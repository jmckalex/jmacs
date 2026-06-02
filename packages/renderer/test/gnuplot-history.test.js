import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHistory } from '../src/gnuplot-history.js';

test('a fresh history yields the current line unchanged on up/down', () => {
  const h = createHistory();
  assert.equal(h.up('typing'), 'typing');
  assert.equal(h.down('typing'), '');
  assert.deepEqual(h.entries(), []);
});

test('push records non-blank commands and ignores blank ones', () => {
  const h = createHistory();
  h.push('plot sin(x)');
  h.push('   '); // whitespace-only — ignored
  h.push('');
  h.push('plot cos(x)');
  assert.deepEqual(h.entries(), ['plot sin(x)', 'plot cos(x)']);
});

test('up walks toward older entries and stops at the oldest', () => {
  const h = createHistory();
  h.push('a');
  h.push('b');
  h.push('c');
  assert.equal(h.up(''), 'c');
  assert.equal(h.up(''), 'b');
  assert.equal(h.up(''), 'a');
  assert.equal(h.up(''), 'a', 'stays at the oldest entry');
});

test('down walks back toward the live line and restores the stashed draft', () => {
  const h = createHistory();
  h.push('first');
  h.push('second');
  // Start typing a new line, then arrow up — the draft is stashed.
  assert.equal(h.up('half-typed'), 'second');
  assert.equal(h.up('half-typed'), 'first');
  // Walk back down: second, then the live line (the draft).
  assert.equal(h.down('first'), 'second');
  assert.equal(h.down('second'), 'half-typed');
});

test('down past the live line keeps returning the draft', () => {
  const h = createHistory();
  h.push('only');
  assert.equal(h.up('draft'), 'only');
  assert.equal(h.down('only'), 'draft');
  assert.equal(h.down('draft'), 'draft', 'no underflow past the live line');
});

test('a fresh draft is captured on each first up from the live line', () => {
  const h = createHistory();
  h.push('cmd');
  // First excursion with one draft.
  assert.equal(h.up('draft-one'), 'cmd');
  assert.equal(h.down('cmd'), 'draft-one');
  // Second excursion stashes a different draft.
  assert.equal(h.up('draft-two'), 'cmd');
  assert.equal(h.down('cmd'), 'draft-two');
});

test('push after browsing resets the cursor to the live line', () => {
  const h = createHistory();
  h.push('a');
  h.push('b');
  h.up(''); // -> 'b'
  h.up(''); // -> 'a'
  h.push('c'); // submit a new command mid-browse
  assert.equal(h.index(), 3, 'cursor parked at the live line');
  // Up should now start from the newest entry again.
  assert.equal(h.up(''), 'c');
});

test('reset parks the cursor at the live line and clears the draft', () => {
  const h = createHistory();
  h.push('x');
  h.up('mid'); // stash draft, move to 'x'
  h.reset();
  assert.equal(h.index(), 1);
  // After reset, down from the live line returns the cleared draft ('').
  assert.equal(h.down('x'), '');
});

test('entries returns a copy that cannot mutate internal state', () => {
  const h = createHistory();
  h.push('a');
  const snapshot = h.entries();
  snapshot.push('hacked');
  assert.deepEqual(h.entries(), ['a']);
});
