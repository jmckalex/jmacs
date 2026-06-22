# Architect notes

Running log for decisions/blockers that need Jason. Newest first.

---

## [2026-06-22 14:40] Model-B/multi-buffer: the server is now a real multi-buffer workspace — N buffers, clients switch between them (C-x b / C-x C-b / C-x k)

**Context**: The foundation after overlays/multi-cursor. The spine held ONE
canonical buffer that find-file *replaced*. This slice makes the server a
real **multi-buffer workspace**: it holds MANY L2 buffers at once (a buffer
list keyed by id), each with its own text/mode/markers/overlays/point, and
clients switch between them. All on branch `multi-window-b` in worktree
`godot-mw-b`, isolated under `apps/desktop/mwb/` behind `MWB_*` flags;
production app.js/view.js/main.js + `packages/*` untouched; suite green
throughout.

**What multi-buffer now does (proven end-to-end through the REAL view.js)**:
- **Server-side buffer registry** (`mwb/buffer-registry.js`, new). The server
  holds many buffers at once; each registry entry owns its L2 buffer (the
  shared text), a `Map<clientIndex, view>` (each window keeps its OWN
  point/mark over that buffer — the per-window vs per-buffer split), its
  overlay list (edit-tracked via L2 markers, **per-buffer** so a highlight
  rides with its buffer), and a per-buffer saved-text baseline. Name
  collisions get an Emacs-style `<n>` suffix. 16 `node --test` cases.
- **find-file ADDS a buffer** (and switches the active client to it) instead
  of replacing the current one. The original buffer stays in the list,
  switchable back — with its overlays and the window's cursor intact.
- **Per-client current-buffer**: each window tracks which buffer it views
  (the spine's `clientBuffers` map). `setActiveClient` binds the interpreter
  to the active client's CURRENT buffer + its view of it (re-deriving the
  major mode, since the mode is a buffer property). Two windows can view
  DIFFERENT buffers; switching one window's buffer leaves the other put.
- **The switch protocol**: a buffer switch sends the client a full SNAPSHOT
  (text + point) of the new buffer, then its overlays + cursor set. The
  client's `onSnapshot` (which builds a fresh `ClientBuffer` + a fresh real
  `view.js`) IS the "tear down the old mirror, build a new one" the brief
  asked for — the same path used for initial sync and find-file; in-flight
  predictions for the old buffer are cleared. New wire pieces: a
  `SWITCH_BUFFER` intent (a direct switch, e.g. a buffer-list click) and a
  `BUFFER_LIST` down-message; SNAPSHOT now carries a `bufferId`.
- **Commands**: `switch-to-buffer` (C-x b) — a host-completed name read
  (exact then shortest-substring match), `list-buffers` (C-x C-b) — sends
  the buffer records, `kill-buffer` (C-x k) — removes the current buffer and
  re-homes the window to a survivor (the registry **refuses to kill the last
  buffer**). All real `defcommand`s, bound in the spine's C-x map exactly as
  production keymap.lisp binds them.

**The one correctness change that mattered: deltas are no longer a
broadcast.** With one buffer, every text delta fanned to every client. With
N buffers, a delta must reach **only the clients viewing the edited buffer**
— else a window on a different buffer gets corrupted. The registry now tags
each buffer's `onChange` with its id (`onBufferChange`), and the server
(`fanDelta`) matches clients by `currentBufferIdOf`. The multi-cursor RESYNC
and the overlay broadcast are likewise **scoped to the edited buffer**. A
find-file/switch through the minibuffer changes the active client's buffer
mid-intent; the switch handler fully re-syncs that client, so `applyIntent`
detects the buffer change and **skips the stale-buffer reconciliation** (the
captured `buffer`/`point` refer to the old buffer).

**view.js change needed: ZERO (again).** The whole switch is "build a fresh
ClientBuffer mirror + a fresh createEditorView on it" — the existing
snapshot path. The renderer never knew the buffer changed underneath it; the
mirror is just re-seeded. Three Model-B fears (latency, the render refactor,
the command/keymap port) were already retired; this adds that **multi-buffer
+ switching is also a drop-in on the render side** — the cost is all in the
server's bookkeeping (the registry + the per-buffer delta scoping), which is
mechanical and now done.

**Verification (headless, no screen)**:
- Pure/registry/spine helpers: `node --test mwb/buffer-registry.test.js`
  (16 cases) + `mwb/spine.test.js` (now 59: +8 multi-buffer — find-file
  adds; switch preserves cursor; bufferListRecords flags the current per
  client; two clients on different buffers independent; different modeline
  modes; kill-buffer removes+re-homes+refuses-last; switching one client
  leaves the other put). Desktop suite green: **552** (was 528; +16
  registry +8 spine).
- **End-to-end through the REAL server + protocol + view.js**: new
  `MWB_MULTIBUFFER_SELFTEST=1`. Single window → `[mwb-multibuffer-
  selftest-done] PASS` (typed a marker into buffer A + highlighted it,
  find-file'd buffer B → view re-mounted with NO A-overlays, switched back
  to A → content + overlays + cursor all restored, switched to B again
  clean, C-x C-b listed both). Two windows (`MWB_CLIENTS=2`) → PASS
  (`differentBuffersIndependent`: client 0 on B / client 1 on A; then the
  observer switches to B and the **same-buffer lockstep still holds** —
  client 0 types into B, client 1 sees it without typing). The prior view /
  same-buffer / overlay / commands self-tests all still **PASS** unchanged.
  Reproduce:
  `cd apps/desktop && MWB_VIEW=1 MWB_MULTIBUFFER_SELFTEST=1 [MWB_CLIENTS=2] ./node_modules/.bin/electron mwb/launch.js --user-data-dir=/tmp/godot-mw-b-userdata --enable-logging=stderr`

**What's deferred (honest)**:
- **Pane GEOMETRY** stays render-side (splits, the tabline, minimap). The
  BUFFER-LIST half of `view-primitives.js` is now built (the registry);
  arranging views in pixels per window is a separate render slice. See the
  updated PRIMITIVE-SPLIT.md "View / pane addressing" (now split into the
  built buffer-list half + the deferred geometry half).
- **The buffer-list VIEW is a stub client-side**: `BUFFER_LIST` reaches the
  client and the records are correct (the self-test asserts them), but the
  prototype just logs + stashes them — it does not render the production
  *View List* table. The data + switch wire are done; the picker UI is a
  render slice.
- **save-buffer** is still a status stub (no file write); a buffer's path
  isn't tracked for writing back. find-file reads; saving is a later slice.
- **Client detach**: `registry.dropClient` exists + is tested, but the
  server doesn't yet call it on a window close (no lifecycle teardown in the
  prototype). Buffers outlive clients correctly; the cleanup hook is unwired.

**State of the work**: branch `multi-window-b`, clean, suite green (552).
Four new commits on top of the overlay slice:
- `feat(mwb): add the server-side buffer registry (multi-buffer foundation)`
- `feat(mwb): multi-buffer through the server (registry + switch + C-x b/C-x C-b/C-x k)`
- `test(mwb): headless multi-buffer proof through the real view.js`
- `test(mwb): spine multi-buffer cases + per-buffer modeline mode`
- `fix(mwb): skip stale reconciliation when an intent switches buffers; doc`
NOT merged. All isolated under `apps/desktop/mwb/` behind `MWB_*` flags.

---

## [2026-06-22 14:10] Model-B/overlay-sync: overlay + multi-cursor sync PROVEN end-to-end through the REAL view.js AND across two windows

**Context**: The prior overlay slice (commits 1d5d19d + 8fc3a35) added the
overlay/multi-cursor wire + mirror + spine commands and was unit-tested
(suite green 528), but had no end-to-end proof through the real renderer
and no architect note. This solidifies the foundation: a headless
`MWB_OVERLAY_SELFTEST` that drives the real server + protocol + production
`view.js` and asserts the synced state both reached the mirror AND got
painted, single-window and across two windows. All on branch
`multi-window-b` in worktree `godot-mw-b`, isolated under
`apps/desktop/mwb/` behind `MWB_*` flags; production view.js/app.js/main.js
+ `packages/*` untouched.

**What the self-test proves (headless, no screen)**:
- **Multi-cursor → mirror → painted.** Type a word with 3 occurrences at
  buffer start, then `select-all-matches` (C-c D) server-side → the full
  3-cursor set syncs to `mirror.cursors` (CURSORS message) AND the real
  view.js paints 2 `.editor-cursor.is-secondary` carets (the existing
  `getCursors()` seam). `C-g` (keyboard-quit) collapses back to 1 cursor.
