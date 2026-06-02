import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLeafPane,
  createSplitPane,
  isPane,
  isLeafPane,
  isSplitPane,
  leafPanes,
  findPane,
  findPaneById,
  findLeafByViewId,
  replacePane,
  containsPane,
  leafCount,
  parentOf,
  siblingOf,
  computeRects,
  splitRect,
  computeSplitterEdges,
  paneInDirection,
  insertAtSplit,
  insertAtRootBorder,
  swapLeaves,
  permuteLeaves,
  spiralOrder,
  PANE_KIND_LEAF,
  PANE_KIND_SPLIT,
  SPLIT_HORIZONTAL,
  SPLIT_VERTICAL,
} from '../src/index.js';

// --- constructors -----------------------------------------------------------

test('createLeafPane: returns a leaf with a fresh id and the given view', () => {
  const view = { kind: 'text', name: 'foo.txt' };
  const pane = createLeafPane({ view });
  assert.equal(pane.kind, PANE_KIND_LEAF);
  assert.equal(pane.view, view);
  assert.ok(pane.id.startsWith('pane-leaf-'));
});

test('createLeafPane: a fresh leaf with no view is allowed', () => {
  const pane = createLeafPane();
  assert.equal(pane.kind, PANE_KIND_LEAF);
  assert.equal(pane.view, null);
});

test('createLeafPane: explicit id is preserved', () => {
  const pane = createLeafPane({ id: 'p-explicit' });
  assert.equal(pane.id, 'p-explicit');
});

test('createLeafPane: each call gets a unique id', () => {
  const a = createLeafPane();
  const b = createLeafPane();
  assert.notEqual(a.id, b.id);
});

test('createSplitPane: returns a split with the given children + ratio', () => {
  const first = createLeafPane({ view: { kind: 'text', name: 'a' } });
  const second = createLeafPane({ view: { kind: 'text', name: 'b' } });
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first,
    second,
  });
  assert.equal(split.kind, PANE_KIND_SPLIT);
  assert.equal(split.orientation, SPLIT_HORIZONTAL);
  assert.equal(split.ratio, 0.5);
  assert.equal(split.first, first);
  assert.equal(split.second, second);
});

test('createSplitPane: rejects invalid orientation', () => {
  assert.throws(
    () =>
      createSplitPane({
        orientation: 'diagonal',
        ratio: 0.5,
        first: createLeafPane(),
        second: createLeafPane(),
      }),
    /orientation/
  );
});

test('createSplitPane: rejects out-of-range ratio', () => {
  assert.throws(
    () =>
      createSplitPane({
        orientation: SPLIT_VERTICAL,
        ratio: 0,
        first: createLeafPane(),
        second: createLeafPane(),
      }),
    /ratio/
  );
  assert.throws(
    () =>
      createSplitPane({
        orientation: SPLIT_VERTICAL,
        ratio: 1,
        first: createLeafPane(),
        second: createLeafPane(),
      }),
    /ratio/
  );
});

test('createSplitPane: rejects non-pane children', () => {
  assert.throws(
    () =>
      createSplitPane({
        orientation: SPLIT_HORIZONTAL,
        ratio: 0.5,
        first: { foo: 'bar' },
        second: createLeafPane(),
      }),
    /must be panes/
  );
});

// --- predicates -------------------------------------------------------------

test('isPane / isLeafPane / isSplitPane: recognise the right shapes', () => {
  const leaf = createLeafPane();
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: createLeafPane(),
    second: createLeafPane(),
  });
  assert.equal(isPane(leaf), true);
  assert.equal(isPane(split), true);
  assert.equal(isPane({}), false);
  assert.equal(isPane(null), false);

  assert.equal(isLeafPane(leaf), true);
  assert.equal(isLeafPane(split), false);
  assert.equal(isSplitPane(split), true);
  assert.equal(isSplitPane(leaf), false);
});

// --- tree walking -----------------------------------------------------------

test('leafPanes: a single leaf returns itself', () => {
  const leaf = createLeafPane();
  assert.deepEqual(leafPanes(leaf), [leaf]);
});

test('leafPanes: in-order across a split', () => {
  const a = createLeafPane({ view: { kind: 'text', name: 'a' } });
  const b = createLeafPane({ view: { kind: 'text', name: 'b' } });
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: b,
  });
  assert.deepEqual(leafPanes(split), [a, b]);
});

