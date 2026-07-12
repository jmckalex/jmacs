/**
 * @file Tests for the Model-B Phase-0 spike wire protocol. Pure helpers
 * only — these run under the existing `node --test` suite and must stay
 * green (the spike must not break the existing suite).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDelta,
  predictSelfInsert,
  predictDeleteBackward,
  renderModeline,
  normaliseOverlay,
  overlaysToDecorations,
  normaliseCursors,
  serializePaneTree,
  wireLeaves,
  wireFocusedLeafId,
  normalisePickerRequest,
  normalisePickerRow,
  filterPickerRows,
  screenfulStep,
  screenfulScrollLine,
  MINIBUFFER_IDLE,
  MSG,
  INTENT,
  PANE_INTENT,
} from './protocol.js';

test('applyDelta inserts at the start', () => {
  assert.equal(
    applyDelta('world', { start: 0, removed: '', inserted: 'hello ' }),
    'hello world'
  );
});

test('applyDelta inserts in the middle', () => {
  assert.equal(
    applyDelta('helloworld', { start: 5, removed: '', inserted: ' ' }),
    'hello world'
  );
});

test('applyDelta deletes a range', () => {
  assert.equal(
    applyDelta('hello world', { start: 5, removed: ' ', inserted: '' }),
    'helloworld'
  );
});

test('applyDelta replaces a range', () => {
  assert.equal(
    applyDelta('hello world', { start: 6, removed: 'world', inserted: 'there' }),
    'hello there'
  );
});

test('applyDelta is pure (does not mutate its input)', () => {
  const before = 'abc';
  applyDelta(before, { start: 1, removed: '', inserted: 'X' });
  assert.equal(before, 'abc');
});

test('a server delta and the optimistic prediction agree for self-insert', () => {
  // The whole point of local echo: predicting the edit locally must land
  // on the SAME mirror the server's authoritative delta would produce.
  const text = 'foo';
  const point = 3;
  const predicted = predictSelfInsert(text, point, '!');
  // The server, applying buffer.insert('!') at point 3, emits exactly
  // this L1 change shape.
  const serverDelta = { start: 3, removed: '', inserted: '!', point: 4 };
  assert.deepEqual(
    { start: predicted.start, removed: predicted.removed, inserted: predicted.inserted, point: predicted.point },
    serverDelta
  );
  assert.equal(applyDelta(text, predicted), applyDelta(text, serverDelta));
});

test('predictSelfInsert advances point past the inserted text', () => {
  const d = predictSelfInsert('ab', 2, 'cd');
  assert.equal(d.point, 4);
  assert.equal(applyDelta('ab', d), 'abcd');
});

test('predictDeleteBackward removes one char and retreats point', () => {
  const d = predictDeleteBackward('abc', 3);
  assert.deepEqual(
    { start: d.start, removed: d.removed, inserted: d.inserted, point: d.point },
    { start: 2, removed: 'c', inserted: '', point: 2 }
  );
  assert.equal(applyDelta('abc', d), 'ab');
});

test('predictDeleteBackward is a no-op at the start of the buffer', () => {
  assert.equal(predictDeleteBackward('abc', 0), null);
});

// --- the command-spine view-update protocol ---------------------------

test('renderModeline shows clean flag, name, position and mode', () => {
  assert.equal(
    renderModeline({ name: 'app.js', modified: false, line: 12, column: 4, mode: 'js' }),
    '–  app.js   L12:C4  (js)'
  );
});

test('renderModeline shows the ● dirty indicator when modified', () => {
  const s = renderModeline({ name: 'notes.txt', modified: true, line: 1, column: 0 });
  assert.equal(s, '●  notes.txt   L1:C0');
  assert.ok(s.includes('●'), 'a modified buffer shows the ● dirty bullet');
});

test('renderModeline defaults a missing name and position', () => {
  assert.equal(renderModeline({}), '–  untitled   L1:C0');
});

test('renderModeline omits the mode parenthetical when there is no mode', () => {
  const s = renderModeline({ name: 'x', line: 2, column: 3, mode: '' });
  assert.ok(!s.includes('('), `expected no mode parens, got: ${s}`);
});

test('renderModeline omits the position for a no-cursor view (noPosition)', () => {
  const s = renderModeline({ name: 'Notebook', modified: false, mode: 'element', noPosition: true });
  assert.equal(s, '–  Notebook   (element)');
  assert.ok(!/L\d+:C\d+/.test(s), 'no L:C for a cursorless view');
});

test('MINIBUFFER_IDLE is an inactive, empty prompt', () => {
  assert.equal(MINIBUFFER_IDLE.active, false);
  assert.equal(MINIBUFFER_IDLE.prompt, '');
  assert.equal(MINIBUFFER_IDLE.value, '');
});

test('the protocol declares the VIEW message + minibuffer intents', () => {
  assert.equal(MSG.VIEW, 'view');
  assert.equal(INTENT.MINIBUFFER_SUBMIT, 'minibuffer-submit');
  assert.equal(INTENT.MINIBUFFER_CANCEL, 'minibuffer-cancel');
  assert.equal(INTENT.MINIBUFFER_CHANGE, 'minibuffer-change');
});

// --- overlays + multi-cursor over the wire ----------------------------

test('the protocol declares the overlay/cursor/resync messages', () => {
  assert.equal(MSG.OVERLAYS, 'overlays');
  assert.equal(MSG.CURSORS, 'cursors');
  assert.equal(MSG.RESYNC, 'resync');
});

test('normaliseOverlay yields the renderer decoration shape', () => {
  assert.deepEqual(
    normaliseOverlay({ start: 3, end: 8, face: 'search-match' }),
    { start: 3, end: 8, face: 'search-match' }
  );
});

test('normaliseOverlay orders start <= end and floors offsets', () => {
  assert.deepEqual(
    normaliseOverlay({ start: 8.9, end: 3.2, face: 'x' }),
    { start: 3, end: 8, face: 'x' }
  );
});

test('normaliseOverlay defaults a missing face and carries kind/id', () => {
  const o = normaliseOverlay({ start: 0, end: 1, kind: 'search', id: 'm3' });
  assert.equal(o.face, 'overlay');
  assert.equal(o.kind, 'search');
  assert.equal(o.id, 'm3');
});

test('normaliseOverlay drops a malformed overlay (non-numeric range)', () => {
  assert.equal(normaliseOverlay({ start: 'x', end: 2, face: 'f' }), null);
  assert.equal(normaliseOverlay(null), null);
  assert.equal(normaliseOverlay(42), null);
});

test('overlaysToDecorations normalises a list and drops malformed entries', () => {
  const decs = overlaysToDecorations([
    { start: 5, end: 2, face: 'a' }, // reversed → ordered
    { start: 'bad', end: 1, face: 'b' }, // dropped
    { start: 10, end: 12, face: 'c', id: 'z' }, // id stripped from a decoration
  ]);
  assert.deepEqual(decs, [
    { start: 2, end: 5, face: 'a' },
    { start: 10, end: 12, face: 'c' },
  ]);
});

test('overlaysToDecorations tolerates a non-array', () => {
  assert.deepEqual(overlaysToDecorations(undefined), []);
});

test('normaliseCursors preserves a multi-cursor set', () => {
  assert.deepEqual(
    normaliseCursors([
      { point: 3, mark: 1 },
      { point: 9, mark: null },
      { point: 12, mark: 12 },
    ]),
    [
      { point: 3, mark: 1 },
      { point: 9, mark: null },
      { point: 12, mark: 12 },
    ]
  );
});

test('normaliseCursors always yields at least the primary', () => {
  assert.deepEqual(normaliseCursors([]), [{ point: 0, mark: null }]);
  assert.deepEqual(normaliseCursors(undefined), [{ point: 0, mark: null }]);
});

test('normaliseCursors floors offsets and nulls a non-finite mark', () => {
  assert.deepEqual(
    normaliseCursors([{ point: 4.7, mark: undefined }]),
    [{ point: 4, mark: null }]
  );
});

// --- the pane tree over the wire (G0a) ---------------------------------

/** A tiny stand-in for an @editor/pane tree (the serializer only reads
 *  kind/id/orientation/ratio/first/second). */
