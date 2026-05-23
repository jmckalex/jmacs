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

test('overlap safety: identical ranges resolve to the later input', () => {
  // A buggy upstream emits the same range twice with different faces.
  // The splitter's tie-break is deterministic: the later-input face
  // wins, and a single warning is emitted.
  const { result, warnings } = withCapturedWarn(() =>
    splitIntoLineRuns('hello', [
      { start: 0, end: 5, face: 'first' },
      { start: 0, end: 5, face: 'second' },
    ])
  );
  assert.deepEqual(result, [[{ text: 'hello', face: 'second' }]]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /overlapping ranges/);
});

test('overlap safety: order in the input determines the winner, not the order in the array', () => {
  // Swap the input order — now 'first' is later in the input, so it wins.
  const { result } = withCapturedWarn(() =>
    splitIntoLineRuns('hello', [
      { start: 0, end: 5, face: 'second' },
      { start: 0, end: 5, face: 'first' },
    ])
  );
  assert.deepEqual(result, [[{ text: 'hello', face: 'first' }]]);
});

test('overlap safety: non-tie overlap is detected and still produces stable output', () => {
  // A=[0,10) and B=[3,5) — nested, no tie at start. The existing
  // "outer wins" behaviour for nested ranges is preserved; a warning
  // still fires because the contract is "no overlap".
  const { result, warnings } = withCapturedWarn(() =>
    splitIntoLineRuns('0123456789', [
      { start: 0, end: 10, face: 'outer' },
      { start: 3, end: 5, face: 'inner' },
    ])
  );
  assert.deepEqual(result, [[{ text: '0123456789', face: 'outer' }]]);
  assert.equal(warnings.length, 1);
});

test('overlap safety: no warning on adjacent (non-overlapping) ranges', () => {
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