test('leafPanes: nested splits visited depth-first', () => {
  const a = createLeafPane({ view: { kind: 'text', name: 'a' } });
  const b = createLeafPane({ view: { kind: 'text', name: 'b' } });
  const c = createLeafPane({ view: { kind: 'text', name: 'c' } });
  const inner = createSplitPane({
    orientation: SPLIT_VERTICAL,
    ratio: 0.3,
    first: b,
    second: c,
  });
  const root = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: inner,
  });
  assert.deepEqual(leafPanes(root), [a, b, c]);
});

test('findPane: returns the first match by predicate', () => {
  const a = createLeafPane({ view: { kind: 'text', name: 'wanted' } });
  const b = createLeafPane({ view: { kind: 'text', name: 'other' } });
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: b,
  });
  const found = findPane(split, (p) => p.kind === 'leaf' && p.view?.name === 'wanted');
  assert.equal(found, a);
  const missing = findPane(split, () => false);
  assert.equal(missing, null);
});

test('findLeafByViewId: locates a leaf by its view id', () => {
  const view = { id: 'view-1', kind: 'text', name: 'a' };
  const a = createLeafPane({ view });
  const b = createLeafPane({ view: { id: 'view-2', kind: 'text', name: 'b' } });
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: b,
  });
  assert.equal(findLeafByViewId(split, 'view-1'), a);
  assert.equal(findLeafByViewId(split, 'view-missing'), null);
});

test('findPaneById: locates a leaf or split by id', () => {
  const a = createLeafPane({ id: 'p-a' });
  const b = createLeafPane({ id: 'p-b' });
  const split = createSplitPane({
    id: 'p-split',
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: b,
  });
  assert.equal(findPaneById(split, 'p-split'), split);
  assert.equal(findPaneById(split, 'p-a'), a);
  assert.equal(findPaneById(split, 'p-missing'), null);
});

test('containsPane: true if subtree contains target', () => {
  const a = createLeafPane();
  const b = createLeafPane();
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: b,
  });
  assert.equal(containsPane(split, a), true);
  assert.equal(containsPane(split, b), true);
  assert.equal(containsPane(split, split), true);
  assert.equal(containsPane(a, b), false);
});

test('leafCount: counts leaves', () => {
  const leaf = createLeafPane();
  assert.equal(leafCount(leaf), 1);

  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: createLeafPane(),
    second: createSplitPane({
      orientation: SPLIT_VERTICAL,
      ratio: 0.5,
      first: createLeafPane(),
      second: createLeafPane(),
    }),
  });
  assert.equal(leafCount(split), 3);
});

// --- immutable replace ------------------------------------------------------

test('replacePane: root replacement returns the new root', () => {
  const old = createLeafPane();
  const fresh = createLeafPane();
  assert.equal(replacePane(old, old, fresh), fresh);
});

test('replacePane: swap in a subtree, original tree unaffected', () => {
  const a = createLeafPane({ id: 'p-a' });
  const b = createLeafPane({ id: 'p-b' });
  const split = createSplitPane({
    id: 'p-split',
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: b,
  });
  const fresh = createLeafPane({ id: 'p-c' });
  const next = replacePane(split, b, fresh);
  // Original untouched.
  assert.equal(split.second, b);
  // Next has the swap on the second slot, first slot unchanged identity.
  assert.equal(next.kind, 'split');
  assert.equal(next.first, a);
  assert.equal(next.second, fresh);
  // Split node's own ratio / orientation preserved.
  assert.equal(next.orientation, split.orientation);
  assert.equal(next.ratio, split.ratio);
});

test('replacePane: throws when target is not in the tree', () => {
  const a = createLeafPane();
  const b = createLeafPane();
  assert.throws(() => replacePane(a, b, createLeafPane()), /not in tree/);
});

// --- layout math ------------------------------------------------------------

test('computeRects: a single leaf occupies the whole host rect', () => {
  const leaf = createLeafPane({ id: 'only' });
  const rects = computeRects(leaf, { width: 800, height: 600 });
  assert.equal(rects.size, 1);
  assert.deepEqual(rects.get('only'), {
    left: 0,
    top: 0,
    width: 800,
    height: 600,
  });
});

test('computeRects: honours non-zero left/top in the host rect', () => {
  const leaf = createLeafPane({ id: 'only' });
  const rects = computeRects(leaf, { left: 10, top: 20, width: 100, height: 200 });
  assert.deepEqual(rects.get('only'), {
    left: 10,
    top: 20,
    width: 100,
    height: 200,
  });
});

