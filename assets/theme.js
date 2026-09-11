/* theme.js — vanilla ES module, no dependencies.
   Owns: cart queue + invariants, quick view, swatch map, predictive search, PDP
   variant logic, WAAPI accordion fallback, search-pill rotation, tap-to-zoom
   lightbox, and the .reveal intersection observer. The buy bar is visible from
   page load; there is no mega menu or on-scroll-up floating header. */
const S = window.Theme || {};
/* locale prefix for hardcoded storefront-data fetches, from Shopify.routes.root
   (e.g. "/xx-yy/" on a secondary-locale storefront, "/" on the default). Only
   for reads that render translatable text (product/collection JSON); cart
   endpoints are excluded, see below. */
const LROOT = (window.Shopify && Shopify.routes && Shopify.routes.root) || '/';

/* S.scarcityFor / S.applyScarcity removed: they derived a stock state from
   `product.id % 10` and painted it into the quick view and the cart mini-page.
   Inventory is untracked in this theme, so that state described nothing — it was
   a stock claim generated from a product ID. Real per-product stock needs
   Shopify inventory tracking and variant.inventory_quantity, not a hash of the
   ID; snippets/pdp-scarcity.liquid holds the honest, merchant-owned version. */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

/* ---------- money ----------
   Classic Shopify.formatMoney token formatter. Was substituting the literal
   {{amount}} token only, so any moneyFormat that used a different token (e.g.
   {{amount_with_comma_separator}}) fell through unreplaced and rendered as
   literal "€{{amount_with_comma_separator}}" on every JS-repainted price
   (variant switch, cart drawer). Now resolves all 5 Shopify money tokens and
   never throws: an unrecognised format string falls back to a plain "€"
   + 2-decimal amount instead of leaving the raw template in the DOM. */
function formatWithDelimiters(cents, precision, thousands, decimal) {
  const amount = Math.abs(Number(cents) || 0) / 100;
  const parts = amount.toFixed(precision).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
  return precision > 0 ? `${intPart}${decimal}${parts[1]}` : intPart;
}
/* settings.price_show_cents, ported to JS. shop.money_format always asks for
   decimals, so without this every price this file repaints (variant switch,
   cart drawer, mini view, ATC bar) read "$240.00" next to a server-rendered
   "$240" — the inconsistency the setting exists to remove. The rule is Liquid's
   money_without_trailing_zeros exactly: drop the decimals only when they would
   be ".00", so $240.50 keeps its cents and never states the wrong price.
   Formats that already ask for no decimals are untouched. */
function moneyPrecision(cents) {
  if (S.showCents) return 2;
  return Number(cents) % 100 === 0 ? 0 : 2;
}
export function money(cents) {
  try {
    const fmt = S.moneyFormat || '€{{amount}}';
    const match = fmt.match(/\{\{\s*(\w+)\s*\}\}/);
    const p = moneyPrecision(cents);
    if (!match) return `€${formatWithDelimiters(cents, p, ',', '.')}`;
    let value;
    switch (match[1]) {
      case 'amount_no_decimals': value = formatWithDelimiters(cents, 0, ',', '.'); break;
      case 'amount_with_comma_separator': value = formatWithDelimiters(cents, p, '.', ','); break;
      case 'amount_no_decimals_with_comma_separator': value = formatWithDelimiters(cents, 0, '.', ','); break;
      case 'amount_with_apostrophe_separator': value = formatWithDelimiters(cents, p, "'", '.'); break;
      case 'amount':
      default: value = formatWithDelimiters(cents, p, ',', '.'); break;
    }
    return fmt.replace(/\{\{\s*\w+\s*\}\}/, value).replace(/<[^>]+>/g, '');
  } catch {
    return `€${(Number(cents || 0) / 100).toFixed(2)}`;
  }
}

/* ---------- events bridge (tracking stays theme-agnostic) ---------- */
const emit = (name, detail) => document.dispatchEvent(new CustomEvent(`theme:${name}`, { detail }));

/* ---------- cart ----------
   The invariants below, and why each one exists — every earlier attempt fixed
   one and quietly broke another:

   1. ONE MUTATION AT A TIME, POST *AND* REFRESH TOGETHER. Chaining only the POST
      was not enough: the two section GETs ran unserialised, each holding a node
      reference captured before its own await. The slower one then called
      replaceWith() on a node the faster one had already detached — a silent
      no-op per spec — yet still re-bound listeners and pushed its stale
      cart-count over the fresh one. Symptom: badge reverts to an old number and
      one tap fires two requests. Reachable by tapping a qty stepper and then a
      cross-sell "Add to bag" a beat later.
   2. QTY CONTROLS FROZEN WHILE ANY MUTATION IS PENDING, counted, not boolean.
      Each control carries a precomputed ABSOLUTE target ("+" on a line of 2
      means quantity:3), so a second tap read off pre-change DOM overwrites the
      first change (from 2, "+" then "-" lands on 1). A boolean freeze released
      in one handler's finally re-opened that window while another mutation was
      still pending, so the counter is load-bearing. Fresh DOM arrives with no
      disabled attribute, so applyCartFreeze() must run after every re-render.
   3. NO PER-BUTTON LISTENERS. Qty controls are handled by ONE delegated listener
      on document, so re-rendering can never stack duplicates — the whole
      duplicate-listener class is gone rather than guarded against.
   4. A FAILED REFRESH IS NOT A SUCCESS. The mutation landed server-side but the
      shopper is looking at a stale cart; swallowing that (as `.catch(() => {})`
      did) shows a correct-looking cart with a wrong total. Reload instead — the
      crude thing the old cart page did, and the only honest one.
   5. LINE ITEMS ADDRESSED BY VARIANT ID. Shopify re-indexes lines on removal, so
      an index captured before an in-flight removal points at the wrong item
      (measured: the change silently did nothing). Line-item keys are unusable
      here — the Bundle & save automatic discounts rewrite the key hash on every
      allocation change (three hashes for one variant, measured). Sound only
      because this theme attaches no line item properties, so one variant is
      always exactly one line; with duplicates Shopify matches the FIRST line,
      which would silently reopen a wrong-target bug. Revisit for subscriptions
      or per-line properties. */

/* optional-called: AbortSignal.timeout is Safari 16.4+, but showModal() already
   puts our floor at 15.4 — on 15.4–16.3 this yields `signal: undefined`, which
   fetch ignores, so those browsers keep the old (untimed) behaviour instead of
   throwing on every cart call. */
const CART_TIMEOUT_MS = 15000;
let cartChain = Promise.resolve();
let cartPending = 0;

/* the mutation succeeded but the visible cart could not be refreshed — distinct
   from a failed mutation, because the recovery is different (reload vs. retry) */
class CartStale extends Error {}

/* invariant 2: disabled iff any mutation is pending. Call after every re-render,
   fresh Liquid never renders the disabled attribute. */
function applyCartFreeze() {
  $$('[data-qty-change]').forEach((b) => { b.disabled = cartPending > 0; });
}

/* invariant 1: run fn as the sole cart operation. FIFO, not a rejecting lock — a
   queued tap must still apply, not be dropped. */
function queueCart(fn) {
  const run = cartChain.then(fn, fn);
  cartChain = run.catch(() => {}); /* a failure must not wedge later mutations */
  return run;
}

async function cartFetch(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout?.(CART_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).description || S.t?.cartError || 'Cart error');
  return res.json();
}

