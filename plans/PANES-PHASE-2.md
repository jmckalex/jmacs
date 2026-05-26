# Phase 2 — pane tree with one leaf

Concrete brief for phase 2 of `plans/PANES.md`. Read PANES.md first
(especially the "The DOM shape", "Tabline as a container view", and
"Window as OS frame > Focus indication" sections) and skim
`plans/PANES-PHASE-1.md` for context on what landed in phase 1.

Phase 1 (`8248b2a`) introduced the View abstraction. Phase 2 introduces
the **pane** abstraction: a rectangular tile that holds one view.
The user sees no visible change — the editor area becomes a single
leaf pane filling the same rectangle. The data model is what's new.

## Scope

- **One window. One pane.** The pane is a leaf containing the
  current view. The binary `split` pane kind exists in the JS data
  model but is unreachable (no Lisp constructors, no UI). End-state:
  jmacs looks and behaves identically to today, but underneath, the
  editor area is now a flat `<div class="pane">` absolute-positioned
  from a JS-owned tree.

- **Focus model.** Each pane has a focus state. Click anywhere in a
  pane focuses that pane. With one pane focus is implicit, but the
  infrastructure is wired so phase 3 can light it up. The focused
  pane carries a **subtle border shading** (one CSS class toggle).

- **Adapter shim cleanup.** Phase 1 left
  `viewAsSessionRecord` and `viewAsTablineRecord` in `app.js` to
  bridge `tabline.js` and `session.js` into the new View shape. This
  phase migrates those modules to consume views directly and deletes
  the shims.

- **New Lisp surface.** `(current-pane)` returns the focused pane
  handle. Pane introspection primitives (`pane-kind`, `pane-view`)
  for tests and Lisp users; no construction commands yet.

## What stays unchanged

- The View abstraction from phase 1. Views aren't restructured.
- The kind registry. Renderer view modules (text, image, jukebox,
  shell, etc.) still receive `setView(view)` calls.
- The OS-level layout chrome that lives *outside* the editor area:
  the tabline at the top, the REPL pane at the bottom, the
  minibuffer, the modeline, the markdown-preview pane, the REPL and
  preview splitters. These stay as-is. Phase 2 only re-plumbs the
  `editor-host` area. Folding those other UI elements into the pane
  model is a later phase — likely phase 3 when tabline-views land.
- The smoke test's structure. Renamed call sites get updated, but
  the harness doesn't move.

## The pane abstraction

Lives at L4 in a new workspace `packages/pane/` (sibling to
`packages/view/` from phase 1; same territory-clarity reasoning).
Two pane kinds in the data model from day one — only one is exposed
to Lisp this phase:

```js
// packages/pane/src/pane.js (sketch)
export function createLeafPane({ id, view = null }) {
  return { kind: 'leaf', id, view };
}

export function createSplitPane({ id, orientation, ratio, first, second }) {
  return { kind: 'split', id, orientation, ratio, first, second };
}
```

Tree walking helpers:

```js
// packages/pane/src/tree.js
export function leafPanes(pane) { /* yield all leaves in display order */ }
export function findPane(pane, predicate) { /* depth-first */ }
export function replacePane(root, target, replacement) { /* immutable */ }
```

Layout — the only piece of math:

```js
// packages/pane/src/layout.js
export function computeRects(pane, hostRect) {
  // Walks the tree. Returns Map<paneId, {left, top, width, height}>
  // recursively splitting hostRect by orientation and ratio. Each
  // leaf gets its computed rect; split nodes don't appear in the
  // result (they have no DOM).
}
```