test('computeRects: a 50/50 horizontal split divides evenly', () => {
  const left = createLeafPane({ id: 'p-left' });
  const right = createLeafPane({ id: 'p-right' });
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: left,
    second: right,
  });
  const rects = computeRects(split, { width: 800, height: 600 });
  assert.deepEqual(rects.get('p-left'), {
    left: 0,
    top: 0,
    width: 400,
    height: 600,
  });
  assert.deepEqual(rects.get('p-right'), {
    left: 400,
    top: 0,
    width: 400,
    height: 600,
  });
});

test('computeRects: 0.3/0.7 vertical split rounds + complements', () => {
  const top = createLeafPane({ id: 'p-top' });
  const bottom = createLeafPane({ id: 'p-bottom' });
  const split = createSplitPane({
    orientation: SPLIT_VERTICAL,
    ratio: 0.3,
    first: top,
    second: bottom,
  });
  const rects = computeRects(split, { width: 800, height: 601 });
  const t = rects.get('p-top');
  const b = rects.get('p-bottom');
  // Rounding: 0.3 * 601 = 180.3 → 180.
  assert.equal(t.top, 0);
  assert.equal(t.height, 180);
  // Complement: bottom fills the rest exactly.
  assert.equal(b.top, 180);
  assert.equal(b.height, 421);
  // Together they cover the host rect without a gap.
  assert.equal(t.top + t.height, b.top);
  assert.equal(t.height + b.height, 601);
});

test('computeRects: nested splits compose cleanly', () => {
  // Layout:
  //   horizontal 0.5
  //     left:  leaf-a (one whole column)
  //     right: vertical 0.5
  //       top:    leaf-b
  //       bottom: leaf-c
  const a = createLeafPane({ id: 'p-a' });
  const b = createLeafPane({ id: 'p-b' });
  const c = createLeafPane({ id: 'p-c' });
  const right = createSplitPane({
    orientation: SPLIT_VERTICAL,
    ratio: 0.5,
    first: b,
    second: c,
  });
  const root = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: right,
  });
  const rects = computeRects(root, { width: 800, height: 600 });
  assert.deepEqual(rects.get('p-a'), { left: 0, top: 0, width: 400, height: 600 });
  assert.deepEqual(rects.get('p-b'), { left: 400, top: 0, width: 400, height: 300 });
  assert.deepEqual(rects.get('p-c'), {
    left: 400,
    top: 300,
    width: 400,
    height: 300,
  });
});

test('computeRects: tolerates a zero-sized host rect (no entries crash)', () => {
  const leaf = createLeafPane({ id: 'only' });
  const rects = computeRects(leaf, { width: 0, height: 0 });
  assert.deepEqual(rects.get('only'), {
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
});

test('splitRect: same arithmetic as computeRects but stand-alone', () => {
  const [first, second] = splitRect(
    { left: 0, top: 0, width: 100, height: 100 },
    SPLIT_HORIZONTAL,
    0.4
  );
  assert.deepEqual(first, { left: 0, top: 0, width: 40, height: 100 });
  assert.deepEqual(second, { left: 40, top: 0, width: 60, height: 100 });
});

// --- parentOf / siblingOf ---------------------------------------------------

test('parentOf: root has no parent', () => {
  const leaf = createLeafPane();
  assert.equal(parentOf(leaf, leaf), null);
});

test('parentOf: returns the split node holding the child', () => {
  const a = createLeafPane({ id: 'p-a' });
  const b = createLeafPane({ id: 'p-b' });
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: b,
  });
  assert.equal(parentOf(split, a), split);
  assert.equal(parentOf(split, b), split);
});

test('parentOf: walks through nested splits', () => {
  const a = createLeafPane({ id: 'p-a' });
  const b = createLeafPane({ id: 'p-b' });
  const c = createLeafPane({ id: 'p-c' });
  const inner = createSplitPane({
    orientation: SPLIT_VERTICAL,
    ratio: 0.5,
    first: b,
    second: c,
  });
  const root = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: inner,
  });
  assert.equal(parentOf(root, a), root);
  assert.equal(parentOf(root, inner), root);
  assert.equal(parentOf(root, b), inner);
  assert.equal(parentOf(root, c), inner);
});

