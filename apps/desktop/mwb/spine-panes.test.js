/**
 * @file Integration tests for the pane/window model THROUGH THE SPINE (G0a).
 *
 * These drive the REAL panes.lisp commands — split-window-below/-right
 * (C-x 2 / C-x 3), other-window (C-x o), delete-window (C-x 0),
 * delete-other-windows (C-x 1) — through the spine's keymap + run-command,
 * and assert the resulting LOGICAL pane tree shape, which leaf/buffer is
 * focused, that an edit lands in the focused leaf's buffer, and that a second
 * leaf on the SAME buffer reflects it (shared text, independent point). They
 * also round-trip a PANE_INTENT and the PANE_TREE wire snapshot.
 *
 * The whole point of G0a is to BOUND the pane-geometry cost: this proves the
 * server owns the tree + the commands graduate verbatim, with no screen
 * (node --test). Pixel layout is the client's; nothing here measures pixels.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpine } from './spine.js';
import { wireLeaves, wireFocusedLeafId } from './protocol.js';

/** A spine with recording effects (incl. pane-tree pushes). */
function makeSpine(initialText = 'one\ntwo\nthree', name = 'scratch.txt', extra = {}) {
  const log = { paneTrees: [], status: [] };
  const spine = createSpine(
    { initialText, name },
    {
      onStatus: (s) => log.status.push(s),
      onPaneTree: (i) => log.paneTrees.push(i),
      openFile: extra.openFile,
    }
  );
  return { spine, log };
}

/** Drive C-x then KEY through the spine (the prefix chord). */
function cx(spine, key) {
  spine.handleKey('C-x');
  spine.handleKey(key);
}

// --- C-x 2 / C-x 3: split through the real commands --------------------

test('C-x 2 (split-window-below) splits the window into two stacked panes', () => {
  const { spine } = makeSpine();
  cx(spine, '2');
  const snap = spine.paneSnapshot(0);
  assert.equal(snap.kind, 'split');
  assert.equal(snap.orientation, 'vertical'); // C-x 2 = top/bottom
  assert.equal(wireLeaves(snap).length, 2);
  // Focus moved to the new pane (production split semantics).
  assert.equal(wireFocusedLeafId(snap), snap.second.id);
});

test('C-x 3 (split-window-right) splits side-by-side', () => {
  const { spine } = makeSpine();
  cx(spine, '3');
  const snap = spine.paneSnapshot(0);
  assert.equal(snap.kind, 'split');
  assert.equal(snap.orientation, 'horizontal'); // C-x 3 = left/right
  assert.equal(wireLeaves(snap).length, 2);
});

test('both panes after a split show the SAME buffer (Emacs split semantics)', () => {
  const { spine } = makeSpine();
  cx(spine, '2');
  const snap = spine.paneSnapshot(0);
  const [a, b] = wireLeaves(snap);
  assert.equal(a.bufferId, b.bufferId);
  assert.ok(a.bufferId); // both reference a real buffer
});

test('a split pushes a fresh PANE_TREE', () => {
  const { spine, log } = makeSpine();
  const before = log.paneTrees.length;
  cx(spine, '2');
  assert.ok(log.paneTrees.length > before);
  assert.equal(log.paneTrees[log.paneTrees.length - 1], 0); // for client 0
});

test('list-bookmarks (C-x r l) TOGGLES the bookmark outline open and closed', () => {
  const { spine } = makeSpine();
  spine.runCommand('list-bookmarks'); // open
  let leaves = wireLeaves(spine.paneSnapshot(0));
  assert.equal(leaves.length, 2, 'the outline opened beside the document');
  assert.ok(leaves.some((l) => l.viewKind === 'bookmark'), 'a leaf is the bookmark outline');

  spine.runCommand('list-bookmarks'); // toggle closed
  assert.equal(
    wireLeaves(spine.paneSnapshot(0)).length, 1,
    'a second C-x r l closed the outline, leaving just the document'
  );

  spine.runCommand('list-bookmarks'); // toggle open again
  assert.equal(wireLeaves(spine.paneSnapshot(0)).length, 2, 're-opens after a close');
});

