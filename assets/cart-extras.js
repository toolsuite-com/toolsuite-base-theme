/* Cart enhancements. Every cart WRITE goes through window.Theme.addToCart
   or a refreshed [data-qty-change] control, keeping theme.js's single FIFO
   mutation queue, counted freeze and stale-view reload as the only writer. */
const S = window.Theme || {};
/* locale prefix for hardcoded storefront-data fetches, from Shopify.routes.root
   (e.g. "/xx-yy/" on a secondary-locale storefront, "/" on the default). Only
   for reads that render translatable text (product/collection JSON); cart
   endpoints are excluded, see below. */
const LROOT = (window.Shopify && Shopify.routes && Shopify.routes.root) || '/';
const $ = (selector, context = document) => context.querySelector(selector);
const $$ = (selector, context = document) => [...context.querySelectorAll(selector)];

const DEADLINE_KEY = 'theme:cart-reservation-deadline';
const DECLINED_KEY = (id) => `theme:addon-declined:${id}`;
const CROSS_FOLDED_KEY = 'theme:cross-folded';
const productCache = new Map();
let countdownTimer = 0;
let preselectInFlight = false;
let miniState = null;

function storageGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { sessionStorage.setItem(key, String(value)); } catch { /* private mode */ }
}
function storageRemove(key) {
  try { sessionStorage.removeItem(key); } catch { /* private mode */ }
}
function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}
/* Classic Shopify.formatMoney token formatter — mirrors assets/theme.js's
   money(), which see for why: the old version only replaced the literal
   {{amount}} token and left {{amount_with_comma_separator}} (the live EUR
   moneyFormat) unreplaced in the DOM. Kept as a separate copy, not an import,
   because every script here loads as its own independent <script type="module">
   with no cross-file imports (see layout/theme.liquid). */
function formatWithDelimiters(cents, precision, thousands, decimal) {
  const amount = Math.abs(Number(cents) || 0) / 100;
  const parts = amount.toFixed(precision).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
  return precision > 0 ? `${intPart}${decimal}${parts[1]}` : intPart;
}
function money(cents) {
  try {
    const format = S.moneyFormat || '€{{amount}}';
    const match = format.match(/\{\{\s*(\w+)\s*\}\}/);
    if (!match) return `€${formatWithDelimiters(cents, 2, ',', '.')}`;
    let value;
    switch (match[1]) {
      case 'amount_no_decimals': value = formatWithDelimiters(cents, 0, ',', '.'); break;
      case 'amount_with_comma_separator': value = formatWithDelimiters(cents, 2, '.', ','); break;
      case 'amount_no_decimals_with_comma_separator': value = formatWithDelimiters(cents, 0, '.', ','); break;
      case 'amount_with_apostrophe_separator': value = formatWithDelimiters(cents, 2, "'", '.'); break;
      case 'amount':
      default: value = formatWithDelimiters(cents, 2, ',', '.'); break;
    }
    return format.replace(/\{\{\s*\w+\s*\}\}/, value).replace(/<[^>]+>/g, '');
  } catch {
    return `€${(Number(cents || 0) / 100).toFixed(2)}`;
  }
}
function imageSource(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.src || value.url || '';
}
function sizedImage(src, width) {
  if (!src) return '';
  return `${src}${src.includes('?') ? '&' : '?'}width=${width}`;
}
function imageKey(src) {
  try { return new URL(src, location.origin).pathname.replace(/_[0-9]+x(?=\.)/, '').toLowerCase(); }
  catch { return String(src || '').split('?')[0].toLowerCase(); }
}
function sameImage(a, b) { return Boolean(a && b && imageKey(a) === imageKey(b)); }
function productURL(product) { return product.url || `/products/${product.handle}`; }