test('parentOf: returns null when child is not in the tree', () => {
  const a = createLeafPane();
  const stranger = createLeafPane();
  assert.equal(parentOf(a, stranger), null);
});

test('siblingOf: returns the other child of the parent split', () => {
  const a = createLeafPane({ id: 'p-a' });
  const b = createLeafPane({ id: 'p-b' });
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: b,
  });
  assert.equal(siblingOf(split, a), b);
  assert.equal(siblingOf(split, b), a);
});

test('siblingOf: returns null for the root', () => {
  const leaf = createLeafPane();
  assert.equal(siblingOf(leaf, leaf), null);
});

// --- computeSplitterEdges ---------------------------------------------------

test('computeSplitterEdges: a single leaf has no edges', () => {
  const leaf = createLeafPane({ id: 'only' });
  const edges = computeSplitterEdges(leaf, { width: 800, height: 600 });
  assert.deepEqual(edges, []);
});

test('computeSplitterEdges: a horizontal split yields one vertical handle', () => {
  const left = createLeafPane({ id: 'p-left' });
  const right = createLeafPane({ id: 'p-right' });
  const split = createSplitPane({
    id: 'p-split',
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: left,
    second: right,
  });
  const edges = computeSplitterEdges(split, { width: 800, height: 600 });
  assert.equal(edges.length, 1);
  const edge = edges[0];
  assert.equal(edge.splitId, 'p-split');
  assert.equal(edge.orientation, SPLIT_HORIZONTAL);
  // 4 px wide handle centred on x=400.
  assert.equal(edge.left, 398);
  assert.equal(edge.top, 0);
  assert.equal(edge.width, 4);
  assert.equal(edge.height, 600);
  assert.equal(edge.ratio, 0.5);
  assert.deepEqual(edge.parentRect, { left: 0, top: 0, width: 800, height: 600 });
});

test('computeSplitterEdges: a vertical split yields one horizontal handle', () => {
  const top = createLeafPane({ id: 'p-top' });
  const bottom = createLeafPane({ id: 'p-bottom' });
  const split = createSplitPane({
    id: 'p-split',
    orientation: SPLIT_VERTICAL,
    ratio: 0.3,
    first: top,
    second: bottom,
  });
  const edges = computeSplitterEdges(split, { width: 800, height: 600 });
  assert.equal(edges.length, 1);
  const edge = edges[0];
  assert.equal(edge.orientation, SPLIT_VERTICAL);
  // 0.3 * 600 = 180; 4 px handle centred on y=180.
  assert.equal(edge.top, 178);
  assert.equal(edge.left, 0);
  assert.equal(edge.height, 4);
  assert.equal(edge.width, 800);
});

test('computeSplitterEdges: nested splits emit one edge per split node', () => {
  // horizontal 0.5 (a | inner) ; inner = vertical 0.5 (b / c)
  const a = createLeafPane({ id: 'p-a' });
  const b = createLeafPane({ id: 'p-b' });
  const c = createLeafPane({ id: 'p-c' });
  const inner = createSplitPane({
    id: 'p-inner',
    orientation: SPLIT_VERTICAL,
    ratio: 0.5,
    first: b,
    second: c,
  });
  const root = createSplitPane({
    id: 'p-root',
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: inner,
  });
  const edges = computeSplitterEdges(root, { width: 800, height: 600 });
  assert.equal(edges.length, 2);
  // Root split: vertical handle centred at x=400, full height.
  const root_edge = edges.find((e) => e.splitId === 'p-root');
  assert.equal(root_edge.orientation, SPLIT_HORIZONTAL);
  assert.equal(root_edge.left, 398);
  assert.equal(root_edge.top, 0);
  // Inner split: horizontal handle, sits in the right half only.
  const inner_edge = edges.find((e) => e.splitId === 'p-inner');
  assert.equal(inner_edge.orientation, SPLIT_VERTICAL);
  assert.equal(inner_edge.left, 400);
  assert.equal(inner_edge.width, 400);
  // 0.5 * 600 = 300 → handle centred on y=300.
  assert.equal(inner_edge.top, 298);
  assert.equal(inner_edge.height, 4);
});

