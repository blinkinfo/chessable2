// Chessable engine loader (worker bootstrap).
//
// AMO limits the size of any single file inside an .xpi, so the ~108 MB
// Stockfish WASM ships split into parts. The content script fetches all
// parts, reassembles them into one ArrayBuffer, and posts it here. We hand
// it to the Emscripten engine glue via Module.wasmBinary so the glue never
// needs to fetch an oversized .wasm file itself.
//
// After importScripts() the glue installs its own message handler; from then
// on this worker behaves exactly like the stock stockfish-18-single.js
// worker (UCI in via postMessage, engine output out via postMessage).
"use strict";

self.onmessage = function (e) {
  var data = e.data || {};
  if (!data.wasmBinary) return;

  self.Module = { wasmBinary: data.wasmBinary };

  // Detach our bootstrap handler so the engine glue installs its own.
  self.onmessage = null;

  // Synchronous import; the glue initialises with the provided wasmBinary.
  importScripts("./stockfish-18-single.js");
};
