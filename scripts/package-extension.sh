#!/usr/bin/env bash
# ============================================================================
# package-extension.sh - builds the zip to upload to the Chrome Web Store.
#
# Usage: ./scripts/package-extension.sh        (from anywhere in the repo)
# Output: dist/check-tracking-extension-<version>.zip  (dist/ is git-ignored)
#
# Lists the shipped files explicitly rather than zipping the whole folder, so
# extension/README.md, extension/store-assets/ and stray .DS_Store files
# never end up in the package. If you add a file the extension loads at
# runtime, add it to FILES below too.
#
# Before each upload: bump "version" in extension/manifest.json (the store
# rejects a version it has already seen), then run this.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(manifest.json background.js bookmarklet.source.js icon16.png icon32.png icon48.png icon128.png)

if ! cmp -s bookmarklet.source.js extension/bookmarklet.source.js; then
  echo "extension/bookmarklet.source.js is out of date. Run:"
  echo "  cp bookmarklet.source.js extension/bookmarklet.source.js"
  exit 1
fi
for f in "${FILES[@]}"; do
  [ -f "extension/$f" ] || { echo "missing extension/$f"; exit 1; }
done

VERSION=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' extension/manifest.json | sed -E 's/.*"([^"]+)"$/\1/')
mkdir -p dist
OUT="dist/check-tracking-extension-$VERSION.zip"
rm -f "$OUT"
(cd extension && zip -X -q "../$OUT" "${FILES[@]}")
echo "Built $OUT (version $VERSION):"
unzip -l "$OUT" | sed 's/^/  /'
echo
echo "Reminder: run ./scripts/network-guard.sh before uploading."
