# Changelog

All notable changes to the ToolSuite Base Theme. Versioning is semantic
(MAJOR.MINOR.PATCH) and lives in `config/settings_schema.json` → `theme_version`.
Bump it here and there in the same commit; pushing to `main` cuts the release.

## 1.3.0 — 2026-09-11

### What's new

- Added: **global style controls.** Until now the only thing you could change about the theme's appearance was seven colours — nothing controlled type, spacing, page width or the product card, so making the theme feel like your store meant editing code. Three new setting groups:
  - **Typography** — a heading font and a body font, a type scale (Compact / Default / Generous) that moves every display size together so the proportions survive the change, heading letter-spacing, and body text size (15–18px). The theme's own Prata and Archivo stay the default and stay local files, so a store that changes nothing keeps exactly the same fonts and the same load time; a Shopify-hosted font is only requested once you actually pick one.
  - **Layout & rhythm** — page width (1200–1600px), section spacing (Tight / Default / Airy) and corner style (Sharp / Soft / Round). Page width and section spacing now govern every contained surface in the store from one setting each.
  - **Product cards** — image shape (Portrait / Tall / Square), hover behaviour (None / Second image / Zoom), show vendor, quick add, and show cents in prices.
  - Two new colours under **Colors**: **Section band**, the alternating surface behind a full-width band, and **Secondary text**, a darker voice for sentences than the existing Secondary label (which stays the small-uppercase colour). Your existing seven colours are untouched.
- Added: **the product page was rebuilt around the buy box.**
  - The size and colour pickers now print the value you have selected next to the option name, on every option — size never showed it at all.
  - Sizes that are sold out in every combination stay visible and struck through instead of vanishing, so a shopper can see the size exists. They remain reachable by keyboard.
  - A **quantity control** — the product page previously posted no quantity at all, so a shopper who wanted three had to add one, open the bag, and step it up twice.
  - **The product can be bought with JavaScript switched off or broken.** The buy box is a real product form with a real variant control, so the add button works even when nothing loads. The instant add-to-bag is now an enhancement on top rather than the only path.
  - The gallery renders **video, external video (YouTube/Vimeo) and 3D previews.** All three were silently dropped before — a product whose second media was a video showed nothing for it. The mobile gallery also gained the dot indicator it was always meant to have.
  - The reassurance row under the button can show three cards instead of two, and sizes itself to its text so a second line can no longer be clipped.
- Added: **hero settings.** Height (Tall / Medium / Short), a focal point so the crop keeps the subject, a caption tone for light or dark type, a **scrim** you can set from 0 to 80%, and an underline-or-button CTA style. White type over a white garment is now something you can fix rather than something the theme decides for you.
- Added: category tiles can put the label **below** the frame instead of over the photograph, per tile — the right answer for pale photography, because nothing is painted over the picture at all.
- Added: **four footer link-list columns** (was three fixed menus) plus a **language selector** next to the country selector.

### What's fixed

- Fixed: **grids no longer run flush to the edge of the screen.** Product grids sat at a hardcoded 2px gap with no page margin, so cards touched each other and touched the browser edge. Grids now carry the page frame and the real column/row spacing, and sections are separated by a proper chapter break instead of a flat gap everywhere.
- Fixed: the amber buy bar's label failed the WCAG AA contrast minimum. The label colour was fixed to the pale tone from both branches of a broken condition and measured 3.19:1 on the shipped amber. The label colour is now chosen by measuring your amber at render time — 5.48:1 today, and it flips back automatically if you choose a darker amber. Your chosen amber is kept exactly as picked.
- Fixed: **the same product no longer prints "$240.00" in one place and "$240" in another.** Every price in the theme — cards, product page, cart, drawer, totals, the quick view and the add-to-bag bar — now goes through one formatting rule driven by **Show cents in prices**. The prices drawn by JavaScript (cart drawer, variant switching) read the same setting, which is what the two halves of the store were disagreeing about.
- Fixed: the quantity control posted the quantity you typed only when JavaScript was off. With JavaScript on it always added 1, and its + / − buttons did nothing at all. Both now work.
- Fixed: a size that is sold out in the combination you are currently looking at now stays reachable by keyboard and by screen reader instead of dropping out of the page entirely. It is still struck through and still cannot be added — but a shopper can now discover that the size exists, which is the whole point of showing it.
- Fixed: picking a size with the buttons now also updates the form's own variant field, so pressing Enter in the quantity box adds the size you chose rather than the one the page opened on.
- Fixed: the **Tall (3:4)** card image shape did nothing — cards stayed at 2:3 and the reserved image box was the wrong height, so picking it caused layout shift for no visual change.
- Fixed: the product name and the price on a card were the same size and weight, so neither read as the more important. The name is now the product and the price is the fact.
- Fixed: the sale flag and the quick-add button moved **off the photograph.** The flag was a solid red box over the garment and the quick-add was an unlabelled circle on it; the flag is now text and the quick-add is a labelled control in the caption, where it never has to compete with a photo for contrast.
- Fixed: the discount percentage on a card is plain text rather than a red chip, and prices line up in columns (tabular figures) so a grid of prices reads as a column of numbers.
- Fixed: the hero caption can no longer be clipped — the caption now sizes the section rather than being laid over a fixed-height box.
- Fixed: category tiles are back to their intended 4:5 / 3:4 crops instead of 2:3 everywhere, and the mosaic is truly gapless rather than 1–2px apart.
- Fixed: the brand story section no longer falls back to Shopify's stock camera/watch/compass line drawing when you have not set an image. An unset image renders as copy only, full width.
- Fixed: panels (cart drawer, filter panel, mobile menu, toast) have their own inset, so the wider page margin on a large screen no longer pushes 64px of padding into a 420px drawer.
- Fixed: the footer's legal and returns lines are no longer ~11px grey. They are demoted into their own colophon band at a 13px floor — quiet, but readable by a shopper and by a Merchant Center reviewer.

