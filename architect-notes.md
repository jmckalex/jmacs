# Architect notes

Running log for decisions/blockers that need Jason. Newest first.

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