test('computeSplitterEdges: thickness option is honoured', () => {
  const a = createLeafPane({ id: 'p-a' });
  const b = createLeafPane({ id: 'p-b' });
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: b,
  });
  const edges = computeSplitterEdges(
    split,
    { width: 800, height: 600 },
    { thickness: 8 }
  );
  assert.equal(edges[0].width, 8);
  // 0.5 * 800 = 400; handle centred on it.
  assert.equal(edges[0].left, 396);
});

// --- paneInDirection --------------------------------------------------------

test('paneInDirection: left/right across a horizontal split', () => {
  // p-left at [0..400], p-right at [400..800].
  const rects = new Map([
    ['p-left', { left: 0, top: 0, width: 400, height: 600 }],
    ['p-right', { left: 400, top: 0, width: 400, height: 600 }],
  ]);
  assert.equal(paneInDirection(rects, 'p-left', 'right'), 'p-right');
  assert.equal(paneInDirection(rects, 'p-right', 'left'), 'p-left');
  assert.equal(paneInDirection(rects, 'p-left', 'left'), null);
  assert.equal(paneInDirection(rects, 'p-right', 'right'), null);
});

test('paneInDirection: up/down across a vertical split', () => {
  const rects = new Map([
    ['p-top', { left: 0, top: 0, width: 800, height: 300 }],
    ['p-bottom', { left: 0, top: 300, width: 800, height: 300 }],
  ]);
  assert.equal(paneInDirection(rects, 'p-top', 'down'), 'p-bottom');
  assert.equal(paneInDirection(rects, 'p-bottom', 'up'), 'p-top');
  assert.equal(paneInDirection(rects, 'p-top', 'up'), null);
});

test('paneInDirection: picks the candidate whose perpendicular centre is closest', () => {
  // a tall pane on the left, abutting two stacked panes on the right.
  // The cursor is on `a`; moving right with the centre near the top
  // should pick the top-right pane.
  const rects = new Map([
    ['p-a', { left: 0, top: 0, width: 400, height: 600 }],
    ['p-b', { left: 400, top: 0, width: 400, height: 300 }],
    ['p-c', { left: 400, top: 300, width: 400, height: 300 }],
  ]);
  // a's vertical centre is y=300, equidistant; the tiebreak picks the
  // first matching candidate. Bias the test by making a shorter.
  const rectsBiased = new Map([
    ['p-a', { left: 0, top: 0, width: 400, height: 200 }],
    ['p-b', { left: 400, top: 0, width: 400, height: 300 }],
    ['p-c', { left: 400, top: 300, width: 400, height: 300 }],
  ]);
  assert.equal(paneInDirection(rectsBiased, 'p-a', 'right'), 'p-b');
  // And the symmetric case: low short pane abutting two stacked.
  const rectsLow = new Map([
    ['p-a', { left: 0, top: 400, width: 400, height: 200 }],
    ['p-b', { left: 400, top: 0, width: 400, height: 300 }],
    ['p-c', { left: 400, top: 300, width: 400, height: 300 }],
  ]);
  assert.equal(paneInDirection(rectsLow, 'p-a', 'right'), 'p-c');
  // Even unused, suppress the "never read" lint by referencing it.
  assert.equal(rects.size, 3);
});

test('paneInDirection: returns null for an unknown current id or direction', () => {
  const rects = new Map([
    ['p-a', { left: 0, top: 0, width: 100, height: 100 }],
  ]);
  assert.equal(paneInDirection(rects, 'no-such-id', 'right'), null);
  assert.equal(paneInDirection(rects, 'p-a', 'diagonal'), null);
});

// --- insertAtSplit / insertAtRootBorder ---------------------------------

test('insertAtSplit: replaces split with outer Split(first, inner Split(NEW, second))', () => {
  const a = createLeafPane({ view: { name: 'a' } });
  const b = createLeafPane({ view: { name: 'b' } });
  const c = createLeafPane({ view: { name: 'c' } });
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: b,
  });
  const newTree = insertAtSplit(split, split, c);
  assert.equal(isSplitPane(newTree), true);
  assert.equal(newTree.orientation, SPLIT_HORIZONTAL);
  assert.equal(newTree.first, a);
  assert.equal(isSplitPane(newTree.second), true);
  assert.equal(newTree.second.orientation, SPLIT_HORIZONTAL);
  assert.equal(newTree.second.first, c);
  assert.equal(newTree.second.second, b);
  // Default ratios produce three equal siblings: outer=1/3, inner=0.5.
  assert.ok(Math.abs(newTree.ratio - 1 / 3) < 1e-9);
  assert.equal(newTree.second.ratio, 0.5);
});