### What you may need to do

- **Pick your footer menus.** The footer's four columns are link lists now. Until you choose them in **Footer → Link lists**, those columns are empty. Your three previous menus still work and are used automatically wherever you have not set a new one; they are grouped under "Link lists (legacy)".
- **Check your page width.** The default contained width is now 1320px, where the theme previously used 1440px. If you want the old measure, set **Layout & rhythm → Page width** to 1600.
- **If you had customised the Cream colour to tint the full-width band** under the homepage highlight section, that band now uses the new **Section band** colour. Set it to your tint; Cream still governs every other image plate.
- **Look at your hero with the new scrim.** It ships at 45%, which is a visible change on a hero that previously had a pale wash. Set it to 0 if your photography does not need it.
- Card names and prices are deliberately smaller and quieter than before. If your catalogue reads too small on a phone, raise both one step rather than changing the colour.

## 1.2.4 — 2026-09-11
- Fixed: your store's own name now appears in the browser tab and in social link previews. The homepage title, meta description and share title were hardcoded placeholder text ("BRAND | Women's Fashion") that no theme setting could reach, so every store published it. New settings under **Brand & SEO**: a homepage tagline and a homepage meta description, both optional — left empty, the title is simply your store name.
- Fixed: placeholder brand text removed everywhere it was still baked in — the FAQ answers, the brand-story copy, the newsletter popup, the social-proof heading and the checkout tip line. The FAQ and popup now read your store name automatically, and the fake `info@BRAND-DOMAIN` return address (a dead link on every store) is gone from the shipped FAQ.
- Fixed: the GPSR distributor line on product pages now prints your real business name instead of a placeholder, taken from Business information (or your store name).
- Fixed: a fresh install no longer requests five brand image files that were never shipped — the logo, two favicons, the touch icon and the structured-data logo. A neutral default favicon now ships with the theme, the header/footer lockup sets your store name in type until you upload a logo, and the app icon plus the Google seller logo are generated from a **Logo** or **Square logo** you upload under Brand & SEO. Nothing 404s, and the old JavaScript fallback that swapped out the broken logo after load is gone.
- Fixed: headings and copy you type into a section are no longer discarded on a second language. Bestsellers, FAQ, customer reviews, brand story, hero, editorial, category tiles, highlight, proof band, related products, the announcement bar and the cart drawer all replaced your text with the theme's built-in copy on any non-primary language. Your wording now wins in every language, and the built-in copy is only used where you left a field empty. This also affected the shipping, returns and money-back lines on the product page — a translated storefront could advertise terms you had never written.
- Fixed: secondary text now meets the WCAG AA contrast minimum. The default "Secondary label" colour sat at 3.46:1 on the paper background, below the 4.5:1 requirement; it is now 5.14:1 (and 4.67:1 on cream), still the same warm grey. Stores that set their own colour are untouched.
- Removed: every invented urgency and proof number. The scarcity line dealt each product a red/amber/green "stock level" calculated from its product ID, and the "N people are viewing this item" line hashed the product ID and then drifted the number at random every few seconds — neither had any data behind it. Both are deleted, along with the shipped default rating (4.7 from 1,284 reviews) and customer count ("Over 1,000+ happy customers") that no new store had earned. **The rating, review-count and stock-line settings all remain**, so you can enter your own real figures; they now ship empty and print nothing until you do.

## 1.2.3 — 2026-09-10
- Added an optional Popup section (one quiet offer — heading, body, button, delay, show-once). Off by default; add it from any template and enable it. On-brand (ink on paper, serif heading), dismissable, and remembered per visitor.

## 1.2.2 — 2026-09-10
- Fixed: the licensing notice's 'Manage license' link now points to the Obsidian app (obsidian.toolsuite.com/dashboard), where theme + membership management moved. The old link (toolsuite.com/dashboard/resources) no longer exists.

## 1.2.1 — 2026-09-10
- Fixed: the theme's Colors settings (paper, ink, cream, hairline, mute) now actually take effect. theme.css kept standalone fallback tokens that loaded after the settings-injected values and silently overrode them; the settings-driven colours are now re-injected after theme.css so your palette applies on the storefront and in the editor.

## 1.2.0 — 2026-09-10
- Added ToolSuite membership licensing: the theme verifies your active membership on load (license key pre-filled in your dashboard download). Inactive/missing → notice in the editor and storefront.

## 1.1.1 — 2026-09-10
- Release announcements now post to the #releases Discord channel.

## 1.1.0 — 2026-09-10
- Versioning pipeline verified end-to-end (git → release → hub).
- Members now see the version, changelog and update date on Dashboard → Resources.

## 1.0.0 — 2026-09-10
- Initial ToolSuite Base Theme (Online Store 2.0): sections, product &
  collection templates, default layout.
