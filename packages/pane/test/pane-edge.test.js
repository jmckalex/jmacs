/**
 * @file Edge-case / characterization tests for the pane tree.
 *
 * The existing `pane.test.js` covers the happy paths of every helper.
 * This file targets the corners that are bug-prone in production: the
 * "singleton re-parent" collapse family (delete the last sibling →
 * collapse the parent split), deep structural sharing under `replacePane`,
 * insertion-ratio clamping bands, navigation across asymmetric trees with
 * the real layout math, and the invariants that must hold after *any*
 * tree operation (every split has two children, leaves hold a view, no
 * orphaned/duplicated nodes, leaf count conserved).
 *
 * These are *characterization* tests — they pin what the code actually
 * does today (verified against the running module), so a behaviour change
 * trips them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLeafPane,
  createSplitPane,
  isLeafPane,
  isSplitPane,
  leafPanes,
  leafCount,
  findPane,
  findPaneById,
  findLeafByViewId,
  containsPane,
  replacePane,
  parentOf,
  siblingOf,
  insertAtSplit,
  insertAtRootBorder,
  swapLeaves,
  permuteLeaves,
  computeRects,
  spiralOrder,
  paneInDirection,
  SPLIT_HORIZONTAL,
  SPLIT_VERTICAL,
} from '../src/index.js';

// --- shared fixtures --------------------------------------------------------

let leafSeq = 0;
function leaf(id) {
  leafSeq += 1;
  return createLeafPane({ id: id ?? `L${leafSeq}`, view: { id: `v-${id ?? leafSeq}` } });
}

/** A deep, asymmetric tree:
 *    root  H 0.5  [ A | rightCol ]
 *    rightCol V 1/3 [ B / lower ]
 *    lower V 0.5 [ C / D ]
 *  Four leaves, two levels of nesting on the right only. */
function deepTree() {
  const a = leaf('A');
  const b = leaf('B');
  const c = leaf('C');
  const d = leaf('D');
  const lower = createSplitPane({
    id: 'lower', orientation: SPLIT_VERTICAL, ratio: 0.5, first: c, second: d,
  });
  const rightCol = createSplitPane({
    id: 'rightCol', orientation: SPLIT_VERTICAL, ratio: 1 / 3, first: b, second: lower,
  });
  const root = createSplitPane({
    id: 'root', orientation: SPLIT_HORIZONTAL, ratio: 0.5, first: a, second: rightCol,
  });
  return { root, a, b, c, d, lower, rightCol };
}

/** Assert the structural invariants that must hold for any well-formed
 *  pane tree, then return the leaves so callers can check counts. */
function assertTreeInvariants(root) {
  const seen = new Set();
  (function walk(node) {
    assert.ok(!seen.has(node), `node ${node.id} appears more than once (orphan/dup)`);
    seen.add(node);
    if (isSplitPane(node)) {
      assert.ok(node.first != null, `split ${node.id} missing first child`);
      assert.ok(node.second != null, `split ${node.id} missing second child`);
      assert.notEqual(node.first, node.second, `split ${node.id} has the same node twice`);
      assert.ok(node.ratio > 0 && node.ratio < 1, `split ${node.id} ratio out of (0,1)`);
      walk(node.first);
      walk(node.second);
    } else {
      assert.ok(isLeafPane(node), `node ${node.id} is neither leaf nor split`);
    }
  })(root);
  return leafPanes(root);
}

// --- singleton re-parent / collapse family ----------------------------------
//
// Deleting a leaf in production (`deletePaneInTree` in app.js) collapses
// the leaf's *parent split* into the leaf's *sibling* via
// `replacePane(root, parent, sibling)`. The pane package owns that
// primitive composition; these pin it at the package level.

test('collapse: replacePane(root, parent, sibling) drops the deleted leaf', () => {
  const a = leaf('a');
  const b = leaf('b');
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL, ratio: 0.5, first: a, second: b,
  });
  // Delete `a`: collapse its parent (the root split) into its sibling `b`.
  const parent = parentOf(split, a);
  const sibling = siblingOf(split, a);
  const collapsed = replacePane(split, parent, sibling);
  assert.equal(collapsed, b, 'the split collapses to the surviving sibling');
  assert.equal(leafCount(collapsed), 1);
  assert.equal(parentOf(collapsed, b), null, 'survivor is now the root (no parent)');
});