async function waitForCartAPI() {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (typeof S.addToCart === 'function') return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
async function fetchProduct(handle) {
  if (!productCache.has(handle)) {
    productCache.set(handle, fetch(`${LROOT}products/${encodeURIComponent(handle)}.js`, { headers: { Accept: 'application/json' } })
      .then((response) => {
        if (!response.ok) throw new Error(`Product ${response.status}`);
        return response.json();
      })
      .catch((error) => { productCache.delete(handle); throw error; }));
  }
  return productCache.get(handle);
}

/* ---------- reservation countdown ---------- */
function tickCountdown() {
  const timeNodes = $$('[data-cart-countdown-time]');
  if (!timeNodes.length) return;
  const deadline = Number(storageGet(DEADLINE_KEY) || 0);
  const remaining = Math.max(0, deadline - Date.now());
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  timeNodes.forEach((node) => { node.textContent = `${minutes}:${seconds}`; });
  if (totalSeconds === 0 && countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = 0;
  }
}
function hydrateCountdown(inner) {
  const itemCount = Number(inner?.dataset.cartCountSrc || 0);
  const shell = $('[data-cart-countdown]', inner || document);
  if (itemCount <= 0) {
    storageRemove(DEADLINE_KEY);
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = 0;
    return;
  }
  if (!shell) {
    storageRemove(DEADLINE_KEY); /* setting is zero: fully off */
    return;
  }
  const minutes = Number(shell.dataset.cartCountdownMin || 0);
  if (minutes <= 0) return;
  /* An EXPIRED deadline is still a truthy number, so the old `if (!deadline)`
     guard never replaced it: once the window ran out the drawer showed a frozen
     "0:00" for the rest of the session. A reservation that has lapsed starts
     again the next time the bag is opened — which matches common reference-store
     behavior. */
  if (Number(storageGet(DEADLINE_KEY)) <= Date.now()) storageSet(DEADLINE_KEY, Date.now() + minutes * 60 * 1000);
  tickCountdown();
  if (!countdownTimer && Number(storageGet(DEADLINE_KEY)) > Date.now()) countdownTimer = window.setInterval(tickCountdown, 1000);
}

/* ---------- preselected real add-ons ---------- */
function markAddonDeclined(id) {
  if (id) storageSet(DECLINED_KEY(id), '1');
}
document.addEventListener('click', (event) => {
  const decline = event.target.closest('[data-addon-decline]');
  if (decline) markAddonDeclined(decline.dataset.addonDecline);
}, true);

/* THE TRIGGER IS THE SHOPPER'S OWN ADD, NOT PAGE LOAD: the cart must not already
   be pre-filled just from loading the page — the add-ons should only ride along
   once the shopper actually adds something themselves.

   theme.js emits theme:add_to_cart only for adds a shopper actually made — the
   add-ons themselves go through addToCart with {silent:true}, emit nothing, and
   therefore cannot re-arm this. Arming a flag rather than running immediately is
   load-bearing: the event fires BEFORE refreshCartSurfaces, so at that moment
   [data-cart-upsells-config] still carries the PREVIOUS data-real-count — on a
   first add that is 0 and the run would abort. hydrateDrawer() is called after
   the drawer's wholesale replacement, i.e. once the count is true. */
let addonsArmed = false;
document.addEventListener('theme:add_to_cart', () => { addonsArmed = true; });

async function preselectAddons() {
  if (preselectInFlight) return;
  const root = $('[data-cart-upsells-config]');
  if (!root || root.dataset.upsellPreselect !== 'true' || Number(root.dataset.realCount || 0) <= 0) return;
  const addons = $$('[data-addon-variant]', root);
  if (!addons.length) return;
  preselectInFlight = true;
  try {
    if (!(await waitForCartAPI())) return;
    for (const addon of addons) {
      const id = addon.dataset.addonVariant;
      if (!id) continue;
      /* per-row opt-in: only Shipping Protection carries
         data-addon-preselect="true" — Priority Shipping is a manual tick. */
      if (addon.dataset.addonPreselect !== 'true') continue;
      if (addon.dataset.addonPresent === 'true') continue;
      /* ONLY an explicit decline blocks re-adding.
         The old `|| AUTO_KEY` skip also blocked the case where the add-ons left
         the cart WITHOUT a decline — e.g. a cart cleared elsewhere (another tab,
         /cart/clear, checkout return) while this tab's session kept the
         "already auto-added" mark: next real add then silently brought no
         add-ons. Every UI removal path (Remove, minus at qty 1, checkbox
         untick) carries data-addon-decline, so decline alone is the guard. */
      if (storageGet(DECLINED_KEY(id))) continue;
      /* silent: no "Added to cart" toast and no add_to_cart event — the shopper
         did not do this. See addToCart in theme.js. */
      await S.addToCart(Number(id), 1, null, { silent: true });
    }
  } finally {
    preselectInFlight = false;
  }
}

/* ---------- cart-line variant swap ---------- */
document.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-cart-variant-option]');
  if (!select) return;
  const line = select.closest('[data-cart-line]');
  if (!line || !(await waitForCartAPI())) return;
  const optionIndex = Number(select.dataset.optionIndex);
  /* optionIndex === -1: the drawer ships ONE select listing whole variants
     ("Beige / L") instead of one per option, so its value IS the variant id and
     there is nothing to resolve (see the Liquid). The per-option path stays for
     the cart PAGE, which still renders one select per option and has the width
     for it. */
  const wholeVariant = optionIndex === -1;
  let currentOptions = [];
  if (!wholeVariant) {
    try { currentOptions = JSON.parse(line.dataset.currentOptions || '[]'); } catch { return; }
  }
  const previousValue = wholeVariant ? String(select.dataset.oldVariantId || '') : currentOptions[optionIndex];
  if (!wholeVariant) {
    $$('[data-cart-variant-option]', line).forEach((control) => {
      currentOptions[Number(control.dataset.optionIndex)] = control.value;
    });
  }
  const controls = $$('button, select', line);
  controls.forEach((control) => { control.disabled = true; });
  try {
    const product = await fetchProduct(line.dataset.productHandle);
    const variant = wholeVariant
      ? product.variants.find((candidate) => String(candidate.id) === String(select.value))
      : product.variants.find((candidate) => candidate.options.every((value, index) => value === currentOptions[index]));
    if (!variant || !variant.available) {
      select.value = previousValue;
      select.setCustomValidity(S.t?.optionUnavailable || 'This option combination is unavailable.');
      select.reportValidity();
      select.setCustomValidity('');
      return;
    }
    const oldId = String(select.dataset.oldVariantId || '');
    if (String(variant.id) === oldId) return;
    const quantity = Math.max(1, Number(select.dataset.oldQuantity || 1));
    const added = await S.addToCart(Number(variant.id), quantity);
    if (!added) {
      select.value = previousValue;
      return;
    }
    /* addToCart resolves only after its queued refresh. Query the FRESH zero
       control, then let theme.js's delegated listener queue the old-line remove. */
    const remove = $$('[data-qty-change="0"][data-variant-id]').find((button) => button.dataset.variantId === oldId);
    if (remove) remove.click();
  } catch {
    select.value = previousValue;
  } finally {
    if (line.isConnected) controls.forEach((control) => { control.disabled = false; });
  }
});

