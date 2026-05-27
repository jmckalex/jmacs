# Handover — jmacs session 2026-05-27 (multi-cursor merge + stretch)

A snapshot for resuming work on **jmacs** in a fresh session. Read
`CLAUDE.md` first — it carries the standing working agreements
(branching, commits, testing discipline, territory). This file is the
where-things-stand record. The prior 2026-05-27 handover (phase 3b
polish, pre-multi-cursor) is preserved in `git log` against `0b596f5`;
this one supersedes it. The phase-3b-landing handover before that is
at `f09ec46`; the 3a-landing handover is at `bff550a`.

## Where main is

HEAD: `2d96a44` (`fix(custom): replace named-let in -coerce-for-type
with a tail-recursive helper`). **All test suites green
(1024+/1024+ — exact count drifted with each commit; latest snapshot
1027/1027: 47 storage + 42 pane + 68 lisp + 55 buffer + 34 view + 247
renderer + 166 desktop + 367 stdlib). Smoke arms unchanged — no new
ones added this session; the multi-cursor smoke arm is a known
follow-up.**

The session's two headlines: **multi-cursor merged** (the salvaged
`agent-multi-cursor` branch rebased + landed end-to-end), and a
**stretch session of polish + bug fixes** that surfaced as Jason drove
the editor with the new feature live: tab handling end-to-end,
directory-views overhauled, folding visuals, theme work, and a string
of pre-existing pane/singleton bugs flushed out.

## Landed this session

Top of `main`, in order (newest first). The merge commit `8babe4d`
brings in the agent-multi-cursor-rebase branch's 11 commits;
everything above and below is direct-to-main.

### Post-merge polish (newest first)

