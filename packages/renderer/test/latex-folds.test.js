/**
 * @file Tests for the pure latex fold scanner. It returns character
 * offsets; `foldRanges` turns those into line spans, so the assertions go
 * through both — the same shape the view consumes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { latexFolds } from '../src/latex-folds.js';
import { foldRanges } from '../src/folding.js';

/** Scan TEXT and return its fold ranges as `{startLine, endLine}` spans. */
function ranges(text) {
  return foldRanges(text, latexFolds(text));
}

test('sections nest: a subsection folds inside its section', () => {
  const text = [
    '\\section{A}', // 0
    'text', // 1
    '\\subsection{A1}', // 2
    'more', // 3
    '\\section{B}', // 4
    'end', // 5
  ].join('\n');
  assert.deepEqual(ranges(text), [
    { startLine: 0, endLine: 3 }, // section A, up to just before section B
    { startLine: 2, endLine: 3 }, // subsection A1
    { startLine: 4, endLine: 5 }, // section B, to EOF
  ]);
});

test('a deeper section closes when a same-or-higher level appears', () => {
  const text = [
    '\\section{A}', // 0
    '\\subsection{A1}', // 1
    'x', // 2
    '\\subsection{A2}', // 3
    'y', // 4
  ].join('\n');
  // A1 ends just before A2; A2 runs to EOF; A wraps both.
  assert.deepEqual(ranges(text), [
    { startLine: 0, endLine: 4 },
    { startLine: 1, endLine: 2 },
    { startLine: 3, endLine: 4 },
  ]);
});

test('starred sectioning commands fold too', () => {
  const text = ['\\section*{A}', 'x', '\\section*{B}', 'y'].join('\n');
  assert.deepEqual(ranges(text), [
    { startLine: 0, endLine: 1 },
    { startLine: 2, endLine: 3 },
  ]);
});

test('an environment folds from begin to its matching end', () => {
  const text = ['\\begin{figure}', '\\includegraphics{x}', '\\end{figure}'].join('\n');
  assert.deepEqual(ranges(text), [{ startLine: 0, endLine: 2 }]);
});

test('nested environments fold on a name-matched stack', () => {
  const text = [
    '\\begin{a}', // 0
    '\\begin{b}', // 1
    'x', // 2
    '\\end{b}', // 3
    '\\end{a}', // 4
  ].join('\n');
  assert.deepEqual(ranges(text), [
    { startLine: 0, endLine: 4 },
    { startLine: 1, endLine: 3 },
  ]);
});

test('a commented-out sectioning command is ignored', () => {
  const text = ['% \\section{X}', '\\section{Y}', 'z'].join('\n');
  assert.deepEqual(ranges(text), [{ startLine: 1, endLine: 2 }]);
});

test('an unclosed environment runs to end of file', () => {
  const text = ['\\begin{verbatim}', 'a', 'b'].join('\n');
  assert.deepEqual(ranges(text), [{ startLine: 0, endLine: 2 }]);
});

test('an empty document yields no folds', () => {
  assert.deepEqual(ranges(''), []);
});
