#!/usr/bin/env bash
# Package the theme into an install-ready zip with a STABLE filename, so the
# GitHub "latest release" download URL never changes. Version travels in the
# release tag/title, read from settings_schema.json.
set -euo pipefail

VERSION=$(python3 -c "import json; print(json.load(open('config/settings_schema.json'))[0]['theme_version'])")
OUT="toolsuite-base-theme.zip"
rm -f toolsuite-base-theme*.zip

zip -r -X "$OUT" \
  assets config layout locales sections snippets templates \
  -x "config/settings_data.json" \
  -x "*.DS_Store" -x "__MACOSX/*" >/dev/null

{
  echo "version=$VERSION"
  echo "zip=$OUT"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"
echo "Packaged $OUT (theme v$VERSION)"
