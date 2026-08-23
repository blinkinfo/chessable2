# Chessable

Formerly *chesscheat*. Chessable shows you the engine's best move — with a
clean evaluation readout — in any chess.com game, right on the board.

The entire UI is **one quiet pill** above the board: click it to toggle
analysis on/off. The best move appears as a subtle green highlight on the
board itself, with the move (e.g. `Nf3`) and eval (`+0.4`) shown in the pill.
No panels, no clutter.

**What's new in 2.0**

- **Stockfish 18 (NNUE, WebAssembly)** bundled with the extension — no longer
  borrows chess.com's internal asm.js engine (roughly Stockfish 10, hundreds of
  Elo weaker). Multi-threaded build is used automatically when the browser
  supports `SharedArrayBuffer`, with a single-threaded fallback.
- **Complete position tracking**: castling rights, en-passant targets and move
  clocks are now reconstructed, so the engine never suggests an illegal move.
- **Event-driven**: a `MutationObserver` replaces the old busy-wait polling —
  near-zero idle CPU usage, instant reaction to moves.
- **Smarter analysis**: configurable depth (6–30), MultiPV top-3 lines with
  evaluations, mate announcements, SAN-style move display (`Nf3`, `exd5`,
  `O-O`, `e8=Q`), and analysis only runs when it's your turn.

*Note: this project was developed for learning purposes. I do not condone or
encourage cheating in games — unfair play can get your chess.com account
suspended.*

## Install

1. Clone or download this repo.
2. Install dependencies and fetch the engine binaries (Node.js required):

   ```bash
   npm install
   # or: bun install && bun run setup
   ```

   This copies the Stockfish 18 WASM files into `engine/` (git-ignored,
   ~220 MB on disk).

3. Open `chrome://extensions` (or `about:debugging` in Firefox), enable
   **Developer mode**, click **Load Unpacked**, and select the repo folder.
4. Open a chess.com game and click the **Chessable** pill to toggle analysis.

## Deploy to Firefox (including Firefox for Android)

The extension ships as a signed add-on from [addons.mozilla.org (AMO)](https://addons.mozilla.org).
See the step-by-step guide at the bottom of this file — no PC required.

For maintainers: every push to `master` triggers a GitHub Actions workflow
(`.github/workflows/build.yml`) that builds `chessable-firefox.xpi` and uploads
it as a downloadable artifact. You can also build it locally:

```bash
npm install
npm run package:firefox   # -> chessable-firefox.xpi
```

The .xpi bundles the **single-threaded Stockfish 18 NNUE build** (~74 MB), which
works on desktop and Android. It passes `web-ext lint` with zero errors,
warnings and notices.

## How it works

- `scripts/main.js` — content script: scrapes the board DOM into a position
  map, tracks move transitions to maintain a legal FEN (castling / en passant /
  clocks), watches for changes with a debounced `MutationObserver`, drives the
  Stockfish UCI worker, and renders the minimal toggle pill.
- `engine/` — Stockfish 18 WASM binaries copied in at install time.
- `scripts/setup-engine.js` — copies the engine binaries from `node_modules`.

## License

Extension code: ISC. Bundled Stockfish: GPL-3.0 (see
[node_modules/stockfish/Copying.txt](node_modules/stockfish/Copying.txt)).

---

# Publishing from scratch — phone only (no PC)

Everything below can be done entirely from your Android phone.

### Step 1 — Get the built extension file (.xpi)

The repo has a GitHub Actions workflow that builds it for you automatically:

1. Open **github.com** in your phone browser, sign in, and go to your
   `chesscheat` repository (make sure the latest code has been pushed —
   use the Freebuff Changes panel to commit/push).
2. Tap the **Actions** tab → tap the latest **“Build Firefox extension”** run.
3. Scroll to the **Artifacts** section at the bottom and tap
   **chessable-firefox-xpi** to download. It downloads as a `.zip` that
   contains `chessable-firefox.xpi`.
4. Unzip it with your Files app (long-press → Extract) so you have a plain
   `chessable-firefox.xpi` file (~74 MB).

> No GitHub Actions run yet? Push any commit, then tap **Actions →
> “Build Firefox extension” → Run workflow** to trigger it manually.

### Step 2 — Create a mozilla.org account

1. Go to **addons.mozilla.org** in your phone browser and tap **Sign up**
   (top right). Register with an email you check — you must confirm it.

### Step 3 — Submit the extension

1. While signed in on addons.mozilla.org, open:
   **https://addons.mozilla.org/developers/addon/submit/**
2. Choose **“On this site”** (self-hosted distribution is NOT needed — pick
   the default: *submit a new add-on to be listed*).
3. Upload `chessable-firefox.xpi` from your phone storage.
   - The upload takes a while (~74 MB). Keep the page open.
   - AMO validates it automatically — this build passes with **0 errors,
     0 warnings**, so validation should be clean.
4. Fill in the submission details when asked:
   - **Name**: Chessable (pre-filled from the manifest)
   - **Description / Summary**: copy the description from readme.md
   - **License**: GPL-3.0 (required — Stockfish is GPL-licensed)
   - **Data collection**: answer **“This add-on does not collect data”**
   - **Does it need admin/debug permissions?** No.
5. Tap **Submit Version**.

### Step 4 — Wait for automatic signing

Most submissions are **signed automatically within minutes** once validation
passes. Check your email and the developer hub
(**developers/addon/chessable**) for status:

- ✅ **Approved/Signed** → continue to Step 5.
- ⏳ **Awaiting review** → larger files sometimes get flagged for manual
  review; this usually completes in a few days. Nothing for you to do —
  you'll get an email.

### Step 5 — Install on Firefox for Android

1. Install **Firefox** from the Play Store (or Fenix/Nightly).
2. Open **addons.mozilla.org** in Firefox on your phone and search
   **“Chessable”**, or open your add-on's listing page directly from the
   developer hub (**View Listing** link).
3. Tap **Add to Firefox** → confirm the permission prompt
   (it only asks for access to chess.com).
4. Done — open or join any chess.com game and tap the little
   **● Chessable** pill above the board to switch analysis on.

### Troubleshooting

| Problem | Fix |
| --- | --- |
| “Download failed” on AMO upload | Use Chrome/Firefox stable on Android; retry on Wi-Fi; make sure you extracted the artifact `.zip` first |
| Pill doesn't appear | Refresh the game page; check the extension is enabled under Firefox menu → Add-ons |
| “Loading engine…” forever | First load unpacks a 113 MB engine — wait ~30 s on a fast connection; then reload the page |
| Engine fails to start | Your phone may be low on memory — close other apps and reload |
| Update released later | Bump `version` in manifest.json, push, download the new artifact, and submit it as a **new version** of the same add-on in the developer hub |
