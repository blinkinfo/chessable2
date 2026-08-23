#!/bin/sh
# Packages Chessable for Firefox (including Firefox for Android) as a .xpi.
#
# The .xpi contains only what Firefox needs:
#   - manifest.json, icon.png, scripts/main.js
#   - the SINGLE-THREADED Stockfish 18 NNUE build (works everywhere; the
#     multi-threaded build needs SharedArrayBuffer, which content-script
#     workers on Firefox do not get without cross-origin isolation).
#
# Result: ./chessable-firefox.xpi  (~113 MB, under AMO's 200 MB limit)
#
# Run `npm install` first so engine/ exists.
set -e
cd "$(dirname "$0")/.."

OUT="chessable-firefox.xpi"

for f in manifest.json icon-16.png icon-48.png icon-128.png scripts/main.js \
         engine/stockfish-18-single.js engine/stockfish-18-single.wasm; do
  if [ ! -f "$f" ]; then
    echo "Missing $f — run 'npm install' (or 'npm run setup') first." >&2
    exit 1
  fi
done

rm -f "$OUT"
zip -q -X "$OUT" manifest.json icon-16.png icon-48.png icon-128.png scripts/main.js \
  engine/stockfish-18-single.js engine/stockfish-18-single.wasm

echo "Created $OUT ($(du -h "$OUT" | cut -f1))"