test('insertAtSplit: works on a non-root split deep in the tree', () => {
  const a = createLeafPane();
  const b = createLeafPane();
  const c = createLeafPane();
  const inner = createSplitPane({
    orientation: SPLIT_VERTICAL,
    ratio: 0.5,
    first: a,
    second: b,
  });
  const root = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: createLeafPane(),
    second: inner,
  });
  const newRoot = insertAtSplit(root, inner, c);
  // Root structure is preserved; inner is replaced by the wrapped pair.
  assert.equal(newRoot.kind, 'split');
  assert.equal(newRoot.orientation, SPLIT_HORIZONTAL);
  assert.equal(newRoot.first, root.first);
  const outer = newRoot.second;
  assert.equal(outer.orientation, SPLIT_VERTICAL);
  assert.equal(outer.first, a);
  assert.equal(outer.second.first, c);
  assert.equal(outer.second.second, b);
});

test('insertAtSplit: throws when split is not in the tree', () => {
  const orphan = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: createLeafPane(),
    second: createLeafPane(),
  });
  const root = createLeafPane();
  assert.throws(() => insertAtSplit(root, orphan, createLeafPane()), /not in tree/);
});

test('insertAtSplit: rejects non-split node and non-leaf new pane', () => {
  const leaf = createLeafPane();
  const otherLeaf = createLeafPane();
  assert.throws(() => insertAtSplit(leaf, leaf, otherLeaf), /split/);
  const sp = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: createLeafPane(),
    second: createLeafPane(),
  });
  assert.throws(() => insertAtSplit(sp, sp, sp), /leaf/);
});

test('insertAtRootBorder: bottom wraps root in vertical split with new pane at second', () => {
  const a = createLeafPane({ view: { name: 'a' } });
  const newPane = createLeafPane({ view: { name: 'new' } });
  const tree = insertAtRootBorder(a, 'bottom', newPane);
  assert.equal(tree.kind, 'split');
  assert.equal(tree.orientation, SPLIT_VERTICAL);
  assert.equal(tree.first, a);
  assert.equal(tree.second, newPane);
  assert.ok(Math.abs(tree.ratio - 0.7) < 1e-9);
});

test('insertAtRootBorder: top puts new pane at first with the keep-ratio flipped', () => {
  const a = createLeafPane();
  const newPane = createLeafPane();
  const tree = insertAtRootBorder(a, 'top', newPane);
  assert.equal(tree.orientation, SPLIT_VERTICAL);
  assert.equal(tree.first, newPane);
  assert.equal(tree.second, a);
  assert.ok(Math.abs(tree.ratio - 0.3) < 1e-9);
});

test('insertAtRootBorder: right wraps in horizontal split with new pane at second', () => {
  const a = createLeafPane();
  const newPane = createLeafPane();
  const tree = insertAtRootBorder(a, 'right', newPane);
  assert.equal(tree.orientation, SPLIT_HORIZONTAL);
  assert.equal(tree.first, a);
  assert.equal(tree.second, newPane);
});

test('insertAtRootBorder: left puts new pane at first', () => {
  const a = createLeafPane();
  const newPane = createLeafPane();
  const tree = insertAtRootBorder(a, 'left', newPane);
  assert.equal(tree.orientation, SPLIT_HORIZONTAL);
  assert.equal(tree.first, newPane);
  assert.equal(tree.second, a);
});

test('insertAtRootBorder: works on a non-leaf root (wraps the whole tree)', () => {
  const a = createLeafPane();
  const b = createLeafPane();
  const root = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: a,
    second: b,
  });
  const newPane = createLeafPane();
  const tree = insertAtRootBorder(root, 'bottom', newPane);
  assert.equal(tree.orientation, SPLIT_VERTICAL);
  assert.equal(tree.first, root);
  assert.equal(tree.second, newPane);
  // The inner split is unchanged.
  assert.equal(tree.first.first, a);
  assert.equal(tree.first.second, b);
});

test('insertAtRootBorder: throws on unrecognised side', () => {
  const a = createLeafPane();
  assert.throws(
    () => insertAtRootBorder(a, 'diagonal', createLeafPane()),
    /side must be/
  );
});

