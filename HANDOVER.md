# Handover — jmacs session 2026-05-29 → 30 (views-as-custom-elements refactor in flight)

A snapshot for resuming work on **jmacs** (renaming to **Godot** —
the prior handover's intent is still queued; see "What's parked"
below). Read `CLAUDE.md` first — it carries the standing working
agreements. This file supersedes the 2026-05-28 handover (preserved
in `git log` against `030a2ac`).

The prior handover predates the entire package-system arc plus the
priority-1 architectural refactor that now governs the queue. The
chain back: that 2026-05-28 file ↔ phase-3b polish at `0b596f5`.

This is **the most architecturally significant session** in the
chain. The branch shape is unusual:

- **`main`** carries two new tabline-session fixes cherry-picked
  from the work branches, but otherwise stays at the pre-
  refactor / pre-packages baseline.
- **`agent-package-system-phase-1`** — paused. Holds Phase 1 + 2 of
  the package system, the modal palette, a substantial pile of
  smaller fixes and decisions. **Will not merge to main until
  the views refactor lands**, and may need re-applying on top.
- **`agent-views-as-custom-elements`** — active. Phases 0, 1, 2a,
  2b, 2c of the refactor described in
  `plans/VIEWS-AS-CUSTOM-ELEMENTS.md`. Phase 2c was committed
  unverified at runtime — see "Phase 2c runtime status."

## Where main is

HEAD: `01e8646`. Two cherry-picked tabline-session fixes since the
prior handover's `9c06bea` baseline:

| Commit | What |
|---|---|
| `01e8646` | `fix(session): restore each tab as its own View handle so close-X is tab-local` |
| `0e9c4af` | `fix(session): stop the auto-duplicate path from accumulating tabs` |
| `381a6d1` | `docs(plans): add SNIPPETS.md — yasnippet-equivalent design notes` (predates the views branch; shared with all branches) |

