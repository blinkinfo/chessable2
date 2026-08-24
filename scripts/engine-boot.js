// Instrumented Worker bootstrap for the Chessable engine.
//
// The background page spawns THIS script as the worker (not the engine glue
// directly) so every stage of the boot is observable AND fast:
//
//   1. The wasm is fetched ONCE and cached in IndexedDB — both the raw bytes
//      AND the compiled WebAssembly.Module (Firefox supports structured-
//      cloning compiled modules into IDB). Every later boot skips the
//      network entirely and skips compilation too — near-instant start.
//   2. The finished module is handed to the patched glue via
//      self.__wasmModule (see setup-engine.js patch 4), so the glue never
//      fetches anything itself.
//   3. Every stage is reported back as {__boot: "..."} so a failure is
//      always NAMED in the pill — never a silent hang.
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

const WASM_URL = new URL("stockfish-18-lite-single.wasm", self.location.href).href;
const GLUE_URL = new URL("stockfish-18-lite-single.js", self.location.href).href;
const DB_NAME = "chessable-engine";
const STORE = "wasm";

report("boot: worker up", self.location.href);

/* ------------------------------------------------------------------ */
/* Early-command queue                                                 */
/*                                                                     */
/* The content script sends "uci" the moment the worker exists — but    */
/* any message delivered to a worker BEFORE its script arms `onmessage` */
/* is silently discarded by the browser. With a warm cache the glue     */
/* loads a second or two after that first "uci", so it used to be       */
/* dropped and the engine sat silent forever. We buffer early messages  */
/* via addEventListener — which deliberately does NOT occupy the        */
/* `onmessage` slot (the glue installs its dispatcher with              */
/* `onmessage = onmessage || fn`) — and replay them once it exists.     */
/* ------------------------------------------------------------------ */

const __early = [];
self.addEventListener("message", (e) => {
  if (typeof self.onmessage !== "function") __early.push(e && e.data);
});

function flushEarly() {
  if (typeof self.onmessage !== "function") return false;
  while (__early.length) {
    try {
      self.onmessage({ data: __early.shift() });
    } catch (err) {
      report("dispatch error", err && err.message);
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Tiny IndexedDB helpers (promise-wrapped, fail-soft)                 */
/* ------------------------------------------------------------------ */

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ------------------------------------------------------------------ */
/* Wasm acquisition: cache -> bytes -> compiled module                 */
/* ------------------------------------------------------------------ */

async function getWasmModule() {
  // 1. Compiled-module cache — the golden path (no network, no compile).
  try {
    const hit = await idbGet("module");
    if (hit instanceof WebAssembly.Module) {
      report("boot: wasm module cache HIT — instant start");
      return hit;
    }
  } catch (_) {/* cache unavailable — fall through */}

  // 2. Raw-bytes cache (module cache miss, e.g. after a Firefox update).
  let bytes = null;
  try {
    bytes = await idbGet("bytes");
    if (bytes) report("boot: wasm bytes from cache");
  } catch (_) {}

  // 3. Network — first boot only.
  if (!bytes) {
    const t0 = Date.now();
    const resp = await fetch(WASM_URL);
    if (!resp.ok) throw new Error(`wasm fetch HTTP ${resp.status}`);
    bytes = await resp.arrayBuffer();
    report("boot: wasm fetched", `${(bytes.byteLength / 1048576).toFixed(1)} MB in ${Date.now() - t0}ms`);
    try { await idbPut("bytes", bytes); } catch (_) {}
  }

  // 4. Compile once, cache the compiled module forever.
  const t1 = Date.now();
  const mod = await WebAssembly.compile(bytes);
  report("boot: wasm compiled", `${Date.now() - t1}ms`);
  try { await idbPut("module", mod); } catch (_) {}
  return mod;
}

/* ------------------------------------------------------------------ */
/* Boot sequence                                                       */
/* ------------------------------------------------------------------ */

(async () => {
  // Permission probe — Firefox MV3 blocks WebAssembly unless the extension
  // CSP includes 'wasm-unsafe-eval'. Silent for the glue; loud for us.
  try {
    await WebAssembly.instantiate(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    report("boot: WebAssembly permission OK");
  } catch (err) {
    report("boot: WebAssembly BLOCKED", err && err.message);
    throw err;
  }

  const mod = await getWasmModule();
  self.__wasmModule = mod; // patched glue instantiates from this — no fetch

  report("boot: loading engine glue");
  try {
    importScripts(GLUE_URL);
  } catch (err) {
    report("boot: glue FAILED to load", err && err.message);
    throw err;
  }
  report("boot: glue loaded — waiting for engine init");

  // Replay anything that arrived during boot. The glue normally installs
  // its dispatcher synchronously at importScripts time; retry briefly in
  // case a future glue defers it.
  const t0 = Date.now();
  (function tryFlush() {
    if (flushEarly()) return;
    if (Date.now() - t0 < 10000) setTimeout(tryFlush, 50);
    else report("boot: glue installed no command dispatcher");
  })();
})().catch((err) => {
  report("boot FAILED", err && err.message ? err.message : String(err));
});