/* ---------- rich fixed cart recommendation ---------- */
function productAvailable(product) {
  return product.available !== false && (!product.variants || product.variants.some((variant) => variant.available));
}
async function recommendationPicks(root) {
  const cartResponse = await fetch(S.cartUrl || '/cart.js', { headers: { Accept: 'application/json' } });
  if (!cartResponse.ok) throw new Error(`Cart ${cartResponse.status}`);
  const cart = await cartResponse.json();
  const seed = cart.items?.[0];
  if (!seed) return [];
  const inCart = new Set(cart.items.map((item) => Number(item.product_id)));
  const excludedHandles = new Set((root.dataset.addonHandles || '').split(',').filter(Boolean));
  let products = [];
  try {
    const base = S.recommendationsUrl || `${LROOT}recommendations/products`;
    const response = await fetch(`${base}.json?product_id=${seed.product_id}&limit=10&intent=related`, { headers: { Accept: 'application/json' } });
    if (response.ok) products = (await response.json()).products || [];
  } catch { /* collection fallback below */ }
  let picks = products.filter((product) => productAvailable(product) && !inCart.has(Number(product.id)) && !excludedHandles.has(product.handle));
  if (!picks.length) {
    try {
      const response = await fetch(`${LROOT}collections/new-in/products.json?limit=16`, { headers: { Accept: 'application/json' } });
      if (response.ok) picks = ((await response.json()).products || [])
        .filter((product) => productAvailable(product) && !inCart.has(Number(product.id)) && !excludedHandles.has(product.handle));
    } catch { /* hide the optional band */ }
  }
  const seen = new Set();
  return picks.filter((product) => product.handle && !seen.has(product.handle) && seen.add(product.handle)).slice(0, 8);
}
function priceMarkup(variant) {
  if (!variant) return '';
  return variant.compare_at_price > variant.price
    ? `<s>${escapeHTML(money(variant.compare_at_price))}</s> <span class="price--sale">${escapeHTML(money(variant.price))}</span>`
    : escapeHTML(money(variant.price));
}
/* NO PRE-SELECTED VARIANT. This theme's standing rule is that a size is never
   chosen for the shopper; the PDP and the quick view both enforce it, and the
   reason is returns: a blind add posts whatever size happened to be first.
   NO NATIVE <select> EITHER — it cannot be styled to this theme on iOS at all.
   The size is instead chosen via the mini product page below, which this card
   could always open from its bag icon — that icon is now the whole control.
   Single-variant products keep the direct Add; there is nothing to choose. */
