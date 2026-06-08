/**
 * @file Unit tests for the pure math-segment scanner and the reveal
 * predicate. No DOM, no tree-sitter — the delimiter scanner is the
 * production fallback and the testable heart of Phase 1.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scanMathSegments,
  segmentsFromNodeRanges,
  pointInsideSegment,
  segmentContainingPoint,
  isEmptyBody,
  maskMarkdownCode,
  LATEX_MATH_CONFIG,
  MARKDOWN_MATH_CONFIG,
} from '../src/math-segments.js';

test('scans a single inline $…$ segment', () => {
  const text = 'a $x+1$ b';
  assert.deepEqual(scanMathSegments(text), [
    { start: 2, end: 7, kind: 'inline', body: 'x+1' },
  ]);
});

test('scans \\(…\\) inline math', () => {
  const text = 'see \\(a^2\\) here';
  assert.deepEqual(scanMathSegments(text), [
    { start: 4, end: 11, kind: 'inline', body: 'a^2' },
  ]);
});

test('scans $$…$$ display math as block', () => {
  const text = 'x $$E=mc^2$$ y';
  assert.deepEqual(scanMathSegments(text), [
    { start: 2, end: 12, kind: 'block', body: 'E=mc^2' },
  ]);
});

test('scans \\[…\\] display math as block', () => {
  const text = 'before \\[\\int_0^1 f\\] after';
  assert.deepEqual(scanMathSegments(text), [
    { start: 7, end: 21, kind: 'block', body: '\\int_0^1 f' },
  ]);
});

test('$$ takes precedence over $ at the same position', () => {
  // The opener is `$$`, so this is one display segment, not two empty
  // inline ones.
  const text = '$$a$$';
  assert.deepEqual(scanMathSegments(text), [
    { start: 0, end: 5, kind: 'block', body: 'a' },
  ]);
});

test('multiple segments in one line, in document order', () => {
  const text = '$a$ and $$b$$ and \\(c\\)';
  assert.deepEqual(scanMathSegments(text), [
    { start: 0, end: 3, kind: 'inline', body: 'a' },
    { start: 8, end: 13, kind: 'block', body: 'b' },
    { start: 18, end: 23, kind: 'inline', body: 'c' },
  ]);
});

test('multi-line display math: $$ spanning newlines', () => {
  const text = '$$\n\\sum_{i=0}^n i\n= \\frac{n(n+1)}{2}\n$$';
  const segs = scanMathSegments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'block');
  assert.equal(segs[0].start, 0);
  assert.equal(segs[0].end, text.length);
  assert.equal(segs[0].body, '\n\\sum_{i=0}^n i\n= \\frac{n(n+1)}{2}\n');
});

test('multi-line display math: \\[ … \\] spanning newlines', () => {
  const text = 'text\n\\[\n  a + b\n\\]\nmore';
  const segs = scanMathSegments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'block');
  assert.equal(segs[0].body, '\n  a + b\n');
});

test('scans a \\begin{align}…\\end{align} environment as block', () => {
  const text = '\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}';
  const segs = scanMathSegments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'block');
  assert.equal(segs[0].start, 0);
  assert.equal(segs[0].end, text.length);
  // The body is the FULL environment source (MathJax processes it).
  assert.equal(segs[0].body, text);
});

test('scans a starred environment (align*) within prose, offsets correct', () => {
  const text = 'see \\begin{align*}x=1\\end{align*} above';
  const segs = scanMathSegments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'block');
  assert.equal(segs[0].start, 4);
  assert.equal(segs[0].body, '\\begin{align*}x=1\\end{align*}');
});

test('scans equation/gather/multline environments as block', () => {
  for (const env of ['equation', 'gather', 'multline']) {
    const text = `\\begin{${env}}E=mc^2\\end{${env}}`;
    const segs = scanMathSegments(text);
    assert.equal(segs.length, 1, env);
    assert.equal(segs[0].kind, 'block', env);
    assert.equal(segs[0].body, text, env);
  }
});

test('non-math environments (itemize) are not scanned', () => {
  const text = '\\begin{itemize}\\item a\\end{itemize}';
  assert.deepEqual(scanMathSegments(text), []);
});

test('a \\begin{align} with no matching \\end is not reported', () => {
  assert.deepEqual(scanMathSegments('\\begin{align} a &= b'), []);
});

test('escaped \\$ is not a math delimiter', () => {
  const text = 'price is \\$5 and \\$6';
  assert.deepEqual(scanMathSegments(text), []);
});

test('escaped \\$ before a real $…$ segment', () => {
  const text = '\\$10 then $y=2$';
  assert.deepEqual(scanMathSegments(text), [
    { start: 10, end: 15, kind: 'inline', body: 'y=2' },
  ]);
});

test('double backslash does not escape the following $', () => {
  // `\\` is a literal backslash pair; the `$` after it is live.
  const text = 'a\\\\$z$';
  assert.deepEqual(scanMathSegments(text), [
    { start: 3, end: 6, kind: 'inline', body: 'z' },
  ]);
});

test('empty inline body $$ … wait, empty $ $', () => {
  const text = '$$';
  // `$$` with nothing between is an *empty display* opener with no
  // close → no complete segment. (It is a half-typed `$$|$$`.)
  assert.deepEqual(scanMathSegments(text), []);
});

test('empty inline body $ $ produces an empty-body segment', () => {
  const text = 'a $ $ b';
  assert.deepEqual(scanMathSegments(text), [
    { start: 2, end: 5, kind: 'inline', body: ' ' },
  ]);
});

test('empty display body $$$$ is one empty block segment', () => {
  const text = '$$$$';
  assert.deepEqual(scanMathSegments(text), [
    { start: 0, end: 4, kind: 'block', body: '' },
  ]);
});

test('unterminated $ opener is not reported (half-typed math)', () => {
  const text = 'a $x+1 and more text';
  assert.deepEqual(scanMathSegments(text), []);
});

test('unterminated \\[ opener is not reported', () => {
  const text = 'a \\[ x + y with no close';
  assert.deepEqual(scanMathSegments(text), []);
});

test('% line comments are skipped — $ inside a comment is not math', () => {
  const text = '% this $is not$ math\nreal $z$ here';
  assert.deepEqual(scanMathSegments(text), [
    { start: 26, end: 29, kind: 'inline', body: 'z' },
  ]);
});

test('escaped \\% is not a comment start', () => {
  const text = '50\\% off $q$';
  assert.deepEqual(scanMathSegments(text), [
    { start: 9, end: 12, kind: 'inline', body: 'q' },
  ]);
});

test('empty input returns no segments', () => {
  assert.deepEqual(scanMathSegments(''), []);
  assert.deepEqual(scanMathSegments(undefined), []);
});

test('a backslash-escaped close inside \\[…\\] is honoured', () => {
  // `\]` closes; a literal `]` does not.
  const text = '\\[ a[1] = b \\]';
  const segs = scanMathSegments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].body, ' a[1] = b ');
});

// --- segmentsFromNodeRanges (tree-sitter adapter) ----------------------

test('segmentsFromNodeRanges strips delimiters by inferred width', () => {
  const text = 'a $x$ b $$y$$ c \\(z\\) \\[w\\]';
  const nodes = [
    { start: 2, end: 5, type: 'inline_formula' },
    { start: 8, end: 13, type: 'displayed_equation' },
    { start: 16, end: 21, type: 'inline_formula' },
    { start: 22, end: 27, type: 'displayed_equation' },
  ];
  assert.deepEqual(segmentsFromNodeRanges(text, nodes), [
    { start: 2, end: 5, kind: 'inline', body: 'x' },
    { start: 8, end: 13, kind: 'block', body: 'y' },
    { start: 16, end: 21, kind: 'inline', body: 'z' },
    { start: 22, end: 27, kind: 'block', body: 'w' },
  ]);
});

test('segmentsFromNodeRanges sorts by start', () => {
  const text = '$$y$$ $x$';
  const nodes = [
    { start: 6, end: 9, type: 'inline_formula' },
    { start: 0, end: 5, type: 'displayed_equation' },
  ];
  const segs = segmentsFromNodeRanges(text, nodes);
  assert.deepEqual(segs.map((s) => s.start), [0, 6]);
});

test('segmentsFromNodeRanges skips nodes with no recognised delimiter', () => {
  const text = 'plain text here';
  const nodes = [{ start: 0, end: 5, type: 'inline_formula' }];
  assert.deepEqual(segmentsFromNodeRanges(text, nodes), []);
});

test('segmentsFromNodeRanges on empty / non-array input', () => {
  assert.deepEqual(segmentsFromNodeRanges('x', []), []);
  assert.deepEqual(segmentsFromNodeRanges('x', null), []);
});

// --- reveal predicate (exclusive at both ends) -------------------------

test('pointInsideSegment is exclusive at both ends', () => {
  const seg = { start: 2, end: 7, kind: 'inline', body: 'x+1' };
  // At the opening delimiter (start) → NOT inside → widget shown.
  assert.equal(pointInsideSegment(seg, 2), false);
  // One step inward → inside → source revealed.
  assert.equal(pointInsideSegment(seg, 3), true);
  // Last interior offset → inside.
  assert.equal(pointInsideSegment(seg, 6), true);
  // At the closing edge (end) → NOT inside → widget shown.
  assert.equal(pointInsideSegment(seg, 7), false);
  // Well outside.
  assert.equal(pointInsideSegment(seg, 0), false);
  assert.equal(pointInsideSegment(seg, 100), false);
});

test('segmentContainingPoint finds the one segment point is inside', () => {
  const segs = [
    { start: 0, end: 3, kind: 'inline', body: 'a' },
    { start: 8, end: 13, kind: 'block', body: 'b' },
  ];
  assert.equal(segmentContainingPoint(segs, 1), segs[0]);
  assert.equal(segmentContainingPoint(segs, 10), segs[1]);
  // Between segments → null.
  assert.equal(segmentContainingPoint(segs, 5), null);
  // On a boundary → null (exclusive).
  assert.equal(segmentContainingPoint(segs, 0), null);
  assert.equal(segmentContainingPoint(segs, 3), null);
});

// --- empty-body predicate ----------------------------------------------

test('isEmptyBody treats empty and whitespace-only as invalid', () => {
  assert.equal(isEmptyBody(''), true);
  assert.equal(isEmptyBody('   '), true);
  assert.equal(isEmptyBody('\n\t '), true);
  assert.equal(isEmptyBody('x'), false);
  assert.equal(isEmptyBody(' x '), false);
  assert.equal(isEmptyBody(undefined), true);
});

// --- config-driven scanning --------------------------------------------

test('default (no config) is the full LaTeX behaviour', () => {
  // Back-compat: an existing caller passing only text scans everything,
  // including \begin…\end environments.
  const text = 'a $x$ \\begin{align}y=1\\end{align}';
  const segs = scanMathSegments(text);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].body, 'x');
  assert.equal(segs[1].kind, 'block');
  assert.equal(segs[1].body, '\\begin{align}y=1\\end{align}');
});

test('LATEX_MATH_CONFIG recognises all four delimiters and environments', () => {
  const text = '$a$ $$b$$ \\(c\\) \\[d\\] \\begin{equation}e\\end{equation}';
  const segs = scanMathSegments(text, LATEX_MATH_CONFIG);
  assert.deepEqual(
    segs.map((s) => [s.kind, s.body]),
    [
      ['inline', 'a'],
      ['block', 'b'],
      ['inline', 'c'],
      ['block', 'd'],
      ['block', '\\begin{equation}e\\end{equation}'],
    ]
  );
});

test('MARKDOWN_MATH_CONFIG recognises all four delimiter pairs', () => {
  const text = '$a$ $$b$$ \\(c\\) \\[d\\]';
  const segs = scanMathSegments(text, MARKDOWN_MATH_CONFIG);
  assert.deepEqual(
    segs.map((s) => [s.kind, s.body]),
    [
      ['inline', 'a'],
      ['block', 'b'],
      ['inline', 'c'],
      ['block', 'd'],
    ]
  );
});

test('MARKDOWN_MATH_CONFIG treats \\begin{equation} as math (matches MathJax)', () => {
  const text = '\\begin{equation}E=mc^2\\end{equation}';
  const segs = scanMathSegments(text, MARKDOWN_MATH_CONFIG);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'block');
  assert.equal(segs[0].body, text);
});

test('MARKDOWN_MATH_CONFIG: a \\begin and a real $…$ are both math', () => {
  const text = '\\begin{equation}q\\end{equation} and $z$';
  const segs = scanMathSegments(text, MARKDOWN_MATH_CONFIG);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].kind, 'block');
  assert.equal(segs[1].body, 'z');
  assert.equal(segs[1].kind, 'inline');
});

test('config flags can disable individual delimiters', () => {
  // Inline dollar off: $a$ is not scanned, but \(b\) still is.
  const text = '$a$ \\(b\\)';
  const segs = scanMathSegments(text, { inlineDollar: false });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].body, 'b');
});

test('environments can be restricted to a name list', () => {
  const config = { environments: ['equation'] };
  // equation is recognised…
  assert.equal(
    scanMathSegments('\\begin{equation}x\\end{equation}', config).length,
    1
  );
  // …align is not (not in the list).
  assert.equal(
    scanMathSegments('\\begin{align}x\\end{align}', config).length,
    0
  );
});

test('an empty config still scans everything (flags default on)', () => {
  const text = '$a$ \\begin{align}b\\end{align}';
  assert.equal(scanMathSegments(text, {}).length, 2);
});

// --- maskMarkdownCode -------------------------------------------------

test('maskMarkdownCode blanks an inline code span, preserving length', () => {
  const text = 'a `$x$` b';
  const masked = maskMarkdownCode(text);
  assert.equal(masked.length, text.length);
  assert.equal(masked, 'a       b');
  // The masked `$` are gone, so no math is scanned there.
  assert.equal(scanMathSegments(masked, MARKDOWN_MATH_CONFIG).length, 0);
});

test('maskMarkdownCode blanks a fenced code block but keeps newlines', () => {
  const text = '```\n$x$\n```';
  const masked = maskMarkdownCode(text);
  assert.equal(masked.length, text.length);
  assert.deepEqual(masked.split('\n'), ['   ', '   ', '   ']);
  assert.equal(scanMathSegments(masked, MARKDOWN_MATH_CONFIG).length, 0);
});

test('maskMarkdownCode leaves real math (outside code) untouched, offsets intact', () => {
  const text = 'see `code` then $y$ end';
  const masked = maskMarkdownCode(text);
  const segs = scanMathSegments(masked, MARKDOWN_MATH_CONFIG);
  assert.equal(segs.length, 1);
  // Offsets index back into the ORIGINAL text correctly.
  assert.equal(text.slice(segs[0].start, segs[0].end), '$y$');
  assert.equal(segs[0].body, 'y');
});

test('maskMarkdownCode leaves an unclosed backtick run alone', () => {
  assert.equal(maskMarkdownCode('a ` b $x$'), 'a ` b $x$');
});
