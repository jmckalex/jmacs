/**
 * @file Tests for the notebook view's pure helpers. The DOM factory
 * (`createNotebookView`) is a custom-element component exercised live /
 * by the smoke arm; there's no jsdom in this repo. These tests cover the
 * surface-independent logic: source ⇄ cells round-tripping, the
 * chord-forward predicate, and badge mapping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  topLevelForms,
  cellsFromSource,
  serializeCells,
  shouldForwardChord,
  badgeForState,
  moveItem,
} from '../src/notebook-view.js';

// --- topLevelForms ------------------------------------------------------

test('topLevelForms splits balanced top-level forms', () => {
  const forms = topLevelForms('(cell x 3) (cell y (* (ref \'x) 4))');
  assert.equal(forms.length, 2);
  assert.equal(forms[0], '(cell x 3)');
  assert.equal(forms[1], "(cell y (* (ref 'x) 4))");
});

test('topLevelForms ignores ) and ; inside strings and comments', () => {
  const forms = topLevelForms('(cell s "a)b;c") ; trailing comment )\n(cell t 1)');
  assert.equal(forms.length, 2);
  assert.equal(forms[0], '(cell s "a)b;c")');
  assert.equal(forms[1], '(cell t 1)');
});

// --- cellsFromSource ----------------------------------------------------

test('cellsFromSource extracts name + raw expr', () => {
  const cells = cellsFromSource('(cell x 3)\n\n(cell area (* pi radius radius))');
  assert.deepEqual(cells, [
    { name: 'x', expr: '3' },
    { name: 'area', expr: '(* pi radius radius)' },
  ]);
});

test('cellsFromSource ignores non-cell forms', () => {
  const cells = cellsFromSource('(define z 1) (cell y 2) (random)');
  assert.deepEqual(cells, [{ name: 'y', expr: '2' }]);
});

test('cellsFromSource preserves a multi-line expression', () => {
  const cells = cellsFromSource('(cell f\n  (+ 1\n     2))');
  assert.equal(cells.length, 1);
  assert.equal(cells[0].name, 'f');
  assert.equal(cells[0].expr, '(+ 1\n     2)');
});

// --- serializeCells -----------------------------------------------------

test('serializeCells writes (cell NAME EXPR) forms, blank-separated', () => {
  const source = serializeCells([
    { name: 'x', expr: '3' },
    { name: 'y', expr: "(* (ref 'x) 4)" },
  ]);
  assert.equal(source, "(cell x 3)\n\n(cell y (* (ref 'x) 4))");
});

test('serializeCells drops cells with an empty name or expr, and trims', () => {
  const source = serializeCells([
    { name: '  x  ', expr: '  3 ' },
    { name: '', expr: '99' },
    { name: 'y', expr: '   ' },
  ]);
  assert.equal(source, '(cell x 3)');
});

test('serialize → parse round-trips', () => {
  const cells = [
    { name: 'a', expr: '1' },
    { name: 'b', expr: "(+ (ref 'a) 2)" },
  ];
  assert.deepEqual(cellsFromSource(serializeCells(cells)), cells);
});

// --- shouldForwardChord -------------------------------------------------

const ev = (over) => ({
  key: 'a',
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

test('shouldForwardChord forwards Ctrl/Alt chords, not plain typing', () => {
  const noChord = () => false;
  assert.equal(shouldForwardChord(ev({ key: 'b', ctrlKey: true }), noChord), true);
  assert.equal(shouldForwardChord(ev({ key: 'x', altKey: true }), noChord), true);
  assert.equal(shouldForwardChord(ev({ key: 'a' }), noChord), false);
  // A bare modifier keydown is never forwarded.
  assert.equal(shouldForwardChord(ev({ key: 'Control', ctrlKey: true }), noChord), false);
});

test('shouldForwardChord forwards any key mid-chord (prefix continuation)', () => {
  const chordPending = () => true;
  // '3' carries no modifier, but a prefix (C-x) is in flight → forward it.
  assert.equal(shouldForwardChord(ev({ key: '3' }), chordPending), true);
  // …still never a bare modifier.
  assert.equal(shouldForwardChord(ev({ key: 'Shift', shiftKey: true }), chordPending), false);
});

// --- moveItem -----------------------------------------------------------

test('moveItem reorders within bounds and is a no-op at the edges', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  // off the top / bottom → unchanged copy
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
  // returns a fresh array (no mutation)
  const src = ['a', 'b'];
  assert.notEqual(moveItem(src, 0, 1), src);
  assert.deepEqual(src, ['a', 'b']);
});

// --- badgeForState ------------------------------------------------------

test('badgeForState distinguishes ok / stale / error / cycle', () => {
  assert.equal(badgeForState('ok').cls, 'notebook-badge-ok');
  assert.equal(badgeForState('stale').cls, 'notebook-badge-stale');
  assert.equal(badgeForState('error', 'boom').cls, 'notebook-badge-error');
  assert.equal(badgeForState('error', 'cycle: a -> b -> a').cls, 'notebook-badge-cycle');
});
