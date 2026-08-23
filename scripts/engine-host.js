// Chessable engine host (extension page script).
//
// Runs inside the hidden engine/host.html iframe on chess.com. Responsibilities:
//   1. fetch the split wasm parts from the extension's own origin and
//      reassemble them into one ArrayBuffer,
//   2. start the loader worker (engine/loader.js) and hand it the binary,
//   3. bridge messages both ways between the worker and the content script
//      via window.postMessage, namespaced with a token so chess.com page
//      scripts can never confuse our traffic with their own.
"use strict";

var CC_TOKEN = "__chessableEngine";

function ccSend(payload) {
  parent.postMessage({ [CC_TOKEN]: true, payload: payload }, "*");
}

async function loadWasmBinary() {
  var parts = [
    "./stockfish-18-single.wasm.part-01",
    "./stockfish-18-single.wasm.part-02",
  ];
  var buffers = [];
  var total = 0;
  for (var i = 0; i < parts.length; i++) {
    var res = await fetch(parts[i]);
    if (!res.ok) throw new Error("could not fetch " + parts[i]);
    var buf = await res.arrayBuffer();
    buffers.push(buf);
    total += buf.byteLength;
  }
  var out = new Uint8Array(total);
  var off = 0;
  for (var j = 0; j < buffers.length; j++) {
    out.set(new Uint8Array(buffers[j]), off);
    off += buffers[j].byteLength;
  }
  return out.buffer;
}

(async function () {
  try {
    var bin = await loadWasmBinary();
    var worker = new Worker("./loader.js");

    worker.onmessage = function (e) {
      ccSend(String(e.data));
    };
    worker.onerror = function (e) {
      ccSend("__engine-error: " + (e.message || "worker crashed"));
    };

    // Commands arriving from the content script are forwarded verbatim.
    window.addEventListener("message", function (e) {
      var d = e.data;
      if (d && d[CC_TOKEN]) worker.postMessage(d.payload);
    });

    // Hand over the binary first; UCI commands queued by the content script
    // afterwards are buffered by the event loop until the glue is live.
    worker.postMessage({ wasmBinary: bin }, [bin]);

    ccSend("__host-ready");
  } catch (err) {
    ccSend("__engine-error: " + (err && err.message ? err.message : String(err)));
  }
})();
