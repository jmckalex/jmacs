# Handover — jmacs session 2026-05-27 (phase 3b + polish)

A snapshot for resuming work on **jmacs** in a fresh session. Read
`CLAUDE.md` first — it carries the standing working agreements
(branching, commits, testing discipline, territory). This file is
the where-things-stand record. The prior 2026-05-27 handover (phase
3b landing, pre-polish) is preserved in `git log` against `f09ec46`;
this one supersedes it. The 3a-landing handover before that is at
`bff550a`.

## Where main is

HEAD: `b1751c9` (`feat(find-file): case-insensitive tab completion
(default), togglable`). **All test suites green (983/983 — +13 from
the post-3b 970: +5 desktop session media-view round-trips, +5
desktop session width round-trips, +3 stdlib find-file case
sensitivity); smoke PASS, 17 arms.**

The session's headline: **phase 3b landed and then got polished
through eight follow-up commits.** Tabline-views are now a
first-class pane kind with the tab strip configurable per pane
(edge + width). Polish work caught the non-text-routing limitation
the brief had flagged as a follow-up, persisted media views across
restart, dropped the welcome/scratch seeds when a session restores,
fixed the active-tab indicator orientation on side tablines, sorted
out a horizontal-scroll cursor-paint-order bug, and made find-file's
tab completion case-insensitive by default.

This session also resolved the provisional pane-direction binding
left open by 3a (`C-x C-<arrow>` is now the final answer, no longer
provisional).

## Landed this session

Top of `main`, in order (newest first):

