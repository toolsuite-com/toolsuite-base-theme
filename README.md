# ToolSuite Base Theme

The ToolSuite base Shopify theme (Online Store 2.0) offered to members from the
dashboard. This repo is the source of truth; members download a packaged zip,
not this tree directly.

## How it ships

Every push to `main`:
1. **Lint** — `shopify theme check` guards Liquid/theme health.
2. **Package** — `scripts/package.sh` zips the theme (excludes `config/settings_data.json`,
   which is store-specific, and repo/dev files) as `toolsuite-base-theme-v<version>.zip`.
3. **Publish** — the zip is uploaded to Vercel Blob at a stable path the hub serves,
   and attached to a GitHub Release tagged with the theme version.

The hub's **Dashboard → Resources** page links the latest zip + shows the version.

## Editing

- Install the [Shopify CLI](https://shopify.dev/docs/themes/tools/cli): `shopify theme dev --store <yourdevstore>` to preview locally.
- Bump `theme_version` in `config/settings_schema.json` when you cut a release —
  the pipeline and the hub read it.
- Keep `config/settings_data.json` generic (no real store data); it's stripped from
  the download anyway, but don't commit a live store's secrets.
