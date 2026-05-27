# Handover — jmacs session 2026-05-27 (phase 3b)

A snapshot for resuming work on **jmacs** in a fresh session. Read
`CLAUDE.md` first — it carries the standing working agreements
(branching, commits, testing discipline, territory). This file is
the where-things-stand record. The prior 2026-05-27 handover (phase
3a landing) is preserved in `git log` against `bff550a`; this one
supersedes it.

## Where main is

HEAD: `a578a7b` (`Merge branch 'agent-tabline-view'`). **All test
suites green (970/970 — +34 from the prior 936: +6 view, +17 stdlib
pane-primitives, +11 desktop session migration + smoke); smoke
PASS, 17 arms (was 18 reported in prior handover; arm-vs-line
counting consolidated during 3b, no arms dropped).**

The session's headline: **phase 3b of the panes reshape landed.**
Tabline-views are now a first-class pane kind. The global tabline
chrome is gone; every pane is either a leaf-view, a split node, or
a tabline-view containing other views. Session schema bumped to v2
with transparent v1→v2 migration. The on-disk session.json
round-trips the full pane tree + tab membership + active tab +
current pane across quits.

This session also resolved the provisional pane-direction binding
left open by 3a (`C-x C-<arrow>` is now the final answer, no longer
provisional).

## Landed this session

Top of `main`, in order:

| Commit | What | Notes |
|---|---|---|
| `a578a7b` | `Merge branch 'agent-tabline-view'` | **Phase 3b of PANES.md.** Eight sub-commits (the brief's 7-commit plan + one fix). Tabline-views in the registry, chrome removal + boot wrap, Lisp surface (`promote-to-tabline!` / `demote-tabline!` / `add-tab!` / `remove-tab!` / `activate-tab!` / `set-tabline-edge!` / etc.), open-file / kill-view / cycle scopes routed per pane, session schema v2 + v1→v2 migration, tabline smoke arm. Live-tested at two gates: post-commits-3-5 (core UX) and post-commits-6-7 (session restore). The merge body has the full feature list. |
| `c0e25ab` | `chore(panes): confirm C-x C-<arrow> as final pane-direction binding` | Direct-to-main. Removed the "placeholder pending" comment in `keymap.lisp` and dropped the matching open question from `architect-notes.md`. Behaviour unchanged; the 3a provisional binding is the final choice. |

### The 8 sub-commits inside the 3b merge

| Commit | What |
|---|---|
| `0157f57` | `feat(view): tabline kind shape + isTablineView helper` |
| `3c5a96b` | `feat(tabline): real tabline kind in the registry + per-pane strip` |
| `6873b87` | `refactor(desktop): drop the global tabline chrome` |
| `93009ff` | `feat(lisp): tabline-view primitives + commands` |
| `7a9f10d` | `refactor(desktop): open-file / kill-view / cycle scopes per Q2 / Q5 / Q6` |
| `1098ff1` | `feat(session): schema v2 — pane tree + tabline membership` |
| `503773f` | `fix(session): thread handlesByBlob through the install callback` (caught by commit 7's smoke; kept as a separate commit per the no-amend rule) |
| `cfc2f91` | `feat(smoke): tabline arms — open / cycle / kill / split / restore` |

### A recovery worth recording

The 3b dispatch had two attempts. The first agent over-scoped
commit 3 by pulling commit-5 routing forward to keep the editor
usable at the mid-phase gate. The brief had implied a strict
separation between commits 3 (chrome removal + boot wrap) and 5
(open-file routing); the agent decided the boundary was untenable
and the commit's body explained why. After the first attempt
landed (clean tests + smoke), Jason flagged that things looked
weird in live test and asked to recover and restart.

The recovery: tagged the first attempt's tip as
`agent-tabline-view-attempt-1` (SHA `0f26629`) for reference, reset
the branch to commit 2, and dispatched a fresh agent for commits
3-5 together — sidestepping the artificial split. The fresh agent
independently arrived at substantially the same machinery the first
attempt had pulled forward (`inheritExistingEditorIntoTabline`, the
single-instance refactor), confirming the boundary really was
untenable. Lesson recorded under "Workflow lessons."

## Pending commits

None. Working tree is clean apart from pre-existing untracked PNG
screenshots and the stray `Makefile` (leave alone — same as prior
handover).

## Branches still ready for review

Four. Same set as the prior handover, minus `agent-tabline-view`
(merged this session). One has moved on:

| Branch | HEAD | What it adds |
|---|---|---|
| `agent-multi-cursor` | `37fd294` | Selection-set buffer + renderer foundation. **The `hash-set` → `assoc` fix is now applied** (was a known blocker in the prior handover; commit subject is literally the fix). Ready to merge. |
| `agent-lsp` | `3f3a666` | TypeScript LSP, diagnostics + hover |
| `agent-file-nav` | `074adab` | Fuzzy project find-file + sidebar tree |
| `agent-reactive-notebook` | `d453841` | Reactive Lisp notebook (engine phase) |

The `agent-pane-splits` and `agent-tabline-view` branches are merged
but their refs still exist; clean up in the next bulk pass. The tag
`agent-tabline-view-attempt-1` also still exists.

### Suggested merge order

Updated for the new state:

1. **`agent-multi-cursor`** — fix is in; should be a clean merge now.
2. **`agent-reactive-notebook`** — previously gated on phase 3b
   landing. It does now. The notebook view sits naturally in a
   tabline-view alongside text files.
3. **`agent-lsp`** — largest standalone surface.
4. **`agent-file-nav`** — sidebar tree.

Expected conflict surfaces — likely larger than the prior handover
noted, since 3b touched many of these:
`apps/desktop/src/app.js` (substantially larger after 3b: open-file
/ kill-view routing, session restore, tabline mount, peelTabline),
`apps/desktop/src/session.js` (now v2 schema), `apps/desktop/index.html`
(tabline-host gone), `apps/desktop/styles.css` (tabline-pane /
tabline-strip / tabline-content rules), `apps/desktop/src/tabline.js`
(per-tabline options), `packages/stdlib/lisp/keymap.lisp`,
`packages/stdlib/src/index.js`.

## In flight / queued

- **Fixture-persistence fix.** The handover predicted this would
  naturally land with the v2 session schema work. It didn't — the
  3b agent stayed focused on the brief and left the
  `welcome.txt` + `scratch.lisp` hardcoded in `app.js`'s initial
  views array. Still pending. Lean fix: drop the fixtures on
  subsequent launches (session is authoritative when present); seed
  them only when `session.json` doesn't yet exist. Probably 20-30
  minutes direct-to-main.

- **Phase 3c (deferred).** Cross-pane drag-and-drop of tabs (move
  a tab from one pane's tabline to another). Jason: "would be nice;
  don't worry about it for now." Material for a follow-up.

- **Phase 4: multi-window.** Spawn additional `BrowserWindow`s,
  move the Lisp VM to the main process (Q5(a) of PANES.md), plumb
  IPC. `make-window!` / `delete-window!` / `other-window` /
  `focus-window!`. Unchanged from prior.

- **Non-text-tab content area routing.** Acknowledged limitation
  from 3b: image / audio / video / customize / doc / shell tabs
  still mount their pre-tabline singleton DOM inside
  `editor-host`, not inside the tabline content area. The strip
  renders correctly; the visible content for those tabs sits where
  it always did. Future phase.

Open follow-ups carried across phases:

- **`docs/CUSTOM-VIEWS.md` rewrite.** Still describes the old
  buffer-wrapper model from before phase 1. Now also outdated for
  the kind-registry mount/dispose contract that 3b extended (the
  optional `{ paneEl }` context for nested mounts).
- **`docs/MANUAL.jmd` + `docs/reference/commands.md` regen** for the
  renamed defcommands (post-phase-1) and the new tabline commands
  (this session).
- **`occur-buffer-name`** still has "buffer" in its name (internal
  helper).
- **Layout precision shift** (1 line of editor visible) from phase
  2's `.pane` border interaction with the old flex layout. 3b's
  tabline-pane / tabline-strip / tabline-content rules may or may
  not have touched this; quick check next live drive.

## Architecture decisions worth preserving

Carried forward, with one new entry:

1. **Lisp at the seams; JS at the engine.** Unchanged.

2. **View is the addressable on-screen thing; buffer is L2 substrate.**
   Post-phase-1 of PANES.md. Twelve view kinds now (the eleven
   from prior + tabline as a real kind, not a stub).

3. **Faces as data, not CSS variables.** Unchanged.

4. **The map-update primitive is `assoc`, never `hash-set`.** Still
   the most-repeated mistake. Multi-cursor branch's own fix commit
   names this directly.

5. **Sync Lisp is a feature, not a bug.** Unchanged.

6. **`Cmd`/`Meta` maps to `C-` in key normalisation.** Unchanged.

7. **Chromium colour-manages CSS; Sublime writes native pixels.**
   Same `--bg-editor` = `#2e3842` story.

8. **Subprocesses go through Python for PTY needs.** Recorded in
   `architect-notes.md`. macOS's BSD `script(1)` doesn't work from
   Node; `python3 -c '<pty.spawn>'` is the cross-platform substitute.

9. **Point/mark live on the view; the buffer's cursor API delegates
   via `bindCursor`.** Established in 3a. Now also threaded through
   tabline-views — `setCurrentPaneId` peels a tabline-view to its
   active child when binding the cursor.

10. **Pane-creating commands return handles.** Per Q15. Composable
    from Lisp without re-resolving through `(current-pane)`.

11. **Focus stays on the originating pane after split.** Matches
    Emacs `C-x 2`/`3`.

12. **Tabline-views are *not* in the global `views[]` list.** *New
    this session.* They live only inside pane handles. The global
    `views[]` is leaf-kind views only. Consequence: `C-x b`'s
    underlying view list never includes tabline-views (you can't
    "switch to a tabline"); the picker further filters out views
    visible in other panes (Q4). Each tabline-view owns a single
    editor-view DOM instance that is reused across tab switches
    (per-view-point + sticky-notes / hover-doc / inline-eval
    references survive switching). `viewHost.currentView` peels
    tabline-views to their active child; non-peeled callers
    (mostly the kind registry) see the tabline-view itself.

## Known issues / paper cuts

Updated:

- **Binding displacements still pending** for unmerged branches
  (taste calls only Jason can make).
- **Token colours feel washed-out vs Sublime.** Unchanged; same
  sRGB-vs-native split as the background. Jason wants to be
  involved in palette decisions.
- **Faint strip at the bottom of the shell view.** Unchanged.
  Same colour-management family as the muted-palette thread.
- **Non-text active tabs overlay the tabline content area.** New
  this session. An image / audio / video / customize / doc / shell
  active tab uses its pre-tabline singleton DOM, which sits inside
  `editor-host` and visually sits where the tabline content area
  would be. Strip stays in the DOM; switching back to a text tab
  restores everything visually. Future-phase work.
- **Resolved this session**:
  - The tabline + panes visual bug (the global tab strip didn't
    say which pane was showing which) — fixed by 3b.
  - The pane-direction key binding scheme — resolved to `C-x C-<arrow>`,
    no longer provisional.
  - The multi-cursor branch's `hash-set` typo — fixed on the
    branch itself.

## Plan documents

In `plans/`:

- `LANGUAGE-INJECTION.md` — implementation merged.
- `REACTIVE-NOTEBOOK.md` — phase 1 on `agent-reactive-notebook`.
- `FACE-CUSTOMISATION.md` — implementation merged.
- `SHELL-V4-XTERM.md` — implementation merged.
- `PANES.md` — guide notes for window/pane/view reshape +
  multi-window + view-without-buffer. All 15 open questions
  resolved.
- `PANES-PHASE-1.md` — implementation brief for phase 1; merged.
- `PANES-PHASE-2.md` — implementation brief for phase 2; merged.
- `PANES-PHASE-3A.md` — implementation brief for phase 3a; merged.
- `PANES-PHASE-3B.md` — implementation brief for phase 3b; **merged
  this session** (the 8-commit merge `a578a7b`).

In `docs/`:

- `CUSTOM-VIEWS.md` — **still out of date.** Needs rewriting for
  the kind-registry mount/dispose contract (including 3b's optional
  `{ paneEl }` context for nested mounts).

## Tree-sitter inventory

After this session: **36 vendored grammars** (unchanged). No
grammar changes this session.

## Memory / preferences saved

- **Direct-to-main commits are fine for small polish.** Branch +
  merge stays the default for feature-sized work.
- **Test before merge.** Sub-agent feature work: live test in the
  running app before merging; never auto-merge after tests-green.
  Reinforced this session by the recovery — the agent's tests +
  smoke were green; live test surfaced (or seemed to surface) a
  symptom that triggered the restart.

## What's missing — the headlines

Updated; 3b no longer #1:

1. **LSP autocomplete.** `agent-lsp` lands the first half.
2. **Git integration.** Diff gutter, blame, basic conflict UI.
3. **Performance proven at scale.**
4. **Process isolation for user code.** Phase 1 proposal in the
   pre-prior handover (`git show 96ea97b -- HANDOVER.md`).
5. **A real README + 60-second demo.**
6. **PANES phase 4** (multi-window) and **3c** (cross-pane tab
   drag) as focused follow-up sessions.

## Workflow lessons (this session)

1. **Brief boundaries can be technically untenable; agent over-scope
   may be the agent reading the situation right.** The 3b brief
   split commits 3 and 5 so that 3 was "drop chrome + boot wrap" and
   5 was "rewrite open-file / kill-view / cycle." The first agent
   pulled some of commit-5's machinery into commit 3 because boot
   wrap without peelTabline + an open-file routing path leaves the
   editor unusable at the gate. The fresh agent, dispatched
   strictly for the brief's commit-3 scope, independently came to
   the same conclusion and pulled the same machinery in. The
   "scope creep" was, in fact, the correct read of an
   under-specified brief boundary.

   *Application*: when an agent self-flags scope expansion in a
   commit body and explains it as technical necessity, weigh the
   explanation before assuming it's a mistake. The first call
   should be: read the commit body, decide whether the technical
   argument holds, and only roll back if it doesn't.

2. **Tag + reset + redispatch is a clean recovery pattern.** When
   in doubt about an agent's work, tag the current tip
   (`agent-<branch>-attempt-1`) before any reset. The branch ref
   then moves freely; the tag preserves the work for diffing and
   reference. Doesn't cost anything if the recovery turns out
   unnecessary — the tag just becomes a curiosity.

3. **The "stop after commit N" instruction in a multi-commit
   dispatch is load-bearing.** The two 3b dispatches (3-5 and 6-7)
   each landed cleanly because the stop point gave Jason a real
   gate to live-test against. The agent that did 3-5 also landed
   its acknowledged limitations cleanly because it knew commit 5
   was the gate and the limitations would be re-examined.

4. **For 7-commit phases that split into a coupled-pair + a
   migration pair, dispatch the coupled pair together.** The brief
   plan had 7 commits; the natural split for this session was 3-5
   (the tabline-as-kind UX) and 6-7 (session schema + smoke). The
   single-commit dispatch attempt for commit 3 alone exposed the
   coupling. Bigger lesson for future planning: a 7-commit phase
   probably wants 2 dispatches, not 7.

## Suggested next steps in priority order

1. **Fixture-persistence fix.** Small, predicted by prior handover
   to land with v2, didn't. Direct-to-main. ~20-30 minutes.

2. **Merge the surviving review queue** in the order above
   (multi-cursor first, then notebook, then lsp, then file-nav).
   Notebook is now unblocked.

3. **Rewrite `docs/CUSTOM-VIEWS.md`** to describe the post-phase-1
   pattern (`createView` + kind registry + `extras`) and the
   3b-extended mount contract (optional `paneEl` context for nested
   mounts).

4. **Pane-direction key bindings cleanup** — actually nothing
   needed here; `C-x C-<arrow>` is the final answer as of this
   session.

5. **Phase 1 interruptibility.** Single highest-leverage
   architectural work. See the prior handover.

6. **Investigate the muted-palette issue.** Bundle the shell-view
   residual strip into the same investigation.

7. **Daily-drive for a week, then a real README + 60-second demo.**

8. **PANES phase 3c** (cross-pane drag of tabs) and **phase 4**
   (multi-window) and **LSP autocomplete** as focused follow-up
   sessions.

9. **Branch + tag cleanup.** `agent-pane-splits`,
   `agent-tabline-view`, and tag `agent-tabline-view-attempt-1`
   are all still around. Sweep with the next bulk cleanup.

---

The story so far: a Lisp-extensible editor with a custom dialect, an
Electron presentation layer, real tree-sitter highlighting (36
languages), a face system customisable via `M-x customize-faces`,
documentation, a working jukebox with album art + metadata,
drag-resizable panes, a diagnostic `C-h F` for syntax highlighting,
directory-tree and Finder-style column browsers, double-click-to-open,
chord-prefix display in the echo area, find-file with tab-completion,
`M-x shell` running on xterm.js, a **pane tree with user-facing
splits** (per-view cursors, drag-resizable splitters, focus
indicator), and as of this session **per-pane tabline-views**: the
tabline is no longer global window chrome; it's a first-class view
kind that any pane can host, configurable per-tabline (edge,
membership), session-restorable end-to-end. Phases 4 (multi-window)
and 3c (cross-pane tab drag) come next.
