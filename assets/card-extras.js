/* card-extras.js — swatch → card image preview + in-card selection.

   Clicking a swatch must NOT navigate. It selects the colour inside the card —
   the lead image swaps to that colour and stays there, and the card's image/title
   links repoint to ?variant=<id>. Clicking the image or title then opens the
   product page on the selected colour. Hover/focus still previews non-destructively
   and restores to the SELECTED colour (cardOriginal moves with the selection).

   Delegated, so it also covers cards injected later (the related row on a PDP,
   paginated collection loads) without re-binding. Nothing here is required for
   the swatch to work: with JS off it is still a plain link to the right variant. */

function cardImageOf(el) {
  const card = el.closest('.card');
  const media = card?.querySelector('.card__media');
  const img = media?.querySelector('.card__art img');
  return img ? { card, media, img } : null;
}

function swapCardImage(swatch) {
  const src = swatch.dataset.cardSwap;
  if (!src) return;
  const found = cardImageOf(swatch);
  if (!found) return;
  const { card, media, img } = found;

  /* remember the shot the card shipped with, once — restoring from a stale
     "previous" is how these previews end up stuck on the wrong colour */
  if (!img.dataset.cardOriginal) img.dataset.cardOriginal = img.currentSrc || img.src;
  if (img.src === src) return;

  /* srcset keeps winning over a plain src swap on a responsive image */
  img.removeAttribute('srcset');
  img.removeAttribute('sizes');
  img.src = src;
  media.classList.add('is-swatch-preview');

  card.querySelectorAll('.card__swatch[aria-current]').forEach((el) => el.removeAttribute('aria-current'));
  swatch.setAttribute('aria-current', 'true');
}

function restoreCardImage(card) {
  if (!card) return;
  const media = card.querySelector('.card__media');
  const img = media?.querySelector('.card__art img');
  if (!img || !img.dataset.cardOriginal) return;
  img.src = img.dataset.cardOriginal;
  media.classList.remove('is-swatch-preview');
  card.querySelectorAll('.card__swatch[aria-current]').forEach((el) => el.removeAttribute('aria-current'));
}

/* hover only where hovering is real — on a touch screen pointerover fires on the
   tap itself and would swap the image in the same gesture that navigates away */
if (window.matchMedia('(hover: hover)').matches) {
  document.addEventListener('pointerover', (event) => {
    const swatch = event.target.closest?.('.card__swatch[data-card-swap]');
    if (swatch) { swapCardImage(swatch); return; }
    const card = event.target.closest?.('.card');
    if (card && !event.target.closest('.card__swatches')) restoreCardImage(card);
  });
  document.addEventListener('pointerout', (event) => {
    const card = event.target.closest?.('.card');
    if (!card || card.contains(event.relatedTarget)) return;
    restoreCardImage(card);
  });
}

/* click = select in place (never navigate). preventDefault keeps the <a>
   fallback for JS-off; cardOriginal is moved to the chosen shot so every later
   hover-restore returns HERE, and the card's two big links repoint at the
   variant so the next click on image/title opens that colour. */
document.addEventListener('click', (event) => {
  const swatch = event.target.closest?.('.card__swatch[data-card-swap]');
  if (!swatch) return;
  event.preventDefault();
  swapCardImage(swatch);
  const found = cardImageOf(swatch);
  if (!found) return;
  found.img.dataset.cardOriginal = swatch.dataset.cardSwap;
  /* lock: the hover second-shot (.card__alt) shows the ORIGINAL colour and used to
     override the selection the moment the pointer re-entered the card */
  found.media.classList.add('is-swatch-locked');
  const href = swatch.getAttribute('href');
  if (href) {
    found.card.querySelectorAll('.card__art, .card__info').forEach((a) => { a.href = href; });
  }
});

/* keyboard parity: tabbing through the swatches previews the same way */
document.addEventListener('focusin', (event) => {
  const swatch = event.target.closest?.('.card__swatch[data-card-swap]');
  if (swatch) swapCardImage(swatch);
});
document.addEventListener('focusout', (event) => {
  const card = event.target.closest?.('.card');
  if (!card) return;
  /* only restore once focus has genuinely left the card */
  setTimeout(() => { if (!card.contains(document.activeElement)) restoreCardImage(card); }, 0);
});