test('collapse: deleting a leaf deep in the tree re-parents the survivor up one level', () => {
  const { root, c, d, lower, rightCol } = deepTree();
  // Delete C: its parent is `lower`, its sibling is D. Collapse lower→D.
  const parent = parentOf(root, c);
  assert.equal(parent, lower);
  const sibling = siblingOf(root, c);
  assert.equal(sibling, d);
  const next = replacePane(root, parent, sibling);
  // D now sits directly under rightCol's second slot (lower is gone).
  const newRight = next.second;
  assert.equal(newRight.id, rightCol.id);
  assert.equal(newRight.second, d, 'D re-parented up into lower\'s old slot');
  assert.equal(leafCount(next), 3);
  assert.equal(findPaneById(next, 'lower'), null, 'the collapsed split is gone');
  assertTreeInvariants(next);
});

test('collapse: a 2-leaf split collapsing to its sibling leaves a single-leaf tree', () => {
  const a = leaf('a');
  const b = leaf('b');
  const root = createSplitPane({
    orientation: SPLIT_VERTICAL, ratio: 0.4, first: a, second: b,
  });
  // Survivor when `b` is deleted is `a`; the tree becomes just `a`.
  const collapsed = replacePane(root, parentOf(root, b), siblingOf(root, b));
  assert.equal(collapsed, a);
  assert.deepEqual(leafPanes(collapsed), [a]);
  assertTreeInvariants(collapsed);
});

test('collapse: survivor sibling can itself be a split (re-parents a whole subtree)', () => {
  const { root, a, rightCol } = deepTree();
  // Delete A (the root's first child). Sibling is the whole rightCol
  // subtree, which becomes the new root, intact.
  const collapsed = replacePane(root, parentOf(root, a), siblingOf(root, a));
  assert.equal(collapsed, rightCol, 'the entire sibling subtree becomes the root');
  assert.equal(leafCount(collapsed), 3);
  assertTreeInvariants(collapsed);
});

// --- replacePane: deep structural sharing + immutability --------------------

test('replacePane: untouched sibling subtree is shared by identity; rebuilt path is not', () => {
  const { root, a, c, d, lower, rightCol } = deepTree();
  const fresh = leaf('fresh');
  const next = replacePane(root, c, fresh);
  // Untouched first child (A) of the root is reused by identity.
  assert.equal(next.first, a);
  // The path from root down to the swap is freshly recreated.
  assert.notEqual(next, root);
  assert.notEqual(next.second, rightCol);
  assert.notEqual(next.second.second, lower);
  // The swap landed; D (the untouched sibling of C) is still shared.
  assert.equal(next.second.second.first, fresh);
  assert.equal(next.second.second.second, d);
  // Recreated split nodes preserve id/orientation/ratio.
  assert.equal(next.second.id, rightCol.id);
  assert.equal(next.second.ratio, rightCol.ratio);
  assert.equal(next.second.second.orientation, lower.orientation);
});

test('replacePane: the input tree is structurally unmutated', () => {
  const { root, c, lower } = deepTree();
  const before = leafPanes(root).map((l) => l.id);
  replacePane(root, c, leaf('fresh'));
  // Original still references its original leaves and split nodes.
  assert.deepEqual(leafPanes(root).map((l) => l.id), before);
  assert.equal(lower.first, c, 'original lower split still points at the original C');
});

test('replacePane: root===target works for a split replacement, not just a leaf', () => {
  const onlyLeaf = leaf('only');
  const replacement = createSplitPane({
    orientation: SPLIT_HORIZONTAL, ratio: 0.5, first: leaf('x'), second: leaf('y'),
  });
  assert.equal(replacePane(onlyLeaf, onlyLeaf, replacement), replacement);
});

test('replacePane: throws when target is absent from a deep tree', () => {
  const { root } = deepTree();
  const stranger = leaf('stranger');
  assert.throws(() => replacePane(root, stranger, leaf('z')), /not in tree/);
});

