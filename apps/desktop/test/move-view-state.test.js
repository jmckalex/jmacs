/**
 * @file Tests for the pure swap-views / permute-views digit-entry state
 * machine (../src/move-view-state.js). No DOM — exercises the entry
 * logic directly: unambiguous-prefix auto-accept, multi-digit panes,
 * the bijection constraint, the forced permute last destination, undo,
 * and commit/abort.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMoveViewState,
  reduce,
  isReady,
  currentSource,
  committedAssignments,
  candidateNumbers,
} from '../src/move-view-state.js';

const d = (digit) => ({ type: 'digit', digit });
const SPACE = { type: 'space' };
const BS = { type: 'backspace' };
const ENTER = { type: 'enter' };
const CANCEL = { type: 'cancel' };

/** Fold a sequence of events; return the final {state, effect}. */
function run(state, events) {
  let s = state;
  let effect = { type: 'none' };
  for (const event of events) {
    const r = reduce(s, event);
    s = r.state;
    effect = r.effect;
  }
  return { state: s, effect };
}

// --- swap -------------------------------------------------------------------

test('swap: two single-key picks commit on Enter', () => {
  const r = run(createMoveViewState('swap', 4), [d('2'), d('4'), ENTER]);
  assert.deepEqual(r.effect, { type: 'commit', assignments: [2, 4] });
});

test('swap: ready after two picks but commits only on Enter', () => {
  let r = run(createMoveViewState('swap', 4), [d('1'), d('3')]);
  assert.equal(isReady(r.state), true);
  assert.deepEqual(r.effect, { type: 'none' });
  r = reduce(r.state, ENTER);
  assert.deepEqual(r.effect, { type: 'commit', assignments: [1, 3] });
});

test('swap: backspace with empty pending undoes the last pick', () => {
  let r = run(createMoveViewState('swap', 4), [d('1'), d('3')]);
  assert.deepEqual(r.state.entries, [1, 3]);
  r = reduce(r.state, BS);
  assert.deepEqual(r.state.entries, [1]);
});

test('swap: Enter before enough entries beeps', () => {
  const r = reduce(reduce(createMoveViewState('swap', 4), d('1')).state, ENTER);
  assert.deepEqual(r.effect, { type: 'beep' });
});

test('swap: a number already taken cannot be re-entered', () => {
  let r = reduce(createMoveViewState('swap', 4), d('2')); // entries [2]
  r = reduce(r.state, d('2')); // "2" no longer available
  assert.deepEqual(r.effect, { type: 'beep' });
  assert.deepEqual(r.state.entries, [2]);
});

// --- multi-digit (N > 9) ----------------------------------------------------

test('n=12: ambiguous prefix waits; Space force-accepts it', () => {
  let r = reduce(createMoveViewState('permute', 12), d('1'));
  assert.equal(r.state.pending, '1'); // 1 is a prefix of 10/11/12 → wait
  assert.deepEqual(r.effect, { type: 'none' });
  r = reduce(r.state, SPACE);
  assert.deepEqual(r.state.entries, [1]);
  assert.equal(r.state.pending, '');
});

test('n=12: typing 1 then 2 auto-accepts 12', () => {
  const r = run(createMoveViewState('permute', 12), [d('1'), d('2')]);
  assert.deepEqual(r.state.entries, [12]);
});

test('rejects a digit with no possible completion', () => {
  const r = reduce(createMoveViewState('swap', 5), d('9'));
  assert.deepEqual(r.effect, { type: 'beep' });
  assert.equal(r.state.pending, '');
});

test('candidateNumbers narrows as digits are typed', () => {
  const s0 = createMoveViewState('permute', 12);
  assert.deepEqual(
    candidateNumbers(s0),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  );
  const r = reduce(s0, d('1'));
  assert.deepEqual(candidateNumbers(r.state), [1, 10, 11, 12]);
});

test('Enter accepts a valid pending number, then commits', () => {
  let r = run(createMoveViewState('swap', 12), [d('5')]); // entries [5]
  r = reduce(r.state, d('1')); // pending "1" (ambiguous)
  assert.equal(r.state.pending, '1');
  r = reduce(r.state, ENTER); // accept 1, then commit
  assert.deepEqual(r.effect, { type: 'commit', assignments: [5, 1] });
});

// --- permute ----------------------------------------------------------------

test('permute: forced last destination is derived on commit', () => {
  let r = run(createMoveViewState('permute', 3), [d('2'), d('3')]);
  assert.equal(isReady(r.state), true); // n-1 = 2 entries
  assert.equal(currentSource(r.state), null);
  assert.deepEqual(committedAssignments(r.state), [2, 3, 1]);
  r = reduce(r.state, ENTER);
  assert.deepEqual(r.effect, { type: 'commit', assignments: [2, 3, 1] });
});

test('permute: currentSource walks 1, 2, … as entries are made', () => {
  const s0 = createMoveViewState('permute', 4);
  assert.equal(currentSource(s0), 1);
  let r = reduce(s0, d('3')); // pane 1 → 3
  assert.equal(currentSource(r.state), 2);
  r = reduce(r.state, d('1')); // pane 2 → 1
  assert.equal(currentSource(r.state), 3);
});

test('permute: backspace steps back a source assignment', () => {
  let r = run(createMoveViewState('permute', 4), [d('3'), d('1')]);
  assert.deepEqual(r.state.entries, [3, 1]);
  r = reduce(r.state, BS);
  assert.deepEqual(r.state.entries, [3]);
  assert.equal(currentSource(r.state), 2);
});

// --- cancel -----------------------------------------------------------------

test('cancel aborts at any point', () => {
  const r = reduce(reduce(createMoveViewState('permute', 3), d('2')).state, CANCEL);
  assert.deepEqual(r.effect, { type: 'abort' });
});