async function fetchSection(url, selector) {
  const res = await fetch(url, { signal: AbortSignal.timeout?.(CART_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`section ${res.status}`);
  const fresh = new DOMParser().parseFromString(await res.text(), 'text/html').querySelector(selector);
  if (!fresh) throw new Error(`section markup missing: ${selector}`);
  return fresh;
}

/* refresh every cart surface that is currently on screen. Both are rendered on
   /cart (the drawer sits on every page), so a change on one must update the
   other. Throws CartStale if any on-screen surface could not be refreshed. */
async function refreshCartSurfaces(openDrawerAfter = false) {
  const results = await Promise.allSettled([refreshCartDrawer(openDrawerAfter), refreshCartPage()]);
  applyCartFreeze(); /* invariant 2: whatever landed, re-apply the current state */
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw new CartStale(String(failed.reason?.message || failed.reason));
}

/* Move the LIVE express-wallet node into the slot under the checkout bar.
   The block is server-rendered in the dialog shell so it
   survives the wholesale inner swap; a plain node MOVE keeps the initialised
   wallet components alive (they carry no iframe). Empty bag = no foot = no
   slot → the block stays parked in the shell, hidden. */
function placeCartExpress() {
  const slot = $('#cart-drawer [data-cart-express-slot]');
  const ex = $('#cart-drawer [data-cart-express]');
  if (slot && ex && ex.parentElement !== slot) slot.appendChild(ex);
}

/* Empty-bag boot rescue: first page load with an empty bag →
   <shopify-accelerated-checkout-cart> upgrades against the empty cart and
   paints nothing, and stays 0px after the first add.

   The naive fix re-assigns innerHTML on the LIVE node, which destroys the
   initialised <shopify-google-pay-button> child and
   nothing re-creates it. This one never touches the live node's contents — it
   fetches the current page again (the server now renders the wallet markup for
   a NON-empty cart), and replaces the whole [data-cart-express] node with the
   fresh copy. Custom elements upgrade automatically on insertion, so the new
   component boots against the current cart. One shot per page load; wallets are
   progressive enhancement, so every failure path is silent. */
let cartExpressRebuilt = false;
async function rescueCartExpress(count) {
  if (cartExpressRebuilt || !(Number(count) > 0)) return;
  const ex = $('#cart-drawer [data-cart-express]');
  /* broken state = host present but the initialised wallet child never appeared */
  if (!ex || ex.querySelector('shopify-google-pay-button, shopify-apple-pay-button, shopify-paypal-button')) return;
  cartExpressRebuilt = true;
  try {
    const res = await fetch(window.location.href, { headers: { Accept: 'text/html' } });
    if (!res.ok) return;
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const fresh = doc.querySelector('[data-cart-express]');
    if (!fresh) return;
    fresh.removeAttribute('hidden');
    ex.replaceWith(fresh);
    placeCartExpress();
  } catch (e) { /* silent by design */ }
}


async function refreshCartDrawer(open) {
  const drawer = $('#cart-drawer');
  if (!drawer) return;
  const fresh = await fetchSection('/?section_id=cart-drawer-content', '.cart-drawer__inner');
  /* re-query AFTER the await, never reuse a pre-await reference: replaceWith() on
     a detached node is a silent no-op, which is how a stale render used to
     survive while still re-binding (invariant 1) */
  const target = drawer.querySelector('.cart-drawer__inner');
  if (!target) throw new Error('drawer markup missing');
  /* rescue the live express node BEFORE the swap — it sits in the slot inside
     the inner and would be destroyed with it; park it in the shell, swap, then
     placeCartExpress() below moves it into the fresh slot */
  const expressNode = drawer.querySelector('[data-cart-express]');
  if (expressNode && expressNode.parentElement !== drawer) drawer.appendChild(expressNode);
  target.replaceWith(fresh);
  const count = fresh.dataset.cartCountSrc; /* the attribute sits on .cart-drawer__inner itself */
  if (count !== undefined) updateCartCount(count);
  /* express wallets live in the dialog shell (not swapped) — sync their visibility */
  $('#cart-drawer [data-cart-express]')?.toggleAttribute('hidden', !(Number(count) > 0));
  placeCartExpress();
  rescueCartExpress(count); /* fire-and-forget: empty-bag boot case, see above */
  loadCartCross().catch(() => {}); /* fire-and-forget: an upsell must never fail a mutation */
  if (open) openDrawer();
}

/* cross-sell in the drawer = Shopify's recommendation engine,
   seeded off the first line item, cart lines filtered out, new-in as the fallback
   while the store is too young for the ML to have signal. Liquid ships only the
   hidden shell — the recommendations object is section-scoped and the drawer is
   re-rendered wholesale, so client-side fill is the one place this can live. */
async function loadCartCross() {
  /* NEUTERED, deliberately not deleted. assets/cart-extras.js now owns
     [data-cart-cross-row] and renders real upsell CARDS there (image, compare+price,
     variant select, Add button, arrows, drawer mini-view) instead of the plain links
     below. Both writing into the same row after every cart refresh is a render race, and
     the loser is whichever finishes second — so the old renderer stops here.
     The function body is kept for reference and the two call sites are left in place as
     harmless no-ops: they sit inside refreshCartDrawer() and the boot block, and removing
     them would mean editing the cart refresh path, which the four invariants at the top of
     this file exist to keep still. One early return is the smaller, safer change. */
  return;
  /* eslint-disable no-unreachable */
  const wrap = $('#cart-drawer [data-cart-cross]');
  if (!wrap) return;
  const cart = await (await fetch(`${S.cartUrl}`)).json();
  const seed = cart.items[0];
  const inCart = new Set(cart.items.map((i) => i.product_id));
  let recs = [];
  /* empty bag has no seed for the recommendation engine — skip straight to the
     new-in fallback below so the empty state still upsells */
  if (seed) {
    try {
      const res = await fetch(`${S.recommendationsUrl}.json?product_id=${seed.product_id}&limit=8&intent=related`);
      if (res.ok) recs = (await res.json()).products || [];
    } catch { /* fall through to new-in */ }
  }
  let picks = recs.filter((p) => p.available && !inCart.has(p.id)).slice(0, 4);
  if (!picks.length) {
    try {
      const res = await fetch('/collections/new-in/products.json?limit=16');
      if (res.ok) picks = ((await res.json()).products || [])
        .filter((p) => !inCart.has(p.id) && p.variants.some((v) => v.available))
        .slice(0, 4)
        .map((p) => ({ url: `/products/${p.handle}`, title: p.title, featured_image: p.images[0]?.src }));
    } catch { /* nothing to show */ }
  }
  const row = wrap.querySelector('[data-cart-cross-row]');
  row.textContent = '';
  for (const p of picks) {
    const a = document.createElement('a');
    a.href = p.url;
    if (p.featured_image) {
      const img = new Image();
      img.src = qvSized(typeof p.featured_image === 'string' ? p.featured_image : p.featured_image.src, 192);
      img.width = 96; img.height = 128; img.loading = 'lazy'; img.alt = '';
      a.append(img);
    }
    const name = cardName(p.title);
    a.append(name.length > 34 ? name.slice(0, 33) + '…' : name);
    row.append(a);
  }
  wrap.hidden = picks.length === 0;
}

function updateCartCount(n) {
  $$('.cart-count').forEach((el) => {
    el.textContent = n;
    el.toggleAttribute('hidden', Number(n) === 0);
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  });
}

/* opts.silent — for adds the SHOPPER did not make. A silent add shows no toast
   and fires NO add_to_cart event: the pre-selected add-ons are not shopper
   intent, and counting them would inflate the add-to-cart rate in GA4 and
   Google Ads by two events per session. Everything else (queue, freeze,
   stale-cart recovery, surface refresh) is unchanged. */
export async function addToCart(id, quantity = 1, button, opts = {}) {
  const label = button?.querySelector('[data-atc-label]');
  const orig = label?.textContent;
  cartPending++;
  applyCartFreeze(); /* an add changes quantities too — qty controls must not be read meanwhile */
  try {
    if (button) button.disabled = true;
    /* /cart renders quick-add cross-sell cards, so an add can happen while the cart
       page is on screen; refreshCartSurfaces updates whichever surfaces exist */
    const item = await queueCart(async () => {
      const added = await cartFetch(S.cartAddUrl, { id, quantity });
      if (!opts.silent) emit('add_to_cart', { item: added });
      await refreshCartSurfaces();
      return added;
    });
    if (label) label.textContent = S.t?.added || 'Added ✓';
    /* A shopper's own add opens the drawer — the toast alone left no visible
       path to checkout once the hide-on-scroll header was off screen. Silent
       add-on adds still open nothing. */
    if (!opts.silent) openDrawer();
    return item;
  } catch (err) {
    /* invariant 4: the item IS in the cart, only the view is stale — a toast here
       would be a lie, so resync instead of reporting a failure that didn't happen */
    if (err instanceof CartStale) { location.reload(); return; }
    if (label) label.textContent = err.message.slice(0, 60);
  } finally {
    cartPending--;
    applyCartFreeze();
    if (button) {
      setTimeout(() => { if (label && orig) label.textContent = orig; button.disabled = false; }, 1600);
    }
  }
}

/* invariant 3: ONE delegated listener for both surfaces, bound once at boot.
   Per-button binding was what let re-renders stack duplicate listeners; a
   disabled button dispatches no click at all, so the freeze still gates this. */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-qty-change]');
  if (btn) changeCartLine(btn);
});

async function changeCartLine(btn) {
  const variantId = btn.dataset.variantId;
  const qty = Number(btn.dataset.qtyChange);
  cartPending++;
  applyCartFreeze(); /* synchronous, before any await: a second tap must not register */
  try {
    await queueCart(async () => {
      await cartFetch(S.cartChangeUrl, { id: String(variantId), quantity: qty });
      if (qty === 0) emit('remove_from_cart', { variantId });
      await refreshCartSurfaces();
    });
  } catch (err) {
    /* invariant 4: never leave a stale-but-interactive cart. The old cart page
       reloaded on any failure; dropping that was a regression. */
    if (err instanceof CartStale) { location.reload(); return; }
    /* the mutation itself failed — cart unchanged, the controls the shopper sees
       are still correct, so just let the freeze lift and allow a retry */
  } finally {
    cartPending--;
    applyCartFreeze();
  }
}

/* ---------- add-to-bag toast (unused: shopper adds open the
   drawer via openDrawer() above; kept for a cheap revert) ---------- */
let toastTimer;
function showCartToast() {
  let t = $('#cart-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'cart-toast';
    t.className = 'cart-toast';
    t.setAttribute('role', 'status');
    t.innerHTML = '<span class="cart-toast__check" aria-hidden="true">✓</span><span>Added to bag</span><button type="button" class="cart-toast__link" data-open-cart>View bag</button>';
    t.querySelector('.cart-toast__link').addEventListener('click', () => t.classList.remove('is-visible'));
    if (document.querySelector('#PBarNextFrameWrapper, #preview-bar-iframe')) t.classList.add('cart-toast--raised'); /* clear Shopify's preview bar */
    document.body.appendChild(t);
  }
  clearTimeout(toastTimer);
  void t.offsetWidth;
  t.classList.add('is-visible');
  toastTimer = setTimeout(() => t.classList.remove('is-visible'), 3500);
}

const drawerEl = () => $('#cart-drawer');
function openDrawer() { const d = drawerEl(); if (d && !d.open) d.showModal(); }
document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-open-cart]');
  if (opener) { e.preventDefault(); openDrawer(); }
  const closer = e.target.closest('[data-close-dialog]');
  if (closer) closer.closest('dialog')?.close();
  const d = e.target.closest('dialog');
  if (d && e.target === d) d.close(); /* backdrop click */
});

/* ---------- quick view (mini PDP dialog, fed by /products/<handle>.js) ---------- */
const qvCache = new Map();
const qvPreloaded = new Set();
function qvSized(src, w) { return src + (src.includes('?') ? '&' : '?') + 'width=' + w; }
function qvPreload(src) { if (qvPreloaded.has(src)) return; qvPreloaded.add(src); const i = new Image(); i.decoding = 'async'; i.src = src; }
async function qvFetch(handle) {
  if (!qvCache.has(handle)) qvCache.set(handle, (await (await fetch(`${LROOT}products/${handle}.js`)).json()));
  return qvCache.get(handle);
}
/* warm the cache + hero image the moment the shopper hovers a card */
document.addEventListener('pointerover', async (e) => {
  const qa = e.target.closest('[data-quick-add-root]')?.querySelector('[data-quick-view]');
  if (!qa) return;
  try {
    const p = await qvFetch(qa.dataset.quickView);
    const first = p.media.find((m) => m.media_type === 'image');
    if (first) qvPreload(qvSized(first.src, 600));
  } catch { /* prefetch only */ }
}, { passive: true });
const qvColorNames = ['color', 'colour'];
/* THE catalogue name: the full title, pipe included (e.g. "INGRID | Crochet
   tiered mini dress" shown as-is), same as
   snippets/product-card.liquid and the PDP. */
function cardName(title) {
  return String(title || '').trim();
}
/* colour → its own photograph, mirroring the PDP swatch rule: an alt-tagged image
   first, the variant's featured image second, hex only where neither exists. */
