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
// TWO patches are applied to the copied glue — each fixes a real,
// verified failure mode:
//
// 1. Explicit wasm URL. The glue defaults the wasm location to a sibling of
//    the *worker script*. We spawn an instrumented bootstrap worker
//    (engine/boot.js), so that default would point at boot.wasm — a 404 and
//    a silent death. The glue now honours `self.__wasmUrl`, which boot.js
//    sets to the real engine wasm URL before importScripts.
//
// 2. Pre-compiled module fast path. boot.js compiles the wasm ONCE (with an
//    IndexedDB cache of the bytes AND the compiled WebAssembly.Module) and
//    hands it to the glue via self.__wasmModule. The glue then instantiates
//    from the ready-made module — no per-boot network fetch, no streaming-
//    compile MIME pitfalls (Firefox demands exactly "application/wasm" for
//    instantiateStreaming), and re-boots are near-instant.
//
// NOTE: the glue's own worker-branch detection is CORRECT for our use (a
// plain worker with no URL fragment boots via its `typeof onmessage` path).
// An earlier patch here replaced its hash check with a `typeof
// importScripts` check — that SHORT-CIRCUITED the whole condition chain and
// silently turned the glue into a no-op inside every worker. Do not reintroduce it.
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
    name: "explicit wasm URL via self.__wasmUrl (set by engine/boot.js)",
    old: `u=decodeURIComponent(e[0]||location.origin+location.pathname.replace(/\\.js$/i,".wasm"))`,
    new: `u=self.__wasmUrl||decodeURIComponent(e[0]||location.origin+location.pathname.replace(/\\.js$/i,".wasm"))`,
  },
  {
    name: "pre-compiled module fast path via self.__wasmModule",
    old: `instantiateWasm:function(n,t){var e=i();`,
    new: `instantiateWasm:function(n,t){if(self.__wasmModule)return WebAssembly.instantiate(self.__wasmModule,n).then(function(e){return t(e,self.__wasmModule),e.exports});var e=i();`,
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