**All test suites green on main (1030 / 1030, unchanged from the
prior handover's tally).** Per-package counts are identical to the
2026-05-28 handover. Phase 2c on the views branch adds the
attribute-helper tests (+15 to the renderer package); the active
branch sits at 1045.

## Priority-1: views-as-custom-elements refactor

**This is the only thing the next session should be doing**
(unless it finds something safety-critical). Everything else
parks behind it.

The refactor: replace the plain-JS `View` object + parallel
renderer modules + `kindRegistry` mapping with a custom HTML
element class per view kind (`<text-view>`, `<tabline-view>`,
`<image-view>`, …). The DOM's single-parent invariant enforces Q9
("no same View in two panes") at the platform level. The
`disconnectedCallback` / `connectedCallback` cycle replaces the
bespoke mount/dispose machinery. Explicit `destroy()` becomes the
real teardown path; lifecycle callbacks become honestly
indistinguishable between moves and teardowns.

Full design + the five resolved Phase 0 decisions plus the
warehouse-persistence policy: **`plans/VIEWS-AS-CUSTOM-ELEMENTS.md`**.

Where we are on the refactor branch:

| Tag / Commit | Phase | What landed |
|---|---|---|
| `views-phase-1` (`678afd6`) | 1 | `view-elements.js` (defineViewElement + attribute helpers), `view-warehouse.js` (warehouse API), `<div id="view-warehouse" hidden>` in index.html, 15 helper tests. |
| `b72ae8f` | 2a | `TextView` custom-element wrapper. Thin wrapper around the existing `createEditorView`; lifecycle hooks + `data-file-path` mirror + the `kind` / `name` / `filePath` getters that the strip widget and `viewFilePath` need. Not wired yet. |
| `views-phase-2b` (`cff0cd6`) | 2b | `TablineView` custom element (full mutation API: `addTab` / `removeTab` / `reorderTab` / `activateTab`, `[active]`-attribute semantics, `tab-close` bubbling event). `tabline.js` moved from `apps/desktop/src/` to `packages/renderer/src/` by symmetry. Not wired yet. |
| `7a9a7bf` | 2c | **TextView wired into the live mount path.** `ensureEditorViewForLeaf`, the kindRegistry-text mount's editor build, `inheritExistingEditorIntoTabline`, `demoteTablineView`, and the `mountTablineActiveChild` text-branch all now operate on `<text-view>` elements. `.element` accesses on editor instances are deleted (the instance IS the element). CSS rule for `text-view { display: block; width: 100%; height: 100%; }` added. |

### Phase 2c runtime status — **UNVERIFIED**

Unit tests pass (1045 green) but they don't render anything. The
mechanical translations are correct in principle, but the editor
hasn't been launched against the new mount path. **Recommended next
action: run the app, eyeball the editor for one minute, confirm
nothing's catastrophically broken before going further.**

Things to look at first:

1. The initial editor renders normally — text visible, cursor
   visible, font right, scrolling works.
2. The DevTools Elements panel shows `<text-view data-file-path="…">`
   wrapping the existing `.editor` div.
3. Opening a file via `M-x find-file` works.
4. Splitting (`C-x 3`) works and the new pane renders.
5. Switching tabs within a tabline works.
6. Closing a tab works.

If any of those fail: **`git reset --hard views-phase-2b`** rolls
back to the last commit before the wiring. The TextView /
TablineView classes still exist; they're just inert again.

Likeliest failure modes:

- **Layout collapse** — `text-view` not sizing correctly inside
  the pane (the `.editor` div has `height: 100%` and needs a
  sized parent; the CSS rule should handle it but a runtime
  cascade conflict could bite).
- **Focus timing** — `createEditorView` ends with `root.focus()`;
  if `<text-view>`'s `connectedCallback` runs while the element
  isn't quite in a focusable state, focus may not land. Same
  call as the pre-refactor code, just slightly deferred.
- **Singleton overlap** — non-text singletons (image / audio /
  directory views) are still on the old singleton-element pattern.
  An interaction between them and the new `<text-view>` mount could
  produce overlay artefacts. Should not, but flag if it appears.

### Phase 2d (next on the refactor)

Wire `<tabline-view>` the same way TextView was wired in 2c:

- Replace the bespoke `state.container` div + `state.stripEl` +
  `state.contentEl` triple inside `mountTablineActiveChild` with a
  single `<tabline-view>` element.
- Migrate the tabs-as-`tablineView.tabs[]`-array model to the
  tabs-as-`<tabline-view>.children` model. This is the big
  semantic shift — both representations exist in parallel during
  the transition.
- After Phase 2d: delete `inheritExistingEditorIntoTabline` and
  `removeViewFromAllTablines` (Q9 enforced means the move-not-
  clone-then-clean-up pattern those exist to manage just works).
- Delete `kindRegistry`'s `text` and `tabline` entries.

Effort: ~1 focused session. The semantic translation is the
delicate part; the mechanical edits are similar in shape to Phase
2c.

## What's parked: `agent-package-system-phase-1`

A substantial branch — a whole session's worth of work that won't
merge to main until the views refactor lands. Highlights of what's
there (not exhaustive — `git log main..agent-package-system-phase-1`
is the authoritative list):

- **Phase 1 of the package system** (9 commits, sub-agent 1):
  local install, manifest reader, dependency resolution, autoload
  stubs, `require!`, boot pipeline split into
  `loadCustomLisp / loadPackages / loadInitLisp`, disable / enable
  / pin commands, three baseline packages
  (`which-key-lite`, `project-switcher`, `godot-essentials`),
  smoke arm for install + autoload + disable round-trip.
- **Phase 2 of the package system** (10 commits, sub-agent 2):
  `install-package-from-git`, `update-package` (ff-only with
  prefix-arg force-update), `update-package all`,
  `uninstall-package` with real teardown, lifecycle hooks
  (`:install-hook` / `:pre-update-hook` / `:post-update-hook` /
  `:uninstall-hook`), `:source-url` / `:source-ref` manifest
  fields, `:git` provenance in `installed.lisp`, palette `i` /
  `u` / `x` wired, smoke arm covering the full lifecycle.
- **Modal package palette**: replaces the package-list view kind
  (which hijacked the active pane) with a centred overlay in the
  find-file lineage. Reachable via `M-x list-packages`.
- **Three appearance defcustoms**: `*editor-background*`,
  `*editor-foreground*`, `*editor-font-size*`. All in the
  appearance group; all routed through `current-theme-css-vars`
  so they survive theme switches.
- **Minibuffer footer polish**: locked 32px row, grey divider,
  no more bounce as chord prefixes show / hide.
- **C-g cancels minibuffer** (mirrors Esc).
- **M-x lists only registered defcommands** (the
  keymap-fallback that let host primitives like `open-file-path!`
  be invoked silently is gone).
- **Session-restore correctness**: `forceDuplicate` so each
  persisted tab restores to its own View; close-X is tab-local
  again. (These two commits are the ones cherry-picked to main.)
- **`setCurrentPaneId` triggers a session save**.
- **No-auto-scroll on mount/view-swap** so opening a file from a
  saved point doesn't horizontally yank the viewport sideways.
- **`plans/SNIPPETS.md`**: design doc for a yasnippet-equivalent.
  671 lines, fourteen open questions, five-phase build path.
  Implementation deferred.

When the views refactor lands, this branch's commits will need a
once-over: the kind-registry entries the package palette and other
new bits depend on may have changed shape. Most of the package
work is in the Lisp layer and shouldn't be affected; the renderer-
side changes (the modal palette element) will want adapting to
the new `<package-palette>` element if we go that route. Cherry-
picking commit-by-commit after the refactor is the expected
approach.

## Tags

| Tag | Commit | What it marks |
|---|---|---|
| `views-phase-1` | `678afd6` | End of Phase 1 of the views refactor (infrastructure + warehouse). |
| `views-phase-2b` | `cff0cd6` | End of Phase 2b (TextView + TablineView classes; not yet wired). The recovery point if Phase 2c misbehaves at runtime. |

The earlier session also tagged nothing on `main` — main's tip is
just `01e8646` from the cherry-pick.

## Architecture decisions worth preserving

Carry forward from the prior handover, plus two new entries from
this session:

1. Lisp at the seams; JS at the engine.
2. View is the addressable on-screen thing; buffer is L2 substrate.
3. Faces as data, not CSS variables.
4. `assoc`, never `hash-set`.
5. Sync Lisp is a feature.
6. `Cmd`/`Meta` maps to `C-`.
7. Chromium colour-manages CSS.
8. Subprocesses go through Python for PTY needs.
9. Per-view-point: cursors live on the view, including the cursor set.
10. Pane-creating commands return handles.
11. Focus stays on the originating pane after split.
12. Tabline-views are not in `views[]`.
13. Non-text active tabs re-parented into the tabline content area.
14. Non-text singletons visible-iff-any-leaf-shows-them.
15. Chord-prefix lookup falls through to the global keymap.
16. `session.currentView` resolves through the pane tree.
17. `*tab-width*` is the only tab-width source of truth.
18. Mode-local indent-tabs preference wins over the global.
19. `:choice` settings round-trip as the original Lisp value.
20. Citation-handle round-trip is JSON-CSL string.

21. **Q9 is structural under custom elements.** *New this
    session.* The DOM single-parent invariant means an element
    can be in at most one parent at a time. Under the views-as-
    custom-elements model, "no same View in two panes" is enforced
    by the browser; we don't need a bookkeeping pass to keep it
    true.

22. **Disconnect ≠ destroy.** *New this session.* A view's
    `disconnectedCallback` fires whether the element is being
    moved (pane → warehouse, pane → pane) or being torn down.
    Code can't distinguish inside the callback. Real teardown is
    an explicit `destroy()` method on every view class; the
    callback may be empty. The "warehouse" pattern — a hidden DOM
    container at `<div id="view-warehouse" hidden>` — is where
    views live between "constructed" and "in a pane" and where
    they go when a pane is closed but the view should survive.
    `*persist-warehouse*` defcustom (default `#f`) controls
    whether the warehouse contents survive a quit-relaunch.

## Plan documents

In `plans/`:

- `PANES.md`, `PANES-PHASE-1.md` → `PANES-PHASE-3B.md` — merged.
- `LANGUAGE-INJECTION.md`, `FACE-CUSTOMISATION.md`,
  `SHELL-V4-XTERM.md` — merged.
- `REACTIVE-NOTEBOOK.md` — Phase 1 on `agent-reactive-notebook`
  (still parked, not yet ready against current main).
- `PACKAGES.md` + `PACKAGES-PHASE-1.md` + `PACKAGES-PHASE-2.md`
  — only on `agent-package-system-phase-1`. Re-merged when the
  package branch re-applies post-refactor.
- `SNIPPETS.md` — design doc, only on the package branch. Same
  fate.
- **`VIEWS-AS-CUSTOM-ELEMENTS.md`** — *the active plan doc.*
  On `main`? No — only on the views and package branches. Worth
  cherry-picking to main if we want it visible from there too.

In `docs/`:

- `CUSTOM-VIEWS.md` — still out of date. Will need a substantial
  rewrite once the custom-element refactor lands; "creating a
  view kind" becomes "extend HTMLElement, document your
  destroy()" rather than the current "createX factory + register
  with kindRegistry" pattern.

## Branches still ready for review

Unchanged from prior handovers (those branches haven't moved):

| Branch | HEAD | What it adds |
|---|---|---|
| `agent-reactive-notebook` | `d453841` | Reactive Lisp notebook. |
| `agent-lsp` | `3f3a666` | TypeScript LSP, diagnostics + hover. |
| `agent-file-nav` | `074adab` | Fuzzy project find-file + sidebar tree. |

Stale refs to clean up someday: `agent-pane-splits`,
`agent-tabline-view`, `agent-multi-cursor`,
`agent-multi-cursor-rebase`, tag `agent-tabline-view-attempt-1`.

## Known issues / paper cuts

Carry-forward from the prior handover, with this session's
additions:

- **Phase 2c is unverified at runtime.** *New, top priority for
  the next session.* See "Phase 2c runtime status" above.
- **Token colours feel washed-out vs Sublime.** Unchanged. The
  package branch experimented with `--force-color-profile=srgb` +
  per-face pre-compensation; both reverted. Worth re-visiting
  after the refactor.
- **Faint strip at the bottom of the shell view.** Unchanged.
- **Multi-cursor doesn't have a smoke arm.** Unchanged.
- **`directory-tree` doesn't yet have the same context menu as
  `directory-columns`.** Unchanged.
- **The post-move source pane in `send-view-to-other-pane` can end
  up showing an empty strip.** Unchanged.
- **The Godot marketing screenshots are diagnostic captures.**
  Unchanged.
- **Tree-view smoke regression**. *From the package branch's
  Phase 1 work.* Pre-existing failure in
  `apps/desktop/scripts/smoke.js`'s tree-view arm; verified
  independent of the package work via a `loadPackages` short-
  circuit test. Likely related to `currentViewIndex` not updating
  after `openFileInTabAdjacent` → `activateTabInTabline`.

## Suggested next steps in priority order

1. **Launch the app on `agent-views-as-custom-elements` and
   verify Phase 2c.** If it works → move on. If it doesn't →
   `git reset --hard views-phase-2b`, diagnose, fix, re-commit.
   This is the single highest-priority unblock for the project's
   roadmap.

2. **Phase 2d — wire TablineView into the live tabline mount
   path.** Reads from `mountTablineActiveChild` and replaces the
   bespoke `state.container` / `state.stripEl` / `state.contentEl`
   trio with `<tabline-view>`. The tabs-as-Lisp-array →
   tabs-as-DOM-children semantic translation is the delicate
   part.

3. **Phases 2e/3/4/5/6** per the plan doc — sweep the remaining
   kinds (image, audio, video, shell, jukebox, directory-tree,
   directory-columns, customize, doc, package palette), delete
   the parallel infrastructure (`kindRegistry`,
   `hideInactiveRendererViews`, `inheritExistingEditorIntoTabline`,
   `removeViewFromAllTablines`, `singletonElementForKind`).

4. **Merge the views branch to main.** Once Phases 2–4 are
   solid; the smoke arm is the integration check.

5. **Re-apply `agent-package-system-phase-1` on top.** Cherry-
   pick commit-by-commit, adapt anything that touched the old
   view model. Most of it is Lisp and won't move.

6. **Then** the jmacs → Godot rename (still queued from the
   prior handover); merge `agent-reactive-notebook`; the
   cleanup-pass items; etc.

## Workflow lessons (this session)

1. **An invariant the platform can enforce beats one the code
   needs to remember.** Every bug we chased pre-refactor came
   from a single shape: "two places think they own the same
   View." The custom-element refactor doesn't *fix* those bugs
   in code — it makes them unrepresentable. That's a different
   kind of safety.

2. **Heisenbugs are sometimes environment, not code.** Twice
   this session we chased something — first the scrollbar
   appearance, then the directory-* file-open overlay — that
   vanished after a clean restart. Diagnostic time spent before
   confirming "is this still happening?" would have been saved.

3. **A wrapper is a valid first step in a class refactor.**
   `TextView` doesn't rewrite the 900-line `createEditorView`
   — it puts a custom-element shell around it. Lifecycle gains
   land immediately; the deeper closures→methods refactor can
   happen later if it earns its weight. Most architectural
   wins come from the *shell*, not the internals.

4. **Tag the recovery points.** When making a deep refactor in
   the live path (Phase 2c was that), tagging the last-known-
   good state (Phase 2b) gives a one-command rollback. Cheap
   insurance.

---

The story so far: a Lisp-extensible editor with a custom dialect,
an Electron presentation layer, real tree-sitter highlighting (36
languages with cross-language injection), a face system
customisable via `M-x customize-faces`, a working jukebox, a pane
tree with user-facing splits, per-pane tabline-views, Sublime-
style multi-cursor, directory views with all the trimmings,
find-file, drag-resizable preview/REPL splitters, `M-x shell` on
xterm.js, tab-width / indent-tabs settings with mode-local
overrides, folding, a four-theme palette, citation.js for BibTeX
/ CSL formatting. The parked `agent-package-system-phase-1`
branch holds a working package system (Phases 1 + 2), a modal
palette, appearance defcustoms, and a long tail of polish. The
views-as-custom-elements refactor is the gate this all queues
behind — once the DOM enforces the addressing invariant the
documentation has been claiming, every future feature lands on a
substrate where the parallel-browser pattern that has been the
source of recurring bugs simply doesn't exist.