- **Search-highlight overlays → mirror → painted.** `highlight-matches`
  (M-s h) server-side → 3 search overlays (each endpoint an L2 marker, so
  they ride edits) sync to `mirror.decorations` (OVERLAYS message, in the
  renderer's `{start,end,face}` shape) AND view.js paints 3
  `.editor-decoration.tok-search-match` boxes (the existing
  `getDecorations()` seam). `unhighlight-all` (M-s u) clears them — mirror
  empties + DOM boxes disappear (the sync is two-way, not a one-way write).
- **Cross-window propagation (MWB_CLIENTS=2).** Client 0 drives;
  client 1 (the observer, which highlighted nothing) sees the 3 overlays
  appear on its OWN mirror + its OWN view.js paints all 3 boxes — overlays
  are SHARED buffer state, broadcast to every client. The observer
  correctly does NOT adopt the driver's secondary cursors
  (`noForeignSecondaryCursors=true`, mirror.cursors.length stays 1):
  multi-cursor is PER-CLIENT window state, overlays are PER-BUFFER — the
  Model-B per-window/per-buffer split, working.

**view.js change needed: ZERO.** The `getCursors()` / `getDecorations()`
options of `createEditorView` ARE the seam; the mirror presents the exact
interface they expect (cursors as `[{point,mark}]`, decorations as
`{start,end,face}`), so secondary carets + overlay boxes render with no
renderer change. The only mwb-side render asset is one `tok-search-match`
CSS face in `view-harness.html` (production styles.css has no search face —
host isearch uses the selection); production styles.css is untouched.

**One sharp edge worth knowing (it bit the first run)**: the multi-cursor
keys are `C-c D` / `C-c d` and the search keys `M-s h` / `M-s u`, which
resolve through the MODE-KEYMAP CHAIN first. In a **markdown** buffer
(README.md) `C-c` is the Markdown chord prefix, so `C-c D` resolves THERE
(unbound → aborts) instead of the global multi-cursor map — the cursor sync
silently produced 1 cursor. The fix is just to run the test on a buffer
whose major mode doesn't claim `C-c`: the default MWB_FILE (view.js, a
`.js` file = fundamental mode in the spine) leaves `C-c`/`M-s` as the
global prefixes. Overlays + cursors themselves are mode-independent once a
command runs; only the KEY used to invoke them is mode-sensitive. The test
documents this; run it WITHOUT MWB_FILE (or with a non-markdown file).

**Verification (reproduce)**:
- Single window:
  `cd apps/desktop && MWB_VIEW=1 MWB_OVERLAY_SELFTEST=1 ./node_modules/.bin/electron mwb/launch.js --user-data-dir=/tmp/godot-mw-b-userdata --enable-logging=stderr`
  → `[mwb-overlay-selftest-done] PASS` (DRIVER: cursorsReachedMirror=3,
  cursorsPainted=2 secondaries, collapsed, overlaysReachedMirror=3,
  overlaysAreSearchMatch, overlaysPainted=3 boxes, overlaysCleared).
- Two windows (add `MWB_CLIENTS=2`) → `[mwb-overlay-selftest-done] PASS`
  (OBSERVER client 1: overlaysReachedMirror=3, viewPainted=3,
  noForeignSecondaryCursors=1).
- The prior `MWB_VIEW_SELFTEST`, `MWB_SAME_BUFFER` (2 clients) and
  `MWB_COMMANDS_SELFTEST` self-tests all still **PASS** unchanged.
- Full desktop suite green: **528** (unchanged — the new self-test is a
  flag-gated harness driver, not a unit test; the overlay/cursor PURE
  helpers were already unit-tested by 1d5d19d/8fc3a35: +25 protocol, +29
  client-buffer, +12 spine cases).

**What's deferred (honest)**:
- The overlay set the spine exposes is the search-highlight feature; the
  general overlay surface (snippets, bookmarks, arbitrary faces) is the
  same wire + mirror path but those features' stdlib files aren't ported.
