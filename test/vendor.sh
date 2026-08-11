#!/usr/bin/env bash
# Fetch the vendored Ghostscript-WASM into app/static/vendor/.
#
# The files are committed rather than installed at build time — there is no npm
# in this image and no build step to add one to, and a CDN at runtime would mean
# every person compressing a PDF tells jsdelivr they are doing it. The whole
# point of moving this into the browser is that nothing leaves it.
#
# Run this only to change version; the result is checked in.
#
#   ./test/vendor.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=1.0.1
DEST=app/static/vendor
URL="https://registry.npmjs.org/ghostscript-wasm-esm/-/ghostscript-wasm-esm-${VERSION}.tgz"

# Ghostscript is AGPL-3.0 and so is this build. Serving it to a browser is
# distribution, so LICENSE ships beside it and stays reachable — see
# app/templates/pdf.html for the link users actually get.
WANT=(gs.mjs gs.wasm browser.js LICENSE)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "fetching ghostscript-wasm-esm@${VERSION}…"
curl -fsSL --max-time 300 -o "$work/p.tgz" "$URL"
tar xzf "$work/p.tgz" -C "$work"

mkdir -p "$DEST"
for f in "${WANT[@]}"; do
  cp "$work/package/$f" "$DEST/$f"
done

# A record of what is in here and where it came from, so the next person does
# not have to guess whether these bytes were edited by hand.
{
  echo "ghostscript-wasm-esm@${VERSION}"
  echo "$URL"
  echo "AGPL-3.0 — see LICENSE in this directory"
  echo
  sha256sum "${WANT[@]/#/$DEST/}" | sed "s|$DEST/||"
} > "$DEST/VENDOR.txt"

cat "$DEST/VENDOR.txt"
