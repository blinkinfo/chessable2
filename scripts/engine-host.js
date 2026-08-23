// Chessable engine host (extension page script).
//
// Runs inside the hidden engine/host.html iframe on chess.com.
//
// Boot is deliberately simple:
//   new Worker("./stockfish-18-lite-single.js")
// The glue detects worker mode via `typeof importScripts` (setup-engine.js
// patches the upstream check, which relied on a URL fragment that Firefox
// strips from Worker URLs) and fetches its sibling .wasm same-origin.
// The 7.3 MB lite binary compiles in a second or two, even on phones.
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

  worker.onmessage = function (e) {
    ccSend(String(e.data));
  };
  worker.onerror = function (e) {
    ccSend("__engine-error: " + (e && e.message ? e.message : "engine worker crashed"));
  };
  worker.onmessageerror = function () {
    ccSend("__engine-error: worker message could not be decoded");
  };

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d[CC_TOKEN]) worker.postMessage(d.payload);
  });

  ccSend("__host-ready");
} catch (err) {
  ccSend("__engine-error: " + (err && err.message ? err.message : String(err)));
}
