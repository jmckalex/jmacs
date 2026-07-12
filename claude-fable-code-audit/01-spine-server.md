# Spine server core (spine.js) — audit

**Date:** 2026-07-01 · **Auditor:** audit agent 1/13 · **Branch:** main @ efe0fa6d

| File | Lines | Coverage |
|---|---|---|
| `apps/desktop/mwb/spine.js` | 6103 | **read fully** |
| `apps/desktop/mwb/server.js` | 2360 | **read fully** |
| `apps/desktop/mwb/buffer-registry.js` | 390 | **read fully** |
| `apps/desktop/mwb/pane-model.js` | 1076 | **read fully** |
| `apps/desktop/mwb/autosave.js` | 264 | **read fully** |
| `apps/desktop/mwb/session-store.js` | 176 | **read fully** |
| `packages/stdlib/lisp/keymap.lisp` | 470 | dispatch half (l.274–470) read; rest grepped |
| `packages/stdlib/lisp/commands.lisp` | 140 | **read fully** |
| `packages/view/src/view.js` | 235 | **read fully** |
| `packages/buffer/src/buffer.js` | ~830 | key sections read (cursor source, markers, clamp, insert, setMark) |
| `packages/storage/src/buffer.js` | — | `positionAt` / `assertOffset` excerpts |
| `packages/lisp/src/reader.js` | — | `readString` escape map excerpt |
| `apps/desktop/mwb/spine.test.js` | 2875 | full test-name survey + targeted reads (restore-clamp tests) |
| `apps/desktop/src/main.js`, `src/app.js`, `src/server-bridge.js` | — | targeted excerpts (env wiring, tab-close, quit, respawn) |
| `packages/stdlib/lisp/occur.lisp`, `panes.lisp` | — | grepped |

Verification aids: `node --check spine.js` (clean); duplicate-key scan of the host-primitives object (awk/sort/uniq); explicit-key vs spread-key intersection (node script against the real `createBufferPrimitives`/`createLatexPrimitives` key sets); keymap-bound-symbol vs server-defined-command diff.

---

## Executive summary