async function buildCrossCard(summary) {
  let product;
  try { product = await fetchProduct(summary.handle); } catch { return null; }
  const variants = product.variants.filter((variant) => variant.available);
  const variant = variants[0] || product.variants[0];
  if (!variant) return null;
  const featured = imageSource(summary.featured_image) || imageSource(product.featured_image) || imageSource(product.media?.find((media) => media.media_type === 'image'));
  const actions = variants.length > 1
    ? `<button type="button" class="cart-cross-card__choose lbl-sm" data-cart-miniview-open aria-label="${escapeHTML((S.t?.chooseSize || 'Choose size') + ' – ' + product.title)}">${escapeHTML(S.t?.chooseSize || 'Choose size')}</button>`
    : `<button type="button" class="cart-cross-card__add" data-cart-cross-add data-variant-id="${variant.id}" aria-label="${escapeHTML(S.t?.addToBag || 'Add to bag')}"><span data-atc-label>${escapeHTML(S.t?.addShort || 'Add')}</span></button>`;
  const html = `
    <article class="cart-cross-card" data-cart-cross-card data-handle="${escapeHTML(product.handle)}" data-product-url="${escapeHTML(productURL(product))}" data-lead-image="${escapeHTML(featured)}">
      <a class="cart-cross-card__media" href="${escapeHTML(productURL(product))}" aria-label="${escapeHTML(product.title)}">
        ${featured ? `<img src="${escapeHTML(sizedImage(featured, 180))}" alt="${escapeHTML(product.title)}" width="72" height="92" loading="lazy">` : ''}
      </a>
      <div class="cart-cross-card__body">
        <a class="cart-cross-card__title" href="${escapeHTML(productURL(product))}">${escapeHTML(product.title)}</a>
        <div class="cart-cross-card__price lbl-sm" data-cart-cross-price>${priceMarkup(variant)}</div>
        <div class="cart-cross-card__actions">${actions}</div>
      </div>
    </article>`;
  return { product, html };
}
async function renderCross(root) {
  const picks = root._cartCrossPicks || [];
  if (!picks.length) { root.hidden = true; return; }
  const index = Math.max(0, Math.min(Number(root.dataset.crossIndex || 0), picks.length - 1));
  root.dataset.crossIndex = String(index);
  const token = String((Number(root.dataset.renderToken || 0) + 1));
  root.dataset.renderToken = token;
  /* Two stacked cards. The pager still steps by one, so the pair window slides
     card-by-card; the second slot wraps around rather than sitting empty on the
     last pick. */
  const wanted = [picks[index]];
  if (picks.length > 1) wanted.push(picks[(index + 1) % picks.length]);
  const built = (await Promise.all(wanted.map(buildCrossCard))).filter(Boolean);
  if (!root.isConnected || root.dataset.renderToken !== token) return;
  if (!built.length) { root.hidden = true; return; }
  const row = $('[data-cart-cross-row]', root);
  root._rendering = true;
  row.innerHTML = built.map((card) => card.html).join('');
  root._rendering = false;
  Array.from(row.children).forEach((element, i) => { element._product = built[i].product; });
  $('[data-cart-cross-status]', root).textContent = `${index + 1} / ${picks.length}`;
  $$('[data-cart-cross-prev], [data-cart-cross-next]', root).forEach((button) => { button.disabled = picks.length < 3; });
  root.hidden = false;
}
/* Warm every recommendation, not just the visible one — the image should not
   start loading when you switch to the product. The arrows step
   through up to eight picks; each step otherwise waits on a product fetch AND a
   cold image. Both are cached — fetchProduct by productCache, the image by the
   browser — so this runs once and every later call is free. Fire-and-forget: a
   failed warm-up must never take the band down with it. */
