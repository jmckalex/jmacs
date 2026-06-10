/**
 * @file Unit tests for the tree-sitter language injection algorithm.
 *
 * The algorithm under test is `spliceInjections` — the pure heart of
 * the injection pipeline that merges outer-grammar captures with the
 * inner-language captures their injection regions produce. The grammar
 * loading and query parsing in `createTreeSitterHighlighter` happen
 * inside a real tree-sitter runtime (which needs `fetch` and the
 * `app://` scheme — Electron-only), so end-to-end coverage lives in
 * the desktop smoke test. These tests exercise the algorithm with
 * hand-built mock highlighters.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_INJECTION_DEPTH,
  spliceInjections,
} from '../src/treesitter.js';

/**
 * Build a stub {@link Highlighter} whose `captures` returns a fixed
 * list of ranges (offsets are relative to the slice it is called
 * with). The third argument records every depth the stub was called
 * with — used by the depth-cap test.
 */
function fakeHighlighter(ranges, callLog) {
  return {
    highlight: () => [],
    captures: (_text, depth) => {
      if (callLog) callLog.push(depth);
      return ranges.map((r) => ({ ...r }));
    },
  };
}

test('with no injections, outer ranges pass through unchanged', () => {
  const outer = [
    { start: 0, end: 5, face: 'a' },
    { start: 10, end: 15, face: 'b' },
  ];
  const result = spliceInjections('xxxxx-----xxxxx', outer, [], () => undefined, 0);
  assert.deepEqual(result, outer);
});

test('with an injection, inner ranges replace outer ones inside the region', () => {
  // Text: <script>console.log(1)</script>
  // Outer (HTML): the script tag bodies as @string, name as @tag etc.
  // Pretend the outer HTML grammar captured the raw_text as a single
  // string face at [8, 21).
  const text = '<script>console.log(1)</script>';
  const outer = [
    { start: 1, end: 7, face: 'tag' }, // 'script' in <script>
    { start: 8, end: 22, face: 'string' }, // the raw_text body
    { start: 24, end: 30, face: 'tag' }, // 'script' in </script>
  ];
  const injections = [
    { start: 8, end: 22, language: 'javascript' },
  ];
  // Inner JS highlighter says 'console' is a function, 'log' a function,
  // '1' a number — offsets relative to the slice "console.log(1)".
  const innerRanges = [
    { start: 0, end: 7, face: 'function' }, // console
    { start: 8, end: 11, face: 'function' }, // log
    { start: 12, end: 13, face: 'number' }, // 1
  ];
  const result = spliceInjections(
    text,
    outer,
    injections,
    () => fakeHighlighter(innerRanges),
    0
  );
  // The outer @string at [8,22) is dropped (fully inside the injection).
  // The two outer @tag captures survive (outside the injection).
  // The three inner ranges are shifted by +8.
  const expected = [
    { start: 1, end: 7, face: 'tag' },
    { start: 24, end: 30, face: 'tag' },
    { start: 8, end: 15, face: 'function' }, // 'console' shifted
    { start: 16, end: 19, face: 'function' }, // 'log' shifted
    { start: 20, end: 21, face: 'number' }, // '1' shifted
  ];
  assert.deepEqual(result, expected);
});

test('a missing inner highlighter leaves the outer face on the region', () => {
  const text = '```lisp\n(define x 1)\n```';
  const outer = [
    { start: 0, end: 7, face: 'punctuation' }, // ```lisp
    { start: 8, end: 20, face: 'string' }, // the code body (outer markdown's face)
    { start: 21, end: 24, face: 'punctuation' }, // ```
  ];
  const injections = [
    { start: 8, end: 20, language: 'lisp' },
  ];
  // No 'lisp' highlighter registered.
  const result = spliceInjections(text, outer, injections, () => undefined, 0);
  // Outer @string survives because the inner highlighter was missing.
  assert.deepEqual(result, outer);
});

test('an unknown language degrades the same way as a missing one', () => {
  const outer = [{ start: 0, end: 10, face: 'string' }];
  const injections = [{ start: 0, end: 10, language: 'esperanto' }];
  const result = spliceInjections(
    'whatever',
    outer,
    injections,
    (tag) => (tag === 'lisp' ? fakeHighlighter([]) : undefined),
    0
  );
  assert.deepEqual(result, outer);
});

test('depth cap stops recursion: at MAX, outer ranges win', () => {
  const text = 'whatever';
  const outer = [{ start: 0, end: 8, face: 'outer' }];
  const injections = [{ start: 0, end: 8, language: 'x' }];
  // Even with a "real" inner highlighter, at the cap the call short-
  // circuits and never invokes it.
  const callLog = [];
  const result = spliceInjections(
    text,
    outer,
    injections,
    () => fakeHighlighter([{ start: 0, end: 8, face: 'inner' }], callLog),
    MAX_INJECTION_DEPTH
  );
  assert.deepEqual(result, outer);
  assert.deepEqual(callLog, []);
});