- **P0 — one stale per-view cursor kills the whole editor.** Server-side view cursors are plain numbers that do **not** ride edits; `viewStateOf` feeds them unclamped into `positionAt` (which throws `RangeError`); the throw escapes `applyIntent`'s try/catch via the post-intent `broadcastView()` and there is **no** `uncaughtException` handler or respawn in the utilityProcess. Shrink a shared buffer from one window while another window's cursor sits past the new end → the server process dies → every window permanently dead. This is the live-session sibling of the just-fixed restore-path freeze.
- **P1 — the restore clamp fix has a hole**: a workspace leaf whose file no longer opens still applies its *saved* point to the fallback view over the boot `*scratch*` (length 0) — same crash as above on the first keystroke after restore.
- **P1 — crash-recovery snapshots live in `$TMPDIR`** (`godot-mw-b-recovery`); main.js pins the workspace store under `~/.godot` but never sets `MWB_RECOVERY_DIR`. macOS sweeps tmp after ~3 days of non-access, so the *last line of defense for unsaved edits* can evaporate exactly when it's needed (crash → return days later). Also never cleared on a clean quit, contradicting the `*autosave-recovery*` docstring.
- **P1 — closing a tab (×) or C-x k silently discards unsaved edits** — no modified-buffer confirmation anywhere in the path; up to one autosave interval (4s) of work is unrecoverable, the rest resurrects only via crash-recovery-from-tmpdir on the *next* launch.
- **P2 tier:** global modal key-reader eats other windows' keys mid quit-walk/query-replace; `highlight-matches` is unbounded and O(k²) with a full overlay-set broadcast per match; PANE_TREE snapshots ship the full text of unfocused panes on every layout/state tick; command errors are invisible to the user (stderr only); window close leaks shell/browser data-sources, orphan ptys, and string-keyed registry views.
- The embedded Lisp block is in good shape: **no duplicate primitive keys, no spread-key shadowing, no `null?`, directive args all flat, escape levels correct**; two *escaped* backticks live in comments (legal, but against the playbook's letter).
- `mwb/spine.test.js` is real coverage (208 tests, incl. the quit walk, close-tab, restore clamps, pickers, data-sources) — the playbook's "spine.js is not in the suite" is stale. What is genuinely naked is **server.js**: intent fan-out ordering, delta targeting, restore orchestration, autosave wiring — the layer where both crash paths live.

---

## Findings

### SPINE-01: Stale per-view cursor + unclamped `positionAt` crashes the whole server (all windows)

- **Severity**: P0
- **Dimension**: Correctness & data safety (crash / freeze / data loss)
- **Location**: `apps/desktop/mwb/spine.js:5390` (`viewStateOf`); `apps/desktop/mwb/server.js:1153–1158` (`applyIntent` tail: `sendCursorsTo` + `broadcastView` **outside** the try/catch), `server.js:1381` (`MSG.PANE` branch `sendViewTo`), `server.js:1113` (`resyncClientToCurrentBuffer` in the switched-buffer branch); root cause in `packages/view/src/view.js:106–121` + `packages/buffer/src/buffer.js` (`insert`/`delete` shift only the **bound** `cursorSource.cursors`) + `packages/storage/src/buffer.js:83–91,309–317` (`positionAt` → `assertOffset` → `RangeError`).
- **Evidence**:
  ```js
  // spine.js viewStateOf — NOT clamped (contrast pointPosition(), 5711, which is):
  const v = focusedViewOf(index);
  const { line, column } = buf.positionAt(v.point);
  ```
  ```js
  // server.js applyIntent — after the try/catch block ends at 1089:
  sendCursorsTo(client);   // 1153
  broadcastView();         // 1158  → sendViewTo(every client) → viewStateOf(...)
  ```
  A view is a plain record (`view.cursors = [{point, mark}]`, view.js:109); buffer edits shift only the currently `bindCursor`-bound source; `assertOffset` throws `RangeError` for `offset > length`. `server-bridge.js:86–91` logs child exit — "(Respawn orchestration is a later phase.)" — and the utilityProcess has no `uncaughtException` handler (only main.js does), so Node's default kills the process.
- **Failure scenario**: Windows A and B both view buffer X (the flagship one-buffer-two-windows case), or one window with two panes on X. B's cursor sits near the end (point = N). In A: `C-x h` + delete, or `replace-all`/`query-replace` that shrinks X below N. The same intent's tail runs `broadcastView()` → `viewStateOf(B)` → `positionAt(N)` → RangeError → uncaught in the port message handler → **utilityProcess exits**. Every window goes permanently dead (the server is the only key resolver; no respawn). Unsaved edits are lost except the ≤4 s-stale autosave snapshot — which lives in tmpdir (SPINE-03). The same-window variant crashes on the `C-x o` back onto the stale pane (`MSG.PANE` → `sendViewTo`, also unguarded).
- **Fix direction**: Clamp in `viewStateOf` exactly as `pointPosition` already does (`Math.min(v.point, buf.length)` — and mark); optionally reconcile non-bound views' cursors on each buffer change (marker semantics), and add a process-level `uncaughtException` logger + top-level try in `onClientMessage` as defense in depth.
- **Confidence**: CONFIRMED (every link traced in code; only the OS-level process-exit default is asserted from Node semantics rather than observed live).

### SPINE-02: Restore of a since-deleted file applies the saved point unclamped to the boot scratch view — crash on first keystroke

- **Severity**: P1
- **Dimension**: Correctness & data safety (the clamp fix is incomplete)
- **Location**: `spine.js:4977–4996` (`clampRestoredPoints` — early `return` when `registry.findByPath(v.path)` misses); `pane-model.js:944–999` (`loadLayout`/`buildLeaf` — reads `view.point` **before/independent of** resolve success and applies it via the non-clamping `state.view.point = point`); `spine.js:785–794` (`makeLeafView(null, …)` falls back to a view over `initialEntry`); `server.js:108–110` (chooser boots seed `initialText = ''`).
- **Evidence**:
  ```js
  // clampRestoredPoints:
  const entry = registry.findByPath(v.path);
  if (!entry) return;            // ← missing file: point/mark stay UNclamped
  ```
  ```js
  // buildLeaf: bufferId = resolve(view) may be null, yet:
  point = Number.isFinite(view.point) ? view.point : 0;  // saved offset kept
  ...
  state.view.point = point;      // raw setter; state.view is the initialEntry view
  ```
- **Failure scenario**: Save a workspace with the cursor at offset N>0 in `notes.md`; delete or rename `notes.md`; relaunch, pick the workspace from the chooser. `visitFile` fails → the leaf resolves to `null` → its view is minted over the boot `*scratch*` (length 0) with `point = N`. The HELLO paint survives (`sendClientState` steps are individually guarded — good), but the **first intent from any window** hits the unguarded tail `broadcastView()` → `viewStateOf` → `positionAt(N)` on a length-0 buffer → server crash as in SPINE-01. The existing tests cover the *shortened-file* clamp, not the *missing-file* fallback.
- **Fix direction**: In `buildLeaf`, zero the point/mark whenever `resolve(view)` returns null (the saved cursor is meaningless for a substitute buffer); or clamp unconditionally in `viewStateOf` (the SPINE-01 fix covers this too).
- **Confidence**: CONFIRMED (path fully traced; not live-reproduced).

### SPINE-03: Crash-recovery snapshots live in tmpdir and are never cleared on a clean quit

- **Severity**: P1
- **Dimension**: Correctness & data safety (persistence hazard)
- **Location**: `server.js:1516–1517` (`RECOVERY_DIR = process.env.MWB_RECOVERY_DIR || join(tmpdir(), 'godot-mw-b-recovery')`); `apps/desktop/src/main.js:415–450` sets `MWB_CONFIG_HOME` / `MWB_SESSION_STORE` but **never `MWB_RECOVERY_DIR`** (repo-wide grep confirms the only reference is server.js itself); `server.js:2005` — `autosave.clear()` is called only in `recoverOnStartup`; `app.js:2243`'s `recovery.clear()` clears the *renderer's* store, not this directory.
- **Evidence**: main.js's own comment for the workspace store: *"Its own fallback is a $TMPDIR file, which macOS periodically sweeps — named workspaces could silently vanish between reboots. Pin it under the config home"* — the identical hazard was recognized and fixed for `workspaces.json` (commit b72d9141 family) but not for the recovery dir sitting three lines away in the same file.
- **Failure scenario**: (a) The server crashes with unsaved edits; snapshots are written to `$TMPDIR/godot-mw-b-recovery`. The user returns after a weekend; macOS's periodic tmp cleaner (removes files unaccessed ~3 days) has swept them → `recoverOnStartup` finds nothing → the edits are gone despite autosave having done its job. (b) The `*autosave-recovery*` defcustom docstring promises "Existing snapshots are cleared on a clean quit regardless" — in server mode they are not (only consumed on the *next* startup), so edits explicitly discarded via the quit walk's "quit anyway" resurrect as recovered buffers on the next launch.
- **Fix direction**: Set `MWB_RECOVERY_DIR` under `configHome` in main.js (mirroring the workspace-store move, with a one-time tmpdir migration); call `autosave.clear()` from the quit path (e.g. on the `quit` directive handoff or SIGTERM flush) to honor the documented contract.
- **Confidence**: CONFIRMED (code + env wiring traced; macOS sweep behavior is standard platform knowledge).

### SPINE-04: Tab-close (×) and C-x k discard a modified buffer with no confirmation

- **Severity**: P1
- **Dimension**: Correctness & data safety (silent data loss)
- **Location**: `spine.js:5165–5233` (`killBufferById` — no `isModified` check anywhere); `spine.js:5540–5593` (`applyPaneIntent` `close-tab`, `killsView` defaults **true** via `*close-tab-kills-view*` panes.lisp:54); `apps/desktop/src/app.js:6774–6784` (tab-× sends the intent directly, no confirm).
- **Evidence**:
  ```js
  // killBufferById — modified state never consulted:
  const survivor = registry.list().find((e) => e.id !== killedId);
  if (!survivor) return;
  registry.remove(killedId);
  ```
- **Failure scenario**: User edits `chapter7.tex`, clicks the tab's × (or hits C-x k) reflexively — the buffer and its unsaved edits vanish instantly. Emacs prompts ("Buffer modified; kill anyway?"); VS Code/Sublime prompt on close. Here: edits made in the last ≤4 s (the autosave cadence) are permanently gone; older edits survive only as a tmpdir crash-snapshot (SPINE-03) that resurfaces — confusingly, as a "recovered" buffer — on the *next* launch, since nothing prunes a killed buffer's snapshot and its disk file is older than it.
- **Fix direction**: In the close-tab / kill-view path, when `registry.isModified(entry)`, route through a minibuffer/echo confirm (the quit walk's `read-next-key` y/n pattern is already available server-side) before `killBufferById`.
- **Confidence**: CONFIRMED.

### SPINE-05: The modal key-reader is global — another window's keys answer the quit walk / query-replace

- **Severity**: P2
- **Dimension**: Correctness (multi-window state divergence)
- **Location**: `packages/stdlib/lisp/keymap.lisp:393–421` (`*key-reader*` is a single global; `handle-key` consumes it first, unconditionally); `server.js:813–815` (`applyIntent` sets the *sender* as active client before `handleKey`); quit walk `spine.js:3277–3338`.
- **Evidence**: `handle-key`'s first branch routes **any** key from **any** window to the pending reader; `-quit-do` then emits the `quit` directive to `(this-window-id)` — which by then is the *other* window.
- **Failure scenario**: Window A runs C-x C-c; the styled "Save "chapter7.tex"? (y/n/!/q)" prompt shows in A. The user keeps typing in window B ("yes" as buffer text) — B's `y` saves the buffer and advances A's walk, `!` saves everything, `q` jumps to the quit-net; and if the walk completes, the shutdown handoff (`quit` directive, workspace prompt, `host.quit()`) is sent to **B**, not A. Same mechanism affects `query-replace`'s per-match loop and `describe-key`.
- **Fix direction**: Tag the reader with the client index that armed it; in `handleKey`, only feed keys from that client to the reader (others resolve normally or get a "modal prompt in another window" status). Requires plumbing the active-client index into the Lisp (a host primitive already exists: `this-window-id`).
- **Confidence**: CONFIRMED (mechanism traced; the misdirected-quit consequence follows directly).

### SPINE-06: `highlight-matches` is unbounded and O(k²) — a freeze on any common word in a large buffer

- **Severity**: P2
- **Dimension**: Correctness / pathological-input perf
- **Location**: `spine.js:3074–3101` (embedded `-add-match-overlays` — whole-buffer, no cap); `spine.js:1588–1596` (`add-overlay!` fires `onOverlays()` **per overlay**); `server.js:605–614` (`broadcastOverlaysForActiveBuffer` serializes the *entire* live set each time); `packages/buffer/src/buffer.js:150–157` (every subsequent edit iterates all live marker shifts).
- **Evidence**: The isearch highlighter directly above it (spine.js:1615–1660) got exactly the protections this lacks: a ±8000-char window, a 400-overlay cap, and a 300 ms debounce — the comment even says why ("never constructs hundreds of overlays per keystroke").
- **Failure scenario**: `M-s h` with point on "e" (or a region of a common token) in a 2 MB buffer → tens of thousands of matches → for match k, `onOverlays()` re-snapshots and re-posts all k overlays to every client on the buffer: O(k²) serialization + k port messages + 2k live markers that then tax **every keystroke** afterwards (marker-shift loop per change). Multi-second freeze to meltdown; the overlays persist until `M-s u`.
- **Fix direction**: Batch — add all overlays, then fire `onOverlays()` once (a `withOverlayBatch` or an explicit `-add-match-overlays` host primitive); cap the count like isearch's 400; consider windowing around point.
- **Confidence**: CONFIRMED.

### SPINE-07: PANE_TREE snapshots ship the full text of unfocused different-buffer panes on every layout/state tick

- **Severity**: P2
- **Dimension**: Perf (message-size cliff)
- **Location**: `pane-model.js:795–802` (`snapshot()` embeds `data.text = textForBuffer(...)` for every leaf whose buffer ≠ focused); `spine.js:845–847` (`textForBuffer` returns the whole buffer string); push triggers: every model `onChange` (split/focus/tab/resize `setSplitRatio`), plus every `dataSources.setState` fan-out — `refreshBookmarkSource` (each bookmark op), `refreshCustomizeModels` (each customize edit), `relabelJukeboxes`.
- **Failure scenario**: A window split between `notes.md` (focused) and a 10 MB log/text file. Every splitter-drag ratio echo, every bookmark set/delete (fans PANE_TREE to *every* window showing the outline), every customize tweak re-serializes and re-posts the 10 MB string over the MessagePort. Structured-clone of multi-MB strings on the utilityProcess loop = visible stalls; nothing bounds it.
- **Fix direction**: Cache and version static-pane text (send `textRev` and omit unchanged text), or send static-pane text once via a dedicated message and let PANE_TREE reference the buffer id only.
- **Confidence**: CONFIRMED (payload path traced; magnitude asserted, not live-measured).

### SPINE-08: Command errors are invisible to the user; `*prefix-arg*` leaks across a throw

- **Severity**: P2
- **Dimension**: Correctness / UX (error surfacing)
- **Location**: `server.js:1085–1086` (`catch { console.error('intent error', …) }` — nothing sent to the client); `keymap.lisp:445–456` (`reset-keymap!` runs *before* the command — good — but `reset-prefix-arg!` runs *after*, so it's skipped on a throw); `spine.js:1995–1998` (`run-process!` on-exit failures also stderr-only).
- **Failure scenario**: Any Lisp `error` or JS primitive throw inside a command (e.g. a RefTeX scan on a malformed file, a user's init-defined command) → the key appears to do *nothing*; no echo-area message, no indication anything failed unless Godot was launched from a terminal. If a `C-u` was pending, it silently applies to the *next* command instead. Diagnosis of "my command doesn't work" becomes guesswork — the exact opposite of the Emacs contract.
- **Fix direction**: In `applyIntent`'s catch, `sendStatusTo(client, error.lispMessage ?? error.message)`; clear `*prefix-arg*` in `reset-keymap!` or wrap the run in the Lisp with an unwind.
- **Confidence**: CONFIRMED.

### SPINE-09: Window close leaks data-sources, ptys, and per-window registry views

- **Severity**: P2
- **Dimension**: Correctness / resource lifecycle
- **Location**: `spine.js:4758–4789` (`removeClientView` — drops only `kind === 'bookmark'` sources owned by the window); `buffer-registry.js:276–278` (`dropClient` deletes only the **numeric** key) vs `spine.js:877` (leaf views are keyed `c${index}-vk-N:bufferId`, strings); `spine.js:757` (`bookmarkEngines` never pruned on buffer kill), `spine.js:5772–5781` (`notebookScopes` never pruned); `runProcessChildren` never killed on shutdown.
- **Evidence**:
  ```js
  // removeClientView — shells/browsers/media of the closed window survive:
  for (const s of dataSources.list()) {
    if (s.kind === 'bookmark' && s._ownerClient === index) dataSources.remove(s.id);
  }
  ```
- **Failure scenario**: Open a shell in window 2; close window 2. The `shell` data-source stays in the global pool forever (it appears in every window's C-x C-b picker as a switchable `*shell*`); the pty in MAIN — reaped only by the *client* when the source leaves its open-set — has no client left to reap it → orphan process (the known process-reaping backlog, reconfirmed on main). Long sessions also accumulate: string-keyed views per closed window in every visited buffer's `views` map, one bookmark engine (with live markers) per *killed* buffer id, one notebook scope per closed notebook.
- **Fix direction**: In `removeClientView`, sweep the closed window's open-set: remove proc/browser sources not shown elsewhere (and signal MAIN to kill their ptys); make `dropClient` also delete keys matching `c${index}-`; delete `bookmarkEngines`/`notebookScopes` entries when their owner dies.
- **Confidence**: CONFIRMED (leaks traced; pty-orphan consequence PLAUSIBLE pending MAIN-side check, which is outside this area).

### SPINE-10: Cross-window minibuffer collision — the global prompt has no owner guard

- **Severity**: P2
- **Dimension**: Correctness (multi-window)
- **Location**: `commands.lisp:63–75` (`*minibuffer-reader*` single global, last-wins); `spine.js:1020` (`activePrompt` single global); `server.js:683–689` (`openMinibuffer` reassigns `minibufferClient` unconditionally); contrast `deliverPicker` (`spine.js:5654–5668`) which **does** guard with a minted `pickerId`.
- **Failure scenario**: Window A opens `M-x` (or `replace-string`'s first prompt); before submitting, a command in window B opens any prompt. B steals `minibufferClient` and overwrites `*minibuffer-reader*`; A's prompt closes on its next VIEW (it no longer owns the state) and A's suspended command silently never resumes. If A manages to submit in the race window, `handleMinibufferSubmit` resolves A's text against **B's** `activePrompt` semantics (e.g. A's replace-string text treated as B's find-file path). The picker channel already solved this shape with per-open ids — the minibuffer predates the fix.
- **Fix direction**: Mint a prompt id per `open-minibuffer!` (mirroring `pickerSeq`), carry it in the wire state, and drop submits/cancels whose id doesn't match; optionally refuse to open a second prompt while one is pending (Emacs's non-recursive-minibuffer default).
- **Confidence**: CONFIRMED mechanism; the harmful interleavings need two windows plus timing (plausible in daily multi-window use).

### SPINE-11: Static different-buffer panes go stale under cross-window edits

- **Severity**: P2 (display-only divergence)
- **Dimension**: Correctness (server/client state divergence)
- **Location**: `server.js:551–567` (`fanDelta` targets only clients whose **focused** buffer matches); `pane-model.js:795–802` (unfocused different-buffer leaves render from snapshot `text`).
- **Failure scenario**: Window 1 shows `a.md` (focused) + `b.md` (split, static text). Window 2 edits `b.md`. No delta reaches window 1 (its focused buffer is `a.md`) and no PANE_TREE re-push happens (no layout change) — window 1's `b.md` pane silently displays outdated content indefinitely, until some pane op or focus change forces a re-push/resync. The pane looks live but isn't; a user could read stale text and act on it.
- **Fix direction**: On `onBufferChange`, also re-push PANE_TREE (or a targeted static-pane refresh) to clients showing that buffer in a *non-focused* leaf — cheap if combined with the SPINE-07 text-versioning fix.
- **Confidence**: CONFIRMED.

### SPINE-12: `switchClientToBuffer`/`switchClientToSource` "restore active index" is a no-op — the kill re-home leaves the wrong window active

- **Severity**: P3 (real logic bug, effects masked by server-side rebinding)
- **Dimension**: Correctness / code health
- **Location**: `spine.js:4836–4840` and `4870–4874`.
- **Evidence**:
  ```js
  const wasActive = index === activeClientIndex;
  if (!wasActive) activeClientIndex = index;
  model.setFocusedBuffer(id);
  activeClientIndex = wasActive ? index : activeClientIndex; // reads the ALREADY-mutated value
  ```
  Both branches leave `activeClientIndex === index`; the intended restore never happens. Consequently the `if (index === activeClientIndex)` block below always runs — a *background* window's re-home (killBufferById's cross-window loop, `spine.js:5222–5229`) rebinds the interpreter to that window's buffer and leaves it there for the remainder of the dispatch (e.g. `applyIntent`'s `multiAfter = spine.activeCursorCount()` then reads the wrong view). server.js masks most of it (`onKillReHome` re-runs `setActiveClient`, and every next intent rebinds), so no user-visible corruption was traceable — but the code says one thing and does another.
- **Fix direction**: `const prev = activeClientIndex; … activeClientIndex = prev;` — or delete the dance if "switching a background window's buffer makes it active" is actually the desired semantics (then also drop the misleading ternary).
- **Confidence**: CONFIRMED (bug), effects PLAUSIBLE-only.

### SPINE-13: isearch lazy-highlight timer mixes the captured entry with the *current* active buffer

- **Severity**: P3
- **Dimension**: Correctness (race)
- **Location**: `spine.js:1635–1659` — the debounced rebuild captures `entry = activeEntry` at schedule time but reads `buffer.text` / `buffer.point` (module-level *active* binding) at fire time, 300 ms later.
- **Failure scenario**: C-s type… then within 300 ms switch buffer/window (C-x b, a picker choose). The timer fires with the *new* buffer's text/point but adds `isearch-lazy` overlays to the *old* entry at those foreign offsets — wrong highlights (markers clamp, so no crash) until the next isearch op clears them.
- **Fix direction**: Read `entry.buffer.text` / the captured view's point inside the timer, or cancel the timer on `setActiveClient`/buffer switch.
- **Confidence**: CONFIRMED.

### SPINE-14: `C-x C-r` is a dead binding server-side (`reload-stdlib` not loaded)

- **Severity**: P3
- **Dimension**: Architecture & consistency
- **Location**: `keymap.lisp:30` binds `C-x C-r → reload-stdlib`; the command is defined only in `system.lisp:28`, which is not in `SPINE_STDLIB`. The keymap-vs-defined-commands diff shows it is the **only** bound-but-undefined command (everything else in the keymap resolves server-side — a clean result).
- **Failure scenario**: `C-x C-r` → "reload-stdlib is not available here" (the handle-key guard, keymap.lisp:451–454, works as designed). Harmless but a dead key on a prime chord.
- **Fix direction**: Define a spine-side `reload-stdlib` (re-evaluate SPINE_STDLIB — genuinely useful for live keymap.lisp editing) or unbind it.
- **Confidence**: CONFIRMED.

### SPINE-15: `M-s o` accumulates `*Occur: X*<2>` buffers

- **Severity**: P3
- **Dimension**: Consistency / lifecycle
- **Location**: `occur.lisp:81` (`new-view! name` unconditionally) → `spine.js:1711–1716` (`new-view!` always `registry.add`) → `buffer-registry.js:96–102` (`uniqueName` appends `<n>`).
- **Failure scenario**: Run occur twice with the same pattern → two buffers (`*Occur: foo*`, `*Occur: foo*<2>`), growing per search; Emacs reuses the occur buffer. Pool clutter, C-x C-b noise.
- **Fix direction**: In occur.lisp, `(let ((v (find-view name))) (if v (switch-to-view! v) (new-view! name)))` + clear its text before refill (`set-buffer-text!`).
- **Confidence**: CONFIRMED.

### SPINE-16: `-emit-client-directive!` silently turns a boolean arg into `''`

- **Severity**: P3 (latent — no current Lisp emitter passes booleans)
- **Dimension**: Security & IPC (wire-shape hazard)
- **Location**: `spine.js:1415–1417`: `typeof v === 'number' ? v : symName(v) ?? lispString(v)` — `true`/`false` fall through both converters to `''`.
- **Failure scenario**: A future embedded command emits `(emit-client-directive! ids 'foo #t)` — the renderer receives `''`, a falsy-but-string value; the classic silent-directive-arg family. (The JS-side `onClientDirective` calls, e.g. `inline-eval-result`'s `true`, bypass this converter and are fine.)
- **Fix direction**: Add `typeof v === 'boolean' ? v :` to the chain.
- **Confidence**: CONFIRMED (behavior), latent (no live caller).

### SPINE-17: Reader escape map diverges from `JSON.stringify` — control characters corrupt minibuffer/picker delivery

- **Severity**: P3
- **Dimension**: Correctness (edge input)
- **Location**: `spine.js:5622–5632` / `5654–5668` (`deliverMinibuffer`/`deliverPicker` embed the value as `JSON.stringify(String(value))` inside Lisp source); `packages/lisp/src/reader.js:217` — the escape map is `{n,t,r,0,\\,"}` only; unknown escapes yield the raw letter.
- **Failure scenario**: A pasted prompt value containing `\f`/`\b`/other C0 controls: JSON emits `\f` or ``; the reader turns those into the literal letters `f` / `u000c` — the delivered string differs from what was typed (e.g. a replace-string replacement gains stray characters). No crash; hard to hit from the keyboard, reachable via paste.
- **Fix direction**: Either extend the reader map (`\f`, `\b`, `\uXXXX`) or deliver prompt values through a host-side mailbox primitive instead of source-splicing.
- **Confidence**: CONFIRMED (mismatch), edge-severity.

### SPINE-18: Wire strings are spliced into evaluated Lisp source (customize ops, RUN_COMMAND names)

- **Severity**: P3 (same-trust renderer; defense-in-depth)
- **Dimension**: Security & IPC
- **Location**: `spine.js:2883–2906` (`applyCustomizeChange`: `` `(custom-apply! (quote ${name}) (quote ${valueSrc}))` `` — `name`/`valueSrc` straight off the wire), `spine.js:3975/3990` (`customizeModel`: `sc.variable`/`sc.group` interpolated), `spine.js:5493–5495` (`runCommand`: `(run-command (quote ${name}))` — `INTENT.RUN_COMMAND.name` comes from menu clicks).
- **Failure scenario**: A compromised or buggy renderer (or a crafted CUSTOMIZE_CHANGED payload) containing `x)) (arbitrary-lisp) ((y` executes arbitrary Lisp in the spine — which has full Node powers (fs, spawn). Today renderer and spine are the same trust domain, and `NOTEBOOK_EVAL`/`REPL_EVAL` already run arbitrary code *by design*, so this is not an escalation — but these paths *look* like data plumbing and are actually eval, which will surprise a future sandboxing effort.
- **Fix direction**: Validate `name` against the defcustom/command registries before splicing (a `/^[a-zA-Z*-][\w*!?<>=-]*$/` gate costs one line); prefer `interpreter.call('custom-apply!', sym(name), …)` over source assembly where possible.
- **Confidence**: CONFIRMED (mechanism), risk assessment per current trust model.

### SPINE-19: Escaped backticks inside embedded-Lisp template comments

- **Severity**: P3
- **Dimension**: Architecture & consistency (playbook letter)
- **Location**: `spine.js:2579` (`(\`(define orig minibuffer-tab-complete)\`)`) and `spine.js:3158` (`` \`m\` ``), both inside the embedded-Lisp JS template literals, both in comments.
- **Failure scenario**: None today — `\`` is legal in a template and produces a literal backtick in a Lisp comment. But the playbook's rule is "zero backticks, even in comments", and these two train the eye to accept backticks there; an unescaped one added by analogy breaks the whole file (the historical trap).
- **Fix direction**: Reword the two comments to use `'…'` quoting.
- **Confidence**: CONFIRMED.

### SPINE-20: `persistLastSession` fsyncs the whole workspace store on every buffer switch and pane intent

- **Severity**: P3
- **Dimension**: Perf
- **Location**: `server.js:788` (end of every `resyncClientToCurrentBuffer`) and `server.js:1386` (every non-switching PANE intent, incl. each `resize` ratio echo); `atomicWriteSync` = temp + `fsyncSync` + rename.
- **Failure scenario**: A splitter drag or rapid tab cycling issues an intent per step → a synchronous fsync'd rewrite of `~/.godot/workspaces.json` per step, on the same thread that resolves keys. Not a correctness issue (the write is atomic and tolerant) but an easy jank source on slow disks.
- **Fix direction**: Debounce `persistLastSession` (e.g. 500 ms trailing), flushing on SIGTERM alongside the metadata flush.
- **Confidence**: CONFIRMED (frequency traced; renderer-side intent cadence for drags not verified — if the client only sends resize on mouseup this is milder).

---

## Architecture observations

- **The host-primitives object is clean.** 125 explicit string keys, zero duplicates (uniq -d), zero collisions with the spread-in `createBufferPrimitives` (52 keys) / `createLatexPrimitives` (7) / citation keys. The duplicate-key family that bit `markdown-preview!` has no current instances.
- **Stub inventory (Q1/Q3):** the only remaining spine stubs are *honest* ones — `start-regexp-search!` / `start-regexp-search-backward!` surface a status ("temporarily unavailable"), `math-preview!` is an intentional no-op (view-field-driven), `start-doc-search!` is a shadowed-safe no-op, `minibuffer-tab-complete` is a documented pass-through (TAB completes only in the find-file-family prompts, matching MODEL-B-DISPATCH.md). No silent stub is reachable from a SPINE_STDLIB command that I could find.
- **SPINE_STDLIB order is coherent and the comments match reality**: commands → editing → custom → indent → modes → faces/themes/highlight → keymap → …; load-order-sensitive pairs (faces before snippets/themes; keymap before multi-cursor/auto-pair/snippets-keymap; expand-region before multi-cursor; latex chain before reftex; reftex openers and `-latex-reveal-source` overridden **post-load**, which is correct since they only matter at command time). Not loaded (verified diff): `files/help/views/system/menus/palette/sticky-notes/tabline/utility-pane/view-menu/inline-eval/jukebox/directory-*/element-view*` — each either replaced by an embedded equivalent or renderer-owned; the keymap diff shows `reload-stdlib` as the sole dead binding (SPINE-14).
- **The embedded Lisp is disciplined**: all `emit-client-directive!` calls pass args flat; `\\n`/`\\"` escape levels are correct everywhere I checked (quit-walk prompts, apropos formatter, jukebox default template — which byte-matches the JS fallback default); `nil?` used throughout, zero `null?` in the file; recursion in `-quit-walk`/`-apropos-format`/`-add-match-overlays` is tail-positioned (TCO exists).
- **Model-B invariants hold** at the seams I traced: nothing raw-Lisp crosses a port (`lispValueToWire`, `configValueToJs`, `writeString`-sourced config pushes, JSON-string chrome payloads); the renderer is driven only by directives; keymap.lisp is the sole resolver, and spine.js's `handleKey` is a thin relay plus the snippet-hook shim (which correctly replaces the renderer-era per-edit host hook — the third of the "three ways broken" family, closed).
- **Two prompts, two designs**: the picker channel has per-open ids and stale-reply guards; the minibuffer (older) has neither (SPINE-10). Worth unifying on the picker's design.
- **Dead/vestigial code**: `pane-model.setFocusedPoint` has no production caller; `buffer-list-rows`'s data-source rows expose other windows' `*Bookmarks*`/customize leaves in the global C-x C-b picker (switching to another window's outline from a different window is possible and semantically odd); the `recoverBuffer` `'\0'` baseline trick is clever but a comment should flag it as the file's one intentional NUL *escape* (the NUL-byte history makes any `\0` here scary to future greppers).
- **`sendClientState`'s per-step guards** (server.js:745–761) are exactly the right degrade-not-freeze pattern — the same guard philosophy should extend to `broadcastView`/`resyncClientToCurrentBuffer` (SPINE-01's fix).

## Test coverage

- **`mwb/spine.test.js` (208 tests) is genuine, current coverage of `createSpine`**: key dispatch incl. chords and mid-chord aborts, self-insert, minibuffer round-trip/cancel/chained prompts, M-x flow, multi-client cursors and index reuse, the full quit walk (y/n/!/q/C-g + styled prompt), close-tab kill/un-curate/last-tab-collapse, media/directory/jukebox/element/browser/shell data-sources incl. serialize-restore round-trips, per-window buffer lists, pickers with stale-id drops, markdown-preview directives, screenful scroll, and — new since the hardening merge — **both restore-clamp tests** (shortened file, tabline tab). The playbook's "spine.js is not in the test suite" is stale; `apps/desktop`'s `node --test` picks it up, plus `spine-panes/undo-integration/save-integration/isearch/occur/snippets` suites.
- **What the suite does not touch** (the naked surface, where this audit's worst findings live):
  - **`server.js` in its entirety** — `applyIntent`'s post-intent fan-out ordering (the unguarded tail), `fanDelta` targeting, the RESYNC decision matrix, `handleMinibufferSubmit`'s prompt fork, restore orchestration (chooser, multi-window cascade, `pendingProjectWindow`), autosave/recovery wiring, metadata debounce+flush. Only manual selftests (env-gated) and `server-bridge-selftest.html` exist.
  - The **missing-file restore fallback** (SPINE-02) — the clamp tests cover shortened files only.
  - The **stale-live-cursor class** (SPINE-01) — no test drives an edit through one view and then reads `viewStateOf` for a second view whose point exceeded the new length.
  - The embedded **help family** (`describe-key`, `describe-command`, `apropos-doc`), `chromeDirectives`, `customizeModel`, `applyCustomizeChange`, `modeInfoFor`'s bind/restore, `reveal-source-pane!`, `loadProjectWindow`.
  - Unit tests stub host primitives (per CLAUDE.md), so the *bodies* of app.js-side directive handlers are never exercised here — as designed, but it means the FLAT-args contract is only enforced by convention plus the interpreter harness.

## What's solid

- **Atomic persistence**: `atomicWriteSync` (temp sibling + fsync + rename) is used for saves, custom.lisp, faces.json, metadata sidecars, workspaces.json, project.json, and recovery snapshots; `sweepStaleTemps` handles orphaned temps; metadata writes are debounced with a synchronous SIGTERM/exit flush.
- **`session-store.js`**: tolerant of missing/corrupt/hand-edited files (malformed → empty model, per-entry `isEntry` filtering), migrates the old flat shape, and the tmpdir→config-home store move landed with a non-destructive migration (main.js).
- **Durable pane identity (Q5)**: `serialiseLayout` persists leaf *and* split ids; `loadLayout` restores them verbatim and `bumpIdCounterPast` prevents collisions with later fresh mints; `visitFile` drops a stale `targetLeafId` that no longer resolves (fail-safe re-route to the editing leaf). The half-empty-split collapse and the guarded `applyNextRestoreWindow` make hand-edited/partial blobs degrade rather than throw.
- **The quit walk** is careful: dirty-list + pathless net, C-g/Escape leave no pending reader, failed saves still count in the final net, and `spine.test.js` covers all branches.
- **`run-process!`** — exactly-once callback discipline (sync-throw, async `error`, `exit` after `error` suppressed), no shell interpretation, and the on-exit is applied under try/catch.
- **Buffer/marker layer**: `moveTo`/`setMark`/`moveCursor` clamp; markers ride all mutations including undo/redo and collapse instead of dying; `add-overlay!` floors/orders its offsets and `createMarker` clamps, so Lisp can't create an out-of-range overlay.
- **Undo/cross-window resync (Q7)**: the late-bound `run-command` wrapper catches every dispatch path (key, M-x, menu, pane intents); the flag is read-*and-cleared* per intent so a no-op undo can't leak; multi-cursor edits and history ops force a full RESYNC to exactly the clients on that buffer.
- **Autosave logic** (apart from its directory): per-buffer atomic snapshots keyed to overwrite, `selectRecoverable`'s disk-mtime predicate, scratch filtering, startup dedupe by base name, consume-after-recover — all sound and unit-tested.
- **isearch highlighting** got the windowing/cap/debounce treatment and is the model SPINE-06 should copy.
- **`fanDelta`/`echoId` replication protocol**: per-buffer targeting, monotonic seq, echo only to the originator — clean; `sendClientState`'s per-step guards make the HELLO paint freeze-proof.
- **No duplicate keys, no spread shadowing, no `null?`, no unescaped backticks, `node --check` clean.**

## Open questions

1. Does an uncaught exception in an Electron `utilityProcess` port handler definitively exit the process (Node default) or does Electron intercept? Either terminal state is bad (dead server vs. permanently-throwing broadcast loop), but the exact failure mode of SPINE-01/02 needs one live reproduction.
2. Does the renderer throttle `resize` PANE intents to mouseup? Determines whether SPINE-20 (fsync per intent) and SPINE-07 (full-text per snapshot) are drag-frequency or click-frequency problems.
3. When a window closes with a live shell, does MAIN's shell.js reap the pty on `window closed` independently of the client's open-set diff? (SPINE-09's orphan-pty claim; MAIN is outside this audit's area.)
4. `M-x notebook-*` / REPL: confirmed by design that NOTEBOOK_EVAL runs arbitrary JS with full Node powers in the spine — is that acceptable long-term for *restored* notebooks (a hostile `.ipynb`-alike opened from disk still requires the user to run a cell, but the cell source is file content)?
5. The workspace chooser boots the seed as `''` `*scratch*` — after "start fresh", the empty scratch plus `seedWindow1Tabline` looks correct in tests; worth one live pass over "chooser → fresh → open file → quit → relaunch" to confirm no `*scratch*<2>` regression (the old bug family).

---

## Stats

- **Findings**: 1 × P0, 3 × P1, 7 × P2, 9 × P3 (20 total).
- **Files fully read**: `spine.js` (6103), `server.js` (2360), `buffer-registry.js` (390), `pane-model.js` (1076), `autosave.js` (264), `session-store.js` (176), `commands.lisp` (140), `view.js` (235); targeted reads in `keymap.lisp`, `buffer.js` (L2), `storage/buffer.js`, `reader.js`, `spine.test.js`, `main.js`, `app.js`, `server-bridge.js`, `occur.lisp`, `panes.lisp`.
- **Tooling checks**: `node --check` clean; primitive-key duplicate scan clean; spread-key collision scan clean; keymap-vs-defined-command diff → 1 dead binding.
