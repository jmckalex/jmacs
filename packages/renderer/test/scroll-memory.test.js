/**
 * @file scroll-memory.test.js — the per-buffer viewport memory behind
 * `setView`'s restore-on-return (Emacs's window-start). The DOM half
 * (actually setting `scrollTop`) is exercised live; these tests pin the
 * decision layer: what is remembered, under which identity, and when a
 * caller must fall back to the caret-follow.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createScrollMemory } from '../src/scroll-memory.js';

test('first visit has no memory; a save is recalled', () => {
  const mem = createScrollMemory();
  const buf = { id: 'b1', name: 'long.md' };
  assert.equal(mem.saved(buf), null);
  mem.save(buf, 3000);
  assert.equal(mem.saved(buf), 3000);
});

test('identity is the id, not the object — a rebuilt mirror recalls', () => {
  const mem = createScrollMemory();
  mem.save({ id: 'b1', name: 'long.md' }, 1234);
  // A SNAPSHOT rebuilds the mirror: fresh object, same wire id.
  assert.equal(mem.saved({ id: 'b1', name: 'long.md' }), 1234);
  // A different buffer does not collide.
  assert.equal(mem.saved({ id: 'b2', name: 'other.md' }), null);
});

test('the id wins over the name; the name is the fallback', () => {
  const mem = createScrollMemory();
  // Two same-named buffers with different ids stay separate.
  mem.save({ id: 'b1', name: 'notes.md' }, 100);
  mem.save({ id: 'b2', name: 'notes.md' }, 200);
  assert.equal(mem.saved({ id: 'b1', name: 'notes.md' }), 100);
  assert.equal(mem.saved({ id: 'b2', name: 'notes.md' }), 200);
  // A plain L2 buffer (no id) keys by name…
  mem.save({ name: 'scratch' }, 55);
  assert.equal(mem.saved({ name: 'scratch' }), 55);
  // …and never reads an id-keyed entry.
  assert.equal(mem.saved({ name: 'notes.md' }), null);
});

test('zero is a real memory — a buffer left at the top comes back there', () => {
  const mem = createScrollMemory();
  const buf = { id: 'b1' };
  mem.save(buf, 0);
  assert.equal(mem.saved(buf), 0);
});

test('a later save overwrites; junk is ignored', () => {
  const mem = createScrollMemory();
  const buf = { id: 'b1' };
  mem.save(buf, 100);
  mem.save(buf, 900);
  assert.equal(mem.saved(buf), 900);
  mem.save(buf, NaN); // a hidden/degenerate read must not clobber
  assert.equal(mem.saved(buf), 900);
  // A buffer with no identity is never remembered, and never throws.
  mem.save(null, 10);
  mem.save({}, 10);
  assert.equal(mem.saved(null), null);
  assert.equal(mem.saved({}), null);
});