| Commit | What | Notes |
|---|---|---|
| `b1751c9` | `feat(find-file): case-insensitive tab completion (default), togglable` | New `defcustom *find-file-case-sensitive*` (default `#f`). Helpers `-prefix-match?` and `-chars-equal?` wrap the comparison; LCP keeps the on-disk case. 3 new stdlib tests. |
| `08e8446` | `feat(session): persist file-backed media views (image/audio/video)` | v2 serialiser emits `{kind, path}` for media views with `filePath`; deserialise + materialise route through `openByPath` → `openFileByPath` (same dispatch the dialog uses). 5 new session tests. Jukebox/shell/customize/doc/directory-* stay ephemeral. |
| `0b4605e` | `fix(session): drop the welcome/scratch seed views when a session restores` | Predicted by the prior handover to land with v2, didn't. Seeds tracked in `initialSeedViews`; after a successful `installRootPane`, spliced out of `views[]`. First launch (no session.json) still seeds the initial tabline. |
| `aa5dac9` | `fix(tabline): mount non-text active children inside the tabline content area` | Surfaced as "media views are broken" — the singleton DOM sat as a sibling of the `position:absolute, inset:0` tabline-pane and got covered. Fix: re-parent the active singleton into `.tabline-content` (move-not-clone, handlers survive). The brief flagged this as a follow-up; it's now done. |
| `4e7b671` | `feat(tabline): resizable strip width on vertical-edge tablines` | 4 px col-resize handle between strip and content; drag updates `view.width` (clamped 80-480 px). New optional `width` field on the v2 tabline-view blob. 1 view test + 4 session round-trip tests. |
| `3447643` | `fix(renderer): keep editor content layers from painting over the gutter` | `isolation: isolate` on `.editor-content` caps every layer inside (cursor, selection, brackets, overlay) below the sticky gutter's z-index 3. Horizontal scroll could otherwise slide the cursor under the gutter while still painting on top. |
| `7dfec71` | `fix(tabline): active-tab indicator on the inner edge per orientation` | Top/bottom/left/right tablines now each draw the accent line on the inside edge facing the content (box-shadow inset, no layout shift). Vertical tabs also drop the 220 px max-width and switch separator to a bottom border. |
| `f09ec46` | `docs: handover update for phase-3b landing` | (Superseded by this file.) |
| `a578a7b` | `Merge branch 'agent-tabline-view'` | **Phase 3b of PANES.md.** Eight sub-commits (the brief's 7-commit plan + one fix). Tabline-views in the registry, chrome removal + boot wrap, Lisp surface (`promote-to-tabline!` / `demote-tabline!` / `add-tab!` / `remove-tab!` / `activate-tab!` / `set-tabline-edge!` / etc.), open-file / kill-view / cycle scopes routed per pane, session schema v2 + v1→v2 migration, tabline smoke arm. Live-tested at two gates: post-commits-3-5 (core UX) and post-commits-6-7 (session restore). |
| `c0e25ab` | `chore(panes): confirm C-x C-<arrow> as final pane-direction binding` | Direct-to-main. Removed the "placeholder pending" comment and the matching open question from `architect-notes.md`. |

### The 8 sub-commits inside the 3b merge

| Commit | What |
|---|---|
| `0157f57` | `feat(view): tabline kind shape + isTablineView helper` |
| `3c5a96b` | `feat(tabline): real tabline kind in the registry + per-pane strip` |
| `6873b87` | `refactor(desktop): drop the global tabline chrome` |
| `93009ff` | `feat(lisp): tabline-view primitives + commands` |
| `7a9f10d` | `refactor(desktop): open-file / kill-view / cycle scopes per Q2 / Q5 / Q6` |
| `1098ff1` | `feat(session): schema v2 — pane tree + tabline membership` |
| `503773f` | `fix(session): thread handlesByBlob through the install callback` |
| `cfc2f91` | `feat(smoke): tabline arms — open / cycle / kill / split / restore` |

### A recovery worth recording

The 3b dispatch had two attempts. The first agent over-scoped
commit 3 by pulling commit-5 routing forward to keep the editor
usable at the mid-phase gate; Jason flagged it as weird in live
test and asked to restart. The recovery: tagged the first
attempt's tip as `agent-tabline-view-attempt-1` (SHA `0f26629`),
reset the branch to commit 2, and dispatched a fresh agent for
commits 3-5 together. The fresh agent independently arrived at
substantially the same machinery the first attempt had pulled
forward (`inheritExistingEditorIntoTabline`, the single-instance
refactor), confirming the boundary really was untenable.

## Pending commits

None. Working tree is clean apart from pre-existing untracked PNGs
(`inner.png`, `outer.png`, `split-1.png`, `split-2.png`,
`working-shell.png`, `no-longer-black.png`, `two-tablines.png`),
the stray `Makefile`, and a `session.json.pre-3b-backup` in the
Electron profile from the pre-3b live-test gate. Leave them alone.

## Branches still ready for review

Four. Unchanged since the post-3b handover.

| Branch | HEAD | What it adds |
|---|---|---|
| `agent-multi-cursor` | `37fd294` | Selection-set buffer + renderer foundation. The `hash-set` → `assoc` fix is on the branch (commit subject is literally the fix). Ready to merge. |
| `agent-lsp` | `3f3a666` | TypeScript LSP, diagnostics + hover. |
| `agent-file-nav` | `074adab` | Fuzzy project find-file + sidebar tree. |
| `agent-reactive-notebook` | `d453841` | Reactive Lisp notebook (engine phase). |

The `agent-pane-splits` and `agent-tabline-view` branches are merged
but their refs still exist; clean up in the next bulk pass. The tag
`agent-tabline-view-attempt-1` also still exists.

### Suggested merge order

1. **`agent-multi-cursor`** — fix is on the branch; should be a clean merge.
2. **`agent-reactive-notebook`** — previously gated on phase 3b
   landing. The notebook view sits naturally in a tabline-view
   alongside text files.
3. **`agent-lsp`** — largest standalone surface.
4. **`agent-file-nav`** — sidebar tree.

Expected conflict surfaces — larger now than the prior handover
noted, since 3b touched many of these:
`apps/desktop/src/app.js` (substantially larger after 3b + polish:
open-file / kill-view routing, session restore, tabline mount,
peelTabline, non-text re-parenting, seed-view cleanup),
`apps/desktop/src/session.js` (v2 schema, media-view persistence),
`apps/desktop/index.html` (tabline-host gone),
`apps/desktop/styles.css` (tabline-pane / tabline-strip /
tabline-content + tabline-resizer + editor-content isolation),
`apps/desktop/src/tabline.js` (per-tabline options),
`packages/stdlib/lisp/keymap.lisp`, `packages/stdlib/lisp/files.lisp`,
`packages/stdlib/src/index.js`, `packages/view/src/view.js`
(tabline width field).

## In flight / queued

- **Phase 3c (deferred).** Cross-pane drag-and-drop of tabs (move
  a tab from one pane's tabline to another). Jason: "would be nice;
  don't worry about it for now."

- **Phase 4: multi-window.** Spawn additional `BrowserWindow`s,
  move the Lisp VM to the main process (Q5(a) of PANES.md), plumb
  IPC. `make-window!` / `delete-window!` / `other-window` /
  `focus-window!`.

Open follow-ups carried across phases:

- **`docs/CUSTOM-VIEWS.md` rewrite.** Still describes the old
  buffer-wrapper model from before phase 1. Also outdated for the
  kind-registry mount/dispose contract that 3b extended (the
  optional `{ paneEl }` context for nested mounts) and for the
  non-text re-parenting added in the polish session.
- **`docs/MANUAL.jmd` + `docs/reference/commands.md` regen** for the
  renamed defcommands (post-phase-1) and the new tabline / find-file
  commands.
- **`occur-buffer-name`** still has "buffer" in its name (internal
  helper).
- **Layout precision shift** (1 line of editor visible) from phase
  2's `.pane` border interaction with the old flex layout. Probably
  unchanged by 3b's tabline-pane / strip / content rules; quick
  check next live drive.
- **Persist more than media views**. The polish session persisted
  image / audio / video views. Jukebox views also have a directory
  path that could be persisted by routing through
  `openJukeboxForDirectory`; shell / customize / doc / directory-*
  have different re-open semantics. Not requested yet; flagging.

## Architecture decisions worth preserving

Carried forward, with one new entry:

1. **Lisp at the seams; JS at the engine.** Unchanged.

2. **View is the addressable on-screen thing; buffer is L2 substrate.**
   Twelve view kinds (eleven + the now-real tabline).

3. **Faces as data, not CSS variables.** Unchanged.

4. **The map-update primitive is `assoc`, never `hash-set`.** Still
   the most-repeated mistake. Multi-cursor branch's own fix commit
   names this directly.

5. **Sync Lisp is a feature, not a bug.** Unchanged.

6. **`Cmd`/`Meta` maps to `C-` in key normalisation.** Unchanged.

7. **Chromium colour-manages CSS; Sublime writes native pixels.**
   Same `--bg-editor` = `#2e3842` story.

8. **Subprocesses go through Python for PTY needs.** macOS's BSD
   `script(1)` doesn't work from Node; `python3 -c '<pty.spawn>'`
   is the cross-platform substitute.

9. **Point/mark live on the view; the buffer's cursor API delegates
   via `bindCursor`.** Now also threaded through tabline-views —
   `setCurrentPaneId` peels a tabline-view to its active child when
   binding the cursor.

10. **Pane-creating commands return handles.** Per Q15.

11. **Focus stays on the originating pane after split.** Matches
    Emacs `C-x 2`/`3`.

12. **Tabline-views are *not* in the global `views[]` list.** They
    live only inside pane handles. Each tabline-view owns a single
    editor-view DOM instance reused across tab switches.
    `viewHost.currentView` peels tablines to their active child.

13. **Non-text active tabs are re-parented into the tabline content
    area on activation.** *New this session.* The renderer
    singletons (image / audio / video / jukebox / customize / doc /
    shell / directory-*) mount at startup with `editorPaneElement()`
    as their parent; on tabline activation, the active singleton
    moves into `.tabline-content` (move-not-clone, so event handlers
    + internal state survive). Only one tabline can host any given
    singleton at a time; switching between panes ping-pongs the
    singleton between content areas. The brief had flagged this as
    a follow-up; it's now load-bearing.

## Known issues / paper cuts

- **Binding displacements still pending** for unmerged branches
  (taste calls only Jason can make).
- **Token colours feel washed-out vs Sublime.** Unchanged; same
  sRGB-vs-native split as the background. Jason wants to be
  involved in palette decisions.
- **Faint strip at the bottom of the shell view.** Unchanged.
  Same colour-management family as the muted-palette thread.

### Resolved this session

- The tabline + panes visual bug (the global tab strip didn't say
  which pane was showing which) — fixed by 3b.
- The pane-direction key binding scheme — resolved to
  `C-x C-<arrow>`, no longer provisional.
- The multi-cursor branch's `hash-set` typo — fixed on the branch.
- Active-tab indicator on side tablines was on the wrong edge —
  fixed (`7dfec71`).
- Side tablines were a fixed 160 px wide — now drag-resizable +
  persisted in session (`4e7b671`).
- Cursor / current-line / selection painted on top of the sticky
  gutter when scrolled horizontally — fixed (`3447643`).
- Non-text active tabs were covered by the tabline-pane — fixed
  (`aa5dac9`); the brief's "follow-up" item is now done.
- Welcome / scratch seed views accumulated at the head of `views`
  across restarts — fixed (`0b4605e`).
- File-backed media views (image/audio/video) didn't survive a quit
  — fixed (`08e8446`); now persisted via path in the v2 blob.
- Find-file tab completion was case-sensitive — fixed (`b1751c9`);
  now case-insensitive by default, togglable via
  `*find-file-case-sensitive*`.

## Plan documents

In `plans/`:

- `LANGUAGE-INJECTION.md` — implementation merged.
- `REACTIVE-NOTEBOOK.md` — phase 1 on `agent-reactive-notebook`.
- `FACE-CUSTOMISATION.md` — implementation merged.
- `SHELL-V4-XTERM.md` — implementation merged.
- `PANES.md` — guide notes. All 15 open questions resolved.
- `PANES-PHASE-1.md` — merged.
- `PANES-PHASE-2.md` — merged.
- `PANES-PHASE-3A.md` — merged.
- `PANES-PHASE-3B.md` — merged this session.

In `docs/`:

- `CUSTOM-VIEWS.md` — **still out of date.** Needs rewriting for
  the kind-registry mount/dispose contract (including 3b's optional
  `{ paneEl }` context for nested mounts and the polish session's
  non-text re-parenting into `.tabline-content`).

## Tree-sitter inventory

**36 vendored grammars** (unchanged).

## Memory / preferences saved

- **Direct-to-main commits are fine for small polish.** Branch +
  merge stays the default for feature-sized work. Reinforced this
  session — eight polish commits direct-to-main, none warranted a
  branch.
- **Test before merge.** Sub-agent feature work: live test in the
  running app before merging; never auto-merge after tests-green.
  Reinforced by the 3b recovery.

## What's missing — the headlines

1. **LSP autocomplete.** `agent-lsp` lands the first half.
2. **Git integration.** Diff gutter, blame, basic conflict UI.
3. **Performance proven at scale.**
4. **Process isolation for user code.** Phase 1 proposal in the
   pre-prior handover (`git show 96ea97b -- HANDOVER.md`).
5. **A real README + 60-second demo.**
6. **PANES phase 4** (multi-window) and **3c** (cross-pane tab
   drag).

## Workflow lessons (this session)

1. **Brief boundaries can be technically untenable; agent over-scope
   may be the agent reading the situation right.** The 3b commit-3
   recovery confirmed this; the polish session reconfirmed it from
   a different angle — the brief's "non-text routing into content
   area is a follow-up" turned out to be load-bearing the moment a
   user activated a media tab, not a deferrable polish item.
   *Application*: when a brief defers something as "future phase,"
   check whether the deferral leaves the user-visible UX in a
   broken state. If yes, it's not a follow-up — it's part of the
   current phase.

2. **Tag + reset + redispatch is a clean recovery pattern.** Tag
   the current tip (`agent-<branch>-attempt-1`) before any reset.
   The branch ref moves freely; the tag preserves the work for
   diffing.

3. **The "stop after commit N" instruction in a multi-commit
   dispatch is load-bearing.** The two 3b dispatches each landed
   cleanly because the stop point gave Jason a real gate.

4. **For 7-commit phases that split into a coupled-pair + a
   migration pair, dispatch the coupled pair together.** A
   7-commit phase probably wants 2 dispatches, not 7.

5. **Visual regressions surface in batches when the user finally
   exercises the feature.** The polish session's screenshot review
   surfaced three issues at once (indicator orientation, no
   resizer, cursor in gutter), and a separate session caught two
   more (non-text routing, media persistence). Lesson: build
   in a deliberate "drive every feature in the running app" pass
   before declaring a phase done.

## Suggested next steps in priority order

1. **Merge the surviving review queue** (multi-cursor first, then
   notebook, then lsp, then file-nav). Notebook is unblocked by
   3b; multi-cursor's blocker is already fixed.

2. **Rewrite `docs/CUSTOM-VIEWS.md`** to describe the post-phase-1
   pattern (`createView` + kind registry + `extras`), the 3b mount
   contract (`paneEl` context for nested mounts), and the polish
   session's non-text re-parenting into `.tabline-content`.

3. **Drive every feature in the running app and capture issues.**
   The polish session showed how many bugs hide until the user
   exercises a feature for real. Worth one focused pass before the
   review queue lands — the queue will conflict more if `main` has
   open paper cuts.

4. **Phase 1 interruptibility.** Single highest-leverage
   architectural work. See the pre-prior handover.

5. **Investigate the muted-palette issue.** Bundle the shell-view
   residual strip into the same investigation.

6. **Daily-drive for a week, then a real README + 60-second demo.**

7. **PANES phase 3c** (cross-pane drag of tabs) and **phase 4**
   (multi-window) and **LSP autocomplete** as focused follow-up
   sessions.

8. **Branch + tag cleanup.** `agent-pane-splits`,
   `agent-tabline-view`, and tag `agent-tabline-view-attempt-1`
   are all still around.

---

The story so far: a Lisp-extensible editor with a custom dialect, an
Electron presentation layer, real tree-sitter highlighting (36
languages), a face system customisable via `M-x customize-faces`,
documentation, a working jukebox with album art + metadata, a
**pane tree with user-facing splits** (per-view cursors,
drag-resizable splitters, focus indicator), **per-pane tabline-views**
(configurable edge + drag-resizable width, session-restorable end-to-
end, non-text content re-parented into the tabline area on activation,
media views persisted by path across restarts), find-file with
case-insensitive completion, drag-resizable preview/REPL splitters,
a diagnostic `C-h F` for syntax highlighting, directory-tree and
Finder-style column browsers, double-click-to-open, chord-prefix
display in the echo area, `M-x shell` running on xterm.js. Next big
moves are the four-branch review queue (multi-cursor / notebook /
lsp / file-nav) and then phase 4 (multi-window).
