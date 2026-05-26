import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseCarriageReturns,
  sanitiseShellOutput,
  stripAnsi,
} from '../src/shell-view.js';

test('stripAnsi removes a colour CSI sequence', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
});

test('stripAnsi removes a cursor-move CSI sequence', () => {
  assert.equal(stripAnsi('hello\x1b[2Kclear'), 'helloclear');
});

test('stripAnsi removes an OSC title sequence (BEL-terminated)', () => {
  assert.equal(stripAnsi('a\x1b]0;title\x07b'), 'ab');
});

test('stripAnsi removes an OSC title sequence (ST-terminated)', () => {
  assert.equal(stripAnsi('a\x1b]0;title\x1b\\b'), 'ab');
});

test('stripAnsi leaves plain text alone', () => {
  assert.equal(stripAnsi('no escapes here'), 'no escapes here');
});

test('stripAnsi handles empty and non-string input', () => {
  assert.equal(stripAnsi(''), '');
  assert.equal(stripAnsi(null), null);
  assert.equal(stripAnsi(undefined), undefined);
});

test('normaliseCarriageReturns turns CRLF into LF', () => {
  assert.equal(normaliseCarriageReturns('a\r\nb\r\nc'), 'a\nb\nc');
});

test('normaliseCarriageReturns drops bare CR', () => {
  // A bare CR is a cursor-to-column-zero in real terminals; we drop it.
  assert.equal(normaliseCarriageReturns('progress\rdone'), 'progressdone');
});

test('sanitiseShellOutput combines ANSI strip and CR normalisation', () => {
  const input = '\x1b[32mok\x1b[0m\r\nnext\r\n';
  assert.equal(sanitiseShellOutput(input), 'ok\nnext\n');
});
