// Chessable engine host — extension BACKGROUND PAGE.
//
// The engine worker lives here instead of inside an iframe embedded in the
// chess.com page. Extension pages can always create Workers, and runtime
// ports work identically on desktop and Firefox for Android — there is no
// dependence on chess.com's DOM, CSP, or message visibility at all.
//
// IMPORTANT: engine output is received via addEventListener, NOT
// `worker.onmessage = ...`. The glue initialises its UCI command dispatcher
// with `onmessage = onmessage || fn` — claiming that slot would stop UCI
// commands from ever reaching the engine.
"use strict";

let worker = null;

function reportError(port, what) {
  console.error("[chessable:bg]", what);
  try {
    port.postMessage({ error: String(what) });
  } catch (_) {
    /* port already gone */
  }
}

function ensureWorker(port) {
  if (worker) return true;
  try {
    worker = new Worker(chrome.runtime.getURL("engine/stockfish-18-lite-single.js"));

    worker.addEventListener("message", (e) => {
      try {
        port.postMessage({ line: String(e.data) });
      } catch (_) {}
    });
    worker.addEventListener("error", (e) => {
      reportError(port, e && e.message ? e.message : "engine worker crashed");
      worker = null; // allow the next connection to boot a fresh engine
    });

    console.log("[chessable:bg] engine worker started");
    return true;
  } catch (err) {
    reportError(port, err && err.message ? err.message : String(err));
    return false;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chessable-engine") return;

  if (ensureWorker(port)) {
    // Worker process exists; the content script starts the UCI handshake.
    port.postMessage({ ready: true });
  }

  port.onMessage.addListener((msg) => {
    if (!worker) return;
    if (typeof msg !== "string") return;
    if (msg === "__ping") return; // keepalive only — keeps this page alive
    worker.postMessage(msg);
  });

  port.onDisconnect.addListener(() => {
    if (worker) {
      try {
        worker.postMessage("stop");
      } catch (_) {}
    }
  });
});