function warmPicks(picks) {
  picks.forEach((pick) => {
    const src = imageSource(pick.featured_image);
    if (src) new Image().src = sizedImage(src, 180);
    fetchProduct(pick.handle).catch(() => {});
  });
}

async function loadRichCross(root) {
  if (!root || root._loading) return;
  root._loading = true;
  try {
    root._cartCrossPicks = await recommendationPicks(root);
    root.dataset.crossIndex = '0';
    await renderCross(root);
    warmPicks(root._cartCrossPicks);
    const row = $('[data-cart-cross-row]', root);
    if (row && !root._legacyGuard) {
      root._legacyGuard = new MutationObserver(() => {
        if (!root._rendering && root._cartCrossPicks?.length && !$('[data-cart-cross-card]', row)) renderCross(root);
      });
      root._legacyGuard.observe(row, { childList: true });
    }
  } catch { root.hidden = true; }
  finally { root._loading = false; }
}

document.addEventListener('click', async (event) => {
  const previous = event.target.closest('[data-cart-cross-prev]');
  const next = event.target.closest('[data-cart-cross-next]');
  if (previous || next) {
    /* The arrows sit inside the band's <summary> — without preventDefault every
       page-turn would also toggle the <details> fold. */
    event.preventDefault();
    const root = event.target.closest('[data-cart-cross]');
    const count = root?._cartCrossPicks?.length || 0;
    if (!count) return;
    const direction = next ? 1 : -1;
    root.dataset.crossIndex = String((Number(root.dataset.crossIndex || 0) + direction + count) % count);
    renderCross(root);
    return;
  }
  const add = event.target.closest('[data-cart-cross-add]');
  if (add) {
    /* no id = no size chosen yet. Number('') is 0, which would reach the cart API as a
       nonsense variant, so the guard is here and not only on the disabled attribute. */
    const crossVariantId = Number(add.dataset.variantId);
    if (crossVariantId && await waitForCartAPI()) S.addToCart(crossVariantId, 1, add);
    return;
  }
  const card = event.target.closest('[data-cart-cross-card]');
  if (card && !event.target.closest('a, button, select, label')) location.href = card.dataset.productUrl;
});

