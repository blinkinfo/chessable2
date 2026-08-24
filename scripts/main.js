// Chessable 2.1 — subtle Stockfish 18 (NNUE, WebAssembly) analysis for chess.com.
// One quiet pill above the board: click to toggle, best move appears on the
// board itself (~1 s budget per move). Event-driven board watching,
// complete FEN reconstruction.
//
// Engine binaries are NOT committed to the repo. Run `npm install`
// (or `bun install`) so scripts/setup-engine.js copies them into engine/.
(() => {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */

  const FILES = "abcdefgh";
  const MULTI_PV = 1;          // single principal variation (fastest)
  const HASH_MB = 64;          // transposition table (phone-friendly)
  const MOVETIME_MS = 900;     // per-move thinking budget — keeps hints near-instant
  const CLOUD_TIMEOUT_MS = 4000;   // cloud answer deadline before falling back to local
  const SEARCH_WATCHDOG_MS = 15000; // no answer at all -> engine host is wedged, restart it
  const ENGINE_READY_TIMEOUT_MS = 90000;   // max SILENCE during boot; any progress resets it
  const SYNC_DEBOUNCE_MS = 150;
  const RENDER_THROTTLE_MS = 100;

  const PIECE_LETTERS = { p: "", n: "N", b: "B", r: "R", q: "Q", k: "K" };

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  const S = {
    running: false,
    depth: 18,
    playerColour: "w",
    sideToMove: "w",
    pieces: new Map(),                    // "e4" -> "wP" style codes
    castling: { K: false, Q: false, k: false, q: false },
    ep: "-",
    halfmove: 0,
    fullmove: 1,
    fen: null,
    results: [],                          // MultiPV lines, index 0 = best
    bestMove: null,
    searching: false,
    reachedDepth: 0,
    cloudUsed: false,
    lastAnalyzedFen: null,                // last position a search was issued for
    noMoveFen: null,                      // last position where the game ended
  };

  let boardEl = null;
  let observer = null;
  let syncTimer = null;
  let renderTimer = null;
  let uiTimer = null;
  let engineLaunch = null;              // in-flight launch promise
  let cloudReqId = 0;                   // invalidates stale cloud answers
  let cloudFallbackTimer = null;
  let searchWatchdog = null;

  const engineCtl = { port: null, ready: false };   // port = background-page channel

  /* ------------------------------------------------------------------ */
  /* Board reading                                                       */
  /* ------------------------------------------------------------------ */

  function getBoard() {
    return document.querySelector("wc-chess-board");
  }

  // chess.com square classes are always absolute ("square-21" = b2),
  // independent of board flip.
  function toAlg(numericSquare) {
    return FILES[Number(numericSquare[0]) - 1] + numericSquare[1];
  }

  function algToClass(square) {
    return (FILES.indexOf(square[0]) + 1) + square[1];
  }

  function fileNum(square) {
    return FILES.indexOf(square[0]);
  }

  function getPieces(board) {
    const map = new Map();
    for (const el of board.querySelectorAll(".piece")) {
      let code = null;
      let sq = null;
      for (const c of el.classList) {
        if (/^[wb][pnbrqk]$/.test(c)) code = c;
        else if (c.startsWith("square-")) sq = c.slice(7);
      }
      if (code && sq) map.set(toAlg(sq), code);
    }
    return map;
  }

  /* ------------------------------------------------------------------ */
  /* Position state (complete FEN reconstruction)                        */
  /* ------------------------------------------------------------------ */

  function inferCastling(pieces) {
    const c = { K: false, Q: false, k: false, q: false };
    if (pieces.get("e1") === "wK") {
      c.K = pieces.get("h1") === "wR";
      c.Q = pieces.get("a1") === "wR";
    }
    if (pieces.get("e8") === "bK") {
      c.k = pieces.get("h8") === "bR";
      c.q = pieces.get("a8") === "bR";
    }
    return c;
  }

  function snapshotPosition() {
    const board = getBoard();
    if (!board) return;
    S.pieces = getPieces(board);
    S.playerColour = board.classList.contains("flipped") ? "b" : "w";
    S.sideToMove = S.playerColour;
    S.castling = inferCastling(S.pieces);
    S.ep = "-";
    S.halfmove = 0;
    S.fullmove = 1;
    S.results = [];
    S.bestMove = null;
    S.lastAnalyzedFen = null;
    S.noMoveFen = null;
  }

  // Apply an observed position change: figures out what move(s) happened,
  // updates castling rights, en-passant square and the clocks.
  function applyMove(next) {
    const prev = S.pieces;
    const removed = [];                                   // {sq, code}
    const added = [];

    for (const [sq, code] of prev) {
      if (next.get(sq) !== code) removed.push({ sq, code });
    }
    for (const [sq, code] of next) {
      if (prev.get(sq) !== code) added.push({ sq, code });
    }
    if (!removed.length && !added.length) return false;

    // Pair each appearing piece with its source square by identical code.
    // Self-pairs (same square AND code) are chess.com re-creating a piece
    // node — NOT a move — and must be filtered out, or they would be
    // misread as a null move and corrupt the turn tracking.
    const moves = [];
    const consumed = new Set();
    for (const a of added) {
      if (prev.get(a.sq) === a.code) { consumed.add(a.sq); continue; } // node re-created in place
      const src = removed.find((r) => !consumed.has(r.sq) && r.code === a.code);
      if (src) {
        consumed.add(src.sq);
        moves.push({ from: src.sq, to: a.sq, code: a.code });
      }
    }

    // Leftover vanished pawns on the 7th/2nd rank => promotions.
    const matchedTos = new Set(moves.map((m) => m.to));
    const promotions = [];
    for (const r of removed) {
      if (consumed.has(r.sq) || !/[wb]P$/.test(r.code)) continue;
      const lastRank = r.code[0] === "w" ? "8" : "1";
      const cand = added.find(
        (a) => !matchedTos.has(a.sq) &&
               !promotions.some((p) => p.to === a.sq) &&
               a.sq[1] === lastRank &&
               Math.abs(fileNum(a.sq) - fileNum(r.sq)) <= 1
      );
      if (cand) {
        promotions.push({ from: r.sq, to: cand.sq, code: r.code, promotion: cand.code[1] });
        consumed.add(r.sq);
      }
    }
    moves.push(...promotions);

    // A diff with no pairable move (mid-animation snapshot, drag ghost,
    // partial re-render) must NOT touch tracked state — a corrupted
    // snapshot or a wrong side-to-move used to silently kill all further
    // analysis (the "stops working until refresh" bug). Ignore this
    // observation entirely; the next stable one diffs cleanly against the
    // snapshot we kept. (Every legal chess move removes a piece from its
    // origin square, so a real move is always pairable.)
    if (!moves.length) return false;

    // Anything still unaccounted for vanished => it was captured.
    const capture = removed.filter((r) => !consumed.has(r.sq)).length > 0 ||
                    removed.length > added.length;

    // Primary move: prefer a pawn move, otherwise the king move, otherwise first.
    const main =
      moves.find((m) => /[wb]P$/.test(m.code)) ||
      moves.find((m) => /[wb]K$/.test(m.code)) ||
      moves[0];

    if (main) {
      const kind = main.code[1];

      // King move: lose both rights for that colour.
      if (kind === "K") {
        if (main.code[0] === "w") { S.castling.K = false; S.castling.Q = false; }
        else { S.castling.k = false; S.castling.q = false; }
      }

      // Any rook leaving its home square (or captured there) kills that right.
      const ROOK_RIGHTS = { h1: "K", a1: "Q", h8: "k", a8: "q" };
      for (const r of removed) {
        if (/[wb]R$/.test(r.code) && ROOK_RIGHTS[r.sq]) S.castling[ROOK_RIGHTS[r.sq]] = false;
      }
      for (const m of moves) {
        const right = ROOK_RIGHTS[m.to];
        // A piece arriving on a rook home square means the rook was captured.
        if (right && prev.get(m.to) && prev.get(m.to)[1] === "R") S.castling[right] = false;
      }

      // Double pawn push => en-passant target square.
      if (kind === "P" && Math.abs(Number(main.to[1]) - Number(main.from[1])) === 2) {
        const mid = (Number(main.from[1]) + Number(main.to[1])) / 2;
        S.ep = main.from[0] + mid;
      } else {
        S.ep = "-";
      }

      // Clocks (approximate move counter — irrelevant for move quality).
      S.halfmove = (kind === "P" || capture) ? 0 : S.halfmove + 1;
      if (S.sideToMove === "b") S.fullmove += 1;
      // Anchor the side to move to the OBSERVED mover's colour instead of
      // blind-flipping the previous value: if a board mutation is ever
      // missed, a stateful flip stays inverted FOREVER and analysis
      // silently stops firing (the "stops working until refresh" bug).
      // Re-anchoring on every observed move self-heals immediately.
      S.sideToMove = main.code[0] === "w" ? "b" : "w";
    }

    S.pieces = next;
    return true;
  }

  function buildFen() {
    const rows = [];
    for (let rank = 8; rank >= 1; rank--) {
      let row = "";
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const code = S.pieces.get(FILES[f] + rank);
        if (!code) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += code[0] === "w" ? code[1].toUpperCase() : code[1].toLowerCase();
      }
      if (empty) row += empty;
      rows.push(row);
    }
    const c = S.castling;
    const castling = (c.K ? "K" : "") + (c.Q ? "Q" : "") + (c.k ? "k" : "") + (c.q ? "q" : "");
    return `${rows.join("/")} ${S.sideToMove} ${castling || "-"} ${S.ep} ${S.halfmove} ${S.fullmove}`;
  }

  /* ------------------------------------------------------------------ */
  /* Engine (Stockfish 18 WASM)                                          */
  /* ------------------------------------------------------------------ */

  function post(cmd) {
    if (engineCtl.port) port_post(engineCtl.port, cmd);
  }

  // The engine worker lives in the extension's BACKGROUND page (see
  // scripts/engine-bg.js). Extension pages can always create Workers, and
  // runtime ports work identically everywhere — no dependence on chess.com's
  // DOM, CSP, or whether page-embedded extension iframes survive.
  function port_post(port, cmd) {
    try {
      port.postMessage(cmd);
    } catch (_) {
      /* port died mid-search; the disconnect handler takes over */
    }
  }

  function startEngine() {
    if (engineCtl.ready) return Promise.resolve(true);
    if (engineLaunch) return engineLaunch;

    engineLaunch = launch().then(
      (ok) => {
        engineLaunch = null;
        if (S.running) analyze();               // pick up any pending toggle
        return ok;
      },
      (err) => { engineLaunch = null; throw err; }
    );
    return engineLaunch;
  }

  function launch() {
    return new Promise((resolve, reject) => {
      const p = chrome.runtime.connect({ name: "chessable-engine" });

      // Silence guard — RESET on every sign of progress (boot stage reports,
      // engine output). A slow first boot (7 MB fetch + compile on mobile
      // data) streams progress the whole way and is never killed; only true
      // silence fails, and the last boot stage is in S.bootInfo for the pill.
      let timer = setTimeout(
        () => fail(`no engine progress for ${ENGINE_READY_TIMEOUT_MS / 1000}s`),
        ENGINE_READY_TIMEOUT_MS
      );
      const kick = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => fail(`no engine progress for ${ENGINE_READY_TIMEOUT_MS / 1000}s`),
          ENGINE_READY_TIMEOUT_MS
        );
      };

      function fail(why) {
        clearTimeout(timer);
        S.engineErrorMsg = String(why).slice(0, 42);
        try { p.disconnect(); } catch (_) {}
        engineCtl.port = null;
        reject(new Error(why));
      }

      p.onMessage.addListener((msg) => {
        if (msg && msg.error) {
          console.error("[chessable] engine:", msg.error);
          if (engineCtl.ready) {
            // Established session hit an error (e.g. the background's boot
            // watchdog fired). fail() would reject an already-settled
            // promise — a no-op that leaves ready=true with a dead port:
            // the zombie state. Do a real restart instead.
            forceEngineRestart(String(msg.error).slice(0, 42));
          } else {
            fail(msg.error);
          }
          return;
        }
        if (msg && msg.info) {
          // Boot diagnostic from the instrumented worker (stage reports).
          // Shown in the pill while booting so progress is always visible.
          console.log("[chessable] boot:", msg.info);
          S.bootInfo = String(msg.info).slice(0, 60);
          kick(); // progress — keep the guard patient
          scheduleRender();
          return;
        }
        if (msg && typeof msg === "object" && msg.cloud) {
          applyCloudResult(msg.cloud);
          return;
        }
        if (msg && typeof msg === "object" && msg.cloudError) {
          console.warn("[chessable] cloud:", msg.cloudError);
          if (S.searching && S.fen) localSearch(S.fen);   // seamless fallback
          return;
        }
        if (msg && msg.ready) {
          // Worker process exists. Kick off the UCI handshake — Stockfish
          // only replies "uciok" AFTER receiving "uci".
          engineCtl.port = p;
          post("uci");
          return;
        }
        const line = msg ? msg.line : null;
        if (typeof line !== "string") return;
        kick(); // engine output — alive

        if (line.startsWith("uciok")) {
          configure();
          engineCtl.ready = true;
          clearTimeout(timer);
          resolve(true);
          return;
        }
        handleEngineLine(line);
      });

      p.onDisconnect.addListener(() => {
        clearTimeout(timer);
        engineCtl.port = null;
        if (!engineCtl.ready) {
          S.engineErrorMsg = "engine host disconnected";
          reject(new Error(S.engineErrorMsg));
        } else {
          // Background page was suspended; re-arm so the next move boots it.
          engineCtl.ready = false;
        }
      });
    });
  }

  function configure() {
    post(`setoption name Hash value ${HASH_MB}`);
    post(`setoption name MultiPV value ${MULTI_PV}`);
    post("isready");
  }

  function handleEngineLine(line) {
    // Ignore everything from a search we already cancelled/superseded —
    // trailing lines from a stopped engine must never overwrite state.
    if (!S.searching) return;
    if (line.startsWith("bestmove")) {
      clearSearchWatchdog();
      S.searching = false;
      const mv = line.split(/\s+/)[1];
      S.bestMove = mv && mv !== "(none)" ? mv : null;
      if (!S.bestMove) S.noMoveFen = S.fen;      // game over — don't re-spin
      scheduleRender();
      return;
    }
    if (!line.startsWith("info ") || !line.includes(" pv ")) return;

    // Skip partial stats-only infos.
    const pvMatch = / pv (.+)$/.exec(line);
    const depthMatch = /depth (\d+)/.exec(line);
    const scoreMatch = /score (cp|mate) (-?\d+)/.exec(line);
    if (!depthMatch || !scoreMatch || !pvMatch) return;

    const mpvMatch = /multipv (\d+)/.exec(line);
    const index = mpvMatch ? Number(mpvMatch[1]) - 1 : 0;

    S.results[index] = {
      depth: Number(depthMatch[1]),
      type: scoreMatch[1],
      value: Number(scoreMatch[2]),
      pv: pvMatch[1].trim(),
    };
    S.reachedDepth = Math.max(S.reachedDepth, Number(depthMatch[1]));
    S.searching = true;
    scheduleRender();
  }

  function analyze() {
    if (!engineCtl.ready || !S.running) return;
    const fen = buildFen();
    // Cancel ANY in-flight local search from a previous position first —
    // an un-cancelled search answers later and its stale bestmove/info
    // lines would corrupt the new analysis' state.
    post("stop");
    S.fen = fen;
    S.lastAnalyzedFen = fen;
    S.results = [];
    S.bestMove = null;
    S.searching = true;
    S.reachedDepth = 0;
    S.cloudUsed = false;
    scheduleRender();
    armSearchWatchdog();

    // Cloud first: a real multi-threaded Stockfish on server hardware
    // answers at far greater depth than a phone can and in a few hundred
    // ms — without burning the battery. The local WASM engine stays warm
    // and takes over automatically on any cloud failure or timeout.
    const id = ++cloudReqId;
    try {
      engineCtl.port.postMessage({ __cloud: fen, depth: S.depth });
    } catch (_) {
      localSearch(fen);                    // port already dead
      return;
    }
    clearTimeout(cloudFallbackTimer);
    cloudFallbackTimer = setTimeout(() => {
      if (id === cloudReqId && S.running && S.searching) localSearch(fen);
    }, CLOUD_TIMEOUT_MS);
  }

  function localSearch(fen) {
    if (!S.running) return;
    post("stop");                          // cancel any previous search
    post(`position fen ${fen}`);
    // Depth AND time limited: Stockfish stops at whichever comes first. The
    // depth box is a quality CAP — easy positions still reach it instantly —
    // while MOVETIME_MS guarantees a move within ~1 s even in complex
    // middlegames (a bare depth-18 search can grind for 4-8 s on a phone).
    post(`go depth ${S.depth} movetime ${MOVETIME_MS}`);
    scheduleRender();
  }

  function applyCloudResult(c) {
    if (!S.running || !S.searching) return;             // stale or stopped
    // Stale-answer protection: a slow cloud reply for a PREVIOUS position
    // must never be shown for the current one.
    if (c && typeof c.fen === "string" && S.fen && c.fen !== S.fen) return;
    if (!c || typeof c.move !== "string" || c.move.length < 4) {
      if (S.fen) localSearch(S.fen);                    // malformed — fall back
      return;
    }
    clearSearchWatchdog();
    clearTimeout(cloudFallbackTimer);
    S.searching = false;
    S.cloudUsed = true;
    S.bestMove = c.move;
    S.reachedDepth = Number(c.depth) || 0;

    // chess-api scores are SIDE-TO-MOVE relative — exactly what
    // formatScore() expects, so they are used as-is.
    const mate = c.mate != null ? Number(c.mate) : null;
    const cpRaw = Number(c.centipawns);
    const cp = Number.isFinite(cpRaw) ? cpRaw : 0;

    S.results[0] =
      mate != null && mate !== 0
        ? { depth: S.reachedDepth, type: "mate", value: mate, pv: c.move }
        : { depth: S.reachedDepth, type: "cp", value: cp, pv: c.move };
    scheduleRender();
  }

  function armSearchWatchdog() {
    clearSearchWatchdog();
    searchWatchdog = setTimeout(() => {
      searchWatchdog = null;
      if (!S.running || !S.searching) return;
      // No answer of any kind for 15 s — the engine host is wedged (e.g.
      // Firefox suspended the background page mid-search and the port died
      // without ever firing onDisconnect). Tear it down and re-boot.
      forceEngineRestart("no answer for 15s");
    }, SEARCH_WATCHDOG_MS);
  }

  function clearSearchWatchdog() {
    clearTimeout(searchWatchdog);
    searchWatchdog = null;
  }

  // Retry button: healthy engine -> just re-analyse; anything doubtful ->
  // full engine-host restart (fresh worker) and re-analyse.
  function forceRetry() {
    if (!S.running) {
      startHack();
      return;
    }
    S.engineError = false;
    S.engineErrorMsg = null;
    if (engineCtl.ready && engineCtl.port && !S.searching) {
      analyze();
    } else {
      forceEngineRestart("manual retry");
    }
  }

  function forceEngineRestart(why) {
    console.warn("[chessable] restarting engine host:", why);
    clearSearchWatchdog();
    clearTimeout(cloudFallbackTimer);
    cloudReqId++;
    S.searching = false;
    // Full teardown: disconnecting makes the background page TERMINATE the
    // (possibly wedged) worker, and the fresh connection boots a new one.
    // Restarting while reusing the old worker left the pill idle forever.
    if (engineCtl.port) {
      const p = engineCtl.port;
      engineCtl.port = null;
      try { p.disconnect(); } catch (_) {}
    }
    engineCtl.ready = false;
    startEngine()
      .then((ok) => {
        if (ok && S.running) analyze();
      })
      .catch(showEngineError);
  }

  /* ------------------------------------------------------------------ */
  /* Move display                                                        */
  /* ------------------------------------------------------------------ */

  function describeMove(uci) {
    if (!uci || uci.length < 4) return uci || "";
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci[4];
    const piece = S.pieces.get(from);
    if (!piece) return uci;

    const kind = piece[1].toLowerCase();

    if (kind === "k" && Math.abs(fileNum(to) - fileNum(from)) === 2) {
      return fileNum(to) > 4 ? "O-O" : "O-O-O";
    }

    const capture = S.pieces.has(to) || (kind === "p" && from[0] !== to[0]);
    let san;
    if (kind === "p") {
      san = (capture ? `${from[0]}x` : "") + to;
    } else {
      san = PIECE_LETTERS[kind] + (capture ? "x" : "") + to;
    }
    if (promo) san += `=${promo.toUpperCase()}`;
    return san;
  }

  function formatScore(result) {
    // Scores are relative to the side to move; show from White's perspective.
    const sign = S.sideToMove === "w" ? 1 : -1;
    if (result.type === "mate") {
      const n = result.value * sign;
      return n > 0 ? `#${n}` : `-#${Math.abs(n)}`;
    }
    const pawns = (result.value * sign) / 100;
    return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)}`;
  }

  function clearHighlights() {
    document.querySelectorAll(".cheat-highlight").forEach((el) => el.remove());
  }

  function highlightMove(bestUci) {
    clearHighlights();
    if (!bestUci || bestUci.length < 4) return;
    const board = boardEl && boardEl.isConnected ? boardEl : getBoard();
    if (!board) return;
    const flipped = board.classList.contains("flipped");
    for (const square of [bestUci.slice(0, 2), bestUci.slice(2, 4)]) {
      const f = FILES.indexOf(square[0]);
      const r = Number(square[1]);
      if (f < 0 || !(r >= 1 && r <= 8)) continue;
      // Position explicitly (percent of the board) instead of borrowing
      // chess.com's .highlight CSS, which does not reliably style injected
      // elements. Flip-aware: chess.com renders rank 8 at the top unless the
      // board has the "flipped" class.
      const left = (flipped ? 7 - f : f) * 12.5;
      const top = (flipped ? r - 1 : 8 - r) * 12.5;
      const el = document.createElement("div");
      el.className = "cheat-highlight";
      el.style.cssText =
        `position:absolute;left:${left}%;top:${top}%;` +
        "width:12.5%;height:12.5%;background:#81b64c;opacity:0.5;" +
        "pointer-events:none;z-index:0;border-radius:2px;";
      // Insert beneath the pieces (first child) so the move tint sits under
      // them, exactly like chess.com's own last-move highlights.
      board.insertBefore(el, board.firstChild);
    }
  }

  /* ------------------------------------------------------------------ */
  /* UI — one quiet pill above the board                                 */
  /* ------------------------------------------------------------------ */

  const refs = {};

  function buildPanel() {
    const pill = document.createElement("div");
    pill.id = "cc-panel";
    pill.title = "Chessable \u2014 click to toggle analysis";
    pill.style.cssText = [
      "display:inline-flex", "align-items:center", "gap:8px",
      "padding:5px 14px", "margin-bottom:8px", "border-radius:999px",
      "background:rgba(30,29,27,0.9)", "color:#a19d98",
      "font-family:'Segoe UI',sans-serif", "font-size:12px",
      "line-height:1", "cursor:pointer", "user-select:none",
      "box-shadow:0 1px 4px rgba(0,0,0,0.35)",
      "backdrop-filter:blur(6px)", "-webkit-backdrop-filter:blur(6px)",
    ].join(";");

    const dot = document.createElement("span");
    dot.style.cssText =
      "width:8px;height:8px;border-radius:50%;background:#57534e;flex:none;" +
      "transition:background 0.2s;";
    refs.dot = dot;

    const label = document.createElement("span");
    label.textContent = "Chessable";
    label.style.cssText = "font-weight:600;color:#e8e6e3;letter-spacing:0.2px;";

    const depthInput = document.createElement("input");
    depthInput.type = "number";
    depthInput.min = "6";
    depthInput.max = "30";
    depthInput.value = String(S.depth);
    depthInput.title =
      "Max search depth (6\u201330). Moves are also capped at ~1 s of thinking, " +
      "so higher depths only kick in for easy positions.";
    depthInput.style.cssText =
      "width:40px;padding:2px 3px;border-radius:4px;border:1px solid #3d3a37;" +
      "background:#211f1d;color:#c7c3bf;font-size:11px;text-align:center;" +
      "outline:none;";
    depthInput.addEventListener("click", (e) => e.stopPropagation());
    depthInput.addEventListener("change", () => {
      const v = Number(depthInput.value);
      S.depth = Math.min(30, Math.max(6, Number.isFinite(v) ? v : 18));
      depthInput.value = String(S.depth);
      if (S.running) analyze();               // restart search at the new depth
    });
    refs.depth = depthInput;

    const move = document.createElement("strong");
    move.style.cssText = "color:#ffffff;font-size:13px;font-weight:700;display:none;";
    refs.move = move;

    const evalTxt = document.createElement("span");
    evalTxt.style.cssText = "display:none;";
    refs.eval = evalTxt;

    const depthInfo = document.createElement("span");
    depthInfo.style.cssText =
      "display:none;font-size:10px;color:#8f8a86;font-variant-numeric:tabular-nums;";
    refs.depthInfo = depthInfo;

    // Manual failsafe: force-restart the engine host and re-analyse, so a
    // wedged session never requires a full page refresh.
    const retry = document.createElement("span");
    retry.textContent = "\u27f3";
    retry.title = "Force restart the engine and re-analyse";
    retry.style.cssText =
      "display:none;cursor:pointer;color:#c7c3bf;font-size:13px;line-height:1;" +
      "padding:0 3px;user-select:none;";
    retry.addEventListener("click", (e) => {
      e.stopPropagation();
      forceRetry();
    });
    refs.retry = retry;

    pill.append(dot, label, depthInput, move, evalTxt, depthInfo, retry);
    pill.addEventListener("click", () => (S.running ? stopHack() : startHack()));
    return pill;
  }

  function ensureUI() {
    const host = document.querySelector(".board-layout-main");
    if (!host) return;
    if (!document.getElementById("cc-panel")) host.prepend(buildPanel());
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderPanel();
    }, RENDER_THROTTLE_MS);
  }

  function renderPanel() {
    if (!refs.dot || !document.getElementById("cc-panel")) return;
    const best = S.results[0];

    // Board highlight always mirrors the pill: green from/to squares while a
    // best move is showing, cleared the moment there isn't one (new position,
    // engine off, engine error). This is the ONLY place highlights are drawn,
    // so they can never go stale or desync from the pill.
    if (S.running && S.bestMove && !S.engineError) highlightMove(S.bestMove);
    else clearHighlights();

    if (refs.depth) refs.depth.value = String(S.depth);

    // The retry button is visible whenever analysis is on — including the
    // error state, where it is needed most.
    refs.retry.style.display = "";

    if (S.engineError) {
      refs.dot.style.background = "#c0392b";            // red = engine failed
      refs.move.style.display = "none";
      refs.eval.style.display = "none";
      refs.depthInfo.textContent = `${S.engineErrorMsg || "failed"} \u00b7 retry`;
      refs.depthInfo.style.display = "";
      return;
    }

    if (!S.running) {
      refs.dot.style.background = "#57534e";            // gray = off
      refs.move.style.display = "none";
      refs.eval.style.display = "none";
      refs.depthInfo.style.display = "none";
      refs.retry.style.display = "none";
      return;
    }
    refs.retry.style.display = "";                      // visible while on

    // amber while the engine searches, green once a move is ready
    refs.dot.style.background = S.bestMove ? "#81b64c" : "#d4a72c";

    // Live depth confirmation: progress toward the configured target.
    if (!engineCtl.ready) {
      refs.depthInfo.textContent = S.bootInfo ? S.bootInfo : "engine\u2026";
      refs.depthInfo.style.display = "";
    } else if (!S.bestMove) {
      refs.depthInfo.textContent = best
        ? `searching d${best.depth}/${S.depth}`
        : `target d${S.depth}`;
      refs.depthInfo.style.display = "";
    } else {
      refs.depthInfo.textContent = `d${S.reachedDepth}/${S.depth}${S.cloudUsed ? " \u2601" : ""}`;
      refs.depthInfo.style.display = "";
    }

    if (S.bestMove) {
      refs.move.textContent = describeMove(S.bestMove);
      refs.move.style.display = "";
      refs.eval.textContent = formatScore(best ?? { type: "cp", value: 0 });
      refs.eval.style.display = "";
    } else {
      refs.move.style.display = "none";
      refs.eval.style.display = "none";
    }
  }

  /* ------------------------------------------------------------------ */
  /* Board watching (MutationObserver, no polling)                       */
  /* ------------------------------------------------------------------ */

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncBoard, SYNC_DEBOUNCE_MS);
  }

  function syncBoard() {
    const board = getBoard();
    if (!board || !board.isConnected) return;

    // New game / SPA navigation swapped the board element underneath us.
    if (board !== boardEl) {
      boardEl = board;
      snapshotPosition();
      attachObserver(board);
      if (S.running) analyze();
      return;
    }

    const next = getPieces(board);
    if (!next.size) return;
    if (mapsEqual(next, S.pieces)) return;

    const changed = applyMove(next);
    // Analyse EVERY confirmed position change — ours or the opponent's.
    // Gating the trigger on tracked turn state is what made one missed or
    // misread mutation stall the pill forever ("stops working until
    // refresh"): the FEN comes straight from the DOM, so a search for the
    // current position is always safe, whichever side is to move.
    if (changed && S.running) analyze();
  }

  function mapsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (b.get(k) !== v) return false;
    return true;
  }

  function attachObserver(board) {
    observer?.disconnect();
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        const touchedPiece = (node) =>
          node?.nodeType === 1 && node.classList?.contains("piece");
        if (
          (m.type === "attributes" && touchedPiece(m.target)) ||
          (m.type === "childList" &&
            ([...m.addedNodes, ...m.removedNodes].some(touchedPiece)))
        ) {
          scheduleSync();
          return;
        }
      }
    });
    observer.observe(board, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      subtree: true,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Start / stop                                                        */
  /* ------------------------------------------------------------------ */

  // One tap: flip on immediately (snappy UI), engine warms up in the
  // background and the search starts the moment it is ready. No popups.
  function startHack() {
    const board = getBoard();
    if (!board || S.running) return;
    S.engineError = false;
    S.engineErrorMsg = null;
    S.bootInfo = null;
    boardEl = board;
    snapshotPosition();
    attachObserver(board);
    S.running = true;
    renderPanel();                              // amber dot right away
    if (engineCtl.ready) {
      // Engine already preloaded — analyse THIS position right now. (This
      // was the bug: the ready path of startEngine() resolved without ever
      // calling analyze(), so nothing happened until the next observed move.)
      analyze();
    } else {
      startEngine().catch(showEngineError);     // launch path analyses on ready
    }
  }

  function showEngineError(err) {
    console.error("[chessable]", err);
    if (!S.running) return;
    clearSearchWatchdog();
    clearTimeout(cloudFallbackTimer);
    cloudReqId++;                             // invalidate in-flight cloud asks
    S.running = false;
    S.engineError = true;
    clearHighlights();
    renderPanel();                              // red dot + hint, no alert
  }

  function stopHack() {
    S.running = false;
    clearSearchWatchdog();
    clearTimeout(cloudFallbackTimer);
    cloudReqId++;                             // invalidate in-flight cloud asks
    post("stop");
    observer?.disconnect();
    observer = null;
    clearHighlights();
    S.results = [];
    S.bestMove = null;
    S.searching = false;
    renderPanel();
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  ensureUI();
  // Preload the engine silently in the background as soon as a board page is
  // detected, so the first tap on the pill analyses instantly.
  let preloadStarted = false;
  // Cheap heartbeat: survives chess.com SPA navigation / panel removal.
  uiTimer = setInterval(() => {
    ensureUI();
    if (!preloadStarted && document.querySelector(".board-layout-main")) {
      preloadStarted = true;
      startEngine().catch(() => {});              // silent: retried on tap
    }
    if (S.running) {
      if (engineCtl.port) {
        post("__ping");                          // keeps the bg page alive mid-game
        // Safety net against ANY missed analysis trigger (observer hiccup,
        // SPA quirk, drifted state). The invariant is simple: the CURRENT
        // board position must have a search issued for it. Re-run the full
        // board sync (cheap, idempotent — it no-ops when nothing changed)
        // and re-analyse whenever the invariant is violated. This makes a
        // permanent stall structurally impossible: even if every trigger
        // is missed, the pill self-heals within one heartbeat.
        syncBoard();
        const fen = S.pieces.size ? buildFen() : null;
        if (
          engineCtl.ready &&
          !S.searching &&
          fen &&
          fen !== S.lastAnalyzedFen &&           // no search issued for THIS position yet
          fen !== S.noMoveFen                    // game-over position — don't spin
        ) {
          analyze();
        }
      } else if (!engineLaunch && !S.engineError) {
        startEngine().catch(showEngineError);     // bg was suspended — re-arm
      }
    }
    if (S.running && !getBoard()?.isConnected) {
      // Board vanished (game ended / navigated away) — stand down quietly.
      stopHack();
    }
  }, 2500);
})();
