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
