// Copies the Stockfish 18 WASM engine binaries from node_modules into
// engine/ so the extension can load them. The engine/ folder is git-ignored
// — run `npm install` (which triggers this via postinstall) or
// `npm run setup` after cloning.
//
// The single-threaded NNUE .wasm (~108 MB) exceeds AMO's per-file size
// limit inside an .xpi, so it is SPLIT into 56 MB parts here. At runtime
// engine/loader.js reassembles them in memory (see scripts/main.js).
"use strict";

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "node_modules", "stockfish", "bin");
const DEST = path.join(__dirname, "..", "engine");

const GLUE = "stockfish-18-single.js";
const WASM = "stockfish-18-single.wasm";
const PART_BYTES = 56 * 1024 * 1024; // stay well under AMO's per-file cap

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(
      "[chessable] stockfish package not found in node_modules. Run `npm install` first."
    );
    process.exit(1);
  }

  fs.mkdirSync(DEST, { recursive: true });

  fs.copyFileSync(path.join(SRC, GLUE), path.join(DEST, GLUE));
  console.log(`[chessable] copied ${GLUE} -> engine/`);

  // Hidden extension page that hosts the engine worker (Firefox blocks
  // content scripts from creating workers on moz-extension:// URLs). It
  // reassembles the split wasm and boots the glue with its blob URL.
  fs.copyFileSync(
    path.join(__dirname, "engine-host.html"),
    path.join(DEST, "host.html")
  );
  fs.copyFileSync(
    path.join(__dirname, "engine-host.js"),
    path.join(DEST, "host.js")
  );
  console.log("[chessable] wrote host.html + host.js -> engine/");

  const buf = fs.readFileSync(path.join(SRC, WASM));
  const parts = Math.ceil(buf.length / PART_BYTES);
  for (let i = 0; i < parts; i++) {
    const name = `stockfish-18-single.wasm.part-${String(i + 1).padStart(2, "0")}`;
    fs.writeFileSync(
      path.join(DEST, name),
      buf.subarray(i * PART_BYTES, Math.min((i + 1) * PART_BYTES, buf.length))
    );
    console.log(`[chessable] wrote ${name} (${PART_BYTES / 1048576} MB max)`);
  }

  console.log(
    `[chessable] engine ready: ${parts} parts, ${buf.length} bytes total.`
  );
}

main();
