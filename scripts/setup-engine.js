// Copies the Stockfish 18 WASM engine binaries from node_modules into
// engine/ so the unpacked extension can load them. The engine/ folder is
// git-ignored — run `npm install` (which triggers this via postinstall)
// or `npm run setup` after cloning.
"use strict";

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "node_modules", "stockfish", "bin");
const DEST = path.join(__dirname, "..", "engine");

const FILES = [
  // Multi-threaded NNUE build (preferred; needs SharedArrayBuffer).
  "stockfish-18.js",
  "stockfish-18.wasm",
  // Single-threaded NNUE fallback (works everywhere).
  "stockfish-18-single.js",
  "stockfish-18-single.wasm",
];

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(
      "[chesscheat] stockfish package not found in node_modules. " +
        "Run `npm install` first."
    );
    process.exit(1);
  }

  fs.mkdirSync(DEST, { recursive: true });

  for (const file of FILES) {
    const from = path.join(SRC, file);
    if (!fs.existsSync(from)) {
      console.error(`[chesscheat] missing engine binary: ${file}`);
      process.exit(1);
    }
    fs.copyFileSync(from, path.join(DEST, file));
    console.log(`[chesscheat] copied ${file} -> engine/`);
  }
  console.log("[chesscheat] engine ready. Load the extension via chrome://extensions.");
}

main();
