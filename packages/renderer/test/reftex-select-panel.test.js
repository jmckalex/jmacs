/**
 * @file Unit tests for the pure helpers of the *RefTeX Select* panel
 * (`packages/renderer/src/reftex-select-panel.js`). These run under Node
 * with no DOM — importing the module just exercises the grouping /
 * filtering / type-cycle helpers and the pure key→action mapping
 * (`mapReftexKey`). The panel's DOM behaviour (rendering, highlight
 * movement, the right-edge overlay slide-in and the SPC peek that drives
 * the editor underneath) is covered by the live hand-off, not here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupHeading,
  filterCandidates,
  distinctTypes,
  groupByType,
  nextTypeFilter,
  mapReftexKey,
} from '../src/reftex-select-panel.js';

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

// --- mapReftexKey: the pure key→action mapping the overlay routes through.

test('mapReftexKey: n/down move forward, p/up move back', () => {
  assert.deepEqual(mapReftexKey('n'), { type: 'move', delta: 1 });
  assert.deepEqual(mapReftexKey('Down'), { type: 'move', delta: 1 });
  assert.deepEqual(mapReftexKey('ArrowDown'), { type: 'move', delta: 1 });
  assert.deepEqual(mapReftexKey('p'), { type: 'move', delta: -1 });
  assert.deepEqual(mapReftexKey('Up'), { type: 'move', delta: -1 });
  assert.deepEqual(mapReftexKey('ArrowUp'), { type: 'move', delta: -1 });
});

test('mapReftexKey: RET/Enter select; SPC/Space peek', () => {
  assert.deepEqual(mapReftexKey('RET'), { type: 'select' });
  assert.deepEqual(mapReftexKey('Enter'), { type: 'select' });
  assert.deepEqual(mapReftexKey('SPC'), { type: 'peek' });
  assert.deepEqual(mapReftexKey(' '), { type: 'peek' });
  assert.deepEqual(mapReftexKey('Space'), { type: 'peek' });
});

test('mapReftexKey: t cycles type; q/Escape cancel', () => {
  assert.deepEqual(mapReftexKey('t'), { type: 'cycle-type' });
  assert.deepEqual(mapReftexKey('q'), { type: 'cancel' });
  assert.deepEqual(mapReftexKey('Escape'), { type: 'cancel' });
  assert.deepEqual(mapReftexKey('Esc'), { type: 'cancel' });
});

test('mapReftexKey: Backspace/Delete edit the filter', () => {
  assert.deepEqual(mapReftexKey('Backspace'), { type: 'backspace' });
  assert.deepEqual(mapReftexKey('Delete'), { type: 'backspace' });
  assert.deepEqual(mapReftexKey('DEL'), { type: 'backspace' });
});

test('mapReftexKey: a printable single char extends the substring filter', () => {
  assert.deepEqual(mapReftexKey('a'), { type: 'filter', char: 'a' });
  assert.deepEqual(mapReftexKey('Z'), { type: 'filter', char: 'Z' });
  assert.deepEqual(mapReftexKey(':'), { type: 'filter', char: ':' });
  // The single space is peek, not a filter char (matches RefTeX SPC).
  assert.deepEqual(mapReftexKey(' '), { type: 'peek' });
});

test('mapReftexKey: a multi-char non-action key is not a picker key', () => {
  assert.equal(mapReftexKey('Tab'), null);
  assert.equal(mapReftexKey('Home'), null);
  assert.equal(mapReftexKey('PageDown'), null);
});