// --- finders / relations at depth -------------------------------------------

test('parentOf / siblingOf reach the deepest leaves', () => {
  const { root, c, d, lower } = deepTree();
  assert.equal(parentOf(root, c), lower);
  assert.equal(parentOf(root, d), lower);
  assert.equal(siblingOf(root, c), d);
  assert.equal(siblingOf(root, d), c);
});

test('findPane / findLeafByViewId / containsPane operate at depth', () => {
  const { root, c, d } = deepTree();
  assert.equal(findPane(root, (p) => p.id === 'C'), c);
  assert.equal(findLeafByViewId(root, 'v-D'), d);
  assert.equal(containsPane(root, c), true);
  assert.equal(containsPane(root, leaf('outsider')), false);
});

// --- insertion ratio clamping bands -----------------------------------------

test('insertAtSplit: out-of-band ratios clamp to the [0.05, 0.95] band', () => {
  const a = leaf('a');
  const b = leaf('b');
  const sp = createSplitPane({
    orientation: SPLIT_HORIZONTAL, ratio: 0.5, first: a, second: b,
  });
  const r = insertAtSplit(sp, sp, leaf('c'), { outerRatio: 0.001, innerRatio: 0.999 });
  assert.equal(r.ratio, 0.05, 'too-small outer clamps up to 0.05');
  assert.equal(r.second.ratio, 0.95, 'too-large inner clamps down to 0.95');
});

test('insertAtSplit: a non-numeric ratio falls back to the default, not the band edge', () => {
  const a = leaf('a');
  const b = leaf('b');
  const sp = createSplitPane({
    orientation: SPLIT_HORIZONTAL, ratio: 0.5, first: a, second: b,
  });
  const r = insertAtSplit(sp, sp, leaf('c'), { outerRatio: 'nope', innerRatio: NaN });
  assert.ok(Math.abs(r.ratio - 1 / 3) < 1e-9, 'non-number outer → default 1/3');
  assert.equal(r.second.ratio, 0.5, 'NaN inner → default 0.5');
});

test('insertAtSplit: a boundary value of exactly 0.05 is preserved as-is', () => {
  const a = leaf('a');
  const b = leaf('b');
  const sp = createSplitPane({
    orientation: SPLIT_HORIZONTAL, ratio: 0.5, first: a, second: b,
  });
  const r = insertAtSplit(sp, sp, leaf('c'), { outerRatio: 0.05 });
  assert.equal(r.ratio, 0.05);
});

test('insertAtRootBorder: keepRatio clamps; an out-of-band NUMBER clamps (not falls back)', () => {
  const a = leaf('a');
  // 0.99 is a valid number above the band → clamps to 0.95.
  const high = insertAtRootBorder(a, 'right', leaf('n'), { keepRatio: 0.99 });
  assert.equal(high.ratio, 0.95);
  // 2 is out of range but still a number → clamps to 0.95 (NOT the 0.7 default).
  const huge = insertAtRootBorder(a, 'right', leaf('n2'), { keepRatio: 2 });
  assert.equal(huge.ratio, 0.95);
  // Only a non-number / NaN triggers the 0.7 fallback.
  const fallback = insertAtRootBorder(a, 'right', leaf('n3'), { keepRatio: 'x' });
  assert.ok(Math.abs(fallback.ratio - 0.7) < 1e-9);
});

// --- structural invariants after operations ---------------------------------

test('insertAtSplit preserves invariants and grows the leaf count by one', () => {
  const { root, rightCol } = deepTree();
  const before = leafCount(root);
  const next = insertAtSplit(root, rightCol, leaf('new'));
  const leaves = assertTreeInvariants(next);
  assert.equal(leaves.length, before + 1);
});

test('insertAtRootBorder preserves invariants and wraps the whole tree', () => {
  const { root } = deepTree();
  const before = leafCount(root);
  const next = insertAtRootBorder(root, 'bottom', leaf('dock'));
  const leaves = assertTreeInvariants(next);
  assert.equal(leaves.length, before + 1);
  assert.equal(next.first, root, 'the original tree is wrapped intact as the first child');
});