function qvColorHero(p, optIndex, values, val) {
  const tagged = p.media.find((m) => m.media_type === 'image' && qvMediaColors(m.alt, values).includes(val));
  if (tagged) return tagged.src;
  const variant = p.variants.find((v) => v.options[optIndex] === val && v.featured_image);
  return variant ? variant.featured_image.src : null;
}
function qvMediaColors(alt, values) {
  const a = (alt || '').toLowerCase();
  return values.filter((v) => { const c = v.toLowerCase();
    return a.includes(` in ${c},`) || a.includes(` in ${c}-`) || a.includes(` i ${c},`) || a.includes(` i ${c}-`); });
}
/* fashion color name -> swatch hex (mirror of main-product.liquid); fallback: CSS color name, else --cream */
const qvSwatchMap = {
  'noir':'#1F1D1B','black':'#1F1D1B','jet-black':'#1F1D1B','cognac':'#9A5B2F',
  'burgundy':'#6E2231','bordeaux':'#6E2231','wine':'#6E2231','wine-red':'#6E2231','maroon':'#6E2231',
  'tan':'#C08A5A','camel':'#B4855B','caramel':'#A96F3D','brown':'#5B3A29','chocolate':'#5B3A29',
  'coffee':'#4A3428','mocha':'#4A3428','espresso':'#4A3428','beige':'#D9C7A7',
  'cream':'#F1E8D8','ivory':'#F1E8D8','off-white':'#F1E8D8','ecru':'#F1E8D8','bone':'#F1E8D8',
  'white':'#FFFFFF','sand':'#D8C09A','taupe':'#8B7D6B','khaki':'#8F8461',
  'olive':'#6B6A45','olive-green':'#6B6A45','army-green':'#4B5320','military-green':'#4B5320',
  'navy':'#22304A','navy-blue':'#22304A','dark-blue':'#22304A','blue':'#3B5B8C',
  'light-blue':'#A8C4DC','sky-blue':'#A8C4DC','baby-blue':'#A8C4DC','denim':'#4A6785','denim-blue':'#4A6785',
  'grey':'#8C8C8C','gray':'#8C8C8C','charcoal':'#3C3C3C','dark-grey':'#3C3C3C','dark-gray':'#3C3C3C','anthracite':'#3C3C3C','light-grey':'#C9C9C9','light-gray':'#C9C9C9',
  'pink':'#E8A9B8','blush':'#D89AA0','rose':'#D89AA0','dusty-pink':'#D89AA0','dusty-rose':'#D89AA0','hot-pink':'#D94F8A','fuchsia':'#D94F8A',
  'red':'#B3282D','rust':'#A85338','terracotta':'#A85338','brick':'#A85338','orange':'#C96A2B','apricot':'#E8B187','peach':'#E8B187','mustard':'#C99A2C','yellow':'#E3C13F',
  'green':'#3E6B4F','emerald':'#2E5D46','forest-green':'#2E5D46','dark-green':'#2E5D46','sage':'#A8B39A','sage-green':'#A8B39A',
  'purple':'#5C3A5E','plum':'#5C3A5E','lavender':'#B9A7CB','lilac':'#B9A7CB','gold':'#C4A24D','silver':'#C0C0C4',
  /* localized colour names (Danish), mirrored 1:1 from the english hexes above */
  'abrikos':'#E8B187','armygrøn':'#4B5320','azurblå':'#F0FFFF','babyblå':'#A8C4DC','beige':'#D9C7A7',
  'blå':'#3B5B8C','bordeaux':'#6E2231','brun':'#5B3A29','camel':'#B4855B','chokoladebrun':'#5B3A29',
  'creme':'#F1E8D8','dyb-rosa':'#FF1493','elfenben':'#F1E8D8','fersken':'#E8B187','fuchsia':'#D94F8A',
  'grå':'#8C8C8C','grøn':'#3E6B4F','gul':'#E3C13F','guld':'#C4A24D','gulgrøn':'#9ACD32',
  'himmelblå':'#A8C4DC','hvid':'#FFFFFF','kaffebrun':'#4A3428','karamel':'#A96F3D','khaki':'#8F8461',
  'knaldrosa':'#D94F8A','kongeblå':'#4169E1','koral':'#FF7F50','kornblomstblå':'#6495ED','kulsort':'#1F1D1B',
  'lilla':'#5C3A5E','limegrøn':'#32CD32','lys-rosa':'#FFB6C1','lyseblå':'#A8C4DC','lysebrun':'#C08A5A',
  'lysegrå':'#C9C9C9','lysegrøn':'#90EE90','lysegul':'#FFFFE0','magenta':'#FF00FF','marineblå':'#22304A',
  'midnatsblå':'#191970','militærgrøn':'#4B5320','mokka':'#4A3428','mørk-orange':'#FF8C00','mørkeblå':'#22304A',
  'mørkegrå':'#3C3C3C','mørkegrøn':'#2E5D46','mørkerød':'#8B0000','mørkeviolet':'#9400D3','offwhite':'#F1E8D8',
  'olivengrøn':'#6B6A45','orange':'#C96A2B','orangerød':'#FF4500','petroleumsblå':'#008080','rosa':'#E8A9B8',
  'rosé':'#D89AA0','rustrød':'#A85338','rød':'#B3282D','rødbrun':'#6E2231','salviegrøn':'#A8B39A',
  'sand':'#D8C09A','sart-rosa':'#D89AA0','sennepsgul':'#C99A2C','sort':'#1F1D1B','stålblå':'#4682B4',
  'støvet-rosa':'#D89AA0','syrenlilla':'#B9A7CB','sølv':'#C0C0C4','taupe':'#8B7D6B','terrakotta':'#A85338',
  'turkis':'#40E0D0','vinrød':'#6E2231','violet':'#EE82EE',
};
function qvSwatch(val) {
  const key = String(val).toLowerCase().trim().replace(/\s+/g, '-');
  return qvSwatchMap[key] || key.replace(/-/g, '');
}
/* PLP card swatches (blueprint): Liquid ships them colorless so the hex table stays
   in exactly one place. Re-run after any injection of fresh cards (related row). */
function paintSwatches(ctx = document) {
  $$('[data-swatch]', ctx).forEach((el) => { el.style.backgroundColor = qvSwatch(el.dataset.swatch); });
}
function initQuickView() {
  const dlg = $('#quick-view');
  if (!dlg) return;
  const els = {
    img: $('[data-qv-img]', dlg), thumbs: $('[data-qv-thumbs]', dlg), title: $('[data-qv-title]', dlg),
    price: $('[data-qv-price]', dlg), options: $('[data-qv-options]', dlg),
    atc: $('[data-qv-atc]', dlg), atcLabel: $('[data-qv-atc-label]', dlg), link: $('[data-qv-link]', dlg),
  };
  let product = null;
  let state = [];

  const variantFor = (opts) => product.variants.find((v) => v.options.every((o, i) => o === opts[i]));
  /* partial match: null entries = "not chosen yet" wildcards (size stays unpicked, like the PDP) */
  const partialFor = (opts) => product.variants.filter((v) => v.options.every((o, i) => opts[i] == null || o === opts[i]));
  const colorIdx = () => product.options.findIndex((o) => qvColorNames.includes(o.name.toLowerCase()));

  function renderMedia() {
    const ci = colorIdx();
    const color = ci > -1 ? state[ci] : null;
    let imgs = product.media.filter((m) => m.media_type === 'image');
    if (color) {
      const values = product.options[ci].values;
      const tagged = imgs.filter((m) => qvMediaColors(m.alt, values).includes(color));
      if (tagged.length) imgs = tagged;
    }
    imgs = imgs.slice(0, 4);
    const main = imgs[0];
    if (main) { els.img.decoding = 'async'; els.img.fetchPriority = 'high'; els.img.src = qvSized(main.src, 600); els.img.alt = main.alt || product.title; }
    els.thumbs.innerHTML = imgs.map((m, i) =>
      `<button type="button" class="qv__thumb${i === 0 ? ' on' : ''}" data-qv-thumb="${m.src}"><img src="${qvSized(m.src, 140)}" alt="" loading="lazy" decoding="async"></button>`).join('');
  }

  function render() {
    const unselected = state.includes(null);
    const v = unselected ? null : variantFor(state);
    /* price fallback while size is still unchosen: first available partial match */
    const pv = v || partialFor(state).find((m) => m.available) || partialFor(state)[0];
    /* same price row as the drawer mini-page, solid chip included */
    els.price.innerHTML = pv && pv.compare_at_price > pv.price
      ? `<s>${money(pv.compare_at_price)}</s> <span class="price--sale">${money(pv.price)}</span> <span class="cart-miniview__badge">-${Math.round((pv.compare_at_price - pv.price) * 100 / pv.compare_at_price)}%</span>`
      : money(pv ? pv.price : product.price);
    /* MATCH THE PDP: black and live while a size is still owed, disabled only
       when there is genuinely nothing to add — it must read as the same page.
       A tap without a size nudges the size row instead of adding blind. */
    els.atc.disabled = !unselected && (!v || !v.available);
    els.atc.classList.toggle('bar--awaiting', unselected);
    els.atcLabel.textContent = unselected ? (S.t?.selectSize || 'Select a size') : !v ? (S.t?.unavailable || 'Unavailable') : v.available ? (S.t?.addToBag || 'Add to bag') : (S.t?.soldOut || 'Sold out');
    els.atc.dataset.variantId = v ? v.id : '';
    els.options.querySelectorAll('[data-qv-opt]').forEach((btn) => {
      const i = Number(btn.dataset.qvOptIndex);
      btn.setAttribute('aria-pressed', String(state[i] === btn.dataset.qvOpt));
      const test = [...state]; test[i] = btn.dataset.qvOpt;
      const cand = partialFor(test).find((m) => m.available);
      if (btn.classList.contains('size-btn')) btn.toggleAttribute('disabled', !cand);
    });
    renderMedia();
  }

  function open(p) {
    product = p;
    /* lead colour first, variant (= import) order second — same rule as the PDP:
       the dialog must open on the colour of the card photograph that was tapped
       (without this, "black" cards could open on a different variant's colour) */
    const ciLead = p.options.findIndex((o) => qvColorNames.includes(o.name.toLowerCase()));
    const leadValues = ciLead > -1 ? p.options[ciLead].values : [];
    const leadMedia = ciLead > -1
      ? p.media.find((m) => m.media_type === 'image' && qvMediaColors(m.alt, leadValues).length)
      : null;
    const leadColor = leadMedia ? qvMediaColors(leadMedia.alt, leadValues)[0] : null;
    const first = (leadColor && p.variants.find((v) => v.available && v.options[ciLead] === leadColor))
      || p.variants.find((v) => v.available) || p.variants[0];
    state = [...first.options];
    /* size pre-selected, same as the PDP — `first` already
       carries the lead colour's first available size */
    els.title.textContent = cardName(p.title);
    els.link.href = `/products/${p.handle}`;
    /* Option NAME localisation: mirrors main-product.liquid's
       opt_label mapping exactly (color/colour -> product.option_color, anything
       else containing "size" -> product.option_size, otherwise the raw name is
       left alone). Never touches o.values (the alt-text parser reads those). */
    els.options.innerHTML = p.options.map((o, i) => {
      if (o.values.length < 2) return '';
      const isColor = qvColorNames.includes(o.name.toLowerCase());
      const isSize = !isColor && o.name.toLowerCase().includes('size');
      const optLabel = isColor ? (S.t?.optionColor || o.name) : isSize ? (S.t?.optionSize || o.name) : o.name;
      const controls = isColor
        ? `<div class="swatches" role="group" aria-label="${optLabel}">${o.values.map((val) => {
            const esc = val.replace(/"/g, '&quot;');
            const hero = qvColorHero(p, i, o.values, val);
            const skin = hero
              ? `class="swatch swatch--img"`
              : `class="swatch" style="background-color: var(--cream); background-color: ${qvSwatch(val)};"`;
            const art = hero ? `<img src="${qvSized(hero, 108)}" alt="" loading="lazy" decoding="async">` : '';
            return `<button type="button" ${skin} data-qv-opt="${esc}" data-qv-opt-index="${i}" aria-label="${esc}" title="${esc}">${art}</button>`;
          }).join('')}</div>`
        : `<div class="sizes" role="group" aria-label="${optLabel}">${o.values.map((val) =>
            `<button type="button" class="size-btn" data-qv-opt="${val.replace(/"/g, '&quot;')}" data-qv-opt-index="${i}">${val}</button>`).join('')}</div>`;
      return `<div class="opt"><div class="opt__head"><p class="opt__label">${optLabel}</p></div>${controls}</div>`;
    }).join('');
    render();
    dlg.showModal();
    const ci = colorIdx();
    if (ci > -1) {
      const values = product.options[ci].values;
      values.forEach((val) => {
        const hero = product.media.find((m) => m.media_type === 'image' && qvMediaColors(m.alt, values).includes(val));
        if (hero) qvPreload(qvSized(hero.src, 600));
      });
    }
  }

  document.addEventListener('click', async (e) => {
    const qa = e.target.closest('[data-quick-add]');
    if (qa) {
      e.preventDefault();
      if (qa.dataset.singleVariant) { addToCart(Number(qa.dataset.singleVariant), 1, qa); return; }
      const handle = qa.dataset.quickView;
      if (!handle) return;
      try { open(await qvFetch(handle)); } catch { window.location.href = `/products/${handle}`; return; }
    }
    if (!product || !dlg.open) return;
    const optBtn = e.target.closest('[data-qv-opt]');
    if (optBtn && !optBtn.disabled) { state[Number(optBtn.dataset.qvOptIndex)] = optBtn.dataset.qvOpt; render(); }
    const thumb = e.target.closest('[data-qv-thumb]');
    if (thumb) {
      els.img.src = thumb.dataset.qvThumb + (thumb.dataset.qvThumb.includes('?') ? '&' : '?') + 'width=600';
      $$('.qv__thumb', els.thumbs).forEach((t) => t.classList.toggle('on', t === thumb));
    }
    if (e.target.closest('[data-qv-atc]')) {
      const id = Number(els.atc.dataset.variantId);
      if (id) { dlg.close(); addToCart(id, 1, els.atc); return; }
      /* same acknowledgement the PDP bar gives: press-in + flag the size row */
      els.atc.classList.remove('bar--nudged');
      void els.atc.offsetWidth;
      els.atc.classList.add('bar--nudged');
      setTimeout(() => els.atc.classList.remove('bar--nudged'), 400);
      const row = $('.sizes', els.options);
      if (row) { row.classList.add('opts-attn'); setTimeout(() => row.classList.remove('opts-attn'), 1200); }
    }
  });
}
initQuickView();

