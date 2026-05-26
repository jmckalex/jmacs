/**
 * @file Pane primitives — the Lisp surface for addressing panes.
 *
 * Phase 2 of plans/PANES.md introduces the pane abstraction: a
 * rectangular tile in the editor area that holds one view. Phase 3a
 * (this file's expanded surface) adds the split / delete / navigate
 * constructors so users can carve the editor area into multiple panes.
 *
 * The host (the desktop app) supplies a `paneHost` shape with:
 *
 *   - `currentPane()` — the focused pane handle (a leaf), or null.
 *   - `splitHorizontal(pane, ratio)` — replaces PANE with a horizontal
 *     split node; returns `{ first, second }` — both leaves.
 *   - `splitVertical(pane, ratio)` — likewise, vertical orientation.
 *   - `deletePane(pane)` — collapses PANE's parent split into PANE's
 *     sibling. No-op when PANE is the root.
 *   - `deleteOtherPanes(pane)` — makes PANE fill the whole editor area.
 *   - `otherPane()` — cycle focus to the next leaf in display order;
 *     returns the new current pane handle.
 *   - `focusPaneDirection(direction)` — focus the leaf adjacent to the
 *     current one in DIRECTION (`'left'`/`'right'`/`'up'`/`'down'`).
 *     Returns the new current pane handle, or `null` when no
 *     neighbour exists.
 *   - `balancePanes()` — reset every split node's ratio to 0.5.
 *   - `setSplitRatio(pane, ratio)` — set PANE's ratio (PANE must be a
 *     split node). Clamped to `[0.05, 0.95]`.
 *
 * `(current-view)`, defined in view-primitives.js, resolves through
 * `(current-pane)` → `pane.view`.
 *
 * Per Q15, pane-creating commands return handles. The split
 * constructors return `(first-handle second-handle)` so a Lisp caller
 * can immediately compose against either leaf.
 */

import { cons, NIL } from '@editor/lisp';

/** The ratio range a split is clamped to so both children stay visible. */
const MIN_RATIO = 0.05;
const MAX_RATIO = 0.95;

/** Default ratio for a fresh split (50/50). */
const DEFAULT_RATIO = 0.5;

/** Clamp RATIO to `[MIN_RATIO, MAX_RATIO]`. Anything non-numeric or NaN
 *  falls back to `DEFAULT_RATIO`. */
function clampRatio(ratio) {
  if (typeof ratio !== 'number' || Number.isNaN(ratio)) return DEFAULT_RATIO;
  if (ratio < MIN_RATIO) return MIN_RATIO;
  if (ratio > MAX_RATIO) return MAX_RATIO;
  return ratio;
}

/** Pull an explicit ratio from a primitive's args, or the default. */
function ratioFromArgs(args) {
  if (args.length === 0) return DEFAULT_RATIO;
  const raw = args[0];
  if (raw === NIL || raw === null || raw === undefined) return DEFAULT_RATIO;
  return clampRatio(Number(raw));
}

/** Resolve PANE_OR_NIL to a pane handle: when nil/missing, fall back to
 *  the focused pane. Returns null when nothing is current. */
function resolvePaneArg(args, paneHost) {
  const raw = args[0];
  if (raw === undefined || raw === null || raw === NIL) {
    return paneHost.currentPane();
  }
  if (typeof raw === 'object' && raw !== null && typeof raw.kind === 'string') {
    return raw;
  }
  return null;
}

/**
 * Build the pane primitives for a pane-host.
 *
 * @param {PaneHost} paneHost
 * @returns {Record<string, (args: *[]) => *>}
 */
