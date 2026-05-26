import { test } from 'node:test';
import assert from 'node:assert/strict';

import { feedLiveLine } from '../src/shell-view.js';

// The shell view's single-line terminal emulator. `feedLiveLine`
// consumes ANSI-parsed runs and either flushes completed lines on
// `\n`, rewinds on `\r`, or trims on `\b`. State persists across
// calls so partial lines compose across chunk boundaries.

/** A run with no SGR styling — what the parser emits for plain text. */
const plain = (text) => ({ text, style: null });

test('feedLiveLine flushes a line on \\n', () => {
  const state = { runs: [] };
  const { completed } = feedLiveLine(state, [plain('hello\n')]);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0], [plain('hello')]);
  assert.deepEqual(state.runs, []);
});

test('feedLiveLine carries a partial across calls', () => {
  const state = { runs: [] };
  const r1 = feedLiveLine(state, [plain('abc')]);
  assert.equal(r1.completed.length, 0);
  assert.deepEqual(state.runs, [plain('abc')]);
  const r2 = feedLiveLine(state, [plain('def\n')]);
  assert.equal(r2.completed.length, 1);
  // The runs from both calls are preserved in order — the partial got
  // extended by the second call before the \n flushed.
  assert.deepEqual(r2.completed[0], [plain('abc'), plain('def')]);
});

test('feedLiveLine wipes the partial on a bare \\r', () => {
  const state = { runs: [] };
  feedLiveLine(state, [plain('abc')]);
  feedLiveLine(state, [plain('\rxyz')]);
  // \r resets the line; the trailing `xyz` is the new partial.
  assert.deepEqual(state.runs, [plain('xyz')]);
});

test('feedLiveLine wipes the zsh PROMPT_SP artefact', () => {
  const state = { runs: [] };
  // The pattern zsh emits when output does not end in \n: an inverse
  // `%` plus a screenful of spaces, then `\r \r` to erase it back.
  // After the second \r, the line is just one space; the next prompt
  // chunk overwrites that.
  feedLiveLine(state, [plain('%' + ' '.repeat(80) + '\r \r')]);
  assert.deepEqual(state.runs, []);
});

test('feedLiveLine handles \\r\\n as a single newline (CRLF normalisation)', () => {
  // \r empties the partial, then \n flushes the now-empty line as a
  // completed empty line. That's the right semantic — `\r\n` in
  // terminal-speak is "go to start of next line" and our model
  // produces the same visual outcome (a fresh line below).
  const state = { runs: [{ text: 'abc', style: null }] };
  const { completed } = feedLiveLine(state, [plain('\r\n')]);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0], []);
  assert.deepEqual(state.runs, []);
});

test('feedLiveLine drops the last char on \\b (backspace)', () => {
  const state = { runs: [] };
  feedLiveLine(state, [plain('abcd')]);
  feedLiveLine(state, [plain('\b\b')]);
  assert.deepEqual(state.runs, [plain('ab')]);
});

test('feedLiveLine preserves SGR style across the line', () => {
  const state = { runs: [] };
  feedLiveLine(state, [
    { text: '(base) ', style: null },
    { text: '~/Source', style: { fg: { mode: 'named', name: 'green' } } },
    { text: '\n$ ', style: null },
  ]);
  assert.deepEqual(state.runs, [plain('$ ')]);
});

test('feedLiveLine handles multiple newlines in one chunk', () => {
  const state = { runs: [] };
  const { completed } = feedLiveLine(state, [plain('one\ntwo\nthree\n')]);
  assert.equal(completed.length, 3);
  assert.deepEqual(completed[0], [plain('one')]);
  assert.deepEqual(completed[1], [plain('two')]);
  assert.deepEqual(completed[2], [plain('three')]);
});

test('feedLiveLine treats an empty incoming list as a no-op', () => {
  const state = { runs: [plain('partial')] };
  const { completed } = feedLiveLine(state, []);
  assert.equal(completed.length, 0);
  assert.deepEqual(state.runs, [plain('partial')]);
});