/* ---------- menu overlay + size chart ----------
   No mega menu: the header carries plain label-system links and the
   full category list lives in one paper overlay (full-screen nav open state). */
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-nav]')) $('#mobile-nav')?.showModal();
  if (e.target.closest('[data-open-size-chart]')) $('#size-chart-dialog')?.showModal();
});

/* ---------- panels (sort / filter) ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-panel-trigger]');
  if (t) {
    const panel = document.getElementById(t.getAttribute('aria-controls'));
    const isOpen = panel.classList.toggle('open');
    t.setAttribute('aria-expanded', String(isOpen));
    return;
  }
  if (!e.target.closest('.sort-panel, .filter-panel')) {
    $$('.sort-panel.open, .filter-panel.open').forEach((p) => p.classList.remove('open'));
    $$('[data-panel-trigger]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.sort-panel.open, .filter-panel.open').forEach((p) => p.classList.remove('open'));
});
$$('[data-sort-value]').forEach((btn) => btn.addEventListener('click', () => {
  const url = new URL(location.href);
  url.searchParams.set('sort_by', btn.dataset.sortValue);
  location.href = url.toString();
}));

/* PLP load-more was replaced by classic numbered pagination. The pager is
   pure server-rendered {% paginate %} markup
   in main-collection / main-search — no JS, no appended DOM to re-paint, every
   page its own URL. The fetch/append routine and its swatch re-paint are gone. */

