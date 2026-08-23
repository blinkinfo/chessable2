// Chessable engine host (extension page script).
//
// Runs inside the hidden engine/host.html iframe on chess.com.
//
// How the engine actually boots (this mirrors stockfish.js's own design):
//   1. fetch the split wasm parts same-origin and reassemble them,
//   2. expose the binary as a blob URL,
//   3. start the glue AS the worker, passing the wasm URL in the fragment:
//        new Worker("./stockfish-18-single.js#<blobUrl>,worker")
//      The glue reads self.location.hash, decodes the wasm URL, fetches it
//      (blobs serve as application/wasm so streaming compile works) and
//      installs its UCI message handler. No Module tricks needed.
//
// Traffic is bridged to the content script via window.postMessage under a
// namespaced token so chess.com page scripts can never confuse it.
"use strict";

var CC_TOKEN = "__chessableEngine";

function ccSend(payload) {
  parent.postMessage({ [CC_TOKEN]: true, payload: payload }, "*");
}

async function loadWasmBlobUrl() {
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
  var joined = new Uint8Array(total);
  var off = 0;
  for (var j = 0; j < buffers.length; j++) {
    joined.set(new Uint8Array(buffers[j]), off);
    off += buffers[j].byteLength;
  }
  return URL.createObjectURL(
    new Blob([joined.buffer], { type: "application/wasm" })
  );
}

(async function () {
  try {
    var wasmUrl = await loadWasmBlobUrl();

    // The glue boots itself as a worker and pulls the wasm from the
    // fragment. This is stockfish.js's documented custom-wasm-path mode.
    var worker = new Worker(
      "./stockfish-18-single.js#" + encodeURIComponent(wasmUrl) + ",worker"
    );

    worker.onmessage = function (e) {
      ccSend(String(e.data));
    };
    worker.onerror = function () {
      ccSend("__engine-error: engine worker crashed");
    };

    window.addEventListener("message", function (e) {
      var d = e.data;
      if (d && d[CC_TOKEN]) worker.postMessage(d.payload);
    });

    ccSend("__host-ready");
  } catch (err) {
    ccSend("__engine-error: " + (err && err.message ? err.message : String(err)));
  }
})();
