// Chessable engine host — extension BACKGROUND PAGE.
//
// The engine worker lives here instead of inside an iframe embedded in the
// chess.com page. Extension pages can always create Workers, and runtime
// ports work identically on desktop and Firefox for Android — there is no
// dependence on chess.com's DOM, CSP, or message visibility at all.
//
// IMPORTANT (learned the hard way):
//  1. Engine output is received via addEventListener, NOT
//     `worker.onmessage = ...`. The glue initialises its UCI dispatcher with
//     `onmessage = onmessage || fn` — claiming that slot would stop UCI
//     commands from ever reaching the engine.
//  2. Firefox MV3 blocks WebAssembly unless the manifest CSP includes
//     'wasm-unsafe-eval'. That block manifests as a silent unhandled
//     promise rejection INSIDE the worker — no error event ever reaches us.
//     The manifest now declares it, and the boot watchdog below turns any
//     remaining silence into a fast, reported failure instead of a hang.
"use strict";

let worker = null;
let bootWatchdog = null;
const ports = new Set();

function broadcast(what) {
  console.error("[chessable:bg]", what);
  for (const port of ports) {
    try {
      port.postMessage({ error: String(what) });
    } catch (_) {}
  }
}

function notePort(port) {
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
}

function clearBootWatchdog() {
  if (bootWatchdog) {
    clearTimeout(bootWatchdog);
    bootWatchdog = null;
  }
}

function ensureWorker(port) {
  if (worker) return true;
  try {
    worker = new Worker(chrome.runtime.getURL("engine/stockfish-18-lite-single.js"));

    // First line from the engine proves WASM compiled and UCI is alive.
    const firstLine = () => {
      worker.removeEventListener("message", firstLine);
      clearBootWatchdog();
    };
    worker.addEventListener("message", firstLine);

    worker.addEventListener("message", (e) => {
      for (const p of ports) {
        try {
          p.postMessage({ line: String(e.data) });
        } catch (_) {}
      }
    });
    worker.addEventListener("error", (e) => {
      broadcast(e && e.message ? e.message : "engine worker crashed");
      clearBootWatchdog();
      worker = null; // allow the next connection to boot a fresh engine
    });
    worker.addEventListener("messageerror", () =>
      broadcast("engine produced an undecodable message")
    );

    // Silence watchdog: a healthy lite engine answers "uci" in well under
    // 10 s even on a phone. If it stays quiet, say so FAST (this is what
    // used to look like "30 s then red" with zero explanation).
    bootWatchdog = setTimeout(() => {
      bootWatchdog = null;
      broadcast(
        "engine silent for 15s — check extension CSP allows WebAssembly ('wasm-unsafe-eval')"
      );
      if (worker) {
        try { worker.terminate(); } catch (_) {}
        worker = null;
      }
    }, 15000);

    console.log("[chessable:bg] engine worker started");
    return true;
  } catch (err) {
    broadcast(err && err.message ? err.message : String(err));
    return false;
  }
}

// Surface any error that escapes the page itself (e.g. resource load
// failures) instead of letting it die silently in the console.
self.addEventListener("error", (e) => broadcast(e.message || "background error"));
self.addEventListener("unhandledrejection", (e) =>
  broadcast(`background: ${e.reason}`)
);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chessable-engine") return;

  notePort(port);

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
    if (ports.size === 0 && worker) {
      try {
        worker.postMessage("stop");
      } catch (_) {}
    }
  });
});