test('C-x r l also CLOSES a PINNED outline (no duplicate after a restore)', () => {
  const { spine } = makeSpine();
  spine.runCommand('list-bookmarks'); // open a following outline
  const outline = wireLeaves(spine.paneSnapshot(0)).find((l) => l.viewKind === 'bookmark');
  assert.ok(outline, 'the outline opened');
  spine.applyBookmarkOp(outline.bufferId, { op: 'pin' }); // pin it (as a restore would)

  // C-x r l on a window showing only a PINNED outline must CLOSE it, not spawn a
  // second (following) one beside it.
  spine.runCommand('list-bookmarks');
  assert.equal(
    wireLeaves(spine.paneSnapshot(0)).length, 1,
    'the pinned outline closed, leaving just the document (no duplicate)'
  );
});

// --- C-x o: other-window cycles focus ----------------------------------

test('C-x o (other-window) cycles focus between the two panes', () => {
  const { spine } = makeSpine();
  cx(spine, '2'); // two panes, focus on the new (second)
  const afterSplit = wireFocusedLeafId(spine.paneSnapshot(0));
  cx(spine, 'o'); // → cycle to the other pane
  const afterFirstO = wireFocusedLeafId(spine.paneSnapshot(0));
  assert.notEqual(afterFirstO, afterSplit);
  cx(spine, 'o'); // → back
  assert.equal(wireFocusedLeafId(spine.paneSnapshot(0)), afterSplit);
});

// --- the core proof: an edit lands in the FOCUSED pane's buffer, and a
//     second pane on the SAME buffer reflects it ------------------------

test('an edit lands in the focused pane, and the other pane on the same buffer sees it', () => {
  const { spine } = makeSpine('');
  // Split: two panes, both on the seed buffer, focus on the new one.
  cx(spine, '2');
  const snap = spine.paneSnapshot(0);
  const [paneA, paneB] = wireLeaves(snap);
  assert.equal(wireFocusedLeafId(snap), paneB.id); // focus on the new pane

  // Type in the focused pane (paneB). The shared buffer changes.
  for (const ch of 'hello') spine.handleKey(ch);
  assert.equal(spine.buffer.text, 'hello');

  // The focused pane's point advanced to 5; the OTHER pane (paneA) on the same
  // buffer reflects the text but keeps its own point (still 0 — it didn't type).
  const snap2 = spine.paneSnapshot(0);
  const a2 = wireLeaves(snap2).find((l) => l.id === paneA.id);
  const b2 = wireLeaves(snap2).find((l) => l.id === paneB.id);
  assert.equal(b2.point, 5); // the focused pane's cursor moved
  assert.equal(a2.point, 0); // the other pane's cursor is independent
  assert.equal(a2.bufferId, b2.bufferId); // same shared buffer (same text)
});

test('C-x o then typing edits the OTHER pane; both share the text', () => {
  const { spine } = makeSpine('');
  cx(spine, '2'); // two panes on the seed buffer, focus on the new (paneB)
  for (const ch of 'AB') spine.handleKey(ch); // edit paneB → "AB", point 2
  cx(spine, 'o'); // focus paneA (point 0)
  // Typing now inserts at paneA's point (0), before "AB".
  spine.handleKey('Z'); // self-insert 'Z' at point 0
  assert.equal(spine.buffer.text, 'ZAB');
  const snap = spine.paneSnapshot(0);
  const leaves = wireLeaves(snap);
  // The focused pane (paneA) advanced to 1; both panes show the shared text.
  const focused = leaves.find((l) => l.focused);
  assert.equal(focused.point, 1);
  assert.equal(leaves[0].bufferId, leaves[1].bufferId);
});

// --- C-x 0: delete-window ----------------------------------------------

