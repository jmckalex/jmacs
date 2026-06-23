# MWB Graduation — flipping the real app to the server/client model

> The plan to graduate the **proven** Model-B prototype (`apps/desktop/mwb/`,
> branch `multi-window-b`) from a flag-gated spike into the **real** app's
> architecture: one central Lisp server (an Electron `utilityProcess`) owning
> the interpreter + buffers + commands + session, with each window a thin
> rendering client driving the existing `view.js` from a replicated mirror.
>
> Companion to `plans/MULTI-WINDOW-MODEL-B.md` (the architecture + the bake-off),
> `apps/desktop/mwb/PRIMITIVE-SPLIT.md` (the model-vs-render primitive map), and
> `architect-notes.md` (the running prototype log). **This document is the
> file-level migration plan, not new architecture.** The architecture is
> decided and de-risked; what remains is sequencing the flip so the app is never
> left long-broken.
>
> Status: **plan only.** Nothing here is built. Read §0 for the verdict, §11 for
> the decision list, §12 for the honest effort assessment.

---

## 0. The verdict up front

Every existential objection to Model B has been retired with working code (see
`architect-notes.md`, eight slices over 2026-06-22):

- **Latency** is a non-issue — round-trip through the `utilityProcess` + the
  real interpreter is **~0.3 ms** (p99 < 0.6 ms); local echo is frame-identical
  to today.
- **The render refactor is a drop-in** — the real `view.js` renders + edits
  from a mirror with **ZERO `view.js` changes** (its buffer-read seam is 12
  synchronous members; the mirror reuses `@editor/storage` verbatim).
- **The command/keymap/minibuffer port is mechanical** — `commands.lisp` +
  `editing.lisp` + ~10 more stdlib files load **verbatim** and run server-side;
  M-x, find-file, the minibuffer, the mode-keymap chain, multi-buffer, real
  save (atomic) + autosave/recovery, and shared per-buffer undo all work
  through the wire. Two windows share one buffer in lockstep.
- **The safety floor exists** — a cooperative step budget bounds runaway
  computation (`packages/lisp`, branch `mwb-interrupt`); interactive `C-g` has
  a known (deferred) path.

**The remaining work is not research — it is a port.** The cost is concentrated
in four places, all enumerated below: (1) the **measurement conversation**'s
hard direction (§5d of the spec), (2) the **pane/tabline geometry** negotiation,
(3) the **render-side picker UIs** (buffer list, `*Recover*`, completions, the
utility pane, RefTeX panels), and (4) the **`C-g` worker-thread** refactor. None
is a landmine; each is a slice with a clear shape.

