import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitIntoLineRuns } from '../src/runs.js';

/** Concatenate a line's run texts. */
const joinLine = (runs) => runs.map((r) => r.text).join('');

test('with no ranges, each line is one faceless run', () => {
  const result = splitIntoLineRuns('abc\ndef', []);
  assert.deepEqual(result, [
    [{ text: 'abc', face: null }],
    [{ text: 'def', face: null }],
  ]);
});

test('an empty line yields no runs', () => {
  assert.deepEqual(splitIntoLineRuns('a\n\nb', []), [
    [{ text: 'a', face: null }],
    [],
    [{ text: 'b', face: null }],
  ]);
});

test('a range within one line splits into faced and plain runs', () => {
  // "hello" with [0,5) -> a single faced run.
  assert.deepEqual(splitIntoLineRuns('hello', [{ start: 0, end: 5, face: 'kw' }]), [
    [{ text: 'hello', face: 'kw' }],
  ]);
  // "a foo b" with foo faced.
  assert.deepEqual(
    splitIntoLineRuns('a foo b', [{ start: 2, end: 5, face: 'id' }]),
    [
      [
        { text: 'a ', face: null },
        { text: 'foo', face: 'id' },
        { text: ' b', face: null },
      ],
    ]
  );
});

test('runs always reconstruct each line', () => {
  const text = 'const x = 1;\n// a comment\nfoo("bar")';
  const ranges = [
    { start: 0, end: 5, face: 'keyword' },
    { start: 13, end: 25, face: 'comment' },
    { start: 30, end: 35, face: 'string' },
  ];
  const lines = text.split('\n');
  const result = splitIntoLineRuns(text, ranges);
  assert.equal(result.length, lines.length);
  result.forEach((runs, i) => assert.equal(joinLine(runs), lines[i]));
});

test('a range spanning lines is clipped to each line', () => {
  // A block comment from mid-line 0 through mid-line 2.
  const text = 'aa/* x\nyy\nz */bb';
  const ranges = [{ start: 2, end: 14, face: 'comment' }];
  const result = splitIntoLineRuns(text, ranges);
  assert.deepEqual(result[0], [
    { text: 'aa', face: null },
    { text: '/* x', face: 'comment' },
  ]);
  assert.deepEqual(result[1], [{ text: 'yy', face: 'comment' }]);
  assert.deepEqual(result[2], [
    { text: 'z */', face: 'comment' },
    { text: 'bb', face: null },
  ]);
});

test('unsorted ranges are handled', () => {
  const result = splitIntoLineRuns('abcdef', [
    { start: 4, end: 6, face: 'b' },
    { start: 0, end: 2, face: 'a' },
  ]);
  assert.deepEqual(result, [
    [
      { text: 'ab', face: 'a' },
      { text: 'cd', face: null },
      { text: 'ef', face: 'b' },
    ],
  ]);
});

/**
 * Capture `console.warn` for the body of a function and return whatever
 * the function returned plus the list of warning calls.
 */
function withCapturedWarn(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const result = fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

test('overlap: identical ranges resolve to the later input (no warning)', () => {
  // Two captures of the same span with different faces resolve to the
  // later input — and overlaps are now a handled input, so no warning.
  const { result, warnings } = withCapturedWarn(() =>
    splitIntoLineRuns('hello', [
      { start: 0, end: 5, face: 'first' },
      { start: 0, end: 5, face: 'second' },
    ])
  );
  assert.deepEqual(result, [[{ text: 'hello', face: 'second' }]]);
  assert.equal(warnings.length, 0);
});

test('overlap: input order decides the equal-size winner', () => {
  // Swap the input order — now 'first' is later in the input, so it wins.
  const { result } = withCapturedWarn(() =>
    splitIntoLineRuns('hello', [
      { start: 0, end: 5, face: 'second' },
      { start: 0, end: 5, face: 'first' },
    ])
  );
  assert.deepEqual(result, [[{ text: 'hello', face: 'first' }]]);
});

test('overlap: a nested range wins its span; the outer fills the gaps', () => {
  // A=[0,10) outer, B=[3,5) inner. The inner face shows on [3,5); the
  // outer face survives only on the gaps around it. (The old splitter
  // dropped the inner face entirely — the outer ate the whole span.)
  const { result, warnings } = withCapturedWarn(() =>
    splitIntoLineRuns('0123456789', [
      { start: 0, end: 10, face: 'outer' },
      { start: 3, end: 5, face: 'inner' },
    ])
  );
  assert.deepEqual(result, [
    [
      { text: '012', face: 'outer' },
      { text: '34', face: 'inner' },
      { text: '56789', face: 'outer' },
    ],
  ]);
  assert.equal(warnings.length, 0);
});

test('overlap: Markdown-style delimiters inside a strong span', () => {
  // The real case: `**bold**` captured as @strong over [0,8) with each
  // `*` delimiter captured as @paren. The delimiters (smaller) win, and
  // the inner text stays @strong — even though @strong shares the start.
  const { result, warnings } = withCapturedWarn(() =>
    splitIntoLineRuns('**bold**', [
      { start: 0, end: 8, face: 'strong' },
      { start: 0, end: 1, face: 'paren' },
      { start: 1, end: 2, face: 'paren' },
      { start: 6, end: 7, face: 'paren' },
      { start: 7, end: 8, face: 'paren' },
    ])
  );
  assert.deepEqual(result, [
    [
      { text: '**', face: 'paren' },
      { text: 'bold', face: 'strong' },
      { text: '**', face: 'paren' },
    ],
  ]);
  assert.equal(warnings.length, 0);
});

test('overlap: no warning on adjacent (non-overlapping) ranges', () => {
  const { result, warnings } = withCapturedWarn(() =>
    splitIntoLineRuns('abcdef', [
      { start: 0, end: 3, face: 'a' },
      { start: 3, end: 6, face: 'b' },
    ])
  );
  assert.deepEqual(result, [
    [
      { text: 'abc', face: 'a' },
      { text: 'def', face: 'b' },
    ],
  ]);
  assert.equal(warnings.length, 0);
});