const leaf = (id) => ({ kind: 'leaf', id });
const split = (id, orientation, ratio, first, second) => ({
  kind: 'split', id, orientation, ratio, first, second,
});

test('serializePaneTree on a single leaf carries buffer + focus, no pixels', () => {
  const node = serializePaneTree(
    leaf('pane-leaf-1'),
    'pane-leaf-1',
    () => ({ bufferId: 'b1', name: 'x.js', point: 3, mark: null, scrollLine: 2 })
  );
  assert.equal(node.kind, 'leaf');
  assert.equal(node.id, 'pane-leaf-1');
  assert.equal(node.bufferId, 'b1');
  assert.equal(node.name, 'x.js');
  assert.equal(node.point, 3);
  assert.equal(node.scrollLine, 2);
  assert.equal(node.focused, true);
  assert.equal(node.left, undefined); // no pixels cross the wire
  assert.equal(node.width, undefined);
});

test('serializePaneTree carries a tabline leaf flag + its curated tabs (Step 3c)', () => {
  const tabs = [
    { bufferId: 'b1', name: 'a.js', modified: false, filePath: '/a.js' },
    { bufferId: 'b2', name: 'b.js', modified: true, filePath: null },
  ];
  const node = serializePaneTree(
    leaf('pane-leaf-1'),
    'pane-leaf-1',
    () => ({ bufferId: 'b2', name: 'b.js', tabline: true, tabs })
  );
  assert.equal(node.tabline, true);
  assert.deepEqual(node.tabs, tabs, 'the ordered curated tab set crosses the wire verbatim');
});

