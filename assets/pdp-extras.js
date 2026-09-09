/* PDP-only behaviors. Cart writes deliberately go through window.Theme.addToCart;
   this module never opens a second mutation path around theme.js's queue. */

const root = document.querySelector('[data-product-root]');

function initRatingLink() {
  const link = document.querySelector('[data-scroll-reviews]');
  if (!link) return;
  const reviews = document.querySelector('[id$="__reviews"]');
  if (!reviews) return;

  /* Keep Shopify's section id intact for Theme Editor events. A tiny child anchor
     gives the setting-owned rating a real hash target without owning the review file. */
  if (!document.getElementById('shop-reviews')) {
    const anchor = document.createElement('span');
    anchor.id = 'shop-reviews';
    anchor.hidden = true;
    reviews.prepend(anchor);
  }
  link.addEventListener('click', (event) => {
    event.preventDefault();
    reviews.scrollIntoView({
      block: 'start',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    });
    history.replaceState(null, '', '#shop-reviews');
  });
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function initViewers() {
  document.querySelectorAll('[data-pdp-viewers]').forEach((line) => {
    const output = line.querySelector('[data-viewers-count]');
    const min = Number(line.dataset.viewersMin);
    const max = Number(line.dataset.viewersMax);
    const productId = line.dataset.productId;
    if (!output || !Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) return;

    const storageKey = `theme-pdp-viewers-${productId}`;
    let stored = Number.NaN;
    try { stored = Number(sessionStorage.getItem(storageKey)); } catch { /* private mode */ }
    let current = Number.isInteger(stored) && stored >= min && stored <= max
      ? stored
      : min + (hashString(productId) % (max - min + 1));
    const paint = () => {
      output.textContent = String(current);
      try { sessionStorage.setItem(storageKey, String(current)); } catch { /* private mode */ }
    };
    /* ±1, direction random every tick: the STEP is always one, the SIGN is a
       fresh coin flip. A direction variable that only flips occasionally produces
       a visible ramp; drawing anywhere in the range produces large jumps (e.g.
       12 → 27 → 14). Flipping the sign every tick drifts the way a real counter
       would. At the range edges the step is forced inward, otherwise the number
       would sit still there. */
    const reroll = () => {
      if (min === max) return;
      let step = Math.random() < 0.5 ? -1 : 1;
      if (current + step > max) step = -1;
      if (current + step < min) step = 1;
      current += step;
      paint();
      window.setTimeout(reroll, 4200 + Math.floor(Math.random() * 3600));
    };
    paint();
    window.setTimeout(reroll, 4200 + (hashString(productId) % 2200));
  });
}

/* GALLERY HEIGHT SYNC.
   The slides are exactly as tall as their own photograph, so the flex track
   would reserve the height of the TALLEST image and leave a gap under every
   shorter one — measured 231px on a mixed-format product, which pushes price and
   buy zone below the fold. 26% of products carry mixed formats (size charts are
   often landscape), so this is not an edge case. The track therefore takes the
   height of the slide currently under the snap point; the peeking neighbours are
   clipped by overflow-y, which is what "peek" already means. Desktop shows one
   slide at a time (display:none on the rest) and needs none of this. */
function initGalleryHeightSync() {
  if (!root) return;
  const gallery = root.querySelector('.pdp__gallery');
  if (!gallery) return;
  let raf = 0;
  const phone = matchMedia('(max-width: 899px)');           /* same breakpoint the CSS uses */
  const apply = () => {
    raf = 0;
    if (!phone.matches) { gallery.style.height = ''; return; }   /* desktop shows one slide, no sync */
    const items = [...gallery.querySelectorAll('.gallery-item')].filter((i) => !i.hidden && i.offsetParent !== null);
    if (!items.length) return;
    const mid = gallery.getBoundingClientRect().left + gallery.clientWidth / 2;
    let best = items[0], bestD = Infinity;
    for (const it of items) {
      const r = it.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - mid);
      if (d < bestD) { bestD = d; best = it; }
    }
    const h = Math.round(best.getBoundingClientRect().height);
    if (h > 0) gallery.style.height = h + 'px';
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
  gallery.addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule, { passive: true });
  phone.addEventListener('change', schedule);
  gallery.querySelectorAll('img').forEach((i) => { if (!i.complete) i.addEventListener('load', schedule, { once: true }); });
  new MutationObserver(schedule).observe(gallery, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  schedule();
}

function initGalleryCounter() {
  if (!root) return;
  const gallery = root.querySelector('.pdp__gallery');
  const dots = root.querySelector('[data-gallery-dots]');
  const counter = root.querySelector('[data-gallery-counter]');
  if (!gallery || !counter) return;

  const update = () => {
    const items = [...gallery.querySelectorAll('.gallery-item[data-media-id]')].filter((item) => !item.hidden);
    if (!items.length) { counter.hidden = true; return; }
    counter.hidden = false;

    const dotItems = dots ? [...dots.querySelectorAll('span')] : [];
    const galleryScrolls = gallery.scrollWidth > gallery.clientWidth + 4;
    let total = items.length;
    let index = items.findIndex((item) => item.classList.contains('is-current'));
    if (galleryScrolls && dotItems.length) {
      total = dotItems.length;
      index = dotItems.findIndex((dot) => dot.classList.contains('on'));
    } else {
      const activeThumb = root.querySelector('.pdp__thumb[aria-current="true"]');
      if (activeThumb) index = items.findIndex((item) => item.dataset.mediaId === activeThumb.dataset.thumbTarget);
    }
    counter.textContent = `${Math.max(0, index) + 1} / ${total}`;
  };

  const observer = new MutationObserver(() => requestAnimationFrame(update));
  if (dots) observer.observe(dots, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  observer.observe(gallery, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  root.querySelectorAll('.pdp__thumb').forEach((thumb) => observer.observe(thumb, { attributes: true, attributeFilter: ['aria-current', 'hidden'] }));
  addEventListener('resize', () => requestAnimationFrame(update), { passive: true });
  requestAnimationFrame(update);
}

async function recommendationMarkup(shell, intent) {
  const path = window.Theme?.recommendationsUrl || '/recommendations/products';
  const url = new URL(path, location.origin);
  url.searchParams.set('section_id', shell.dataset.sectionId);
  url.searchParams.set('product_id', shell.dataset.productId);
  url.searchParams.set('intent', intent);
  url.searchParams.set('limit', '3');
  const response = await fetch(url);
  if (!response.ok) return null;
  const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
  return doc.querySelector('[data-complete-look-ready]');
}

async function initCompleteLook() {
  const shell = document.querySelector('[data-complete-look]');
  if (!shell) return;
  const target = shell.querySelector('[data-complete-look-target]');
  if (!target) return;
  try {
    /* Complementary is the semantic source; related is the API-backed fallback
       while Shopify has not yet learned/manual-curated a complementary set. */
    const ready = await recommendationMarkup(shell, 'complementary')
      || await recommendationMarkup(shell, 'related');
    if (!ready || !ready.children.length) { shell.remove(); return; }
    target.replaceChildren(ready);
    shell.hidden = false;
  } catch {
    shell.remove();
  }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-complete-look-add]');
  if (!button || button.disabled) return;
  const variantId = Number(button.dataset.variantId);
  if (!variantId || typeof window.Theme?.addToCart !== 'function') return;
  window.Theme.addToCart(variantId, 1, button);
});

initRatingLink();
initViewers();
initGalleryCounter();
  initGalleryHeightSync();
initCompleteLook();