test('C-x 0 (delete-window) collapses the focused pane back to one', () => {
  const { spine } = makeSpine();
  cx(spine, '2'); // two panes, focus on the new
  assert.equal(wireLeaves(spine.paneSnapshot(0)).length, 2);
  cx(spine, '0'); // delete the focused pane
  const snap = spine.paneSnapshot(0);
  assert.equal(snap.kind, 'leaf');
  assert.equal(wireLeaves(snap).length, 1);
});

test('C-x 0 at the sole pane is a no-op', () => {
  const { spine } = makeSpine();
  cx(spine, '0');
  assert.equal(spine.paneSnapshot(0).kind, 'leaf');
  assert.equal(wireLeaves(spine.paneSnapshot(0)).length, 1);
});

// --- C-x 1: delete-other-windows ---------------------------------------

test('C-x 1 (delete-other-windows) makes the focused pane fill the window', () => {
  const { spine } = makeSpine();
  cx(spine, '2'); // 2 panes
  cx(spine, '3'); // 3 panes (split the focused one again)
  assert.equal(wireLeaves(spine.paneSnapshot(0)).length, 3);
  const keep = wireFocusedLeafId(spine.paneSnapshot(0));
  cx(spine, '1'); // the focused pane fills the window
  const snap = spine.paneSnapshot(0);
  assert.equal(snap.kind, 'leaf');
  assert.equal(snap.id, keep);
});

// --- a deeper layout: 3 panes, edit in each ----------------------------

test('a 3-pane layout: edits route to whichever pane is focused', () => {
  const { spine } = makeSpine('');
  cx(spine, '2'); // 2 panes (vertical)
  cx(spine, '3'); // 3 panes (split the focused one horizontally)
  assert.equal(wireLeaves(spine.paneSnapshot(0)).length, 3);
  // Type in the currently-focused (3rd) pane.
  for (const ch of 'xyz') spine.handleKey(ch);
  assert.equal(spine.buffer.text, 'xyz');
  // All three panes share the one buffer (we never switched buffers).
  const ids = new Set(wireLeaves(spine.paneSnapshot(0)).map((l) => l.bufferId));
  assert.equal(ids.size, 1);
});

// --- PANE_INTENT round-trip (the wire path the client uses) -------------

test('applyPaneIntent split-below drives the same command as C-x 2', () => {
  const { spine } = makeSpine();
  const ok = spine.applyPaneIntent(0, { op: 'split-below' });
  assert.equal(ok, true);
  const snap = spine.paneSnapshot(0);
  assert.equal(snap.kind, 'split');
  assert.equal(snap.orientation, 'vertical');
  assert.equal(wireLeaves(snap).length, 2);
});

test('applyPaneIntent other-window + focus-pane move focus over the wire', () => {
  const { spine } = makeSpine();
  spine.applyPaneIntent(0, { op: 'split-right' }); // 2 panes
  const snap = spine.paneSnapshot(0);
  const focusedAfterSplit = wireFocusedLeafId(snap);
  const otherId = wireLeaves(snap).find((l) => l.id !== focusedAfterSplit).id;
  // other-window cycles to the other pane.
  spine.applyPaneIntent(0, { op: 'other-window' });
  assert.equal(wireFocusedLeafId(spine.paneSnapshot(0)), otherId);
  // focus-pane jumps directly back to a specific leaf by id.
  spine.applyPaneIntent(0, { op: 'focus-pane', paneId: focusedAfterSplit });
  assert.equal(wireFocusedLeafId(spine.paneSnapshot(0)), focusedAfterSplit);
});

test('applyPaneIntent resize records a client splitter drag (ratio only, no pixels)', () => {
  const { spine } = makeSpine();
  spine.applyPaneIntent(0, { op: 'split-right' });
  const splitId = spine.paneSnapshot(0).id;
  const ok = spine.applyPaneIntent(0, { op: 'resize', paneId: splitId, ratio: 0.65 });
  assert.equal(ok, true);
  assert.equal(spine.paneSnapshot(0).ratio, 0.65);
});

