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
let lastBootInfo = null;      // most recent diagnostic from the boot worker
const BOOT_SILENCE_MS = 60000; // any worker message resets this — only TRUE silence fires it
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

function kickWatchdog() {
  clearBootWatchdog();
  bootWatchdog = setTimeout(() => {
    bootWatchdog = null;
    broadcast(
      `engine silent ${BOOT_SILENCE_MS / 1000}s${lastBootInfo ? ` — last: ${lastBootInfo}` : " — no boot diagnostics"}`
    );
    if (worker) {
      try { worker.terminate(); } catch (_) {}
      worker = null;
    }
  }, BOOT_SILENCE_MS);
}

function ensureWorker(port) {
  if (worker) return true;
  try {
    lastBootInfo = null;
    // Spawn the INSTRUMENTED bootstrap (engine/boot.js), not the glue
    // directly. boot.js reports every boot stage back to us — wasm reach,
    // Content-Type, WASM-compile permission, importScripts result — so a
    // failure is always diagnosable from the pill, never a silent hang.
    worker = new Worker(chrome.runtime.getURL("engine/boot.js"));

    worker.addEventListener("message", (e) => {
      const d = e.data;
      kickWatchdog(); // ANY message (boot stage or engine line) = alive
      // Boot diagnostics from the bootstrap worker.
      if (d && typeof d === "object" && typeof d.__boot === "string") {
        lastBootInfo = d.__boot;
        console.log("[chessable:bg]", d.__boot);
        for (const p of ports) {
          try { p.postMessage({ info: d.__boot }); } catch (_) {}
        }
        return;
      }
      const line = typeof d === "string" ? d : d && d.data;
      if (typeof line !== "string") return;
      // The engine answered the UCI handshake — boot is complete, the
      // silence watchdog has no business watching an idle healthy engine.
      if (line === "uciok") clearBootWatchdog();
      for (const p of ports) {
        try {
          p.postMessage({ line: String(line) });
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

    // Silence watchdog — resets on EVERY message from the worker, so a
    // slow-but-progressing first boot (7 MB fetch + compile on mobile data
    // can legitimately take 20-30 s) is never killed. Only total silence
    // for 60 s — a genuinely wedged boot — fires it, and the last boot
    // stage is included so the pill names exactly where it stopped.
    kickWatchdog();

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
