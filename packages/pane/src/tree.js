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
