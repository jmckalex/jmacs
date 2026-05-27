# Handover — jmacs session 2026-05-27

A snapshot for resuming work on **jmacs** in a fresh session. Read
`CLAUDE.md` first — it carries the standing working agreements
(branching, commits, testing discipline, territory). This file is the
where-things-stand record. The previous handover (2026-05-26) is
preserved in `git log` against `031ce05`; this one supersedes it.

## Where main is

HEAD: `6954846` (`Merge branch 'agent-pane-splits'`). **All test
suites green (936/936 — +37 from the prior 899: 13 new pane-primitive
tests, 15 pane tree/navigation/splitter-edges tests, 5 buffer
bindCursor tests, 4 view point/mark tests); desktop smoke PASS, 18
arms (was 16).**

The session's headline: **phase 3a of the panes reshape landed.**
The phase-2 pane tree (one leaf) gains user-facing split / delete /
navigate commands, splitter drag UI, the focus indicator becomes
visible with multiple panes, per-view point/mark, per-pane editor-
view instances, Q9 auto-duplicate + collision, auto-collapse on
empty pane, and `C-x 2 / 3 / 0 / 1 / o` bindings. Behind it: **phase
3b is fully designed.** `plans/PANES-PHASE-3B.md` is in the working
tree (currently untracked — see "Pending commits" below) with all
15 architecture open questions resolved by Jason inline + a
file-by-file implementation brief at the bottom. The 3b sub-agent
hasn't started yet; the brief is ready for dispatch.

## Landed this session

Merge bubble at top of `main`:

| Commit | What | Notes |
|---|---|---|
| `6954846` | `Merge branch 'agent-pane-splits'` | **Phase 3a of PANES.md.** Splits + delete + navigate + drag + focus indicator + per-view point/mark + per-pane editor instances + Q9 auto-duplicate + collision rule + auto-collapse + C-x 2/3/0/1/o + C-x C-<arrow> (provisional). Tests 936/936, smoke 18 arms. Live-verified at the mid-phase gate (after commit 3 — per-view-point + per-pane instances, app still works with one pane) and again post-merge with multi-pane behaviour. The merge body has the full feature list. |
| `3eb5a04` | `style(panes): subtle permanent border on every pane` | Direct-to-main on the branch before merge. Phase 3a's first multi-pane live test (`split-1.png` / `split-2.png`) showed unfocused panes blending together; replacing `.pane`'s transparent 1px border with a 40%-opacity `--fg-dim` outline fixed it. Focused pane keeps the accent border + inset shadow. |
| `a2f4823` | `feat(smoke): multi-pane arms` | Smoke arms covering split-and-focus-stays, splitter drag, delete, other-pane. |
| `199f4e5` | `feat(pane): Q9 auto-duplicate on open-file into another pane` | Opening a file already visible in another pane creates a fresh view over the same buffer in the current pane (text views only). Non-text views drop `*scratch*` into the new pane on split. The Q9 collision rule landed in commit 4 alongside the split commands rather than here (per the sub-agent's judgement — the brief allowed the coupling). |
| `c1738dc` | `feat(pane): split / delete / navigate commands` | The whole user-facing pane surface. `(split-horizontal! [ratio])`, `(split-vertical! [ratio])` returning `(handleLeft handleRight)` / `(handleTop handleBottom)`; focus stays on the originating pane (matches Emacs `C-x 2`/`3`). `(delete-pane!)` / `(delete-other-panes!)` auto-collapse. `(other-pane!)` cycles depth-first; `(focus-pane-direction! 'left|...)` uses spatial adjacency from `paneInDirection`. `(balance-panes!)`, `(set-split-ratio!)`. Splitter drag: 4 px handle per interior edge, pointer-capture + rAF-coalesced relayout. CSS for splitter handles + the visible `.pane--focused` border. Lisp: `panes.lisp` lands. Key bindings: C-x 2/3 split, C-x 0/1 delete, C-x o other-pane, C-x C-<arrow> pane-direction (provisional — see "Known issues"). |
| `832f1d8` | `refactor(desktop): per-pane editor-view instances` | Singleton `editorView` replaced with a `Map<paneId, EditorViewInstance>`. The kind registry's text spec creates one `createEditorView` per leaf, bound to that pane's div. Renderer's `setBuffer(buffer)` renamed to `setView(view)`. `hideInactiveRendererViews` rewritten to manage per-pane text instances; non-text singletons get hidden/detached as their views become active. With one pane it behaves identically; the multi-pane case is unblocked. |
| `c253890` | `refactor(buffer,view): point and mark move from buffer to view` | The per-view-point migration. **Judgement call worth preserving**: the sub-agent kept the buffer's cursor *API* (`buf.insert(text)`, `buf.moveLeft()`, etc.) but moved *storage* via a new `buffer.bindCursor(viewOrNull)` indirection — when bound, `buffer.point`/`buffer.mark` getters delegate to fields on the view; when unbound (bare-buffer tests), a local backing kicks in. Saved ~30 callsite refactors the literal brief reading would have required. The `buffer-primitives` auto-bind on every `currentBuffer()` read; the desktop app re-binds on every focus change (`setCurrentPaneId`) so the focused view's point follows the focus. Two views over one buffer get independent cursors. |
| `52532e5` | `feat(pane): tree helpers + spatial navigation` | New `packages/pane/src/navigation.js` (`paneInDirection`); extended `layout.js` with `computeSplitterEdges`; `tree.js` with `parentOf` / `siblingOf`. 15 new unit tests. Dormant when this commit landed; consumed by commit 4. |
| `5df8454` | `docs(panes): phase-3a implementation brief` | `plans/PANES-PHASE-3A.md`. File-by-file walkthrough; sub-agent followed it across two dispatches (commits 1–3 on the first, 4–6 on the second). |

The phase-3a chain spans seven commits between `52532e5` and
`a2f4823`, plus the small `3eb5a04` polish, landed via the
`--no-ff` merge `6954846` with full sub-commit history preserved.

## Pending commits

One file in the working tree, untracked, that the next session
should commit (or fold into the first 3b commit):

- `plans/PANES-PHASE-3B.md` — the phase 3b design doc + implementation
  brief. Jason resolved the 15 open questions inline (ALL CAPS,
  PANES.md style). The implementation brief at the bottom is ready
  to dispatch. Suggested commit: `docs(panes): phase-3b design +
  implementation brief`.

Other untracked files (pre-existing, not part of the work — leave
alone): `Makefile`, `inner.png`, `outer.png`, `no-longer-black.png`,
`split-1.png`, `split-2.png`, `working-shell.png`.

## Branches still ready for review

Five at session start. After this session's merge of
`agent-pane-splits`, four left. Same set as the prior handover
recorded; no new pre-existing branches were merged or created besides
phase 3a's work:

| Branch | HEAD | What it adds |
|---|---|---|
| `agent-multi-cursor` | `484b430` | Selection-set buffer + renderer foundation. **⚠ Lisp uses `hash-set` which doesn't exist; needs `assoc` fix** |
| `agent-lsp` | `3f3a666` | TypeScript LSP, diagnostics + hover |
| `agent-file-nav` | `074adab` | Fuzzy project find-file + sidebar tree |
| `agent-reactive-notebook` | `d453841` | Reactive Lisp notebook (engine phase) |

The `agent-pane-splits` branch is merged but its ref likely still
exists; can be deleted alongside the next bulk branch cleanup.

### Suggested merge order

Unchanged from the prior handover except that the view-without-buffer
model is now further along — phase 3a's per-view-point + per-pane
editor-instance work means `agent-reactive-notebook` can land
naturally once phase 3b is in too:

1. `agent-multi-cursor` — apply the `hash-set` → `assoc` fix first, then merge.
2. `agent-lsp` — largest standalone surface.
3. `agent-file-nav` — sidebar tree.
4. `agent-reactive-notebook` — best done after PANES phase 3b lands
   (the notebook view lives in a pane naturally; if it lands in a
   tabline-view alongside text files, the per-pane tabs are a clean
   home for it).

Expected conflict surfaces — likely larger now than the prior
handover noted, since phase 3a touched many of these:
`apps/desktop/src/app.js` (much larger after 3a),
`packages/stdlib/lisp/keymap.lisp`, `packages/stdlib/src/index.js`,
`apps/desktop/scripts/smoke.js`, `apps/desktop/styles.css`,
`packages/renderer/src/view.js`, `packages/buffer/src/buffer.js`.

## In flight / queued

- **Phase 3b — tabline-view, per pane.** The whole design + brief
  is in `plans/PANES-PHASE-3B.md`. Move the tabline from window
  chrome to a view kind that sits inside a pane; the global
  `#tabline-host` strip goes away, replaced visually by a root
  tabline-view containing the session-restored views.
  Open questions all resolved (see the table in the doc); 7 commits
  planned, ~half a focused day's work. Branch name: `agent-tabline-view`
  (from main). **First action in the next session**: commit the brief
  (it's untracked), then dispatch.

  Key resolutions worth carrying in working memory:
  - Auto-add-tab when current pane is a tabline-view; swap-view when
    current pane is a plain leaf (no auto-promote on open into a
    leaf).
  - `C-x ←` / `C-x →` cycle current pane's tabs only.
  - `C-x b` picker hides views shown in *other* panes.
  - `C-x k` kills focused tab; auto-collapses pane when tabline empties.
  - Tabline-views are *not* in the global `views[]` — they live only
    inside pane handles. Global list is leaf-kind views only.
  - Session schema bumps to v2; transparent v1→v2 migration.
  - Nested tabline-views: allowed (ugly but not forbidden).
  - Tabline-view's `name` derives from active child (modeline Just Works).
  - Flexbox inside the pane div for the four-edge tab strip layout.

- **Phase 3c (deferred).** Cross-pane drag-and-drop of tabs (move
  a tab from one pane's tabline to another). Jason noted "would
  be nice; don't worry about it for now." Material for a follow-up
  after 3b is solid.

- **Phase 4: multi-window.** Spawn additional `BrowserWindow`s,
  move the Lisp VM to the main process (Q5(a)), plumb IPC.
  `make-window!` / `delete-window!` / `other-window` /
  `focus-window!`. Unchanged from the prior handover.

Open follow-ups carried across phases (unchanged from prior, repeated
here so the next session has the full picture):

- **Pane-direction binding scheme.** The 3a sub-agent landed
  `C-x C-<arrow>` provisionally and was supposed to write a note to
  `architect-notes.md` — it didn't, so this slot is still open.
  Alternatives: `M-S-<arrow>`, a fresh `C-x C-o` prefix, or keeping
  `C-x C-<arrow>` as the final answer. Jason's call. Trivial to
  rebind in `packages/stdlib/lisp/keymap.lisp`.
- **`docs/CUSTOM-VIEWS.md` rewrite.** Still describes the old
  buffer-wrapper model from before phase 1. Needs rewriting to match
  `createView({ kind, name, buffer?, extras })` + kind registry.
- **`docs/MANUAL.jmd` + `docs/reference/commands.md` regen** for the
  renamed defcommands (post-phase-1).
- **`occur-buffer-name`** still has "buffer" in its name (internal
  helper).
- **Fixture-persistence bug.** `welcome.txt` and `scratch.lisp` are
  hardcoded in `app.js`'s initial views array and never persisted in
  session.json (no filePath → `isEphemeral`), so reordering them
  relative to user-opened files doesn't survive restart. Pre-existing,
  predates phase 1. Lean fix: drop the fixtures on subsequent
  launches (session-is-authoritative). Phase 3b's session schema
  v2 work is a natural moment to bundle this.
- **Layout precision shift** (1 line of editor visible) from phase
  2's `.pane` border interaction with the old flex layout. Phase 3a
  may or may not have touched this; quick check on the next live
  test.

## Architecture decisions worth preserving

Carried forward, lightly updated:

1. **Lisp at the seams; JS at the engine.** Unchanged.

2. **View is the addressable on-screen thing; buffer is L2 substrate.**
   Post-phase-1 of PANES.md. Eleven view kinds (text, customize, image,
   doc, jukebox, audio, video, directory-tree, directory-columns,
   shell, plus tabline stubbed in phase 2; **real tabline-view kind
   lands in phase 3b**).

3. **Faces as data, not CSS variables.** Unchanged.

4. **The map-update primitive is `assoc`, never `hash-set`.** Still
   the most-repeated mistake.

5. **Sync Lisp is a feature, not a bug.** Unchanged.

6. **`Cmd`/`Meta` maps to `C-` in key normalisation.** Unchanged.

7. **Chromium colour-manages CSS; Sublime writes native pixels.**
   Same `--bg-editor` = `#2e3842` story.

8. **Subprocesses go through Python for PTY needs.** Recorded in
   `architect-notes.md`. macOS's BSD `script(1)` doesn't work from
   Node; `python3 -c '<pty.spawn>'` is the cross-platform substitute.

9. **Point/mark live on the view; the buffer's cursor API delegates
   via `bindCursor`.** *New this session.* The buffer keeps
   `buf.insert(text)`, `buf.moveLeft()`, etc. as a working API; the
   storage of `point`/`mark` lives on the view (text kind only), and
   the buffer's getters/setters delegate via `buffer.bindCursor(view)`.
   When unbound (bare-buffer tests), a local backing kicks in. Two
   views over one buffer have independent cursors because the
   buffer's cursor source rebinds on every focus change.

10. **Pane-creating commands return handles.** Per Q15. The
    `(split-horizontal!)` / `(split-vertical!)` constructors return
    `(handleLeft handleRight)` / `(handleTop handleBottom)`;
    `(other-pane!)` returns the new current pane; etc. Lisp users
    can compose without re-resolving through `(current-pane)`.

11. **Focus stays on the originating pane after split.** *New this
    session.* Matches Emacs `C-x 2`/`3`. The pane that was current
    before the split is the same handle as the *first* child of the
    new split node; `currentPaneId` resolves to it naturally.

## Known issues / paper cuts

- **Binding displacements still pending** for unmerged branches
  (taste calls only Jason can make).
- **Multi-cursor branch still ships broken** (`hash-set` typo).
  Five-minute fix when its turn comes.
- **Token colours feel washed-out vs Sublime.** Unchanged; same
  sRGB-vs-native split as the background. Jason wants to be involved
  in palette decisions.
- **Faint strip at the bottom of the shell view.** Unchanged from
  prior handover. Same colour-management family as the muted-palette
  thread.
- **Tabline + panes don't play well together (visual bug, phase 3a
  byproduct).** With multiple panes, the global top-of-window tab
  strip still shows every view but doesn't say which pane is showing
  which — clicking a tab acts on whichever pane has focus. **This is
  the problem phase 3b is fixing.** Brief is ready.
- **Pane-direction key bindings provisional.** `C-x C-<arrow>` works
  but Jason hasn't picked the final scheme. Minor; rebind in
  `keymap.lisp` whenever.

## Plan documents

In `plans/`:

- `LANGUAGE-INJECTION.md` — implementation merged.
- `REACTIVE-NOTEBOOK.md` — phase 1 on `agent-reactive-notebook`.
- `FACE-CUSTOMISATION.md` — implementation merged.
- `SHELL-V4-XTERM.md` — implementation merged.
- `PANES.md` — guide notes for window/pane/view reshape + multi-window
  + view-without-buffer. All 15 open questions resolved.
- `PANES-PHASE-1.md` — implementation brief for phase 1; merged.
- `PANES-PHASE-2.md` — implementation brief for phase 2; merged.
- `PANES-PHASE-3A.md` — implementation brief for phase 3a; **merged
  this session** (`5df8454` brief + `6954846` merge).
- `PANES-PHASE-3B.md` — *new this session.* Design + open questions
  (all 15 resolved by Jason inline) + implementation brief. **Not yet
  committed** — see "Pending commits" above.

In `docs/`:

- `CUSTOM-VIEWS.md` — **still out of date** (describes the old
  buffer-wrapper model). Still needs rewriting.

## Tree-sitter inventory

After this session: **36 vendored grammars** (unchanged from prior
handover). No grammar changes this session.

## Memory / preferences saved

- **Direct-to-main commits are fine for small polish.** Branch +
  merge stays the default for feature-sized work.
- **Test before merge.** Sub-agent feature work: live test in the
  running app before merging; never auto-merge after tests-green.
  Reinforced this session — the mid-phase gate (after commits 1–3
  of 3a) caught no regressions but was psychologically valuable;
  the post-merge multi-pane test caught the missing pane borders.

## What's missing — the headlines

1. **Ship phase 3b** (tabline-view as per-pane kind). Brief ready;
   one dispatch away.
2. **LSP autocomplete.** `agent-lsp` lands the first half.
3. **Git integration.** Diff gutter, blame, basic conflict UI.
4. **Performance proven at scale.**
5. **Process isolation for user code.** Phase 1 proposal in the
   pre-prior handover (`git show 96ea97b -- HANDOVER.md`).
6. **A real README + 60-second demo.**

## Workflow lessons (this session)

1. **Splitting phase 3 into 3a + 3b paid off.** The 3a brief was
   already large (6 commits, two sub-agent dispatches with a
   live-test gate in between); folding tabline-view's per-pane
   redesign into the same phase would have made it unreviewable.
   Splitting let Jason see the splits work and ask for the next
   thing as a fresh design problem.

2. **The mid-phase gate matters even when it passes.** After commits
   1–3 of 3a (per-view-point migration + per-pane editor-instance
   refactor, with the app still showing one pane), the live test
   found nothing wrong — but the gate gave Jason confidence that
   the subtle refactors landed cleanly before the multi-pane code
   came on top. Don't skip the gate just because it's likely to
   pass.

3. **Permanent pane borders only surfaced in live test.** The data
   model + tests were perfect; the focused-only-border CSS made
   visual sense in unit-of-one but broke in unit-of-three. The fix
   was three lines of CSS. Reinforces: tests verify code correctness,
   not feature correctness. Live the UI before saying done.

4. **The bindCursor judgement call saved 30 callsite refactors.**
   The 3a brief said "remove `point` / `mark` locals from the buffer";
   the literal reading would have required rewriting every
   `buf.insert(text)` / `buf.moveLeft()` callsite to read the view's
   point first. The sub-agent's compromise — keep the buffer's API,
   move the *storage* to a view via `buffer.bindCursor(view)` — gave
   the same per-view-point semantic with a much smaller blast
   radius. Worth bookmarking as an example of "interpret the brief
   for what it's trying to achieve, not what it literally says."

5. **The 15-open-questions pattern is reusable.** Phase 3b's design
   doc followed `plans/PANES.md`'s style (model + open questions),
   and Jason answered in ALL CAPS in the doc itself. Same rhythm:
   draft questions with recommended leans, user resolves, append
   the implementation brief at the bottom. Works for design work
   that needs alignment before code.

## Suggested next steps in priority order

1. **Commit `plans/PANES-PHASE-3B.md`** to main as
   `docs(panes): phase-3b design + implementation brief`. Untracked
   currently; the next session's sub-agent needs it on main to brief
   from.

2. **Phase 3b sub-agent dispatch.** Branch `agent-tabline-view` from
   main. 7 commits (see the brief). Live-test gate: between commit 3
   (tabline strip renders correctly inside a pane via REPL
   construction) and commit 4 (real Lisp surface + auto-add-tab),
   or just at the end. Brief is the source of truth.

3. **Pane-direction binding scheme.** Trivial; pick `C-x C-<arrow>` /
   `M-S-<arrow>` / something else and rebind in `keymap.lisp`. Can
   ride in the next session's first commit.

4. **Fixture-persistence fix.** Naturally bundled with phase 3b's
   session schema v2 work — when v2 lands, drop the hardcoded
   `welcome.txt` / `scratch.lisp` from `app.js`'s initial views and
   seed them only on first launch when `session.json` doesn't yet
   exist.

5. **Merge the surviving review queue** (`agent-multi-cursor`,
   `agent-lsp`, `agent-file-nav`, `agent-reactive-notebook`) —
   ideally after phase 3b. Notebook benefits most from the
   tabline-view model.

6. **Rewrite `docs/CUSTOM-VIEWS.md`** to describe the post-phase-1
   pattern (`createView` + kind registry + `extras`). Deferred
   forever; do it.

7. **Phase 1 interruptibility.** Single highest-leverage architectural
   work. See the prior handover.

8. **Investigate the muted-palette issue.** Bundle the shell-view
   residual strip into the same investigation.

9. **Daily-drive for a week, then a real README + 60-second demo.**

10. **PANES phase 3c** (cross-pane drag of tabs) and **phase 4**
    (multi-window) and **LSP autocomplete** as focused follow-up
    sessions.

---

The story so far: a Lisp-extensible editor with a custom dialect, an
Electron presentation layer, real tree-sitter highlighting (36
languages), a face system customisable via `M-x customize-faces`,
documentation, a working jukebox with album art + metadata,
drag-resizable panes, a diagnostic `C-h F` for syntax highlighting,
directory-tree and Finder-style column browsers, double-click-to-open,
chord-prefix display in the echo area, find-file with tab-completion,
`M-x shell` running on xterm.js, and as of this session a real **pane
tree with user-facing splits**: side-by-side or top/bottom panes with
drag-resizable splitters, per-view cursors that survive splits, focus
indicator that shows which pane is active, and the architectural
foundation for the tabline-view kind that phase 3b makes visible.
Phases 3b (per-pane tabs) and 4 (multi-window) come next.