test('swapLeaves preserves invariants, leaf identities, and split structure', () => {
  const { root, a, d } = deepTree();
  const swapped = swapLeaves(root, a, d);
  const leaves = assertTreeInvariants(swapped);
  assert.equal(leaves.length, 4);
  // Both leaf objects survive somewhere in the tree, by identity.
  assert.ok(leaves.includes(a) && leaves.includes(d));
  // Their on-screen positions exchanged.
  const before = computeRects(root, { width: 600, height: 600 });
  const after = computeRects(swapped, { width: 600, height: 600 });
  assert.deepEqual(after.get('A'), before.get('D'));
  assert.deepEqual(after.get('D'), before.get('A'));
});

test('permuteLeaves: a full rotation preserves invariants and conserves leaves', () => {
  const { root } = deepTree();
  const leaves = leafPanes(root);
  const slotByLeaf = new Map(leaves.map((l, i) => [l, i]));
  const occ = leaves.map((_, i) => leaves[(i + 1) % leaves.length]);
  const rotated = permuteLeaves(root, slotByLeaf, occ);
  const out = assertTreeInvariants(rotated);
  assert.equal(out.length, 4);
  // Same set of leaf objects, possibly reordered.
  assert.deepEqual(new Set(out), new Set(leaves));
});

// --- navigation across the deep asymmetric tree, via the real layout --------

test('paneInDirection: moving across an asymmetric tree picks the closest-centre neighbour', () => {
  const { root } = deepTree();
  const rects = computeRects(root, { width: 600, height: 600 });
  // A is the tall left column [0..300]x[0..600], centre y=300.
  // Right column rows: B [0..200], C [200..400], D [400..600].
  // Moving right from A should land on C (its band straddles y=300).
  assert.equal(paneInDirection(rects, 'A', 'right'), 'C');
  // From any right leaf, left lands back on A.
  assert.equal(paneInDirection(rects, 'B', 'left'), 'A');
  assert.equal(paneInDirection(rects, 'C', 'left'), 'A');
  // Vertical moves within the right column.
  assert.equal(paneInDirection(rects, 'C', 'up'), 'B');
  assert.equal(paneInDirection(rects, 'C', 'down'), 'D');
});

test('paneInDirection: no wrap-around — edges return null', () => {
  const { root } = deepTree();
  const rects = computeRects(root, { width: 600, height: 600 });
  assert.equal(paneInDirection(rects, 'A', 'left'), null, 'left edge has no left neighbour');
  assert.equal(paneInDirection(rects, 'A', 'up'), null, 'tall A spans full height: no up');
  assert.equal(paneInDirection(rects, 'B', 'up'), null, 'B is the top-right: no up');
  assert.equal(paneInDirection(rects, 'D', 'down'), null, 'D is the bottom-right: no down');
});

test('paneInDirection: corner-only contact is not adjacency', () => {
  // Three panes; `a` (top-left) shares only a single corner with `c`
  // (bottom-right of the lower-left), so moving right from `a` must pick
  // `b` (the genuine edge-sharing neighbour), never the diagonal.
  const rects = new Map([
    ['a', { left: 0, top: 0, width: 50, height: 50 }],
    ['b', { left: 50, top: 0, width: 50, height: 50 }],
    ['diag', { left: 50, top: 50, width: 50, height: 50 }],
  ]);
  assert.equal(paneInDirection(rects, 'a', 'right'), 'b');
  assert.equal(paneInDirection(rects, 'a', 'down'), null, 'a has no edge-sharing pane below it');
});

// --- spiralOrder degenerate hosts -------------------------------------------

test('spiralOrder: a zero-size host still yields a total order over the leaves', () => {
  const a = leaf('A');
  const b = leaf('B');
  const root = createSplitPane({
    orientation: SPLIT_HORIZONTAL, ratio: 0.5, first: a, second: b,
  });
  const { ordered, indexByLeaf } = spiralOrder(root, { width: 0, height: 0 });
  assert.equal(ordered.length, 2);
  // Every leaf has a slot; the inverse map round-trips.
  for (let i = 0; i < ordered.length; i += 1) {
    assert.equal(indexByLeaf.get(ordered[i]), i);
  }
});