test('applyPaneIntent delete-window + delete-other-windows over the wire', () => {
  const { spine } = makeSpine();
  spine.applyPaneIntent(0, { op: 'split-below' });
  spine.applyPaneIntent(0, { op: 'split-right' }); // 3 panes
  assert.equal(wireLeaves(spine.paneSnapshot(0)).length, 3);
  spine.applyPaneIntent(0, { op: 'delete-window' }); // 2 panes
  assert.equal(wireLeaves(spine.paneSnapshot(0)).length, 2);
  spine.applyPaneIntent(0, { op: 'delete-other-windows' }); // 1 pane
  assert.equal(spine.paneSnapshot(0).kind, 'leaf');
});

test('an unknown pane intent is rejected', () => {
  const { spine } = makeSpine();
  assert.equal(spine.applyPaneIntent(0, { op: 'no-such-op' }), false);
});

// --- Step 3c: a tabline leaf with its OWN curated tabs -----------------

test('toggle-tabline makes the focused leaf a 1-tab tabline; find-file adds a tab', () => {
  const files = { '/x.js': { text: 'const x = 1;\n', name: 'x.js' } };
  const { spine } = makeSpine('seed', 'scratch.txt', { openFile: (p) => files[p] ?? null });
  const seedId = spine.currentBufferIdOf(0);

  spine.runCommand('toggle-tabline');
  let leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.equal(leaf.tabline, true, 'the focused leaf is now a tabline');
  assert.deepEqual(leaf.tabs.map((t) => t.bufferId), [seedId], 'seeded with EXACTLY one tab');

  // find-file WHILE the tabline leaf is focused ADDS a tab and makes it active.
  const xId = spine.visitFile('/x.js');
  leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.equal(leaf.tabline, true, 'still a tabline');
  assert.deepEqual(leaf.tabs.map((t) => t.bufferId), [seedId, xId], 'the open added a tab');
  assert.equal(leaf.bufferId, xId, 'the new file is the active tab');
  assert.equal(leaf.tabs.find((t) => t.bufferId === xId).name, 'x.js', 'tab metadata is live');
});

test('splitting a tabline leaf keeps the original tabline; the new leaf is plain (Step 3c)', () => {
  const { spine } = makeSpine();
  spine.runCommand('toggle-tabline');
  spine.applyPaneIntent(0, { op: 'split-right' });
  const leaves = wireLeaves(spine.paneSnapshot(0));
  assert.equal(leaves.length, 2);
  const tab = leaves.find((l) => l.tabline);
  const plain = leaves.find((l) => !l.tabline);
  assert.ok(tab, 'the original leaf is still a tabline (its curated tabs survive)');
  assert.ok(plain, 'the new leaf is a plain single view');
  assert.equal(plain.focused, true, 'focus moved to the new plain leaf (Emacs split)');
  assert.equal(tab.bufferId, plain.bufferId, 'both show the same buffer');
  // The original tabline is now NON-focused on the SAME buffer as the focused
  // leaf, so the wire carries no `text` for it — the client must render it from
  // the live mirror (3a), not an empty static buffer.
  assert.equal(tab.text, undefined, 'no static text for a same-buffer tabline leaf');
});

test('a close-tab pane intent un-curates a tab (buffer survives in the pool) (Step 3c, opt-out)', () => {
  const files = { '/x.js': { text: 'x', name: 'x.js' } };
  const { spine } = makeSpine('seed', 'scratch.txt', { openFile: (p) => files[p] ?? null });
  const seedId = spine.currentBufferIdOf(0);
  // The default is now KILL-on-close; opt out so this exercises the un-curate
  // path (the buffer survives in the pool / C-x C-b).
  spine.interpreter.evaluate('(set! *close-tab-kills-view* #f)');
  spine.runCommand('toggle-tabline');
  const xId = spine.visitFile('/x.js'); // tabs: seed, x (x active)

  // Close the non-active seed tab — it leaves THIS tabline but stays in the pool.
  assert.equal(spine.applyPaneIntent(0, { op: 'close-tab', bufferId: seedId }), true);
  const leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.deepEqual(leaf.tabs.map((t) => t.bufferId), [xId], 'the seed tab is gone');
  assert.equal(leaf.bufferId, xId, 'the active tab is unchanged');
  assert.ok(spine.bufferIdByName('scratch.txt'), 'the closed buffer is still in the pool');
});

