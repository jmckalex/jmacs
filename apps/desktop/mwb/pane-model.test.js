/**
 * @file Tests for the Model-B server-side pane model (pane-model.js, G0a).
 *
 * These prove the LOGICAL pane tree the server owns: split / delete /
 * other-window / delete-others mutate the tree shape correctly; focus
 * follows; two leaves can show the same buffer with independent point;
 * the PANE_TREE wire snapshot carries the structure + per-leaf state + the
 * focused leaf, and NO pixels. DOM-free, interpreter-free — part of the
 * `node --test` suite (the verification of record; no screen).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPaneModel } from './pane-model.js';
import { wireLeaves, wireFocusedLeafId } from './protocol.js';

/** A pane model seeded on buffer "b1", with an onChange counter. */
function makeModel(initialBufferId = 'b1') {
  const log = { changes: 0 };
  const model = createPaneModel(
    { initialBufferId },
    {
      onChange: () => { log.changes += 1; },
      nameForBuffer: (id) => (id == null ? 'scratch' : `name-of-${id}`),
    }
  );
  return { model, log };
}

/** Collect every leaf node of a wire snapshot. */
function snapshotLeaves(node, out = []) {
  if (!node) return out;
  if (node.kind === 'leaf') out.push(node);
  else { snapshotLeaves(node.first, out); snapshotLeaves(node.second, out); }
  return out;
}

test('snapshot carries text only for a DIFFERENT-buffer leaf (Step 3b)', () => {
  const texts = { A: 'alpha text', B: 'beta text' };
  const model = createPaneModel(
    { initialBufferId: 'A' },
    { nameForBuffer: (id) => `name-of-${id}`, textForBuffer: (id) => texts[id] ?? null }
  );

  // Two leaves, both on A (focus on the new one). Same buffer → no text.
  model.split('horizontal', 0.5, 'after');
  let leaves = snapshotLeaves(model.snapshot());
  assert.ok(leaves.every((l) => l.text === undefined), 'same-buffer split carries no text');

  // Switch the focused leaf to B → the OTHER leaf (A) is now a different buffer.
  model.setFocusedBuffer('B');
  leaves = snapshotLeaves(model.snapshot());
  const focused = leaves.find((l) => l.focused);
  const other = leaves.find((l) => !l.focused);
  assert.equal(focused.bufferId, 'B');
  assert.equal(focused.text, undefined, 'the focused leaf carries no text (uses the live mirror)');
  assert.equal(other.bufferId, 'A');
  assert.equal(other.text, 'alpha text', 'the different-buffer leaf carries its text');
});

test('a fresh model is a single focused leaf on the seed buffer', () => {
  const { model } = makeModel('b1');
  assert.equal(model.leafCount(), 1);
  assert.equal(model.focusedBufferId(), 'b1');
  assert.equal(model.root.kind, 'leaf');
  assert.equal(model.focusedId, model.root.id);
});

test('split-below makes a vertical split of two leaves, focus on the new one', () => {
  const { model, log } = makeModel('b1');
  const before = log.changes;
  const newLeaf = model.split('vertical', 0.5, 'after');
  assert.equal(model.leafCount(), 2);
  assert.equal(model.root.kind, 'split');
  assert.equal(model.root.orientation, 'vertical');
  // The new leaf is the second child (side 'after') and holds focus.
  assert.equal(model.root.second.id, newLeaf.id);
  assert.equal(model.focusedId, newLeaf.id);
  assert.equal(log.changes, before + 1);
});

test('split-right makes a horizontal split', () => {
  const { model } = makeModel('b1');
  model.split('horizontal', 0.5, 'after');
  assert.equal(model.root.kind, 'split');
  assert.equal(model.root.orientation, 'horizontal');
  assert.equal(model.leafCount(), 2);
});

test('the split new leaf shows the SAME buffer as the source (Emacs semantics)', () => {
  const { model } = makeModel('b1');
  const newLeaf = model.split('vertical', 0.5);
  // Both leaves reference b1 — shared text, the same-buffer-two-windows case.
  assert.equal(model.stateOf(model.root.first.id).bufferId, 'b1');
  assert.equal(model.stateOf(newLeaf.id).bufferId, 'b1');
});