test('serializePaneTree omits tabline/tabs for a single-view leaf (Step 3c)', () => {
  const node = serializePaneTree(
    leaf('pane-leaf-1'),
    'pane-leaf-1',
    () => ({ bufferId: 'b1' })
  );
  assert.equal(node.tabline, undefined);
  assert.equal(node.tabs, undefined);
});

test('serializePaneTree on a split carries orientation + ratio + subtrees', () => {
  const tree = split('pane-split-1', 'horizontal', 0.4, leaf('a'), leaf('b'));
  const node = serializePaneTree(tree, 'b', (l) => ({ bufferId: `buf-${l.id}` }));
  assert.equal(node.kind, 'split');
  assert.equal(node.orientation, 'horizontal');
  assert.equal(node.ratio, 0.4);
  assert.equal(node.first.bufferId, 'buf-a');
  assert.equal(node.second.bufferId, 'buf-b');
  assert.equal(node.first.focused, false);
  assert.equal(node.second.focused, true);
});

test('wireLeaves yields leaves in display order (first then second)', () => {
  const tree = split('s', 'vertical', 0.5,
    leaf('top'),
    split('s2', 'horizontal', 0.5, leaf('bl'), leaf('br')));
  const node = serializePaneTree(tree, 'top', (l) => ({ bufferId: l.id }));
  const ids = wireLeaves(node).map((l) => l.id);
  assert.deepEqual(ids, ['top', 'bl', 'br']);
});

test('wireFocusedLeafId finds the focused leaf, null when none', () => {
  const tree = split('s', 'horizontal', 0.5, leaf('a'), leaf('b'));
  const focused = serializePaneTree(tree, 'b', (l) => ({ bufferId: l.id }));
  assert.equal(wireFocusedLeafId(focused), 'b');
  const none = serializePaneTree(tree, 'nope', (l) => ({ bufferId: l.id }));
  assert.equal(wireFocusedLeafId(none), null);
});

test('PANE_INTENT enumerates the structural ops', () => {
  assert.equal(PANE_INTENT.SPLIT_BELOW, 'split-below');
  assert.equal(PANE_INTENT.SPLIT_RIGHT, 'split-right');
  assert.equal(PANE_INTENT.OTHER_WINDOW, 'other-window');
  assert.equal(PANE_INTENT.DELETE_WINDOW, 'delete-window');
  assert.equal(PANE_INTENT.DELETE_OTHER_WINDOWS, 'delete-other-windows');
  assert.equal(PANE_INTENT.FOCUS_PANE, 'focus-pane');
  assert.equal(PANE_INTENT.RESIZE, 'resize');
});

test('MSG includes the pane channel tags', () => {
  assert.equal(MSG.PANE_TREE, 'pane-tree');
  assert.equal(MSG.PANE, 'pane');
  assert.equal(MSG.PANE_VIEWPORT, 'pane-viewport');
});

// --- the generic picker channel (G0b) ---------------------------------

test('the protocol declares the PICKER message + choose/cancel intents', () => {
  assert.equal(MSG.PICKER, 'picker');
  assert.equal(INTENT.PICKER_CHOOSE, 'picker-choose');
  assert.equal(INTENT.PICKER_CANCEL, 'picker-cancel');
});

test('normalisePickerRequest shapes a well-formed request, defaulting options', () => {
  const req = normalisePickerRequest({
    id: 'picker-1',
    title: 'Buffer list',
    rows: [{ label: 'a.js', value: 'b1', meta: '3L –' }],
  });
  assert.equal(req.id, 'picker-1');
  assert.equal(req.title, 'Buffer list');
  assert.equal(req.rows.length, 1);
  assert.deepEqual(req.rows[0], { label: 'a.js', value: 'b1', meta: '3L –' });
  assert.equal(req.options.filter, true); // default on
});

test('normalisePickerRequest defaults a missing id/title and empty rows', () => {
  const req = normalisePickerRequest({});
  assert.equal(req.id, 'picker');
  assert.equal(req.title, '');
  assert.deepEqual(req.rows, []);
  assert.equal(req.options.filter, true);
});