test('seedClientTabline makes a window a tabline of given buffers (unify window 1)', () => {
  const files = {
    '/a.js': { text: 'a', name: 'a.js' },
    '/b.js': { text: 'b', name: 'b.js' },
  };
  const { spine } = makeSpine('seed', 'scratch.txt', { openFile: (p) => files[p] ?? null });
  const seedId = spine.currentBufferIdOf(0);
  const aId = spine.visitFile('/a.js');
  const bId = spine.visitFile('/b.js'); // active client (0) now on b.js, single leaf

  // Seed window 0 as a tabline of its open files (the restore → tabline path).
  assert.equal(spine.seedClientTabline(0, [seedId, aId, bId], bId), true);
  const leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.equal(leaf.tabline, true, 'the window is now a tabline leaf');
  assert.deepEqual(leaf.tabs.map((t) => t.bufferId), [seedId, aId, bId], 'all open files are tabs');
  assert.equal(leaf.bufferId, bId, 'the active file is the active tab');
  assert.equal(spine.currentBufferIdOf(0), bId, 'the active buffer is unchanged');
});

test('a reorder-tab pane intent reorders the focused tabline (Step 3c)', () => {
  const files = { '/x.js': { text: 'x', name: 'x.js' } };
  const { spine } = makeSpine('seed', 'scratch.txt', { openFile: (p) => files[p] ?? null });
  const seedId = spine.currentBufferIdOf(0);
  spine.runCommand('toggle-tabline');
  const xId = spine.visitFile('/x.js'); // tabs: seed, x (x active)

  // Drag x (index 1) to the front.
  assert.equal(spine.applyPaneIntent(0, { op: 'reorder-tab', from: 1, to: 0 }), true);
  const leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.deepEqual(leaf.tabs.map((t) => t.bufferId), [xId, seedId], 'order changed');
  assert.equal(leaf.bufferId, xId, 'the active tab is still x');
});

// --- two panes on DIFFERENT buffers within one window ------------------

