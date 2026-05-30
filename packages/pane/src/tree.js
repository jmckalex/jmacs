/**
 * @file Tree walking helpers for the pane tree.
 *
 * The pane tree is immutable from the perspective of these helpers:
 * `replacePane` returns a new tree with one node swapped; the original
 * is untouched. (The leaf-pane records themselves remain mutable — the
 * desktop app may mutate `leaf.view` in place when a view switch lands.)
 *
 * Phase 2 only exercises the one-leaf case in production, but the
 * helpers are written for the general tree because phase 3's splits
 * land on the same machinery.
 */

import { isLeafPane, isSplitPane, createSplitPane } from './pane.js';

/**
 * Yield every leaf pane in display order (depth-first, first-then-second).
 *
 * @param {import('./pane.js').Pane} pane
 * @returns {import('./pane.js').LeafPane[]}
 */
export function leafPanes(pane) {
  const out = [];
  collectLeaves(pane, out);
  return out;
}

function collectLeaves(pane, out) {
  if (isLeafPane(pane)) {
    out.push(pane);
    return;
  }
  if (isSplitPane(pane)) {
    collectLeaves(pane.first, out);
    collectLeaves(pane.second, out);
  }
}

/**
 * Find the first pane (leaf or split) in PANE for which PREDICATE
 * returns true. Returns `null` when none matches.
 *
 * @param {import('./pane.js').Pane} pane
 * @param {(p: import('./pane.js').Pane) => boolean} predicate
 * @returns {import('./pane.js').Pane | null}
 */
export function findPane(pane, predicate) {
  if (predicate(pane)) return pane;
  if (isSplitPane(pane)) {
    const first = findPane(pane.first, predicate);
    if (first !== null) return first;
    return findPane(pane.second, predicate);
  }
  return null;
}

/**
 * Find the (first) leaf in PANE whose view's id equals VIEW_ID, or `null`.
 *
 * Useful for "is this view visible somewhere?" lookups.
 *
 * @param {import('./pane.js').Pane} pane
 * @param {string} viewId
 * @returns {import('./pane.js').LeafPane | null}
 */
export function findLeafByViewId(pane, viewId) {
  for (const leaf of leafPanes(pane)) {
    if (leaf.view && leaf.view.id === viewId) return leaf;
  }
  return null;
}

/**
 * Find a pane by its id. Returns `null` when no node matches.
 *
 * @param {import('./pane.js').Pane} pane
 * @param {string} id
 * @returns {import('./pane.js').Pane | null}
 */
export function findPaneById(pane, id) {
  return findPane(pane, (p) => p.id === id);
}

/**
 * Return a new pane tree with TARGET swapped out for REPLACEMENT. The
 * original tree is untouched; split nodes on the path are re-created so
 * structural sharing along the unaffected side is preserved.
 *
 * Throws when TARGET is not in the tree.
 *
 * @param {import('./pane.js').Pane} root
 * @param {import('./pane.js').Pane} target
 * @param {import('./pane.js').Pane} replacement
 * @returns {import('./pane.js').Pane}
 */
export function replacePane(root, target, replacement) {
  if (root === target) return replacement;
  if (isSplitPane(root)) {
    if (containsPane(root.first, target)) {
      return createSplitPane({
        id: root.id,
        orientation: root.orientation,
        ratio: root.ratio,
        first: replacePane(root.first, target, replacement),
        second: root.second,
      });
    }
    if (containsPane(root.second, target)) {
      return createSplitPane({
        id: root.id,
        orientation: root.orientation,
        ratio: root.ratio,
        first: root.first,
        second: replacePane(root.second, target, replacement),
      });
    }
  }
  throw new Error(`replacePane: target ${target?.id ?? '?'} not in tree`);
}

/**
 * Whether PANE contains TARGET somewhere in its subtree (including
 * itself).
 *
 * @param {import('./pane.js').Pane} pane
 * @param {import('./pane.js').Pane} target
 * @returns {boolean}
 */
export function containsPane(pane, target) {
  if (pane === target) return true;
  if (isSplitPane(pane)) {
    return containsPane(pane.first, target) || containsPane(pane.second, target);
  }
  return false;
}

/**
 * Count the leaves in PANE.
 *
 * @param {import('./pane.js').Pane} pane
 * @returns {number}
 */
export function leafCount(pane) {
  return leafPanes(pane).length;
}

/**
 * Return the split node in ROOT whose `first` or `second` slot is CHILD,
 * or `null` when CHILD is the root (or not in the tree).
 *
 * @param {import('./pane.js').Pane} root
 * @param {import('./pane.js').Pane} child
 * @returns {import('./pane.js').SplitPane | null}
 */
export function parentOf(root, child) {
  if (root === child) return null;
  if (isSplitPane(root)) {
    if (root.first === child || root.second === child) return root;
    return parentOf(root.first, child) ?? parentOf(root.second, child);
  }
  return null;
}