/* ---------- mini product page inside the drawer ---------- */
const colorNames = ['color', 'colour'];
const swatchMap = {
  black:'#1f1d1b', noir:'#1f1d1b', white:'#fff', cream:'#f1e8d8', ivory:'#f1e8d8', beige:'#d9c7a7', tan:'#c08a5a',
  brown:'#5b3a29', chocolate:'#5b3a29', cognac:'#9a5b2f', burgundy:'#6e2231', red:'#b3282d', pink:'#e8a9b8',
  blue:'#3b5b8c', navy:'#22304a', green:'#3e6b4f', olive:'#6b6a45', sage:'#a8b39a', grey:'#8c8c8c', gray:'#8c8c8c',
  purple:'#5c3a5e', lilac:'#b9a7cb', orange:'#c96a2b', yellow:'#e3c13f'
};
function swatchColor(value) { return swatchMap[String(value).toLowerCase().trim().replace(/\s+/g, '-')] || '#d8d2c8'; }
function mediaColors(alt, values) {
  const text = String(alt || '').toLowerCase();
  return values.filter((value) => text.includes(` in ${String(value).toLowerCase()},`) || text.includes(` in ${String(value).toLowerCase()}-`));
}
function colorHero(product, optionIndex, values, value) {
  const tagged = product.media?.find((media) => media.media_type === 'image' && mediaColors(media.alt, values).includes(value));
  if (tagged) return imageSource(tagged);
  const variant = product.variants.find((item) => item.options[optionIndex] === value && imageSource(item.featured_image));
  return imageSource(variant?.featured_image);
}
function leadColorFor(product, leadSrc, colorIndex) {
  if (colorIndex < 0) return null;
  const values = product.options[colorIndex].values;
  const exactMedia = product.media?.find((media) => media.media_type === 'image' && sameImage(imageSource(media), leadSrc));
  const tagged = exactMedia ? mediaColors(exactMedia.alt, values)[0] : null;
  if (tagged) return tagged;
  const variant = product.variants.find((item) => sameImage(imageSource(item.featured_image), leadSrc));
  if (variant) return variant.options[colorIndex];
  const firstTagged = product.media?.find((media) => media.media_type === 'image' && mediaColors(media.alt, values).length);
  return firstTagged ? mediaColors(firstTagged.alt, values)[0] : null;
}
function miniElements(panel) {
  return {
    image: $('[data-cart-mv-img]', panel), title: $('[data-cart-mv-title]', panel), price: $('[data-cart-mv-price]', panel),
    options: $('[data-cart-mv-options]', panel), atc: $('[data-cart-mv-atc]', panel), label: $('[data-cart-mv-atc-label]', panel),
    link: $('[data-cart-mv-link]', panel)
  };
}
function miniVariantFor(product, options) { return product.variants.find((variant) => variant.options.every((value, index) => value === options[index])); }
function miniPartialFor(product, options) { return product.variants.filter((variant) => variant.options.every((value, index) => options[index] == null || value === options[index])); }
function renderMini() {
  if (!miniState?.panel?.isConnected) return;
  const { product, options, panel } = miniState;
  const els = miniElements(panel);
  const unselected = options.includes(null);
  const variant = unselected ? null : miniVariantFor(product, options);
  const priceVariant = variant || miniPartialFor(product, options).find((item) => item.available) || miniPartialFor(product, options)[0] || product.variants[0];
  els.price.innerHTML = priceMarkup(priceVariant);
  if (priceVariant?.compare_at_price > priceVariant.price) {
    const percent = Math.round((priceVariant.compare_at_price - priceVariant.price) * 100 / priceVariant.compare_at_price);
    els.price.insertAdjacentHTML('beforeend', ` <span class="cart-miniview__badge">-${percent}%</span>`);
  }
  /* Same rule as the PDP and the quick view: the button reads fully opaque,
     never dimmed. Load-bearing here for a second reason: the button is sticky,
     so a 38%-opacity one let the size row show straight through it. Disabled
     only when there is nothing to add. */
  els.atc.disabled = !unselected && !variant?.available;
  els.atc.classList.toggle('bar--awaiting', unselected);
  els.atc.dataset.variantId = variant?.id || '';
  els.label.textContent = unselected ? (S.t?.selectSize || 'Select a size') : !variant ? (S.t?.unavailable || 'Unavailable') : variant.available ? (S.t?.addToBag || 'Add to bag') : (S.t?.soldOut || 'Sold out');
  $$('[data-cart-mv-opt]', els.options).forEach((button) => {
    const index = Number(button.dataset.optionIndex);
    button.setAttribute('aria-pressed', String(options[index] === button.dataset.optionValue));
    const test = [...options];
    test[index] = button.dataset.optionValue;
    button.disabled = !miniPartialFor(product, test).some((item) => item.available);
  });
  const colorIndex = product.options.findIndex((option) => colorNames.includes(option.name.toLowerCase()));
  const color = colorIndex > -1 ? options[colorIndex] : null;
  let image = miniState.preferredImage;
  if (!image || (color && leadColorFor(product, image, colorIndex) !== color)) {
    image = color ? colorHero(product, colorIndex, product.options[colorIndex].values, color) : '';
  }
  image ||= imageSource(priceVariant?.featured_image) || imageSource(product.featured_image) || imageSource(product.media?.find((media) => media.media_type === 'image'));
  if (image) {
    els.image.src = sizedImage(image, 720);
    els.image.alt = product.title;
  }
}
/* THE SHARED PICKER CLASSES, NOT PRIVATE ONES: this panel must read as the same
   mini product page as the quick view. .opt / .swatches /
   .swatch / .sizes / .size-btn are theme.css's documented variant-picker contract —
   the PDP, the quick view and now this panel all render the same markup, so
   pdp-extras.css styles all three from one rule and they cannot drift again.
   The [data-cart-mv-opt] hooks are untouched; only the class names change. */