/* ---------- PDP: variant switching ---------- */
function initPDP() {
  const root = $('[data-product-root]');
  if (!root) return;
  const data = JSON.parse($('#product-json').textContent);
  const urlVariantId = Number(new URLSearchParams(location.search).get('variant'));
  const colorIdx = data.options.findIndex((o) => /^colou?r$/i.test(o.name || o));
  /* lead colour = the colour of the first alt-tagged gallery image, i.e. the
     photograph the PLP card showed. Variant (= import) order used to win here,
     which could open "black" cards on the pink variant.
     Liquid computes data-colors with the same alt-needle rule, so reading the
     DOM keeps exactly one source of truth. Explicit ?variant= still wins. */
  const leadColor = ($('.gallery-item[data-colors]', root)?.dataset.colors || '').split('||')[0] || null;
  const initialVariant = data.variants.find((v) => v.id === urlVariantId)
    || (colorIdx > -1 && leadColor && data.variants.find((v) => v.available && v.options[colorIdx] === leadColor))
    || data.variants.find((v) => v.available) || data.variants[0];
  const state = { options: [...initialVariant.options] };
  /* must match theme.css: at >=900px the gallery collapses to ONE visible image
     with the thumb rail; below that it is the snap-scroll swiper */
  const isWide = () => matchMedia('(min-width: 900px)').matches;

  /* Size PRE-SELECTED: initialVariant's size (the lead
     colour's first available) stays in state, so the ATC reads "add to bag" with
     a price from first paint. The size sheet still opens via the size row, and a
     wrong-size add remains coverable by the 30-day return promise. */

  const variantFor = (opts) => data.variants.find((v) => v.options.every((o, i) => o === opts[i]));
  /* partial match: null entries = "not chosen yet" wildcards */
  const partialFor = (opts) => data.variants.filter((v) => v.options.every((o, i) => opts[i] == null || o === opts[i]));

  let lastColor = leadColor; /* color tracking: gallery navigation only on color change.
     Seeded with the LEAD colour, not null: a ?variant=
     landing — every ad click on a non-lead colour — selects that colour in state,
     but the gallery opens on the lead photo; with a null seed the first render's
     colorChanged stayed false and swatch and gallery disagreed until a manual
     colour round-trip. Seeded, the first render jumps to the URL colour; landings
     without ?variant start ON the lead colour so nothing moves, and size clicks
     stay jump-free either way. */
  function render() {
    const unselected = state.options.includes(null);
    const v = unselected ? null : variantFor(state.options);
    /* price/teaser fallback while a size is still unchosen: first available partial match */
    const pv = v || partialFor(state.options).find((m) => m.available) || partialFor(state.options)[0];
    $$('[data-opt-btn]', root).forEach((btn) => {
      const { optIndex, optValue } = btn.dataset;
      const test = [...state.options]; test[Number(optIndex)] = optValue;
      const candidate = partialFor(test).find((m) => m.available);
      btn.setAttribute('aria-pressed', String(state.options[Number(optIndex)] === optValue));
      /* aria-disabled, NOT the disabled attribute: a size that exists but is
         unavailable in this combination has to stay reachable by keyboard and
         screen reader, because taking it out of the tab order hides the fact
         that the size exists at all. theme.css strikes through
         [aria-disabled="true"] in the same rule as [data-unavailable], so this
         looks identical to the Liquid first paint. */
      if (btn.classList.contains('size-btn')) {
        btn.setAttribute('aria-disabled', String(!candidate));
        btn.removeAttribute('disabled');
      }
    });
    $$('[data-opt-current]', root).forEach((el) => { el.textContent = state.options[Number(el.dataset.optCurrent)] || S.t?.optionSelect || 'Select'; });
    /* The form's only name="id" control, kept in step with the buttons. Without
       this the native POST path — Enter pressed in the quantity field, or
       theme.js attaching and then render() being the thing that failed — posts
       whichever variant Liquid pre-selected rather than the one just picked. */
    const idField = $('[data-variant-select]', root);
    if (idField && v) idField.value = String(v.id);
    /* title-block price: plain, sale markup identical to the Liquid first paint
       (no discount badge, no chrome around the number). $$ not $: the
       desktop rich bar carries a second [data-price]. */
    if (pv) {
      const priceHtml = pv.compare_at_price > pv.price
        ? `<s>${money(pv.compare_at_price)}</s> <span class="price--sale">${money(pv.price)}</span>`
        : money(pv.price);
      $$('[data-price]', root).forEach((el) => { el.innerHTML = priceHtml; });
    }
    /* the percentage badge lives OUTSIDE [data-price] on purpose.
       The loop above rewrites the innerHTML of every [data-price] on each variant
       change, so a badge nested in there would be destroyed by the first size click.
       Kept as a sibling [data-price-badge] and painted here instead, with the same
       arithmetic as snippets/price-badge.liquid so the JS repaint and the Liquid
       first paint can never disagree. No anchor on this variant → no badge, which is
       what makes the number honest. */
    {
      const pct = pv && pv.compare_at_price > pv.price
        ? Math.round(((pv.compare_at_price - pv.price) * 100) / pv.compare_at_price)
        : 0;
      $$('[data-price-badge]', root).forEach((el) => {
        el.textContent = pct > 0 ? `−${pct}%` : '';
        el.hidden = pct <= 0;
      });
    }
    /* EVERY add button (label left, price right, no price shown while the
       shopper still owes us a size). There are up to three of them: the phone
       bar, the desktop buy-column ATC and the desktop rich bar. One loop keeps
       them identical — no second state. */
    /* "Select a size" with NO price while a size is owed. Price appears the
       moment the label flips to
       "Add to bag". While a size is still owed the button stays CLICKABLE — a
       truly disabled button fires no click and would kill the tap-to-open-the-
       size-sheet mechanic below — and wears .bar--awaiting so it reads as
       not-yet-armed. Matches the quick view and drawer mini-PDP wording. */
    const atcLabel = unselected ? (S.t?.selectSize || 'Select a size') : !v ? (S.t?.unavailable || 'Unavailable') : v.available ? (S.t?.addToBag || 'Add to bag') : (S.t?.soldOut || 'Sold out');
    const atcPrice = !unselected && v && v.available ? money(v.price) : '';
    $$('[data-atc]', root).forEach((atc) => {
      atc.disabled = unselected ? false : (!v || !v.available);
      atc.classList.toggle('bar--awaiting', unselected);
      atc.setAttribute('aria-label', unselected ? (S.t?.selectSizeAria || 'Select a size to add to bag') : atcLabel);
      const lbl = atc.querySelector('[data-atc-label]');
      if (lbl) lbl.textContent = atcLabel;
      const barPrice = atc.querySelector('[data-atc-price]');
      if (barPrice) barPrice.textContent = atcPrice;
      atc.dataset.variantId = v ? v.id : '';
    });
    /* no "Only X left" scarcity note — considered an anti-pattern here */
    /* per-color gallery filtering REMOVED: the gallery and
       the thumb rail always show ALL product images, whatever colour is picked.
       data-colors stays on the items — the colour-change jump below and
       warmColorImages still read it. Revert = re-hide by data-colors here. */
    /* desktop shows one image at a time — never leave the gallery without a current item */
    if (isWide()) {
      const cur = $('.gallery-item.is-current', root);
      if (!cur || cur.hidden) galleryShow(null);
    }
    /* NEVER reorder the DOM: prepend() on every
       render would scramble the curated lifestyle-first order a little more with each
       SIZE click. We only NAVIGATE to the color's lead image, and only when the
       COLOR actually changed. The color is tracked OUTSIDE the v-guard: on the
       first render the size is unpicked so v is undefined — tracking inside the
       guard left lastColor null, and the first SIZE click then counted as a
       "color change" and jumped the gallery to the variant's studio shot. */
    const colorNow = colorIdx > -1 ? state.options[colorIdx] : null;
    const colorChanged = lastColor !== null && colorNow !== lastColor;
    lastColor = colorNow;
    /* Since the gallery stopped filtering by colour, this jump is the
       ONLY thing that takes a colour click to that colour's photo, so it must not
       depend on a fully resolved variant: sizes are never pre-selected, so `v` is
       undefined until the shopper picks one and the jump would never fire. Target
       = the colour's first alt-tagged gallery image (same data-colors contract as
       Liquid), variant featured media only as the fallback. */
    if (colorChanged && colorNow) {
      const target = $$('.gallery-item[data-colors]', root).find((el) => el.dataset.colors.split('||').includes(colorNow))
        || (pv && pv.featured_media && $(`[data-media-id="${pv.featured_media.id}"]`, root));
      if (target) {
        if (isWide()) galleryShow(target);
        else target.scrollIntoView({ inline: 'center', block: 'nearest' });
      }
    }
    if (v) {
      const url = new URL(location.href);
      url.searchParams.set('variant', v.id);
      history.replaceState({}, '', url);
      emit('variant_change', { variant: v });
    }
  }

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-opt-btn]');
    /* aria-disabled has to be rejected here as well as `disabled`: render()
       now marks unavailable sizes that way so they stay tabbable, which also
       means they stay clickable unless this guard says otherwise. */
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
      /* re-click on the already-active colour swatch:
         state doesn't change, so the colorChanged jump in render() would stay
         silent — reset the tracker so the jump re-fires and the gallery answers
         the tap by navigating back to that colour's photo */
      if (Number(btn.dataset.optIndex) === colorIdx && state.options[colorIdx] === btn.dataset.optValue) lastColor = '';
      state.options[Number(btn.dataset.optIndex)] = btn.dataset.optValue;
      render();
    }
  });
  /* Size expansion panel: the bar reads "Select a size", and tapping it opens a
     panel directly above the bar that holds the REAL size row — moved there, not
     copied, so there is exactly one picker and render() needs no extra branch.
     It goes home on close. */
  const sheet = $('[data-vsheet]', root);
  const sheetSlot = $('[data-vsheet-slot]', root);
  const sizeOpt = $('[data-size-opt]', root);
  const sizeHome = $('[data-size-home]', root);
  const sheetUsable = sheet && sheetSlot && sizeOpt && sizeHome;
  const openSheet = () => {
    /* the expansion sheet is a phone mechanic (theme.css hides it from 900px):
       on desktop the size row is already on screen next to the ATC, so flag it
       instead of sliding up a panel nobody can see */
    if (!sheetUsable || isWide()) return nudgeSize();
    sheetSlot.appendChild(sizeOpt);
    sheet.hidden = false;
    requestAnimationFrame(() => sheet.classList.add('open'));
  };
  const closeSheet = () => {
    if (!sheetUsable || sheet.hidden) return;
    sheet.classList.remove('open');
    setTimeout(() => {
      sheet.hidden = true;
      sizeHome.parentNode.insertBefore(sizeOpt, sizeHome);
    }, 240);
  };
  $$('[data-vsheet-close]', root).forEach((el) => el.addEventListener('click', closeSheet));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  /* no panel to open (no size option at all): flag the inline picker instead of
     adding a variant the shopper never chose */
  function nudgeSize() {
    const grp = $('.sizes', root);
    if (!grp) return;
    grp.closest('.opt')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    grp.classList.add('opts-attn');
    setTimeout(() => grp.classList.remove('opts-attn'), 1200);
  }

  /* every add button, not just the first: the desktop column ATC and the rich
     bar are real add buttons too. Unpicked size still opens the
     phone sheet / nudges the picker rather than adding blind. */
  $$('[data-atc]', root).forEach((btn) => btn.addEventListener('click', (e) => {
    /* The in-column ATC is a real type="submit" inside {% form 'product' %}, so
       the product stays buyable with no JavaScript. Once this handler is
       attached we own the click, so the native POST has to be suppressed or a
       healthy page adds twice — once here, once by submitting. This replaces an
       inline onclick guard that probed for an aria-label render() writes: it
       worked, but it made "never put aria-label on a [data-atc] in Liquid" a
       rule whose violation silently removed no-JS purchasing. Not attaching at
       all (no JS, or theme.js dying before this line) leaves the native submit
       intact, which is the fallback the form exists for. */
    e.preventDefault();
    const id = Number(e.currentTarget.dataset.variantId);
    if (!id) {
      /* VISIBLE PRESS: the button is full black in both states now, so nothing else signals that
         the tap landed — without this a shopper who taps before picking a size
         gets a scroll they did not ask for and no acknowledgement. */
      const pressed = e.currentTarget;
      pressed.classList.remove('bar--nudged');
      void pressed.offsetWidth;
      pressed.classList.add('bar--nudged');
      setTimeout(() => pressed.classList.remove('bar--nudged'), 400);
      /* the IN-FLOW button sits right under the size row — scroll there instead
         of opening the sheet (the sheet lives in the bar, which is hidden while
         the in-flow ATC is on screen). The bar keeps its sheet. */
      if (e.currentTarget.classList.contains('pdp__atc')) {
        const row = $('.sizes', root) || $('[data-size-home]', root);
        row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row?.querySelector('.size-btn:not([disabled]):not([aria-disabled="true"])')?.focus({ preventScroll: true });
        return;
      }
      openSheet(); return;
    }
    /* READ THE QUANTITY PICKER. snippets/pdp-quantity.liquid renders a real
       name="quantity" input, so the no-JS POST has always carried the right
       number; this path used to hardcode 1, which meant a shopper who set 3
       on a normal JS page silently got 1. The field is scoped to `root` (the
       PDP section), and the column ATC, the phone bar and the rich bar are all
       inside it, so all three add buttons read the one input. Falls back to 1
       wherever the snippet is not rendered (quick view, upsells). */
    const qtyField = $('[data-qty-input]', root);
    const qty = Math.max(1, Math.floor(Number(qtyField?.value) || 1));
    addToCart(id, qty, e.currentTarget);
    closeSheet();
  }));

  /* THE +/- STEPPERS. Without this they are dead on a JS page — and because
     `html.js .pdp-qty__input` in theme.css hides the native number spinner
     (correctly: the spinner is the no-JS stepper), typing would be the only
     way left to change quantity. Delegated on root rather than bound per
     button so it survives a section re-render. Clamped to the input's own
     min/max so the field can never post a quantity /cart/add will reject. */
  root.addEventListener('click', (e) => {
    const step = e.target.closest('[data-qty-step]');
    if (!step) return;
    const field = $('[data-qty-input]', root);
    if (!field) return;
    const min = Number(field.min) || 1;
    const max = Number(field.max) || Infinity;
    const current = Math.floor(Number(field.value) || min);
    const clamped = Math.min(max, Math.max(min, current + Number(step.dataset.qtyStep)));
    if (clamped === current) return;
    field.value = String(clamped);
    /* 'change', not 'input': that is what a native spinner fires on commit, so
       the two stepper paths stay indistinguishable to any later listener. */
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });

  /* a size picked inside the panel is the whole point of the panel — close it and
     leave the shopper on a bar that now reads "Add to bag · $x" */
  sheetSlot?.addEventListener('click', (e) => {
    if (!e.target.closest('.size-btn')) return;
    /* deferred on purpose: this listener runs BEFORE the delegated one on root
       that writes state, so the check has to happen after render() */
    setTimeout(() => { if (!state.options.includes(null)) closeSheet(); }, 180);
  });
  /* declared BEFORE the first render(): the initial colour jump for a
     ?variant= landing runs galleryShow→railNudge during that render — with railEl
     still in its const TDZ down at the rail block, initPDP died on a ReferenceError
     and everything after this line (dots, rail, bar sync) never wired up. */
  const railEl = $('.pdp__rail', root);
  render();

  /* info sections: inline swap, never an accordion, never a page jump */
  const infoTabs = $$('[data-info-tab]', root);
  infoTabs.forEach((tab) => tab.addEventListener('click', () => {
    infoTabs.forEach((t) => t.setAttribute('aria-current', String(t === tab)));
    $$('[data-info-panel]', root).forEach((p) => { p.hidden = p.dataset.infoPanel !== tab.dataset.infoTab; });
  }));

  /* warm the cache for each color's lead image AFTER load, in idle time, so a
     color switch renders instantly instead of waiting ~1s on the CDN fetch.
     Idle + post-load keeps this off the LCP critical path; saveData users skip. */
  const warmColorImages = () => {
    if (navigator.connection && navigator.connection.saveData) return;
    const done = new Set();
    $$('.gallery-item[data-colors]', root).forEach((el) => {
      const img = el.querySelector('img');
      if (!img) return;
      el.dataset.colors.split('||').filter(Boolean).forEach((c) => {
        if (done.has(c)) return;
        done.add(c);
        const pre = new Image();
        if (img.sizes) pre.sizes = img.sizes;
        if (img.srcset) pre.srcset = img.srcset;
        pre.src = img.src;
      });
    });
  };
  const scheduleWarm = () => ('requestIdleCallback' in window)
    ? requestIdleCallback(warmColorImages, { timeout: 4000 })
    : setTimeout(warmColorImages, 2500);
  if (document.readyState === 'complete') scheduleWarm();
  else window.addEventListener('load', scheduleWarm, { once: true });

  /* Bottom bar reveal. MOBILE: the bar is THE buy button and is
     present from page load — theme.css never hides it below 900px, so
     this class is inert there. DESKTOP: the buy column owns the primary ATC, so
     the rich bar only arrives once that column has scrolled out of view. One
     observer on the column's own add button: visible = the shopper can already
     buy, hidden = hand them the bar. */
  const barwrap = $('[data-barwrap]', root);
  const columnAtc = $('.pdp__atc', root);
  if (barwrap && columnAtc) {
    /* scroll listener, NOT IntersectionObserver: on
       mobile the in-flow ATC starts below the fold, so an instant jump past it
       (back/forward restore, anchor link, size-recommender scrollIntoView)
       never crosses the intersection boundary and IO simply does not fire.
       The bar shows ONLY below the ATC: bottom < 0 = scrolled past it.

       On mobile the bar must be shown FROM PAGE LOAD: it is the only add button
       there. If .pdp__atc does not render below 900px, columnAtc is
       null and the `else if` below would pin the bar open forever — .pdp__atc
       must render on both viewports (it also anchors the payment icons and the
       trust box) so this branch runs on phones too, or the bar stays hidden
       until the shopper scrolls past a button that can sit far down the page.

       The bar reveals on scroll-past on EVERY viewport — the in-flow button is
       the primary buy control on mobile too. The bar must sit strictly below
       the in-flow ATC (not merely once it leaves the viewport, which can show
       the bar ABOVE the button) — reveal-on-scroll-past only. */
    const pdpTop = document.querySelector('.pdp__top');
    const sync = () => {
      /* theme.css hides the column ATC below 900px — sticky bar is THE buy
         button on mobile, from page load. display:none = offsetParent null =
         nothing to scroll past. */
      if (!columnAtc.offsetParent) { barwrap.classList.add('is-shown'); return; }
      /* On >=900px the gallery is
         sticky, so a bar that appears as soon as the inline ATC scrolls out
         covers the lower half of the pinned photo. There the bar waits until
         the WHOLE .pdp__top block (buy rail incl. complete-the-look) has
         scrolled past — 100px ~ the fixed header, i.e. nothing of the block
         is visible any more. Mobile keeps the inline-ATC trigger. */
      if (pdpTop && matchMedia('(min-width: 900px)').matches) {
        barwrap.classList.toggle('is-shown', pdpTop.getBoundingClientRect().bottom < 100);
        return;
      }
      const r = columnAtc.getBoundingClientRect();
      barwrap.classList.toggle('is-shown', r.bottom < 0);
    };
    addEventListener('scroll', sync, { passive: true });
    addEventListener('resize', sync, { passive: true });
    sync();
  } else if (barwrap) {
    barwrap.classList.add('is-shown'); /* no anchor to measure: never trap the bar off-screen */
  }

  /* mobile gallery dots: one dot per visible image, synced to snap scroll */
  const gal = $('.pdp__gallery', root);
  const dots = $('[data-gallery-dots]', root);
  /* the x-mandatory snap gallery swallows vertical mouse wheel in Chromium —
     route vertical intent to the page (touch is unaffected) */
  gal?.addEventListener('wheel', (e) => {
    if (gal.scrollWidth > gal.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      window.scrollBy(0, e.deltaY);
    }
  }, { passive: false });

  /* Same rule for the desktop thumbnail rail. Capping it to the photo
     height turned it into a scroll container, and a scroll container under the
     cursor eats the wheel until it hits its own end — with many thumbs that is
     thousands of pixels of rail before the PAGE moves at all.
     The wheel therefore always belongs to the page here. The rail is still fully
     reachable: its own scrollbar drags, clicking a thumb works, and theme.js scrolls
     the active thumb into view on every colour and image change.
     (railEl itself is declared up by the first render() call.) */
  /* click-to-arm rail scrolling: clicking INSIDE the rail
     arms it — the wheel then scrolls the rail natively (scroll chaining hands the
     wheel back to the page at the rail's ends). Clicking anywhere else disarms it
     and the wheel belongs to the page again. .is-armed is the visual cue. */
  let railArmed = false;
  if (railEl) document.addEventListener('pointerdown', (e) => {
    const inRail = !!e.target.closest('.pdp__rail');
    if (inRail !== railArmed) { railArmed = inRail; railEl.classList.toggle('is-armed', railArmed); }
  }, true);
  railEl?.addEventListener('wheel', (e) => {
    if (railEl.scrollHeight <= railEl.clientHeight) return;      /* nothing to eat */
    if (railArmed) return;                                       /* armed: native rail scroll */
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;        /* horizontal intent stays */
    e.preventDefault();
    window.scrollBy(0, e.deltaY);
  }, { passive: false });
  /* scrollIntoView({block:'nearest'}) would keep the active thumb visible but
     scrolls EVERY scrollable ancestor including the document, not just the rail.
     The gallery IntersectionObserver below calls setActive during plain page
     scrolling, so the page got yanked back up on every wheel tick until the
     images settled (measured: scrollY 960→649 mid-scroll). This helper moves
     the rail's OWN scrollTop and touches nothing else. */
  function railNudge(t) { /* function declaration: hoisted, safe for the initial render's galleryShow */
    if (!railEl || railEl.scrollHeight <= railEl.clientHeight) return;
    const top = t.offsetTop, bot = top + t.offsetHeight;
    if (top < railEl.scrollTop) railEl.scrollTop = top;
    else if (bot > railEl.scrollTop + railEl.clientHeight) railEl.scrollTop = bot - railEl.clientHeight;
  }
  /* clicked thumb glides to the rail's middle. Rail-only, same page-safety
     rule as railNudge. */
  function railCenter(t) { /* function declaration for the same hoisting reason as railNudge */
    if (!railEl || railEl.scrollHeight <= railEl.clientHeight) return;
    railEl.scrollTo({ top: t.offsetTop - (railEl.clientHeight - t.offsetHeight) / 2, behavior: 'smooth' });
  }
  if (gal && dots) {
    const visItems = () => $$('.gallery-item', gal).filter((el) => el.offsetParent !== null);
    const rebuild = () => {
      const items = visItems();
      dots.innerHTML = items.map((_, i) => `<span${i === 0 ? ' class="on"' : ''}></span>`).join('');
      dots.hidden = items.length < 2;
      sync();
    };
    const sync = () => {
      const items = visItems();
      if (!items.length) return;
      const mid = gal.scrollLeft + gal.clientWidth / 2;
      let idx = 0;
      items.forEach((el, i) => { if (el.offsetLeft <= mid) idx = i; });
      $$('span', dots).forEach((s, i) => s.classList.toggle('on', i === idx));
    };
    rebuild();
    /* re-count on resize: desktop shows only ONE item (is-current), so a dot count
       built at desktop width is wrong after crossing into the mobile breakpoint */
    addEventListener('resize', () => requestAnimationFrame(rebuild), { passive: true });
    gal.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true });
    /* no rebuild on option clicks any more: the image set no longer
       changes with the colour, and the rebuild reset the active dot to #1 right
       after the colour jump had scrolled to image #19. Scroll sync handles it. */
  }

  /* desktop: one visible gallery image — swap which one is shown + sync the thumb rail.
     Function declaration on purpose: render() runs its initial pass (line ~691)
     before this point in the file, hoisting keeps that call safe. */
  function galleryShow(el) {
    const items = $$('.gallery-item', root);
    if (!el || el.hidden) el = items.find((i) => !i.hidden);
    if (!el) return;
    items.forEach((i) => {
      const now = i === el;
      if (now && !i.classList.contains('is-current')) {
        i.classList.remove('g-fade'); void i.offsetWidth; i.classList.add('g-fade');
      }
      i.classList.toggle('is-current', now);
    });
    /* same rail-scroll rule as the click handler below — this is the
       path a colour swap takes, and it jumps furthest through the rail */
    $$('.pdp__thumb', root).forEach((t) => {
      const on = t.dataset.thumbTarget === el.dataset.mediaId;
      t.setAttribute('aria-current', String(on));
      if (on && isWide()) railNudge(t);
    });
  }

  /* desktop thumbnail rail: click a thumb to SHOW its image (no page scroll); mobile keeps snap-scroll */
  const thumbs = $$('.pdp__thumb', root);
  if (thumbs.length) {
    /* The desktop rail is a scroll container capped to the image
       height (theme.css), so the active thumb can sit outside its viewport — after
       a colour swap it usually does. railNudge (not scrollIntoView — see the note
       above) keeps it in view
       without ever moving the page; the IntersectionObserver below calls this on
       every page scroll. */
    const setActive = (id) => thumbs.forEach((t) => {
      const on = t.dataset.thumbTarget === id;
      t.setAttribute('aria-current', String(on));
      if (on && isWide()) railNudge(t);
    });
    thumbs.forEach((t) => t.addEventListener('click', () => {
      const item = $(`.gallery-item[data-media-id="${t.dataset.thumbTarget}"]`, root);
      if (isWide()) {
        galleryShow(item);
        /* after the swap: centre the clicked thumb so fresh thumbs appear below it.
           galleryShow's railNudge is a no-op here (a clicked thumb is visible by
           definition), so this is the only rail movement — one smooth glide. */
        railCenter(t);
      } else {
        item?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setActive(t.dataset.thumbTarget);
      }
    }));
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (vis[0]) setActive(vis[0].target.dataset.mediaId);
      }, { threshold: [0.4, 0.7] });
      $$('.gallery-item', root).forEach((el) => io.observe(el));
    }
    setActive(thumbs[0].dataset.thumbTarget);
  }

  /* zoom lightbox: opens UNZOOMED (photo
     fitted to the frame), the shopper zooms in/out themselves — pinch on touch,
     double-tap/double-click toggle, ctrl+wheel (= trackpad pinch) on desktop.
     Swipe left/right flips to the prev/next photo while unzoomed; when zoomed,
     one finger pans (native overflow scroll). Arrows + X + Esc unchanged.
     Entry point: a genuine tap on the photo itself — the photo was a heavily
     tapped but otherwise dead PDP element, since only the small icon worked.
     A tap on the photo used to fire the lightbox mid-swipe
     on phones — the pointerdown/up distance guard below is
     the actual fix: a swipe moves the pointer well past the threshold before
     release, so it's ignored, while a real tap (near-zero movement) opens zoom
     on that exact image. */
  const dialog = $('#zoom-dialog');
  if (dialog) {
    let zoomItems = [];
    let zoomIndex = 0;
    /* the magnifier button is GONE from the markup — the
       photograph itself is the only zoom trigger now. The old [data-zoom-open] handler and the
       currentIndex() helper that fed it went with it; they had no other caller.
       zoomOrigin replaces the button as the focus-return target, so closing the dialog
       still hands focus back to something the shopper can see instead of to <body>. */
    let zoomOrigin = null;
    const img = $('img', dialog);
    const inner = $('.zoom-dialog__inner', dialog);
    const prevBtn = $('[data-zoom-prev]', dialog);
    const nextBtn = $('[data-zoom-next]', dialog);
    /* Rebuilt on the standard viewer model (Panzoom/PhotoSwipe): the photo sits
       at its FIT size, all zoom/pan is ONE GPU transform `translate(tx,ty) scale(s)`
       around the centre, driven by unified pointer events. Swipe-to-flip is not
       used — it conflicted with pan gestures while zoomed (a pan while zoomed
       kept firing next-image); navigation is arrows + keyboard only. */
    const Z_MAX = 4;
    let zScale = 1, zTx = 0, zTy = 0;
    let fitW = 0, fitH = 0;
    const zApply = () => {
      img.style.transform = (zScale === 1 && !zTx && !zTy)
        ? 'none' : `translate(${zTx}px, ${zTy}px) scale(${zScale})`;
      inner?.classList.toggle('is-zoomed', zScale > 1.02); /* cursor feedback, CSS end-block */
    };
    const zClamp = () => {
      /* no gap may open past an edge once the scaled photo exceeds the frame;
         smaller than the frame stays centred */
      const maxX = Math.max(0, (fitW * zScale - inner.clientWidth) / 2);
      const maxY = Math.max(0, (fitH * zScale - inner.clientHeight) / 2);
      zTx = Math.min(maxX, Math.max(-maxX, zTx));
      zTy = Math.min(maxY, Math.max(-maxY, zTy));
    };
    /* zoom towards a focal point (client coords — the dialog is full-viewport):
       the image pixel under the fingers/cursor stays put */
    const zoomTo = (next, px, py) => {
      if (!inner || !fitW) return;
      next = Math.min(Z_MAX, Math.max(1, next));
      const fx = (px ?? inner.clientWidth / 2) - inner.clientWidth / 2;
      const fy = (py ?? inner.clientHeight / 2) - inner.clientHeight / 2;
      zTx = fx - (fx - zTx) * (next / zScale);
      zTy = fy - (fy - zTy) * (next / zScale);
      zScale = next;
      if (zScale < 1.001) { zScale = 1; zTx = 0; zTy = 0; }
      zClamp();
      zApply();
    };
    /* every freshly shown photo starts UNZOOMED: fit to frame, transform reset */
    const centerPan = () => {
      if (!inner) return;
      const iw = img.naturalWidth || 1024;
      const ih = img.naturalHeight || 1536;
      const s = Math.min(inner.clientWidth / iw, inner.clientHeight / ih);
      fitW = Math.max(1, Math.floor(iw * s));
      fitH = Math.max(1, Math.floor(ih * s));
      img.style.width = fitW + 'px';
      zScale = 1; zTx = 0; zTy = 0;
      img.classList.remove('is-anim');
      zApply();
    };
    const showZoom = (i) => {
      zoomIndex = (i + zoomItems.length) % zoomItems.length;
      const item = zoomItems[zoomIndex];
      const src = item.dataset.zoomSrc;
      const alt = $('img', item)?.alt || '';
      /* keep the current photo on screen until the next master is ready — an
         instant src swap leaves an empty <img> over the dark backdrop while the
         1024px file downloads */
      const pre = new Image();
      const commit = () => {
        if (zoomItems[zoomIndex] !== item) return; /* stale load, user moved on */
        img.src = src; img.alt = alt;
        if (img.complete) centerPan();
        else img.addEventListener('load', centerPan, { once: true });
      };
      pre.addEventListener('load', commit, { once: true });
      pre.addEventListener('error', commit, { once: true }); /* never strand the dialog */
      pre.src = src;
      if (pre.complete) commit();
      /* warm both neighbours so the next arrow press is instant */
      [zoomIndex + 1, zoomIndex - 1].forEach((n) => {
        const nb = zoomItems[(n + zoomItems.length) % zoomItems.length];
        if (nb && nb !== item && nb.dataset.zoomSrc) { new Image().src = nb.dataset.zoomSrc; }
      });
    };
    const openZoom = (startIndex) => {
      /* !hidden (not offsetParent): desktop keeps non-current images display:none, they must stay zoomable */
      zoomItems = $$('.gallery-item', root).filter((el) => el.dataset.zoomSrc && !el.hidden);
      if (!zoomItems.length) return;
      const single = zoomItems.length < 2;
      if (prevBtn) prevBtn.hidden = single;
      if (nextBtn) nextBtn.hidden = single;
      showZoom(startIndex);
      dialog.showModal();
    };
    prevBtn?.addEventListener('click', () => showZoom(zoomIndex - 1));
    nextBtn?.addEventListener('click', () => showZoom(zoomIndex + 1));
    dialog.addEventListener('keydown', (e) => {
      if (!zoomItems.length) return;
      if (e.key === 'ArrowLeft') showZoom(zoomIndex - 1);
      if (e.key === 'ArrowRight') showZoom(zoomIndex + 1);
    });
    /* focus goes back to the photograph that opened the dialog. It used to go to the
       magnifier button, which no longer exists — without a target, focus would
       fall to <body> and a keyboard shopper would restart at the top of the page. */
    dialog.addEventListener('close', () => { img.src = ''; img.style.width = ''; img.style.transform = ''; zScale = 1; zTx = 0; zTy = 0; zoomOrigin?.focus({ preventScroll: true }); });

    /* unified pointer gestures (mouse + touch + pen), one state machine:
       1 pointer  → pan the zoomed photo (dead at scale 1 — swipe-nav removed),
       2 pointers → pinch around the midpoint + two-finger pan,
       quick tap ×2 / double-click → toggle fit ↔ 2.5× at that spot,
       wheel → zoom at the cursor. touch-action:none + gesture* preventDefault
       keep Safari from page-zooming the dialog. */
    const zPointers = new Map();
    let zGesture = null; /* {mode, moved, startX, startY, startTx, startTy, lastDist, lastMid} */
    let zLastTap = { t: 0, x: 0, y: 0 };
    const zMid = () => {
      const [a, b] = [...zPointers.values()];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
    };
    inner?.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return; /* arrows/X keep their clicks */
      img.classList.remove('is-anim');
      zPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { inner.setPointerCapture(e.pointerId); } catch {}
      if (zPointers.size === 2) {
        const m = zMid();
        zGesture = { mode: 'pinch', moved: 99, lastDist: m.d, lastMid: m };
      } else if (zPointers.size === 1) {
        zGesture = { mode: 'pan', moved: 0, startX: e.clientX, startY: e.clientY, startTx: zTx, startTy: zTy };
      }
    });
    inner?.addEventListener('pointermove', (e) => {
      if (!zPointers.has(e.pointerId) || !zGesture) return;
      zPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (zGesture.mode === 'pinch' && zPointers.size === 2) {
        const m = zMid();
        if (m.d > 0 && zGesture.lastDist > 0) zoomTo(zScale * (m.d / zGesture.lastDist), m.x, m.y);
        zTx += m.x - zGesture.lastMid.x;
        zTy += m.y - zGesture.lastMid.y;
        zClamp();
        zApply();
        zGesture.lastDist = m.d;
        zGesture.lastMid = m;
      } else if (zGesture.mode === 'pan') {
        const dx = e.clientX - zGesture.startX;
        const dy = e.clientY - zGesture.startY;
        zGesture.moved = Math.max(zGesture.moved, Math.hypot(dx, dy));
        if (zScale > 1) {
          zTx = zGesture.startTx + dx;
          zTy = zGesture.startTy + dy;
          zClamp();
          zApply();
        }
      }
    });
    const zUp = (e) => {
      if (!zPointers.has(e.pointerId)) return;
      zPointers.delete(e.pointerId);
      if (zPointers.size === 1) {
        /* pinch → pan hand-off with the remaining finger, never a tap */
        const [rest] = [...zPointers.values()];
        zGesture = { mode: 'pan', moved: 99, startX: rest.x, startY: rest.y, startTx: zTx, startTy: zTy };
        return;
      }
      if (zPointers.size > 0) return;
      const g = zGesture;
      zGesture = null;
      if (!g || g.mode !== 'pan' || g.moved >= 10 || e.type === 'pointercancel') return;
      /* clean tap: double-tap/double-click toggles the zoom at that spot */
      /* A mouse has no pinch, so on
         fine pointers a SINGLE click toggles fit <-> 2.5x at the cursor.
         Touch (phone/tablet) keeps the double-tap — a single tap there is too
         easy to hit accidentally while handling the photo. */
      if (e.pointerType === 'mouse') {
        img.classList.add('is-anim');
        zoomTo(zScale > 1.02 ? 1 : 2.5, e.clientX, e.clientY);
        return;
      }
      const now = Date.now();
      if (now - zLastTap.t < 350 && Math.hypot(e.clientX - zLastTap.x, e.clientY - zLastTap.y) < 40) {
        img.classList.add('is-anim');
        zoomTo(zScale > 1.02 ? 1 : 2.5, e.clientX, e.clientY);
        zLastTap.t = 0;
      } else {
        zLastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    };
    inner?.addEventListener('pointerup', zUp);
    inner?.addEventListener('pointercancel', zUp);
    inner?.addEventListener('wheel', (e) => {
      e.preventDefault(); /* wheel = zoom at the cursor (ctrl-wheel = trackpad pinch) */
      img.classList.remove('is-anim');
      zoomTo(zScale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.006 : 0.0015)), e.clientX, e.clientY);
    }, { passive: false });
    /* Safari's proprietary page-zoom gesture must never grab the dialog */
    ['gesturestart', 'gesturechange'].forEach((t) =>
      inner?.addEventListener(t, (e) => e.preventDefault()));

    /* tap-to-zoom on the photo itself, guarded against swipes: a real tap moves
       the pointer under TAP_SLOP px between down and up; a swipe moves it much
       further before release, so the gallery's own scroll keeps working
       untouched and this never double-fires alongside it. */
    const TAP_SLOP = 10;
    let tapStart = null;
    gal?.addEventListener('pointerdown', (e) => { tapStart = { x: e.clientX, y: e.clientY }; }, { passive: true });
    gal?.addEventListener('pointerup', (e) => {
      if (!tapStart) return;
      const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
      tapStart = null;
      if (moved > TAP_SLOP) return;
      const item = e.target.closest('.gallery-item');
      if (!item || !item.dataset.zoomSrc) return;
      const zoomable = $$('.gallery-item', root).filter((el) => el.dataset.zoomSrc && !el.hidden);
      const idx = zoomable.indexOf(item);
      zoomOrigin = item;
      /* the tapped photo GLIDES to centre first, then the zoom
         opens. Opening the dialog in the same frame swallows that movement entirely,
         so the zoom is deferred just long enough for the glide to be seen.
         Only on the mobile snap-scroll gallery: on desktop one image already fills the
         frame, there is nothing to glide, and a delay there would just feel slow.
         Reduced motion skips the glide and opens immediately. */
      const canGlide = gal && gal.scrollWidth > gal.clientWidth + 4
        && !matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (canGlide) {
        item.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
        setTimeout(() => openZoom(idx > -1 ? idx : 0), 260);
      } else {
        openZoom(idx > -1 ? idx : 0);
      }
    });
    gal?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const item = e.target.closest('.gallery-item');
      if (!item || !item.dataset.zoomSrc) return;
      e.preventDefault();
      const visible = $$('.gallery-item', root).filter((el) => el.dataset.zoomSrc && !el.hidden);
      const idx = visible.indexOf(item);
      zoomOrigin = item;
      openZoom(idx > -1 ? idx : 0);
    });
  }

  /* related products — recommendations API fetch (static render is empty by design) */
  const related = $('[data-related]');
  if (related) {
    const url = `${S.recommendationsUrl}?section_id=${related.dataset.sectionId}&product_id=${related.dataset.productId}&intent=related&limit=6`;
    fetch(url)
      .then((r) => r.text())
      .then((html) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const grid = doc.querySelector('[data-related-grid]');
        const fallback = related.querySelector('[data-related-target].product-grid');
        if (grid && grid.children.length) {
          related.querySelector('[data-related-target]').replaceWith(grid);
          paintSwatches(grid);
          emit('view_item_list', { list: 'related' });
        } else if (fallback) {
          emit('view_item_list', { list: 'related' }); /* server-side collection fallback stays */
        } else {
          related.remove();
        }
      })
      .catch(() => { if (!related.querySelector('[data-related-target].product-grid')) related.remove(); });
  }
  emit('view_item', { product: data });
}

