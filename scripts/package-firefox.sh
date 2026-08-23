#!/bin/sh
# Packages Chessable for Firefox (including Firefox for Android) as a .xpi.
#
# The .xpi contains only what Firefox needs:
#   - manifest.json, icons, scripts/main.js, engine/loader.js
#   - the single-threaded Stockfish 18 NNUE build (works everywhere), with
#     the ~108 MB .wasm split into two parts to stay under AMO's per-file
#     size limit; engine/loader.js reassembles them in memory at runtime.
#
# Result: ./chessable-firefox.xpi  (~74 MB, under AMO's 200 MB total limit)
#
# Run `npm install` first so engine/ exists.
set -e
cd "$(dirname "$0")/.."

OUT="chessable-firefox.xpi"

for f in manifest.json icon-16.png icon-48.png icon-128.png scripts/main.js \
         engine/loader.js engine/stockfish-18-single.js \
         engine/stockfish-18-single.wasm.part-01 \
         engine/stockfish-18-single.wasm.part-02; do
  if [ ! -f "$f" ]; then
    echo "Missing $f — run 'npm install' (or 'npm run setup') first." >&2
    exit 1
  fi
done

rm -f "$OUT"
zip -q -X "$OUT" manifest.json icon-16.png icon-48.png icon-128.png \
  scripts/main.js engine/loader.js engine/stockfish-18-single.js \
  engine/stockfish-18-single.wasm.part-01 \
  engine/stockfish-18-single.wasm.part-02

echo "Created $OUT ($(du -h "$OUT" | cut -f1))"