function buildMiniOptions(product, state) {
  return product.options.map((option, optionIndex) => {
    if (option.values.length < 2) return '';
    const isColor = colorNames.includes(option.name.toLowerCase());
    /* option NAMES are English base data ("Color"/"Size") — route the label
       through the same locale keys the PDP uses;
       VALUES stay raw, the alt-text parser depends on them */
    const optLabel = isColor ? (S.t?.optionColor || option.name)
      : /size/i.test(option.name) ? (S.t?.optionSize || option.name) : option.name;
    const controls = option.values.map((value) => {
      const hero = isColor ? colorHero(product, optionIndex, option.values, value) : '';
      const style = isColor && !hero ? ` style="background-color:${swatchColor(value)}"` : '';
      const image = isColor && hero ? `<img src="${escapeHTML(sizedImage(hero, 144))}" alt="" loading="lazy">` : '';
      const skin = isColor ? `swatch${hero ? ' swatch--img' : ''}` : 'size-btn';
      return `<button type="button" class="${skin}" data-cart-mv-opt data-option-index="${optionIndex}" data-option-value="${escapeHTML(value)}" aria-pressed="${state[optionIndex] === value}" aria-label="${escapeHTML(value)}"${style}>${image}${isColor ? '<span class="visually-hidden">' + escapeHTML(value) + '</span>' : escapeHTML(value)}</button>`;
    }).join('');
    return `<fieldset class="opt"><div class="opt__head"><legend class="opt__label">${escapeHTML(optLabel)}</legend></div><div class="${isColor ? 'swatches' : 'sizes'}" role="group" aria-label="${escapeHTML(optLabel)}">${controls}</div></fieldset>`;
  }).join('');
}
async function openMiniView(trigger) {
  const card = trigger.closest('[data-cart-cross-card]');
  const handle = card?.dataset.handle;
  if (!handle) return;
  const product = card._product || await fetchProduct(handle);
  const panel = $('[data-cart-miniview]');
  if (!panel) return;
  const colorIndex = product.options.findIndex((option) => colorNames.includes(option.name.toLowerCase()));
  const leadColor = leadColorFor(product, card.dataset.leadImage, colorIndex);
  const first = (leadColor && product.variants.find((variant) => variant.available && variant.options[colorIndex] === leadColor))
    || product.variants.find((variant) => variant.available) || product.variants[0];
  const options = [...first.options];
  const sizeIndex = product.options.findIndex((option) => /size/i.test(option.name));
  if (sizeIndex > -1 && product.options[sizeIndex].values.length > 1) options[sizeIndex] = null;
  miniState = { product, options, panel, returnFocus: trigger, preferredImage: card.dataset.leadImage };
  const els = miniElements(panel);
  els.title.textContent = product.title;
  els.link.href = productURL(product);
  els.options.innerHTML = buildMiniOptions(product, options);
  panel.hidden = false;
  panel.setAttribute('aria-hidden', 'false');
  renderMini();
  $('[data-cart-miniview-close]', panel)?.focus();
}
function closeMiniView() {
  if (!miniState) return;
  const { panel, returnFocus } = miniState;
  panel.hidden = true;
  panel.setAttribute('aria-hidden', 'true');
  miniState = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}