test('two leaves on the same buffer keep independent point', () => {
  const { model } = makeModel('b1');
  const first = model.root; // the original leaf, currently focused before split
  const firstId = first.id;
  // Set the original leaf's point, then split (new leaf seeds from it).
  model.setFocusedPoint(10, null);
  const newLeaf = model.split('vertical', 0.5);
  // The new leaf seeded point 10 from the source, and now holds focus.
  assert.equal(model.stateOf(newLeaf.id).point, 10);
  // Move the focused (new) leaf's point; the original leaf is unchanged.
  model.setFocusedPoint(3, null);
  assert.equal(model.stateOf(newLeaf.id).point, 3);
  assert.equal(model.stateOf(firstId).point, 10);
});

test('other-window cycles focus through the leaves in display order', () => {
  const { model } = makeModel('b1');
  const original = model.focusedId;
  const second = model.split('vertical', 0.5); // focus now on `second`
  assert.equal(model.focusedId, second.id);
  // C-x o cycles: second → (wraps) → first (original).
  const next = model.otherPane();
  assert.equal(next.id, original);
  assert.equal(model.focusedId, original);
  // Again → back to second.
  model.otherPane();
  assert.equal(model.focusedId, second.id);
});

test('other-window is a no-op with a single pane', () => {
  const { model, log } = makeModel('b1');
  const before = log.changes;
  const leaf = model.otherPane();
  assert.equal(leaf.id, model.focusedId);
  assert.equal(model.leafCount(), 1);
  assert.equal(log.changes, before); // no change emitted
});

test('delete-window collapses the parent split into the sibling', () => {
  const { model } = makeModel('b1');
  const original = model.focusedId;
  model.split('vertical', 0.5); // two leaves, focus on the new (second)
  assert.equal(model.leafCount(), 2);
  // Delete the focused (new) leaf → back to one leaf (the original).
  const deleted = model.deletePane();
  assert.equal(deleted, true);
  assert.equal(model.leafCount(), 1);
  assert.equal(model.root.kind, 'leaf');
  assert.equal(model.focusedId, original);
});

test('delete-window is a no-op at the root leaf', () => {
  const { model } = makeModel('b1');
  assert.equal(model.deletePane(), false);
  assert.equal(model.leafCount(), 1);
});

test('delete-window focus lands in the surviving sibling', () => {
  const { model } = makeModel('b1');
  // Build three leaves: split, then split again (focus on the newest).
  model.split('horizontal', 0.5); // 2 leaves
  model.split('vertical', 0.5); // 3 leaves, focus on the newest
  assert.equal(model.leafCount(), 3);
  const focusedBefore = model.focusedId;
  model.deletePane();
  assert.equal(model.leafCount(), 2);
  // Focus moved off the deleted leaf into a survivor.
  assert.notEqual(model.focusedId, focusedBefore);
  assert.ok(model.leaves().some((l) => l.id === model.focusedId));
});

test('delete-other-windows makes the focused leaf fill the window', () => {
  const { model } = makeModel('b1');
  model.split('horizontal', 0.5);
  model.split('vertical', 0.5); // 3 leaves, focus on newest
  const keep = model.focusedId;
  const collapsed = model.deleteOtherPanes();
  assert.equal(collapsed, true);
  assert.equal(model.leafCount(), 1);
  assert.equal(model.root.kind, 'leaf');
  assert.equal(model.focusedId, keep);
  assert.equal(model.root.id, keep);
});

test('delete-other-windows is a no-op when already a single pane', () => {
  const { model } = makeModel('b1');
  assert.equal(model.deleteOtherPanes(), false);
});

test('orphan leaf-state is pruned after a delete', () => {
  const { model } = makeModel('b1');
  const newLeaf = model.split('vertical', 0.5);
  assert.ok(model.stateOf(newLeaf.id));
  // Focus is on newLeaf; delete it → its state must be gone.
  model.deletePane();
  assert.equal(model.stateOf(newLeaf.id), null);
});

test('swap-panes exchanges the buffers two leaves show', () => {
  const { model } = makeModel('b1');
  const a = model.root; // original, on b1
  const aId = a.id;
  const newLeaf = model.split('vertical', 0.5); // new leaf, also b1 by default
  // Point the new leaf at a different buffer + distinct point.
  model.setFocusedBuffer('b2');
  model.setFocusedPoint(7, null);
  // Sanity: a on b1, newLeaf on b2.
  assert.equal(model.stateOf(aId).bufferId, 'b1');
  assert.equal(model.stateOf(newLeaf.id).bufferId, 'b2');
  const aLeaf = model.leaves().find((l) => l.id === aId);
  const swapped = model.swapPanes(aLeaf, newLeaf);
  assert.equal(swapped, true);
  // The buffers traded places; the leaf IDS (frames) stayed put.
  assert.equal(model.stateOf(aId).bufferId, 'b2');
  assert.equal(model.stateOf(newLeaf.id).bufferId, 'b1');
  assert.equal(model.stateOf(aId).point, 7);
});

