// Chessable engine host (extension page script).
//
// Runs inside the hidden engine/host.html iframe on chess.com.
//
// Boot is deliberately simple:
//   new Worker("./stockfish-18-lite-single.js")
// The glue detects worker mode via `typeof importScripts` (setup-engine.js
// patches the upstream check, which relied on a URL fragment that Firefox
// strips from Worker URLs) and fetches its sibling .wasm same-origin.
//
// IMPORTANT: we receive engine output via addEventListener, NOT
// `worker.onmessage = ...`. The glue initialises its UCI command dispatcher
// with `onmessage = onmessage || fn` — if we claim the onmessage slot before
// the glue evaluates, it silently skips installing its dispatcher and UCI
// commands never reach the engine. addEventListener leaves the slot free.
//
// Traffic is bridged to the content script via window.postMessage under a
// namespaced token so chess.com page scripts can never confuse it.
"use strict";

var CC_TOKEN = "__chessableEngine";

function ccSend(payload) {
  parent.postMessage({ [CC_TOKEN]: true, payload: payload }, "*");
}

try {
  var worker = new Worker("./stockfish-18-lite-single.js");

  worker.addEventListener("message", function (e) {
    ccSend(String(e.data));
  });
  worker.addEventListener("error", function (e) {
    ccSend(
      "__engine-error: " +
        (e && e.message ? e.message : "engine worker crashed")
    );
  });

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d[CC_TOKEN]) worker.postMessage(d.payload);
  });

  ccSend("__host-ready");
} catch (err) {
  ccSend("__engine-error: " + (err && err.message ? err.message : String(err)));
}
