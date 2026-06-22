/**
 * @file Tests for the multi-pane CLIENT layout (pane-client-layout.js, G0a).
 *
 * These prove the client's pixel half: a PANE_TREE wire snapshot + the
 * client's OWN host rectangle → per-leaf pixel rects (via the same pure
 * computeRects math), splitter handles, and the mount/unmount/keep diff a
 * renderer applies to its createEditorView instances. The point: the geometry
 * separates cleanly — every pixel is derived client-side from the wire ratios
 * + the client's rect; nothing pixel crosses the wire. node --test, no screen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  layoutPaneTree,
  diffPaneLeaves,
  wireTreeToLayoutTree,
} from './pane-client-layout.js';
import { createPaneModel } from './pane-model.js';

/** A pane model + its current PANE_TREE snapshot, for end-to-end layout. */
function snap(buildFn) {
  const model = createPaneModel(
    { initialBufferId: 'b1' },
    { nameForBuffer: (id) => `name-of-${id}` }
  );
  if (buildFn) buildFn(model);
  return model.snapshot();
}

test('a single-leaf tree lays out to the whole host rect', () => {
  const tree = snap();
  const { leafRects, splitters, focusedId } = layoutPaneTree(tree, {
    width: 800, height: 600,
  });
  assert.equal(leafRects.size, 1);
  const rect = [...leafRects.values()][0];
  assert.deepEqual(rect, { left: 0, top: 0, width: 800, height: 600 });
  assert.equal(splitters.length, 0); // no split → no splitter
  assert.equal(focusedId, tree.id);
});

test('a vertical split lays out top/bottom, pixel-perfect (no gap, no overlap)', () => {
  const tree = snap((m) => m.split('vertical', 0.5));
  const { leafRects } = layoutPaneTree(tree, { width: 800, height: 600 });
  assert.equal(leafRects.size, 2);
  const [topId, bottomId] = [tree.first.id, tree.second.id];
  const top = leafRects.get(topId);
  const bottom = leafRects.get(bottomId);
  // Top fills the upper half, bottom the lower; they tile the host exactly.
  assert.equal(top.top, 0);
  assert.equal(top.height, 300);
  assert.equal(bottom.top, 300);
  assert.equal(bottom.height, 300);
  assert.equal(top.top + top.height, bottom.top); // adjacent, no gap/overlap
  assert.equal(top.width, 800);
  assert.equal(bottom.width, 800);
});

test('a horizontal split lays out left/right and honours the wire ratio', () => {
  const tree = snap((m) => m.split('horizontal', 0.25));
  const { leafRects, splitters } = layoutPaneTree(tree, { width: 1000, height: 400 });
  const left = leafRects.get(tree.first.id);
  const right = leafRects.get(tree.second.id);
  assert.equal(left.width, 250); // 0.25 * 1000
  assert.equal(right.width, 750);
  assert.equal(left.left + left.width, right.left); // adjacent
  // One splitter handle, on the shared vertical edge.
  assert.equal(splitters.length, 1);
  assert.equal(splitters[0].orientation, 'horizontal');
});

test('the SAME client rect drives all the pixels — change the rect, change the layout', () => {
  const tree = snap((m) => m.split('horizontal', 0.5));
  const wide = layoutPaneTree(tree, { width: 1200, height: 300 });
  const narrow = layoutPaneTree(tree, { width: 600, height: 300 });
  // The wire tree is identical; only the client's host rect differs, and that
  // ALONE changes the pixels — the geometry is client-derived, nothing pixel
  // crossed the wire.
  assert.equal(wide.leafRects.get(tree.first.id).width, 600);
  assert.equal(narrow.leafRects.get(tree.first.id).width, 300);
});

test('a 3-pane layout tiles the host with three leaf rects', () => {
  const tree = snap((m) => {
    m.split('vertical', 0.5); // top | bottom, focus bottom
    m.split('horizontal', 0.5); // bottom → bl | br, focus br
  });
  const { leafRects } = layoutPaneTree(tree, { width: 800, height: 600 });
  assert.equal(leafRects.size, 3);
  // The three rects together cover exactly the host area (no overlap/gap).
  const total = [...leafRects.values()].reduce((sum, r) => sum + r.width * r.height, 0);
  assert.equal(total, 800 * 600);
});

test('layoutPaneTree reports the focused leaf id', () => {
  const tree = snap((m) => m.split('vertical', 0.5)); // focus on the new (second)
  const { focusedId } = layoutPaneTree(tree, { width: 100, height: 100 });
  assert.equal(focusedId, tree.second.id);
});

test('wireTreeToLayoutTree reconstructs a pane-shaped tree from the wire node', () => {
  const tree = snap((m) => m.split('horizontal', 0.4));
  const layout = wireTreeToLayoutTree(tree);
  assert.equal(layout.kind, 'split');
  assert.equal(layout.orientation, 'horizontal');
  assert.equal(layout.ratio, 0.4);
  assert.equal(layout.first.kind, 'leaf');
  assert.equal(layout.second.kind, 'leaf');
});

// --- the mount/unmount diff (what the renderer applies) ----------------

test('diff: a fresh tree mounts every leaf when nothing is mounted yet', () => {
  const tree = snap((m) => m.split('vertical', 0.5));
  const { mount, unmount, keep } = diffPaneLeaves(tree, []);
  assert.equal(mount.length, 2);
  assert.equal(unmount.length, 0);
  assert.equal(keep.length, 0);
  // Each mount entry carries the buffer + view-state to mount the view.
  for (const leaf of mount) {
    assert.equal(leaf.bufferId, 'b1');
    assert.equal(typeof leaf.point, 'number');
  }
});

test('diff: a split keeps the existing leaf and mounts only the new one', () => {
  const model = createPaneModel({ initialBufferId: 'b1' });
  const before = model.snapshot(); // single leaf
  const originalId = before.id;
  // The client has mounted the original leaf.
  const mounted = new Set([originalId]);
  model.split('vertical', 0.5); // adds a second leaf
  const after = model.snapshot();
  const { mount, unmount, keep } = diffPaneLeaves(after, mounted);
  // The original leaf is KEPT (re-used, just repositioned); only the new one
  // is mounted; nothing unmounted.
  assert.equal(keep.length, 1);
  assert.equal(keep[0].id, originalId);
  assert.equal(mount.length, 1);
  assert.notEqual(mount[0].id, originalId);
  assert.equal(unmount.length, 0);
});

test('diff: delete-other-panes unmounts the vanished leaves, keeps the survivor', () => {
  const model = createPaneModel({ initialBufferId: 'b1' });
  model.split('vertical', 0.5);
  model.split('horizontal', 0.5); // 3 leaves
  const three = model.snapshot();
  const mountedIds = three.kind === 'split'
    ? collectLeafIds(three)
    : [three.id];
  assert.equal(mountedIds.length, 3);
  const keepId = model.focusedId;
  model.deleteOtherPanes(); // collapse to the focused leaf
  const one = model.snapshot();
  const { mount, unmount, keep } = diffPaneLeaves(one, mountedIds);
  assert.equal(keep.length, 1);
  assert.equal(keep[0].id, keepId);
  assert.equal(mount.length, 0);
  assert.equal(unmount.length, 2); // the two other leaves are torn down
});

function collectLeafIds(node, out = []) {
  if (node.kind === 'leaf') out.push(node.id);
  else { collectLeafIds(node.first, out); collectLeafIds(node.second, out); }
  return out;
}