My recommendation (§12): **do not flip the real app yet.** Build **two more
structural prototype pieces first** — the *pane/window model* (the server's
logical pane tree + the client's geometry negotiation) and *one render-side
picker* (the buffer list, as the template for all the others) — because those
are the only two unknowns whose *shape* the prototype has not yet pinned. Once
those exist, the flip is a long but legible port with no surprises left.

---

## CURRENT STATUS (2026-06-23) — most of this plan is BUILT; the leaf-flip is the live frontier

§0's "plan only, nothing built" is now historical. Since 2026-06-22:
- **G0–G3 are done**, plus an overnight build (5 waves) and a morning of fixes.
  Flag-on (`GODOT_SERVER=1`) is **genuinely usable via the G2 overlay**: typing,
  auto-pair, prefix chords, the minibuffer (M-x / find-file), `C-x b`, screenful
  scroll, the full keymap, the LaTeX chain, and citations/RefTeX. Flag-off is
  byte-for-byte; suite green. See `MWB-STATE.md` (state + test checklist) and
  `architect-notes.md` (every wave + finding).

**THE LIVE FRONTIER — the leaf-flip (retire the G2 overlay).** G2 routes a window
via a full-bleed **overlay** (`g2HostEl`) stacked over the idle in-renderer
editor; the flip makes the real leaf's view BE the server mirror and deletes the
overlay.

- **Step A FAILED + was reverted** (`1a66d88` → `9288f2c`). Approach: "mount the
  mirror `<text-view>` into the real pane element." Result: empty editor — the
  in-renderer pane render loop (`elementForViewInstance` → tabline-view +
  warehouse; `syncPaneElements` ~`app.js:723`) re-resolves `leaf.view` to its own
  element and re-mounts it, **evicting the foreign mirror**. A foreign append
  cannot beat the render loop.
- **CORRECT APPROACH (do next):** make **`leaf.view` resolve TO the mirror** — a
  server-backed View handle whose `elementForViewInstance` (`app.js` ~4680)
  returns the mirror `<text-view>` — so the EXISTING tabline/warehouse/sync render
  shows it with no fight. A designed change to the view-resolution layer + the
  View-handle shape, NOT a foreign append. GUI-shaped: verify in the live app
  (boot-tests only confirm no-crash).
- After it: **Step B** (splits/multi-pane — each leaf its own mirror off the
  server pane tree), then **G5** (flip the default + delete the dead in-renderer
  interpreter path).

Deferred slices (don't block the leaf-flip): `read-next-key` live delivery
(isearch + math `` ` ``); the completing-minibuffer slice (find-file TAB / M-x
completion); the \*Recover\* picker UX. See `architect-notes.md`.

---

## 1. Target architecture, mapped onto the real files

The split is the same one `PRIMITIVE-SPLIT.md` defines, now applied to concrete
modules. Three columns: **MOVES to the server**, **STAYS in the client**,
**SPLITS** (the primitive-split — model half server-side, render half a wire
message). Line references are to the current `multi-window-b` tip.

### 1.1 MOVES to the server (`utilityProcess`, a Node child)

| Real module / concern | Today | Under Model B |
|---|---|---|
| `createInterpreter` + global env | `app.js:3467` | The server owns the one interpreter. The prototype already does this (`spine.js createSpine`). |
| `@editor/storage` (L1) + `@editor/buffer` (L2) — text, markers, overlays, modes | imported into the renderer | The canonical buffers live in the server's `buffer-registry.js`. Each is a real L2 buffer. |
| The kill ring / registers / `*last-command*` | interpreter state in the renderer | Interpreter state in the server (shared by construction). |
| `createBufferPrimitives` | `app.js:3470` | Server-side, unchanged (`PRIMITIVE-SPLIT.md` "Buffer/editing — model"). |
| The `defcommand` / `run-command` / keymap dispatch + the minibuffer state machine | `dispatchKey` `app.js:5713`, `interpreter.call('handle-key', key)` `:5733`, `keymap.lisp` | The server resolves keys through the real keymap chain (`spine.js handleKey` + `resolveModeBinding`). The client forwards key-strings as intents. |
| The **logical** buffer/view/pane model (which buffer shows where, the buffer list, splits *as structure*) | `views[]` `:260`, `rootPane` `:653`, `currentViewIndex` `:261` | The server owns the logical model (`buffer-registry.js` + a new server-side pane model — see §1.3, the gap). The *pixel geometry* stays client-side. |
| Session / project state | `session.js`, `project-index.js`, `project.lisp`, `activeProjectPath` `:774`, `projectSession` `:776` | The server owns the session model; it persists via its own direct fs (no IPC). |
| File **I/O** — read/write (atomic), directory listing, recovery/autosave, `run-process!`, shell/gnuplot spawn | `files.js` (1055 lines, ~40 IPC channels), `preload.mjs` host bridge | The server is a Node child: it does this **directly**, no IPC hop. `atomic-write-sync.js` + `autosave.js` already prove the save/recovery half. The long-lived shell/gnuplot/process spawns move server-side (they're already child-process plumbing). |

### 1.2 STAYS in the client (each window, its own renderer/V8/DOM)

| Real module | Why it stays |
|---|---|
| `packages/renderer/src/view.js` (2110 lines) + everything it drives | Rendering, tree-sitter highlight, folding, **all pixel measurement** (`getBoundingClientRect`, `scrollTop`/`clientHeight`, the `firstRow`/`lastRow` virtualization window), morphdom, replaced-range widgets. Renders from the **local mirror** (`client-buffer.js`), proven with zero changes. |
| Input capture + normalisation | The window-level `keydown` router (`app.js:5792`) + `keyEventToString` produce the key-string the client sends up. |
| The DOM of every render-side widget | `minimap-view.js` (968), `directory-tree-view.js` (611), `tabline-view.js`, the splitter, the math-preview replaced ranges, the picker panels (`reftex-select-panel.js` 442, `reftex-cite-panel.js` 507, `completions-panel.js`, the project chooser). |
| A **local mirror** of each displayed buffer + this window's window-state (point/mark/scroll/cursor-set) | `client-buffer.js` — the proven mirror. |
| The system clipboard + native dialogs | Clipboard stays client/main (`preload.mjs clipboardReadText/WriteText`); native pickers stay in main (only main shows them). The server requests them via a render/main hop. |

### 1.3 SPLITS — the primitive-split, generalised from the prototype's map

Each of these is one host primitive (or family) that has a **model half** the
server provides and a **render half** the client executes via a wire message.
`PRIMITIVE-SPLIT.md` is the authoritative table; this is the by-real-file view.

| Concern | Model half (server) | Render half (client message) | Status |
|---|---|---|---|
| Echo area / status | `show-status!`/`clear-status!` set the string | `VIEW` message carries it | **wired** |
| Minibuffer | the prompt + the suspended-command continuation (`open-minibuffer!`, `minibuffer-delivered`) | the client paints the prompt + collects input; submit/cancel come back as intents | **wired** (single global prompt) |
| Recenter / follow-cursor | server picks the line (it knows point) | client does the pixel scroll (`scroll` request) | **wired** (the *easy* §5d direction) |
| Scroll-by-screenful (`scroll-up`/`page-down`/`window-start`) | server owns the scroll *decision* | client must report viewport geometry **UP** (lines-per-screen) | **GAP — the hard §5d direction** |
| Customize | the registry (`defcustom`, `custom-value`, `*tab-width*`) runs server-side | `open-customize!` opens a render-side panel | model **wired**; panel **stub** |
| Modes | `modes.lisp` + the keymap chain run server-side | `register-mode-menu!`'s *rendering* is client-side | model **wired**; menu render is a slice |
| Kill ring / yank | the ring is shared interpreter state | `clipboard-set-text!`/`clipboard-text` round-trip to the OS clipboard (client/main) | ring **wired**; OS-clipboard sync **stub** |
| Buffer list | the registry owns which buffers exist + each window's current buffer | the *View List* table is a render-side picker | data **wired** (`BUFFER_LIST`); **picker UI is a stub** |
| Overlays / multi-cursor | per-buffer overlays + per-client cursor sets are model state | `view.js`'s `getDecorations()`/`getCursors()` paint them | **wired** end-to-end |
| Undo / redo | server-side, shared per-buffer history | a grouped undo `RESYNC`s the mirror | **wired** |
| Save / autosave / recovery | direct atomic fs write + snapshot timer | the `*Recover*` picker is render-side | save+autosave **wired**; **picker UI is a stub** |
| Pane geometry / splits / tabline | the server owns the *logical* tree (view↔pane) | the client owns the *pixel* layout (split ratios, the splitter, tab strip) | **GAP — unbuilt; needs a two-way negotiation** |
| isearch / regex-search | a server search state machine | a client highlight overlay + the minibuffer loop | **stub** (commands resolve; the interactive loop is unbuilt) |
| Math/markdown preview, element views | the toggle commands + model state | the iframe/MathJax/custom-element rendering | **stub** (commands resolve; rendering is a render-message) |

---

## 2. The protocol surface the real app needs

The prototype's `protocol.js` already defines the load-bearing core. What the
real flip adds is enumerated here so the wire is designed once, not grown
ad-hoc.

### 2.1 Already defined (reuse verbatim)

- **Up:** `HELLO`, `INTENT` (`SELF_INSERT`, `DELETE_BACKWARD`, `POINT`, `KEY`,
  `MINIBUFFER_CHANGE/SUBMIT/CANCEL`, `SWITCH_BUFFER`).
- **Down:** `SNAPSHOT`, `DELTA` (the L1 `{start,removed,inserted}` change shape
  — no new encoding), `CURSOR`, `VIEW` (point/mark, modeline string, status,
  minibuffer, the `scroll` request), `OVERLAYS`, `CURSORS`, `RESYNC` (the
  lossy-edit / grouped-undo path), `BUFFER_LIST`.
- The pure helpers: `applyDelta`, `predictSelfInsert/DeleteBackward`,
  `renderModeline`, `normaliseOverlay/Cursors`, `overlaysToDecorations`.

### 2.2 Still missing (design these as part of the flip)

1. **The measurement conversation, hard direction (§5d).** Today everything
   the client measures stays client-side. The gap is the round-trip for a
   command whose decision *needs* this client's pixels:
   - Add an up-message `VIEWPORT` (or fold it into a periodic part of `HELLO`/
     resize): `{ linesPerScreen, firstVisibleLine, lastVisibleLine, lineHeight }`
     — sent on resize, scroll-settle, and on demand.
   - `scroll-up`/`scroll-down`/`recenter`/`move-to-window-line` then have what
     they need: the server computes the new `window-start` line from the
     client's reported screenful and replies with a `scroll` request (already
     defined). Keep it line-based, never pixel-based, so wrap stays the
     client's business.
   - This is the one genuinely fiddly piece. Prototype it (see §12).

2. **Pane/window structural messages.** The buffer list is `model`, but the
   pane *geometry* is a negotiation:
   - Down: `PANE_TREE` — the logical tree (which view in which leaf, split
     orientation), without pixel ratios. The client lays it out.
   - Up: `PANE_INTENT` — `split`, `delete-pane`, `swap`, `focus-pane`,
     `resize` (ratios the client chose). The server updates the logical model;
     the client owns the splitter drag + the pixel ratios (persisted in its
     own `panes:write` equivalent, or echoed up for the session).
   - Tabline: the *which tabs / active tab* is `BUFFER_LIST`-shaped per pane;
     the strip's DOM + reorder/close is render-side, emitting `PANE_INTENT`s.

3. **Generic render-side picker channel.** The buffer list, `*Recover*`,
   completions, and the RefTeX/cite panels are all the same shape: *the server
   holds rows of data; the client renders a list; a selection comes back up*.
   Define **one** reusable pair:
   - Down: `PICKER` — `{ id, kind, title, rows: [{label, meta, value}], mode }`.
   - Up: `PICKER_RESULT` — `{ id, value | cancelled }`.
   The server already owns the data for every one of these (it owns buffers,
   recovery snapshots, the command registry, the RefTeX DB). This single channel
   collapses five render slices into one mechanism + five row-providers. **This
   is the highest-leverage new protocol piece** — design it carefully.

4. **Native-dialog / clipboard hop (server→main→client).** `file:open` (native
   picker), `clipboard-*`, `reveal-in-folder`, `pick-project-image`,
   `save-svg`: the server can't show a dialog. Add `HOST_REQUEST` (server→main,
   over `parentPort`) / `HOST_REPLY`. Main does the native thing and replies.
   This inverts today's renderer→main IPC into server→main, but the operations
   are the same; `files.js`'s dialog handlers move behind it.

5. **Lifecycle / reconnect.** `SERVER_READY`, `CLIENT_DETACH` (on window
   close — the prototype's `registry.dropClient` exists + is tested but unwired),
   and a `RESUME` path for a respawned server / a reconnecting client (re-`HELLO`
   + full re-sync of every buffer the client was showing). The data path is the
   `SNAPSHOT`/`RESYNC` we already have; the *orchestration* is new.

---

## 3. The migration order — staged, never long-broken

The guiding rule: **the existing in-renderer app stays the shipping default
until the server path is at parity**, gated behind a flag, and the flip is a
single config switch we can revert. The prototype already proves we can run the
server path *beside* the real renderer without touching production code.

### Phase G0 — Two structural prototypes (the only remaining unknowns)

Before any production change, build the two pieces the prototype hasn't pinned
(§12). These live under `apps/desktop/mwb/` like the rest, flag-gated.

- **G0a — the pane/window model.** Add a server-side logical pane tree
  (`@editor/pane` runs in the server) + the `PANE_TREE`/`PANE_INTENT` wire +
  a client that renders 2-4 panes from it and drives splits/swaps. Reuse the
  real `@editor/pane` tree ops (they're pure, no DOM).
- **G0b — the generic picker.** Build the `PICKER`/`PICKER_RESULT` channel and
  render the **buffer list** through it (the existing stub becomes real). This
  is the template every other picker copies.

**Exit:** both demoed headlessly + by hand through the mwb harness; two windows
with independent pane layouts over a shared buffer set; the buffer-list picker
selects + switches. **Decision gate:** if the pane negotiation or the picker
channel turns out worse than expected, re-open the A-vs-B question *here*, before
touching production. (It won't — but this is the honest last checkpoint.)

### Phase G1 — Stand the server up inside the *real* main process

Fold the prototype's `launch.js` topology into `apps/desktop/src/main.js`
behind a flag (`GODOT_SERVER=1`), **without** removing the in-renderer path.

- `main.js` (currently 194 lines) gains: fork the server `utilityProcess`,
  create a `MessageChannelMain` per window, transfer ports (the prototype's
  exact dance, `launch.js:188-192`).
- The server module graduates from `mwb/server.js` to a real
  `apps/desktop/src/server/` directory (see §4 reuse map).
- With the flag **off**, `main.js` behaves exactly as today. With it **on**, it
  forks the server but the renderer still boots the old way (the server is just
  *present*). No behaviour change yet.

**Exit:** `GODOT_SERVER=1` boots the app, forks the server, suite green with the
flag off (default). The app is byte-for-byte unchanged in the default config.

### Phase G2 — Route one window/buffer through the server behind the flag

Make the real renderer, when `GODOT_SERVER=1`, mount **one** `view.js` on a
`client-buffer.js` mirror instead of a live buffer, for a single buffer.

- In `app.js`, behind the flag, the active text view's `createEditorView`
  `buffer` argument becomes a mirror; `onKey` forwards key-strings as intents
  (the existing `dispatchKey` becomes "send a `KEY` intent" in server mode).
- `loadStdlib` does **not** run in the renderer in server mode — the server
  loads the stdlib. The renderer's job shrinks to rendering + input.
- Save, undo, M-x, find-file, the minibuffer all already work through the
  prototype's server; this phase is wiring the *real* renderer's `view.js` +
  minibuffer + modeline DOM to the same messages the harness uses.

**Exit:** with the flag on, a single window edits one buffer through the server
— type/motion/M-x/find-file/save/undo all work, typing feels native, and the
**flag-off path is untouched and still the default.** This is the first moment
the *real* app runs on the server; it is reversible and not yet shipping.

### Phase G3 — Widen coverage via the primitive-split (the long middle)

Port the stdlib file-by-file in the canonical `STDLIB_FILES` order
(`packages/stdlib/src/index.js:28-185`), using the `PRIMITIVE-SPLIT.md` recipe
for each. This is mechanical and incremental — the app is usable throughout
because each file either works server-side or its commands resolve to a
documented stub. Group the order into waves (§6 maps each feature to its split
verdict):

- **Wave A (model-clean, mostly done in the prototype):** `commands`, `editing`,
  `custom`, `indent`, `files`, `views`, `kill`, `yank-pop`, `line-ops`, `occur`,
  `expand-region`, `system`, `modes`, `multi-cursor`, `markdown`, `search`
  (commands), `regex-search` (commands). Most already load in `spine.js`.
- **Wave B (needs a render message slice each):** `faces`/`themes`/
  `highlight-rules` (the registry is model; the live CSS apply is a client
  message), `keymap` (model, but mode-menu render is client), `snippets*` (the
  field *decorations* ride `getDecorations`, already proven; the engine is
  model), `auto-pair`, `menus`/`view-menu`, `palette`, `inline-eval`, `folding`
  (fold ranges are client; the toggle command is model), `bookmarks` (markers
  are model; the bookmark *view* is a picker), `sticky-notes`.
- **Wave C (the heavy / async / picker-bearing):** `latex*` + `reftex*` + `cite`
  (process-spawning + the select/cite **picker panels** ride §2.2's `PICKER`),
  `utility-pane`/`shell`/`gnuplot`/`notebook` (child processes move server-side;
  the xterm/output DOM stays client), `math-preview`/element-views (render-
  message), `directory-tree`/`directory-columns`/`minimap`/`tabline`/`panes`
  (pane-geometry + render widgets), `project`/`docs`/`help`/`face-info`.

**Exit (per wave):** every command in the wave's files either runs correctly
server-side or resolves to a *documented* stub with no crash; a headless
self-test drives one command per file through the server; the flag-off path
still green. **Exit (phase):** feature parity with the in-renderer app at the
flag, with the only stubs being the genuinely-deferred ones (interactive
isearch loop, the few preview iframes) tracked in `architect-notes.md`.

### Phase G4 — Multi-window + the payoff

Turn on N windows (the prototype's `MWB_CLIENTS=2` path, now in real `main.js`):
window registry + focus in main, `window:new/close/focus`, per-client window-
state over shared buffers, deltas fanning out. The same-buffer-in-two-windows
feature falls out (already proven in the prototype). Wire `CLIENT_DETACH` on
window close (`registry.dropClient`).

**Exit:** open two windows; show one buffer in both; edit in one, watch the
other update; close a window and the buffers live on. Cross-window commands
(`window-eval`, move-view) work because there's one env.

### Phase G5 — Flip the default, retire the old path

Once parity holds and has lived through real use (the architect's daily driver
for a week), make `GODOT_SERVER=1` the default, then **delete** the in-renderer
interpreter path from `app.js`: the `createInterpreter` block (`:3467`), the
in-renderer `loadStdlib` (`:5580`), and the host-primitive registrations that
moved server-side. `app.js` shrinks from ~10,800 lines to a rendering+input
client; the host primitives become the server's primitive surface.

**Exit:** the app boots only on the server path; the flag is removed; the dead
in-renderer interpreter code is gone; smoke harness updated to stand up the
server (§8 risks). Tag `pre-mwb-flip` before the deletion commit.

---

## 4. Reuse vs rebuild

### 4.1 `mwb/` code that becomes the real server/client basis (reuse)

| Prototype file | Becomes | Reuse verdict |
|---|---|---|
| `protocol.js` | `apps/desktop/src/shared/protocol.js` (shared by main/server/preload) | **Reuse near-verbatim.** Add the §2.2 messages. The L1-delta-as-wire-delta insight is load-bearing and stays. |
| `client-buffer.js` | the renderer's mirror | **Reuse verbatim.** It reuses `@editor/storage`; the real `view.js` already renders from it unchanged. |
| `spine.js` (createSpine — the command machinery) | the heart of `src/server/spine.js` | **Reuse, then grow.** It already loads ~16 stdlib files verbatim, runs `run-command`/keymap chain/minibuffer. Wave-B/C files extend it. |
| `buffer-registry.js` | `src/server/buffer-registry.js` | **Reuse verbatim.** Multi-buffer, per-client views, per-buffer overlays, dirty tracking — all there. |
| `server.js` (intent loop, fan-out, save, autosave) | `src/server/index.js` | **Reuse the loop; replace the harness bits.** The `applyIntent` reconciliation (delta vs RESYNC vs CURSOR), `fanDelta`, the minibuffer routing all graduate. Strip the `*_SELFTEST` blocks. |
| `atomic-write-sync.js`, `autosave.js` | `src/server/` | **Reuse verbatim** — already mirror production `files.js`/`recovery.js`. |
| `view-client.js` | folds **into** `app.js`'s render path | **Reference, don't copy.** It proves the mount; the real client is `app.js` mounting `view.js` on the mirror. |
| `launch.js` | folds **into** `main.js` | **Reference.** The fork + `MessageChannelMain` + port-transfer dance is the template; the real version lives in `main.js`. |
| `preload.mjs` (mwb) | merges with real `preload.mjs` | **Reference.** The port re-dispatch is ~10 lines; add it to the real preload. |

### 4.2 What must be built fresh

- **The server-side pane/window model** (G0a) — `@editor/pane` runs server-side
  but the *negotiation* with each client's geometry is new.
- **The generic `PICKER` channel + row-providers** (G0b) — new mechanism; the
  five existing picker DOMs (`reftex-select-panel.js`, `reftex-cite-panel.js`,
  `completions-panel.js`, the buffer list, `*Recover*`) become render-only
  consumers of it.
- **The `HOST_REQUEST` server→main hop** for native dialogs/clipboard — new,
  but mechanical (it inverts existing IPC).
- **The measurement-conversation hard direction** (`VIEWPORT` up-message) — new,
  fiddly, prototype-worthy.
- **Server respawn / client reconnect orchestration** — new lifecycle code in
  `main.js` (the data path reuses `SNAPSHOT`/`RESYNC`).
- **The interactive isearch state machine + regex-search overlay** — deferred;
  genuinely render-coupled (see §6).
- **The `C-g` worker-thread eval** — deferred; see §7 + the SAB finding.

---

## 5. The measurement conversation (the one subtle protocol piece)

Called out separately because it is the only piece the prototype deliberately
left unbuilt in its hard direction, and getting it wrong produces janky scroll.

- **Easy direction (built):** server knows point → "scroll so point is centred"
  → client does pixels. `recenter!` already works this way.
- **Hard direction (build in G0/G3):** `scroll-up` advances `window-start` by
  "one screenful" — a quantity only the client knows (it depends on wrap + line
  height + viewport height). The client must report it.

Design: the client sends `VIEWPORT { linesPerScreen, firstVisibleLine,
lastVisibleLine }` on scroll-settle + resize + on a server "measure" request.
The server keeps the latest per client and computes scroll decisions in **line**
space; the client translates lines→pixels (it owns wrap). Never send pixels over
the wire. This keeps wrapping entirely client-side (where the measurement lives)
while the server makes the *decision* (where point lives). It is bounded — a
handful of commands (`scroll-up/down`, `move-to-window-line`, `recenter` with an
arg) — not pervasive.

---

## 6. How the big existing features graduate (per-feature verdict)

Against the primitive-split litmus (*could two windows on one buffer legitimately
disagree about the answer?*):

| Feature | Files | Verdict | Why |
|---|---|---|---|
| **Project / session** | `session.js`, `project-index.js`, `project-chooser.js`, `project.lisp` | **Rides the split cleanly (model) + one picker.** The session/project model is shared state the server owns + persists via direct fs. The project-chooser modal is a render-side picker (its own DOM, fed `PICKER`-style data). |
| **Pane tree + tablines + splits** | `panes.lisp`, `tabline.lisp`, `app.js:653-1610`, `splitter.js`, `tabline-view.js`, `add-pane-mode.js`, `move-view-mode.js` | **Genuinely hard — needs the pane negotiation (§2.2.2).** Logical tree is model; pixel geometry is per-client render state. The split/swap *commands* are model; the splitter drag + ratios + the tab strip DOM are client. This is the biggest structural gap → G0a. |
| **Minibuffer / completions** | `createMinibuffer`, `app.js:2759`, `completions-panel.js`, `palette.lisp` | **Mostly wired + the completions picker.** The prompt round-trip works. Completions (find-file TAB candidates) become a `PICKER`. Multi-prompt is single-global today (fine); per-client prompts are a later refinement. |
| **LaTeX / RefTeX** | `latex*.lisp` (~3300), `reftex*.lisp` (~1800), `latex-compile`/`synctex`, `reftex-select-panel.js`, `reftex-cite-panel.js`, `math-segments.js` | **Needs slices, but rides well.** The *model* (the multi-file DB, label/section parsing, the insertion commands) is pure Lisp over buffers → server-side, and the **process-spawning** (`latex-compile`) *simplifies* server-side (direct child process, no IPC). The **select/cite panels** are `PICKER` consumers. SyncTeX inverse-search (Option-click → server) is a `HOST_REQUEST`/intent. The math-preview replaced ranges stay render-side. Heavy but legible. |
| **Bookmarks** | `bookmarks.lisp`, `bookmarks.js`, `bookmark-relocate.js`, `bookmark-view.js`, `bookmark-outline.js` | **Rides the split (markers=model) + a picker + the sidebar view.** Bookmark positions are L2 markers (model, edit-tracked) — shared and correct by construction. The bookmark list/outline is a render-side view fed model data. |
| **Snippets** | `snippets*.lisp` (~1350), field decorations in `view.js` | **Rides cleanly.** The engine + parser are pure Lisp over buffers (model); the field/mirror **decorations** ride `getDecorations()` — already proven over the wire. Multi-cursor name-mirror (C-c @) is model. |
| **Multi-cursor** | `multi-cursor.lisp`, `getCursors()` in `view.js` | **Wired.** Per-client cursor sets sync via `CURSORS`; secondary carets paint via `getCursors()`. A multi-caret edit `RESYNC`s. Proven end-to-end + cross-window. |
| **Utility pane (REPL/shell/compile)** | `utility-pane.lisp`, `utility-dock.js`, `repl.js`, `shell-view.js`, `output-panel.js` | **Needs a render-message slice; child processes move server-side.** The shell/gnuplot/process **spawns** move to the server (Node child — simpler). The xterm.js terminal + output DOM stay client; stdout/stderr stream down as messages. The REPL eval already operates on the live world (the server *is* the world — a Model-B win: a REPL in any window sees everything). |
| **Themes / faces** | `themes.lisp`, `faces.lisp`, `highlight-rules.lisp`, `face-info.lisp`, `face-styles.js`, `face-overrides.js` | **Rides cleanly (model) + a CSS-apply message + the face-picker.** The registry + a `defface`/theme/override change is model state → instantly global (a Model-B win, no broadcast needed). The generated CSS is applied per-client via a `VIEW`/`FACES` message. The face-picker (C-h F) is a render-side view + `PICKER`. |
| **Directory-tree / minimap** | `directory-tree.lisp` + `directory-tree-view.js` (611), `minimap.lisp` + `minimap-view.js` (968) | **Render-side views fed model data.** Directory listing is server-side fs (direct). The minimap renders from the same mirror text (pure function of text, like the main view) — no new data, just another client render of the mirror. |

---

## 7. The `C-g` / interruption story

The **safety floor is done**: `setStepBudget(n)` (branch `mwb-interrupt`,
`packages/lisp`) bounds runaway/infinite computation with no external signal — a
`(while #t)` throws `LispInterrupt` after N trampoline bounces, so the shared
server can't *permanently* hang. This is the mandatory piece and it exists.

The **interactive `C-g`** (abort a long-but-finite command on demand) is
**deferred** with a known path. The SAB finding (`architect-notes.md`
2026-06-22 ~14:00) is decisive: **`SharedArrayBuffer` does NOT cross the
`utilityProcess` boundary** (`postMessage(sab)` throws "could not be cloned").
So the planned client-`Atomics.store` / server-`Atomics.load` flag is not viable
between renderer/main and the server process.

The path: run the interpreter on a **Worker thread inside the server process**.
SAB shares across threads within one process, so the server's main thread (free,
because eval runs on the worker) receives the `C-g` message, sets the SAB flag,
and the worker's eval polls it via the existing `setInterruptCheck`. This is a
real refactor (eval → worker thread) and is a **refinement, not on the critical
path** — ship the step budget as the v1 mechanism; do the worker thread when
interactive `C-g` becomes a felt need. **Do not** spend more time trying to make
SAB cross the process boundary directly.

---

## 8. Risks, unknowns, and the honest hard parts

In rough order of residual risk:

1. **Pane/tabline geometry negotiation (§2.2.2, §6).** The biggest *unbuilt*
   piece. Today `app.js` interleaves the logical tree (`rootPane`, `views[]`)
   and the pixel layout in ~1000 lines (`:653-1610`). Splitting "which view in
   which leaf" (server) from "how many pixels wide" (client) is the one place
   the prototype's clean drop-in story has *not* been demonstrated. **Mitigation:
   G0a prototypes it before any production change.**

2. **The render-side picker UIs.** Five of them (buffer list, `*Recover*`,
   completions, RefTeX select, cite) plus the project chooser and face picker.
   Each works today against the in-renderer interpreter synchronously; over the
   wire they need the async `PICKER` round-trip. **Mitigation: one generic
   channel (§2.2.3) built once in G0b; the rest are row-providers.** The risk is
   under-designing the channel and growing seven bespoke ones.

3. **The long half-working middle (the spec's named fear, §8).** G3 ports ~85
   stdlib files; a mid-port state where half run server-side and half don't is
   inherently fragile. **Mitigation: the flag.** The in-renderer path stays the
   default and shipping until G5; the server path is opt-in and incremental;
   every wave keeps the flag-off suite green. The app is never *only* on the
   half-ported server.

4. **`C-g` worker-thread refactor (§7).** Deferred but real. Eval-on-a-worker
   touches the interpreter's hot path; it's the one piece that reaches back into
   `packages/lisp`. **Mitigation: the step budget covers safety today; defer the
   interactive abort until it's felt.** Low *risk* (path known), real *effort*.

5. **Crash/respawn UX.** A server crash takes every window's editing with it
   until respawn + re-sync. The data is safe (server-side autosave/recovery,
   proven), but the *UX* of "server died, reconnecting…" across N windows is
   unbuilt. **Mitigation: the recover-on-startup path already runs on every boot
   = the respawn path; the orchestration (re-HELLO + re-sync) reuses existing
   messages.** Medium effort, low data-loss risk.

6. **The smoke/screenshot harness.** Already can't boot the app (no preload);
   under Model B it must stand up the server too. **Mitigation: the mwb
   self-tests are the new model — headless, server-driven; port the smoke arm to
   that shape.**

7. **The toolbar (off-branch).** A programmable toolbar (the Conn) exists on an
   unmerged `toolbar` branch — **not visible from this worktree**. It assumes the
   renderer owns the interpreter + buffers (`define-toolbar-item`, Spine/Lens/
   Vitals/Command-field). It **must graduate too**: the `define-toolbar-*`
   collectors run server-side (model — they're registries + live eval), while
   `renderActions`/`renderLens`/`renderSpine` stay client-side rendering from
   pushed data. Flag it now; it's a Wave-B/C feature when the branch merges. The
   Command field's "pure-only ghost-preview" eval is a natural fit for the
   shared server REPL.

8. **Persisted-data shape changes.** The session/pane/faces/project on-disk
   formats are owned by the renderer today (via IPC); moving ownership to the
   server must preserve the on-disk shape (the no-backward-compat rule has its
   **one exception** for persisted data — migrate, don't break). Low risk if the
   server reuses the same JSON schemas `files.js` writes today.

---

## 9. What the prototype already retired (so this plan doesn't re-litigate)

- Latency (Phase 0): ~0.3 ms round-trip. **Not a risk.**
- view.js render-from-mirror: **zero changes.** Highlighting/folding are pure
  functions of mirror text. **Not a risk.**
- Command/keymap/minibuffer/mode-chain port: **mechanical**, ~16 files run.
- Multi-buffer + per-buffer delta scoping: **done.**
- Real save (atomic) + dirty tracking + server-side autosave/recovery: **done.**
- Shared per-buffer undo/redo (+ grouped-undo RESYNC): **done.**
- Overlays + multi-cursor over the wire, cross-window: **done.**
- The step-budget safety floor: **done** (branch `mwb-interrupt`).

---

## 10. File-level change map (the concrete diff surface)

When the flip lands, these are the files that change and how:

- **`apps/desktop/src/main.js`** (194 → ~350): fork the server `utilityProcess`,
  per-window `MessageChannelMain`, port transfer, `HOST_REQUEST`/dialog hop,
  window registry, server respawn. *Grows.*
- **`apps/desktop/src/app.js`** (~10,800 → ~4,000 after G5): the
  `createInterpreter` block (`:3467`), in-renderer `loadStdlib` (`:5580`), and
  the host-primitive registrations **delete** (move server-side). `dispatchKey`
  (`:5713`) becomes "send a `KEY` intent." `createEditorView` mounts on a mirror.
  The render widgets stay. *Shrinks dramatically.*
- **`apps/desktop/src/server/`** (new): `index.js` (from `mwb/server.js`),
  `spine.js`, `buffer-registry.js`, `atomic-write-sync.js`, `autosave.js`,
  `pane-model.js` (new, G0a), the host-primitive surface (moved from `app.js`).
- **`apps/desktop/src/shared/protocol.js`** (from `mwb/protocol.js`) + the §2.2
  additions.
- **`apps/desktop/src/files.js`** (1055): the *direct-I/O* handlers (read/write/
  list/recovery/session/project) move into the server; the *native-dialog*
  handlers stay in main behind `HOST_REQUEST`. *Splits.*
- **`apps/desktop/preload.mjs`** (714): add the port re-dispatch; clipboard +
  native-dialog bridges stay; the file-I/O bridges that moved server-side are
  removed. *Net smaller.*
- **`packages/renderer/src/view.js`** (2110): **no change** (the headline
  result). Its `buffer`/`onKey`/`getCursors`/`getDecorations` seam is the mount.
- **`packages/lisp/`** (`mwb-interrupt` branch): merge the step budget; later,
  the worker-thread eval for `C-g`.
- **`packages/stdlib/lisp/*`**: **no change** — they load verbatim server-side.
  This is the whole point of the primitive split.

---

## 11. Decision list (for the architect)

1. **Sequencing: G0 first, or flip-soon?** My recommendation: **G0 first** (two
   structural prototypes — pane model + generic picker). They're the only
   unknowns left. (§12.)
2. **Server home:** confirm `utilityProcess` (the prototype proves it). The SAB
   finding pushes `C-g` to a worker-thread refinement — accepted?
3. **The generic `PICKER` channel** vs five bespoke pickers — adopt the single
   channel (strong recommendation)?
4. **Flag name + default** for the long G1-G4 middle (`GODOT_SERVER`?), and the
   parity bar before G5 flips the default (proposal: the architect's daily
   driver for a week with no fallback).
5. **Toolbar branch:** schedule its merge *before* or *after* the flip? (It must
   graduate either way; merging first means porting it once, in-flow.)
6. **`C-g` worker thread:** ship with step-budget-only v1 (recommended), or
   build the worker-thread interactive abort up front?
7. **Multi-window UX** (window menu, titles, daemon start/attach/detach) — Phase
   G5 polish, or earlier?

---

## 12. The sequencing recommendation — flip soon vs more prototype first

**Recommendation: build two more structural prototype pieces first (G0), then
flip.** Reasoning:

The prototype has retired every objection that was *existential* (latency, the
render refactor, the command port) and a great deal that was merely *laborious*
(multi-buffer, save, undo, overlays, multi-cursor). What it has **not** pinned is
the *shape* of exactly two things, and they happen to be the two with the most
structural coupling in the current renderer:

- **The pane/window geometry negotiation.** Everything proven so far has been
  *one view in one window* (or the same view in two). The real app's pane tree
  (`app.js:653-1610`, ~1000 lines interleaving logical structure and pixels) is
  the one place the clean "render from a mirror, server owns the model" story
  has not been demonstrated. If there's a surprise left in Model B, it's here.
  A focused G0a prototype (server-side `@editor/pane` + the `PANE_TREE`/
  `PANE_INTENT` wire + a 2-4-pane client) will either confirm it's another
  drop-in or surface the cost *before* a single production line changes.

- **The render-side picker round-trip.** Five+ pickers go from synchronous
  in-renderer calls to async wire round-trips. Getting the *generic* channel
  right once (G0b, with the buffer list as the first consumer) turns five slices
  into one mechanism. Getting it wrong means seven bespoke async UIs. This is
  cheap to prototype and high-leverage to get right early.

Both are small (each is a `mwb/`-style flag-gated slice, days not weeks), and
both end with a real **decision gate**: if either turns out worse than the rest
of Model B has, that's the honest last moment to reconsider — *before* the
production flip, with the in-renderer app still 100% intact and shipping.

**After G0, flip with confidence** via G1-G5: stand the server up in real
`main.js` behind a flag, route one window through it, port the stdlib in
`STDLIB_FILES` order wave-by-wave (mechanical, the app usable throughout, the
flag-off default untouched), turn on multi-window, then flip the default and
delete the dead in-renderer path. The long middle is *long* but *legible* — no
research left, only bookkeeping, and the flag means the app is never only on the
half-ported path.

The one thing I would **not** do is flip the real app *now*, before G0: not
because it would fail, but because the pane negotiation is the single piece whose
cost the evidence doesn't yet bound, and it's cheap to bound it first. Measure
the last unknown, then commit.
