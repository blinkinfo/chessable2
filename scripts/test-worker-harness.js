// Verification harness — run with `npm test` (never shipped in the xpi).
// Runs the REAL boot.js + patched glue inside a Node worker_threads thread
// with a browser-worker shim (self/importScripts/postMessage/onmessage),
// proving the exact code path the extension uses:
// boot.js -> wasm module -> glue worker branch -> UCI handshake -> bestmove.
//
// The shim must hide Node's `global` and `process` and define `onmessage`
// as null — a real browser worker has exactly that shape, and the glue's
// env detection takes completely different branches otherwise.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { Worker, isMainThread, parentPort } = require("worker_threads");

const ROOT = path.join(__dirname, "..");

if (isMainThread) {
  const lines = [];
  const w = new Worker(__filename);

  const done = (ok, why) => {
    console.log(ok ? "PASS" : "FAIL", why || "");
    if (!ok) console.log("messages received:\n" + lines.join("\n").slice(-3000));
    w.terminate();
    process.exit(ok ? 0 : 1);
  };

  w.on("message", (m) => {
    const s = typeof m === "string" ? m : m && m.__boot;
    console.log("[msg]", String(s));
    lines.push(String(s));
    if (!s) return;
    if (s.startsWith("bestmove")) done(true, "bestmove: " + s);
  });
  w.on("error", (e) => done(false, "worker error: " + e.message));
  w.on("exit", (c) => console.log("[worker exited code", c + "]"));

  setTimeout(() => { w.postMessage("uci"); console.error("[main] sent uci EARLY (before glue load)"); }, 300);
  setTimeout(() => w.postMessage("isready"), 500);
  setTimeout(() => w.postMessage("position startpos moves e2e4 e7e5"), 700);
  setTimeout(() => w.postMessage("go depth 12"), 900);
  setTimeout(() => done(false, "TIMEOUT waiting for bestmove"), 45000);
} else {
  // ---- browser-worker shim inside the thread ----
  globalThis.self = globalThis;
  // Hide Node's `global` — a real browser worker has no `global`, and the
  // glue's Node-worker detection (`typeof global=="object" && ... &&
  // !require("worker_threads").isMainThread`) would otherwise hit a bare
  // `require` that doesn't exist outside a CJS module scope.
  globalThis.global = undefined;
  // Hide Node's `process` too — a real browser worker has none, and with it
  // visible the glue's env detection takes the NODE branch (W=true) and hits
  // a bare require("path") that doesn't exist outside a CJS module scope.
  const __process = process;
  globalThis.process = undefined;
  // A real dedicated worker has `onmessage` as an IDL attribute with value
  // null — the glue's worker-branch gate is `"undefined"!=typeof onmessage`.
  globalThis.onmessage = null;
  // Message listeners registered via addEventListener — a real worker
  // dispatches every incoming message to BOTH these listeners and the
  // `onmessage` property (when set). boot.js relies on this to queue
  // commands that arrive before the glue installs its dispatcher.
  const __msgListeners = [];
  globalThis.addEventListener = (type, fn) => {
    if (type === "message") {
      __msgListeners.push(fn);
      return;
    }
    // Forward worker error traps to the parent so nothing is swallowed.
    if (type === "unhandledrejection")
      __process.on("unhandledRejection", (r) => parentPort.postMessage("UNHANDLED REJECTION: " + (r && r.stack || r)));
    if (type === "error")
      __process.on("uncaughtException", (e) => parentPort.postMessage("UNCAUGHT: " + (e && e.stack || e)));
  };
  globalThis.postMessage = (m) => parentPort.postMessage(m); // browser-worker global
  globalThis.location = {
    hash: "",
    origin: "file://",
    href: "file://" + path.join(ROOT, "engine", "boot.js"),
    pathname: path.join(ROOT, "engine", "boot.js"),
  };
  globalThis.importScripts = function (...urls) {
    for (const u of urls) {
      const f = decodeURIComponent(u.replace(/^file:\/\//, ""));
      try {
        vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
      } catch (e) {
        parentPort.postMessage("IMPORTSCRIPTS STACK: " + (String((e && e.stack) || e).split("\n").slice(0, 4).join(" | ")));
        throw e;
      }
    }
  };
  // Node fetch can't do file:// — shim it to read the wasm from disk.
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => {
      const buf = fs.readFileSync(decodeURIComponent(url.replace(/^file:\/\//, "")));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  });
  // Bridge incoming messages exactly like a real worker: listeners first,
  // then the `onmessage` property (if the glue has installed it).
  parentPort.on("message", (m) => {
    const ev = { data: m };
    for (const fn of __msgListeners) {
      try { fn(ev); } catch (e) { parentPort.postMessage("LISTENER THROW: " + e.stack); }
    }
    if (typeof globalThis.onmessage === "function") globalThis.onmessage(ev);
  });

  try {
    parentPort.postMessage("shim up, requiring boot.js");
    require(path.join(ROOT, "engine", "boot.js"));
  } catch (e) {
    parentPort.postMessage("BOOT.JS THROW: " + e.stack);
  }
}
