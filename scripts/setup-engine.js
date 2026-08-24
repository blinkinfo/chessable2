// Copies the Stockfish 18 WASM engine binaries from node_modules into
// engine/ so the extension can load them. The engine/ folder is git-ignored
// — run `npm install` (which triggers this via postinstall) or
// `npm run setup` after cloning.
//
// We ship the LITE single-threaded build: Stockfish 18 with the small NNUE
// net (~7.3 MB wasm). It compiles in a couple of seconds even on phones,
// fits AMO's per-file size limit whole (no splitting needed), and is far
// stronger than the old Stockfish 10 asm.js the extension used originally.
//
// THREE PATCHES are applied to the copied glue — each fixes a real,
// verified Firefox failure mode:
//
// 1. Worker-mode check. The glue requires
//    `self.location.hash.split(",")[1] === "worker"`, but Firefox strips
//    URL fragments from Worker script URLs, so the check never passed and
//    the engine silently never booted. Widened to the standard emscripten
//    worker detection (`typeof importScripts`).
//
// 2. Explicit wasm URL. The glue defaults the wasm location to a sibling of
//    the *worker script*. We spawn an instrumented bootstrap worker
//    (engine/boot.js), so that default would point at boot.wasm — a 404 and
//    another silent death. The glue now honours `self.__wasmUrl`, which
//    boot.js sets to the real engine wasm URL before importScripts.
//
// 3. MIME-independent WASM compile. The glue's custom instantiateWasm feeds
//    its downloaded Response straight into WebAssembly.instantiateStreaming,
//    which Firefox hard-fails unless Content-Type is exactly
//    "application/wasm" — with no fallback (unlike emscripten's built-in
//    path). If moz-extension:// ever serves .wasm with a different MIME the
//    engine dies silently. We compile from the ArrayBuffer instead, which
//    ignores Content-Type entirely.
"use strict";

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "node_modules", "stockfish", "bin");
const DEST = path.join(__dirname, "..", "engine");

const GLUE = "stockfish-18-lite-single.js";
const WASM = "stockfish-18-lite-single.wasm";
const BOOT_SRC = path.join(__dirname, "engine-boot.js");
const BOOT = "boot.js";

const PATCHES = [
  {
    name: "worker-mode check (Firefox strips worker URL fragments)",
    old: `"worker"===self.location.hash.split(",")[1]`,
    new: `"function"==typeof importScripts`,
  },
  {
    name: "explicit wasm URL via self.__wasmUrl (set by engine/boot.js)",
    old: `u=decodeURIComponent(e[0]||location.origin+location.pathname.replace(/\\.js$/i,".wasm"))`,
    new: `u=decodeURIComponent(e[0]||self.__wasmUrl||location.origin+location.pathname.replace(/\\.js$/i,".wasm"))`,
  },
  {
    name: "MIME-independent WASM compile (no instantiateStreaming)",
    old: `a(u,e).then(function(e){return WebAssembly.instantiateStreaming(e,n)})`,
    new: `a(u,e).then(function(e){return e.arrayBuffer().then(function(e){return WebAssembly.instantiate(e,n)})})`,
  },
];

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(
      "[chessable] stockfish package not found in node_modules. Run `npm install` first."
    );
    process.exit(1);
  }

  fs.mkdirSync(DEST, { recursive: true });

  // Remove artifacts from older packaging schemes so stale files can never
  // be picked up or shipped by accident.
  const keep = new Set([GLUE, WASM, BOOT]);
  for (const f of fs.readdirSync(DEST)) {
    if (!keep.has(f)) {
      fs.rmSync(path.join(DEST, f), { force: true });
      console.log(`[chessable] removed stale engine/${f}`);
    }
  }

  // 1. Glue, with all Firefox-safety patches applied. Refuse to ship if the
  // upstream package changed and any patch no longer matches.
  let glue = fs.readFileSync(path.join(SRC, GLUE), "utf8");
  for (const p of PATCHES) {
    if (!glue.includes(p.old)) {
      console.error(
        `[chessable] FATAL: pattern for "${p.name}" not found in the engine ` +
          "glue — the stockfish package may have changed. Refusing to ship a broken engine."
      );
      process.exit(1);
    }
    glue = glue.replace(p.old, p.new);
  }
  fs.writeFileSync(path.join(DEST, GLUE), glue);
  console.log(`[chessable] wrote engine/${GLUE} (${PATCHES.length} Firefox patches applied)`);

  // 2. The wasm binary, whole (7.3 MB — no splitting required).
  fs.copyFileSync(path.join(SRC, WASM), path.join(DEST, WASM));
  const mb = (fs.statSync(path.join(DEST, WASM)).size / 1048576).toFixed(1);
  console.log(`[chessable] wrote engine/${WASM} (${mb} MB)`);

  // 3. The instrumented boot worker (source lives in scripts/, committed).
  fs.copyFileSync(BOOT_SRC, path.join(DEST, BOOT));
  console.log(`[chessable] wrote engine/${BOOT} (instrumented bootstrap)`);

  console.log("[chessable] engine ready (hosted by scripts/engine-bg.js)");
}

main();
