/**
 * @file output-panel.test.js — unit tests for the pure `appendLines` helper
 * (streaming append + scrollback cap). The DOM panel is exercised live.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appendLines } from '../src/output-panel.js';

test('appendLines splits a multi-line chunk into lines', () => {
  assert.deepEqual(appendLines([''], 'a\nb\nc'), ['a', 'b', 'c']);
});

test('appendLines treats the last line as open and continues it', () => {
  // Streaming "foo" then "bar\nbaz" must reconstruct the same lines as one
  // write of "foobar\nbaz".
  let lines = appendLines([''], 'foo');
  assert.deepEqual(lines, ['foo']);
  lines = appendLines(lines, 'bar\nbaz');
  assert.deepEqual(lines, ['foobar', 'baz']);
});

test('appendLines from an empty/garbage base starts a single open line', () => {
  assert.deepEqual(appendLines([], 'x'), ['x']);
  assert.deepEqual(appendLines(undefined, 'x'), ['x']);
});

test('appendLines tolerates a null/empty chunk', () => {
  assert.deepEqual(appendLines(['a'], null), ['a']);
  assert.deepEqual(appendLines(['a'], ''), ['a']);
});

test('appendLines caps scrollback to the last maxLines lines', () => {
  let lines = [''];
  for (let i = 1; i <= 10; i += 1) lines = appendLines(lines, `line${i}\n`, 3);
  // After "line10\n" the open trailing line is '' — keep the last 3.
  assert.deepEqual(lines, ['line9', 'line10', '']);
});

test('appendLines with maxLines<=0 keeps everything', () => {
  // The open last line 'b' is continued by the first segment 'c' → 'bc'.
  const lines = appendLines(['a', 'b'], 'c\nd', 0);
  assert.deepEqual(lines, ['a', 'bc', 'd']);
});
