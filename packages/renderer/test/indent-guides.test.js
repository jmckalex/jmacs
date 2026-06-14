/**
 * @file Unit tests for the pure indent-guide computation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  lineIndentColumns,
  computeIndentGuides,
} from '../src/indent-guides.js';

test('lineIndentColumns counts spaces and expands tabs to the tab stop', () => {
  assert.equal(lineIndentColumns('    code', 4), 4);
  assert.equal(lineIndentColumns('\tcode', 4), 4); // one tab -> next stop
  assert.equal(lineIndentColumns('  \tcode', 4), 4); // 2 spaces then tab -> 4
  assert.equal(lineIndentColumns('code', 4), 0);
  assert.equal(lineIndentColumns('', 4), null); // empty -> blank
  assert.equal(lineIndentColumns('    ', 4), null); // all whitespace -> blank
});

test('computeIndentGuides draws a guide at each tab stop past col 0', () => {
  // indent 0, 4, 8, 8, 4, 0 — a function with a nested if. No col-0 guide:
  // only col 4 (rows indented past 4) survives. Nothing is past 8.
  const indents = [0, 4, 8, 8, 4, 0];
  const guides = computeIndentGuides(indents, 4);
  assert.deepEqual(guides, [{ col: 4, start: 2, end: 3 }]);
});

test('computeIndentGuides bridges a blank line inside a block', () => {
  // A blank row between two indent-8 rows keeps the col-4 guide unbroken.
  const indents = [4, 8, null, 8, 4];
  const guides = computeIndentGuides(indents, 4);
  assert.deepEqual(guides, [{ col: 4, start: 1, end: 3 }]);
});

test('computeIndentGuides bridges the blank below a header (max rule)', () => {
  // The reported bug: a blank between an indent-8 header and its indent-12
  // body. The blank inherits max(8,12)=12, so the col-8 guide is drawn
  // through it (rows 2..3) — no gap right below the header.
  const indents = [4, 8, null, 12, 8, 4];
  const guides = computeIndentGuides(indents, 4).sort(
    (a, b) => a.col - b.col || a.start - b.start
  );
  assert.deepEqual(guides, [
    { col: 4, start: 1, end: 4 },
    { col: 8, start: 2, end: 3 }, // bridges the blank below the header
  ]);
});

test('computeIndentGuides splits a guide around an interrupting outdent', () => {
  // Two indent-8 blocks separated by an indent-4 line: two col-4 segments.
  const indents = [8, 8, 4, 8, 8];
  const guides = computeIndentGuides(indents, 4);
  assert.deepEqual(guides, [
    { col: 4, start: 0, end: 1 },
    { col: 4, start: 3, end: 4 },
  ]);
});

test('computeIndentGuides returns nothing for flat or empty input', () => {
  assert.deepEqual(computeIndentGuides([0, 0, 0], 4), []);
  assert.deepEqual(computeIndentGuides([4, 4], 4), []); // only col-0 would apply
  assert.deepEqual(computeIndentGuides([], 4), []);
  assert.deepEqual(computeIndentGuides([8, 8], 0), []); // guard tabWidth
});