/* ---------- predictive search ---------- */
function initSearch() {
  $$('[data-predictive]').forEach((wrap) => {
    const input = $('input[type="search"]', wrap);
    const panel = $('.predictive__panel', wrap);
    if (!input || !panel) return;
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { panel.hidden = true; return; }
      timer = setTimeout(async () => {
        const res = await fetch(`${S.searchUrl}?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=5&section_id=predictive-search`);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const items = doc.querySelector('[data-predictive-results]');
        panel.innerHTML = items ? items.innerHTML : '';
        panel.hidden = !panel.innerHTML.trim();
        emit('search', { query: q });
      }, 240);
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) panel.hidden = true; });
  });
}

/* ---------- cart page (/cart): section re-render ----------
   Re-render only; the cart API change already happened. Both surfaces refresh
   each other because the drawer is rendered on every page, so on /cart it sits
   behind the page and would otherwise keep a stale copy — a common cart-state
   desync class in Shopify themes. No listener binding here:
   qty controls run off the single delegated listener (invariant 3). */
async function refreshCartPage() {
  const root = $('[data-cart-page]');
  if (!root) return; /* not on /cart — nothing to refresh, not an error */
  const fresh = await fetchSection(`/cart?section_id=${root.dataset.cartSection}`, '[data-cart-page]');
  /* re-query after the await for the same reason as the drawer: a pre-await
     reference may already be detached, and replaceWith() would no-op silently */
  const current = $('[data-cart-page]');
  if (!current) throw new Error('cart page markup missing');
  current.replaceWith(fresh);
}