/**
 * Return the sibling subtree of CHILD within ROOT (the *other* child of
 * CHILD's parent split node), or `null` when CHILD is the root or not in
 * the tree.
 *
 * @param {import('./pane.js').Pane} root
 * @param {import('./pane.js').Pane} child
 * @returns {import('./pane.js').Pane | null}
 */
export function siblingOf(root, child) {
  const parent = parentOf(root, child);
  if (parent === null) return null;
  return parent.first === child ? parent.second : parent.first;
}

/**
 * Insert NEW_LEAF "in the gap" between SPLIT's two children. Replaces
 * the split node with an outer split whose first child is the original
 * `first` and whose second child is a new inner split that nests
 * NEW_LEAF next to the original `second`. The outer ratio defaults to
 * `1/3` (the original `first` takes a third); the inner ratio defaults
 * to `0.5` (NEW_LEAF and the original `second` share the remaining
 * two-thirds evenly). End effect: three equal-sized siblings along the
 * split's axis.
 *
 * Both new split nodes keep the orientation of the original — the new
 * leaf sits at the same boundary, just one node deeper.
 *
 * Throws when SPLIT is not in ROOT or isn't a split node.
 *
 * @param {import('./pane.js').Pane} root
 * @param {import('./pane.js').SplitPane} split
 * @param {import('./pane.js').LeafPane} newLeaf
 * @param {object} [options]
 * @param {number} [options.outerRatio=1/3]
 * @param {number} [options.innerRatio=0.5]
 * @returns {import('./pane.js').Pane}
 */
export function insertAtSplit(root, split, newLeaf, options = {}) {
  if (!isSplitPane(split)) {
    throw new TypeError('insertAtSplit: split must be a split pane');
  }
  if (!isLeafPane(newLeaf)) {
    throw new TypeError('insertAtSplit: newLeaf must be a leaf pane');
  }
  const outerRatio = clampInsertRatio(options.outerRatio, 1 / 3);
  const innerRatio = clampInsertRatio(options.innerRatio, 0.5);
  const inner = createSplitPane({
    orientation: split.orientation,
    ratio: innerRatio,
    first: newLeaf,
    second: split.second,
  });
  const outer = createSplitPane({
    orientation: split.orientation,
    ratio: outerRatio,
    first: split.first,
    second: inner,
  });
  return replacePane(root, split, outer);
}

/**
 * Insert NEW_LEAF on the given SIDE of ROOT — wrap ROOT in a fresh
 * outer split node, with NEW_LEAF as the sibling on that side. The
 * new pane occupies `1 - keepRatio` of the area (default 30%) so the
 * existing layout stays mostly intact.
 *
 * @param {import('./pane.js').Pane} root
 * @param {'top'|'bottom'|'left'|'right'} side
 * @param {import('./pane.js').LeafPane} newLeaf
 * @param {object} [options]
 * @param {number} [options.keepRatio=0.7] - Fraction of the wrapped
 *   area the existing root takes. The new leaf gets `1 - keepRatio`.
 * @returns {import('./pane.js').Pane}
 */
export function insertAtRootBorder(root, side, newLeaf, options = {}) {
  if (!isLeafPane(newLeaf)) {
    throw new TypeError('insertAtRootBorder: newLeaf must be a leaf pane');
  }
  const keepRatio = clampInsertRatio(options.keepRatio, 0.7);
  const newRatio = clampInsertRatio(1 - keepRatio, 0.3);
  // Horizontal: side-by-side; vertical: top-and-bottom.
  switch (side) {
    case 'right':
      return createSplitPane({
        orientation: 'horizontal',
        ratio: keepRatio,
        first: root,
        second: newLeaf,
      });
    case 'left':
      return createSplitPane({
        orientation: 'horizontal',
        ratio: newRatio,
        first: newLeaf,
        second: root,
      });
    case 'bottom':
      return createSplitPane({
        orientation: 'vertical',
        ratio: keepRatio,
        first: root,
        second: newLeaf,
      });
    case 'top':
      return createSplitPane({
        orientation: 'vertical',
        ratio: newRatio,
        first: newLeaf,
        second: root,
      });
    default:
      throw new TypeError(
        `insertAtRootBorder: side must be top/bottom/left/right (got ${side})`
      );
  }
}

/** Clamp an insertion ratio to a sensible band; fall back to FALLBACK
 *  for non-numeric / out-of-band input. */
function clampInsertRatio(value, fallback) {
  const fb =
    typeof fallback === 'number' && fallback > 0 && fallback < 1
      ? fallback
      : 0.5;
  if (typeof value !== 'number' || Number.isNaN(value)) return fb;
  if (value <= 0.05) return 0.05;
  if (value >= 0.95) return 0.95;
  return value;
}