This phase only ever needs `computeRects` on a tree with one leaf
(returns one entry: the leaf's id mapped to the full hostRect). But
write it general — phase 3 will exercise the recursive case
immediately.

## DOM model

Today the editor area is `<main id="editor-host" class="editor-host">`
containing the renderer view modules' elements, hidden/shown by the
old `mountView(kind)`. Phase 2 swaps that for:

```html
<main id="editor-host" class="editor-host">
  <div class="pane" data-pane-id="<id>"
       style="left:0;top:0;width:100%;height:100%">
    <!-- renderer view module elements mount here -->
  </div>
</main>
```

The `editor-host` keeps its role as the container for the editor area
within the broader app layout (the existing flex/grid sibling of the
markdown-preview-host etc.). What changes is *inside* `editor-host`:
a single absolute-positioned pane div, sized from the pane tree.

When phase 3 splits arrive, more sibling pane divs appear under
`editor-host`, each absolute-positioned from the tree's layout. No
nested split containers; flat leaves.

### Layout flow

1. App startup builds the initial pane tree (one leaf, containing
   the current view).
2. `relayoutPanes()` reads `editor-host`'s `getBoundingClientRect()`,
   runs `computeRects(rootPane, hostRect)`, and writes the result to
   each leaf's div as inline `style.left/top/width/height` in pixels.
3. A `ResizeObserver` on `editor-host` re-runs `relayoutPanes()` on
   container size change. (Today the editor-host's children are CSS-
   sized; this replaces that with explicit pixel layout, which the
   terminal grid and image views will actually thank you for.)

## Focus

Each pane has a focus state. Phase 2 wires:

- A `currentPaneId` field at module level in `app.js`.
- A click listener on each pane div: clicking inside the pane sets
  `currentPaneId` to that pane and re-applies the `pane--focused`
  CSS class (subtle border shading per PANES.md "Focus indication").
  With one pane, this is a no-op visually but the data model is
  exercised.
- A `currentPane()` accessor (the pane handle for the current id).
- `(current-pane)` Lisp primitive that returns the pane handle.
- `(pane-view pane)` returns the view in a leaf pane (or `nil`).
- `(pane-kind pane)` returns the kind ('leaf' or 'split').

The pane-focus model interacts with the existing view-focus model:
"current view" is now defined as "the view in the focused leaf
pane." For phase 2 that's identical to today's "the current view in
the views list" because there's one leaf — but the resolution path
shifts: `(current-view)` now resolves through `(current-pane)` and
reads `pane.view`. Update `view-primitives.js` accordingly; do NOT
break the existing semantic.

## Adapter shim cleanup

`app.js` currently has `viewAsTablineRecord` (~line 3366) and
`viewAsSessionRecord` (~line 3429), projecting View into the
legacy `{name, filePath, point, mark, kind?}` shape these modules
expect.

Cleanup approach: change `apps/desktop/src/tabline.js` and
`apps/desktop/src/session.js` to consume `getViews(): View[]`
instead of `getBuffers(): {name, filePath, …}[]`. Both modules
already read a tiny surface (name, filePath; session also reads
kind/point/mark). They can read these straight off the View:

- `view.name`
- file path: use the existing `viewFilePath(view)` helper from
  `app.js` — move it to a shared place (`packages/view/src/index.js`
  or a small `apps/desktop/src/view-utils.js`) so both `tabline.js`
  and `session.js` can import it.
- `view.kind`
- text view point/mark: read `view.buffer?.point` / `view.buffer?.mark`.

Then delete the `viewAsTablineRecord` / `viewAsSessionRecord`
functions in `app.js`.

The change is mostly mechanical inside `tabline.js` and `session.js`;
their unit tests need their fixtures updated to use View-shaped
inputs instead of buffer-record-shaped inputs.

## File-by-file

### `packages/pane/` (new workspace)

- `package.json` — `@editor/pane`, ESM, no runtime deps.
- `src/pane.js` — `createLeafPane`, `createSplitPane`, kind constants.
- `src/tree.js` — `leafPanes`, `findPane`, `replacePane`, `findLeafByViewId`.
- `src/layout.js` — `computeRects`.
- `src/index.js` — re-exports.
- `test/pane.test.js` — unit tests for the constructors + tree
  helpers + layout math. Cover one-leaf and a deliberately-
  constructed two-leaf split case even though Lisp doesn't expose
  splits yet, so layout regressions in phase 3 are caught early.

### `apps/desktop/src/app.js`

- Build an initial pane tree at startup (one leaf containing the
  current view).
- Replace `mountView(kind)` / `kindRegistry.mount(view)` flow with
  a pane-aware variant: the leaf pane's div is the mount target;
  the kind registry's mount hook receives `(view, paneElement)` so
  it can position its DOM inside the leaf.
- Add `relayoutPanes()`, observe `editor-host` for resize, run on
  init.
- Add `currentPaneId` state + the click-to-focus listener.
- Remove `viewAsTablineRecord` and `viewAsSessionRecord`; pass
  `getViews: () => views` to `createTabline` and `createSession`.
- Add `host.currentPane()` exposure for the Lisp primitive.

### `apps/desktop/styles.css`

- New section `--- pane ---`. Rules:
  - `.pane { position: absolute; overflow: hidden; }` (or whatever
    fits the layout flow).
  - `.pane--focused` — the focus border. Subtle: a 1px border in
    `var(--accent)` at maybe 50% opacity, with a 1px transparent
    border on unfocused panes so toggling doesn't reflow.
- `.editor-host` becomes `position: relative` (it's the positioning
  context for absolute-positioned panes); remove any flex/grid
  rules that conflict.

### `apps/desktop/src/tabline.js`, `session.js`

- Take `getViews` instead of `getBuffers` (rename param + JSDoc).
- Read view fields directly. Use the shared `viewFilePath` helper.
- Fixture/test updates to match.

### `packages/stdlib/src/view-primitives.js` (or new `pane-primitives.js`)

- `current-pane` → returns the current pane handle.
- `pane-kind` → returns 'leaf' or 'split' as a Lisp symbol.
- `pane-view` → returns the view in a leaf pane (nil for splits).
- Update `current-view` so it resolves via `current-pane` →
  `pane.view`. (Semantic unchanged with one pane; clearer once
  splits arrive.)

If splitting into a new `pane-primitives.js` file, follow the same
pattern as `view-primitives.js`: take a `paneHost` parameter from
`app.js` that exposes `currentPane()`.

### `apps/desktop/scripts/smoke.js`

The smoke shouldn't *need* changes — the user-visible behaviour is
unchanged. Run it; if anything fails, the most likely cause is the
pane div absorbing a click that used to bubble up to a global
listener. Fix the bubble, not the test.

### `packages/stdlib/test/`, `apps/desktop/test/`

Tests for `tabline.js` and `session.js` need their fixtures
restructured to View shape. Unit tests for the new `@editor/pane`
package land in `packages/pane/test/`.

## Things NOT to do this phase

- **No splits exposed.** No `(split-horizontal!)`, no `C-x 2` / `C-x 3`,
  no `delete-pane`. The data model exists; the user can't invoke it.
  Phase 3.
- **No tabline-view rendering.** The tabline kind is registered with
  a phase-3 stub; don't implement its mount.
- **No `(make-split-pane)` Lisp constructor.** Phase 3.
- **No multi-window.** Phase 4.
- **Don't fold the OUTER UI (top tabline, REPL pane, modeline,
  minibuffer, markdown-preview) into the pane tree.** Phase 2 is
  about the editor area only.