test('set-split-ratio records a client splitter drag', () => {
  const { model } = makeModel('b1');
  model.split('horizontal', 0.5);
  const splitId = model.root.id;
  assert.equal(model.setSplitRatio(splitId, 0.7), true);
  assert.equal(model.root.ratio, 0.7);
  // Clamped to the sane band.
  model.setSplitRatio(splitId, 0.99);
  assert.equal(model.root.ratio, 0.95);
});

test('balance-panes resets every split ratio to 0.5', () => {
  const { model } = makeModel('b1');
  model.split('horizontal', 0.3); // ratio 0.3
  model.split('vertical', 0.8); // nested split ratio 0.8
  model.balancePanes();
  // Walk: every split node now 0.5.
  const walk = (n) => {
    if (n.kind !== 'split') return true;
    return n.ratio === 0.5 && walk(n.first) && walk(n.second);
  };
  assert.equal(walk(model.root), true);
});

// --- spatial navigation (the geometry-coupled command) -----------------

test('focus-pane-direction moves right across a horizontal split', () => {
  const { model } = makeModel('b1');
  // Report a wide host rect so the geometry is unambiguous.
  model.setHostRect({ width: 1000, height: 400 });
  const left = model.root; // original leaf becomes the LEFT child
  const leftId = left.id;
  const right = model.split('horizontal', 0.5); // new leaf to the right, focused
  // Focus is on the right leaf; move LEFT → lands on the original.
  assert.equal(model.focusPaneDirection('left'), true);
  assert.equal(model.focusedId, leftId);
  // Move RIGHT → back to the right leaf.
  assert.equal(model.focusPaneDirection('right'), true);
  assert.equal(model.focusedId, right.id);
});

test('focus-pane-direction returns false with no neighbour on that side', () => {
  const { model } = makeModel('b1');
  model.setHostRect({ width: 1000, height: 400 });
  model.split('horizontal', 0.5); // focus on the right leaf
  // Nothing to the right of the rightmost leaf.
  assert.equal(model.focusPaneDirection('right'), false);
  // Nothing above (a horizontal split has no vertical neighbours).
  assert.equal(model.focusPaneDirection('up'), false);
});

// --- the PANE_TREE wire snapshot ---------------------------------------

test('snapshot of a single leaf carries the buffer + focus + no pixels', () => {
  const { model } = makeModel('b1');
  model.setFocusedPoint(4, 2);
  const snap = model.snapshot();
  assert.equal(snap.kind, 'leaf');
  assert.equal(snap.bufferId, 'b1');
  assert.equal(snap.name, 'name-of-b1');
  assert.equal(snap.point, 4);
  assert.equal(snap.mark, 2);
  assert.equal(snap.focused, true);
  // NO pixel fields cross the wire.
  assert.equal(snap.left, undefined);
  assert.equal(snap.width, undefined);
});

test('snapshot of a split carries orientation + ratio + both subtrees', () => {
  const { model } = makeModel('b1');
  model.split('vertical', 0.4, 'after');
  const snap = model.snapshot();
  assert.equal(snap.kind, 'split');
  assert.equal(snap.orientation, 'vertical');
  assert.equal(snap.ratio, 0.4);
  assert.equal(snap.first.kind, 'leaf');
  assert.equal(snap.second.kind, 'leaf');
  // The wire-leaf helpers find the leaves + the focused one.
  const leaves = wireLeaves(snap);
  assert.equal(leaves.length, 2);
  assert.equal(wireFocusedLeafId(snap), model.focusedId);
  // The focused (second) leaf is the new one.
  assert.equal(wireFocusedLeafId(snap), snap.second.id);
});

test('snapshot reflects a 4-pane layout with the right leaf count', () => {
  const { model } = makeModel('b1');
  model.split('horizontal', 0.5); // 2
  model.split('vertical', 0.5); // 3
  model.otherPane(); // move focus so the next split lands elsewhere
  model.split('vertical', 0.5); // 4
  const snap = model.snapshot();
  assert.equal(wireLeaves(snap).length, 4);
  // Exactly one focused leaf.
  assert.equal(wireLeaves(snap).filter((l) => l.focused).length, 1);
});