| Commit | What |
|---|---|
| `2d96a44` | `fix(custom): replace named-let in -coerce-for-type with a tail-recursive helper` — the prior commit used `(let loop ...)` which this dialect doesn't support; same workaround as multi-cursor.lisp. +2 regression-guard stdlib tests. |
| `c74d717` | `fix(custom): coerce :choice strings to their option symbol on apply` — heals stale string-form custom.lisp (e.g. `(quote "midnight")`) by mapping the string to the matching Sym in the setting's :options. `custom-set-saved!` stores the coerced value so the next save rewrites the file in canonical form. |
| `f73a70e` | `fix(customize): :choice widget passes back the original Lisp value` — read() returned `widget.value` (string), causing `(quote "dark")` to land downstream where a symbol was expected. Now keeps a label → original-option map and returns the Sym. |
| `b5af7c3` | `fix(customize): :choice select shows option names, not [object Object]` — `String(sym)` was the default-object string. New `asDisplayString` helper reads the `name` property. |
| `05fbe45` | `feat(themes): add a 'bright' theme variant` — dark chrome with a punchier syntax palette (string `#a3d977`, keyword `#d56bff`, function `#82aaff`, etc.); `*theme*` :options gains `bright`; `defface` blocks gain `:default-bright`; resolver in faces.lisp learns the new branch. `--bg-editor` lifted ~5% to `#323e4a`. |
| `71c093f` | `fix(html-fold): skip void elements (meta / br / img / link / ...)` — fold query now `(element (start_tag) (end_tag)) @fold` so void elements (which parse as `element` without an end_tag) don't grow stray chevrons. Same shape for script/style. |
| `ca8beb2` | `fix(folding): yellow ellipsis, highlighted closing-token, chevron icon` — chevron over caret; `…` rendered in `--tok-type` yellow; closing-line preview goes through the syntax highlighter via the existing per-line runs (new `trimLeadingWhitespaceRuns` helper drops the close-line's indent). |
| `9fe2e3e` | `feat(folding): FA disclosure triangle + closing-token preview` — initial swap of ▸/▾ for a FA caret + appending the closing line trimmed text so a folded `<script>` reads as `<script>…</script>`. (Both refined in the next commit.) |
| `32f8b9b` | `fix(desktop): non-text singletons stay visible while another pane shows them` — `hideInactiveRendererViews` had been operating globally. New behaviour: compute the *union* of active singleton kinds across the whole pane tree; a singleton is visible iff at least one leaf shows it. Same rule for the audio/video/shell `setBuffer(null)` cleanups. |
| `86ae391` | `feat(renderer,desktop): tab-aware cursor / selection positioning (layer 3/3)` — `visualColumn` + `charIndexAtVisualColumn` in projection.js; threaded through `renderCursor` / `renderSelection` / `renderBrackets` / `offsetFromPoint` via a new `getTabWidth` createEditorView option; host caches `currentTabWidth` updated by `set-css-tab-width!`. +7 projection tests. |
| `8b21fff` | `feat(desktop,stdlib): wire *tab-width* into a --tab-width CSS variable (layer 2/3)` — `.editor-line` and `.directory-columns-preview-line` set `tab-size: var(--tab-width, 4)`; new `set-css-tab-width!` primitive pushes the value; host installs an `:on-change` hook on the *tab-width* defcustom after stdlib load. |
| `2303769` | `feat(stdlib): tab settings + Makefile-correct insert-tab (layer 1/3)` — new `indent.lisp` with `*tab-width*` (default 4) and `*indent-tabs-mode*` (default `#f`); `insert-tab` honours them plus the current mode's `:indent-tabs?` / `:tab-width` overrides. Makefile-mode pins `:indent-tabs?` on. New `string-repeat` primitive. +4 stdlib tests. |
| `aa264ad` | `feat(directory-columns): windowed preview rendering for large files` — virtualised line rendering (spacer + absolute positioning) so the user can scroll through any file. Line height measured once via a transient probe. Re-renders on scroll + ResizeObserver. |
| `cc7c035` | `fix(directory-columns): inject sees full source; preview caps lines not bytes` — the byte-cap was cutting mid-element which broke HTML's CSS injection. Now the whole source goes through the highlighter; only the rendered line count is capped (400 → since superseded by virtualisation). |
| `d655e52` | `feat(directory-columns): syntax-highlight the text preview pane` — preview text renders through the same `highlighters` registry the editor uses; falls back to `highlightBuffer` then `highlightLine`. |
| `1a158b6` | `fix(directory-columns): in-module modal instead of window.prompt/confirm` — Electron's renderer silently disables `prompt()`; replaced with a per-module modal (overlay + dialog + input + buttons) that returns a Promise. Used for Rename + Trash confirmation. |
| `318a7ed` | `feat(directory-columns): right-click context menu (Open / Reveal / Rename / Trash)` — host IPC handlers for `file:rename` / `file:trash` (via `shell.trashItem`) / `file:reveal` (via `shell.showItemInFolder`); renderer-side menu with viewport-clamp + outside-click dismissal. |
| `c708d20` | `feat(directory-views): open file as a new tab beside the directory view` — double-click no longer replaces the directory view; new `openFileInTabAdjacent` promotes the pane to a tabline (if not already) and adds the opened file as a tab. Wired into both directory-tree and directory-columns. |
| `55ec03f` | `fix(desktop): show the restored singleton's element on installRootPane` — re-parenting alone wasn't enough; the boot setup hides every singleton via `display:none` and nothing flipped it back during restore. Plain-leaf restore now sets `display:''` too. |
| `d8a5446` | `fix(desktop): re-parent non-text singletons in installRootPane's plain-leaf path` — restored a directory-tree / directory-columns leaf had its singleton element orphaned to the (just-disposed) boot leaf; reparent now mirrors the switchToViewIndex plain-leaf fix from the merged branch. |
| `0269c7b` | `fix(session): parseView accepts directory-tree / directory-columns` — the persistence pipeline wrote them but `parseView`'s allow-list dropped them on read. |
| `9f453a0` | `feat(session): persist directory-tree / directory-columns views by rootPath` — directory views survive a quit; per-view interaction state (expanded set, columns list, previewPath) is intentionally ephemeral. |
| `fa0ec04` | `fix(directory-columns): preview pane fills remaining horizontal space` — flex `0 0 360px` → `1 1 360px`; the embedded `<video>` now grows with the preview pane as columns shrink. |

### The merge `8babe4d` — agent-multi-cursor-rebase

11 commits, in branch order:

| Commit | What |
|---|---|
| `0d93e2d` | `fix(desktop): re-parent non-text singletons in the plain-leaf open path` (the switchToViewIndex twin to `d8a5446`). |
| `1e423ec` | `style(pane): inactive-pane cursors fade and stop blinking` — `.pane:not(.pane--focused) .editor-cursor` → opacity 0.45 / no animation. |
| `5d50088` | `feat(stdlib): ESC deselects every cursor without collapsing the set` — Jason's "I want to keep the cursors but lose the selection" request. C-g still does both. |
| `f20c786` | `fix(renderer,buffer): blink in unison + arrow keys deselect to the edge` — restart `is-blinking` on every cursor each render so they're in phase. (The collapse-on-arrow part was reverted next; only the blink-sync change stuck.) |
| `2b66053` | `fix(desktop): editor mousedown focuses the pane it landed in` — the click listener never fires for editor clicks (the renderer's mousedown detaches the press target by re-rendering), so a parallel mousedown listener runs alongside. |
| `d5c9690` | `fix(desktop): session.currentView resolves through the pane tree` — the buffer-primitives' `session.currentView` was reading `views[currentViewIndex]` which got stale when tabline tabs were switched. Unified with `viewHost.currentView`. |
| `f9a6329` | `fix(keymap): chord-prefix lookup falls through to the global keymap` — `active-keymap` is now a *stack* of prefix maps from every leaf in the mode chain. A mode-local `C-c` map no longer hides the global one for keys it doesn't bind. +2 stdlib tests. |
| `743ad62` | `feat(lisp,stdlib): multi-cursor commands bound to C-c d / C-c D` — `add-cursor-next` + `select-all-matches` + `keyboard-quit` extension. Bound under `c-c-keymap` (chosen by Jason; `M-d` and `C-l` were the branch defaults but conflicted with `kill-word` / `recenter`). +6 stdlib tests. |
| `360ab61` | `feat(renderer): paint every cursor in the set (selections + carets)` — `selectionRects` / `cursorPositions` walk every cursor; renderer pools secondary `.editor-cursor.is-secondary` elements; new `getCursors` createEditorView option. |
| `89a9b76` | `feat(buffer): multi-cursor edit / move logic via cursorSource.cursors[]` — buffer iterates the cursor set; selections, addSelection, collapseToPrimary, forEachSelection, cursorCount. +18 buffer tests. |
| `edf1a00` | `feat(view): cursors[] storage on text views; point/mark alias cursors[0]` — selection set lives on the *view*, not the buffer (the salvaged branch had it on the buffer; phase 3a moved point/mark to the view, so the rebase landed it where it belongs). +2 view tests. |

### A note worth recording

The salvage of `agent-multi-cursor` (the original commit `37fd294`) put
the selection-set abstraction on the **buffer**, which was where point
and mark lived before phase 3a. Phase 3a moved them onto the view, so
a straight merge would have produced a multi-cursor implementation in
the wrong layer — every multi-cursor op mutating buffer-local state
shared across views.

The rebase ported the design but landed the selection set on the view:
`view.cursors[]` is canonical; `view.point`/`view.mark` are accessors
aliasing `cursors[0]`. Two views over one buffer keep independent
cursor *sets*, not just primaries.

## Pending commits

None. Working tree clean apart from pre-existing untracked PNGs
(several this-session screenshots: `bug-hunt.png`, `bug-hunt-2.png`,
`column-view.png`, `columns.png`, `directory-tree.png`,
`need-highlighting.png`, `need-injection.png`, `no-directory.png`,
`no-joy.png`, `object.png`, `two-tablines.png`, `weird.png`), the
stray `Makefile`, and a `session.json.pre-3b-backup` in the Electron
profile.

## Branches still ready for review

Three remaining. `agent-multi-cursor` is merged; its rebase branch
`agent-multi-cursor-rebase` is also merged (the tip `0d93e2d` is in
the merge commit's history).

| Branch | HEAD | What it adds |
|---|---|---|
| `agent-reactive-notebook` | `d453841` | Reactive Lisp notebook (engine phase). **Next in the queue** — the handover before this one flagged it as unblocked by phase 3b. |
| `agent-lsp` | `3f3a666` | TypeScript LSP, diagnostics + hover. |
| `agent-file-nav` | `074adab` | Fuzzy project find-file + sidebar tree. |

The merged-but-stale branches `agent-pane-splits`, `agent-tabline-view`,
`agent-multi-cursor`, `agent-multi-cursor-rebase` all still exist as
refs (along with the tag `agent-tabline-view-attempt-1`); clean up in
the next bulk pass.

### Suggested merge order

1. **`agent-reactive-notebook`** — the notebook view sits naturally
   in a tabline-view alongside text files; phase 3b unblocked it.
2. **`agent-lsp`** — largest standalone surface.
3. **`agent-file-nav`** — sidebar tree.

Expected conflict surfaces are larger than before this session
because:
- `apps/desktop/src/app.js` got a lot of new code (open-file-in-tab,
  context-menu wiring, singleton reparent, `hideInactiveRendererViews`
  union, currentTabWidth cache, `set-css-tab-width!` primitive,
  directory-view ensure-helpers, `session.currentView` unification,
  mousedown focus listener).
- `packages/renderer/src/view.js` (getCursors / getTabWidth / fold
  rendering / `trimLeadingWhitespaceRuns`).
- `packages/renderer/src/projection.js` (visualColumn,
  charIndexAtVisualColumn, selectionRects/tabWidth, cursorPositions/tabWidth).
- `packages/renderer/src/directory-columns-view.js` (context menu,
  modal, highlighters, virtualisation).
- `packages/buffer/src/buffer.js` (cursors[] iteration in every
  move/edit method).
- `packages/view/src/view.js` (cursors[] storage + point/mark accessors).
- `packages/stdlib/lisp/keymap.lisp` (chord-stack lookup).
- `packages/stdlib/lisp/themes.lisp` + `faces.lisp` (bright theme +
  `:default-bright` everywhere).
- `apps/desktop/src/session.js` (directory-view blob handling).
- `apps/desktop/src/files.js` + `preload.mjs` (file:rename / file:trash
  / file:reveal).
- `apps/desktop/styles.css` (tabline visibility, fold visuals, preview
  styles, context-menu, modal, cursor fade, tab-size).

## In flight / queued

- **Phase 3c (deferred).** Cross-pane drag-and-drop of tabs (move a
  tab from one pane's tabline to another). Unchanged.

- **Phase 4: multi-window.** Unchanged. Spawn additional
  `BrowserWindow`s, move the Lisp VM to the main process (Q5(a) of
  PANES.md), plumb IPC.

Open follow-ups carried across phases (mostly unchanged):

- **`docs/CUSTOM-VIEWS.md` rewrite.** Still describes the old
  buffer-wrapper model from before phase 1. Now also wants a section
  on the `directory-columns` view options (highlighters, onRename,
  onTrash, onRevealInFolder) and the context-menu modal contract.
- **`docs/MANUAL.jmd` + `docs/reference/commands.md` regen** for the
  renamed defcommands (post-phase-1), the new tabline / find-file
  commands, the multi-cursor commands (`add-cursor-next`,
  `select-all-matches`, `deselect`), and the new defcustoms
  (`*tab-width*`, `*indent-tabs-mode*`, the `bright` theme).
- **`occur-buffer-name`** still has "buffer" in its name (internal
  helper).
- **Multi-cursor smoke arm** — handover before this one flagged it as
  missing; not added this session.
- **Same context-menu treatment for `directory-tree`** — Rename /
  Trash / Reveal would carry over almost verbatim.
- **The shell-view bottom strip + the muted-palette colour-pipeline
  thread** — Jason tried `--force-color-profile=srgb` this session
  ("not much difference") and the path he picked was to bump the
  syntax palette instead (the new `bright` theme). The
  pre-compensation question remains untouched.
- **`init.lisp` workaround for theme persistence**. If the user's
  saved theme ever fails to take, `(custom-apply! '*theme* 'midnight)`
  in init.lisp pins it. Worth surfacing in user docs.

## Architecture decisions worth preserving

Carried forward, with new entries from this session:

1. **Lisp at the seams; JS at the engine.** Unchanged.

2. **View is the addressable on-screen thing; buffer is L2 substrate.**

3. **Faces as data, not CSS variables.** Unchanged.

4. **The map-update primitive is `assoc`, never `hash-set`.** Still
   the most-repeated mistake; the multi-cursor branch had it. Now
   captured in this dialect's idiom.

5. **Sync Lisp is a feature, not a bug.** Unchanged.

6. **`Cmd`/`Meta` maps to `C-` in key normalisation.** Unchanged.

7. **Chromium colour-manages CSS; Sublime writes native pixels.**
   Same `--bg-editor` story; the new `bright` theme tests bumping the
   syntax palette instead of touching the pipeline.

8. **Subprocesses go through Python for PTY needs.** Unchanged.

9. **Point/mark live on the view; the buffer's cursor API delegates
   via `bindCursor`.** Extended this session: the cursor *source*
   carries a `cursors[]` array, with `point`/`mark` aliasing
   `cursors[0]`. Two views over one buffer keep independent cursor
   *sets* — not just independent primaries.

10. **Pane-creating commands return handles.** Per Q15.

11. **Focus stays on the originating pane after split.** Matches
    Emacs `C-x 2`/`3`.

12. **Tabline-views are *not* in the global `views[]` list.**
    Unchanged.

13. **Non-text active tabs are re-parented into the tabline content
    area on activation.** Unchanged in shape but extended in
    coverage: the same reparent+display-flip now happens for the
    plain-leaf switchToViewIndex path AND the session-restore
    installRootPane path, not just the tabline mount. Without those
    fixes a session with a directory-* view in a non-tabline pane
    came back empty.

14. **Non-text singletons are visible-iff-any-leaf-shows-them.**
    *New this session.* `hideInactiveRendererViews` computes the
    union of active singleton kinds across the whole pane tree —
    clicking a text tab in one pane no longer hides a singleton
    parented in another pane. The setBuffer(null) cleanups for
    audio/video/shell follow the same rule.

15. **Chord-prefix lookup falls through.** *New this session.* When
    the user enters a chord like `C-c`, `active-keymap` becomes a
    *list* of every prefix-map the chord-leading key resolved to
    across the mode chain. Mid-chord lookup walks the stack in chain
    order; mode-local prefix wins where defined, but doesn't hide
    the global one for keys it doesn't bind.

16. **`session.currentView` and `viewHost.currentView` are one
    source of truth.** *New this session.* Both resolve through
    `currentPane()` + `peelTabline`. The buffer-primitives' previous
    `views[currentViewIndex]` lookup went stale when tabline tabs
    were switched without re-focusing the pane; the unified path
    keeps `(point)` / `(insert!)` operating on what the user sees.

17. **`*tab-width*` is the only tab-width source of truth.** *New
    this session.* The host's `set-css-tab-width!` primitive writes
    `--tab-width` AND a `currentTabWidth` JS cache; the renderer
    reads the cache via `getTabWidth` for cursor / selection
    positioning math. `tab-size: var(--tab-width)` on
    `.editor-line` keeps the visual width in step. Live
    customise-edit re-syncs both.

18. **Mode-local indent-tabs preference wins over the global.**
    *New this session.* A major mode's `:indent-tabs?` and
    `:tab-width` keys are read by `-indent-tabs-effective` and
    `-tab-width-effective` (in indent.lisp). Makefile pins
    `:indent-tabs? #t` regardless of the user's global preference.

19. **`:choice` settings round-trip as the original Lisp value.**
    *New this session.* The customize widget keeps a label →
    original-option map so `read()` returns the Sym, not the
    dropdown's string label. `custom-apply!` also coerces a stale
    string back to its option symbol on load, so an older
    `custom.lisp` heals on next save.

## Known issues / paper cuts

- **Binding displacements still pending** for unmerged branches
  (taste calls only Jason can make).
- **Token colours feel washed-out vs Sublime.** Bumped via the new
  `bright` theme this session; the pre-compensation thread is still
  open. Jason found the bright palette enough to ship as a built-in
  variant; the colour-pipeline conversation remains.
- **Faint strip at the bottom of the shell view.** Unchanged.
- **Multi-cursor doesn't have a smoke arm.** Carried over.
- **`directory-tree` doesn't yet have the same context menu as
  `directory-columns`** — would carry verbatim.

### Resolved this session

- Multi-cursor branch's design mismatch with phase 3a — fixed by the
  rebase; selection set lives on the view (`8babe4d`).
- Chord-prefix lookup no longer hides the global keymap (`f9a6329`).
- Mousedown on an unfocused pane now focuses it (`2b66053`).
- `session.currentView` and `viewHost.currentView` unified
  (`d5c9690`).
- Cursors blink in unison (`f20c786`).
- ESC deselects without collapsing the multi-cursor set (`5d50088`).
- Inactive-pane cursors fade + stop blinking (`1e423ec`).
- Non-text singletons stay visible while shown in a non-focused pane
  (`32f8b9b`).
- Plain-leaf restore reparents + un-hides non-text singletons
  (`d8a5446`, `55ec03f`).
- Directory-tree / directory-columns persist across quit (`9f453a0`,
  `0269c7b`).
- Column-view preview pane fills available space (`fa0ec04`).
- Opening a file from a directory view doesn't replace the directory
  view — promotes the pane to a tabline and adds the file as a new
  tab (`c708d20`).
- Right-click context menu in column view (`318a7ed`).
- In-module modal for Rename / Trash confirmation; `window.prompt`
  was a no-op in Electron's renderer (`1a158b6`).
- Column-view preview gets syntax highlighting, with injection
  (`d655e52`, `cc7c035`).
- Column-view preview virtualised for big files (`aa264ad`).
- Tab handling end-to-end (3 layers): settings, CSS, cursor positioning
  (`2303769`, `8b21fff`, `86ae391`).
- Fold marker now a FA chevron; folded preview includes the closing
  token with proper syntax highlighting; ellipsis is yellow
  (`9fe2e3e`, `ca8beb2`).
- HTML void elements no longer get fold chevrons (`71c093f`).
- `bright` theme variant; `defface` resolver carries the new key
  (`05fbe45`).
- `:choice` dropdown shows option names (not `[object Object]`)
  (`b5af7c3`).
- `:choice` widget round-trips the original Lisp value (`f73a70e`).
- Stale string-form `:choice` values heal on load (`c74d717`,
  `2d96a44`).

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
- `PANES-PHASE-3B.md` — merged.

In `docs/`:

- `CUSTOM-VIEWS.md` — **still out of date.** Now also wants the
  directory-columns context-menu / modal pattern + the renderer-side
  highlighters / virtualisation contract.

## Tree-sitter inventory

**36 vendored grammars** (unchanged).

## Memory / preferences saved

- **Direct-to-main commits are fine for small polish.** Branch +
  merge stays the default for feature-sized work. Reinforced again
  this session — 23 polish commits direct-to-main, none warranted a
  branch.
- **Test before merge.** Sub-agent feature work: live test in the
  running app before merging; never auto-merge after tests-green.
- **Halfway between Python and Perl.** Allow unusual configurations,
  don't encourage them.
- **Named let isn't supported in this Lisp dialect.** Surfaced THREE
  times this session: in the multi-cursor.lisp salvage, the
  `custom-apply!` :choice coercion, and the chord-stack helper.
  *Application*: use a tail-recursive helper instead of
  `(let loop ((x ...)) ...)`. Worth a defmacro at some point.

## What's missing — the headlines

1. **LSP autocomplete.** `agent-lsp` lands the first half.
2. **Reactive notebook.** `agent-reactive-notebook` (next merge).
3. **Git integration.** Diff gutter, blame, basic conflict UI.
4. **Performance proven at scale.**
5. **Process isolation for user code.** Phase 1 proposal in the
   pre-prior handover (`git show 96ea97b -- HANDOVER.md`).
6. **A real README + 60-second demo.**
7. **PANES phase 4** (multi-window) and **3c** (cross-pane tab
   drag).

## Workflow lessons (this session)

1. **A salvaged branch's design can be wrong on arrival, not just
   incomplete.** The `agent-multi-cursor` salvage had multi-cursor on
   the buffer; phase 3a had since moved point/mark onto the view.
   The rebase ported the design *and re-located it*. The first
   commit on the branch (the view-layer change) was the most
   important — the rest followed.

2. **Live testing finds the bugs that exercise the integration
   layer.** Multi-cursor merged with green tests, then Jason drove it
   and surfaced: chord fallthrough, session.currentView unification,
   mousedown focus, plain-leaf singleton reparent. Four pre-existing
   bugs nobody had hit because nobody had reason to.

3. **Electron's renderer disables `window.prompt`.** Plus `confirm()`
   is unreliable. Don't reach for them; build a per-module modal.

4. **`:choice` defcustoms need round-trip discipline.** The widget's
   `read()` must return the *original Lisp value*, not the
   dropdown's string label, or downstream `(eq? value 'name)` checks
   fail. And a stale custom.lisp can leak old string-form values, so
   `custom-apply!` needs to coerce.

5. **The same plain-leaf-singleton bug appeared in two places.** It
   was easy to fix the first occurrence (`switchToViewIndex`'s
   plain-leaf path) and miss the second (`installRootPane`'s
   plain-leaf path). The rule "non-text singleton in a plain leaf
   needs reparent + display:''" applies everywhere a non-text view
   lands in a plain leaf.

## Suggested next steps in priority order

1. **Merge `agent-reactive-notebook`.** Next in the queue;
   structurally unblocked by phase 3b.

2. **Cleanup pass on branches + tag.** `agent-pane-splits`,
   `agent-tabline-view`, `agent-multi-cursor`,
   `agent-multi-cursor-rebase`, and the tag
   `agent-tabline-view-attempt-1` are all still around.

3. **Same context menu for `directory-tree`** — Rename / Trash /
   Reveal would carry verbatim from `directory-columns-view.js`. ~30
   minutes of work.

4. **Rewrite `docs/CUSTOM-VIEWS.md`** — kind-registry mount contract
   + tabline mount context + non-text reparenting + directory-columns
   context-menu / modal pattern + renderer-side highlighters +
   virtualisation hooks.

5. **Multi-cursor smoke arm** — open the file, do C-c d twice, type,
   verify all three matches changed; ESC deselect + C-g collapse.

6. **Investigate the muted-palette / shell-view residual strip
   thread** — bundled. The new `bright` theme covers the syntax
   palette case; the pre-compensation conversation remains.

7. **Daily-drive for a week, then a real README + 60-second demo.**

8. **PANES phase 3c** (cross-pane drag of tabs) and **phase 4**
   (multi-window) and **LSP autocomplete** as focused follow-up
   sessions.

---

The story so far: a Lisp-extensible editor with a custom dialect, an
Electron presentation layer, real tree-sitter highlighting (36
languages with cross-language injection), a face system customisable
via `M-x customize-faces` (and now `M-x customize` → `*theme*` /
`*tab-width*` / `*indent-tabs-mode*`), documentation, a working
jukebox with album art + metadata, a **pane tree with user-facing
splits** (per-view cursors, drag-resizable splitters, focus
indicator), **per-pane tabline-views** (configurable edge +
drag-resizable width, session-restorable end-to-end), **Sublime-style
multi-cursor** (per-view cursor sets, `C-c d` / `C-c D`, ESC deselect
without collapsing, in-sync blink, faded cursors on inactive panes),
**directory views with all the trimmings** (persisted across restart,
context menu with Rename / Trash / Reveal, syntax-highlighted
virtualised preview pane, open-in-new-tab), find-file with
case-insensitive completion, drag-resizable preview/REPL splitters, a
diagnostic `C-h F` for syntax highlighting, double-click-to-open,
chord-prefix display in the echo area with global-fallthrough,
`M-x shell` running on xterm.js, **tab-width / indent-tabs settings
with mode-local overrides** (Makefile gets real tabs), **folding with
chevron + closing-token preview + yellow ellipsis + void-element
filter**, and a **four-theme palette** (dark / bright / light /
midnight) reachable from `M-x customize`. Next big moves are the
three-branch review queue (notebook / lsp / file-nav) and then phase
4 (multi-window).
