# Changelog

All notable changes to the ToolSuite Base Theme. Versioning is semantic
(MAJOR.MINOR.PATCH) and lives in `config/settings_schema.json` → `theme_version`.
Bump it here and there in the same commit; pushing to `main` cuts the release.

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
