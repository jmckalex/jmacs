# Phase 3a — expose splits

Concrete brief for the first half of phase 3 of `plans/PANES.md`. Read
PANES.md first (especially the "Sketch of stdlib surface", "Focus
indication", and the resolved Q2 / Q9 / Q15 sections) and skim
`plans/PANES-PHASE-2.md` for context on the pane tree, the focus
model, the leaf-pane DOM, and the kind registry that landed there.

Phase 2 (`403e731`) built the pane tree with one leaf. Phase 3a turns
that data model into something the user can actually drive: multiple
leaves on screen, a draggable splitter between them, the focus
indicator visible, and the Lisp surface to construct/delete/navigate
panes with `C-x 2 / 3 / 0 / 1 / o` bound to it. Per-view point/mark
and per-pane edit-view instances land here too — without them, the
Q9 auto-duplicate path can't give two views over one buffer their
own cursors.

**Phase 3b** (separate brief, comes after this lands): tabline-view's
real implementation plus `(make-tabline-view)`, `(add-tab!)`,
`(activate-tab!)`, etc. The tabline kind stays at its phase-3 stub
through 3a.

## Scope

- **Split constructors.** `(split-horizontal! [ratio])` and
  `(split-vertical! [ratio])` operate on `(current-pane)`. Each
  replaces the current leaf with a split node; the originating pane
  becomes the **first** child and **keeps focus** (Jason's call,
  matches Emacs's `C-x 2 / 3` semantics). The second child is a fresh
  leaf — see "What goes in the new pane" below.
  - `split-horizontal!` → orientation `'horizontal'`, returns
    `(left-handle right-handle)`.
  - `split-vertical!` → orientation `'vertical'`, returns
    `(top-handle bottom-handle)`.
  - Default ratio: 0.5.

- **Pane deletion.** `(delete-pane! [pane])` removes a leaf and
  collapses its sibling into the parent's slot (Emacs `C-x 0`
  semantics). `(delete-other-panes! [pane])` makes the given pane
  fill the whole editor area (Emacs `C-x 1`). Both default to
  `(current-pane)` when called without an argument. **Auto-collapse**
  is invariant: there is never a split node with one child; the tree
  is either a single leaf or a binary tree of splits.

- **Navigation.** `(other-pane)` cycles focus to the next leaf in
  display order (depth-first). `(focus-pane-direction! 'left|'right|'up|'down)`
  uses spatial adjacency from the laid-out rects.

- **Layout knobs.** `(balance-panes!)` resets every split node's
  ratio to 0.5 — the simple version is fine. `(set-split-ratio! pane
  ratio)` for direct manipulation; the splitter-drag UI calls into
  this.

- **Splitter drag UI.** A 4 px-wide handle between adjacent leaves;
  mouse-down on the handle starts a drag that updates the bordering
  split node's ratio live, with `relayoutPanes` running on every
  frame of the drag. Cursor changes to `col-resize` / `row-resize`
  while hovering / dragging.

- **Focus indicator becomes visible.** The `.pane--focused` class
  was wired in phase 2 but invisible with one pane. Now there are
  multiple panes and the user can see which one holds focus.

- **Per-view point/mark migration.** Move `point` and `mark` from
  the buffer to the view. The buffer keeps the text, markers,
  overlays, edit history. Two text views over one buffer (the Q9
  duplicate-view path) get independent cursors.

- **Per-pane edit-view instances.** Replace the singleton
  `editorView` with one `createEditorView` instance per leaf that
  holds a text view. Mount/dispose is driven by the pane life cycle.
  Other renderer view modules (shell, jukebox, image, audio, video,
  doc, customize, directory-tree, directory-columns,
  markdown-preview) stay as singletons in 3a — see the scope note
  below.

- **Click-anywhere-to-focus.** Already wired in phase 2; verify the
  multi-pane case works (clicking a non-focused pane focuses it
  *and* doesn't disturb the previously-focused pane's selection).

- **Q9 collision rule.** `(switch-to-view! view)` raises when `view`
  is already visible in some other pane of the current window. The
  workflow for "I want this file in another pane" is the auto-
  duplicate path on split-then-open-same-file (see below).

- **Q9 auto-duplicate on split-then-open-same-file.** When a freshly-
  split pane is told to open a file already visible in its sibling,
  create a *new* text view over the same buffer (a new View handle,
  new id, distinct point/mark/scroll) and put it in the freshly-
  split pane. The view list grows by one entry; both views share the
  buffer.

- **Key bindings.**
  - `C-x 2` → `split-vertical` (Emacs naming: split *vertically* puts
    one window above the other; matches our `split-vertical!`).
  - `C-x 3` → `split-horizontal` (side-by-side).
  - `C-x 0` → `delete-pane` (current pane).
  - `C-x 1` → `delete-other-panes` (current pane fills the area).
  - `C-x o` → `other-pane`.
  - `C-x <left>` / `<right>` / `<up>` / `<down>` → already taken
    elsewhere or available? **Audit the existing `c-x-keymap`**
    (lines 14-33 of `keymap.lisp`) — currently `C-x right` is
    `next-view` and `C-x left` is `previous-view`. Phase 3a keeps
    those (they're view-list navigation, not pane navigation). Add
    pane-direction focus on `M-S-up` / `M-S-down` / `M-S-left` /
    `M-S-right` instead, or reserve a fresh `C-x C-o` prefix. **The
    exact pane-direction binding is Jason's call** — leave a stub
    with `focus-pane-left` etc. registered, bind the obvious ones
    that don't collide, and write a note in architect-notes.md
    asking about the final scheme.

## What stays unchanged in 3a

- The pane tree data model from phase 2 (`packages/pane/`). All the
  walking helpers and layout math you need are already there.
- The view abstraction from phase 1 (`packages/view/`). Views aren't
  restructured.
- The OS-level layout chrome outside the editor area: top tabline
  strip (the old `tabline.js` consuming views directly per phase 2),
  REPL pane at the bottom, minibuffer, modeline, markdown-preview
  pane, the REPL/preview splitters. None of that moves into the pane
  tree this phase. Folding the outer UI into the pane model is a
  later phase.
- The smoke test's structure (16 arms). It exercises one pane today;
  add new arms for the multi-pane case, don't rework the existing
  ones.

## What goes in the new pane on split

Splitting on a **text view**: the new pane gets a *duplicate view*
— a fresh View handle of kind `'text'`, with the **same buffer**,
its own freshly-initialised point (copy of the original at the
moment of split) and mark (null) and scroll (0). The view list grows
by one entry. This is the Q9 auto-duplicate path applied to the
common "I want this file beside itself" workflow.

Splitting on a **non-text view** (shell, jukebox, image, audio,
video, doc, customize, directory-tree, directory-columns,
markdown-preview, tabline-stub): the new pane gets the **`*scratch*`
text view** (or the most-recently-focused text view in the view
list — Jason's call; default to `*scratch*` for predictability).
The originating pane keeps the non-text view; the non-text renderer
singleton stays mounted in its original pane's div.

This degraded-but-usable answer is what makes "edit-view per-pane,
others singleton" tractable in 3a. Splitting a shell into two shells
side-by-side is a real ask but it bites against the singleton
assumption; let it wait for a later phase that makes the other
renderer views per-pane too.

## Per-view point/mark — the migration

Today: `buffer.point` and `buffer.mark` are state on the buffer
(`packages/buffer/src/buffer.js` ~lines 49-51). Every text command
in `packages/stdlib/src/buffer-primitives.js` reads or mutates them
through the buffer.

After 3a: `view.point` and `view.mark` are state on the view (text
kind only; nil for non-text). The buffer holds *no* cursor.

Migration shape:

- **`packages/view/src/view.js`** — add `point: 0` and `mark: null`
  initial fields for `kind === 'text'` views in `createView`. Other
  kinds leave the fields undefined (or explicitly null — either
  works; pick one).

- **`packages/buffer/src/buffer.js`** — remove the closure `point`
  and `mark` locals and their getters/setters. The buffer's
  insert/delete methods stop mutating point as a side effect; they
  take an explicit offset argument (most callers already pass one;
  the implicit-point callers are inside `buffer-primitives.js` and
  read the view's point now). Edit-history and undo continue to
  record the position they restore to — keep that data on the edit
  history record, not on the buffer.

- **`packages/stdlib/src/buffer-primitives.js`** — every primitive
  that touches point/mark resolves through `(current-view)` →
  `view.point` / `view.mark`. `(point)`, `(mark)`, `(set-point!)`,
  `(set-mark!)`, `(insert!)`, `(delete-region!)`, etc.

- **`packages/renderer/src/view.js` (the editor renderer)** — the
  view module currently reads `buffer.point` inside its render loop
  (e.g. for cursor positioning, selection rects). Add a constructor
  option `getPoint: () => number` and `getMark: () => number | null`,
  defaulted from the buffer's old fields for renderer unit tests
  that still pass a bare buffer. The desktop app passes closures
  that read `view.point` / `view.mark` of the View bound to that
  editor instance.

- **All callers in `packages/stdlib/lisp/*.lisp` and the renderer
  command modules.** Grep for `buffer.point`, `buffer.mark`,
  `(point)`, `(mark)`. Audit each.

This refactor is the single largest piece of 3a. Land it as its own
commit before the split commands, so each subsequent commit can
assume per-view-point is true. The tests for `buffer-primitives` and
the renderer's view will need updates; expect cascading fixture
changes.

## Per-pane edit-view instances — the refactor

Today: `editorView = createEditorView(...)` is constructed once at
startup with one container element. `switchToViewIndex` calls
`editorView.setBuffer(view.buffer)` to re-point the same DOM at a
different buffer.

After 3a: one `createEditorView(view, paneEl, options)` instance per
leaf-pane that holds a text view. The instance lives as long as the
pane lives; killing the pane disposes the instance. Switching a
text-view pane to show a *different* text view re-uses the existing
instance and calls `instance.setView(newView)` (renamed from
`setBuffer`).

Shape:

- **`packages/renderer/src/view.js`** — change `setBuffer(buffer)` to
  `setView(view)`. The instance reads `activeView` (the View) and
  through it `activeView.buffer` when it needs the text data model,
  `activeView.point` for the cursor, etc.

- **`apps/desktop/src/app.js`** — replace the singleton `editorView`
  with a `Map<paneId, EditorViewInstance>`. The kind registry's text
  spec `mount(view, paneElement)` looks up the pane's instance,
  creates one if missing, attaches its root to the pane element,
  calls `instance.setView(view)`. The dispose hook on text takes the
  pane element and tears down the instance.

- **`apps/desktop/src/app.js#hideInactiveRendererViews`** — needs a
  refresh. For text panes the answer "hide every other view's root"
  no longer makes sense — each pane has its own text-view instance,
  and the non-text singletons are at most in one pane at once.
  Practically: when *any* pane shows a non-text view, that
  singleton's element moves into that pane's div; when *no* pane
  shows it, the element is detached. The function's name probably
  goes; the per-kind logic moves into the kind registry's mount /
  dispose hooks.

Per-pane edit-view instancing is the second-biggest piece of 3a
after the per-view-point migration. Land it after per-view-point but
before the split commands.

## Splitter drag UI

After `relayoutPanes` writes each leaf's rect, walk the split nodes
and emit a draggable handle div for each interior edge between two
sibling rects. A handle is a thin div (4 px) absolute-positioned
along the shared edge.

```js
// packages/pane/src/layout.js — extend
export function computeSplitterEdges(pane, hostRect) {
  // Walks the tree. Returns an array of
  //   { splitId, orientation, x, y, width, height }
  // — one entry per split node, describing where its handle sits
  // and which split-node's ratio it edits.
}
```

The handle DOM mirror lives next to the pane DOM mirror under
`editor-host`. On `mousedown` the handle captures pointer events,
records the start position and the split node's starting ratio, and
on each `mousemove` recomputes `ratio = startRatio + dx / parentRect.width`
(or `dy / parentRect.height` for vertical splits), clamped to a
minimum/maximum (say `[0.05, 0.95]` to keep both children visible).
`mouseup` releases the capture. `requestAnimationFrame` coalesces
the relayouts.

The drag mutates the split node's ratio in place — there's no
immutable replace here; the split node is already addressable in the
tree, and the layout reads the live ratio. The split node's id is
how the handle knows what to mutate; pass it as a `data-split-id`
attribute on the handle div.

## Spatial pane navigation

`(focus-pane-direction! 'left)` finds the pane whose right edge is
adjacent to the focused pane's left edge, prefers the leaf whose
vertical centerline is closest to the focused pane's vertical
centerline (when several panes touch the same edge), and switches
focus to it. Symmetric for the other three directions.

```js
// packages/pane/src/navigation.js (new module)
export function paneInDirection(rects, currentId, direction) {
  // returns the id of the adjacent pane in `direction`, or null
  // when there's no neighbour on that side.
}
```

Takes a `Map<paneId, rect>` from `computeRects` plus the current
pane's id. Pure function, easy to test.

## Auto-collapse on delete

`(delete-pane! pane)`:

1. If `pane` is the root, no-op (can't delete the only pane).
2. Find the parent split node and the sibling subtree.
3. Replace the parent (in the tree) with the sibling. This drops a
   layer and the sibling moves up; its own ratio (if it's a split)
   is unchanged.
4. Dispose the pane's renderer view instance (text panes only —
   non-text singletons stay; they may have been re-parented into the
   pane being deleted).
5. If focus was on the deleted pane (or anywhere inside its subtree,
   but the subtree is just one leaf), move focus to the sibling's
   first leaf.
6. `syncPaneElements` + `relayoutPanes`.

`(delete-other-panes! pane)`:

1. Replace the root with the leaf-pane (`pane`) intact.
2. Dispose every other leaf's renderer view instance.
3. `syncPaneElements` + `relayoutPanes`.

## File-by-file

### `packages/pane/`

- **`src/navigation.js`** — new module. `paneInDirection(rects, id,
  direction)` plus the helpers it needs. Unit-tested with
  hand-built rect maps. Export from `src/index.js`.
- **`src/layout.js`** — extend with `computeSplitterEdges(pane,
  hostRect)`. Returns an array of edge records for the splitter
  drag UI. Unit-tested for one-leaf (no edges), one-split (one
  edge), nested-split (multiple edges).
- **`src/tree.js`** — add `parentOf(root, child)` (returns the
  split node whose `first` or `second` is `child`, or null when
  `child` is root) and `siblingOf(root, child)` (returns the
  sibling subtree). Unit-tested.
- **`test/pane.test.js`** — extend with the new helpers' tests.

### `packages/view/src/view.js`

- Add `point: 0` and `mark: null` initial fields for `kind ===
  'text'` views in `createView`. (Other kinds: undefined; or
  explicitly null. Pick consistent.)
- Update the `View` typedef.

### `packages/buffer/src/buffer.js`

- Remove closure-locals `point` and `mark`, their getters/setters,
  and the lines that mutate them as side effects of insert/delete.
- The buffer's `insert(offset, text)` and `delete(start, end)` take
  explicit offsets only — most callers already pass them; the
  implicit-point callers move to `buffer-primitives.js`.
- Edit history retains the cursor offset to restore as a property of
  the history record. (Today undo/redo restore via the buffer's
  point; after this they restore via the view's point — but the
  view-tracking lives in `buffer-primitives.js` / app.js, not in
  the buffer. The buffer keeps storing the offset on its history
  record; the consumer wires it to the view.)

### `packages/stdlib/src/buffer-primitives.js`

- Every primitive that reads/writes point/mark goes through
  `(current-view)`'s fields.
- `(insert!)`, `(delete-region!)`, `(set-point!)`, `(set-mark!)`,
  movement commands (`forward-char`, `next-line`, etc.) all read
  `view.point` and `view.mark`, write back to the view.
- Selection helpers (`(region)`, `(point)` etc.) read from the view.

### `packages/stdlib/src/pane-primitives.js`

- Extend `createPanePrimitives(paneHost)` with:
  - `(split-horizontal! [ratio])` → returns `(left-handle right-handle)`.
  - `(split-vertical! [ratio])` → returns `(top-handle bottom-handle)`.
  - `(delete-pane! [pane])` → returns nil; raises on root-only.
  - `(delete-other-panes! [pane])` → returns nil.
  - `(other-pane)` → returns the new current pane handle.
  - `(focus-pane-direction! direction)` → returns the new current
    pane handle or nil when no neighbour exists.
  - `(balance-panes!)` → returns nil.
  - `(set-split-ratio! pane ratio)` → returns nil; clamps the ratio.
- The `paneHost` API grows new methods on it:
  - `splitHorizontal(pane, ratio): { first, second }`
  - `splitVertical(pane, ratio): { first, second }`
  - `deletePane(pane): void`
  - `deleteOtherPanes(pane): void`
  - `otherPane(): Pane | null`
  - `focusPaneDirection(direction): Pane | null`
  - `balancePanes(): void`
  - `setSplitRatio(pane, ratio): void`
- Lisp-side: convert direction symbols (`'left|'right|'up|'down`) to
  the string the host expects.

### `apps/desktop/src/app.js`

- Replace the singleton `editorView` with a `Map<paneId,
  EditorViewInstance>`. Build/tear-down driven by the kind registry's
  text spec.
- The kind registry's text spec changes its mount signature to
  `(view, paneElement)`; create the instance on first use, call
  `setView(view)` thereafter.
- Implement `splitHorizontal` / `splitVertical` / `deletePane` /
  `deleteOtherPanes` / `otherPane` / `focusPaneDirection` /
  `balancePanes` / `setSplitRatio` against `rootPane`. They mutate
  the tree (immutable replace via `replacePane` for splits + deletes;
  in-place `ratio` mutation for `setSplitRatio`) and call
  `syncPaneElements` + `scheduleRelayout`.
- After a split, focus stays on the originating pane —
  `currentPaneId` is set to the first child's id (which is the new
  identity of the originating leaf). Confirm the `.pane--focused`
  indicator paints there.
- Splitter drag wiring: a `pointerdown` listener on each handle div;
  `pointermove` / `pointerup` on `window` with pointer capture; the
  handler updates the split node's ratio and calls `scheduleRelayout`.
- Auto-duplicate-on-open-file-into-second-pane: in
  `openFileByPath` / `openFileInteractive`, when the resolved file's
  buffer is already shown in some pane, create a new View over that
  buffer (don't reuse the existing one) and switch the *current*
  pane to it. The buffer is shared; the views are independent.
- Q9 collision rule: `viewHost.switchToView(target)` checks whether
  `target` is currently the view in some other pane; if so, throw a
  Lisp condition (via `repl.appendError` and return null, matching
  the existing pattern).

### `apps/desktop/styles.css`

- New `--- splitter ---` section: `.splitter` is absolute-positioned;
  `.splitter--horizontal` has `cursor: col-resize` and is 4 px wide;
  `.splitter--vertical` has `cursor: row-resize` and is 4 px tall.
  The handle's background is `transparent` until hover, then a
  thin highlight in `var(--accent)` at low opacity.
- Confirm `.pane--focused` is visible enough with multiple panes —
  may need to bump the opacity from phase 2's draft.

### `packages/stdlib/lisp/keymap.lisp`

- Extend the `c-x-keymap` with:
  - `"2"` → `'split-vertical`
  - `"3"` → `'split-horizontal`
  - `"0"` → `'delete-pane`
  - `"1"` → `'delete-other-panes`
  - `"o"` → `'other-pane`
- Define the matching commands in a new `panes.lisp` (or extend
  `views.lisp`) — each is a thin wrapper around the primitive that
  ignores its return value (interactive commands don't compose
  handles).
- The pane-direction bindings: stub commands `focus-pane-left`
  etc., bound to something sensible (e.g. `"C-x C-<arrow>"`), with
  an architect note asking Jason for the final scheme.

### `packages/stdlib/lisp/panes.lisp` (new file)

- `defcommand split-horizontal` / `split-vertical` / `delete-pane` /
  `delete-other-panes` / `other-pane` / `focus-pane-left` (etc.) /
  `balance-panes`. Each calls the matching primitive with no args.
- Add to `STDLIB_FILES` in `packages/stdlib/src/index.js`.

### `apps/desktop/scripts/smoke.js`

- Existing arms must still PASS (one-pane behaviour unchanged when
  no split is performed).
- New arms:
  - Split the current view horizontally; assert two panes visible;
    assert focus stayed on the originating (left) pane.
  - Switch the right pane to a different file; assert independent
    point/mark.
  - `delete-other-panes` from the left pane; assert one pane
    remains and it's the left one.
  - `other-pane` cycles focus.
  - Splitter drag mutates the ratio (via a synthesised pointer
    event sequence).

### Tests

- `packages/pane/test/` — extend with `navigation.test.js` and
  `layout.test.js` (splitter-edges). Existing tests stay green.
- `packages/view/test/` — point/mark fields on text views; nil/
  undefined on non-text.
- `packages/buffer/test/` — every test that asserted on
  `buffer.point` / `buffer.mark` needs migration. Most likely the
  test rewrites read/write through the view shim or just pass
  offsets explicitly.
- `packages/stdlib/test/buffer-primitives.test.js` — fixture
  changes: tests now construct a View + its buffer, not a raw
  buffer. The view-host shim from existing tests grows the
  primitives that read/write view.point.

## Things NOT to do this phase

- **No tabline-view real implementation.** The phase-2 stub
  (`apps/desktop/src/app.js` ~line 3124) stays. Phase 3b.
- **No `(make-tabline-view)` / `(add-tab!)` etc.** Phase 3b.
- **No multi-window.** Phase 4.
- **No per-pane instancing of non-text renderer views** (shell,
  jukebox, image, audio, video, doc, customize, directory-tree,
  directory-columns, markdown-preview). Splitting on a non-text
  view drops `*scratch*` into the new pane.
- **No fold-state or sticky-note migration to the view.** Fold
  state per buffer (the existing `WeakMap<buffer, Set<line>>` in
  `packages/renderer/src/view.js`) stays buffer-keyed for now —
  duplicate views over one buffer share fold state. That's
  defensible; revisit if it bites.
- **Don't touch `agent-session` reconciliation.** The session
  branch's revision sits on top of phase 3+.
- **No fixture-persistence fix** (the welcome.txt / scratch.lisp
  tab-reorder bug bracketed during phase 2). Its own task; not in
  scope here.
- **Don't fold the outer UI (top tabline, REPL pane, modeline,
  minibuffer, markdown-preview) into the pane tree.** Same boundary
  as phase 2.

## Pitfalls

- **Per-view-point regressions.** Movement commands, kill-region,
  query-replace, undo/redo — all touch point. After the migration,
  any code path that still reads `buffer.point` reports the wrong
  position (or worse, mutates a now-nonexistent field). Grep the
  whole tree for `buffer.point` and `buffer.mark` after the
  migration and audit each hit. The renderer's view (`packages/
  renderer/src/view.js`) is the biggest user.

- **Undo/redo cursor positioning.** Today the buffer restores point
  after undo via its own point field. After the migration, the
  buffer can't — it doesn't know which view's point to update. The
  edit-history record retains the offset; the *consumer* (the
  primitive in `buffer-primitives.js`) writes that offset back to
  `(current-view).point`. Test undo across a split (the wrong view
  getting the cursor on undo is the worst-feeling regression).

- **Sharing buffers across views — buffer events.** A text edit in
  view A's pane should re-render view B's pane (same buffer). The
  buffer already emits change events; the renderer's editor view
  subscribes per-instance. With per-pane edit-view instances each
  subscribes independently and the shared-buffer case Just Works —
  as long as the subscribe / unsubscribe is paired with the pane's
  mount / dispose. Leaks here look like ghost panes catching events
  forever; verify with a dispose-and-recreate test.

- **Cursor positioning on click in a non-focused pane.** Today the
  editor's click-to-position handler mutates `buffer.point`. After
  the migration, it mutates the *view*'s point. With two views over
  one buffer, clicking in pane B moves view B's point; the buffer's
  event fires but view A's point is undisturbed. Confirm.

- **Splitter drag captures.** Use `setPointerCapture` on
  `pointerdown` so the drag survives the cursor leaving the handle
  div. Release on `pointerup` *and* on `pointercancel`. A leaked
  capture means subsequent clicks miss their real target.

- **ResizeObserver during a drag.** Each frame of a splitter drag
  changes leaf rects, which doesn't change `editor-host`'s rect —
  so the observer doesn't fire, which is fine. But if a drag
  somehow does change host size (it shouldn't), the observer +
  the drag's per-frame relayout race. Coalescing via
  `scheduleRelayout` handles this — but verify.

- **Auto-collapse off-by-one in the tree.** When deleting a pane,
  replacing the parent split with the sibling subtree drops a
  layer. If the sibling is itself a split, its ratio is preserved
  — but the rect it gets is now its grandparent's, which is bigger
  than its parent's was. Visually the sibling's children expand to
  fill the freed space; that's the correct behaviour. Just be sure
  `replacePane(root, parent, sibling)` is what you want, not
  `replacePane(root, parent, deepCloneOfSibling)`. (See the existing
  `replacePane` semantics — structural sharing is the default.)

- **Q9 collision rule and the view list.** With the auto-duplicate
  path, the view list grows by one entry per side-by-side instance.
  The `*Buffer List*` (view-menu) showing two `foo.txt` rows is
  expected, not a bug. The menu should disambiguate them (e.g. by
  appending the pane id, or by line:column position of point). Keep
  it simple in 3a — two identical-name rows is fine; revisit if
  Jason wants the disambiguation now.

## Branch + commit shape

- Branch: `agent-pane-splits`.
- Suggested commit cadence (each passes `pnpm test` + smoke):

  1. `feat(pane): tree helpers + spatial navigation` —
     `parentOf`, `siblingOf`, `computeSplitterEdges`,
     `paneInDirection`. All inside `packages/pane/`. Unit-tested.
     Dormant; nothing in `app.js` calls them yet.

  2. `refactor(buffer,view): point and mark move from buffer to view` —
     the per-view-point migration. Buffer loses `point` / `mark`;
     view gains them (text kind). `buffer-primitives.js`, the
     renderer's editor view, undo/redo, and every grep hit migrated.
     The app is rebuilt and tests are green; no UI changes user-
     visible yet.

  3. `refactor(desktop): per-pane editor-view instances` — kind
     registry's text spec creates one `createEditorView` per leaf,
     bound to that pane's div. Singleton `editorView` gone. With
     one pane this still works identically; the multi-pane case is
     unblocked.

  4. `feat(pane): split / delete / navigate commands` — the
     primitives + their host methods. Mutate `rootPane` via
     `replacePane`; relayout; refocus the originating pane after
     split. `(split-horizontal!)` and friends bound in Lisp; the
     `panes.lisp` file lands. C-x 2/3/0/1/o wired. Splitter handle
     divs and drag wiring. Focus indicator visible.

  5. `feat(pane): Q9 auto-duplicate + collision rule` —
     `openFileByPath` creates a fresh view over the same buffer
     when the buffer is already shown elsewhere; `switchToView`
     raises on a view already shown in another pane.

  6. `feat(smoke): multi-pane arms` — smoke arms for the split,
     focus-stays, delete, delete-others, other-pane, and splitter
     drag. (Or fold into 4–5 if cleaner.)

- Merge as `--no-ff` with sub-commit history preserved.

## Test gate

Before each commit:

- `pnpm test` — every package green. New tests in `packages/pane/
  test/`, view/buffer/stdlib fixtures updated for the point/mark
  migration.
- `pnpm --filter @editor/desktop smoke` — PASS, all arms (existing
  + new multi-pane arms).

Before merge: run live. The smoke covers user-visible behaviour but
the feel of the drag, the focus border, and the cursor-in-the-wrong-
pane-on-undo regressions only come out when you actually drive it.

## When to stop and write to `architect-notes.md`

- The per-view-point migration breaks something subtle in undo/redo
  or query-replace that the test suite doesn't catch and you can't
  reproduce reliably.
- The renderer view's `setBuffer` → `setView` rename has a much
  larger surface than expected (modules that import the view module
  for type info, etc.) and the refactor sprawls.
- The Q9 auto-duplicate path turns out to need view-list
  disambiguation in the menu sooner than expected (two identical
  entries with no visual difference become a UX problem).
- Three attempts on the same fix.
- A subagent is about to disable a failing test to make the suite
  pass — don't; stop instead.

Don't guess and proceed.

## Effort estimate

This phase is substantially larger than phase 2. Three of the six
commits — the per-view-point migration, the per-pane editor-view
instancing, and the splits-and-drag commit — are each comparable in
size to a phase-2 commit on their own. Budget roughly 1–1.5 focused
days for the full set, perhaps over two sessions with a
hand-off-and-test gate in between (between commit 3 and commit 4 is
a natural breakpoint — the app still works with one pane after
commit 3, so it's a clean place to verify before going wider).
