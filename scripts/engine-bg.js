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

// Cloud analysis via chess-api.com — free, keyless, live multi-threaded
// Stockfish on server hardware (depth ~13-15 on any position, ~500 ms).
// Scores are SIDE-TO-MOVE relative. Fetched here in the background page,
// which has the host permission (content-script fetches would face page
// CORS). The content script falls back to the local WASM engine
// automatically on any failure or timeout.
const CLOUD_URL = "https://chess-api.com/v1";

async function bestCloudEval(fen, depth) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const resp = await fetch(CLOUD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen, depth: Number(depth) || 18 }),
      signal: ctl.signal,
    });
    if (!resp.ok) throw new Error(`cloud HTTP ${resp.status}`);
    const d = await resp.json();
    if (d && d.type === "error") throw new Error(d.error || "cloud error");
    if (!d || typeof d.move !== "string") throw new Error("no move in cloud response");
    return {
      source: "cloud",                // cp/mate are SIDE-TO-MOVE relative
      move: d.move,
      centipawns: d.centipawns,
      mate: d.mate,
      depth: d.depth,
      fen,
    };
  } finally {
    clearTimeout(t);
  }
}

let worker = null;
let bootWatchdog = null;
let bootComplete = false;    // true once the engine answered the UCI handshake
let lastBootInfo = null;      // most recent diagnostic from the boot worker
const BOOT_SILENCE_MS = 30000; // any worker message resets this — only TRUE silence fires it
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
    bootComplete = false;
    // Spawn the INSTRUMENTED bootstrap (engine/boot.js), not the glue
    // directly. boot.js reports every boot stage back to us — wasm reach,
    // Content-Type, WASM-compile permission, importScripts result — so a
    // failure is always diagnosable from the pill, never a silent hang.
    worker = new Worker(chrome.runtime.getURL("engine/boot.js"));

    worker.addEventListener("message", (e) => {
      const d = e.data;
      // Feed the boot watchdog ONLY while booting. Re-arming it on every
      // message forever used to KILL HEALTHY IDLE ENGINES mid-game: an
      // engine waiting for the opponent's move is legitimately silent for
      // minutes, the watchdog fired, terminated the worker, and the pill
      // died until a page refresh. Boot silence is the only thing this
      // watchdog exists for.
      if (!bootComplete) kickWatchdog();
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
      // The engine answered the UCI handshake — boot is complete. Disarm
      // the silence watchdog permanently for this worker.
      if (line === "uciok") {
        bootComplete = true;
        clearBootWatchdog();
      }
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

    // Boot silence watchdog — resets on every message WHILE booting, so a
    // slow first boot (7 MB fetch + compile on mobile data) is never
    // killed. Disarmed for good once the engine answers "uciok".

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
    // Cloud analysis request — answered from the background page (it has
    // the host permission; content-script fetches would face page CORS).
    if (msg && typeof msg === "object" && typeof msg.__cloud === "string") {
      bestCloudEval(msg.__cloud, msg.depth)
        .then((r) => {
          try { port.postMessage({ cloud: r }); } catch (_) {}
        })
        .catch((err) => {
          try {
            port.postMessage({ cloudError: String((err && err.message) || err).slice(0, 80) });
          } catch (_) {}
        });
      return;
    }
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
        // Terminate and drop the worker, don't just pause it: the content
        // script's watchdog restarts by RECONNECTING, and ensureWorker()
        // would otherwise hand the fresh connection the same possibly-wedged
        // worker — leaving the pill idle forever (the "refresh to fix" bug).
        try {
          worker.terminate();
        } catch (_) {}
        worker = null;
      }
    });
});