/* ---------- FAQ / accordions: native <details>; JS height animation only where
   CSS `interpolate-size` is unsupported (WebKit/iOS), matching the desktop ease ---------- */
function initAccordions() {
  if (CSS.supports('interpolate-size', 'allow-keywords')) return;
  /* border-box: height clamps at the body's padding, so padding must animate too
     or the last ~20px vanish in one frame at the end (visible jerk on iOS) */
  const EASE = 'cubic-bezier(0.33, 1, 0.68, 1)', MS = 320;
  $$('details.acc').forEach((d) => {
    const summary = $('summary', d);
    const body = $('.acc__body', d);
    if (!summary || !body) return;
    body.style.overflow = 'clip';
    const frames = (opening) => {
      const pb = getComputedStyle(body).paddingBottom;
      const h = `${body.offsetHeight}px`;
      return opening
        ? { height: ['0px', h], paddingBottom: ['0px', pb], opacity: [0, 1] }
        : { height: [h, '0px'], paddingBottom: [pb, '0px'], opacity: [1, 0] };
    };
    let anim = null;
    summary.addEventListener('click', (e) => {
      e.preventDefault();
      anim?.cancel();
      if (d.open && !d.classList.contains('closing')) {
        d.classList.add('closing');
        anim = body.animate(frames(false), { duration: MS, easing: EASE });
        anim.onfinish = () => { d.open = false; d.classList.remove('closing'); anim = null; };
      } else {
        d.classList.remove('closing');
        d.open = true;
        anim = body.animate(frames(true), { duration: MS, easing: EASE });
        anim.onfinish = () => { anim = null; };
      }
    });
  });
}

