# Moving views between panes — `swap-views` and `permute-views`

Design note for two interactive commands that rearrange which view is
shown in which on-screen pane. Pre-implementation; settle here, then
build on a branch.

**Status:** drafted 2026-06-03 from a design conversation with Jason.
The design calls below were settled in that conversation; they're
marked **[settled]**, including command naming (`swap-views` /
`permute-views` — the commands move *views*, even though the user thinks
of it as rearranging panes) and the primitive stack (see "Primitive
stack & layering").

## What this is (and isn't)

A pane tree carves the editor area into rectangles; each leaf holds one
view (a leaf-direct view, or a whole tabline-view with its tabs). These
two commands let the user **rearrange which view sits in which pane**
without changing the split structure — the rectangles stay exactly
where they are; their *contents* trade places.

- `swap-views` — number every pane, user types two numbers, those two
  panes' contents trade places.
- `permute-views` — number every pane, user types a destination for
  pane 1, then pane 2, and so on; every pane's content moves at once.

This is **not** restructuring the split tree (no new splits, no
collapses, no resizing the tree). The topology is invariant; only the
mapping from leaf-node to on-screen slot changes.

## The four settled design calls

### 1. Pane numbering — clockwise spiral from the top-left **[settled]**

Numbering must be deterministic for *any* layout a binary split tree can
produce, including interior panes. The rule:

> Draw a ray from the window's centre to the window's **top-left
> corner** — the pane there is **#1**. Rotate the ray clockwise. Number
> each pane as the ray crosses its **top-left corner**. When the ray
> crosses several collinear corners at once, the **furthest-out** is
> numbered first — so the numbering spirals inward.

Concretely, for each leaf with rect `{left, top, ...}`:

- centre `C = (W/2, H/2)`; corner `T = (left, top)`; `v = T − C`.
- screen-clockwise angle `φ(v) = atan2(v.y, v.x)` (screen y points down,
  so `atan2` *increases* clockwise).
- sweep angle `α = (φ(v) − φ(startDir)) mod 2π`, where
  `startDir = (0,0) − C` points at the window's top-left corner.
- **Sort key:** `α` ascending, then radius `|v|` **descending**
  (furthest-out first — Jason's tie-break), then `leaf.id` ascending
  (a nano-tiebreak for the pathological case of two identical corner
  points; never hit in practice, present only so the order is total).

The top-left pane's corner is `(0,0)`, which lies exactly on the start
ray at `α = 0` and is the furthest point along it — so it is always #1,
matching intuition.

This sort is computed from **geometry** (`computeRects`), not from the
tree's DFS `leafPanes()` order, which is not spatial.

### 2. Mechanism — move the frames, not the contents **[settled]**

Two implementations look identical on screen; only the DOM differs:

- **Move the contents** (what the existing `swapPaneViews`,
  `app.js:6713`, does): keep each `.pane` div fixed, reparent the view
  *elements* between them. This is the known trap — moving a `<webview>`
  in the DOM recreates its guest and blanks the page (see
  `docs/VIEWS.md`; bit us last session). Also needs bookkeeping fixes.

- **Move the frames** (chosen): keep each view inside its own `.pane`
  div, untouched, and **swap which slot each leaf node occupies in the
  tree** so `computeRects` hands each `.pane` the other's rectangle.
  Then `relayoutPanes()` (`app.js:473`) just rewrites `left/top/
  width/height` on the existing divs by leaf id. **No view DOM moves**,
  so a browser/PDF/shell pane can never blank, and *every* per-leaf map
  (`paneElements`, `editorViewByPaneId`, `tablineStateByView`,
  `currentViewIndex`, `currentPaneId`) stays valid with zero changes —
  the leaf nodes keep their ids and contents; only their tree position
  changes.

**Consequence — focus follows the view.** `currentPaneId` is a leaf id;
that leaf carries its content to the new slot, so the focused view stays
focused and simply relocates. This is the intended behaviour.

The existing content-swap `swapPaneViews` (`app.js:6713`) is
**superseded** by the new frame-move path. The Lisp primitive
`swap-panes!` is **repointed** to the frame-move implementation
(`swapPaneFrames`, below); its signature `(swap-panes! paneA paneB)` is
unchanged, so its existing caller `swap-with-other-pane` (`panes.lisp:
158`) keeps working — and silently gains the webview-safe behaviour. The
old `swapPaneViews` can then be deleted.

### 3. Input model — scales to any N **[settled]**

Panes can exceed nine (do **not** hard-code a 9-pane ceiling). Numbers
are entered as digit strings with these rules:

- **Digits** append to the *pending* number, shown live and previewed on
  the candidate panes (panes whose number has the pending string as a
  prefix highlight; the set narrows as you type).
- **Auto-accept on an unambiguous prefix:** the moment the pending
  string equals a valid pane number *and* is not a proper prefix of any
  other valid pane number, it's accepted automatically. **For N ≤ 9 this
  makes every entry a single keypress** (no number is a prefix of
  another), preserving the snappy feel; only when N ≥ 10 and a typed
  prefix is itself a valid pane *and* a prefix of a larger one (e.g. `1`
  when panes 1 and 10–12 exist) does it wait.
- **Space** force-accepts the pending number if it is a valid, still-
  available pane number (the explicit "I mean exactly this" key for the
  ambiguous-prefix case). An invalid/taken number beeps and is ignored.
- **Delete/Backspace** — if the pending number has digits, delete the
  last digit; if it's empty, **undo the last accepted assignment** (this
  is Jason's "undo assignments one at a time", unified with digit
  editing under one key).
- **Enter** accepts any pending number, then **commits** the whole
  operation (the move runs). Requires the right count — exactly 2 for
  swap, exactly N for permute — otherwise beeps.
- **`C-g` / Escape** aborts: no change, badges removed.

### 4. Reachable while a browser is focused **[settled]**

A focused `<webview>` swallows `C-x` chords — the reason the View-menu
pane ops exist. So:

- Both commands appear in the **View menu** (invokable when a chord
  can't be typed), in addition to keybindings.
- Once active, the transient digit-capture hooks the **global
  window-level key router** (the bubble-phase dispatcher), *not* the
  focused element — otherwise a focused browser eats the digits.
- The number **badges** render in a single **top-level overlay layer**
  above the editor host (positioned from `computeRects`), so they paint
  *over* a focused browser pane rather than under its guest. (Verify the
  z-order actually wins over a `<webview>` during the build; with
  `<webview>` tags + a high z-index it should.)

## Command UX

### `swap-views`

1. Badge every pane (spiral numbering). Prompt: `Swap: from / to`.
2. User enters two pane numbers. Live highlight on each as it's chosen.
3. **Enter** commits — the two panes' contents trade slots. **Delete**
   walks the entries back; **C-g** aborts. Same index twice → no-op.

### `permute-views`

1. Badge every pane. Process sources in numeric order: highlight pane 1,
   prompt `Pane 1 → ?`; the typed number is its **destination slot**.
2. Each pane badge shows its source number, and once assigned, the
   destination as an arrow, e.g. `3→1`, so the permutation is visible as
   it forms.
3. **Bijection enforced:** a destination already taken is not a valid
   candidate (excluded from highlight/auto-accept; Space on it beeps).
   When N−1 are assigned, the last is **forced** and auto-filled.
4. **Enter** commits the whole permutation at once. **Delete** undoes the
   most recent assignment (re-freeing its slot and stepping back a
   source). **C-g** aborts.

"Destination" is a *slot* in the same spiral numbering: "pane k → d"
means pane k's content ends up where slot d's rectangle is now.

## Primitive stack & layering **[settled]**

The shape mirrors `add-pane`: a transient visual macro is a host-side
module that owns the overlay + window-level key capture, triggered by a
one-line Lisp `enter-…-mode!` primitive. We additionally expose the
mechanism and numbering as standalone primitives so the capability is
composable from Lisp non-interactively (a user macro can call
`(swap-panes! a b)` or `(permute-panes! …)` directly). Four layers,
bottom-up:

### Layer 1 — pane package (`packages/pane/src/`), pure tree math

Copy-on-write, identity-preserving (reuse the existing leaf node objects
so ids/contents/maps survive). Topology never changes — only which leaf
node sits in which slot.

```js
// tree.js
/** New tree with leaves A and B exchanging tree positions. */
swapLeaves(root, leafA, leafB) -> Pane

/** New tree where each leaf is relocated per OCCUPANTBYSLOT, keyed by
 *  the leaf's spiral slot index. occupantBySlot[i] is the leaf node that
 *  should sit in slot i afterwards (a bijection over the same leaf set).
 *  swapLeaves is the 2-element special case. */
permuteLeaves(root, spiralIndexByLeaf, occupantBySlot) -> Pane

// layout.js (geometry — lives where the rects are computed)
/** Leaves in clockwise-spiral order (numbering, call 1 §). Returns the
 *  ordered leaf list and a Map<leaf, index> for the inverse lookup. */
spiralOrder(root, hostRect) -> { ordered: Leaf[], indexByLeaf: Map }
```

### Layer 2 — desktop host functions (`apps/desktop/src/app.js`)

Thin glue over Layer 1 that re-assigns `rootPane` and calls
`relayoutPanes()`. No remount, no reparent.

```js
swapPaneFrames(paneA, paneB)        // swapLeaves + relayout; replaces swapPaneViews
permutePaneFrames(orderedPanes, destSlots)  // permuteLeaves + relayout
spiralOrderedLeaves()               // wraps spiralOrder against the live host rect
```

### Layer 3 — Lisp-facing host primitives

Registered in the same host-primitive table as `open-url!`,
`split-horizontal!`, etc. Pane handles already cross the bridge
(`current-pane`, `swap-panes!`).

```lisp
(swap-panes! paneA paneB)        ; REPOINTED to swapPaneFrames (was content-swap)
(permute-panes! panes dests)     ; new — panes in spiral order, dests parallel list
(panes-in-spiral-order)          ; new — list of pane handles in badge-number order
(enter-move-views-mode! kind)    ; new — kind is 'swap or 'permute; runs the macro
```

`enter-move-views-mode!` drives the host module
`move-view-mode.js` (sibling of `add-pane-mode.js`): builds the badge
overlay from `spiralOrderedLeaves()`, captures digits/Space/Backspace/
Enter/`C-g` at window capture phase, runs the swap/permute state machine
(call 3 §), and on commit calls `swapPaneFrames` / `permutePaneFrames`.
Returns a `{ active, exit }` handle exactly like `enterAddPaneMode`.

### Layer 4 — Lisp commands (`packages/stdlib/lisp/panes.lisp`)

One-liners, in the spirit of `add-pane`:

```lisp
(defcommand swap-views ()    "…" (enter-move-views-mode! 'swap))
(defcommand permute-views () "…" (enter-move-views-mode! 'permute))
```

Plus View-menu entries (`view-menu.lisp` / `menu.js`) and keybindings
(`keymap.lisp`), per call 4 §.

**Why not build the interaction in Lisp?** The badge overlay, the
live highlight, and digit capture *over a focused `<webview>`* are
inherently host/DOM work, and `add-pane` already establishes that
transient visual macros are host modules. Exposing Layers 1–3 as
primitives still leaves the *mechanism* fully scriptable from Lisp; only
the interactive shell is host-side.

## Testing

- **Pane package (unit, `pane.test.js`):** `swapLeaves` /
  `permuteLeaves` preserve leaf identity (same node objects), preserve
  topology (split structure + ratios unchanged), and realise the
  intended slot mapping. `spiralOrder` on hand-built layouts: 2-pane
  L/R and T/B, 2×2 grid (TL→TR→BR→BL), tall-left + two-stacked-right,
  and an interior-pane case — assert the exact ordering, including the
  furthest-out-first tie-break.
- **Permutation algebra:** identity permutation is a no-op;
  `permute` of a transposition equals `swapLeaves`; applying a
  permutation then its inverse restores the original tree.
- **App-level (manual / smoke):** swap two panes where one holds a live
  browser and confirm the page does **not** reload (the whole point of
  move-the-frames). Verify badges paint over a focused browser. Verify
  focus follows the moved view. **Regression:** `swap-with-other-pane`
  (`C-x`-bound) still swaps correctly after `swap-panes!` is repointed —
  and now also survives a browser pane.

## Edge cases

- **One pane:** no-op with a message ("Only one pane").
- **Swap same index twice / permute identity:** no-op, exit cleanly.
- **Abort mid-entry (`C-g`):** badges removed, tree untouched.
- **A pane mid-move that's a tabline:** the whole tabline (all tabs)
  moves as one unit — free, because the move is a tree-slot reassignment
  and the tabline lives inside that leaf's `.pane` div.

## Naming **[settled]**

Commands: `swap-views` / `permute-views` (they move *views*). The
slot-cycle focus command stays `swap-with-other-pane`. Internal layers
keep their own vocabulary: `swapLeaves` / `permuteLeaves` /
`spiralOrder` (pane package), `swapPaneFrames` / `permutePaneFrames`
(host), `swap-panes!` / `permute-panes!` / `panes-in-spiral-order` /
`enter-move-views-mode!` (Lisp primitives). The `…-panes!` primitives
keep the existing `-panes` suffix for continuity with `split-…!` /
`delete-pane!` and the live `swap-panes!` caller.
