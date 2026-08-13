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

GS_VERSION=1.0.1
PDFJS_VERSION=6.2.108
DEST=public/vendor
GS_URL="https://registry.npmjs.org/ghostscript-wasm-esm/-/ghostscript-wasm-esm-${GS_VERSION}.tgz"
PDFJS_URL="https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${PDFJS_VERSION}.tgz"

# Ghostscript is AGPL-3.0 and so is this build. Serving it to a browser is
# distribution, so LICENSE ships beside it and stays reachable — see
# templates/pdf.html for the link users actually get. PDF.js is Apache-2.0 and
# its licence rides along for the same reason.
GS_WANT=(gs.mjs gs.wasm browser.js LICENSE)
# Only the minified build and its worker. The .map files are five megabytes of
# debugging aid for code nobody here will step through.
PDFJS_WANT=(build/pdf.min.mjs build/pdf.worker.min.mjs LICENSE)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$DEST"

echo "fetching ghostscript-wasm-esm@${GS_VERSION}…"
curl -fsSL --max-time 300 -o "$work/gs.tgz" "$GS_URL"
mkdir -p "$work/gs" && tar xzf "$work/gs.tgz" -C "$work/gs"
for f in "${GS_WANT[@]}"; do cp "$work/gs/package/$f" "$DEST/$f"; done

echo "fetching pdfjs-dist@${PDFJS_VERSION}…"
curl -fsSL --max-time 300 -o "$work/pdfjs.tgz" "$PDFJS_URL"
mkdir -p "$work/pdfjs" && tar xzf "$work/pdfjs.tgz" -C "$work/pdfjs"
for f in "${PDFJS_WANT[@]}"; do
  # Flattened: build/pdf.min.mjs becomes pdf.min.mjs, and LICENSE would collide
  # with Ghostscript's, so it is named for what it covers.
  case "$f" in
    LICENSE) cp "$work/pdfjs/package/$f" "$DEST/LICENSE-pdfjs" ;;
    *) cp "$work/pdfjs/package/$f" "$DEST/$(basename "$f")" ;;
  esac
done

# A record of what is in here and where it came from, so the next person does
# not have to guess whether these bytes were edited by hand.
{
  echo "ghostscript-wasm-esm@${GS_VERSION}  AGPL-3.0  (LICENSE)"
  echo "  $GS_URL"
  echo "pdfjs-dist@${PDFJS_VERSION}  Apache-2.0  (LICENSE-pdfjs)"
  echo "  $PDFJS_URL"
  echo
  (cd "$DEST" && sha256sum gs.mjs gs.wasm browser.js LICENSE \
                           pdf.min.mjs pdf.worker.min.mjs LICENSE-pdfjs)
} > "$DEST/VENDOR.txt"

cat "$DEST/VENDOR.txt"