test('recursion terminates on a self-cycle without exceeding MAX', () => {
  // A two-language cycle: 'a' injects 'a' over the whole text. Each
  // level peels off no characters; only the depth cap stops it.
  const text = 'cycle';
  const callDepths = [];
  /** @type {import('../src/treesitter.js').Highlighter} */
  const recursive = {
    highlight: () => [],
    captures: (_t, depth) => {
      callDepths.push(depth);
      return spliceInjections(
        _t,
        [{ start: 0, end: _t.length, face: 'a' }],
        [{ start: 0, end: _t.length, language: 'a' }],
        () => recursive,
        depth
      );
    },
  };
  // Kick it off at depth 0. The outer call (depth 0) calls the recursive
  // 'a' highlighter at depth 1, which calls it at depth 2, ..., at
  // depth MAX_INJECTION_DEPTH the recursion short-circuits.
  const result = spliceInjections(
    text,
    [{ start: 0, end: text.length, face: 'a' }],
    [{ start: 0, end: text.length, language: 'a' }],
    () => recursive,
    0
  );
  // The inner calls are at depths 1, 2, ..., MAX_INJECTION_DEPTH.
  // The depth-MAX call short-circuits without recursing further.
  assert.equal(callDepths.length, MAX_INJECTION_DEPTH);
  assert.deepEqual(
    callDepths,
    Array.from({ length: MAX_INJECTION_DEPTH }, (_, i) => i + 1)
  );
  // The final result still contains a captured range — nothing crashed.
  assert.ok(result.length > 0);
});

test('an injection without a registered getHighlighter is a no-op', () => {
  const outer = [{ start: 0, end: 5, face: 'a' }];
  const injections = [{ start: 0, end: 5, language: 'x' }];
  const result = spliceInjections(
    'hello',
    outer,
    injections,
    undefined,
    0
  );
  assert.deepEqual(result, outer);
});

test('an outer range spanning an injection is clipped around it', () => {
  // Outer [0, 30) spans injection [10, 20). The outer face survives on
  // the parts that actually surround the injection ([0,10) and [20,30));
  // the injected region is yielded to the inner face. This keeps the
  // ranges non-overlapping (no splitIntoLineRuns warning) and renders the
  // boundary with the injected language's face, not the outer one.
  const outer = [{ start: 0, end: 30, face: 'block' }];
  const injections = [{ start: 10, end: 20, language: 'x' }];
  const inner = fakeHighlighter([{ start: 0, end: 10, face: 'keyword' }]);
  const result = spliceInjections(
    'a'.repeat(30),
    outer,
    injections,
    () => inner,
    0
  );
  assert.ok(result.some((r) => r.start === 0 && r.end === 10 && r.face === 'block'),
    'left surrounding piece kept');
  assert.ok(result.some((r) => r.start === 20 && r.end === 30 && r.face === 'block'),
    'right surrounding piece kept');
  assert.ok(result.some((r) => r.start === 10 && r.end === 20 && r.face === 'keyword'),
    'inner face owns the injected region');
  // No surviving outer range crosses into the injection.
  assert.ok(!result.some((r) => r.face === 'block' && r.start < 20 && r.end > 10),
    'no outer range overlaps the injection');
});

test('an outer range crossing only the injection start is clipped on the right', () => {
  // Outer [5, 15) crosses into injection [10, 20): keep [5, 10) only.
  const outer = [{ start: 5, end: 15, face: 'block' }];
  const injections = [{ start: 10, end: 20, language: 'x' }];
  const inner = fakeHighlighter([{ start: 0, end: 10, face: 'kw' }]);
  const result = spliceInjections('a'.repeat(25), outer, injections, () => inner, 0);
  assert.ok(result.some((r) => r.start === 5 && r.end === 10 && r.face === 'block'));
  assert.ok(!result.some((r) => r.face === 'block' && r.end > 10));
});

test('an outer range crossing only the injection end is clipped on the left', () => {
  // Outer [15, 25) crosses out of injection [10, 20): keep [20, 25) only.
  const outer = [{ start: 15, end: 25, face: 'block' }];
  const injections = [{ start: 10, end: 20, language: 'x' }];
  const inner = fakeHighlighter([{ start: 0, end: 10, face: 'kw' }]);
  const result = spliceInjections('a'.repeat(25), outer, injections, () => inner, 0);
  assert.ok(result.some((r) => r.start === 20 && r.end === 25 && r.face === 'block'));
  assert.ok(!result.some((r) => r.face === 'block' && r.start < 20));
});

test('an outer range fully inside an injection is dropped (inner wins)', () => {
  const outer = [{ start: 12, end: 18, face: 'block' }];
  const injections = [{ start: 10, end: 20, language: 'x' }];
  const inner = fakeHighlighter([{ start: 0, end: 10, face: 'kw' }]);
  const result = spliceInjections('a'.repeat(25), outer, injections, () => inner, 0);
  assert.ok(!result.some((r) => r.face === 'block'), 'contained outer range dropped');
  assert.ok(result.some((r) => r.start === 10 && r.end === 20 && r.face === 'kw'));
});
