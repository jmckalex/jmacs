import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseCarriageReturns } from '../src/shell-view.js';

// v1's stripAnsi / sanitiseShellOutput tests are gone — the strip
// pipeline was replaced by a real ANSI parser (see ansi.test.js).
// normaliseCarriageReturns survives because pty output still uses \r
// to redraw the current line, and we want a transcript-friendly fold.

test('normaliseCarriageReturns turns CRLF into LF', () => {
  assert.equal(normaliseCarriageReturns('a\r\nb\r\nc'), 'a\nb\nc');
});

test('normaliseCarriageReturns turns a bare CR into a newline', () => {
  // v2 behaviour: a mid-stream CR is a "redraw current line" in real
  // terminals. The transcript is line-oriented; we can't redraw, so we
  // turn the CR into a newline so the following content lands on a
  // fresh line rather than vanishing (v1) or overwriting (the real
  // terminal behaviour we can't reproduce).
  assert.equal(normaliseCarriageReturns('progress\rdone'), 'progress\ndone');
});

test('normaliseCarriageReturns is a no-op on empty / non-string input', () => {
  assert.equal(normaliseCarriageReturns(''), '');
  assert.equal(normaliseCarriageReturns(null), null);
  assert.equal(normaliseCarriageReturns(undefined), undefined);
});

test('normaliseCarriageReturns leaves plain text alone', () => {
  assert.equal(normaliseCarriageReturns('no carriage returns here'),
    'no carriage returns here');
});
