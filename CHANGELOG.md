# Changelog

All notable changes to the ToolSuite Base Theme. Versioning is semantic
(MAJOR.MINOR.PATCH) and lives in `config/settings_schema.json` → `theme_version`.
Bump it here and there in the same commit; pushing to `main` cuts the release.

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