export function createPanePrimitives(paneHost) {
  return {
    // `(current-pane)` — the focused leaf pane's handle. `nil` when no
    // pane has focus (vanishingly rare; the editor area always has at
    // least one leaf).
    'current-pane': () => {
      const pane = paneHost.currentPane();
      return pane ?? NIL;
    },
    // `(pane-kind pane)` — the pane's kind as a string. Either `"leaf"`
    // or `"split"` for a well-formed handle.
    'pane-kind': (args) => {
      const pane = args[0];
      if (pane === null || pane === undefined || pane === NIL) return NIL;
      if (typeof pane !== 'object') return NIL;
      return typeof pane.kind === 'string' ? pane.kind : NIL;
    },
    // `(pane-view pane)` — the view a leaf pane holds, or `nil` for a
    // split pane (which holds no view directly) or a malformed handle.
    'pane-view': (args) => {
      const pane = args[0];
      if (pane === null || pane === undefined || pane === NIL) return NIL;
      if (typeof pane !== 'object') return NIL;
      if (pane.kind !== 'leaf') return NIL;
      return pane.view ?? NIL;
    },

    // --- split / delete / navigate -------------------------------------
    // Phase 3a: the user-facing pane surface.

    // `(split-horizontal! [ratio])` — replace the current leaf with a
    // horizontal split node (side-by-side). The originating leaf stays
    // focused as the *first* child (left), the new leaf becomes the
    // *second* (right). Returns `(left-handle . right-handle)` as a
    // proper list `(left right)` per Q15.
    'split-horizontal!': (args) => {
      const pane = paneHost.currentPane();
      if (pane === null) return NIL;
      const ratio = ratioFromArgs(args);
      const result = paneHost.splitHorizontal(pane, ratio);
      if (!result) return NIL;
      return cons(result.first, cons(result.second, NIL));
    },
    // `(split-vertical! [ratio])` — likewise, vertical orientation
    // (top-and-bottom). Originating leaf is the *first* (top) child.
    'split-vertical!': (args) => {
      const pane = paneHost.currentPane();
      if (pane === null) return NIL;
      const ratio = ratioFromArgs(args);
      const result = paneHost.splitVertical(pane, ratio);
      if (!result) return NIL;
      return cons(result.first, cons(result.second, NIL));
    },
    // `(delete-pane! [pane])` — collapse PANE's parent split into PANE's
    // sibling. No-op on the root-only-leaf case. PANE defaults to
    // `(current-pane)`. Returns nil.
    'delete-pane!': (args) => {
      const pane = resolvePaneArg(args, paneHost);
      if (pane === null) return NIL;
      paneHost.deletePane(pane);
      return NIL;
    },
    // `(delete-other-panes! [pane])` — make PANE fill the whole editor
    // area, disposing every other leaf. PANE defaults to `(current-pane)`.
    // Returns nil.
    'delete-other-panes!': (args) => {
      const pane = resolvePaneArg(args, paneHost);
      if (pane === null) return NIL;
      paneHost.deleteOtherPanes(pane);
      return NIL;
    },
    // `(other-pane)` — cycle focus to the next leaf in display order
    // (depth-first). Returns the new current pane handle, or nil when
    // there's only one pane.
    'other-pane': () => {
      const pane = paneHost.otherPane();
      return pane ?? NIL;
    },
    // `(focus-pane-direction! direction)` — focus the leaf adjacent to
    // the current one in DIRECTION (a symbol or string: 'left', 'right',
    // 'up', 'down'). Returns the new current pane handle, or nil when
    // there's no neighbour in that direction.
    'focus-pane-direction!': (args) => {
      const raw = args[0];
      let direction;
      if (typeof raw === 'string') direction = raw;
      else if (raw && typeof raw === 'object' && typeof raw.name === 'string') {
        direction = raw.name; // a Sym
      } else direction = null;
      if (
        direction !== 'left' &&
        direction !== 'right' &&
        direction !== 'up' &&
        direction !== 'down'
      ) {
        return NIL;
      }
      const pane = paneHost.focusPaneDirection(direction);
      return pane ?? NIL;
    },
    // `(balance-panes!)` — reset every split node's ratio to 0.5.
    // Returns nil.
    'balance-panes!': () => {
      paneHost.balancePanes();
      return NIL;
    },
    // `(set-split-ratio! pane ratio)` — set PANE's ratio (PANE must be
    // a split node). The value is clamped to `[0.05, 0.95]`. Returns
    // nil.
    'set-split-ratio!': (args) => {
      const pane = args[0];
      const ratio = args[1];
      if (
        pane === null || pane === undefined || pane === NIL ||
        typeof pane !== 'object' || pane.kind !== 'split'
      ) {
        return NIL;
      }
      paneHost.setSplitRatio(pane, clampRatio(Number(ratio)));
      return NIL;
    },
  };
}

/**
 * @typedef {import('@editor/pane').Pane} Pane
 *
 * @typedef {object} PaneHost
 * @property {() => (Pane | null)} currentPane - The currently-focused
 *   pane handle (a leaf), or null.
 * @property {(pane: Pane, ratio: number) => ({first: Pane, second: Pane} | null)} [splitHorizontal]
 * @property {(pane: Pane, ratio: number) => ({first: Pane, second: Pane} | null)} [splitVertical]
 * @property {(pane: Pane) => void} [deletePane]
 * @property {(pane: Pane) => void} [deleteOtherPanes]
 * @property {() => (Pane | null)} [otherPane]
 * @property {(direction: 'left'|'right'|'up'|'down') => (Pane | null)} [focusPaneDirection]
 * @property {() => void} [balancePanes]
 * @property {(pane: Pane, ratio: number) => void} [setSplitRatio]
 */