test('insertAtRootBorder: rejects non-leaf new pane', () => {
  const a = createLeafPane();
  const sp = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: createLeafPane(),
    second: createLeafPane(),
  });
  assert.throws(() => insertAtRootBorder(a, 'right', sp), /leaf/);
});

// --- swapLeaves / permuteLeaves / spiralOrder -------------------------------
//
// The "move the frames, not the contents" operations for swap-views /
// permute-views (plans/PANES-SWAP-PERMUTE.md). They relocate leaf nodes
// between tree positions while leaving the split structure (ids, ratios,
// orientations) untouched and reusing the leaf objects by identity.

/** A 2x2 grid with stable ids: columns are vertical splits, joined by an
 *  outer horizontal split. Corners (in a square host): TL(0,0) TR(W/2,0)
 *  BL(0,H/2) BR(W/2,H/2). */
function grid2x2() {
  const tl = createLeafPane({ id: 'TL', view: { kind: 'text', name: 'tl' } });
  const tr = createLeafPane({ id: 'TR', view: { kind: 'text', name: 'tr' } });
  const bl = createLeafPane({ id: 'BL', view: { kind: 'text', name: 'bl' } });
  const br = createLeafPane({ id: 'BR', view: { kind: 'text', name: 'br' } });
  const leftCol = createSplitPane({
    orientation: SPLIT_VERTICAL, ratio: 0.5, first: tl, second: bl,
  });
  const rightCol = createSplitPane({
    orientation: SPLIT_VERTICAL, ratio: 0.5, first: tr, second: br,
  });
  const root = createSplitPane({
    orientation: SPLIT_HORIZONTAL, ratio: 0.5, first: leftCol, second: rightCol,
  });
  return { root, tl, tr, bl, br, leftCol, rightCol };
}

/** Every split node's {id, orientation, ratio}, in DFS order. */
function collectSplits(pane, out = []) {
  if (isSplitPane(pane)) {
    out.push({ id: pane.id, orientation: pane.orientation, ratio: pane.ratio });
    collectSplits(pane.first, out);
    collectSplits(pane.second, out);
  }
  return out;
}

const HOST = { width: 100, height: 100 };

test('spiralOrder: single leaf is slot 0', () => {
  const leaf = createLeafPane({ id: 'only', view: {} });
  const { ordered, indexByLeaf } = spiralOrder(leaf, { width: 80, height: 60 });
  assert.deepEqual(ordered.map((l) => l.id), ['only']);
  assert.equal(indexByLeaf.get(leaf), 0);
});

test('spiralOrder: horizontal split numbers left then right', () => {
  const l = createLeafPane({ id: 'L', view: {} });
  const r = createLeafPane({ id: 'R', view: {} });
  const root = createSplitPane({
    orientation: SPLIT_HORIZONTAL, ratio: 0.5, first: l, second: r,
  });
  assert.deepEqual(spiralOrder(root, HOST).ordered.map((x) => x.id), ['L', 'R']);
});

test('spiralOrder: vertical split numbers top then bottom', () => {
  const t = createLeafPane({ id: 'T', view: {} });
  const b = createLeafPane({ id: 'B', view: {} });
  const root = createSplitPane({
    orientation: SPLIT_VERTICAL, ratio: 0.5, first: t, second: b,
  });
  assert.deepEqual(spiralOrder(root, HOST).ordered.map((x) => x.id), ['T', 'B']);
});

test('spiralOrder: 2x2 grid numbers clockwise TL→TR→BR→BL', () => {
  const { root } = grid2x2();
  assert.deepEqual(
    spiralOrder(root, HOST).ordered.map((l) => l.id),
    ['TL', 'TR', 'BR', 'BL']
  );
});

test('spiralOrder: tall-left + stacked-right numbers L, TR, BR', () => {
  const left = createLeafPane({ id: 'L', view: {} });
  const tr = createLeafPane({ id: 'TR', view: {} });
  const br = createLeafPane({ id: 'BR', view: {} });
  const rightCol = createSplitPane({
    orientation: SPLIT_VERTICAL, ratio: 0.5, first: tr, second: br,
  });
  const root = createSplitPane({
    orientation: SPLIT_HORIZONTAL, ratio: 0.5, first: left, second: rightCol,
  });
  assert.deepEqual(
    spiralOrder(root, HOST).ordered.map((x) => x.id),
    ['L', 'TR', 'BR']
  );
});