- Multi-cursor SELF-INSERT across the wire (typing at every caret) works
  server-side (spine test `a multi-cursor self-insert edits at every
  caret`) and resyncs via RESYNC; the overlay self-test exercises the
  cursor SET sync + paint, not multi-caret typing through the real view
  (that's the same RESYNC path the spine tests cover).

**State of the work**: branch `multi-window-b`, clean, suite green (528).
One new commit on top of the overlay slice:
- `test(mwb): headless overlay + multi-cursor sync proof through real view.js`
NOT merged. Changes confined to `apps/desktop/mwb/` (preload.mjs, launch.js,
view-client.js); production untouched.

---

## [2026-06-22 13:30] Model-B/primitive-split: the model/render split is documented + proven on a real stdlib slice (kill/yank, line-ops, a major mode) running server-side

**Context**: The spine loaded only `commands.lisp` + `editing.lisp`.
Completing Model B means loading the **rest of the stdlib server-side**,
but most stdlib files call **renderer-side primitives** the
utilityProcess server has no business running. This slice (a) establishes
+ documents the **model/render primitive-split pattern** — the key
deliverable that makes the remaining port mechanical — and (b) proves it
scales by porting a meaningful **model-heavy slice** verbatim. All on
branch `multi-window-b` in worktree `godot-mw-b`, isolated under
`apps/desktop/mwb/` behind `MWB_*` flags; production app.js/view.js/main.js
+ `packages/*` untouched; suite green throughout.

**The split pattern (the deliverable) — `mwb/PRIMITIVE-SPLIT.md`**: every
host primitive is one of three categories —
- **model**: pure buffer/interpreter state → the server provides it
  directly (already does, via `createBufferPrimitives`).
- **render-message**: a visual effect the client owns → the server turns
  the call into a `VIEW`/scroll/`SNAPSHOT` message the client executes.
- **stub**: a visual/system effect not yet wired → no-op for now; the
  command still loads + dispatches, the effect is a documented gap.

Litmus test: *could two windows on one buffer legitimately disagree about
the answer?* Yes (scroll, pixel height, focused pane, this window's
minibuffer) → render-side; no (the text, the kill ring, a major mode, a
customize value) → model-side. The doc has a per-family table so each
not-yet-ported file resolves to a recipe: grep its host primitives, look
them up, provide the model ones, route/stub the rest, load verbatim, add
a headless test.

**What's now loaded + running server-side, VERBATIM from disk** (on top of
the command core): `custom.lisp`, `indent.lisp`, `modes.lisp`,
`math-preview.lisp`, `kill.lisp`, `yank-pop.lisp`, `line-ops.lisp`,
`search.lisp`, `markdown.lisp`. Working through the server:
- **kill ring / yank**: `C-w` kill-region, `M-w` copy-region, `C-k`
  kill-line, `C-y` yank, `M-y` yank-pop (+ its correct rejection when the
  previous command wasn't a yank), `M-d`/`M-backspace` kill-word. The ring
  is real shared interpreter state; the system-clipboard mirror is a
  **server-local in-memory stub** (the ring round-trips fully; true
  cross-app paste deferred — a future clipboard render-message both ways).
- **line operations**: `M-up`/`M-down` move-line, `C-x C-d` duplicate-line,
  `C-x C-j` join-line, `M-]`/`M-[` indent/outdent-region, `sort-lines`
  (an `interactive region` command). All pure model-side.
- **a real major mode through the server (markdown.lisp)**: a `.md` buffer
  gets `markdown-mode` server-side (`choose-major-mode!`); its bindings
  dispatch via the **mode-keymap chain** (see below): `C-c b` bolds the
  selection (`*…*`), `C-c 1` makes a heading, `C-c m` toggles the
  math-symbol minor mode and `` ` a`` inserts `\alpha` (via `read-next-key`).

**The meaningful spine extension — the mode-keymap chain.** For a mode's
bindings to dispatch server-side, `handleKey` now consults the active
buffer's mode keymaps (minor + major, via modes.lisp's
`minor-mode-keymaps`/`major-mode-keymap`) **before** the global table,
plus a Lisp `*key-reader*` for `read-next-key`. This is the same
resolution order as production keymap.lisp, reusing the real helpers; the
chord state lives in Lisp (`-spine-chord-map`) so a `C-c …` chord resolves
against the live mode map. The modeline now also carries the
server-chosen major mode (model-side info the server owns).

**One shared-state subtlety found + fixed (it WILL recur in the port)**:
`yank-pop` is valid only right after `yank`/`yank-pop`, tested via
`*last-command*` (set by `run-command`). For that to hold server-side ALL
dispatch must touch `*last-command*` — and bare self-insert didn't (it
called `buffer.insert` directly). Fixed: self-insert now clears
`*last-command*`, so typing correctly invalidates a pending yank. This is
the kind of shared-history-state correctness Model B forces (and it's
cheap once spotted) — flagging it because the same "does this path update
shared command state?" question recurs for every command file.

**What's stubbed/deferred (honest)**:
- **search** (`search.lisp` loaded; `regex-search.lisp` not): the two
  `isearch-*` commands resolve, but the actual **interactive isearch loop**
  (per-keystroke match + highlight + minibuffer) is host-owned. Porting it
  is a render-message slice of its own (a server search state machine + a
  client highlight overlay), not a table row — the honest "too entangled
  to port cleanly now" case. `start-search!` surfaces a stub status.
- **preview / MathJax**: `markdown-preview!`/`math-preview!` stubbed (the
  toggle commands resolve; the iframe/MathJax is a render-message to build).
- **customize panel**: the registry (`defcustom`, `*tab-width*`, …) runs
  model-side; the openers (`open-customize!`, `write-custom-file!`) stub.
- **pane/view/tabline/themes/faces/languages files**: NOT ported — they
  need the pane tree + DOM measurement + element views, all render-side
  slices. See PRIMITIVE-SPLIT.md "View / pane addressing".

**Verification (headless, no screen)**:
- Pure/spine helpers: `node --test mwb/spine.test.js` — **39** cases (22
  prior + 17 new: the registry, kill/copy/yank, yank-pop + rejection,
  move-line/duplicate/sort, .md→markdown-mode, C-c b / C-c 1 via the mode
  chain, the math-symbol minor mode, the search stub, the custom registry).
- **End-to-end through the REAL server + protocol + view.js**: new
  `MWB_COMMANDS_SELFTEST=1` flag drives copy/yank + Markdown `C-c b`
  through the wire and asserts the client MIRROR reflects each. On
  `sample-documents/README.md`: `[mwb-commands-selftest-done] PASS`
  (`modeOk=true yankWorked=true boldWorked=true`, modeline `(Markdown)`).
  The prior `MWB_VIEW_SELFTEST` and `MWB_SAME_BUFFER` self-tests still
  **PASS** unchanged (single-window + two-window-same-buffer intact).
- Full desktop suite green: **495** (was 478; +17 spine).

**Feasibility read (updated)**: this retires the last "is the stdlib port
a metastasizing rewrite?" worry the prior note flagged. With the split map
in hand, the model-heavy files port **mechanically** — load verbatim,
provide the (already-present) model primitives, stub the render ones — and
a real major mode now works through the server, keymap chain and all. The
residual cost is concentrated in the **render-message families that need a
real two-way protocol** (the isearch loop, the pane/view negotiation,
MathJax/preview, §5d's hard direction) — those are slices, not table rows,
and are clearly enumerated. Nothing here changes the A-vs-B verdict's
shape; it just moves more of B's "hard, unknown" column into "mechanical,
known".

**State of the work**: branch `multi-window-b`, clean, suite green (495).
Two new commits on top of the command-spine work:
- `feat(mwb): establish the primitive-split + port a model-heavy stdlib slice`
- `feat(mwb): headless self-test for the richer stdlib through the real view`
NOT merged. All isolated under `apps/desktop/mwb/` behind `MWB_*` flags.

---

## [2026-06-22 11:50] Model-B/command-spine: the prototype is a usable editor THROUGH the server — and two windows share one buffer

**Context**: The next slice after render-from-mirror. Phase 0 answered
latency (sub-ms); the render slice proved view.js renders from a mirror
with ZERO view.js changes. The open cost was the **model/command half**.
This slice pays down the thinnest real slice of it: make the prototype a
genuinely usable single-window editor *through the server* — and (stretch,
reached) stand a second client on the same buffer. All on branch
`multi-window-b` in worktree `godot-mw-b`, isolated under
`apps/desktop/mwb/` behind the `MWB_*` flags; production
app.js/view.js/main.js untouched; existing suite green throughout.

**What now works THROUGH the server (the command surface reached)**:
- **The whole command machinery runs server-side, REAL, not re-implemented.**
  `mwb/spine.js` (`createSpine`) stands up a real L2 buffer in a real
  `@editor/view`, the real `createBufferPrimitives` surface, and loads
  `commands.lisp` + `editing.lisp` **verbatim from disk** — so it's the
  real `defcommand`/`run-command`/interactive-gatherer + the real
  motion/editing commands. A focused `handle-key` keymap (same shape as
  keymap.lisp: prefix chords, self-insert fallthrough) drives `run-command`.
- **Routing**: the client's `onKey` forwards normalised key-strings up. A
  bare printable self-inserts with **local echo** (instant) + a SELF_INSERT
  intent the server confirms via a delta; **every other key** — Enter,
  Backspace, motion, chords, M-x, C-x C-f — is a pure KEY intent the server
  resolves through the real keymap. Buffer mutations come back as DELTAs
  (proven); non-text effects as a new **VIEW** message.
- **The view-update protocol** (`protocol.js`, `MSG.VIEW`): cursor/mark, the
  modeline string (pure `renderModeline` helper, tested), the echo-area
  status, and minibuffer state — plus a down-channel `scroll` request for
  recenter (the easy direction of the §5d measurement conversation: server
  decides the line, client does the pixels).
- **M-x**: opens the minibuffer (real `(interactive (string "M-x "))`),
  client shows it, server completes against the **real command registry**
  and runs the chosen command.
- **find-file**: prompts, the server (a Node child) reads the file directly,
  swaps the canonical buffer, re-snapshots the client — which renders it via
  the mirror with real highlighting.
- **The minibuffer round-trip**: prompt server-side (open-minibuffer! →
  VIEW), display + input client-side, submit/cancel back up; the server
  resumes the suspended command's continuation (`minibuffer-delivered`).
  Single AND chained prompts work (goto-line; replace-string's two prompts).

**The stretch — REACHED: two clients, one shared buffer (the Model-B payoff).**
`MWB_CLIENTS=2` opens a second window with its own MessageChannel to the
server. The spine holds **N views over one shared buffer** — each client its
own point/mark, the text shared. A text delta fans to EVERY client (only the
originator gets the echoId, to reconcile its optimistic edit); a motion
touches only its client. Headless `MWB_SAME_BUFFER=1` verified: client 0
types "SHARED99 ", **client 1 (the observer) sees it on its own mirror
without typing it** (`sawMarker=true changed=true`). This is the thing Model
A can't cheaply do, working.

**Verification (headless, no screen)**:
- Pure helpers: `node --test mwb/protocol.test.js mwb/spine.test.js
  mwb/client-buffer.test.js` — 55 cases (incl. 22 spine: self-insert,
  motion, editing, chords, the real registry, set-mark, the minibuffer
  round-trip, find-file swap, recenter scroll, M-x abort-then-run, +3
  multi-client: shared text / separate cursors / cross-client edits).
- Single-window spine self-test (real view.js on the real 90k-char view.js):
  `MWB_VIEW=1 MWB_VIEW_SELFTEST=1 electron mwb/launch.js …` → PASS —
  `grew line0Changed serverConfirmed reRendered pointMovedByCommand
  modeline minibufferWorks` all true (typing not scrambled; a motion command
  moves point server-side; the modeline updates; the M-x→goto-line round
  trip works). Local echo paints same-frame; round-trip sub-frame.
- Two-window same-buffer: `MWB_VIEW=1 MWB_SAME_BUFFER=1 MWB_CLIENTS=2
  electron mwb/launch.js …` → `[mwb-same-buffer-done] PASS`.
- Full desktop suite green: **478** (was 450; +28 mwb spine/protocol/
  multi-client tests). `MWB_FILE=<abs>` renders a different file/language;
  drop the SELFTEST flags to drive by hand (open the window, type, M-x,
  C-x C-f).

**One real bug found + fixed (worth knowing — it WILL recur)**: under rapid
local-echo typing the marker came out scrambled ("MWBxyz" → "MWByz x"). Cause:
the echoed self-insert delta in `client-buffer.js applyDelta({echoed})` was
**adopting the server's `delta.point`**, which LAGS the client's optimistic
point when several predictions are in flight — rewinding the cursor so the
next predicted char inserted at the wrong offset. Fix: during echo the local
prediction is authoritative for point; an echoed delta no longer touches it
(the server point matters only for non-echoed, command-driven moves). The
client also guards VIEW-message cursor reconciliation behind "no predictions
in flight" for the same reason. **If typing scrambles again, look here first,
not at the protocol.**

**What's hard / deferred (honest — NOT built, costs real work later)**:
- The spine loads a **deliberately small stdlib subset** (commands.lisp +
  editing.lisp). The full stdlib pulls in panes/tabline/faces/themes/
  languages + dozens of renderer-only primitives the server has no business
  owning yet. The command SURFACE is proven real; the full port is a
  file-by-file effort (each stdlib file's primitives need a server home or a
  client round-trip).
- **Markers/overlays/multi-cursor over the wire** (snippets, bookmarks,
  decorations), **undo policy** (server-side, shared), and **interruption**
  (§7.2, the C-g step-budget — mandatory before living in the shared model)
  are all still unbuilt. The mirror drives only the primary cursor.
- The **scroll/measurement conversation** is built only in the easy
  direction (recenter: server→client line). The fiddly direction
  (scroll-by-screenful needs the client's viewport geometry UP) is unbuilt.
- Multi-client lifecycle is a slice, not robust: no client detach/respawn,
  the minibuffer is one-prompt-global (fine for now), and the second client
  reuses the same window-state reset on find-file. Phase 2/3 polish.

**Feasibility read (updated, for the A-vs-B decision)**: Model B's two
scariest risks were latency (retired Phase 0) and the render refactor
(retired by render-from-mirror). This slice retires the third fear — that
the command/keymap/minibuffer port is a metastasizing rewrite: **it isn't.**
The real command system loaded verbatim and ran server-side against the real
buffer with a small host-primitive shim; M-x, find-file, the minibuffer and
the keymap all work through the wire; and the payoff feature (one buffer in
two windows) fell out almost for free once the spine existed. The residual
cost is real but **legible and incremental** (port stdlib file-by-file; build
interruption + shared undo + markers-over-wire), not a landmine. My honest
call: if you have appetite for that incremental port + interruption, Model B
is viable and its integration ceiling (shared world, same-buffer-free, live
global customization) is genuinely higher than A's. If you want
shippable-soon at lowest risk, A is still the safe answer — but every
existential objection to B has now been retired with working code.

**State of the work**: branch `multi-window-b`, clean, suite green (478).
New commits on top of the render slice:
- `feat(mwb): add the view-update protocol (modeline, status, minibuffer)`
- `feat(mwb): server-side command spine (real defcommand/keymap/minibuffer)`
- `feat(mwb): wire the command spine through the server (usable single window)`
- `feat(mwb): two clients on one shared buffer (the Model-B payoff)`
NOT merged. Everything isolated under `apps/desktop/mwb/` behind `MWB_*`
flags; no production code touched.

---

## [2026-06-22 11:00] Model-B/render-from-mirror: the REAL view.js renders + edits from a mirror — COST IS LOW (view.js: ZERO changes)

**Context**: The Phase-0 spike answered the *latency* question (~0.3 ms
round-trip, frame-identical local echo) but rendered from a trivial
`<pre>`+cursor painter, not `view.js`. The decisive remaining bake-off
question (plan §5b, §10 "the decision is now a *cost* question"): **how
expensive is it to drive the real `view.js` rendering stack — tree-sitter
highlighting, folding, measurement — from a replicated buffer mirror +
server deltas instead of the live buffer?** I built the thinnest REAL
slice to find out. All on branch `multi-window-b` in worktree
`godot-mw-b`, isolated under `apps/desktop/mwb/`; production app.js/view.js
were NOT touched; existing suite green throughout (450 desktop tests).

**What I built (the working slice)**:
- `mwb/client-buffer.js` (`createClientBuffer`) — the **mirror**. It
  presents the same read interface `view.js` consumes off an L2 buffer,
  but is driven by server deltas instead of local commands. It **reuses
  `@editor/storage` (L1) verbatim** for the entire read surface
  (`text/lineAt/positionAt/offsetAt/slice/lineCount`) — the subtle
  line/column/surrogate math we get for free — and only re-homes two
  things: the **cursor becomes per-client window-state** the mirror owns,
  and the **mutators become intent-emitters** (local-echo a prediction +
  send the edit UP). `applyDelta`/`applySnapshot` drive it from the wire.
  18 `node --test` cases.
- `mwb/server.js` (extended) — loads a **real file** (view.js by default,
  `MWB_FILE` to override) directly off disk (utilityProcess = Node child,
  plan §3 (i)), and routes self-insert/backspace/point/arrow-motion
  intents through the real interpreter + L2 buffer. Text edits fan out as
  deltas; a motion that yields no text delta replies with a CURSOR message
  so the client reconciles its per-window cursor.
- `mwb/view-harness.html` + `mwb/view-client.js` — load the app's real
  `styles.css` + **all ~70 language grammars** (the exact app.js recipe)
  and mount the **production `createEditorView`** on the mirror. Keystrokes
  route via `onKey` → mirror mutators (local echo) + intents.
- `mwb/launch.js` (extended) — `MWB_VIEW=1` opens this harness;
  `MWB_VIEW_SELFTEST=1` drives a **headless** edit-through-the-server
  self-test and quits PASS/FAIL (no screen needed).

**Headless verification** (real view.js mounted on the real `view.js`,
90,725 chars / 2,111 lines, AND on `editing.lisp` via the Scheme grammar):
- Mounted with **zero render errors**; full tree-sitter highlighting +
  folding active, computed entirely client-side off the mirror text.
- Typing a marker at buffer start → `grew=true line0Changed=true
  serverConfirmed=7/7 reRendered=8`, i.e. every keystroke round-tripped
  through the server's canonical buffer AND the real view re-rendered +
  re-highlighted. Round-trip **mean 0.53 ms, p95 0.60–0.70 ms** — matches
  Phase 0; local echo paints on the same frame.

**THE COST FINDING (the bake-off input)**:

1. **`view.js` required ZERO changes.** Its buffer-read surface is small
   (exactly **12 members**: `text, name, lineCount, slice, lineAt,
   positionAt, offsetAt, onChange, point, mark, insert, moveTo`),
   synchronous, and cleanly separable from editing. The mirror implements
   all 12; the renderer never knew it wasn't reading a live buffer. I did
   **not** fork view.js or add a seam to it — the *existing* `buffer`
   parameter of `createEditorView` IS the seam. **This is the single most
   important result**: the plan called this "the largest single refactor in
   the codebase" and feared a "long half-working middle"; for the
   *rendering* half, that fear does not materialise. Render-from-mirror is
   a drop-in.

2. **Highlighting + folding are pure functions of the mirror text** and
   ran completely unchanged. This is the crux of the replicated-client
   tractability argument (plan §4) and it holds in practice: don't rewrite
   rendering, replicate state.

3. **The genuinely useful discovery — the keystroke path needs no view.js
   mutation hook at all.** With an `onKey` dispatcher supplied (which the
   real app already does, to hand its Lisp keymap the keys), `view.js`
   does NOT call `buffer.insert` for keystrokes — it delegates 100% to
   `onKey(keyString)`. So routing edits to the server is purely a matter of
   what `onKey` does; the renderer is already decoupled from "who applies
   the edit." The only direct `buffer.insert`/`moveTo` calls left in
   view.js are the IME `compositionend` path and mouse cursor-placement —
   both handled by the mirror's mutators (echo + intent), no view.js touch.

**Where it bites (honest — the cost that ISN'T zero)**:
- **The measurement conversation (§5d) is real but narrow.** view.js owns
  ALL pixel measurement + scroll geometry client-side (`scrollTop`,
  `clientHeight`, `getBoundingClientRect().height` for line height, the
  `firstRow`/`lastRow` virtualization window, `scrollIntoView` for
  follow-cursor/recenter). In my slice this is a **non-issue for basic
  editing** — the view scrolls itself, the server is never consulted for
  pixels. It bites in exactly one place: when a **server-side Lisp command**
  must make a scroll decision needing this client's pixels. Concretely,
  `recenter` is `(defcommand recenter () (recenter!))` → `editorView
  .recenter()` — a Lisp command whose *effect* is a client-pixel scroll.
  Under Model B that becomes a **down-channel message** ("recenter your
  view" / "scroll to window-start line L"): the server decides the line
  (it knows point), the client executes the pixel scroll. That direction
  is easy. The fiddly direction is commands like `scroll-up`/`page-down`
  that advance window-start by "one screenful" — a quantity only the
  client knows — which needs the client to report viewport geometry UP.
  **Bounded and well-understood, not a metastasis risk; I did not build it
  (the brief said I need not).**
- **What this slice did NOT exercise** (and would still cost real work in
  the full port — these are NOT in the rendering half, so item 1's "zero"
  doesn't cover them): markers + overlays over the wire (snippets,
  bookmarks, decorations — the mirror stubs `createMarker`), multi-cursor
  replication (the mirror drives only the primary cursor), the whole
  `defcommand`/keymap + minibuffer state machine moving server-side, undo
  policy (server-side, shared), and interruption (Phase 1, mandatory before
  living in the shared model). The latency + render proofs say nothing
  about how long *that* surface takes — but none of it is the
  "view.js-reads-buffer-synchronously is everywhere" landmine the plan
  most feared, which is now **defused**.

**Feasibility verdict (Model B vs A — updated)**: Both existential gates
Model B had to clear are now **cleared with margin**. Phase 0 killed the
latency objection (sub-ms round-trip, frame-identical echo). This slice
kills the second one — the fear that driving the real renderer from a
mirror is a huge, regression-prone refactor: **the rendering half is a
drop-in, zero changes to view.js, real highlighting/folding for free.**
The remaining Model-B cost is concentrated in the **model/command half**
(commands + keymap + minibuffer + markers/overlays/multi-cursor + undo +
interruption moving server-side and replicating correctly), plus the
narrow, bounded §5d measurement conversation — NOT in the render path.

My honest read for the A-vs-B decision: Model B's integration ceiling
(one buffer in N windows for free, shared world, instant global
customization) is genuinely higher, the two scariest risks (latency, the
render refactor) are now retired, and the residual cost is real but
*localized and legible* rather than pervasive. If you have appetite for
the model/command-half port (commands server-side + interruption), Model B
is viable and more powerful than I'd have bet before this slice. If you
want shippable-soon with the lowest risk, Model A is still the safe
answer — but the gap narrowed: "the render refactor is enormous" was the
strongest cost argument for A, and it didn't survive contact with the real
renderer.

**Reproduce**:
- Read surface tests: `cd apps/desktop && node --test mwb/client-buffer.test.js`
- The slice, headless self-test:
  `cd apps/desktop && MWB_VIEW=1 MWB_VIEW_SELFTEST=1 ./node_modules/.bin/electron mwb/launch.js --user-data-dir=/tmp/godot-mw-b-userdata --enable-logging=stderr`
  (loads the real renderer on a real file, types through the server,
  prints `[mwb-view-selftest-done] PASS`, quits). `MWB_FILE=<abs path>` to
  render a different file/language; drop `MWB_VIEW_SELFTEST` to leave the
  window open and type by hand.

**State of the work**: branch `multi-window-b`, clean, existing suite
green (450 desktop tests = 432 baseline + 18 ClientBuffer). Two new
commits on top of the Phase-0 work:
- `feat(mwb): add ClientBuffer mirror for render-from-mirror slice`
- `feat(mwb): render the REAL view.js from a server-fed mirror`
NOT merged. Declared `@editor/storage` as a desktop dep (it was already
transitive via `@editor/buffer`) so the mirror's L1 import resolves under
`node --test`. Everything is isolated under `apps/desktop/mwb/` behind the
`MWB_VIEW` flag; production app.js/view.js untouched.

---

## [2026-06-21] Projects "Phase 5" — Project Chooser: built autonomously, needs your review on 3 UX calls

**Context**: You asked me to build the Nova-style Project Chooser (the
screenshot) completely autonomously while away. Done — it's all on branch
`project-workspace` (now 11 commits ahead of `main`), suite **green (~2,578 /
0)**, **not merged**. It builds on increment 1 (open/find/close-project +
3-column layout) from earlier this session. Full design is in
`plans/PROJECTS.md` ("Increment 2"). **Main-process code changed → needs a
full quit + relaunch to live-test, not a reload.**

**What it is**: `M-x project-chooser` opens a Nova-style launcher **modal** —
a centered dialog over a dark backdrop with a grid of project tiles (custom
thumbnail image, or a generated deterministic color+initials tile), a search
field, *Open Folder…* / *Add Project…* actions, and per-card 📷 set-thumbnail
+ ✕ remove. Click a tile (or arrow-select + Enter) to open; Escape / backdrop
/ × to dismiss.

**Update (same session)**: per your follow-up, tiles are now **drag-and-drop
targets** — drag an image from Finder onto a tile to set its thumbnail (the
quick alternative to 📷). The dropped path comes from
`webUtils.getPathForFile` (Electron 42 removed `File.path`), exposed via
preload as `host.getPathForFile`. A dropped file is validated as a readable
image before it's stored, so a non-image drop is a silent no-op.

**Decisions I made (flagging for your review, can change any):**
1. **Modal, not a view/pane.** The chooser is transient (invoke → pick →
   gone) so it shouldn't live in the pane tree or persist in a session. Built
   on the `directory-columns-modal` / `colour-picker` pattern.
2. **Thumbnails = data URLs** (host reads the image path → base64, 8 MB cap),
   stored as an absolute path on the index entry. No serve-route/allowlisting
   needed for small thumbs. Picker is limited to png/jpg/jpeg/gif/svg/webp
   (the formats the reader supports).
3. **No keybinding** for `project-chooser` — left it `M-x` only. I didn't want
   to clobber a key autonomously after the `C-x p` conflict earlier. **Your
   call**: a natural fit is a project prefix (Emacs `C-x p ...`), but that
   collides with `toggle-repl` — same open question as before.
4. **No startup change.** Nova shows the chooser on launch when no project is
   open. That's a boot-behaviour change I won't make autonomously — it'd
   change how you normally start into your home session. Deferred; easy to add
   (`open-project-chooser!` on first boot when `activeProjectPath` is null).
5. **Skipped Nova's New Document + Clone** actions (New Document = a plain new
   buffer; Clone = git) as out of scope for a chooser.

**Two UX behaviours worth a look (both deliberate, see PROJECTS.md):**
- *Open Folder…* closes the chooser **before** the native picker opens (the
  body-level overlay must be gone before `openProject` rebuilds the window).
  So cancelling that picker drops you back to the editor — re-invoke to retry.
  (Add/Set-thumbnail don't close, since they don't rebuild the window.)
- Clicking a **stale** tile (project dir since deleted) closes the chooser,
  then the open is declined with a "Not a directory" status line. Stale
  entries aren't auto-pruned — the ✕ removes one manually.

**Still open from increment 1** (unchanged): orphaned views accumulate in the
global `views` list across workspace switches — clutter in `C-x b`, not a
functional break. Pruning is a documented follow-up.

**How to live-test** (quit + relaunch first):
1. `M-x project-chooser` — empty state first run (Open Folder / Add Project).
2. *Add Project…* a couple of dirs → tiles appear (letter tiles).
3. Hover a tile → 📷 set a thumbnail image; ✕ removes from the list.
4. Type in search to filter; arrow-keys + Enter to open; Escape to dismiss.
5. Click a tile → it opens as a project (3-column layout). Re-open the chooser
   and confirm the just-opened project is now first.

**State of the work**: all committed on `project-workspace`, tests green,
nothing on `main`. Tag `pre-project-workspace` before any `--no-ff` merge.
Files: `apps/desktop/src/{project-chooser.js,project-index.js,files.js,
preload.mjs,app.js}`, `styles.css`, `packages/stdlib/lisp/project.lisp`,
tests `test/project-{index,chooser}.test.js`.

---

## [2026-06-11 00:41] Renderer view-lifecycle tests (E1-A): `@editor/view` is undeclared in the renderer, blocking `tabline-view` tests

**Context**: Audit ticket E1 part A — adding the renderer view layer's
first lifecycle unit tests. I added `packages/renderer/test/text-view-lifecycle.test.js`
(16 tests, green) covering the `<text-view>` wrapper's lifecycle. I then
wrote a matching `tabline-view-lifecycle.test.js` (add/remove/reorder/
activate/active-reanchor/tab-close/destroy) but **could not land it**:
importing `tabline-view.js` fails at module-load with
`ERR_MODULE_NOT_FOUND: '@editor/view'`.

**Question/blocker**: Should the renderer **declare `@editor/view` as a
dependency** (and link it in `node_modules`) so its source is importable
under the package's own resolution? Root cause: `packages/renderer/src/tabline.js`
has a real runtime `import { viewFilePath } from '@editor/view'`, but the
renderer's `package.json` lists only `@editor/buffer`, and
`node_modules/@editor/` symlinks only `buffer`. So `tabline.js` (and
anything importing it, incl. `tabline-view.js`) is unimportable in the
renderer test env. It only works in the running app because of how the
desktop app bundles/serves. This is *why* the view layer has zero
lifecycle tests — the modules aren't loadable under `node --test`.
(`view.js` itself is fine: its only `@editor/view` reference is a
JSDoc `@param {import('@editor/view').View}` type-only annotation, which
ESM never resolves — hence the text-view test loads cleanly.)

I did **not** make the fix myself: adding a cross-package dependency +
node_modules link is dependency-management + layering territory, not a
test change, and a bare local symlink would pass for me but break on a
fresh `pnpm install` / in CI (a test must pass in the real suite, so I
won't ship one that depends on an untracked symlink).

**Options considered**:
- (a) Add `"@editor/view": "workspace:*"` to `packages/renderer/package.json`
  dependencies and let pnpm link it. Clean layering — `@editor/view`
  depends only on `@editor/buffer`, so **no cycle**. My lean: this is the
  right fix; it also unblocks any future `view.js`/`tabline.js` tests.
  One `pnpm install` needed after.
- (b) Refactor `tabline.js` to receive `viewFilePath` via injection
  instead of a static import, so it loads without the dep. More invasive,
  changes a stable module's API for test convenience — not worth it.
- (c) Leave `tabline-view` untested for now (current state). The lifecycle
  logic there (active re-anchoring on remove, single-parent move,
  tab-close event) is exactly the bug-prone surface worth covering, so
  I'd rather not.

**State of the work**: branch `renderer-view-lifecycle-tests`. Committed:
`text-view-lifecycle.test.js` (16 tests, green) + this note. The
`tabline-view-lifecycle.test.js` I wrote is removed from the tree (it
can't pass yet); I can re-add it verbatim the moment option (a) lands —
it drives the real methods against a minimal DOM stub and needs no
further source change. Full renderer suite green. Tree clean.

**[2026-06-11 — RESOLVED]** Option (a) was taken: `@editor/view` is now
declared in `packages/renderer/package.json` and `pnpm install` linked it,
so `tabline-view.js` imports cleanly under `node --test`. Landed
`packages/renderer/test/tabline-view-lifecycle.test.js` (26 tests, green):
add/insert/append-out-of-range, remove (active vs non-active, last tab,
out-of-range guard), active re-anchoring on close, activate (clears
siblings + focus + out-of-range no-op), reorder (up/down/no-op), the Q9
single-parent move, `tab-close` dispatch + bubbling (incl. via the strip's
× button), the edge accessor, and destroy() teardown (DOM removed, nulled,
idempotent, post-destroy mutations are safe no-ops). The test self-contains
a compact fake DOM (element tree + attrs/dataset/classList + the one
`:scope > [active]` selector + bubbling dispatchEvent), installed on
`globalThis` before the import so `ViewElement` picks up `HTMLElement`.
Full renderer suite 625 pass / 0 fail (was 599 + 26 new).

**view.js render internals — NOT unit-tested here (deliberate, not a
blocker).** E1 also asked for `view.js` render-loop tests (line
virtualization, replaced-range/math-widget mount + cleanup across scroll,
fold persistence across re-render). I did **not** add them, and recommend
against forcing them under `node --test`: `createEditorView` is one large
closure whose render path is driven by real pixel layout
(`getBoundingClientRect().height` for the line height, `root.scrollTop` /
`root.clientHeight` for the window, `createTreeWalker`/`createRange` for
caret measurement), `requestAnimationFrame` batching, `morphdom`, and the
tree-sitter highlighters. A fake DOM faithful enough to make the
virtualization window or a widget's measured height come out *right* would
be simulating layout — the assertions would then be testing the simulation,
not the renderer (the "no speculative assertions" trap). The genuinely
pure logic these features rest on is already extracted into siblings with
their own green tests: line splitting + selection/cursor geometry in
`projection.js` (`projection.test.js`), the math-widget layout/placement in
`math-layout.js` (`math-layout.test.js`), and fold ranges + hidden-line
computation in `folding.js` (`folding.test.js`). The remaining `view.js`
glue (wiring those into the rAF render against the real viewport) is what
the smoke arm / live app covers. If you want a unit-level seam, the
cheapest honest one is to export the ~4-line `firstRow`/`lastRow` window
arithmetic from the render closure as a pure helper and pin it — flagging
it rather than doing it, since it's a source change to a hot file other
sessions are also touching.

---

## [2026-06-03] LaTeX Phase 5 (latex-nav): "M-return" → "M-enter" binding deviation

**Context**: Built AUCTeX Phase 5 (navigation & niceties) on branch
`latex-nav`: `latex-next-section` / `latex-previous-section` (C-c C-n /
C-c C-r), `latex-goto-matching-env` (C-c %), `latex-insert-item` (M-RET),
`latex-smart-quote` (the `"` key). New file
`packages/stdlib/lisp/latex-nav.lisp` + `test/latex-nav.test.js` (28
tests). Full suite **1480 / 0 fail** (1452 baseline + 28).

**Deviation (one, deliberate)**: the brief said to bind M-RET as
`"M-return"`. The renderer's `keymap.js` normalises the Enter key's name
to `enter` (NAMED_KEYS / NAMED_CODES), so Alt+Return arrives as
**`"M-enter"`**, never `"M-return"` — `jukebox-view.js` already relies on
exactly `"M-enter"`. Binding `"M-return"` would be a dead key (the feature
would never fire), so I bound the live name `"M-enter"` and the wiring
test asserts that. Nothing else changed. Flagging per the standing rule
("the brief wins, but flag the conflict"); if you'd genuinely rather it be
`"M-return"`, the feature is simply unreachable until the renderer emits
that string.

**Other choices to be aware of** (all within the brief's latitude):
- Section nav is **self-contained** (scans `(buffer-text)` from `(point)`
  via the pure `next/prev-section-offset`), not reftex-dependent — works
  without a built RefTeX DB.
- `latex-goto-matching-env` is C-c **%** (vim's match mnemonic; also the
  TeX comment char, free here). Section prev is C-c **C-r** (C-p was
  taken by toggle-latex-math-preview).
- Smart-quote v1 looks only at the char before point — **no math/verbatim
  detection** (documented in the command's docstring). Double-press (or a
  press right after a `"`/`` ` ``/`'`) inserts a literal straight quote.

**State**: committed on `latex-nav`, suite green. Not merged (per the
"hand off for live testing before merge" rule).

---

## [2026-06-03 overnight] swap-views / permute-views: built, needs live test + a keybinding call

**Context**: Implemented the two commands designed in
`plans/PANES-SWAP-PERMUTE.md` (number every pane, type pane numbers to
swap / permute which view each pane shows). Built bottom-up on branch
`swap-permute-views`. Full suite green throughout (**1144 tests, 0
fail**; +34 over the 1109 baseline).

**What's done and unit-tested (safe):**

- **Layer 1 — pane package** (`tree.js`, `layout.js`): `swapLeaves`,
  `permuteLeaves` (copy-on-write, identity-preserving frame moves) and
  `spiralOrder` (your clockwise-spiral-from-top-left numbering,
  furthest-out-first, stable-id tiebreak). 13 tests — incl. the exact
  orderings for L/R, T/B, 2×2 (TL→TR→BR→BL), tall-left+stacked-right;
  swap=transposition; permute∘inverse=identity; bijection guard.
- **Layer 3 — stdlib primitives** (`pane-primitives.js`):
  `permute-panes!`, `panes-in-spiral-order` (+ `swap-panes!` unchanged,
  still delegating to `paneHost.swapPanes`). 7 tests with a mock host.
- **State machine** (`move-view-state.js`): pure reducer for digit
  entry — unambiguous-prefix auto-accept (single keypress ≤9; waits only
  on a genuinely ambiguous prefix like 1 vs 10–12), Space force-accept,
  Backspace undo, bijection, permute forced-last. 14 tests.

**What's written but NOT yet verified (needs the running app):**

- `app.js`: `swapPaneFrames` / `permutePaneFrames` / `spiralOrderedLeaves`;
  `paneHost.swapPanes` repointed to the frame-move (so
  `swap-with-other-pane`, `C-x X`, now rides it too — please sanity-check
  that still works); `permutePanes` + `panesInSpiralOrder` added;
  `enter-move-views-mode!` primitive; **old `swapPaneViews` deleted**.
- `move-view-mode.js`: the overlay (numbered badges + prompt strip),
  window-capture key handling, modal focus grab.
- `panes.lisp`: `swap-views` / `permute-views` commands.
- `menu.js`: **View menu → "Swap Views…" / "Permute Views…"** (the
  primary entry point).
- `styles.css`: overlay/badge/prompt styling + beep shake.

**Please live-test (per our test-before-merge rule — do not merge on
tests-green alone):**

1. View menu → *Swap Views…* with ≥2 panes: badges appear top-left of
   each pane, numbered clockwise-spiral from the top-left pane; type two
   numbers, Enter swaps them; Esc/`C-g`/backdrop-click cancels; Delete
   undoes.
2. *Permute Views…*: it walks pane 1→?, pane 2→?, …; each badge shows
   `k→d` as assigned; the last is auto-filled; Enter applies all at once.
3. **The whole point — a browser/pdf/shell pane must NOT reload/blank
   when moved** (frame-move). Put a live page in one pane, swap it,
   confirm it survives.
4. **Two things I couldn't verify and am least sure about:**
   - *Badge z-order over a focused `<webview>`.* The overlay is
     z-index 60 and grabs focus, but a `<webview>` guest can paint over
     sibling DOM. If badges are hidden behind a browser pane, we may need
     to dim/cover the webview while the overlay is up.
   - *Multi-digit over a focused browser.* Menu entry focuses the editor
     first (releasing the key grab) and the overlay re-grabs focus, so
     digits should reach the window — but this is the exact "webview
     swallows keys" hazard, worth a direct check.
   - Minor edge: if the host is resized *during* entry, badge numbers use
     the entry-time layout while the apply re-derives spiral order — a
     mismatch is possible. Rare (modal, brief); flagging only.

**Decision I need from you — keybindings (deliberately left unbound).**

I did not bind `swap-views` / `permute-views` to keys — that's
user-facing taste, and binding blindly risks annoyance. They're reachable
via the View menu and `M-x`. Free `C-x` slots: `C-x 4`–`C-x 9`.

- **Options**: (a) leave menu/`M-x` only; (b) bind under `C-x` digits
  (e.g. `C-x 4` swap, `C-x 5` permute) — but `4`/`5` are Emacs
  other-window/other-frame prefixes, so this diverges from muscle memory;
  (c) a small mnemonic prefix of your choosing.
- My lean: (a) for now — the menu is the right primary path anyway, since
  the commands are most useful when a browser pane is focused and would
  swallow a chord. Tell me which you want and I'll wire it in `keymap.lisp`.

**State of the work**: branch `swap-permute-views`, 5 commits off `main`
(`6e502a9` spec is already on `main`). Nothing half-done; tree clean;
suite green. Ready for your live test, the keybinding call, then merge.

---

## [2026-06-11 00:00] desktop-logic-tests: unit tests for electron-free desktop modules (2 of 4 targets covered)

**Context**: Overnight test-only task — add unit tests for currently-untested
electron-free modules under `apps/desktop/src/`. Branch `desktop-logic-tests`,
no `src/` touched.

**Covered (both green)**:
- `view-warehouse.js` → `test/view-warehouse.test.js` (14 tests). Fake-DOM
  harness with real re-parenting semantics; pins reuse-vs-rebuild, document
  order, snapshot semantics of `warehouseContents`, the lazy element cache,
  and the missing-`#view-warehouse` throw.
- `jmarkdown.js` → `test/jmarkdown.test.js` (14 tests). Drives real harmless
  commands (`cat`/`tr`/shell `exit`); pins stdin-only delivery (the
  shell-injection-safety property), stderr/exit-code error shapes, the
  no-command guard, and "never rejects".

Desktop suite: 314 → 342 pass, 0 fail (both `node --test` and
`pnpm --filter @editor/desktop test`).

**Skipped (could NOT import without changing production config — flagging, not
guessing)**:
- `splash.js` imports `@editor/renderer`; `move-view-mode.js` and
  `add-pane-mode.js` import `@editor/pane`. Neither package is a declared
  dependency of `apps/desktop/package.json` (only `@editor/view` is) and
  neither is symlinked into `apps/desktop/node_modules`, so they fail to
  resolve under `node --test` (`ERR_MODULE_NOT_FOUND`). Importing them in a
  test would require adding `@editor/renderer` / `@editor/pane` to the desktop
  package's deps — a production manifest change, out of scope for a test-only
  task. If you want these covered, the clean fix is to add those two as
  `workspace:*` deps of `apps/desktop` (they're already real workspace
  packages); say the word and I'll do it on a follow-up branch. The pure
  digit-entry state machine behind `move-view-mode` is already fully tested
  in `test/move-view-state.test.js`.

**Gap noted in jmarkdown coverage**: the 5s render-timeout path (`TIMEOUT_MS`,
SIGKILL → `{ error: 'JMarkdown render timed out' }`) is not exercised — the
limit is a fixed internal constant, not injectable, so a real test would have
to wait the full 5s. Left uncovered deliberately (commented in the test file).
If you'd like it tested, exposing `TIMEOUT_MS` as an optional parameter would
make a fast test possible — but that's a `src/` change, so I didn't make it.

No bugs found; all observed behaviour matched the modules' doc comments.

---

## [2026-06-13] D5 attribution: RESOLVED — citeproc taken under AGPL-3.0 arm

**Decision (Jason)**: take the AGPL arm for `citeproc`.

**Verification**: citeproc's own `LICENSE` text grants "CPAL ... OR ...
the GNU Affero General Public License (AGPL) ... either version 3 of the
AGPL, or (at your option) any later version" — i.e. **AGPL-3.0-or-later**.
The npm `package.json` SPDX field `AGPL-1.0` is inaccurate. AGPL-3.0 is
GPL-3.0-compatible (section 13 of each permits the combined work), so D5's
"nothing GPL-incompatible ships" acceptance is now satisfied.

**Landed on main** (not via the stale `attribution` branch, which was 127
behind with an obsolete 22-line LICENSE stub — main already carries the
full GPL-3.0 text):
- `ATTRIBUTION.md` — full inventory; the citeproc flag is replaced with the
  resolved AGPL-3.0 note (compatibility reasoning, SPDX-metadata caveat,
  corresponding-source pointer, §13 network-clause non-issue).
- `licenses/AGPL-3.0.txt` — canonical AGPL v3 text we convey for the
  citeproc portion.
- `licenses/citeproc.LICENSE` — citeproc's copyright + dual-license notice,
  verbatim.

The original 2026-06-10 blocker write-up survives in tag
`archive/attribution`. ATTRIBUTION.md's dependency inventory reflects the
2026-06-10 audit; a from-scratch `pnpm licenses list` re-audit before
release would be a sensible (separate) follow-up.

---

## [2026-06-22 10:30] Model-B/Phase-0: server in utilityProcess + one client; latency proven (~0.3 ms round-trip)

**Context**: Phase 0 of `plans/MULTI-WINDOW-MODEL-B.md` — the make-or-break
feasibility spike for Model B (central Lisp server, windows as clients).
Goal: stand up the Lisp server in an Electron `utilityProcess`, make ONE
window a client over a `MessageChannelMain` port, and MEASURE typing
latency (local-echo + server-confirmed round-trip) vs today's in-renderer
baseline. No multi-window. Built entirely on branch `multi-window-b` in the
`godot-mw-b` worktree.

**What the prototype does** (all under `apps/desktop/mwb/`, isolated from
app.js/view.js so the real editor + its suite are untouched):
- `server.js` — the authoritative model in a `utilityProcess`. Hosts the
  REAL `createInterpreter` (@editor/lisp) + a REAL L2 buffer (@editor/buffer).
  A self-insert intent routes through `interpreter.call(...)` and mutates the
  buffer; the buffer's `onChange` forwards each L1 change
  (`{start,removed,inserted}`) to the client as a wire delta. The L1 change
  shape IS the delta — no new encoding needed.
- `launch.js` — a STANDALONE Electron entry (NOT the real main.js). Forks the
  server, opens the harness window, creates ONE `MessageChannelMain`, hands
  port1 to the server (over `parentPort`) and port2 to the renderer (over
  `webContents.postMessage`). Client↔server then talk DIRECTLY — no main hop
  on the hot path.
- `preload.mjs` — tiny; re-dispatches the transferred `MessagePort` into the
  page; exposes `MWB_AUTOBENCH`.
- `harness.html` + `client.js` — a minimal text view rendering from a LOCAL
  STRING MIRROR (deliberately NOT view.js). Local-echo self-insert paints
  immediately, sends the intent up, reconciles the server delta. Instruments
  three latencies via `performance.now()` and a 200-keystroke benchmark.
- `protocol.js` (+ `.test.js`, 9 cases) — DOM-free message tags + delta-apply
  / optimistic-prediction helpers.

**The latency numbers** (M-series mac, dev build, 2 stable runs, n=200 each):

| metric      | mean   | p50   | p95   | p99   | max    |
|-------------|--------|-------|-------|-------|--------|
| local-echo  | ~8.3ms | 8.3   | 9.1   | 9.4   | 9.4    |
| round-trip  | ~0.3ms | 0.3   | 0.4   | 0.5–0.6 | 0.6–0.7 |
| baseline    | ~8.3ms | 8.3   | 9.2   | 9.4   | 9.4    |

- **round-trip** = keydown → intent over the port → server runs the real
  interpreter + mutates the real buffer → delta back → client reconciles.
  **~0.3 ms, p99 < 0.6 ms.** This is the decisive number: crossing the
  `utilityProcess` boundary and back, through the real Lisp machinery, costs
  ~2% of a single 16 ms frame.
- **local-echo** (~8.3 ms) and **baseline** (~8.3 ms, server OFF = today's
  all-local model) are STATISTICALLY INDISTINGUISHABLE — both are gated by the
  same `requestAnimationFrame`→paint quantum (half a 16.7 ms frame). i.e. the
  central server adds NO perceptible typing latency: local echo paints on the
  same frame today's model would, and the server confirms an order of
  magnitude faster than one frame.

Reproduce:
`cd apps/desktop && MWB_AUTOBENCH=1 ./node_modules/.bin/electron mwb/launch.js --user-data-dir=/tmp/godot-mw-b-userdata --enable-logging=stderr`
(prints the table to stderr and quits). Or launch without the env var and
click "Run 200-keystroke benchmark" in the window.

**Where the model/render split got hard** (the part to weigh against the
latency win): the latency question is ANSWERED and the answer is good, BUT
this spike deliberately did NOT attempt the real split. The hard parts the
plan (§5 "genuinely hard refactor", §8) flags are real and untouched:
- The spike renders from a trivial `<pre>`+cursor painter. The REAL client
  must drive the existing `view.js` stack (tree-sitter highlight, folding,
  measurement, overlays, math preview, minimap, toolbar) from a buffer MIRROR
  instead of the live buffer. `view.js` reads the buffer SYNCHRONOUSLY in many
  places; converting it to "render from a replicated mirror + apply deltas" is
  the largest single refactor in the codebase. My latency number says the
  PROTOCOL is cheap; it says NOTHING about how long that refactor takes or how
  many regressions it risks.
- Measurement conversation (§5d): the spike's server owns the buffer but the
  spike never needed the client's pixel measurements (wrap, line height,
  `window-start`). The real server owns scroll DECISIONS while the client owns
  MEASUREMENT — that round-trip is unbuilt and fiddly.
- Only self-insert + backspace are wired. The whole `defcommand`/keymap
  surface, minibuffer state machine, multi-cursor, markers/overlays over the
  wire, and undo policy (server-side, shared) are unbuilt.
- Interruption (§7.2, Phase 1) is unbuilt: a `(while #t)` in the shared server
  hangs the (one) client. Mandatory before living in the shared model, but not
  needed to answer the latency question.

**Feasibility verdict (for the A-vs-B bake-off)**: Model B PASSES its
existential test decisively. The plan's stated non-starter condition — "if
local-echo + round-trip doesn't feel native, Model B is dead" — does not
trigger: round-trip is sub-millisecond and local-echo is frame-identical to
today. The `utilityProcess` + `MessageChannelMain` topology works exactly as
the plan hoped (direct client↔server channel, no main hop, real interpreter
off the UI thread). So latency is NOT the thing that should kill Model B.

The remaining risk is entirely COST/RISK, not responsiveness: the
view.js-renders-from-a-mirror refactor (§5) is large and the measurement
conversation (§5d) is subtle. My honest read: Model B's *integration ceiling*
(one buffer in N windows for free, shared world, global live customization) is
genuinely higher than Model A's, and the latency objection is now off the
table — but the decision should be made on appetite for the model/render
split, which this spike intentionally did not pay down. If that refactor is
acceptable, Model B is viable and more powerful; if you want shippable-soon
with low risk, Model A remains the safe answer. The bake-off is now a cost
question, not a latency question.

**State of the work**: branch `multi-window-b`, worktree `godot-mw-b`, clean,
existing suite green (432 desktop tests, +9 spike protocol tests). Four
commits on top of the plan seed:
- `feat(mwb): add Model-B Phase-0 wire protocol + delta helpers`
- `feat(mwb): stand up server (utilityProcess) + one client + latency harness`
- `feat(mwb): add headless auto-bench (server + baseline passes)`
- (this note)
NOT merged. Instrumentation is isolated in `apps/desktop/mwb/` behind the
harness UI / `MWB_AUTOBENCH` flag; nothing in production app.js/view.js was
touched.

---

## [2026-06-22 12:30] mwb-interrupt: cooperative C-g interrupt + step budget on the Lisp trampoline

**Context**: Model B §7.2 calls the step-budget/`C-g` interrupt *mandatory before
living in a shared model* — one runaway command must not hang every window. Built
it on the interpreter in `packages/lisp` (worktree `godot-mw-b-interrupt`, branch
`mwb-interrupt` off `multi-window-b`). Scoped to the interpreter only; the server
wiring (`apps/desktop/mwb/`) is deliberately untouched — that's a later step.

**What was built (the API)**:
- `LispInterrupt` (in `values.js`) — a subclass of `LispError`. Raised when an
  interrupt-check fires or the step budget is crossed. Being a LispError, it
  unwinds through `try`/`catch`/`finally` exactly like any error (cleanup runs)
  and a Lisp `(catch e …)` *can* catch it; JS callers tell it apart with
  `instanceof LispInterrupt` or the `.interrupt === true` flag (so the server can
  distinguish "user quit" from "program failed" — e.g. don't surface a quit as a
  red error in the minibuffer).
- `interpreter.setInterruptCheck(fn | null)` — installs a cooperative check. The
  eval trampoline calls `fn()` roughly every 4096 bounces; a truthy return aborts
  the running evaluation with `LispInterrupt('quit')`. `null` (default) removes it.
  `fn` is arbitrary — exactly what the server needs.
- `interpreter.setStepBudget(n | Infinity)` — a per-top-level-form bounce ceiling;
  exceeding it throws `LispInterrupt('step budget exceeded (n steps)')`. `Infinity`
  (default) = no limit. Bounds runaway computation even with no external signal,
  and bounds deep *non-tail* recursion before it can stack-overflow.
- Also exported from `@editor/lisp`: `setInterruptCheck`, `setStepBudget`,
  `resetStepCounter`, and `LispInterrupt` (via the values re-export).

**How it works / how to drive it**: state lives as module-level vars in `eval.js`
(like the existing `currentLocation`): an interrupt-check (default null), a step
budget (default Infinity), a step counter. The `evaluate` trampoline does
`stepCount += 1; if ((stepCount & 4095) === 0) interruptPoint();` at the top of
every bounce — one add + a masked test on the hot path; the actual function call
(`interruptPoint`) runs only every 4096 bounces. The counter resets per top-level
`evaluate(source)` and per `call(name, …)` (the keystroke path), so the budget is
per-command, not lifetime. `createInterpreter` resets check→null, budget→Infinity,
so one interpreter's state can't leak into the next (a respawned server starts clean).

**Defaults are a true no-op**: with no check and no budget, results are identical
and there are no spurious interrupts (tested: a 1,000,000-iteration loop — far more
than the 4096 check interval — completes unchanged). The existing 238 lisp tests
and the full `pnpm test` (incl. 478 desktop) stay green; +16 new interrupt tests.

**How the later server wiring should set the check (the SAB/Atomics plan)**:
The server (utilityProcess) owns the single interpreter. The client sets a flag on
`C-g` that the server's trampoline reads with zero IPC latency via a shared
`SharedArrayBuffer`:
1. Allocate `const sab = new SharedArrayBuffer(4); const flag = new Int32Array(sab);`
   in the server; pass `sab` to each client (it's transferable across
   `MessagePort`/`postMessage`; a `utilityProcess` can share it).
2. Server: `interpreter.setInterruptCheck(() => Atomics.load(flag, 0) !== 0)`.
3. Client `C-g`: `Atomics.store(flag, 0, 1)` (set from the renderer/preload).
4. Server, *after* catching a `LispInterrupt` from a command (and before running the
   next), clears it: `Atomics.store(flag, 0, 0)`. Clearing belongs on the server
   side, right where it resets per-command state, so a stale quit can't abort the
   next command. (Per-client quit could use one slot per client, or a single shared
   slot if any C-g aborts the in-flight command — pick when wiring; the API doesn't
   constrain it.)
   Also call `interpreter.setStepBudget(N)` with a generous N as a backstop so a
   runaway with no C-g still terminates.
   Note: SAB needs cross-origin isolation in a renderer (COOP/COEP); in a
   utilityProcess server (Node context) it's unconstrained — another point for the
   §3(i) utilityProcess placement.

**State of the work**: branch `mwb-interrupt`, worktree `godot-mw-b-interrupt`,
working tree clean, suites green (254 lisp, full `pnpm test` green). One commit on
top of the `multi-window-b` tip:
- `feat(lisp): cooperative interrupt + step budget on the trampoline`
NOT merged — the orchestrator merges `mwb-interrupt` into `multi-window-b`. Changes
confined entirely to `packages/lisp` (`values.js`, `eval.js`, `interpreter.js`,
`index.js`, new `test/interrupt.test.js`); nothing in `apps/desktop/mwb/` touched.

---

## [2026-06-22 ~14:00] mwb-c-g/SAB finding: SharedArrayBuffer does NOT cross the utilityProcess boundary

**Empirical result (probed, then discarded):** `utilityProcess.postMessage(sab)`
throws **"An object could not be cloned"** — Electron's structured clone rejects
a `SharedArrayBuffer` across the utilityProcess (separate OS process) boundary.
A Worker-thread probe was also explored. So the planned cross-process interrupt
flag (client `Atomics.store`, server `Atomics.load`) is **not viable as-is**
between the renderer/main and the server utilityProcess.

**Why this is NOT a blocker — the safety floor is already covered.**
`setStepBudget(n)` (Wave 1, in the interpreter) bounds runaway / infinite
computation with **no external flag** — an infinite loop throws `LispInterrupt`
after N trampoline bounces. So Model B cannot *permanently* hang on a runaway
command today; the safety-critical case is handled.

**Interactive C-g (abort a long-but-finite command) — the path, DEFERRED.**
Run the interpreter on a **Worker thread inside the server process**: SAB shares
across threads in one process, so the server's main thread (free, because eval
runs on the worker) receives the C-g message, sets the SAB flag, and the
worker's eval polls it via the existing `setInterruptCheck`. This is a real
refactor (eval → worker thread) and is a refinement, not on the critical path.

**Recommendation:** ship the step-budget as the v1 safety mechanism; treat
interactive cross-process C-g as a follow-on (Worker-thread eval). Do not spend
more time trying to make SAB cross the utilityProcess boundary directly — it
doesn't.

**Operational note:** probe scripts must wrap process-boundary experiments in
try/catch — an uncaught throw in the MAIN process pops an Electron error dialog
on the architect's screen. Prefer `node --test` / caught failures over raw
electron probes.
