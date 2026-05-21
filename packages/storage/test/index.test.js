import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '../src/index.js';

test('createBuffer with no argument is empty', () => {
  const buf = createBuffer();
  assert.equal(buf.toString(), '');
});

test('createBuffer seeds with initial text', () => {
  const buf = createBuffer('hello world');
  assert.equal(buf.toString(), 'hello world');
});

test('createBuffer rejects a non-string seed', () => {
  assert.throws(() => createBuffer(42), TypeError);
});

test('insert in the middle', () => {
  const buf = createBuffer('hello world');
  buf.insert(5, ',');
  assert.equal(buf.toString(), 'hello, world');
});

test('insert at the start', () => {
  const buf = createBuffer('world');
  buf.insert(0, 'hello ');
  assert.equal(buf.toString(), 'hello world');
});

test('insert at the end appends', () => {
  const buf = createBuffer('hello');
  buf.insert(5, ' world');
  assert.equal(buf.toString(), 'hello world');
});

test('inserting an empty string is a no-op', () => {
  const buf = createBuffer('unchanged');
  buf.insert(3, '');
  assert.equal(buf.toString(), 'unchanged');
});

test('successive inserts compose', () => {
  const buf = createBuffer('ac');
  buf.insert(1, 'b');
  buf.insert(3, 'd');
  assert.equal(buf.toString(), 'abcd');
});

test('insert rejects an out-of-range position', () => {
  const buf = createBuffer('short');
  assert.throws(() => buf.insert(6, 'x'), RangeError);
  assert.throws(() => buf.insert(-1, 'x'), RangeError);
});

test('insert rejects a non-integer position', () => {
  const buf = createBuffer('text');
  assert.throws(() => buf.insert(1.5, 'x'), TypeError);
});

test('insert rejects non-string text', () => {
  const buf = createBuffer('text');
  assert.throws(() => buf.insert(0, 99), TypeError);
});