/* ---------- newsletter popup (theme-owned) ----------
   Replaced the Shopify Forms popup: its fixed overlay broke under the iOS
   keyboard (visual-viewport pan + app autofocus). This one is plain DOM: <dialog>
   top-layer, no transform animations, no autofocus, 16px input — nothing for
   iOS to fight. Native customer form posts into the same subscriber list, so
   any welcome-discount automation keeps working. */

/* ---------- boot ----------
   No cart binding here any more: the qty controls of BOTH surfaces run off the
   one delegated listener registered next to changeCartLine (invariant 3). */
/* The header is permanently frosted in CSS on every template, so the old
   scroll listener that toggled `.at-top` is gone —
   one fewer scroll handler and no transparent state to get wrong. */

/* Header: hide on scroll down, slide back on scroll up. Direction from the scroll delta; never
   hidden near the top (the announcement bar is the first trust signal), and
   never while something inside the header owns focus (open search, keyboard). */
(function initHeaderHide() {
  const wrap = $('.hdr-wrap');
  if (!wrap) return;
  let lastY = window.scrollY;
  addEventListener('scroll', () => {
    const y = window.scrollY;
    const dy = y - lastY;
    lastY = y;
    if (Math.abs(dy) < 4) return;
    if (wrap.matches(':focus-within')) return;
    /* hide from the very first downward scroll; y > 10 only avoids rubber-band jitter */
    if (dy > 0 && y > 10) wrap.classList.add('is-hidden');
    else if (dy < 0) wrap.classList.remove('is-hidden');
  }, { passive: true });
})();

/* quiet reveals: .reveal → .is-in once in view. Reduced motion never gets a
   transition (theme.css), so revealing everything up front is the honest path. */
(function initReveal() {
  const els = $$('.reveal');
  if (!els.length) return;
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    els.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add('is-in');
      io.unobserve(e.target);
    });
  /* 200px pre-trigger: at '-8%' a fast scroll reached sections while
     still opacity:0 — whole viewports read as blank until the transition caught up. */
  }, { rootMargin: '0px 0px 200px 0px' });
  els.forEach((el) => io.observe(el));
})();

/* The floating search pill and its two helpers (footer fade-out + rotating hint
   lines, with the setInterval they needed) were removed. Do not reintroduce. */

/* ---------- cart add-on upsells ----------
   The row is a toggle. REMOVING reuses the [data-qty-change] delegate above
   (invariant 3), so only ADDING needs a hook — /cart/change.js cannot create a
   line that does not exist yet. */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-upsell-add]');
  if (t) addToCart(Number(t.dataset.upsellAdd), 1, t);
});

/* ---------- newsletter popup + reminder ----------
   Markup: snippets/newsletter-popup.liquid.
   Every branch below is a bug someone already paid for — read the comments
   before simplifying any of them. */
function initNewsletterPopup() {
  const dlg = $('#nl-popup');
  if (!dlg) return;
  /* the reminder pill was removed, so
     [data-nl-teaser] may legitimately be absent. This used to be `if (!dlg || !teaser)
     return;` — with the pill gone that early return killed the POPUP as well, which is
     a landmine for anyone who later deletes the leftover hidden stub. The teaser is now
     optional everywhere below; showTeaser() and lift() no-op without it. */
  const teaser = $('[data-nl-teaser]');

  const KEY = 'theme-nl';
  let state = {};
  try { state = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* private mode */ }
  const save = (o) => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* private mode */ } };

  /* already subscribed -> never ask again. The customer form redirects back with
     ?customer_posted=true, so catch both the rendered success state and the URL. */
  if (dlg.querySelector('[data-nl-posted]') || new URLSearchParams(location.search).has('customer_posted')) {
    save({ done: 1 });
    if (dlg.querySelector('[data-nl-posted]')) dlg.showModal();
    return;
  }
  if (state.done) return;

  const showTeaser = (on) => { if (teaser) teaser.hidden = !on; };

  /* the PDP buy bar is fixed at the bottom and slides in on scroll; lift the
     pill clear of it so the two never overlap on a phone */
  const barwrap = $('[data-barwrap]');
  const lift = () => {
    if (!barwrap || !teaser) return;
    const shown = barwrap.classList.contains('is-shown');
    teaser.style.setProperty('--nl-lift', shown ? -(barwrap.offsetHeight + 8) + 'px' : '0px');
    teaser.classList.toggle('lift', shown);
  };
  if (barwrap) {
    lift();
    addEventListener('scroll', () => requestAnimationFrame(lift), { passive: true });
    addEventListener('resize', lift, { passive: true });
  }

  teaser?.addEventListener('click', (e) => {
    /* the X dismisses for good; anywhere else on the pill opens the popup */
    if (e.target.closest('[data-nl-teaser-dismiss]')) { save({ done: 1 }); showTeaser(false); return; }
    dlg.showModal();
    showTeaser(false);
  });

  dlg.addEventListener('close', () => { save({ ts: Date.now() }); showTeaser(true); lift(); });

  /* /cart is checkout-critical: neither the popup (covers the Checkout button)
     nor the auto-teaser (transiently overlaps the full-width CTA while
     scrolling). Nothing auto-appears there; the offer meets the shopper on
     every other template — checkout-first beats one more impression. */
  if (document.body.classList.contains('template-cart')) return;

  const dismissedRecently = state.ts && Date.now() - state.ts < 30 * 864e5;
  if (dismissedRecently) { showTeaser(true); lift(); return; }

  /* never auto-open over ANY open overlay: the cart drawer, quick view, zoom,
     size chart and mobile nav are modal <dialog>s (showModal() would stack this
     popup in the top layer ABOVE the open bag), and the PDP size sheet is a DIV
     toggled via [hidden] — caught by the second selector. If something is open
     at the 8s mark, fall back to the pill so the offer stays reachable instead
     of silently vanishing for the session. */
  setTimeout(() => {
    if (document.querySelector('dialog[open], [data-vsheet]:not([hidden])')) { showTeaser(true); lift(); }
    else dlg.showModal();
  }, 8000);
}

/* the per-block modules (cart-extras.js, pdp-extras.js) must be able
   to mutate the cart. They MUST NOT fetch /cart/*.js themselves: every cart write in this
   theme goes through the FIFO queue, the counted freeze and the stale-cart reload
   documented in the four invariants at the top of this file, and a second unserialised
   writer reopens exactly the bugs those invariants close (wrong totals, one tap firing two
   requests, a mutation landing on the wrong line). Exposing the two entry points is the
   cheapest way to keep one queue for the whole page. */
S.addToCart = addToCart;
S.refreshCart = refreshCartSurfaces;

/* ---------- gift-card recipient ----------
   The fieldset ships `disabled`, which is what makes opting out work: a disabled
   field is not submitted, so a card bought for yourself posts no recipient and
   behaves exactly as it did before the fields existed. All this does is flip
   that on when the shopper says it is a gift — with no JavaScript the fieldset
   stays disabled and the card still sells, it just cannot be sent to someone
   else, which is a degraded feature rather than a broken page. */
function initGiftCard() {
  document.querySelectorAll('[data-gift-card]').forEach((root) => {
    const toggle = root.querySelector('[data-gift-card-toggle]');
    const fields = root.querySelector('[data-gift-card-fields]');
    if (!toggle || !fields) return;
    const sync = () => {
      fields.disabled = !toggle.checked;
      if (toggle.checked) fields.querySelector('input, textarea')?.focus({ preventScroll: true });
    };
    toggle.addEventListener('change', sync);
    sync();
  });
}

paintSwatches();
initAccordions();
initPDP();
initGiftCard();
placeCartExpress(); /* initial move, before the wallet script has painted */
initSearch();
loadCartCross().catch(() => {}); /* fill the drawer's recommendation shell on first paint */
initNewsletterPopup();
if (document.body.classList.contains('template-404')) emit('404', { path: location.pathname });