test('swapLeaves: the two leaves exchange rects; structure + identity kept', () => {
  const { root, tl, br } = grid2x2();
  const before = computeRects(root, HOST);
  const swapped = swapLeaves(root, tl, br);
  const after = computeRects(swapped, HOST);
  // TL now occupies BR's old rect and vice versa…
  assert.deepEqual(after.get('TL'), before.get('BR'));
  assert.deepEqual(after.get('BR'), before.get('TL'));
  // …untouched leaves keep their rects.
  assert.deepEqual(after.get('TR'), before.get('TR'));
  assert.deepEqual(after.get('BL'), before.get('BL'));
  // Leaf node objects are reused by identity.
  assert.equal(findPaneById(swapped, 'TL'), tl);
  assert.equal(findPaneById(swapped, 'BR'), br);
  assert.equal(leafCount(swapped), 4);
});

test('swapLeaves: split structure (ids, ratios, orientations) is preserved', () => {
  const { root, tl, tr } = grid2x2();
  const swapped = swapLeaves(root, tl, tr);
  assert.deepEqual(collectSplits(swapped), collectSplits(root));
});

test('swapLeaves: swapping a leaf with itself returns the tree unchanged', () => {
  const { root, tl } = grid2x2();
  assert.equal(swapLeaves(root, tl, tl), root);
});

test('swapLeaves: throws when a leaf is not in the tree', () => {
  const { root, tl } = grid2x2();
  const alien = createLeafPane({ id: 'alien', view: {} });
  assert.throws(() => swapLeaves(root, tl, alien), /not in tree/);
});

test('swapLeaves: throws when a target is not a leaf', () => {
  const { root, tl, leftCol } = grid2x2();
  assert.throws(() => swapLeaves(root, tl, leftCol), /leaf/);
});

test('permuteLeaves: identity permutation preserves leaf positions', () => {
  const { root } = grid2x2();
  const leaves = leafPanes(root);
  const slotByLeaf = new Map(leaves.map((l, i) => [l, i]));
  const result = permuteLeaves(root, slotByLeaf, leaves.slice());
  assert.deepEqual(
    leafPanes(result).map((l) => l.id),
    leaves.map((l) => l.id)
  );
});

test('permuteLeaves: a transposition equals swapLeaves', () => {
  const a = grid2x2();
  const b = grid2x2();
  const leaves = leafPanes(a.root);
  const slotByLeaf = new Map(leaves.map((l, i) => [l, i]));
  const occ = leaves.slice();
  occ[slotByLeaf.get(a.tl)] = a.br;
  occ[slotByLeaf.get(a.br)] = a.tl;
  const viaPermute = computeRects(permuteLeaves(a.root, slotByLeaf, occ), HOST);
  const viaSwap = computeRects(swapLeaves(b.root, b.tl, b.br), HOST);
  for (const id of ['TL', 'TR', 'BL', 'BR']) {
    assert.deepEqual(viaPermute.get(id), viaSwap.get(id));
  }
});

test('permuteLeaves: applying a permutation then its inverse restores it', () => {
  const { root } = grid2x2();
  const host = { width: 120, height: 90 };
  const before = computeRects(root, host);
  const leaves = leafPanes(root);
  const slotByLeaf = new Map(leaves.map((l, i) => [l, i]));
  // Rotate: position p receives the next leaf.
  const occ = leaves.map((_, i) => leaves[(i + 1) % leaves.length]);
  const rotated = permuteLeaves(root, slotByLeaf, occ);
  // Invert against the rotated tree's own positions.
  const slotByLeaf2 = new Map(leafPanes(rotated).map((l, i) => [l, i]));
  const restored = permuteLeaves(rotated, slotByLeaf2, leaves.slice());
  const after = computeRects(restored, host);
  for (const id of ['TL', 'TR', 'BL', 'BR']) {
    assert.deepEqual(after.get(id), before.get(id));
  }
});

test('permuteLeaves: throws when occupant table is not a bijection', () => {
  const { root } = grid2x2();
  const leaves = leafPanes(root);
  const slotByLeaf = new Map(leaves.map((l, i) => [l, i]));
  const dup = leaves.slice();
  dup[1] = dup[0]; // duplicate one leaf, drop another
  assert.throws(() => permuteLeaves(root, slotByLeaf, dup), /bijection/);
  assert.throws(
    () => permuteLeaves(root, slotByLeaf, leaves.slice(0, 3)),
    /exactly once/
  );
});