test('a pane can show a different buffer; the other pane keeps its own', () => {
  const files = { '/x.js': { text: 'const x = 1;\n', name: 'x.js' } };
  const { spine } = makeSpine('seed text', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  cx(spine, '2'); // 2 panes on the seed buffer, focus on the new (paneB)
  const seedId = spine.paneSnapshot(0).first.bufferId;
  // find-file in the focused pane → that pane now shows x.js; the other keeps seed.
  spine.visitFile('/x.js');
  const snap = spine.paneSnapshot(0);
  const leaves = wireLeaves(snap);
  const focused = leaves.find((l) => l.focused);
  const other = leaves.find((l) => !l.focused);
  assert.notEqual(focused.bufferId, other.bufferId);
  assert.equal(other.bufferId, seedId);
  assert.equal(focused.name, 'x.js');
  assert.equal(other.name, 'scratch.txt');
});

// --- the wire snapshot carries no pixels (the geometry finding) --------

test('the PANE_TREE snapshot carries structure + ratio but NO pixel fields', () => {
  const { spine } = makeSpine();
  cx(spine, '2');
  const snap = spine.paneSnapshot(0);
  // A split node carries orientation + ratio (a fraction), not pixels.
  assert.equal(typeof snap.ratio, 'number');
  assert.ok(snap.ratio > 0 && snap.ratio < 1);
  assert.equal(snap.left, undefined);
  assert.equal(snap.width, undefined);
  for (const leaf of wireLeaves(snap)) {
    assert.equal(leaf.left, undefined);
    assert.equal(leaf.width, undefined);
    assert.equal(leaf.height, undefined);
  }
});

// --- spatial navigation needs the client's host rect (the one coupling) -

test('focus-pane-direction needs the reported host rect (the geometry coupling)', () => {
  const { spine } = makeSpine();
  spine.setPaneHostRect(0, { width: 1000, height: 400 });
  cx(spine, '3'); // horizontal split → left | right, focus on the right
  const snap = spine.paneSnapshot(0);
  const leftId = snap.first.id;
  const rightId = snap.second.id;
  assert.equal(wireFocusedLeafId(snap), rightId);
  // Drive focus-pane-left via the real command (focus-pane-left → focus-pane-direction! 'left).
  spine.runCommand('focus-pane-left');
  assert.equal(wireFocusedLeafId(spine.paneSnapshot(0)), leftId);
});

// --- add-pane: the visual macro's server half (C-x +) -----------------

test('add-pane asks THIS window to show the overlay (enter-add-pane-mode directive)', () => {
  const dirs = [];
  const spine = createSpine({ initialText: 'hi', name: 'a.txt' }, {
    onClientDirective: (ids, name, args) => dirs.push({ ids, name, args }),
  });
  spine.runCommand('add-pane');
  assert.deepEqual(dirs, [{ ids: [0], name: 'enter-add-pane-mode', args: [] }]);
});

test('an add-at-border PANE_INTENT wraps the layout + focuses the new pane + re-pushes', () => {
  const { spine, log } = makeSpine();
  const before = log.paneTrees.length;
  assert.equal(spine.applyPaneIntent(0, { op: 'add-at-border', side: 'right' }), true);
  const snap = spine.paneSnapshot(0);
  assert.equal(snap.kind, 'split');
  assert.equal(wireLeaves(snap).length, 2);
  assert.equal(wireFocusedLeafId(snap), snap.second.id); // new leaf on the right, focused
  assert.ok(log.paneTrees.length > before, 'a fresh PANE_TREE was pushed');
});

test('an add-at-splitter PANE_INTENT inserts a third sibling into the split', () => {
  const { spine } = makeSpine();
  cx(spine, '3'); // one split, two leaves
  const splitId = spine.paneSnapshot(0).id;
  assert.equal(spine.applyPaneIntent(0, { op: 'add-at-splitter', paneId: splitId }), true);
  assert.equal(wireLeaves(spine.paneSnapshot(0)).length, 3);
});

test('a malformed add-pane intent is rejected (no tree change)', () => {
  const { spine } = makeSpine();
  assert.equal(spine.applyPaneIntent(0, { op: 'add-at-border', side: 'nope' }), false);
  assert.equal(spine.applyPaneIntent(0, { op: 'add-at-splitter', paneId: 'no-such' }), false);
  assert.equal(wireLeaves(spine.paneSnapshot(0)).length, 1);
});

// --- move-views: swap-views / permute-views server half --------------

test('swap-views/permute-views ask THIS window to show the badge overlay', () => {
  const dirs = [];
  const spine = createSpine({ initialText: 'hi', name: 'a.txt' }, {
    onClientDirective: (ids, name, args) => dirs.push({ ids, name, args }),
  });
  spine.runCommand('swap-views'); // one pane → refused (status only, no directive)
  spine.applyPaneIntent(0, { op: 'split-right' }); // now two panes
  spine.runCommand('swap-views');
  spine.runCommand('permute-views');
  assert.deepEqual(dirs, [
    { ids: [0], name: 'enter-move-views-mode', args: ['swap'] },
    { ids: [0], name: 'enter-move-views-mode', args: ['permute'] },
  ]);
});

test('a move-views PANE_INTENT moves the leaves structurally + re-pushes PANE_TREE', () => {
  const { spine, log } = makeSpine();
  cx(spine, '3'); // two leaves
  const [l0, l1] = wireLeaves(spine.paneSnapshot(0));
  const before = log.paneTrees.length;
  assert.equal(
    spine.applyPaneIntent(0, { op: 'move-views', slotOrder: [l0.id, l1.id], occupants: [l1.id, l0.id] }),
    true
  );
  const [n0, n1] = wireLeaves(spine.paneSnapshot(0));
  assert.equal(n0.id, l1.id); // the leaf ids swapped slots (content rode along)
  assert.equal(n1.id, l0.id);
  assert.ok(log.paneTrees.length > before);
});