document.addEventListener('click', async (event) => {
  const open = event.target.closest('[data-cart-miniview-open]');
  if (open) { event.preventDefault(); try { await openMiniView(open); } catch { /* product link remains available */ } return; }
  if (event.target.closest('[data-cart-miniview-close]')) { closeMiniView(); return; }
  const option = event.target.closest('[data-cart-mv-opt]');
  if (option && miniState && !option.disabled) {
    miniState.options[Number(option.dataset.optionIndex)] = option.dataset.optionValue;
    miniState.preferredImage = '';
    renderMini();
    return;
  }
  const atc = event.target.closest('[data-cart-mv-atc]');
  if (atc && miniState && !atc.disabled) {
    const id = Number(atc.dataset.variantId);
    if (id) { if (await waitForCartAPI()) S.addToCart(id, 1, atc); return; }
    /* no size yet: acknowledge the press and take them to the row, never add */
    atc.classList.remove('bar--nudged');
    void atc.offsetWidth;
    atc.classList.add('bar--nudged');
    setTimeout(() => atc.classList.remove('bar--nudged'), 400);
    const row = $('.sizes', miniState.panel);
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('opts-attn');
      setTimeout(() => row.classList.remove('opts-attn'), 1200);
    }
  }
});
document.addEventListener('keydown', (event) => {
  if (!miniState) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeMiniView();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = $$('a[href], button:not([disabled]), select:not([disabled])', miniState.panel).filter((element) => !element.hidden);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}, true);

/* remember the shopper's fold state of the recommendation band. toggle does
   not bubble — capture. Applying the stored state in hydrateDrawer() re-fires
   toggle with the same value, which is harmlessly idempotent. */
document.addEventListener('toggle', (event) => {
  const cross = event.target?.matches?.('[data-cart-cross]') ? event.target : null;
  if (cross) storageSet(CROSS_FOLDED_KEY, cross.open ? '0' : '1');
}, true);

/* ---------- wholesale drawer rehydration ---------- */
function hydrateDrawer() {
  if (miniState?.panel && !miniState.panel.isConnected) {
    miniState = null;
    requestAnimationFrame(() => $('#cart-drawer [data-close-dialog]')?.focus());
  }
  const inner = $('#cart-drawer .cart-drawer__inner');
  if (inner) hydrateCountdown(inner);
  const cross = inner && $('[data-cart-cross]', inner);
  if (cross) {
    /* the <details> ships open, but a shopper's fold sticks for the session —
       every mutation re-renders the inner, which used to snap it back open. */
    if (storageGet(CROSS_FOLDED_KEY) === '1') cross.open = false;
    loadRichCross(cross);
  }
  if (addonsArmed) { addonsArmed = false; preselectAddons(); }
}
function initCartExtras() {
  hydrateDrawer();
  const drawer = $('#cart-drawer');
  if (drawer) {
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => [...mutation.addedNodes].some((node) => node.nodeType === 1 && node.matches?.('.cart-drawer__inner')))) hydrateDrawer();
    });
    /* subtree IS load-bearing — without it this whole
       module is dead after the first cart change. Shopify wraps every {% section %} in
       its own <div id="shopify-section-…">, so .cart-drawer__inner is a GRANDCHILD of
       #cart-drawer, not a child. theme.js's refreshCartDrawer() replaces the inner, which
       mutates that wrapper — an observer watching only the dialog's direct children never
       sees it. Symptom before the fix: countdown never re-hydrated, the rich cross-sell
       row stayed empty and the pre-selected add-ons were never added, all silently. */
    observer.observe(drawer, { childList: true, subtree: true });
  }
}

initCartExtras();