- **Don't touch per-pane modeline.** PANES.md's Q8 was deferred;
  keep the existing single global modeline at the bottom of the app.
- **No `agent-session` reconciliation.** That branch's revision sits
  on top of phase 2; not in scope here.

## Pitfalls

- **Click handlers on pane divs may steal clicks** the renderer view
  modules expect to receive. Audit which view modules listen for
  clicks on their own elements (text edit view, jukebox transports,
  image-view drag, shell-view's xterm). The pane-focus listener
  should fire on *bubble*, after content listeners have had their
  turn, and shouldn't `preventDefault`. Verify the shell view's
  Cmd+C selection-copy and the text view's cursor positioning still
  work.

- **ResizeObserver storms.** When the user drags the REPL splitter
  or the markdown-preview splitter, `editor-host`'s size changes
  continuously. `relayoutPanes()` should be cheap (single-leaf →
  one DOM-style write) but coalesce via requestAnimationFrame if
  there's any chance it becomes a bottleneck. xterm.js's FitAddon
  uses the same pattern.

- **z-index and overflow** on the renderer view modules' root
  elements. Today they're hidden/shown by `display`. With absolute
  positioning their root needs `width: 100%; height: 100%;` inside
  the leaf div, and `overflow: hidden` to clip child terminals /
  images that haven't yet sized themselves.

- **`editor-host` resize when there is no leaf yet** (early init).
  `computeRects` should tolerate a zero-sized host or be skipped
  until first paint.

## Branch + commit shape

- Branch: `agent-pane-tree`.
- Suggested commit cadence (each passes `pnpm test` + smoke):
  1. `feat(pane): introduce Pane abstraction + tree + layout` —
     `packages/pane/` with constructors, tree walking, layout math,
     unit tests. Dormant; `app.js` not wired yet.
  2. `refactor(desktop): editor area becomes a leaf pane` — wire
     `app.js` through the pane tree. New `.pane` CSS. ResizeObserver
     + `relayoutPanes`. Existing view-module mount swaps from the
     old "hidden/shown by display" to "absolute-positioned in a leaf
     pane." User-visible behaviour unchanged.
  3. `feat(focus): pane focus model + indicator` — `currentPaneId`,
     click-to-focus, `pane--focused` border. With one pane the
     indicator is invisible; the model is exercised.
  4. `feat(lisp): (current-pane), (pane-view), (pane-kind)
     primitives` — Lisp surface. `(current-view)` reroutes through
     `(current-pane)`.
  5. `refactor(desktop): drop viewAsTablineRecord /
     viewAsSessionRecord adapters` — tabline.js + session.js
     consume views directly via `getViews`; `viewFilePath` moves to
     a shared module; fixture/test updates.
- Merge as `--no-ff` with sub-commit history preserved.

## Test gate

Before each commit:
- `pnpm test` — every package green. New tests in
  `packages/pane/test/`.
- `pnpm --filter @editor/desktop smoke` — PASS, 16 arms.

## When to stop and write to `architect-notes.md`

- The renderer view modules' mount surface (today: `setBuffer`/
  `setView` on a singleton instance per kind) doesn't fit absolute-
  position layout cleanly. If you need to refactor the kind-spec's
  mount signature, it's larger than this brief — write a note.
- The click-to-focus interferes with any view's own click semantics
  in a non-trivial way.
- The pane abstraction needs to live somewhere other than
  `packages/pane/` (e.g., extending `packages/view/` for simpler
  coupling).
- Three attempts on the same fix.

Don't guess and proceed.

## Effort estimate

Roughly half a focused day — substantially smaller surface than
phase 1. Most of the work is the new `packages/pane/` module, the
`app.js` re-plumbing, and the adapter cleanup. The CSS + focus
indicator is small.
