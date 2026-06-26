# Architect notes

Running log for decisions/blockers that need Jason. Newest first.

---

## [2026-06-23] Citations + RefTeX online server-side — the last big model-heavy stdlib family, the one you write with. Gated, flag-off byte-for-byte.

**Done + committed on `multi-window-b` (NOT merged). Suite GREEN 816 desktop**
(was 797; +10 citation-bridge, +9 reftex-flow), full root suite green (storage
63 / lisp 254 / buffer 70 / view 48 / renderer 800 / stdlib 882 / desktop 816).
All work is under `apps/desktop/mwb/` (server-side, only runs under
`GODOT_SERVER=1`) — flag-off untouched.

**The prior network-stalled attempt's one obstacle — module resolution — is
resolved.** The citation host primitives are NOT re-implemented against
`@citation-js/*` from `/tmp`. The renderer's OWN `citation.js`
(`packages/renderer/src/citation.js`) + its vendored bundle
(`packages/renderer/vendor/citation-js.esm.js`) are **pure ESM, no
DOM/Electron**, so the headless server imports the SAME module the renderer
uses — a fixed relative path into the repo, resolving against the repo's
installed/vendored modules exactly like the renderer. Verified: a real BibTeX
entry APA-formats to the exact `Smith, J. (2020). A Study of Things. Journal of
Testing, 7, 1–10.` server-side under bare `node`. (The `@citation-js/*` node
modules DO also resolve from `apps/desktop` — confirmed — but reusing the
production `citation.js` is more faithful + simpler, so that's the path taken.)

**What now works server-side (the daily LaTeX-with-citations workflow):**
- **The citation bridge** (`citation-bridge.js`): `citation-parse` /
  `-parse-lenient` / `-format` / `-format-bibliography` / `-keys` / `-entries`
  / `-format-entries` / `-format-keys` / `-register-style!`, bodies mirroring
  app.js's (same `apa`/`text`/`en-US` defaults + absence convention). 10
  `node --test` cases (parse, exact APA string, keys, entries projection,
  subset formatting, lenient).
- **cite.lisp + the full RefTeX R1–R3 chain** (`reftex.lisp` /
  `reftex-refs.lisp` / `reftex-cite.lisp`) load verbatim via the
  primitive-split. New host primitives backing them: the PURE
  `createLatexPrimitives` (latex-scan / path-*), real `file-exists?`
  (statSync), real `list-directory-paths` (readdirSync, was a NIL stub), the
  view→file mapping (`view-file-path` / `view-buffer` / `view-directory` via
  `entryForView`, matched by buffer identity), `open-file-path!` (visitFile).
  reftex's `latex-master-file` redefinition is the sole one — latex-compile.lisp
  (run-process!/PDF/SyncTeX/utility-dock) is deliberately NOT loaded.
- **The cite/ref pickers ride the generic G0b PICKER channel** (as the G0b
  note predicted). The three bespoke openers (`open-reftex-select!` /
  `open-reftex-cite-format!` / `open-reftex-cite-select!`) are `picker-read`
  calls over JS row-providers that marshal the Lisp candidate accessors into
  the `{label, value, group, detail}` wire shape; a choice resumes the
  matching reftex callback, a nil cancel its `-on-cancel`. The command bodies
  are UNCHANGED.

**Proven end-to-end headless** (`reftex-flow.test.js`, 9 cases, a real
`doc.tex` + `refs.bib` in a temp dir, through the REAL run-command):
- **C-c [** `reftex-citation` → format-menu PICKER → `\cite`/`\citep` choice →
  cite-entry PICKER (rows from the REAL CSL pipeline — the filter blob carries
  "Jones"/"Big Book", proving citation.js actually parsed the bib) → inserts
  `\cite{smith2020}` / `\citep{jones2018}` at the origin. Cancel inserts nothing.
- **C-c )** `reftex-reference` → label PICKER (names + type groups) → inserts
  the type-aware macro: `\eqref{eq:einstein}` for the equation, `\ref{sec:intro}`
  for the section. Cancel inserts nothing.
- **C-c (** `reftex-label` → minibuffer → `\label{my:newlabel}`.
- `reftex-reparse` scans 1 file, 2 labels.

**Commits (4, this branch, NOT merged):**
- `b2f0b1f feat(mwb): server-side citation host bridge (cite/RefTeX foundation)`
- `7ae2b9f feat(mwb): load cite.lisp + the RefTeX R1-R3 chain server-side`
- `e558a95 feat(mwb): bridge the RefTeX cite/ref pickers to the generic PICKER channel`
- `7031d46 test(mwb): prove reftex-citation / -reference / -label flows server-side`
- (this notes + PRIMITIVE-SPLIT.md update commit)

**Deferred (honest — bespoke-panel affordances, not the daily path):**
- **SPC-peek** in the label picker + **`m` multi-key marking** in the cite
  picker. The generic PICKER is choose-or-cancel, so the SINGLE-choice path
  (the common case — cite one key, ref one label) is fully wired; multi-mark
  inserting `\cite{k1,k2,…}` and peek-without-dismiss are render-side
  follow-ups (the channel would need the additive multi-select the G0b note
  already sketches).
- **The bottom-dock LIVE cite preview panel** (the formatted-reference panel
  the bespoke `open-reftex-cite-select!` paints) — render-side; the server
  ships the cheap index + formats the shown subset on demand, but the panel's
  DOM is a render slice.
- **latex-compile.lisp + latex-synctex.lisp + latex-menu.lisp** — the
  compile/view loop (`run-process!`, PDF view, SyncTeX) is a process/render
  slice of its own; reftex doesn't need it (its `latex-master-file` stands
  alone), so it's out of scope here.

**YOU VERIFY LIVE** (GUI launch is permission-blocked for the agent): with
`GODOT_SERVER=1`, open a `.tex` with a `\bibliography`, put point where you'd
write, **C-c [** → pick a format → pick an entry → `\cite{key}` lands; **C-c )**
→ pick a label → `\ref`/`\eqref` lands; **C-c (** → `\label{...}`. (The
PICKER channel is already wired into the real server-view per the prior
slice, so the cite/ref rows surface in the same panel as C-x C-b.) Flag-off:
no change.

---

## [2026-06-23] Server-view usability layer: multi-file in the REAL server-view (open/switch re-mirrors) + more of the keymap. Gated, flag-off byte-for-byte.

**Both done + committed on `multi-window-b` (NOT merged). Suite GREEN 797
desktop** (was 779; +6 Part 1, +12 Part 2). Every change is additive + gated on
`window.host.serverMode` (false by default) — flag-off untouched.

**What's now usable in the running app (GODOT_SERVER=1):**
- **Opening / switching files in the server-view works.** find-file (C-x C-f),
  C-x b switch-to-buffer, C-x k kill-buffer change the server's focused buffer,
  the server pushes a fresh SNAPSHOT (new bufferId), and the REAL `<text-view>`
  now re-mirrors + re-renders the new file — you see and edit what you opened.
- **More everyday keys dispatch server-side** (see Part 2 list): C-o, C-t, M-m,
  M-a/M-e, M-k, M-q, M-g, M-r, C-=, C-x C-x, C-x h, C-x ;.

### Part 1 — multi-file in the real server-view
The CLIENT switch logic was already correct + tested: `src/server-view-client.js`
`onSnapshot` detects a new `bufferId`, rebuilds the `ClientBuffer` mirror, and
re-mounts the view (test "a SNAPSHOT with a new buffer id rebuilds the mirror +
re-mounts the view"). The server side was also done: find-file/switch/kill all
call `resyncClientToCurrentBuffer` → `sendSnapshot` with the new id (server.js).

**The real gap was DOM-side in app.js `mountServerView`:** on a switch the client
calls `view.destroy()` (the inner editor removes its OWN root) then `mountView()`
again — but the old `<text-view>` host element was NEVER removed from
`#godot-server-view-host`. So a dead empty `<text-view>` accumulated per switch
and stole flex-column layout from the live view (the prototype sidestepped this
by re-pointing ONE persistent container; the custom-element equivalent is to
sweep stale views).

**Fix:** new `src/server-view-mount.js` `clearStaleServerViews(hostEl)`
(dependency-free, 6 unit tests in `test/server-view-mount.test.js`), called from
`mountServerView` before appending the new view → exactly one live `<text-view>`
across any number of switches. Per-buffer point is preserved (it rides the
SNAPSHOT's `point`, applied by the mirror — unchanged).

**Verify live (architect — GUI is permission-blocked for the agent):**
1. The extended self-test now also proves the real-app switch:
   ```
   cd apps/desktop && GODOT_SERVER=1 ./node_modules/.bin/electron \
     mwb/server-view-selftest.js \
     --user-data-dir=/tmp/godot-g2-selftest --enable-logging=stderr
   ```
   Expect `[g2-selftest] buffer-switch-remirrors: PASS` + `[g2-selftest-done] PASS`.
2. By hand in the real app: launch with `GODOT_SERVER=1`, `C-x C-f` a file →
   it should display + be editable; `C-x b` back → the original returns. In
   DevTools, `window.__godotG2.textViewCount()` must stay `1` after each switch.

### Part 2 — more of the keymap (spine.js)
Bound the obvious gaps vs production `keymap.lisp`, all loadable through the
primitive-split (editing.lisp / kill.lisp / expand-region.lisp + the real
`createBufferPrimitives`), so each resolves + runs through the real run-command:
- **Top-level KEYMAP:** `C-o` open-line, `C-t` transpose-chars, `M-m`
  back-to-indentation, `M-a`/`M-e` backward/forward-sentence, `M-k`
  kill-sentence, `M-q` fill-paragraph, `M-g` goto-line, `M-r` replace-string,
  `C-=` (`C-equal`) expand-region.
- **C-x map:** `C-x C-x` exchange-point-and-mark, `C-x h` mark-whole-buffer,
  `C-x ;` comment-line.
- 13 `node --test` cases (`mwb/spine.test.js`), each driving the KEY through
  `handleKey` (the real keymap path), assertions on the buffer.

**Deferred / not done:** `C-x C-o` delete-blank-lines (the command isn't defined
in any loaded lisp file — NOT loadable, so not bound). The leaf-flip is untouched
(reserved for the architect's call). `M-d`/`M-backspace` were already bound.

**Commits (4, this branch, NOT merged):**
- `1a75aca fix(mwb): keep one live <text-view> across a server-pushed buffer switch`
- `30c4095 test(mwb): self-test the real-app buffer switch re-mirrors + stays one view`
- `e9f546f feat(mwb): bind more everyday commands in the spine's focused keymap`
- (this notes commit)

---

## [2026-06-22] Two server-mode usability fixes: global-router stand-down (undo bell) + screenful scroll (C-v/M-v). Both gated, flag-off byte-for-byte.

**Both done + committed on `multi-window-b` (NOT merged). Suite GREEN 779
desktop** (was 759; +5 Part 1, +15 Part 2), all packages green. Every change is
additive + gated on `window.host.serverMode` (false by default) — flag-off is
untouched.

**Commits (2, this branch):**
- `6d662f4 fix(mwb): global key router stands down in server-mode (kills the undo bell)`
- `80ad13a feat(mwb): screenful scroll (C-v/M-v) via a client VIEWPORT report`

### Part 1 — the global key-router defers in server-mode (the undo `C-/` bell)
**The bug:** under `GODOT_SERVER=1` the server-driven `<text-view>` overlay is
the sole dispatcher, but the legacy window-level global router (app.js ~6010)
only stood down via `event.defaultPrevented` — a FOCUS-DEPENDENT guard. The
overlay's keydown listener only fires when the overlay is focused; when DOM
focus drifts to `<body>` (after a minibuffer/picker closes — `refocusServerView`
uses a `requestAnimationFrame`, so there's a window where focus is on body; also
after a DOM rebuild / programmatic switch), the overlay never `preventDefault`s,
so the global router ALSO runs: `C-/` dispatches server-side AND re-runs against
the idle in-renderer buffer → its undo on an empty buffer rings the bell.

**The fix:** a pure, focus-INDEPENDENT gate `shouldGlobalRouterDefer(serverMode,
serverViewMounted)` (new `src/server-router-gate.js`, 5 unit tests). Once the
server view is mounted, the window keydown router AND the paste handler return
early — the server owns dispatch, period; no reliance on `preventDefault`.
Flag-off it is always `false` (serverMode false) → the router runs exactly as
today. (Gated the paste handler too: same dual-dispatch class — in-renderer
`yank` would mutate the idle editor.)

**YOU VERIFY LIVE** (I can't launch GUI Electron): with `GODOT_SERVER=1`, the
**undo bell is gone** — `C-/` (and `C-x u`) undo right after a minibuffer/M-x or
picker closes no longer rings the bell on the idle in-renderer buffer; undo
still works (server-side). Flag-off: behaviour identical to today.

### Part 2 — screenful scroll (C-v / M-v)
A screenful needs the pane's visible line count — only the client knows it
(plan §5d). Added a **VIEWPORT up-message**: the client measures
`view.pageLines()` and reports `{ lines }` on mount (+ a rAF re-measure once the
layout settles) and on window resize; the server stores it per client.

**Server side:** `page-lines` host primitive returns the active client's
screenful (`screenfulStep` = visible lines − 2 context, min 1, 1-line fallback
until the first report). The **verbatim `editing.lisp` `scroll-up`/`scroll-down`
then `(range (page-lines))` cursor-down!/up!** — moving point by a screenful,
which makes the client follow-scroll on the resulting CURSOR update (so C-v/M-v
scroll with **no new down-channel message**). Bound `C-v`→scroll-up,
`M-v`→scroll-down in the spine keymap. This is maximally production-faithful: the
exact same Lisp commands as the real app, only `page-lines` reads the wire
instead of `editorView.pageLines()`.

**Files:** `protocol.js` (MSG.VIEWPORT + pure `screenfulStep`/
`screenfulScrollLine`), `spine.js` (per-client viewport + `setViewport`/
`viewportOf` + `page-lines` + C-v/M-v binds), `server.js` (VIEWPORT case),
`server-view-client.js` (`reportViewport` on mount/resize, injected
`subscribeResize`), `app.js` (wires `subscribeResize` to window resize, inside
the serverMode boot).

**Tests (node --test):** 6 pure-math (protocol), 5 spine (REAL C-v/M-v move
point by a screenful, clamp at both ends, 1-line fallback when unmeasured), 4
client (report on mount, re-report on resize, drop a 0-measure, unsubscribe on
destroy).

**YOU VERIFY LIVE:** with `GODOT_SERVER=1`, `C-v` pages DOWN one screenful,
`M-v` pages UP; after resizing the window the page step tracks the new height.
(The pixel measurement `view.pageLines()` is the part only a live run can
check.) Flag-off: no VIEWPORT, no page-lines on the wire — unchanged.

**Nothing deferred from the brief.** Both parts fully wired + tested. NOT merged
— handed back. Next per the brief: more stdlib + the leaf-flip (G3).

---

## [2026-06-22] G2 — ONE real renderer view now routes through the server behind GODOT_SERVER=1; flag-OFF is byte-for-byte today

**The first moment the REAL renderer is a CLIENT of the server.** With
`GODOT_SERVER=1`, one real `<text-view>` (the real `createEditorView` + the
real highlighters + the real `keyEventToString`) mounts on a `ClientBuffer`
mirror and is driven entirely by the server: it opens the server's seed buffer
through a HELLO/SNAPSHOT, renders FROM the mirror, and routes its keystrokes to
the server (key → intent → server command → delta/view-update → mirror →
re-render), with local echo for self-insert. With the flag unset (the default),
none of this runs — the in-renderer interpreter drives everything as today.

**What G2 wired (3 commits on `multi-window-b`, base was `7f5cf42`):**
- `aa8353d feat(g2): testable server-view client core` — new
  `src/server-view-client.js`: the production graduation of the proven prototype
  `mwb/view-client.js`. `createServerViewClient` takes ALL collaborators by
  injection (port, `mountView`, highlighters, `keyEventToString`) so `node --test`
  covers the whole handshake → open-buffer → mirror → key-routing wiring with NO
  Electron, against the REAL `ClientBuffer` (real `@editor/storage`). It HELLOs
  the server, builds the mirror on the SNAPSHOT, mounts a view, and routes keys
  (bare printable = local-echo SELF_INSERT; every other key = a pure KEY the
  server resolves). It reconciles echoed vs server-originated deltas, the
  motion CURSOR, the prediction-in-flight VIEW guard (the "MWxyzB" cursor-rewind
  bug the prototype documents), overlays + multi-cursor sync, buffer switch, and
  RESYNC. **17 unit tests.**
- `efa7c17 feat(g2): mount one real view as a server client behind GODOT_SERVER` —
  the production wiring in `app.js`, all gated on `window.host.serverMode`:
  - The G1 port-listener now calls a hoisted `bootServerViewClient` hook (the
    port can connect before OR after the highlighters are ready; whichever runs
    second fires the boot).
  - The late boot (right after the REAL highlighters load) defines
    `mountServerView` — it builds a REAL `<text-view>`, `configure()`s it with
    the client's `onKey` + the mirror-reading closures + the real
    highlighters/foldCaptures/tab-width/override-generation, binds the mirror,
    and reveals a dedicated full-bleed container (`#godot-server-view-host`,
    `z-index:5`) layered over the editor host — then constructs the client and
    `connect()`s it.
  - **The G2 view is a SELF-CONTAINED overlay**: it deliberately does NOT touch
    the entangled in-renderer pane tree / `ensureEditorViewForLeaf` /
    `dispatchKey` seams (see "integration friction" below). The in-renderer
    editor sits behind it, idle.
- `1c672f2 test(g2): flag-gated electron self-test for the live round-trip` —
  `mwb/server-view-selftest.js` (see "VERIFY LIVE").

**Flag-OFF is provably the old path (the ironclad rule):**
- Full `pnpm test` **GREEN: 704/0 desktop** (687 baseline + 17 new client tests),
  all packages green — the flag-off tripwire, untouched.
- Every G2 reference is gated: the init-time port listener and the entire late
  boot block (incl. `mountServerView`, the `window.__godotG2` test hook, and the
  `if (godotServerPort) bootServerViewClient()` kick) live inside
  `if (window.host && window.host.serverMode)` (false by default). The imported
  `server-view-client.js` has **no top-level effects** (only exported functions).
  Flag-off: no listener, `bootServerViewClient`/`serverViewClient` stay null, no
  container, no `<text-view>` mounts, no `__godotG2` — byte-for-byte today.
- The double-dispatch question is resolved cleanly: the G2 `<text-view>`'s own
  keydown listener calls its `onKey` (→ server intent), returns true, and
  `view.js` calls `event.preventDefault()`; the window-level global router
  (`app.js` ~5840) stands down on `if (event.defaultPrevented) return`. So a key
  typed into the focused G2 view routes ONLY to the server — the in-renderer
  `handle-key` is never also called. (This holds as long as focus stays in the
  G2 view, which it does — `view.focus()` runs on mount.)

**WHAT YOU (Jason) MUST VERIFY LIVE** — I cannot launch GUI Electron:
1. **The G2 round-trip** (the exit criteria), via the committed self-test:
   ```
   cd apps/desktop && GODOT_SERVER=1 ./node_modules/.bin/electron \
       mwb/server-view-selftest.js --user-data-dir=/tmp/godot-g2-selftest \
       --enable-logging=stderr
   ```
   Expect: `[g2-selftest] mounted-through-server: PASS`,
   `[g2-selftest] char-round-trips: PASS`, `[g2-selftest-done] PASS` (exits 0).
   It forks the REAL server, loads the REAL editor page, lets the real G2 boot
   mount a REAL `<text-view>` through the server, then types a marker and asserts
   the mirror grew by exactly the marker. (`GODOT_SERVER=1` MUST be prefixed —
   the preload reads launch-time env. The marker is typed into the seed buffer
   IN MEMORY; the test does NOT save, so nothing hits disk.)
2. **The real app, flag ON, by hand**:
   `cd apps/desktop && GODOT_SERVER=1 ./node_modules/.bin/electron .` —
   you should see a full-window editor showing the server's seed buffer
   (`packages/renderer/src/view.js` by default, or set `MWB_FILE`). **Type into
   it — that's the decisive "does it feel native?" test.** Try: typing
   (local-echo instant), motion (arrows, `C-a`/`C-e`, `M-<`/`M->`), `M-x`
   commands, the minibuffer prompt for a command, `C-y` yank, `C-/` undo.
   Console: `[godot] Model-B server port connected` then `[godot] G2: real view
   routed through the server`. (Modeline/status/minibuffer DOM CHROME is still
   the in-renderer one underneath for now — see the G2 scope note — so the
   *visible* echo-area/modeline may not reflect server state yet; the editing
   does. The server's modeline/status come down on VIEW messages and are wired
   in a later slice.)
3. **The real app, flag OFF**: `./node_modules/.bin/electron .` — identical to
   today; no `#godot-server-view-host`, no `godot-server` process.

**G2 scope (minimal + safe, as the plan asks):** ONE window/buffer edits through
the server. The text + cursor + overlays + multi-cursor + scroll all flow; M-x,
find-file, the minibuffer state machine, save, undo all work server-side (the
prototype proved them; G2 just routes the real view's keys to them). What is
DELIBERATELY still in-renderer / a later slice (G3+): the **modeline/status/
minibuffer-prompt CHROME rendering** (the VIEW message carries them; the G2 view
doesn't paint that DOM yet — it shares the in-renderer chrome), and everything
not on this one view (the pane tree, tablines, all other views/panes). Broad
coverage is G3/G4 per the plan.

**Integration friction found (the honest "here's what fights the client model"
— flagged for G3 and for your live debugging):**
- **The real mount path is one layer deeper than the prototype's.** The prototype
  calls `createEditorView` directly. The real app mounts it via the `<text-view>`
  custom element (`packages/renderer/src/text-view.js`), and configures it inside
  `ensureEditorViewForLeaf` (`app.js` ~6190). That function's per-view closures
  read `instance._boundLeaf.view.buffer/point/cursors` — i.e. a **Lisp View
  handle**, not a buffer object. To flip an EXISTING in-renderer view to a mirror
  in place, that leaf's `.view` would have to become mirror-backed AND the
  in-renderer `handle-key` would have to stop driving it — a deep change to the
  pane/leaf/Lisp-view coupling. **That is why G2 mounts a SELF-CONTAINED overlay
  view instead of flipping a leaf** — it proves "the real renderer is a server
  client" with zero risk to the entangled seams. The G3 question for you: do we
  (a) teach `ensureEditorViewForLeaf` a server-mode branch where the leaf's
  buffer is a mirror and the closures read it (then retire the overlay), or (b)
  keep a parallel server-view surface and grow it? (a) is the real graduation; it
  needs the leaf/Lisp-view model to admit a mirror-backed view — the biggest
  app.js seam.
- **Two key routers coexist under the flag.** The in-renderer global keydown
  router still runs; it's neutralised only by the G2 view's `preventDefault`
  (focus-dependent). It's correct today, but G3 should make server-mode the
  router's explicit branch (forward unclaimed keys as KEY intents) rather than
  relying on the overlay's focus + preventDefault.
- **Chrome (modeline/status/minibuffer) is shared, not yet server-driven.** The
  VIEW message already carries the server's modeline/status/minibuffer; the G2
  view doesn't render that DOM (it has no minibuffer element of its own). So under
  the flag the *visible* chrome is the idle in-renderer one. Wiring the server's
  VIEW chrome into real DOM (or giving the G2 surface its own minibuffer) is the
  first G3 slice.

**Not done (correctly — later phases):** modeline/status/minibuffer chrome from
the server, any view beyond the one, the pane negotiation (G0a proved its shape
but it's unbuilt in production), multi-window (G4). NOT merged — hand back for G3.

---

## [2026-06-22] G1 — server stood up inside the REAL main.js behind GODOT_SERVER=1; flag-OFF is byte-for-byte today

**This is the first production change of the graduation** (G0 was prototype-only).
The Model-B server now forks from the real `apps/desktop/src/main.js` and a
MessagePort connects to the renderer — **but only when `GODOT_SERVER=1`**, and
**no editing is routed through it yet** (that's G2). With the flag unset (the
default), the app is unchanged.

**What G1 wired (3 commits on `multi-window-b`, tip was `54df3f3`):**
- `f982f71 feat(g1): testable server bridge behind GODOT_SERVER flag` — new
  `src/server-bridge.js`: the wire-up extracted into pure functions + an
  injection-based factory so `node --test` covers it with NO real Electron.
  `isServerMode(env)` is the **single gate** (`GODOT_SERVER === '1'`).
  `serverModulePath()` reuses the prototype's `mwb/server.js` verbatim (plan
  §4.1 — it graduates to `src/server/` in a later phase). `createServerBridge`
  forks the server `utilityProcess` and exposes `attachWindow(webContents)`
  (per-window `MessageChannelMain` port transfer — the exact `mwb/launch.js`
  dance) + `dispose()`. Everything wrapped so it can never throw in main. 13 tests.
- `f7fb27f feat(g1): fork the Model-B server + plumb a port behind GODOT_SERVER` —
  the production wiring:
  - **main.js**: behind `isServerMode()`, fork the server (construction in a
    try/catch so a fork failure logs, doesn't crash the host); in `createWindow`,
    `if (serverBridge) serverBridge.attachWindow(win.webContents)`; `will-quit`
    disposes the server. With the flag off `serverBridge` stays `null` and all
    three references are guarded no-ops.
  - **preload.mjs**: `host.serverMode` (the single gate the renderer reads) +,
    only under `GODOT_SERVER=1`, a `godot:server-port` listener that re-dispatches
    the transferred port to the page as a window message.
  - **app.js**: only when `host.serverMode`, a window-message listener that
    stashes the connected port in `godotServerPort` for G2. **Editing is NOT
    routed through it** — G1 just proves the port connects (logs `[godot] Model-B
    server port connected`). TDZ-safe (hoisted `var`, reads only `window.host`).
- `7564d9f test(g1): flag-gated electron self-test for the live spawn + handshake`
  — `mwb/server-bridge-selftest.{js,html}` (see "VERIFY LIVE" below).

**Flag-OFF is provably the old path (the ironclad rule):**
- Full `pnpm test` **GREEN: 687/0** (674 baseline + 13 new bridge tests) — the
  flag-off tripwire. The suite exercises the flag-off path and is untouched.
- Every server entry point is gated by one of `if (isServerMode())` /
  `if (serverBridge)` (null when off) / `process.env.GODOT_SERVER === '1'` /
  `window.host.serverMode` (grep in the commit confirms — no ungated path).
  Flag-off: no `utilityProcess` forked, no port plumbed, no listener registered,
  `host.serverMode` is just a new `false` field.
- Verified the **server module itself loads + initializes cleanly under bare
  `node`** (interpreter + model + autosave stand up) — strong evidence the
  `utilityProcess` fork will boot. (Couldn't actually fork it: GUI/Electron
  launch is permission-blocked in the agent sandbox.)

**WHAT YOU (Jason) MUST VERIFY LIVE** — I cannot launch GUI Electron:
1. **The spawn + handshake** (the G1 exit criteria), via the committed self-test:
   ```
   cd apps/desktop && GODOT_SERVER=1 ./node_modules/.bin/electron \
       mwb/server-bridge-selftest.js --user-data-dir=/tmp/godot-g1-selftest \
       --enable-logging=stderr
   ```
   Expect: `[g1-selftest] server-ready: PASS`, `[g1-selftest] port-handshake:
   PASS`, `[g1-selftest-done] PASS` (exits 0). It exercises the REAL bridge + REAL
   preload re-dispatch. NOTE: `GODOT_SERVER=1` must be **prefixed on the launch**
   (the preload reads the launch-time env, not a runtime mutation) — the self-test
   bails loudly if it's missing.
2. **The real app, flag ON**: `cd apps/desktop && GODOT_SERVER=1 ./node_modules/.bin/electron .`
   — confirm it boots and edits **exactly as today** (the server is merely
   *present*; nothing routes through it). Look for `[main] GODOT_SERVER=1:
   Model-B server forked` + a renderer console `[godot] Model-B server port
   connected`. A `godot-server` process should appear (and die on quit).
3. **The real app, flag OFF**: `cd apps/desktop && ./node_modules/.bin/electron .`
   — confirm no `godot-server` process spawns and behaviour is identical to today.

**Not done (correctly — it's G2):** no `view.js` mounts on a mirror, no `KEY`
intents are sent, the in-renderer interpreter still drives everything. The port
is connected and idle. NOT merged — hand back for G2.

---

## [2026-06-22] G0b (generic PICKER channel) — COMPLETE; the buffer-list picker proves it; the other pickers map cleanly

**This closes out G0** (both structural prototypes done — G0a pane model +
G0b picker). The graduation **decision gate** is reached: neither unknown
turned out worse than the rest of Model B. Recommend proceeding to G1.

**The deliverable: ONE reusable render-side picker channel, modelled on the
minibuffer round-trip, proven on the buffer list.** Built entirely under
`apps/desktop/mwb/` behind the existing harness; production `app.js`/`view.js`/
`main.js` and `packages/*` (incl. `commands.lisp`) **untouched**.

**The channel (4 commits, this branch):**
- **protocol.js** — `MSG.PICKER` (down) + `INTENT.PICKER_CHOOSE`/`PICKER_CANCEL`
  (up). The wire request is `{ id, title, rows: [{ label, value, ...meta }],
  options }`. Pure DOM-free helpers: `normalisePickerRequest`/`normalisePickerRow`
  (shape the request, drop malformed rows, default options) + `filterPickerRows`
  (the type-to-narrow filter every client picker shares). 11 helper tests.
- **spine.js** — the **suspend/resume twin of the minibuffer**. A `picker-read`/
  `picker-delivered` continuation + `*picker-reader*` slot, defined in the
  spine's **own** Lisp prelude via `interpreter.evaluate` (NOT production
  `commands.lisp` — the channel stays inside the mwb slice). Host primitive
  `open-picker!` mints a picker id, records the request, raises `onPicker`.
  `deliverPicker(value, pickerId)` / `cancelPicker(pickerId)` resume the
  suspended command — guarded by the pickerId, so a **stale (superseded)
  picker** can't resume the wrong command.
- **server.js** — `onPicker` → `sendPickerTo` (normalised PICKER down, tracking
  `pickerClient`, the minibuffer's twin). `PICKER_CHOOSE`/`PICKER_CANCEL`
  intents → `spine.deliverPicker`/`cancelPicker`; a choice that switches buffer
  re-syncs the client through the existing `onBufferSwitched` path.
- **picker-panel.js** — ONE client-side picker UI: title, type-to-narrow
  filter, ↑/↓/PageUp/Down nav, Enter/click to choose, Escape to cancel. Holds
  **no** buffer/registry knowledge (rows are opaque), so the same panel serves
  every picker. Pure interaction core (`pickerView` selection + `moveSelection`)
  is unit-tested (9 cases). `pane-view-client.js` mounts it over a dimmed
  overlay on a `PICKER` message and reports the outcome up.

**Proven on the buffer list (the first + only real consumer):** `C-x C-b` /
`list-buffers` now opens a real PICKER over the open buffers (rows from the
`buffer-list-rows` provider: label=name, value=id, meta="Nl ●/–", current
marked) → the client renders the interactive list → choosing a row runs
`switch-to-buffer-id!` and the window switches to that buffer through the
server. End-to-end. The old `open-buffer-list!` data-only stub is superseded.

**Verification (no screen):**
- `node --test`: spine.test.js **6** picker cases (open, round-trip-switch,
  cancel, stale-id drop, C-x C-b chord dispatch) + protocol.test.js **11**
  helper cases + picker-panel.test.js **9** interaction-core cases. Full suite
  **674/0** (was 649; +25). `commands.lisp`/`view.js` **unchanged** (stdlib
  882/0, renderer 800/0).
- A flag-gated **`MWB_PICKER_SELFTEST`** electron self-test drives the WHOLE
  round-trip through the REAL server intent path (C-x C-b as KEY intents →
  PICKER → stale-reply-dropped → choice → switch + re-sync → cancel-stays-put).
  Probed headlessly (stubbed parentPort): **all 12 checks PASS.**

**THE TEMPLATE MAPPING — how the other render-side pickers ride this channel.**
Each is "provide rows + an on-choose command"; the channel + panel are reused,
only the row-provider + the on-choose handler differ:

| Picker | Row-provider (server) | row `{label, value, meta}` | on-choose |
|---|---|---|---|
| **Buffer list** (built) | `buffer-list-rows` (registry) | name / buffer-id / "Nl ●/–" | `switch-to-buffer-id!` |
| **`*Recover*`** | the autosave `scanRecoverable()` set (already server-side) | snapshot name / recovery-key / age + path | `recover-buffer!` (the spine already has `recoverBuffer`) — and a discard variant |
| **Completions** (find-file TAB / M-x) | the command registry / the dir listing (server owns both) | candidate / the string itself / kind icon | insert the completion / `run-command` it |
| **RefTeX select** | the RefTeX label DB (pure Lisp over buffers → server) | label / label-name / type + context; uses `row.group` for the type headings | insert `\ref{name}` |
| **Cite** | the bib DB (server) | key / cite-key / author·year·title in `detail` | insert `\cite{key}` |

All five providers' DATA already lives server-side (the registry, the recovery
scan, the command/dir lists, the RefTeX/bib DBs). So each is a few lines: a
provider that emits `{label, value, meta}` rows + an on-choose that does one
host action. The panel's `row.group`/`row.detail` fields (already in the wire
shape + normaliser) cover RefTeX's type-grouped headings and cite's
author/year second line **without** a new channel.

**The one picker that needs MORE than rows-in/choice-out — and how it's
handled: COMPLETIONS' live re-query.** Find-file TAB / M-x narrow as you type,
and the candidate SET can change with the query (find-file: typing a `/`
re-lists a new directory; M-x against the full registry is a fixed set, so it's
fine). Two tiers, both supported:
1. **Fixed-set narrowing** (M-x, the buffer list, RefTeX, cite): the full row
   set ships once in the PICKER message and the **client** narrows locally via
   `filterPickerRows` — zero extra round-trips, the common case, already built.
2. **Server-re-queried narrowing** (find-file across directories): when the
   query crosses a boundary the client needs rows it doesn't have. The channel
   extends with ONE up-message — `PICKER_QUERY { pickerId, query }` — and the
   server replies with a fresh `PICKER` (same id) carrying the new rows; the
   client swaps its row set and keeps its filter box. This is the ONLY addition
   the five pickers need, it's additive (tier-1 pickers never send it), and
   it's small. **Not built in G0b** (the buffer list is fixed-set); flagged
   here so it's designed, not discovered. Everything else is pure row-provider.

**Why this bounds the plan's #2 risk** (the render-side pickers, §8.2): the
fear was "under-design the channel → grow seven bespoke async UIs." Instead one
channel + one panel + N tiny providers, with the single genuinely-different
case (live re-query) reduced to one additive up-message. view.js unchanged; the
existing five panel DOMs (`reftex-select-panel.js`, `reftex-cite-panel.js`,
`completions-panel.js`, the buffer list, `recover-view.js`) become render-only
consumers of `picker-panel.js` at graduation.

**One naming divergence from the plan (§2.2.3):** the plan sketched a single
up-message `PICKER_RESULT { id, value | cancelled }`. I split it into two
intents — `PICKER_CHOOSE { value, pickerId }` + `PICKER_CANCEL { pickerId }` —
to match the existing minibuffer's `MINIBUFFER_SUBMIT`/`MINIBUFFER_CANCEL`
split (one less "is this a cancel?" branch, consistent with the rest of the
wire). Trivial to rename if you'd rather keep the plan's exact term.

**Decision-gate read:** G0 is done; both unknowns (pane geometry G0a, picker
channel G0b) came in as clean cuts, not entanglements. **No reason to re-open
A-vs-B.** Recommend G1 (stand the server up in real `main.js` behind
`GODOT_SERVER=1`).

---

## [2026-06-22 ~18:00] Model-B/graduation: the file-level plan to flip the REAL app — `plans/MWB-GRADUATION.md`

**Context**: An analysis + planning task, not a build. With the prototype
having retired every existential objection to Model B (latency, the render
refactor, the command/keymap/minibuffer port, multi-buffer, save+recovery,
shared undo, overlays/multi-cursor, the step-budget safety floor — all on
`multi-window-b`), I wrote the **graduation plan**: a concrete, staged, file-
level roadmap for flipping the *real* app from its per-window-interpreter
architecture to the proven server/client model. **Only change: added
`plans/MWB-GRADUATION.md` (+ this note). No app/prototype code touched. Suite
unaffected (docs only).**

**What the plan covers** (§ refs are inside the doc):
- **§1 Target architecture mapped onto real files** — three columns: MOVES to
  the server (`createInterpreter` `app.js:3467`, L1/L2 buffers, kill ring,
  `defcommand`/keymap/minibuffer, the logical view/pane model, session/project,
  file I/O direct in the Node child), STAYS client (`view.js` + all pixel
  measurement + the render widgets + the mirror + input), and SPLITS (the
  primitive-split, generalised — per-real-file table of model-half vs
  render-message-half).
- **§2 Protocol surface** — what `protocol.js` already defines vs the 5 missing
  pieces: the §5d measurement conversation's hard direction (`VIEWPORT` up),
  pane structural messages (`PANE_TREE`/`PANE_INTENT`), a **generic `PICKER`
  channel** (collapses buffer-list/`*Recover*`/completions/RefTeX/cite into one
  mechanism — the highest-leverage new piece), the native-dialog/clipboard
  server→main hop (`HOST_REQUEST`), and lifecycle/reconnect.
- **§3 Migration order** — G0 two structural prototypes → G1 server in real
  `main.js` behind `GODOT_SERVER=1` → G2 one window/buffer through it → G3 the
  long stdlib port wave-by-wave in `STDLIB_FILES` order → G4 multi-window +
  payoff → G5 flip default + delete the dead in-renderer path. Exit criteria per
  phase; **the in-renderer path stays the shipping default behind the flag until
  G5, so the app is never left long-broken.**
- **§4 Reuse vs rebuild** — `protocol.js`/`client-buffer.js`/`spine.js`/
  `buffer-registry.js`/`server.js`/`atomic-write-sync.js`/`autosave.js` graduate
  (reuse near-verbatim); fresh builds = the pane/window negotiation, the generic
  picker, `HOST_REQUEST`, the `VIEWPORT` measurement, respawn orchestration, the
  isearch state machine, the `C-g` worker thread.
- **§6 Per-feature graduation verdicts** — project/session, panes/tabline (the
  genuinely-hard one), minibuffer/completions, LaTeX/RefTeX (heavy but rides
  well; process-spawn *simplifies* server-side), bookmarks/snippets/multi-cursor
  (ride cleanly), utility pane, themes/faces, dir-tree/minimap.
- **§7 C-g**: step-budget is the done safety floor; interactive C-g is a
  Worker-thread-eval refinement (the SAB-across-utilityProcess dead-end is
  recorded). **§8 risks**, **§10 file-level diff map** (`app.js` ~10.8k→~4k,
  `view.js` no change, stdlib no change), **§11 decision list**.

**The recommendation (the handoff ask)**: **do NOT flip the real app yet —
build two more structural prototype pieces first (G0):**
1. **the pane/window model** (server-side `@editor/pane` + `PANE_TREE`/
   `PANE_INTENT` + a 2-4-pane client), and
2. **one render-side picker** (the buffer list, as the template for all the
   others, via the generic `PICKER` channel).
These are the only two unknowns whose *shape* the prototype hasn't pinned, and
they're the two with the most structural coupling in today's renderer
(`app.js:653-1610` interleaves the logical pane tree with pixel layout). Each is
a days-not-weeks flag-gated `mwb/`-style slice ending in a real decision gate —
the honest last moment to reconsider A-vs-B, with the in-renderer app still
100% intact. After G0, the flip is a long-but-legible port with no research
left.

**Decisions I need (full list in §11)**: G0-first vs flip-soon (my rec:
G0-first); adopt the single generic PICKER channel (strong rec: yes); the flag
name + the parity bar before G5 flips the default (proposal: daily-driver for a
week with no fallback); whether to merge the **`toolbar` branch** before or
after the flip (it must graduate too — `define-toolbar-*` collectors → server,
`renderActions`/`renderLens` → client — but it's not visible from this
worktree, flagged in §8); ship step-budget-only C-g v1 vs build the worker
thread up front (rec: step-budget v1).

**State of the work**: branch `multi-window-b`, clean, suite green (593,
unchanged — docs only). One commit:
- `docs(mwb): file-level graduation plan to flip the real app to Model B`
NOT merged. Only `plans/MWB-GRADUATION.md` + this note added; no code touched.

---

## [2026-06-22 ~17:30] Model-B/undo-redo: undo/redo through the server — shared, per-buffer history, ● agrees

**Context**: The next core editing capability after real-save. The server's
canonical L2 buffer holds the undo history; this slice makes undo/redo run
there and reflect to every client viewing the buffer. All on `multi-window-b`
in worktree `godot-mw-b`, isolated under `apps/desktop/mwb/` behind `MWB_*`
flags; production app.js/view.js/main.js + `packages/*` untouched; suite green.

**What undo/redo now does (proven headless)**:
- **The real L2 undo, unchanged.** editing.lisp's `undo`/`redo` commands +
  the `undo!`/`redo!` buffer primitives already loaded verbatim in the spine —
  only the KEYMAP entries were missing. Bound: **undo → C-/ (`C-slash`), C-x u,
  C-S-minus**; **redo → C-S-/ (`C-S-slash`), M-S-z**. (On a US layout the `/`
  key's `event.code` is `Slash`, so C-/ normalises to `C-slash`; Emacs's literal
  C-_ is Shift+Minus → `C-S-minus`.) Undo runs through the same real
  `run-command` as every other command.
- **Text + point.** The L2 `undo()` reverts the edit, **restores point to the
  changed region**, clears the mark, and emits a change event — which fans out
  as the normal **delta** (carrying the restored point) to every client on that
  buffer. No new render path; the existing delta/cursor wire carries it.
- **Shared, per-buffer history (the Model-B payoff).** The undo stack lives
  with the canonical buffer, so an undo in window A reverts the buffer **both**
  windows see. Proven in a two-client integration test: edit in one client,
  undo from the OTHER, both mirrors revert; redo likewise; interleaved
  edits+undos from both windows never diverge. Scoped per-buffer (the delta /
  resync only reaches clients viewing the edited buffer).
- **● dirty flag agrees with undo, for free.** `isModified` is a pure
  text-vs-saved-baseline diff (the save wave's logic), so undoing back to the
  saved baseline clears ● and redoing past it sets it again with no extra code.
  Tested against both the seed baseline AND a mid-stream SAVED baseline
  (undo-to-saved is clean; undo-BEFORE-the-save is dirty).

**The one correctness point — a CHANGE-GROUP undo is lossy as a single delta,
so undo/redo RESYNCs.** A change group (join-line, fill-paragraph, snippet
expansion) is several L1 edits in one undo step. Asymmetry on the wire,
discovered + pinned by tests:
- The **forward** grouped edit emits one L2 change event PER inner edit, so the
  server's `fanDelta` (which fires on each L2 onChange) replicates it faithfully
  by fanning them all — no special handling needed.
- The grouped **undo** emits a **SINGLE** L2 delta for several inverse edits
  (the L2 `undo()` calls L1 `storage.undo()` once + emits once at the end), which
  is **lossy** — applying that one delta to a mirror leaves a stray character.
So the spine flags an undo/redo (`consumeHistoryOp()`, read-and-cleared per
intent so a no-op undo can't leak forward), and the server (`applyIntent`)
folds it into the existing multi-cursor `needsResync` branch: an undo/redo
**RESYNCs** the canonical text + each client's cursor set instead of fanning the
lossy delta. A regression test drives a grouped undo through the single-delta
path and asserts it DESYNCs — proving the resync is load-bearing.

**view.js change: ZERO (again).** Undo is a server-side command + the existing
delta/resync/cursor wire; the renderer's mirror just adopts the text + point.

**Verification (headless, no screen — `node --test`)**:
- Suite green: **593** (was 581; +12). Spine tests (spine.test.js, +7): C-/ and
  C-x u undo with point restore, C-S-/ redo, the history flag, ● vs undo against
  seed + saved baselines, bottom-of-stack no-op. Integration
  (`undo-integration.test.js`, +5): real spine ⇄ two real client mirrors,
  cross-window undo/redo, change-group edit+undo fidelity, the desync
  regression guard, interleaved non-divergence.
- Flag-gated **`MWB_UNDO_SELFTEST=1`** end-to-end self-test through the real
  Electron server (I could not launch the GUI here — permission-blocked — but
  the `node --test` path exercises the identical spine; the self-test asserts
  text+point+dirty and posts PASS/FAIL, launch.js exits on it). To run:
  `cd apps/desktop && MWB_VIEW=1 MWB_UNDO_SELFTEST=1 ./node_modules/.bin/electron mwb/launch.js --user-data-dir=/tmp/godot-mw-b-userdata --enable-logging=stderr`
  (expect `[mwb-undo-selftest-done] PASS` + exit 0).

**Deferred (honest)**:
- **Undo grouping / keystroke coalescing.** Plain typing is one undo step PER
  character (each self-insert is its own L1 change — no coalescing of a run of
  keystrokes into one undo). Emacs/Sublime coalesce; production does not appear
  to either at the L1 level. Out of scope for this slice; the per-char undo is
  correct, just finer-grained than some editors.
- **Multi-cursor undo.** Not specifically exercised. An undo collapses the
  cursor set to the primary (L2 `undo()` calls `collapseInPlace`), and the
  edit-region point is single. A multi-caret edit's undo would revert the text
  (via the resync) but not restore the secondary carets — acceptable and matches
  the L2 contract, but untested here.

**State of the work**: branch `multi-window-b`, clean, suite green (593). Two
new commits on top of the save slice:
- `feat(mwb): undo/redo through the server (shared per-buffer history)`
- `test(mwb): undo/redo proof — spine + two-client integration (headless)`
NOT merged. All isolated under `apps/desktop/mwb/` behind `MWB_*` flags.

---

## [2026-06-22 ~16:00] Model-B/save+data-safety: REAL save-to-disk (atomic) + dirty tracking + server-side autosave/recovery

**Context**: The glaring gap for a usable editor — `save-buffer` was a status
stub that wrote nothing. This slice makes the server actually write files
(crash-safe) and adds the data-safety story the SHARED model requires (unsaved
state lives in the server's memory → a server crash must not lose work). All on
`multi-window-b` in worktree `godot-mw-b`, isolated under `apps/desktop/mwb/`
behind `MWB_*` flags; production app.js/view.js/main.js + `packages/*` untouched.

**Real save (the must-have — solid)**:
- **save-buffer (C-x C-s)** writes the canonical buffer's text to its file path
  with an **atomic write** (temp file + fsync + rename), mirroring production
  `files.js`. The writer is `mwb/atomic-write-sync.js` — a SYNCHRONOUS variant of
  production's async `atomicWrite` (the save runs inside the synchronous Lisp
  command, so it can't suspend on a Promise). Production's writer is untouched.
- **write-file / save-as (C-x C-w)** prompts for a path, writes there, and binds
  the path (subsequent C-x C-s saves to it). A **path-less buffer's C-x C-s falls
  back to write-file** (prompts), exactly like Emacs's C-x C-s on a new buffer.
- **Dirty tracking**: each registry entry now carries a `filePath` + a saved-text
  baseline; `isModified` = text≠baseline (the real app's saved-baseline approach).
  An edit sets dirty; a successful save re-baselines (clears it). find-file records
  the resolved absolute path so save-back targets the right file.
- **The ● dirty indicator** is now the modeline's leading glyph (`renderModeline`):
  `●` = unsaved, `–` = clean. It clears on save (the view-update broadcast refreshes
  every window on that buffer).

**Server-side autosave + recovery (the data-safety deliverable)**:
- `mwb/autosave.js`: a **periodic timer** snapshots every DIRTY buffer to a
  recovery dir on disk (atomic, one JSON file per buffer, keyed `file:<path>` /
  `buf:<id>`), and a **recover-on-startup** scan finds snapshots worth restoring
  and **loads them back as dirty buffers**. The pure pieces reuse production
  `src/recovery.js` VERBATIM (`hashText`, `recoveryFileName`, `parseRecoveryRecord`)
  and the **which-to-recover predicate is the EXACT one `app.js scanForRecovery`
  uses** (newer-than-disk OR no-disk-file). Recovery dir = `MWB_RECOVERY_DIR` else
  a stable per-app temp dir; cadence = `MWB_AUTOSAVE_INTERVAL_MS` (default 4s).
- **What's DEFERRED** (documented, not built): the full `*Recover*` PICKER UX (a
  render-side view with per-snapshot recover/discard). The data + the wire to
  surface it are here (recovered buffers land in the registry, listable via the
  existing buffer-list slice); rendering the picker is the same render slice the
  buffer-list view stub is. Also deferred: full server respawn/reconnect UX (the
  recover-on-startup path runs on every server boot, which IS the respawn path).

**view.js change: ZERO.** Save is pure server-side I/O + the existing modeline
view-update; the renderer just shows the ● the modeline string already carries.

**Verification (headless, no screen)**:
- `pnpm test` green: **581** (was 552; +29). New: registry dirty/path (5),
  spine save/write-file/recover (8), autosave pure+temp-dir (10), the sync
  atomic writer (3), and an **end-to-end disk integration test**
  (`save-integration.test.js`, 3) that wires the spine's saveFile to the REAL
  atomic writer + a real temp recovery dir, drives save-buffer / write-file, and
  **reads the bytes back off disk** — proving bytes hit disk (atomic), ● toggles,
  and a dirty buffer's autosave snapshot lands on disk + is recoverable.
- A committed **server-side `MWB_SAVE_SELFTEST=1`** self-test does the same end-to-end
  through Electron + the real server (it owns fs, so it does the read-back). I could
  NOT run the Electron launch myself (the GUI launch is permission-blocked here);
  the `node --test` integration test exercises the identical path headlessly and
  is green. To run the Electron one interactively:
  `! cd apps/desktop && MWB_VIEW=1 MWB_SAVE_SELFTEST=1 MWB_SAVE_TARGET=/tmp/godot-mw-b-save-scratch.txt MWB_RECOVERY_DIR=/tmp/godot-mw-b-recovery-selftest ./node_modules/.bin/electron mwb/launch.js --user-data-dir=/tmp/godot-mw-b-userdata --enable-logging=stderr`
  (expect `[mwb-save-selftest-done] PASS` + exit 0).

**State of the work**: branch `multi-window-b`, clean, suite green (581). Three
new commits on top of the multi-buffer slice:
- `feat(mwb): real save-buffer + write-file (atomic) with ● dirty tracking`
- `feat(mwb): server-side autosave + crash-recovery snapshots`
- `test(mwb): headless save + data-safety proof (node --test + self-test)`
NOT merged. All isolated under `apps/desktop/mwb/` behind `MWB_*` flags.

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

## [2026-06-22] G0a (pane model) — COMPLETE; geometry cost BOUNDED (clean separation)

(Reconstructed from the committed, green work — the building agent stalled on a
network watchdog one step before writing its own finding; everything below is
committed + tested, not speculative.)

**Built (5 commits, dd9beb8 / 236f9a7 / 8223a0c / 159b28d + the client render):**
- Server-side per-window **pane tree** reusing `@editor/pane` (binary split tree;
  leaves hold a buffer + per-pane view-state; two leaves may share a buffer).
- Protocol: **`PANE_TREE`** down (layout + which buffer + view-state + focus per
  leaf) and **`PANE_INTENT`** up (split / focus-other / delete).
- The real `panes.lisp` commands run server-side: **C-x 2 / C-x 3 / C-x o /
  C-x 0 / C-x 1** drive the server's pane tree (loaded verbatim via the
  primitive-split).
- **Multi-pane client render** (`pane-view-client.js` + `pane-client-layout.js`):
  lays out `PANE_TREE` as nested split containers, each leaf a real
  `createEditorView` on its buffer mirror with the leaf's focus/view-state.

**Geometry-cost verdict (the deliverable):** the logical pane tree (server) and
the pixel split layout (client) **separate cleanly** — the server owns the tree,
which-buffer-where, and focus; the client lays out the splits from `PANE_TREE`
and renders each leaf with the unchanged `view.js`. This **bounds the graduation
plan's #1 risk**: pane geometry is a clean server/client cut, not entangled.
**Residual (small, already in the plan):** a `VIEWPORT` up-message so the server
knows each pane's pixel size for scroll-by-screenful/recenter — a client→server
message, not a blocker.

**Tests:** desktop suite **649/0** (+56 from panes; `pane-client-layout` 10/10).
**view.js: unchanged.** A flag-gated `MWB_PANES_SELFTEST` electron self-test is
committed for the architect to run by hand.

## [2026-06-22] G3 — stdlib port wave (8 files + supporting primitives), server-side only

Broadened the server spine's stdlib coverage via the established
**primitive-split**. Server-side only — no renderer / `app.js` / `view.js`
touched (the leaf-flip is yours). Each file loaded **verbatim from disk**;
each driven headlessly through the spine (`node --test`). Desktop suite
**747/0** (+38 from 709). 8 commits on `multi-window-b` (tip `edc40af`),
NOT merged.

**Newly server-side (in `SPINE_STDLIB`), with what works:**
- **regex-search.lisp** — `replace-regexp` (JS back-refs $1/$&/$$) and
  `query-replace` (the y/n/q/! per-match loop, via the spine's
  `read-next-key` reader) run FULLY model-side. The two `isearch-regexp-*`
  starters are stubbed (the incremental loop is render-side). Provided the
  model-side `find-regexp-forward/-backward`, `find-string-forward`,
  `replace-regexp-all!`, `replace-range!` (mirror app.js's pure helpers
  byte-for-byte).
- **occur.lisp** — `M-s o` lists matching lines in a fresh `*Occur:*`
  buffer. Provided the model-side `new-view!` / `find-view` /
  `switch-to-view!` (a "view" maps onto a registry buffer; new-view! mints
  one + switches the active client onto it).
- **auto-pair.lisp** — typing `(`/`[`/`{`/`"`/`` ` `` auto-pairs
  **end-to-end** server-side: `handle-key` now consults a model-side
  `the-keymap` shim for a single printable before self-insert (exactly as
  production resolves `the-keymap` first). Pair-insert, step-over a close,
  self-pairing quotes, backspace-deletes-both, and the `*auto-pair*` off
  path all work over the wire.
- **snippets-parser.lisp** — pure data-in/out, zero glue.
- **snippets.lisp** — the **full snippet engine** server-side: expansion,
  field navigation, and **mirrors-as-multicursors (Policy A)** — a mirrored
  `$1` installs a real 2-cursor set through the spine (the snippet +
  multi-cursor + overlay integration end to end). Built-in starter set
  loads with no directory I/O. Added a model-side `defface`/`face` shim
  (the face registry is shared model state; rendering deferred);
  `snippet-date-string` mirrors app.js; the dir-store file reads are
  stubbed to safe empties.
- **latex.lisp** — the base writing commands (textbf/textit/emph/
  math-inline/section/itemize/…) + the C-c keymap; fully model-side, and
  **C-c b / C-c s dispatch via the mode-keymap chain** on a `.tex` buffer.
- **latex-insert / latex-math / latex-nav / latex-fill** — the model-side
  AUCTeX commands run: font wrappers, close-environment, `\begin/\end`
  matching, section nav, M-RET `\item`, smart quotes, fill-paragraph (in an
  env). Completion-driven inserts route through the spine's
  completing-minibuffer (`open-completing-minibuffer!` → the ordinary
  prompt round-trip; the candidate LIST is the deferred render half). Added
  a pass-through `minibuffer-tab-complete` base (latex-insert/reftex-refs
  CAPTURE it at load; completion is render-side). RefTeX is a soft dep
  (try/catch fallback) so the chain loads without it.
- **makefile.lisp** — target/phony/variable/tab/include + C-c chord; fully
  model-side like latex.lisp.

**Coverage picture:** the spine now loads **~26 of the ~70 STDLIB_FILES**
verbatim (commands/editing/custom/indent/modes/math-preview/kill/yank-pop/
line-ops/occur/expand-region/multi-cursor/search/regex-search/markdown/
latex(+insert/math/nav/fill)/makefile/panes/auto-pair/snippets-parser/
snippets). The model-side editing/mode/snippet/latex surface is now
broadly server-ready; what remains is concentrated in the render-message
slices (isearch loop, preview/MathJax, pane geometry, completion UI) and a
few render-coupled feature engines.

**Deferred (render-coupled, recorded with reasons in PRIMITIVE-SPLIT.md):**
- **bookmarks.lisp / sticky-notes.lisp** — their engines (`bookmarks.js`,
  the sticky-note overlay+JMarkdown-render+metadata) are render/host-side;
  the commands would only resolve against unbuilt engines. Slices of their
  own, not table-rows.
- **reftex.lisp + reftex-refs/reftex-cite** — the DB/label logic is
  model-heavy, but the load chain pulls in **cite.lisp** (`*citation-bib-
  path*`, the `citation-parse` host bridge) + `latex-master-file`
  (latex-compile). A coherent next slice once the citation bridge is
  decided; not forced here.
- The jukebox / gnuplot / shell / notebook / project / docs / palette
  files open render-side views (their externals are all `open-*-buffer!`).

**One pre-existing stdlib bug found (NOT mine, NOT fixed — outside mwb
territory):** `latex-fill-paragraph` does `(car (-latex-open-env-stack
text (point)))` which throws `car: expected a pair, got nil` when point is
in **prose with no enclosing environment** (the stdlib's own
`latex-fill.test.js` only fills inside an `\begin…\end`, so it never hits
this). The in-environment path — the real use — works correctly
server-side (matches the stdlib test's expected output exactly). Flagging
for a guard in `packages/stdlib/lisp/latex-fill.lisp` (a `(when (and stack
…))` around line 580).

**Test files added (one per ported file/chain):** `regex-search.test.js`,
`occur.test.js`, `auto-pair.test.js`, `snippets-parser.test.js`,
`snippets.test.js`, `latex.test.js`, `latex-extras.test.js`,
`makefile.test.js` — each drives a representative command (or keystroke
path) through the spine and asserts the buffer/cursor result. The existing
spine self-tests still pass unchanged.

## [2026-06-22 night] Live flag-on test (Jason) — findings

Real app, `GODOT_SERVER=1`. Typing native. The single-key editing core works
through the server: motion (arrows / C-f/b/n/p / C-a/e / M-f/b), editing
(Return/Backspace/C-d/C-k), kill-ring (C-k/C-y, C-SPC/C-w/M-w), undo (C-/).

**Pipeline (deferred feature — auto-corrects, NOT a bug):**
- **C-v / M-v** (scroll a screenful) — needs the deferred **VIEWPORT** up-message
  (the server must know the pane's pixel/line height to scroll by a screenful).
  Comes with the measurement-conversation wiring.
- **C-o (open-line)** — not bound in the spine's *focused* keymap subset; comes
  when we load the full keymap.lisp / bind more. Command exists server-side.

**Genuine bugs (won't fully auto-correct — fix in the key-dispatch / leaf-flip):**
1. **Auto-pair (and any *electric*/keymap-bound printable) never fires.** Root:
   the client local-echo path (`echoSelfInsert`, `server-view-client.js`
   `dispatchKey`) self-inserts a bare printable as `SELF_INSERT`, **bypassing the
   server's `handle-key`/`the-keymap`** where `(`/`[`/`{`/`"` are bound. SAME root
   as the chord-eating bug (a printable after a prefix). **Fix:** route printables
   through `handle-key` — either drop the `SELF_INSERT` special-case entirely
   (Phase-0 showed local-echo isn't perceptibly faster — both are frame-gated;
   Jason confirms native feel through the round-trip), OR run `SELF_INSERT`
   through `handle-key` server-side and let the corrected delta reconcile the
   optimistic prediction. This single fix also kills the chord-eating bug.
2. **Undo (C-/) rings the bell each time.** Undo works but chirps. Likely the
   in-renderer global router *also* processing C-/ on its own (untouched) buffer
   → "no further undo" → ding (the dual-router), i.e. the global router isn't
   fully standing down under server-mode. Resolve with the server-mode router
   branch (part of the leaf-flip). Confirm it's the bell source.

---

## [2026-06-22 night] Key routing + chrome wired to the server — auto-pair / chords / minibuffer / picker now usable through GODOT_SERVER=1

Two-part usability chunk on `multi-window-b` (4 commits, tip `a1276ab`, NOT
merged). Suite **759/0** (was 747; +12 new client tests). Flag-OFF
byte-for-byte: every change is additive + gated on `host.serverMode`.

**Part 1 — every key now routes through the server's keymap** (`fix bd135b1`).
`server-view-client.js` `dispatchKey` no longer local-echoes a bare printable
as `SELF_INSERT` (that bypassed `handle-key`/`the-keymap`). It now sends EVERY
keystroke up as a `KEY` intent, so the server's `handle-key` resolves it: `(`
`[` `{` `"` auto-pair, `C-x`/`C-c` start a prefix, a plain printable falls
through to self-insert. The mirror reconciles via the server's echoed DELTA
(no prediction; fresh-apply is always correct). This is the SAME root as the
chord-eating bug, so it fixes both. New tests: `(` round-trips to `()`; `C-x`
then `b` reaches the server as two bare KEY intents.

**Part 2 — the server's chrome drives the DOM** (`feat cb0b060` + focus fix
`298cf7d`). The client takes an injected `chrome` (fakeable in tests); `app.js`
passes the real nodes behind the serverMode gate:
- **Modeline** — paints the spine's `renderModeline` string (VIEW.modeline)
  into the real `#modeline-name`; clears `#modeline-position` (line:col is
  baked into the string). `updateModeline()` now stands down under serverMode
  so the idle in-renderer modeline can't fight it.
- **Echo area / pending prefix** — paints VIEW.status (e.g. `C-x-` mid-chord)
  via `minibuffer.setStatus`; suppressed while a prompt is open.
- **Minibuffer** — a server-suspended read opens the REAL minibuffer; input
  routes back up as MINIBUFFER_CHANGE/SUBMIT/CANCEL; opens once (no flicker),
  closes in lock-step when the server clears it. Focus returns to the view on
  close (else the next key goes nowhere).
- **Picker** — a PICKER message renders the generic `createPickerPanel` overlay
  (choice/cancel → PICKER_CHOOSE/CANCEL, tagged with pickerId; supersede tears
  down the old). Ported the `.mwb-picker` CSS into `styles.css`
  (theme-variable + color-mix, light-theme safe).

**⚠ ARCHITECT — verify live in the morning (GODOT_SERVER=1):**
1. **Auto-pair** — typing `(` `[` `{` `"` inserts the PAIR with point between;
   typing the close steps over; backspace in an empty pair deletes both.
2. **`C-x b`** ("Switch to buffer:") — the minibuffer opens, type a name +
   Enter switches the buffer; Esc cancels; focus returns to the view after.
3. **`M-x`** — the prompt opens, a command name + Enter runs it.
4. **find-file (`C-x C-f`)** — the prompt opens, a path + Enter visits it.
5. **Prefix-in-echo-area** — pressing `C-x` shows `C-x-` in the echo area
   until the next key; a complete chord clears it.
6. **Modeline** — shows the server's `● name  L:C (mode)` and tracks the
   point/dirty flag as you type (it's the server's, not the in-renderer one).
7. **Picker** (if a command opens one, e.g. C-x C-b buffer list) — the overlay
   renders styled, type-to-narrow + Enter/click chooses, Esc cancels.
   NB: a picker only appears for commands that call open-picker!; C-x b uses
   the minibuffer round-trip, not the picker.

**Should now be auto-corrected from the prior live test:** auto-pair (bug 1)
and the chord-eating bug are both fixed by Part 1. Undo's bell (bug 2) is the
in-renderer global router still processing C-/ — that's the **leaf-flip's
server-mode router branch**, NOT touched here (left for you per the brief).

**Deferred / NOT done (ran the chunk, not the leaf-flip):** the global
key-router still co-exists under serverMode (bug 2's bell; the dual-router);
C-v/M-v screenful scroll still needs the VIEWPORT up-message; C-o open-line
needs the fuller keymap. All flagged in the prior note as leaf-flip work.

**Commits (multi-window-b, unmerged):** bd135b1 (Part 1 key routing), cb0b060
(Part 2 chrome), 298cf7d (focus return), a1276ab (header doc). Tree clean,
759/0 green. No merge per the brief.

## [2026-06-23 ~02:00] Overnight autonomous build — summary (5 waves; app usable flag-on)

Drove the Model-B graduation from "types through a server" to "an editor you can
work in." 5 waves, each boot-tested (flag-on mounts clean; flag-off shows no
server + no errors), flag-off byte-for-byte, suite 779→822:
- **W1 keys+chrome** — route ALL keys through `handle-key` (fixed auto-pair + the
  C-x b chord-eating bug, same root) + wire modeline/echo/minibuffer/picker to the DOM.
- **W2 router+scroll** — focus-independent gate so the in-renderer global router
  stands down in server-mode (killed the undo `C-/` bell) + `C-v`/`M-v` screenful
  scroll via a client `VIEWPORT` report.
- **W3 multi-file+keymap** — find-file / `C-x b` re-mirror (fixed accumulating dead
  `<text-view>`s; one live view) + a dozen everyday bindings (`C-o`, `C-t`, `M-q`…).
- **W4 citations+RefTeX** — server-side citation bridge reusing the renderer's
  pure-ESM `citation.js`; `C-c [`/`)`/`(` cite/ref/label via the generic PICKER channel.
- **W5 isearch** — real `C-s`/`C-r` incremental search. *Salvaged after a network
  stall:* the agent's implementation was complete + uncommitted (boot-clean); I wrote
  the 6 `node --test` cases (fwd/back/wrap/abort/exit/backspace — all green) and committed.

Two network stalls (the watchdog, not logic) cost nothing — frequent commits + the
isearch salvage. **The leaf-flip stayed untouched** — it's GUI-shaped and best done
live with Jason driving; risking it autonomously (unverifiable) could break flag-ON.
Stopped here because the safe, autonomously-verifiable server-side work is done; the
rest (leaf-flip, multi-window, render-coupled stdlib) needs the live session.
`MWB-STATE.md` refreshed as the morning test guide. 84 commits ahead, nothing merged.

## [2026-06-23 morning] isearch REVERTED — live read-next-key hang (force-quit)

Jason hit a force-quit HANG invoking `C-s` (isearch) flag-on: the prompt showed
but keystrokes couldn't drive it and `C-g` couldn't escape. **Root cause:** isearch
drives its loop via `read-next-key`, which needs each keystroke to flow
view → KEY intent → server → the pending key-reader. That works in the *synchronous*
spine test (why the 6 tests passed — but it was never LIVE-verified, the known
salvage risk), but LIVE the keys don't reach the pending key-reader, and W2's
global-router gate (router stands down in server-mode) removed the fallback, so
it's stuck with no escape.

This is a `read-next-key` **live-delivery / focus** bug, and it's **shared**: the
math-symbol `` ` `` (latex-math-mode) uses the same `read-next-key` and almost
certainly hangs too — so this is a root mechanism to fix, not an isearch quirk.

Reverted the isearch commit (`8ac50e6`) to stop the hang — `C-s`/`C-r` back to the
safe stub (status, no loop). The `-isearch-*` machinery is CORRECT (node-tested)
and recoverable from `8ac50e6`. **Redo (live, GUI-verified):** fix `read-next-key`
live delivery — while a key-reader is pending the view must keep focus + keep
emitting KEY intents (and/or signal the client that a reader is active so it holds
focus / the router gate must permit the reader path). Re-arm isearch + math-symbol
once solid. Suite back to 822, flag-off byte-for-byte.

## [2026-06-23] Leaf-flip Step A ATTEMPTED + REVERTED — the correct approach found

Tried Step A: retire the g2HostEl overlay, mount the server mirror view into the
focused leaf's REAL pane element. Boots clean, suite green — but the editor
renders EMPTY. Diagnostic (settled, 2s post-mount): `mirrorInPane=false`,
`visibleKids=[tabline-view]`. The in-renderer pane render loop
(`elementForViewInstance` → the tabline-view/warehouse render, re-run on
layout/focus) re-resolves `leaf.view` to its OWN element (wrapped in a
tabline-view) and re-mounts it into the pane, EVICTING the foreign mirror.

**Lesson:** "append a mirror into the pane" fundamentally fights the render
loop. The CORRECT leaf-flip makes `leaf.view` itself **resolve to** the server
mirror — a server-backed View handle whose `elementForViewInstance` returns the
mirror `<text-view>` — so the EXISTING tabline/warehouse/sync render shows it
naturally, no fighting. That's a designed change to the view-resolution system,
done deliberately (map `elementForViewInstance` + the View-handle shape), NOT a
live poke. Reverted (`9288f2c` reverts `1a66d88`); the overlay works meanwhile.

## [2026-06-23] Leaf-flip — REFINED design (after reading elementForViewInstance + the render)

`elementForViewInstance` (app.js 9049): tabline children via editorByChild; per-
instance maps for browser/doc/element; else `singletonElementForKind`. A TEXT
leaf, though, mounts via `ensureEditorViewForLeaf` (the per-leaf <text-view>),
whose configure closures read **`instance._boundLeaf.view`** (= leaf.view) for
point/mark/cursors and `leaf.view.buffer` for content.

So the clean flip is NOT a resolver hack and NOT a foreign append — it's to make
**`leaf.view` itself a server-backed text view**:
  leaf.view = { kind:'text', buffer: <the ClientBuffer mirror>, point, mark, cursors }
- update its point/mark/cursors from each server VIEW message; the mirror IS the buffer.
- then the EXISTING `ensureEditorViewForLeaf` + render + `elementForViewInstance`
  drive the leaf's OWN <text-view> from the mirror — no overlay, no fight.

The **server-view-client refactors** from "create + own a <text-view> + closures"
to "own + update `leaf.view`"; keep `dispatchKey` (keys → KEY intents) + the chrome.
Watch-points: (1) the tabline — a leaf may hold a tabline-view whose active child is
the text view; set that child (or give the server leaf a bare text view, no tabline);
(2) `leaf.view.buffer` must satisfy view.js's 12-member read seam — the ClientBuffer
mirror already does. GUI-iterative; verify live. **A careful refactor — best started
with a fresh context budget; this is the next session's first task.**

## [2026-06-23 afternoon] Leaf-flip SHIPPED + server-mode one-world + Inc2.1 plumbing (live-verified)

The leaf-flip is DONE and **live-verified by Jason** ("It worked!"), plus two
follow-on increments toward "the server restores the session." All on
`multi-window-b`, suite green (3028/0; +6 new client tests → apps/desktop 828).
Three commits: `1e57d3a` (flip), `169c7de` (Inc1 one-world), `d76ca9b` (Inc2.1).

**Leaf-flip (`1e57d3a`).** Retired the G2 overlay. `leaf.view` is now a live
FAÇADE over the ClientBuffer mirror (`{kind:'text',_serverBacked,buffer:mirror,
get point/mark/cursors}`); the EXISTING `ensureEditorViewForLeaf` + render show
the leaf's own `<text-view>` from it. **Scope = Option 1**: `server-view-client.js`
untouched (the injected `mountView` boundary absorbed the change). Two
serverMode-gated seams in `ensureEditorViewForLeaf`: `serverViewKeyOption` (a
server-backed leaf's `onKey` → server keymap, decided PER-KEYSTROKE since
`configure()` can't re-run post-mount) + `getDecorations` reads the mirror.
`mountServerView` returns an adapter over the leaf's `<text-view>` (soft destroy;
a switch re-points the SAME leaf/instance). Flag-off byte-for-byte.

**Live test exposed "two buffer worlds":** the in-renderer home-session restore
re-opened the user's previous files into the leaf and competed with the server's
SNAPSHOT → the leaf showed in-renderer buffers while the server's seed (`view.js`,
HARDCODED at `server.js:49`, recovered from a dirty autosave) was orphaned and
only drove the modeline (the `view.js L1:C0` mismatch). **The overlay had MASKED
this** (it was a full-bleed layer hiding the in-renderer editor).

**Increment 1 (`169c7de`) — live-verified.** In server mode the SERVER owns
buffers + the session, so the in-renderer session machinery stands down (all
serverMode-gated): `activeSession()` → inert `NULL_SESSION` (every
save/flush/restore no-ops — ALSO closes a DATA-SAFETY hazard: it would otherwise
overwrite the user's real flag-off `session.json` with the welcome seed); the boot
wrap skips `sessionController.restore()` + `wrapRootInTabline`; the in-renderer
recovery offer is skipped. Result: boot lands on the server seed alone, fully
server-backed — typing edits the server buffer, find-file routes through the
server, modeline matches. Jason confirmed (opened a file; modeline matched).

**Open follow-up (task #9): server-side mode coverage.** Server modeline shows
`(Fundamental)` for `.html` — the server loads only markdown/latex/makefile
modes, so `choose-major-mode!` has no `html-mode`. Highlighting/folds still work
(tree-sitter keys off the file EXTENSION, not the major mode). Fix = port
`html-mode` (+ others) to the server's STDLIB_FILES.

**Increment 2.1 (`d76ca9b`) — the plumbing for server-backed tabs.** Jason chose
"native tabs" (reuse the in-renderer tabline + `views[]` as a thin proxy over the
server's buffer set). Server now PUSHES `BUFFER_LIST` on every buffer-set change
(`sendBufferListTo` added to `resyncClientToCurrentBuffer` + the HELLO handler).
Client handles `MSG.BUFFER_LIST` (cache + injected `chrome.setBufferList`),
exposes `getBufferList()` + `switchBuffer(id)` (sends a `SWITCH_BUFFER` intent).
Records are `[{id,name,lineCount,modified,filePath,current}]`. +6 client tests.

**NEXT — Increment 2.2 (the GUI part, UNBUILT): render the server buffers as
native tabs.** Design = the **shared-façade-element model** (the client mirrors
only ONE buffer, so per-tab elements don't fit):
 - Keep ONE shared `<text-view>` (the façade) bound to the single live mirror =
   the active buffer. Tabs are LIGHTWEIGHT proxy views (`{id, kind:'text',
   _serverBacked, _serverBufferId, name, buffer:null}`) — one per server buffer,
   pure strip labels. Only the active tab is ever mounted, and its content is the
   shared façade (NOT a per-tab element).
 - `leaf.view` becomes a tabline-view whose `tabs` are the proxies, `active` =
   the current buffer's index. A new `syncServerBufferTabs(buffers)` (wired via
   `serverChrome.setBufferList`) builds/updates the tabline from `BUFFER_LIST`.
 - `mountTablineActiveChild` (~app.js 9020): a serverMode branch — for a
   `_serverBacked` active tab, mount/show the shared façade element
   (`ensureServerFacadeElement`, cached on the tabline state, configured with
   `serverViewKeyOption` + server `getDecorations`), re-pointed to the mirror.
 - `activateTabInTabline` (~9180) + the strip `onSelect`/`switchToViewIndex`/`C-x b`:
   a serverMode branch — switching to a DIFFERENT server buffer calls
   `serverViewClient.switchBuffer(id)`; DON'T mount locally. The server re-syncs
   (SNAPSHOT re-mirrors → `mountServerView` updates the shared `serverMirror`;
   BUFFER_LIST re-marks active → `syncServerBufferTabs` re-activates).
 - `mountServerView` (~5815) restructures: set a module-level `serverMirror` +
   re-render the shared façade, instead of `leaf.view = bare façade`. On a switch
   the SNAPSHOT arrives BEFORE the BUFFER_LIST (server order: resync → snapshot
   THEN bufferlist).
 - Deferred polish: the tab dirty-dot (proxies have `buffer:null` → read proxy
   `_modified` in the strip); the View List (proxies in `views[]` → route
   View-List clicks to `switchBuffer`); tab-close → server `kill-buffer`.
 ALL GUI-shaped — verify live; the build side can't launch the GUI.

**Increment 3 (UNBUILT): server-side session persistence** — persist open file
paths + active; on boot the server re-opens them (fold with crash-recovery). Then
the user's real files come back through the server as tabs. (server.js has no
session file today — only crash-recovery autosave.)

## [2026-06-23 late pm] Increment 2.2 native tabs + close + quit — SHIPPED, live-verified

Increment 2 is DONE and live-verified by Jason. The focused leaf in server mode
is a real in-renderer tabline whose tabs ARE the server's buffers; open/switch/
close/quit all route through the server. Commits `be48f0a` (native tabs),
`e02c703` (bindCursor fix), `ef9b34c` (close + quit). Suite green (832/0).

**Native tabs (`be48f0a`) — shared-façade-element model, as designed above.**
`serverFacadeView` (module-level, getters over the single `serverMirror`) always
occupies the active tab slot; other buffers are lightweight proxies (labels). The
leaf becomes a server tabline (`ensureServerTabline`, which also unlinks the init
leaf-direct `<text-view>` so it isn't orphaned behind the tabline);
`syncServerBufferTabs` (← `serverChrome.setBufferList` ← BUFFER_LIST) reconciles
tabs + active. `ensureTabElement` + `activateTabInTabline` got serverMode
branches (façade tab onKey→server / decorations→mirror; a proxy click →
`switchBuffer`). All `_serverBacked`/`_serverTabline`-gated → flag-off byte-for-byte.

**bindCursor fix (`e02c703`).** The tabline mount path runs
`applyTextMountSideEffects`, which called `view.buffer.bindCursor()` (an L2
method the mirror lacks) → threw twice into the REPL on boot. The leaf-flip path
never reached it. Guarded: for a server-backed view, skip the whole in-renderer
block (bindCursor / sticky-notes / bookmarks / major-mode / dirty-watch) and just
point `editorView` at the instance + render + focus.

**Close + quit (`ef9b34c`) — renderer-only, reusing server machinery.**
- Tab `×` → `client.closeBuffer(id)` = `switchBuffer(id)` then send `C-x` `k`
  (the server's kill-buffer); the server re-homes + re-pushes BUFFER_LIST so the
  tab vanishes. Refuses to kill the only buffer. (Closing an INACTIVE tab briefly
  flashes to it — switch-then-kill; a kill-by-id intent would avoid the flash.)
- `C-x C-c` → the client resolves the chord (`dispatchKey` shadows the prefix via
  `lastDispatchedKey`; the server leaves C-x C-c unbound) and calls a
  `requestQuit` chrome hook → `quitInteractive()`. Split: server owns editing,
  client owns window lifecycle.

**Observed (not bugs):** boot shows TWO `view.js` tabs — the server's hardcoded
seed `view.js` + a recovered dirty `view.js` autosave snapshot (the `*Recover*`
UX item). The modeline still says `(Fundamental)` for `.html` (mode-coverage
task #9).

**REMAINING (in order):** (a) wire the *View List* to the server buffer set (the
proxies aren't in `views[]`, so it's empty in server mode); (b) Increment 3 —
server-side session persistence (the headline want); (c) mode-coverage (task #9);
(d) `read-next-key` live delivery (isearch + LaTeX `` ` ``); (e) the dup-`view.js`
/ `*Recover*` UX. All other Increment-2 sub-bits (tabs/switch/close/quit) DONE.

## [2026-06-23 evening] View List wired + Increment 3 (session restore) — SHIPPED, live-verified

The Model-B graduation arc is COMPLETE for single-window: server mode is now a
proper, persistent, native-tab editor that restores the user's session. Commits
`bf9340c` (View List) + `43b5db4` (Inc3). Suite green (832/0).

**View List (`bf9340c`).** In server mode `viewListRecords` is sourced from
`serverViewClient.getBufferList()` (rows' id = server buffer id); `selectView` →
`switchBuffer`, `killView` → `closeBuffer`; refreshed on every BUFFER_LIST. (The
*View List*'s kill-row affordance is hard to find — a small UI follow-up.)

**Increment 3 (`43b5db4`) — server owns the session. LIVE-VERIFIED ("It worked!").**
The server remembers the user's open files across restarts and restores them
through the server as tabs:
 - `persistServerSession()` writes `{files, active}` (file-backed, de-duped) to
   SESSION_STORE on every buffer-set change (via resyncClientToCurrentBuffer).
 - `restoreServerSession()` on the FIRST HELLO opens each remembered file (skip
   already-open) + switches to the active, before the snapshot.
 - `readSessionSeed()` (first boot only, no server session yet) parses the
   renderer's session.json (path via `MWB_SESSION_SEED`, set in main.js before
   the fork) for its text-file paths — so the user's EXISTING flag-off session
   comes back. Then the server owns its own session.
 - Self-heals stale paths: a missing file ENOENTs once (logged, no crash), never
   opens, so it's dropped from the next persist (Jason's `/Users/jalex/tmp/test.md`
   was gone by the 2nd boot).

**Known wart (deferred): the spine still seeds DEFAULT_FILE (view.js) every boot**,
so it shows as an extra tab alongside the restored session (and gets persisted as
a file-backed buffer). Fix = don't seed view.js when a session/seed exists (boot
the spine on the active session file instead) — a spine-boot change.

**STATE: the Model-B single-window editor is feature-complete + usable.** Open /
switch / close / quit / multi-tab / View-List / session-restore all server-backed,
flag-off byte-for-byte throughout. ~14 commits this session, all live-verified.
Remaining are polish/coverage: seed-noise, mode-coverage (#9), read-next-key
(isearch/LaTeX `` ` ``), `*Recover*` UX, View-List kill-row affordance. Then G4
(multi-window) + G5 (flip default, delete in-renderer interpreter).

## [2026-06-23 night] Seed-noise + mode-coverage — SHIPPED, live-verified

Commit `6aafbc5`. Suite green (832/0). Both live-verified ("That worked!").
- **Seed-noise:** the spine seeded DEFAULT_FILE (`view.js`) every boot → a stray
  tab. Now boots on the saved session's ACTIVE file (server's own session, else
  the renderer's session.json seed). `SESSION_STORE` moved above the spine (read
  via the hoisted `readServerSession`); `createSpine`/`registry.add` gained
  `initialPath` so the seed is file-backed (restore then skips it as
  already-open). Falls back to `view.js` when there is no session.
- **Mode coverage (task #9 ✓):** load every `languages/*.lisp` (define-mode +
  register-mode + a few editing commands) TOLERANTLY (one bad file logs + skips,
  never aborts boot), so `.html`/`.py`/`.css`/`.json`/… get the right major mode
  + keymap by extension. Skip latex/markdown (richer modes from the root list).

**OPEN — the next slice: find-file TAB-completion in server mode.** The
completing-minibuffer slice from the original backlog. The engine
(`minibuffer-tab-complete`) + dir-listing are ALREADY server-side; only the
TAB→complete→display wire is missing. Do as ONE coherent slice — a
`MINIBUFFER_COMPLETE` intent (client→server) → the server runs the completer +
returns candidates → the client renders them (inline completion and/or the
completions picker). NOT a band-aid. Good first task for a fresh session.

**SESSION CLOSE: the Model-B single-window editor is feature-complete + polished**
(open/switch/close/quit/tabs/View-List/session-restore/right-modes, all
server-backed, flag-off byte-for-byte). ~18 commits this session, every step
live-verified. **Next big phase: G4 (multi-window)** — the server already has
per-client pane models + PANE_TREE; the client stubs them. Polish backlog:
find-file completion (next slice), View-List kill-row affordance, read-next-key
live delivery (isearch + LaTeX `` ` ``), `*Recover*` UX.

## [2026-06-23 G4 build] Multi-window — open/close a second window — BUILT, awaiting live verify

The headline finding: **the data layer was ALREADY multi-client** (server
`clients[]` with per-client views/pane-trees/cursors/viewports; `fanDelta`
per-buffer fan-out + `broadcastView`; the bridge mints a fresh channel + client
per `attachWindow`; the client is fully per-renderer). So G4 is mostly the
missing **window-management shell** in `main.js` + a clean **detach**. Three
commits on `multi-window-b` (UNMERGED), suite 832→835, flag-off byte-for-byte:

- **`250fc2e` G4.1 — multi-window core.** `main.js`: a `windows` Set replacing
  the single-window assumption; `createWindow()` is repeatable + each new window
  is `attachWindow`'d as a new client. In server mode a window **closes freely**
  (buffers are server-owned + outlive any window — closing loses nothing); only
  QUITTING (before-quit / C-x C-c, which kills the server) runs the unsaved
  confirm, now via `focusedWindow()`. `mainWindow` re-points to a survivor on
  close. `menu.js`: a server-mode-only **File ▸ New Window (C-x 5 2)** item.
  `preload.mjs`: `host.newWindow()` → `window:new` IPC → main creates+attaches.
- **`a1471e0` G4.2 — clean detach.** `server.js`: `registerClient` wires
  `port.on('close')` → `detachClient` (drop from `clients[]`, release any
  minibuffer/picker/active ownership, `spine.removeClientView`). The index-0
  assignment is now a ONE-SHOT bootstrap claim (not `clients.length===0`, which
  breaks after a detach-to-0 on macOS). `spine.js`: `removeClientView` +
  MONOTONIC index allocation (`nextClientIndex`, never reused — `.size` would
  re-mint a live index after a middle drop); a new window seeds on the ACTIVE
  window's current buffer (make-frame semantics). +2 spine tests.
- **`a9058ab` G4.1b — the C-x 5 2 chord.** A 3-key, NON-terminal sequence, so
  (unlike the C-x C-c quit shadow) a client-side shadow would leave the server
  in a dangling `C-x 5` prefix that eats the next key. Instead the SERVER
  resolves it through its real keymap: `CX_MAP['5'] = {2:'new-window'}` → the
  `new-window` defcommand → `request-new-window!` primitive → a new
  `onNewWindow` effect → server posts `WINDOW_NEW` → client `requestNewWindow`
  chrome → `host.newWindow()`. The model/host split, cleaner than the shadow.
  +1 spine test (C-x 5 2 fires; C-x 2 stays split-vertical).

**⚠ ARCHITECT — verify live (GODOT_SERVER=1; needs a quit + relaunch, the
server/main/preload changed):**
1. **File ▸ New Window** (and **C-x 5 2**) opens a SECOND window showing the
   same buffer set, focused on the buffer the first window was on.
2. **Shared editing:** type/open/switch in one window → the other window's tab
   set + (same-buffer) text track it live. Two windows on ONE buffer = the
   payoff.
3. **Close one window** (red traffic-light) while the other is open → only that
   window closes, the app + the other window live on, no errors in the server
   stderr (`client N detached (M left)`), buffers preserved. Reopen via New
   Window works.
4. **Quit** (Cmd+Q / C-x C-c) from any window → confirms once, tears down all +
   the server.
5. **macOS:** close ALL windows → app stays alive (server lives); dock-activate
   re-opens a window onto the server (lands on the seed buffer — see below).
6. **Flag-OFF** unchanged: single window, no New Window menu item.

**Unknowns to watch live:** (a) does `port.on('close')` fire reliably when a
renderer window is destroyed? (the detach hangs off it — fallback if not: main
sends an explicit detach on window `closed`, mapping window→client); (b) the
"close all then reopen" reopen lands on the seed buffer, not the last-active
(all buffers are still in the tab list — acceptable; could seed smarter later).

**REMAINING in G4:** G4.3 polish — the app MENU follows the focused window's
mode (today `menu:set` is whoever-last-sent; minor). Window TITLE already tracks
per-window (serverChrome.setModeline sets document.title). Then **G5** (flip the
default + delete the dead in-renderer interpreter path).

**LIVE-VERIFIED (Jason): G4 multi-window works.** "It worked!" The terminal log
confirmed BOTH unknowns resolved: `port.on('close')` fires (the `client N
detached` lines come only from detachClient ← port close), and the monotonic
index works (after clients 0+1 detached, a reopened window got `client 2
attached`, not a reused 0). Detach + reuse-free indexing are solid.

## [2026-06-23 G4 window-model] A window is NOT a tabline — fresh window = single composable pane (Step 1)

Live feedback reshaped the design. Jason: a window should be a **composable
pane layout** (Emacs frames over one shared buffer pool), NOT hardcoded as a
tabline. The Inc2.2 "window = tabline of ALL server buffers" shortcut is too
rigid — other window types (projects) need other layouts. The agreed model:
- **Window 1** = welcome (no session) or the restored session (its tabline, as
  today).
- **Windows 2+** = a **single composable pane on their own fresh `*scratch*`**
  (+ REPL), like a normal fresh start — the user then loads a single view OR
  adds a tabline-view. NOT assumed to be a tabline.
- **Buffers stay one shared pool**; each window shows a subset.

Staged: **Step 1 (DONE, this commit `f1f355f`)** decouples the window from the
forced tabline. **Step 2** = full per-window buffer SUBSETS (each window its own
arbitrary tab set; tab-× = un-display vs C-x k = kill; C-x C-b reaches the
pool). **Step 3** = client-side `PANE_TREE` rendering (splits within a window —
the big pane-negotiation gap; the client still ignores PANE_TREE today,
`server-view-client.js` default case).

**Step 1 mechanics (`f1f355f`, suite 835→836, flag-off byte-for-byte):**
- `server.js` registerClient: window 1 → `windowKind:'tabline'`; windows 2+ →
  `windowKind:'single'` on a fresh scratch (`addClientView({freshScratch})`).
  The kind rides the snapshot.
- `spine.js`: `addClientView({freshScratch})` mints a PRIVATE `*scratch*` per
  window (`scratchOwner` map); `bufferListRecords` hides a scratch from OTHER
  windows (a DENY-list, so any buffer is globally visible by default + C-x C-b
  reaches the whole pool via `bufferListRows`); `removeClientView` reaps an
  empty scratch on close.
- client: `server-view-client.js` stashes `windowKind` from the snapshot →
  `mountView`; `app.js` `mountServerView` branches — `single` →
  `mountServerSingleView` (the leaf's own `<text-view>` via the resurrected
  leaf-flip mount, NO tabline); `tabline` → `ensureServerTabline` (unchanged).

**⚠ ARCHITECT — verify live (GODOT_SERVER=1; quit + relaunch — server changed):**
1. **Window 1** unchanged: welcome / restored-session tabline.
2. **New Window (C-x 5 2 / menu)** → opens a **single pane on an empty
   `*scratch*`**, NO tabline. (This is the visible change.)
3. The new window's scratch does NOT appear as a tab in window 1.
4. In the fresh window: `C-x C-f` a file → it loads as a single view (no tabs);
   `C-x C-b` still reaches ALL buffers (the whole pool).
5. **REPL** — Jason wanted "a REPL below, like a normal fresh start." OPEN
   QUESTION for live: does the REPL/utility dock show in a fresh server window?
   If not, it's a follow-up (the utility dock is render-coupled — may be a stub
   in server mode). The must-have for Step 1 is the single scratch pane.

## [2026-06-23 G4 window-model Step 3] Arbitrary pane layouts — LIVE-VERIFIED working

The window-as-composable-pane-layout vision is REAL and live-verified by Jason
("works great", "works perfectly"). Step 1 (single scratch pane) was verified;
then Step 3 rendered the server's PANE_TREE so a window holds arbitrary splits
with different buffers per pane. Commits on `multi-window-b` (UNMERGED, ~120
ahead), suite 836→837, flag-off byte-for-byte:

- **`34f4c7f`** — dismiss the startup splash in a fresh server window (the
  faint `(cond` ghost; `dismissSplash()` in mountServerView). Live-verified.
- **`ade0f74` Step 3a** — the client renders the server's PANE_TREE.
  `server-view-client` handles PANE_TREE → `chrome.setPaneTree`; `app.js`
  `reconcileServerPaneTree` rebuilds rootPane from the wire tree (reusing the
  server's stable leaf ids + the existing split/splitter/layout machinery),
  mounts each leaf, focuses the server's focused leaf. C-x 2/3/0/1/o became
  visible. Focused leaf → live `serverFacadeView`; same-buffer panes → live
  shared mirror. Only a 'single' window reconciles; window 1 keeps its tabline.
- **`a85fe75` Step 3b** — different buffers per pane. Instead of N live mirrors,
  a NON-focused DIFFERENT-buffer pane renders from a static snapshot carried in
  the PANE_TREE leaf (`text`, included only when the leaf's buffer ≠ the focused
  one; a `textForBuffer` hook from the spine registry). app.js `serverStaticBuffers`
  caches them. + a server fix: C-x o onto a different-buffer pane re-syncs the
  originator's live mirror (didn't fire onBufferSwitched → `bufferSwitchEffectFired`
  guards a double).
- **`f2be17c`** — a pane CLICK now sends a `focus-pane` PANE intent so the SERVER
  re-focuses that leaf (the plumbing existed; the client never sent it). Fixes
  "click the top pane, C-x 3 splits the bottom" — the server's focus is now the
  source of truth for every pane command. Live-verified.
- **`d01b962`** — per-window buffer SUBSETS. Files opened in window 2 were
  leaking into window 1's tabline (Step 1's deny-list only hid scratches).
  Replaced with a per-window ALLOW-LIST (`clientBuffers`: clientIndex → open
  buffer ids), maintained on every add path (construction/restore/find-file via
  switchClientToBuffer, addClientView, recoverBuffer, kill drops it,
  removeClientView reaps an unused scratch). `bufferListRecords` filters to the
  window's set (+ its current, defensively); the C-x C-b PICKER stays GLOBAL.
  Live-verified. **Jason's note: the set is buffer-id-keyed today; it generalises
  to VIEW ids when buffer-less element-views (jukebox/stella) graduate to the
  server.**

**THE MODEL-B PAYOFF IS VISIBLY WORKING (Jason, unprompted):** the same buffer
shown as the ACTIVE view in two real windows updates LIVE in both as you type
(fanDelta → each client's live mirror). The one remaining non-live case is a
buffer in a NON-focused split pane (static snapshot, 3b) edited from elsewhere.

**REMAINING (Step 3 polish, all deferred):** 3c — a leaf can BE a tabline with
its own tab set; live background-pane cursors / full per-buffer mirrors;
persisted splitter ratios; the fresh-window REPL eval (does it work?). Then
G4.3 menu-follows-focus polish, then G5 (flip default, delete in-renderer interp).

## [2026-06-23 Step 3c] Server foundation committed; CORRECTED tabline model

3c SERVER half committed (`4355fec`, suite 838/0): a per-leaf `tabline` flag in
the pane model + `toggleFocusedTabline` + a `toggle-tabline` command + the flag
on the PANE_TREE wire. NO visible effect yet (the client ignores it).

**⚠ CORRECTED MODEL (Jason — my first design framing was WRONG).** A tabline-leaf
is a container of EXPLICITLY-CURATED tabs (like a flag-off `tabline-view`'s `tabs`
array). A tab is in a tabline ONLY because it was (a) RESTORED there or (b) put
there by the USER. A tabline shows **only its own tabs** — NOT "the window's
buffer set" (that phrase was an artifact of window-1 being one big tabline =
`clientBuffers`; there's no general window-buffer-set a tabline displays).
- `toggle-tabline` on a single pane → a tabline with EXACTLY ONE tab (its buffer).
- find-file / switch WHILE A TABLINE LEAF IS FOCUSED → ADD a tab to THAT tabline;
  find-file in a single-view pane just replaces what it shows.

**So the committed flag is only a START.** The real server model: the tabline-leaf
needs an explicit ordered **`tabs: bufferId[]`** (+ active), not just the boolean.
Reconcile `clientBuffers` (the per-window stand-in) with per-tabline-leaf tab sets:
window 1's tabs become its leaf's set; clientBuffers derives from the pane tree or
retires. Then the CLIENT renders a tabline leaf as a real tabline-view of EXACTLY
its `tabs` (proxies via `ensureServerProxy`), mounted via `mountKindView`. Full
design in repo-root `HANDOVER.md` (the ⚡ NEXT ACTION block).

## [2026-06-23 Step 3c client] Tabline leaves render — a leaf with its OWN curated tabs (BUILT, awaiting live verify)

Step 3c is now end-to-end: a leaf can BE a tabline of its own explicitly-curated
tabs, and the client renders it. Two commits on `multi-window-b` (UNMERGED, ~123
ahead of `main`, suite 838→**847**, flag-off byte-for-byte). Build side can't
launch the GUI — **awaiting Jason's live verify** before any merge.

- **`29a30c7` server** — per-leaf curated tab set. The 4355fec foundation had only
  a `tabline` boolean; per the corrected model (a tabline = a container of
  EXPLICITLY-CURATED tabs, not "the window's buffer set") the leaf now has an
  ordered `tabs: bufferId[]` (active = the leaf's `bufferId`):
  - `toggleFocusedTabline` ON seeds EXACTLY one tab (the leaf's buffer); OFF drops
    the set.
  - `setFocusedBuffer` ADDS a tab when the focused leaf is a tabline (find-file /
    switch joins THAT tabline, no dup, re-activates an existing tab); a single-view
    pane just replaces what it shows.
  - `closeFocusedTab` un-curates a tab (buffer lives on in the pool; never empties
    the tabline; re-points to a neighbour if the active tab closed) — via a new
    `close-tab` PANE intent (the server's MSG.PANE handler resyncs when the active
    buffer changes).
  - The PANE_TREE wire carries the ordered `tabs` with per-tab display metadata
    (name/dirty/path) via a new `tabMeta` pane-model hook (wired to the registry).
  - Tests: pane-model.test.js (+5: seeds/adds/replace/off/close), protocol.test.js
    (+2: tabs on the wire / omitted for a single view), spine-panes.test.js (+2:
    toggle-tabline then find-file adds a tab; close-tab un-curates, buffer survives).

- **`6f930b3` client** — render a tabline leaf as a real tabline-view. In a
  'single' window, `buildServerPaneNode` turns a `tabline` leaf into a tabline-view
  of EXACTLY that leaf's tabs (reused per leaf id via `serverLeafTablines` so the
  tablineState / per-tab elements survive a focus-only reconcile): the active tab is
  the live `serverFacadeView` when the leaf is focused (cursor tracks the mirror),
  a static buffer view when not; every other tab a `ensureServerProxy` label.
  `reconcileServerPaneTree` mounts a tabline leaf via `mountKindView` (NOT the
  text-only `ensureEditorViewForLeaf`), sweeps the stale leaf-direct `<text-view>`
  on a text→tabline flip, and `disposeTablineKind`s a leaf-tabline that flipped
  back / vanished. Tab click → `focus-pane` + `switchBuffer`; tab × → `focus-pane`
  + `close-tab` (both focus THIS leaf first — the click may be in a non-focused
  pane). `toggle-tabline` destroys the focused leaf's element with NO following
  SNAPSHOT, so the reconcile restores keyboard focus to the focused leaf's
  element — but ONLY when focus was orphaned to `<body>` (never steals it from an
  open minibuffer/picker). New shared `focusedServerLeafElement()` resolves the
  focused leaf's live element (plain instance or tabline-façade tab) for the
  focused-leaf adapter + the focus-restore.

**LIVE-VERIFY (Jason):** in a FRESH window (`C-x 5 2`, a 'single' window) —
1. `M-x toggle-tabline` → the single *scratch* pane grows a 1-tab tabline strip.
2. `C-x C-f` a file → the tabline gains a 2nd tab, the new file active; typing edits it.
3. Click the first tab → switches back; click the 2nd → forward. Tab × removes a tab
   (the buffer stays reachable via C-x C-b). `M-x toggle-tabline` again → back to a
   single view on the active buffer.

**CLEAN path = a FOCUSED single tabline leaf** (live façade, no element churn).
**Follow-ons (deferred, as scoped):** non-focused tabline leaves (their static
active tab re-creates its element each reconcile — a churn/leak), multiple tablines
per window, RESTORE of tab structure across a relaunch (the server `tabs` set isn't
persisted yet), reconciling `clientBuffers` with per-leaf tab sets (window 1 is
still one big tabline = clientBuffers; a 'single' window now has its own per-leaf
tabs — the two models coexist but aren't unified). Then G4.3 menu-follows-focus,
then G5.

## [2026-06-23 Step 3c follow-ups] find-file reuse + non-focused tabline + reorder (BUILT, awaiting live verify)

A live-verify of 3c surfaced a real bug; fixed it + filled two functional gaps.
Three commits on `multi-window-b` (suite 849→**852**, flag-off byte-for-byte).

- **`9f2cf14` fix — find-file reuses an open buffer (no `name<2>` duplicate).**
  Jason's repro: `C-x C-f` a file already open in another window's tabline made a
  SECOND buffer `foobar.html<2>` with NO syntax highlighting. One cause, two
  symptoms: `visitFile` always `registry.add`ed; the uniquifier appended `<2>`;
  the client keys highlighting off the extension (`languageForFilename` does
  `name.endsWith('.html')`), so `foobar.html<2>` matched no language → plain text.
  Fix = Emacs semantics: new `registry.findByPath(absPath)`; a re-visit SWITCHES
  to the existing buffer (shared across windows = the Model-B payoff; name stays
  clean; unsaved edits preserved). **Server change → needs quit+relaunch.**
- **`ffcdf82` fix — a non-focused tabline leaf renders LIVE (no empty pane after a
  split).** Splitting a tabline pane (C-x 3) left the original tabline non-focused
  on the SAME buffer as the new focused leaf → the wire carried no `text` for it
  (only different-buffer leaves get text) → the client's non-focused tab went to a
  static buffer seeded from absent text = EMPTY pane. Fix: the tabline path now
  mirrors `buildServerPaneNode`'s non-focused branches — same buffer → live mirror
  (3a), different buffer → its snapshot text (3b). The non-focused active-tab view
  is a STABLE per-leaf object (`serverLeafActiveTabViews`), re-bound in the
  reconcile, so its element is reused (no churn) and content/cursor stay live.
- **`78d429a` feat — drag-reorder tabs in a tabline leaf.** Completes the tab bar
  (open/switch/close already worked). The server owns order: a drag routes up as a
  `reorder-tab` PANE intent → `reorderFocusedTab(from,to)` splices the leaf's
  `tabs`; active is tracked by id (unchanged); PANE_TREE re-renders the strip.

**LIVE-VERIFY (Jason) — quit+relaunch first (server changes):**
1. find-file the same file in two windows → it lands as `foobar.html` (no `<2>`),
   highlighted; type in one window, it echoes live in the other.
2. In a fresh window: `M-x toggle-tabline`, open 2-3 files as tabs, then `C-x 3`
   to split → the split shows the file live (not empty); edit it in either pane.
3. Drag a tab to reorder it; the order sticks.

**Still deferred (the real forks, need your call):** RESTORE of tab/pane structure
across a relaunch (server persists window-1's open files only, NOT the pane tree /
per-leaf tabs); UNIFY window 1 (still the old one-big-tabline = `clientBuffers`,
ignores PANE_TREE — so C-x 2/3 don't visibly split window 1) into the same
composable model the fresh windows use. Both are sizeable; pick before I build.

## [2026-06-23 unify] Window 1 folded into the composable-pane model (BUILT, awaiting verify)

Retiring the dual model: window 1 was a client-side ONE-BIG-TABLINE that IGNORED
the PANE_TREE (so C-x 2/3 couldn't split the main window); every other window was
a composable pane layout. Now EVERY window renders from its PANE_TREE — window 1
is just SEEDED as a tabline leaf of its restored files. Two commits on
`multi-window-b` (suite 852→**856**, flag-off byte-for-byte); cleanup of the dead
machinery is a third commit, DEFERRED until Jason verifies.

- **`95af110` foundation** — `seedFocusedTabline(ids, activeId)` (pane-model: make
  the focused leaf a tabline with a GIVEN curated tab set; preserves the leaf's
  cursor when active is unchanged — the restore case; dedupes; default active =
  first) + `seedClientTabline(index, ids, activeId)` (spine: note the buffers,
  seed, rebind the interpreter when it's the active client). +4 tests. Not wired.
- **`d025dbb` functional unify** — every client `windowKind: 'single'`; after
  `restoreServerSession`, `seedWindow1Tabline(client)` makes window 1's focused
  leaf a tabline of its open files (active = the session's active). The View-List
  refresh moved onto the BUFFER_LIST push directly (it used to piggyback on the
  now-dead one-big-tabline sync). Window 1 now renders via reconcileServerPaneTree
  like any window.

**HOW IT WORKS:** one render path (reconcileServerPaneTree), two seeds — window 1 =
a tabline leaf of restored files; fresh windows = a single scratch pane. A
session-less first boot still gets a 1-tab tabline (the open-set always has the
boot buffer), matching the pre-unify look. STRUCTURE restore is still just the
flat file list → a single tabline leaf (restoring SPLITS is the separate deferred
fork).

**LIVE-VERIFY (Jason) — QUIT + RELAUNCH (server change):**
1. Window 1 comes up showing its restored files as tabs (as before), highlighted,
   on the active file.
2. **C-x 3 / C-x 2 now SPLIT window 1** (the headline — it couldn't before); C-x o
   moves focus; C-x 0/1 collapse. Edit in a split → live.
3. Tabs in window 1: open (C-x C-f) adds a tab, click/×/drag-reorder all work.
4. The View List (and C-x C-b) still track the open set.
Watch-points: the boot flash (single pane → tabline) is normal; focus after boot;
× now UN-CURATES a tab (buffer stays in C-x C-b) rather than killing it (the 3c
semantics — a change from window 1's old × = kill).

**NEXT (deferred):** delete the dead window-1 machinery (serverTablineView,
ensureServerTabline, syncServerBufferTabs, makeServerLeafAdapter,
serverFacadeElement window-1, serverTabProxies, the serverWindowKind branch +
mountServerView 'tabline' branch, the windowKind field) — pure hygiene, after
verify. Then RESTORE-of-structure (persist the pane tree / per-leaf tabs), then
G4.3 menu-follows-focus, then G5.

## [2026-06-23 data-sources] Non-text views graduate to the server — media (image/video/audio/pdf) BUILT, awaiting verify

Overnight autonomous build (Jason asleep, "go as far as you can"). Implements the
buffer→DATA-SOURCE generalisation Jason framed: a text buffer is the shared
source-of-truth fanned to its views; that's the general pattern, so a DATA-SOURCE
is the same for any view kind. MEDIA (image/audio/video/pdf) is the immutable
case; the mutable-state fan-out seam (stella/jukebox: a loaded ROM/song that syncs
across duplicate views) is DEFINED but UNUSED. Fixes "open an .mp4 → binary
garbage": the server read every file as UTF-8. Six commits on `multi-window-b`
(suite 856→**864**, flag-off byte-for-byte). EXISTING element-views are reused —
nothing rebuilt. Build side can't launch the GUI — **awaiting Jason's verify.**

- **`25273f7` server foundation** — `mwb/media-kinds.js` (suffix→kind, mirrors
  files.js) + `mwb/data-source.js` (the registry: `ds`-prefixed ids beside the
  buffer registry, findByPath reuse, the setState/onStateChange seam). server
  `readFileForVisit` returns a media descriptor (no byte read) for a media suffix;
  spine `visitFile` media branch → `dataSources.add` + `switchClientToSource`
  (focused leaf shows it; a tabline leaf adds a tab) — NO garbage text buffer.
  `makeLeafView` returns null for a ds (no cursor); the interpreter binds a
  fallback text buffer (no keys edit a media leaf). PANE_TREE leaf carries
  `{viewKind, filePath, state}`; nameForBuffer/tabMeta resolve data-sources.
- **`797525b` client render** — buildServerPaneNode / a tabline's active tab build
  the EXISTING element-view via createView({kind:viewKind}); bytes load async from
  `window.host.openFilePath` (serverMediaViewSpec mirrors
  openAsMediaViewIfRecognised) + bind onto the element (re-setBuffer / re-reconcile
  when ready). Media never touches the text mirror.
- **`baa3ce9` lists+restore** — bufferListRecords/bufferListRows include open
  data-sources, so media is in the View List + C-x C-b, and persistServerSession
  records its path → restoreServerSession reopens it → seedWindow1Tabline tabs it.
- **`90fadee` modeline** — a media-focused leaf's modeline shows the source's name
  + kind (not the fallback buffer).
- **`b6a8933` global keys** — in server mode the global router now routes
  held-modifier CHORDS to the server when a NON-TEXT view is focused (it deferred
  unconditionally before), so C-x C-f / M-x / C-x b work from a media view; bare
  keys (space=play/pause, arrows=seek) stay with the element.

**LIVE-VERIFY (Jason) — QUIT + RELAUNCH (server changes):**
`C-x C-c`, then `cd godot-mw-b/apps/desktop && GODOT_SERVER=1 ./node_modules/.bin/electron .`
1. **C-x C-f an .mp4 / .png / .pdf / .mp3 in window 1** → it opens as a video /
   image / pdf / audio TAB (NOT binary text); the tab + modeline show its name.
2. A video plays; space=play/pause, arrows=seek stay with the player; C-x C-f /
   C-x b still work while it's focused (the chord routes to the server).
3. C-x b lists the media (meta = its kind); switching back + forth works.
4. Re-open the same media file → reuses it (no duplicate). Quit + relaunch →
   the media file reopens as a tab (session restore).
5. Split a pane and open media in it (a bare media pane uses the per-kind SINGLETON
   — one such pane at a time; media-as-a-tab is the clean path).

**KNOWN GAPS (note for the next pass, not blockers):** a BARE media pane uses the
singleton (image/audio/video; pdf may not be a singleton → a bare pdf pane could
be blank — pdf-as-a-tab works); C-x k on a media leaf re-homes to a text buffer
but doesn't drop the data-source (leak); the global-key + async-mount + element
rendering are GUI-shaped (unverifiable here) so watch them in the verify. The
mutable-source fan-out (stella/jukebox) is the seam's reason for being — unbuilt.

## [2026-06-24] Media views LIVE-VERIFIED ("It worked!")

The data-source / media feature is live-verified by Jason after two follow-up
fixes to the overnight build:
- **`630a414`** — a bare media pane (a media file in a SECOND / 'single' window)
  rendered blank: the per-kind SINGLETON mounts via mountKindView's singleton
  fallback, which doesn't set `display` (the media singletons start
  `display:none`); the reconcile now calls `hideInactiveSingletons()` to reveal
  the in-use singleton.
- **`ceef3d4`** — garbled restore: on boot the server seeded its initial buffer
  from the session's ACTIVE file via `readFileSync(active,'utf8')` with no media
  check, so a media active file restored as a garbled TEXT buffer in window 1.
  Boot now seeds from the first TEXT file when the active is media (restore opens
  the media active as a data-source + switches to it); self-heals the session.

VERIFIED: open a PNG → it shows; quit + relaunch → it restores as an image tab
(not garbled text). The buffer→data-source generalisation is real and working.

**Still-open media gaps (small, deferred):** a BARE media pane uses the per-kind
SINGLETON → only one bare media pane of a given kind at a time (media-as-a-tab is
unaffected); `C-x k` on a media leaf re-homes but doesn't drop the data-source.
**Bigger next items:** RESTORE-of-structure (persist the pane tree / per-leaf
tabs); the MUTABLE data-source fan-out seam (stella/jukebox: a loaded ROM/song
syncing across duplicate views — the reason the seam exists). Then G4.3 → G5.

## [2026-06-24] find-file TAB-completion in server mode (case-insensitive + list) — awaiting verify

`f10d3a2`. The deferred find-file completion slice (HANDOVER §2), built as scoped:
a `MINIBUFFER_COMPLETE` query (client→server) → server computes → `MINIBUFFER_COMPLETIONS`
reply → client fills the input + shows candidates. New pure `path-complete.js`
(case-insensitive prefix completion, preserves typed casing + dir prefix, trailing
'/' for dirs; 8 tests); server `completeFindFilePath` wires the fs read; the
minibuffer's onTab sends the request, the reply setValue's + reuses the existing
"Completions" panel (extracted `displayCompletionsPanel`). Server change →
quit+relaunch. Suite 872. Only the 'Find file: ' prompt is wired (M-x /
switch-to-buffer completion would be the same shape, not done).

## [2026-06-24] find-file TAB-completion + media-tab fixes — LIVE-VERIFIED

Polishing media views into daily-usable shape. All live-verified by Jason.

- **find-file TAB-completion (`f10d3a2`)** — server-mode find-file had none. New
  pure `path-complete.js` (CASE-INSENSITIVE prefix completion; preserves the typed
  partial's casing + the dir prefix; trailing '/' for dirs; 8 tests) + a
  `MINIBUFFER_COMPLETE`/`MINIBUFFER_COMPLETIONS` round-trip; the reply fills the
  input + shows the existing "Completions" panel. Wired for the 'Find file:' prompt
  (M-x / switch-buffer would be the same shape, not done). "Works well."
- **media reveal (`630a414`)** — a media file in a 2nd window rendered blank: the
  bare-pane singleton mounts but the reconcile never revealed it → call
  `hideInactiveSingletons()`.
- **media boot-seed (`ceef3d4`)** — restore read the session's active MEDIA file as
  UTF-8 → garbled text buffer; boot now seeds from the first TEXT file when active
  is media (restore opens the media as a data-source + switches to it).
- **media-tab fixes (`b442fb5` + `6d4ee0a`)** — opening a 2nd media file while a
  media view was focused failed. Diagnosed via a temporary MEDIA_TRACE round-trip
  (since removed, `ec4c4d2`). Two real bugs: (1) restored media were open but
  HIDDEN (seedClientTabline filtered ids through `registry.has`, excluding
  data-sources → now keeps text buffers OR data-sources); (2) a focused media
  element forwarded chords to the IN-RENDERER dispatchKey (+ preventDefault), so
  C-x C-f was swallowed → new `serverMediaKeyOption()` routes media `onKey` to
  serverViewClient in server mode (mirrors text views). Also: media views carry
  `_serverBufferId` (clickable tabs); a media tab uses its element-view whether
  active or not (no proxy churn); the active-tab re-bind falls back to `setBuffer`
  for media. "That worked!"

Suite 872 (was 864 + 8 path-complete). Branch ~147 ahead, UNMERGED.

**Media follow-ons still open (small):** a BARE media pane uses the per-kind
SINGLETON (one at a time; media-as-a-tab is fine); `C-x k` on a media leaf doesn't
drop the data-source. **Bigger next:** the MUTABLE data-source fan-out seam
(stella/jukebox), RESTORE-of-structure (pane tree / per-leaf tabs), then G4.3 → G5.
A MERGE CHECKPOINT to main is worth considering (147 commits unmerged, flag-off
byte-for-byte).

## [2026-06-26 02:00] SVG editor (overnight build): MVP shipped, two decisions parked

**Context**: Built the Inkscape-like `<svg-editor-view>` per plans/SVG-EDITOR.md
on branch `svg-editor`. Phase-1 MVP (rect/ellipse/line/text + select/move/resize
+ save) and the headline LaTeX math boxes are in and reachable via `M-x svg-edit`.
6 commits, all on top of the design-doc commit; renderer suite 841/0, stdlib 883/0.
Live-verify is yours in the morning (I can't launch the GUI).

**Decision 1 — `.svg` default handler.** I did NOT change `.svg` ownership.
Plain `.svg` still opens as the read-only image view (media-kinds.js untouched);
the editor is an explicit `M-x svg-edit` entry point that opens a BLANK canvas.
The spec's §"Open questions" #1 recommends editor-by-default with a "view as
image" escape hatch — that is your call because it changes behaviour for anyone
who just wanted to *look* at an SVG. To make the editor the default later: route
`.svg` in `apps/desktop/src/media-kinds.js` and add an open-existing path
(parse file bytes → `setBuffer({svgText})`). I left it as-is to avoid a
behaviour change while you sleep. **Recommend: editor-by-default + a "View as
image" command, but confirm.**

**Decision 2 — MathJax defs id de-collision approach.** I took the
**prefix-rewrite** route, not `fontCache:'none'`. `svg-mathjax-ids.js`
(pure + 9 tests) namespaces every id and its references (`id=`,
`href`/`xlink:href` `#frag`, `url(#X)`) per box, so two math boxes in one
document don't collide MathJax's repeated `MJX-N-...` glyph ids and each box's
`<use>` resolves to its own `<defs>`. This keeps file size down and the
round-trip valid. The `fontCache:'none'` alternative (inline paths, no `<use>`)
is simpler but fatter; the prefix approach is the spec's recommendation (§"Open
questions" #2). **Needs your live spike: type two different formulas in two boxes,
save, reopen in a browser/Inkscape, confirm both render correctly.** The pure
helper is unit-tested but the real MathJax output structure can only be confirmed
live — if the namespacing misses an id form MathJax emits, that test sample
needs updating.

**What's NOT done (the budget line for one overnight session):**
- Host file-backed **save/open-existing** wiring. The MVP `save()` downloads the
  cleaned `.svg` via a Blob (works, but it's a download, not an in-place file
  write). Real save needs either an `onSave` host bridge through the element-view
  wrapper or the Model-B server-owned `svg-document` data-source (spec §6 / Phase
  0 + 5). I deliberately did NOT touch app.js territory for this overnight run.
- **Model-B / server data-source** (`svg-document` kind, per-instance client view,
  session-restore) — Phase 0/5, mirrors the shell/gnuplot ports. Untouched.
- Connectors, arrowheads, groups, rotate, pan/zoom UI, multi-select, snapping,
  PNG/PDF export — all later phases per the spec.

**State of the work**: branch `svg-editor`, 6 commits past the design doc, working
tree clean (this note is the only uncommitted change), both suites green. Pure
helpers (geometry / mathjax-ids / document-model) carry 38 unit tests; the live
element is exercised by you in Electron. Build order followed the brief: pure
testable helpers first, then the element, then the wiring.

---
