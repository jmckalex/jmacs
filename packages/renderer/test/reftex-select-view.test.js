/**
 * @file Unit tests for the pure helpers of the *RefTeX Select* view
 * (`packages/renderer/src/reftex-select-view.js`). These run under Node
 * with no DOM — `defineViewElement` is a no-op there, so importing the
 * module just exercises the grouping / filtering / type-cycle helpers.
 * The element's keyboard behaviour (n/p movement, RET/SPC, the live
 * filter) is covered by the live hand-off, not here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupHeading,
  filterCandidates,
  distinctTypes,
  groupByType,
  nextTypeFilter,
} from '../src/reftex-select-view.js';

const CANDIDATES = [
  { name: 'eq:euler', type: 'equation', macro: '\\eqref', context: 'e = mc^2' },
  { name: 'eq:gauss', type: 'equation', macro: '\\eqref', context: 'div E = rho' },
  { name: 'fig:plot', type: 'figure', macro: '\\ref', context: 'The big plot' },
  { name: 'sec:intro', type: 'section', macro: '\\ref', context: 'Introduction' },
  { name: 'misc:thing', type: '', macro: '\\ref', context: 'a bare label' },
];

test('groupHeading capitalises the type; typeless groups under Other', () => {
  assert.equal(groupHeading('equation'), 'Equation');
  assert.equal(groupHeading('figure'), 'Figure');
  assert.equal(groupHeading(''), 'Other');
  assert.equal(groupHeading(null), 'Other');
  assert.equal(groupHeading(undefined), 'Other');
});

test('filterCandidates: empty filter + null type keeps everything', () => {
  assert.equal(filterCandidates(CANDIDATES, '', null).length, 5);
});

test('filterCandidates: substring matches the name (case-insensitive)', () => {
  const out = filterCandidates(CANDIDATES, 'EQ:', null);
  assert.deepEqual(out.map((c) => c.name), ['eq:euler', 'eq:gauss']);
});

test('filterCandidates: substring also matches the context line', () => {
  const out = filterCandidates(CANDIDATES, 'introduction', null);
  assert.deepEqual(out.map((c) => c.name), ['sec:intro']);
});

test('filterCandidates: type filter keeps only that exact type', () => {
  const out = filterCandidates(CANDIDATES, '', 'figure');
  assert.deepEqual(out.map((c) => c.name), ['fig:plot']);
});

test('filterCandidates: type + substring compose', () => {
  const out = filterCandidates(CANDIDATES, 'gauss', 'equation');
  assert.deepEqual(out.map((c) => c.name), ['eq:gauss']);
  assert.equal(filterCandidates(CANDIDATES, 'gauss', 'figure').length, 0);
});

test('distinctTypes lists types in first-seen order', () => {
  assert.deepEqual(distinctTypes(CANDIDATES), [
    'equation',
    'figure',
    'section',
    '',
  ]);
});

test('groupByType blocks the candidates by type in first-seen order', () => {
  const groups = groupByType(CANDIDATES);
  assert.deepEqual(
    groups.map((g) => [g.type, g.heading, g.items.length]),
    [
      ['equation', 'Equation', 2],
      ['figure', 'Figure', 1],
      ['section', 'Section', 1],
      ['', 'Other', 1],
    ]
  );
});

test('nextTypeFilter cycles null -> first -> … -> last -> null', () => {
  const types = ['equation', 'figure', 'section', ''];
  assert.equal(nextTypeFilter(null, types), 'equation');
  assert.equal(nextTypeFilter('equation', types), 'figure');
  assert.equal(nextTypeFilter('figure', types), 'section');
  assert.equal(nextTypeFilter('section', types), '');
  assert.equal(nextTypeFilter('', types), null);
});

test('nextTypeFilter with no types stays null', () => {
  assert.equal(nextTypeFilter(null, []), null);
  assert.equal(nextTypeFilter('equation', []), null);
});

test('nextTypeFilter resets to null for an unknown current type', () => {
  assert.equal(nextTypeFilter('mystery', ['equation', 'figure']), null);
});
