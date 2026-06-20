# Sub-views — view-owned satellite views

**Status:** design note, not yet implemented. Prompted by the minimap
(branch `minimap-view`), which is currently a *sibling leaf* in the pane
tree and so loses its spatial relationship to its target under frame-move
(`swap-views` / `permute-views`). See that branch for the interim
implementation and `docs/VIEWS.md` for the containment invariants this
must respect.

## Problem

Some on-screen things belong to a **view**, not to the window: a minimap,
an overview/annotated scrollbar, a per-view breadcrumb / table-of-contents,
a diff-or-blame gutter, an image thumbnail strip, a gnuplot view's
parameter/output panels. Today the only way to put such a thing beside a
document is to make it a peer **leaf** in the pane tree. That's wrong: a
peer leaf participates in splits, focus cycling, and frame-move as an
independent pane, so it can be separated from, or shuffled away from, the
view it's meant to accompany. The companion has to *chase* its host through
reconcile hooks (the minimap's `rebindMinimapForLeaf` / `scheduleMinimapReconcile`
machinery) — and frame-move still breaks adjacency.

## Concept

A **sub-view** is a view docked to, and owned by, a host view — the way the
window hosts a pane tree, a view hosts its sub-views. The defining property
is **fate-sharing**: when the host is hidden (inactive tab), moved
(frame-move / permute), warehoused, or destroyed, its sub-views do the same
**by construction**, because they are part of the host's surface rather than
independent tree nodes. No reconcile, no chasing.

Duality worth keeping in mind: a **tabline** multiplexes child views *in
time* (one tab visible); a **sub-view host** multiplexes them *in space*
(docked regions, shown together). Both are "a view that contains views."

## Decision: ownership is per-**view** (not per-leaf)

Each view owns its sub-views. Concretely for the minimap: every text view
carries *its own* minimap. This is the model VS Code / Nova use (the minimap
is part of *that* editor), and it is markedly simpler here:

- A tab switch hides one tab's element (its sub-views included) and shows
  another's — the minimap "follows" automatically. The whole
  `reconcile / peelTabline / "mirror the active content" / orphan-cleanup`
  layer **is deleted**, not ported.
- Promotion/demotion move the view between leaf-direct and tabline-wrapped;
  its sub-views travel with it untouched.
- Frame-move / permute can't separate a sub-view from its host, and never
  badge or focus it (sub-views aren't panes).

Generality the per-view model unlocks (the reason to prefer it): sub-views
become a capability of **every** view kind, host *and* satellite. A gnuplot
view could host its own satellite panels; an image view a thumbnail strip;
a doc view a table-of-contents. The minimap is just the first client.

Behavioural deltas from the current per-leaf minimap, to accept:
- A non-text tab simply has **no** minimap (its region collapses) rather
  than showing "Minimap not supported for this view." Cleaner; different
  from the current spec.
- Each tab has its own minimap rather than one shared per pane (correct, but
  a change).

## Design points

- **Reuse the pane layout, don't build a parallel one.** A sub-view region
  is a *subordinate, restricted pane subtree* rooted at the host: reuse
  `packages/pane/src/layout.js` rect math + the splitter handling,
  restricted to the host's box, flagged subordinate so window-level
  operations (split, focus-cycle, frame-move, the move-views overlay) skip
  it. This is what keeps it from becoming a second layout system.
- **Docking:** each sub-view has an `edge` (left/right/top/bottom) and a
  size (fraction, with a resize splitter between host content and sub-view).
  Default for the minimap: right, ~0.16, per the existing `*minimap-*`
  defcustoms.
- **Focus:** sub-views are subordinate — they never become the active pane
  (today's `:no-focus`), and interacting with one acts on / navigates the
  host.
- **Persistence:** a sub-view's presence + config rides with the host
  view's session blob (e.g. `view.subViews = [{kind:'minimap', edge, size}]`),
  replacing the current "don't persist; collapse the leaf on restore" hack
  in `session.js`.
- **Warehouse:** sub-views move with the host element when it is warehoused
  / re-parented (they're DOM descendants of the host's surface).
- **Lifecycle:** the host's mount/hide/destroy drives the sub-views; the
  custom-element model already gives each its own `configure`/`setView`/
  `destroy`, so a sub-view is just another `ViewElement` laid out in the
  host's region.

## Touchpoints (for the eventual implementation)

- Leaf mount path: `mountKindView`, `ensureEditorViewForLeaf`,
  `syncPaneElements`, `scheduleRelayout` (apps/desktop/src/app.js) — a leaf's
  content becomes "host element + its sub-view region."
- Tabline tab-element model: `tablineStateByView`, `mountTablineActiveChild`
  — each tab element carries its sub-views; the existing show/hide-inactive
  logic already covers them.
- Layout: `packages/pane/src/layout.js` (restricted/subordinate reuse).
- Persistence: `serialiseView` / `serialisePane` (apps/desktop/src/session.js).
- Minimap migration: delete `minimapByTargetLeafId`, `rebindMinimapForLeaf`,
  `scheduleMinimapReconcile`, `removeMinimapForLeaf`, the no-focus split
  attach, and the session-collapse special-case; reattach `<minimap-view>`
  as a sub-view of each text view. The element itself (rendering, hover
  band, code-preview flyout, scroll/edit subscriptions) is unchanged — it
  already takes a target adapter.

## Pros / cons (summary)

**Pros:** companion-follows-host by construction (no reconcile); deletes the
minimap's host-wiring rather than adding to it; correct ownership for
persistence and focus; a reusable home for view-attached chrome across all
view kinds (incl. gnuplot); no pollution of the pane tree / focus cycle /
move overlay.

**Cons:** a fifth containment layer in the area `VIEWS.md` flags as the
top source of bugs (visibility/lifecycle matrix grows); risk of a second
layout system unless `layout.js` is deliberately reused; more Electron-only,
hard-to-unit-test layout surface; non-trivial migration touching the leaf
mount, tabline, relayout, persistence, and warehouse paths.

## Phasing

1. **Interim (optional, on `minimap-view`):** mark the companion split
   atomic + exclude the minimap leaf from the move-views overlay, so
   frame-move can't separate or shuffle it. Cheap, reversible, buys time.
2. **Target (this note):** introduce sub-views as a subordinate pane subtree
   owned per-view; migrate the minimap onto it (a net code *deletion*); open
   it to other kinds (gnuplot etc.) as clients appear.

## Open questions

- Can a sub-view host its own sub-views (recursion), or one level only?
  (One level is almost certainly enough; recursion multiplies the matrix.)
- Do sub-views get their own keymap/command surface, or only host-mediated
  interaction?
- Resize splitter: share the pane splitter UI, or a lighter per-region grip?
- For a buffer shown in two views (Q9 auto-duplicate), each view gets its own
  sub-views — confirm that's the intended (independent) behaviour.
