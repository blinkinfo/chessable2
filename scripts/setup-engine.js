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
// ONE PATCH is applied to the copied glue: its worker-mode check requires
// `self.location.hash.split(",")[1] === "worker"` (a URL fragment), but
// Firefox strips fragments from Worker script URLs, so the check never
// passed and the engine silently never booted. We widen the check to the
// standard emscripten worker detection (`typeof importScripts`), which is
// fragment-independent and works on every browser.
"use strict";

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "node_modules", "stockfish", "bin");
const DEST = path.join(__dirname, "..", "engine");

const GLUE = "stockfish-18-lite-single.js";
const WASM = "stockfish-18-lite-single.wasm";

const WORKER_CHECK_OLD = `"worker"===self.location.hash.split(",")[1]`;
const WORKER_CHECK_NEW = `"function"==typeof importScripts`;

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
  for (const f of fs.readdirSync(DEST)) {
    if (f !== GLUE && f !== WASM && f !== "host.html" && f !== "host.js") {
      fs.rmSync(path.join(DEST, f), { force: true });
      console.log(`[chessable] removed stale engine/${f}`);
    }
  }

  // 1. Glue, with the Firefox-safe worker check patched in.
  let glue = fs.readFileSync(path.join(SRC, GLUE), "utf8");
  if (!glue.includes(WORKER_CHECK_OLD)) {
    console.error(
      "[chessable] FATAL: worker-mode pattern not found in the engine glue — " +
        "the stockfish package may have changed. Refusing to ship a broken engine."
    );
    process.exit(1);
  }
  glue = glue.replace(WORKER_CHECK_OLD, WORKER_CHECK_NEW);
  fs.writeFileSync(path.join(DEST, GLUE), glue);
  console.log(`[chessable] wrote engine/${GLUE} (worker check patched for Firefox)`);

  // 2. The wasm binary, whole (7.3 MB — no splitting required).
  fs.copyFileSync(path.join(SRC, WASM), path.join(DEST, WASM));
  const mb = (fs.statSync(path.join(DEST, WASM)).size / 1048576).toFixed(1);
  console.log(`[chessable] wrote engine/${WASM} (${mb} MB)`);

  // 3. Hidden extension page that hosts the engine worker (Firefox blocks
  //    content scripts from creating workers on moz-extension:// URLs).
  fs.copyFileSync(
    path.join(__dirname, "engine-host.html"),
    path.join(DEST, "host.html")
  );
  fs.copyFileSync(
    path.join(__dirname, "engine-host.js"),
    path.join(DEST, "host.js")
  );
  console.log("[chessable] wrote host.html + host.js -> engine/");
}

main();