test('normalisePickerRequest honours filter:false and carries kind/placeholder', () => {
  const req = normalisePickerRequest({
    id: 'p', title: 't', rows: [],
    options: { filter: false, kind: 'recover', placeholder: 'type…' },
  });
  assert.equal(req.options.filter, false);
  assert.equal(req.options.kind, 'recover');
  assert.equal(req.options.placeholder, 'type…');
});

test('normalisePickerRequest drops malformed rows but keeps the good ones', () => {
  const req = normalisePickerRequest({
    id: 'p', title: 't',
    rows: [{ label: 'good', value: 1 }, { value: 2 }, null, 42, 'bare'],
  });
  // The labelled row + the bare-string row survive; the label-less ones drop.
  assert.deepEqual(req.rows.map((r) => r.label), ['good', 'bare']);
});

test('normalisePickerRow: a bare string becomes a label==value row', () => {
  assert.deepEqual(normalisePickerRow('hello'), { label: 'hello', value: 'hello' });
});

test('normalisePickerRow defaults value to the label and carries meta/detail/group/current', () => {
  assert.deepEqual(
    normalisePickerRow({ label: 'x', meta: 'm', detail: 'd', group: 'g', current: true }),
    { label: 'x', value: 'x', meta: 'm', detail: 'd', group: 'g', current: true }
  );
});

test('normalisePickerRow rejects a row with no label', () => {
  assert.equal(normalisePickerRow({ value: 'v' }), null);
  assert.equal(normalisePickerRow(null), null);
  assert.equal(normalisePickerRow(42), null);
});

test('filterPickerRows narrows by label, case-insensitively, preserving order', () => {
  const rows = [
    { label: 'alpha.js', value: 1 },
    { label: 'Beta.md', value: 2 },
    { label: 'gamma.txt', value: 3 },
  ];
  assert.deepEqual(filterPickerRows(rows, 'a').map((r) => r.value), [1, 2, 3]);
  assert.deepEqual(filterPickerRows(rows, 'BET').map((r) => r.value), [2]);
  assert.deepEqual(filterPickerRows(rows, '.md').map((r) => r.value), [2]);
});

test('filterPickerRows: an empty query keeps every row (a fresh copy)', () => {
  const rows = [{ label: 'a', value: 1 }];
  const out = filterPickerRows(rows, '   ');
  assert.deepEqual(out, rows);
  assert.notEqual(out, rows); // a copy, not the same array
});

test('filterPickerRows also matches the meta field', () => {
  const rows = [
    { label: 'scratch', value: 1, meta: '120L ●' },
    { label: 'notes', value: 2, meta: '5L –' },
  ];
  // The ● flag (in meta) narrows to the modified buffer.
  assert.deepEqual(filterPickerRows(rows, '●').map((r) => r.value), [1]);
});

// --- screenful scroll math (C-v / M-v) -----------------------------------

test('screenfulStep is the visible lines minus the context overlap', () => {
  assert.equal(screenfulStep(40), 38); // default context 2
  assert.equal(screenfulStep(40, 0), 40);
  assert.equal(screenfulStep(10, 3), 7);
});

test('screenfulStep falls back to 1 for an unmeasured / tiny viewport', () => {
  assert.equal(screenfulStep(0), 1); // not measured yet
  assert.equal(screenfulStep(2), 1); // 2 - 2 = 0 → clamp to 1
  assert.equal(screenfulStep(NaN), 1);
  assert.equal(screenfulStep(Infinity), 1);
  assert.equal(screenfulStep(-10), 1);
});

test('screenfulScrollLine: page-down moves point down by a screenful', () => {
  // 40-line viewport (step 38), 100-line buffer, point at line 0.
  assert.equal(screenfulScrollLine(0, 100, 40, 1), 38);
  assert.equal(screenfulScrollLine(38, 100, 40, 1), 76);
});

test('screenfulScrollLine: page-up moves point up by a screenful', () => {
  assert.equal(screenfulScrollLine(76, 100, 40, -1), 38);
  assert.equal(screenfulScrollLine(38, 100, 40, -1), 0);
});

test('screenfulScrollLine clamps to the buffer line range', () => {
  // Step (38) overshoots a 20-line buffer → clamp to the last line (19).
  assert.equal(screenfulScrollLine(0, 20, 40, 1), 19);
  // And never below 0.
  assert.equal(screenfulScrollLine(5, 20, 40, -1), 0);
});

test('screenfulScrollLine with no viewport nudges one line (never a no-op)', () => {
  assert.equal(screenfulScrollLine(3, 100, 0, 1), 4);
  assert.equal(screenfulScrollLine(3, 100, 0, -1), 2);
});
