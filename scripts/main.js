// Chessable 2.1 — subtle Stockfish 18 (NNUE, WebAssembly) analysis for chess.com.
// One quiet pill above the board: click to toggle, best move appears on the
// board itself. Event-driven board watching, complete FEN reconstruction.
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
  };

  let boardEl = null;
  let observer = null;
  let syncTimer = null;
  let renderTimer = null;
  let uiTimer = null;
  let engineLaunch = null;              // in-flight launch promise

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
    const moves = [];
    const consumed = new Set();
    for (const a of added) {
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
      S.sideToMove = S.sideToMove === "w" ? "b" : "w";
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
          fail(msg.error);
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
    if (line.startsWith("bestmove")) {
      S.searching = false;
      const mv = line.split(/\s+/)[1];
      S.bestMove = mv && mv !== "(none)" ? mv : null;
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
    S.fen = fen;
    S.results = [];
    S.bestMove = null;
    S.searching = true;
    S.reachedDepth = 0;
    post("stop");                              // cancel any previous search
    post(`position fen ${fen}`);
    post(`go depth ${S.depth}`);               // NOTE: template literal (the old bug!)
    scheduleRender();
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
    depthInput.title = "Search depth (6\u201330). Higher = stronger but slower.";
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

    pill.append(dot, label, depthInput, move, evalTxt, depthInfo);
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
      return;
    }

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
      refs.depthInfo.textContent = `d${S.reachedDepth}/${S.depth}`;
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
      if (S.running && S.sideToMove === S.playerColour) analyze();
      return;
    }

    const next = getPieces(board);
    if (!next.size) return;
    if (mapsEqual(next, S.pieces)) return;

    applyMove(next);
    // Only burn CPU analysing when it is actually our move.
    if (S.running && S.sideToMove === S.playerColour) analyze();
    else if (S.running) post("stop");
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
    startEngine().catch(showEngineError);
  }

  function showEngineError(err) {
    console.error("[chessable]", err);
    if (!S.running) return;
    S.running = false;
    S.engineError = true;
    clearHighlights();
    renderPanel();                              // red dot + hint, no alert
  }

  function stopHack() {
    S.running = false;
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
