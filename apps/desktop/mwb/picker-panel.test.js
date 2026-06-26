/**
 * @file Tests for the generic PICKER panel's PURE interaction core (G0b).
 * The DOM half (createPickerPanel) is verified live + by the electron
 * self-test; these cover the filter/selection state machine that drives it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickerView, moveSelection } from './picker-panel.js';

const ROWS = [
  { label: 'scratch.txt', value: 'b0', meta: '1L –' },
  { label: 'x.js', value: 'b1', meta: '3L –', current: true },
  { label: 'notes.md', value: 'b2', meta: '5L ●' },
];

test('pickerView with no query selects the current row', () => {
  const { visible, selected } = pickerView(ROWS, '', null);
  assert.equal(visible.length, 3);
  assert.equal(visible[selected].value, 'b1'); // the current buffer
});

test('pickerView with no query + no current row selects the first', () => {
  const rows = ROWS.map((r) => ({ ...r, current: false }));
  const { selected } = pickerView(rows, '', null);
  assert.equal(selected, 0);
});

test('pickerView narrows to matching rows and selects the first match', () => {
  const { visible, selected } = pickerView(ROWS, 'note', null);
  assert.deepEqual(visible.map((r) => r.value), ['b2']);
  assert.equal(selected, 0);
});

test('pickerView keeps the selection on a value that survives the filter', () => {
  // Previously selected b2; filter to ".md"/".txt" — b2 survives, stays selected.
  const { visible, selected } = pickerView(ROWS, 'm', 'b2');
  assert.equal(visible[selected].value, 'b2');
});

test('pickerView falls back to the first match when the prior value is filtered out', () => {
  // prev = b0 (scratch), but filter ".js" leaves only b1.
  const { visible, selected } = pickerView(ROWS, 'js', 'b0');
  assert.deepEqual(visible.map((r) => r.value), ['b1']);
  assert.equal(selected, 0);
});

test('pickerView returns selected=-1 when nothing matches', () => {
  const { visible, selected } = pickerView(ROWS, 'zzz', null);
  assert.equal(visible.length, 0);
  assert.equal(selected, -1);
});

test('moveSelection clamps at the ends (no wrap)', () => {
  assert.equal(moveSelection(0, -1, 3), 0); // already at top
  assert.equal(moveSelection(2, 1, 3), 2); // already at bottom
  assert.equal(moveSelection(0, 1, 3), 1);
  assert.equal(moveSelection(2, -1, 3), 1);
});

test('moveSelection pages within bounds', () => {
  assert.equal(moveSelection(0, 8, 3), 2); // page down past the end → last
  assert.equal(moveSelection(2, -8, 3), 0); // page up past the top → first
});

test('moveSelection on an empty list is -1', () => {
  assert.equal(moveSelection(0, 1, 0), -1);
});
