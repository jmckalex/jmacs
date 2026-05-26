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
  computeRects,
  splitRect,
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
