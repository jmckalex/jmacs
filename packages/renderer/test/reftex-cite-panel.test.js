/**
 * @file reftex-cite-panel.test.js — unit tests for the pure helpers of
 * the RefTeX citation panels (format menu + cite picker). The DOM
 * factories are exercised by the smoke arm; the key→action mapping,
 * format-key matching, row filtering, and "marked-or-current" selection
 * rule are tested here without a DOM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchCiteFormatKey,
  filterCiteRows,
  citeKeysToInsert,
  mapCiteKey,
} from '../src/reftex-cite-panel.js';

const FORMATS = [
  { key: 'enter', macro: '\\cite', desc: 'default' },
  { key: 'p', macro: '\\citep', desc: 'paren' },
  { key: 'P', macro: '\\parencite', desc: 'biblatex paren' },
  { key: 't', macro: '\\citet', desc: 'textual' },
];

const ROWS = [
  { key: 'lee2021', html: '<i>A</i>', plain: 'lee2021 jane lee 2021 a theory' },
  { key: 'patel2020', html: '<i>F</i>', plain: 'patel2020 riya patel 2020 foundations' },
  { key: 'smith2019', html: '<i>M</i>', plain: 'smith2019 bob smith 2019 methods' },
];

// --- matchCiteFormatKey -----------------------------------------------

test('matchCiteFormatKey maps a format key to its macro', () => {
  assert.equal(matchCiteFormatKey('enter', FORMATS), '\\cite');
  assert.equal(matchCiteFormatKey('p', FORMATS), '\\citep');
  assert.equal(matchCiteFormatKey('t', FORMATS), '\\citet');
});

test('matchCiteFormatKey is case-sensitive (p vs P)', () => {
  assert.equal(matchCiteFormatKey('P', FORMATS), '\\parencite');
  assert.notEqual(matchCiteFormatKey('P', FORMATS), matchCiteFormatKey('p', FORMATS));
});

test('matchCiteFormatKey returns null for an unbound key', () => {
  assert.equal(matchCiteFormatKey('z', FORMATS), null);
  assert.equal(matchCiteFormatKey('q', FORMATS), null);
});

// --- filterCiteRows ---------------------------------------------------

test('filterCiteRows matches key and plain text, case-insensitively', () => {
  assert.deepEqual(filterCiteRows(ROWS, 'patel').map((r) => r.key), ['patel2020']);
  assert.deepEqual(filterCiteRows(ROWS, 'METHODS').map((r) => r.key), ['smith2019']);
  assert.deepEqual(filterCiteRows(ROWS, '2021').map((r) => r.key), ['lee2021']);
});

test('an empty filter returns every row', () => {
  assert.equal(filterCiteRows(ROWS, '').length, 3);
  assert.equal(filterCiteRows(ROWS, null).length, 3);
});

// --- citeKeysToInsert (marked, or current) ----------------------------

test('citeKeysToInsert returns the current key when nothing is marked', () => {
  assert.deepEqual(citeKeysToInsert(ROWS, new Set(), 'patel2020'), ['patel2020']);
});

test('citeKeysToInsert returns marked keys in index order when any are marked', () => {
  const marked = new Set(['smith2019', 'lee2021']);
  // Current key is irrelevant when there are marks; order follows the index.
  assert.deepEqual(citeKeysToInsert(ROWS, marked, 'patel2020'), ['lee2021', 'smith2019']);
});

test('citeKeysToInsert collects a marked key even when it is filtered out', () => {
  // The marked key need not be among the currently shown rows — it is
  // collected from the full index passed in.
  const marked = new Set(['smith2019']);
  assert.deepEqual(citeKeysToInsert(ROWS, marked, 'lee2021'), ['smith2019']);
});

test('citeKeysToInsert is empty when nothing marked and no current key', () => {
  assert.deepEqual(citeKeysToInsert(ROWS, new Set(), null), []);
  assert.deepEqual(citeKeysToInsert([], new Set(), null), []);
});

// --- mapCiteKey -------------------------------------------------------

test('mapCiteKey covers move / mark / insert / cancel / filter', () => {
  assert.deepEqual(mapCiteKey('n'), { type: 'move', delta: 1 });
  assert.deepEqual(mapCiteKey('down'), { type: 'move', delta: 1 });
  assert.deepEqual(mapCiteKey('p'), { type: 'move', delta: -1 });
  assert.deepEqual(mapCiteKey('up'), { type: 'move', delta: -1 });
  assert.deepEqual(mapCiteKey('m'), { type: 'mark' });
  assert.deepEqual(mapCiteKey('enter'), { type: 'insert' });
  assert.deepEqual(mapCiteKey('q'), { type: 'cancel' });
  assert.deepEqual(mapCiteKey('escape'), { type: 'cancel' });
  assert.deepEqual(mapCiteKey('backspace'), { type: 'backspace' });
  assert.deepEqual(mapCiteKey('a'), { type: 'filter', char: 'a' });
  assert.equal(mapCiteKey('f1'), null);
});
