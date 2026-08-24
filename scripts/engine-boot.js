// Instrumented Worker bootstrap for the Chessable engine.
//
// The background page spawns THIS script as the worker (not the engine glue
// directly) so that every stage of the engine boot is observable. Any
// failure is reported back with the exact stage that failed — no more
// silent hangs. Stages travel to the background page as {__boot: "..."}
// messages and are surfaced in the pill.
//
// The engine glue is imported AFTER self.__wasmUrl is set: the patched glue
// uses that global as the wasm location (its own default would point at a
// sibling of boot.js — wrong).
"use strict";

function report(stage, detail) {
  const text = detail ? `${stage}: ${detail}` : stage;
  try {
    self.postMessage({ __boot: String(text).slice(0, 300) });
  } catch (_) {/* parent gone — nothing to do */}
}

// Surface EVERY asynchronous failure inside this worker. These are exactly
// the failures that used to be invisible (silent hang -> watchdog).
self.addEventListener("error", (e) => {
  report(
    "worker error",
    `${e.message || "unknown"}${e.filename ? ` @ ${e.filename}:${e.lineno || "?"}` : ""}`
  );
});
self.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  report("unhandled rejection", r && r.message ? r.message : String(r));
});

// The engine glue reads this as the wasm location (see setup-engine.js
// patch 2). Computed from THIS script's URL, so it is always the engine
// wasm sitting next to it in engine/.
const WASM_URL = new URL("stockfish-18-lite-single.wasm", self.location.href).href;
self.__wasmUrl = WASM_URL;
report("worker started", self.location.href);

// Stage check 1 — is WebAssembly compilation allowed at all? (Firefox MV3
// blocks it unless the extension CSP includes 'wasm-unsafe-eval'; a block
// here is silent for the glue, but not for us.)
WebAssembly.instantiate(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])).then(
  () => report("WebAssembly compile OK"),
  (err) => report("WebAssembly BLOCKED", err && err.message)
);

// Stage check 2 — is the wasm file reachable, and with which Content-Type?
// Firefox's instantiateStreaming demands exactly "application/wasm"; we
// compile from ArrayBuffer so the type no longer matters, but logging it
// makes any serving problem visible.
fetch(WASM_URL, { method: "HEAD" }).then(
  (r) =>
    report(
      "engine wasm reachable",
      `HTTP ${r.status} type=${r.headers.get("content-type") || "?"}`
    ),
  (err) => report("engine wasm unreachable", err && err.message)
);

// Stage 3 — boot the engine glue itself (worker-mode branch).
try {
  importScripts("stockfish-18-lite-single.js");
  report("engine glue loaded");
} catch (err) {
  report("engine glue FAILED to load", err && err.message);
  throw err;
}
