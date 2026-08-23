#!/bin/sh
# Packages Chessable for Firefox (including Firefox for Android) as a .xpi.
#
# The .xpi contains only what Firefox needs:
#   - manifest.json, icons, scripts/main.js
#   - engine/host.html + engine/host.js (hidden page hosting the worker)
#   - the Stockfish 18 LITE NNUE build (~7.3 MB wasm, whole — no splitting,
#     well under AMO's per-file limit; boots in seconds on phones)
#
# Result: ./chessable-firefox.xpi  (~4 MB)
#
# Run `npm install` first so engine/ exists.
set -e
cd "$(dirname "$0")/.."

OUT="chessable-firefox.xpi"

for f in manifest.json icon-16.png icon-48.png icon-128.png scripts/main.js \
         engine/host.html engine/host.js \
         engine/stockfish-18-lite-single.js \
         engine/stockfish-18-lite-single.wasm; do
  if [ ! -f "$f" ]; then
    echo "Missing $f — run 'npm install' (or 'npm run setup') first." >&2
    exit 1
  fi
done

rm -f "$OUT"
zip -q -X "$OUT" manifest.json icon-16.png icon-48.png icon-128.png \
  scripts/main.js engine/host.html engine/host.js \
  engine/stockfish-18-lite-single.js \
  engine/stockfish-18-lite-single.wasm

echo "Created $OUT ($(du -h "$OUT" | cut -f1))"
