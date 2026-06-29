/**
 * @file latex-log-parse.test.js — unit tests for the pure pdflatex /
 * latexmk log parser.
 *
 * Covers the four load-bearing cases for error navigation: a `!`-error
 * paired with its `l.NN` line number, the paren file-stack attributing
 * an error to the right file, a `LaTeX Warning … on input line N`, and a
 * clean log producing an empty list. Plus a few edges (package warnings,
 * undefined references, nested file context, unbalanced parens).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLatexLog } from '../src/latex-log-parse.js';

test('a clean log yields no diagnostics', () => {
  const log = [
    'This is pdfTeX, Version 3.14159265',
    '(./paper.tex',
    'LaTeX2e <2023-11-01>',
    '(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls)',
    'Output written on paper.pdf (3 pages, 12345 bytes).',
    'Transcript written on paper.log.',
  ].join('\n');
  assert.deepEqual(parseLatexLog(log), []);
});

test('an empty / non-string input yields an empty list', () => {
  assert.deepEqual(parseLatexLog(''), []);
  assert.deepEqual(parseLatexLog(null), []);
  assert.deepEqual(parseLatexLog(undefined), []);
});

test('a "! …" error is paired with its l.NN line number', () => {
  const log = [
    '(./paper.tex',
    '! Undefined control sequence.',
    'l.42 \\foo',
    '          bar',
    '?',
  ].join('\n');
  const diags = parseLatexLog(log);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, 'error');
  assert.equal(diags[0].message, 'Undefined control sequence');
  assert.equal(diags[0].line, 42);
  assert.equal(diags[0].file, './paper.tex');
});

test('the paren file-stack attributes an error to the included file', () => {
  const log = [
    '(./paper.tex',
    '(./chapter1.tex',
    '! Missing $ inserted.',
    'l.7 x^2',
    ')', // close chapter1
    'Some more text in paper.tex',
  ].join('\n');
  const diags = parseLatexLog(log);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].file, './chapter1.tex');
  assert.equal(diags[0].line, 7);
  assert.equal(diags[0].message, 'Missing $ inserted');
});

test('after a file closes, the next error belongs to the outer file', () => {
  const log = [
    '(./paper.tex',
    '(./chapter1.tex',
    'fine here',
    ')', // back to paper.tex
    '! Undefined control sequence.',
    'l.99 \\nope',
  ].join('\n');
  const diags = parseLatexLog(log);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].file, './paper.tex');
  assert.equal(diags[0].line, 99);
});

test('a LaTeX Warning with an input line is captured as a warning', () => {
  const log = [
    '(./paper.tex',
    'LaTeX Warning: Reference `fig:missing\' on page 1 undefined on input line 13.',
    ')',
  ].join('\n');
  const diags = parseLatexLog(log);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, 'warning');
  assert.equal(diags[0].line, 13);
  assert.equal(diags[0].file, './paper.tex');
  assert.match(diags[0].message, /Reference `fig:missing'/);
  // The "on input line NN." tail is stripped from the message.
  assert.doesNotMatch(diags[0].message, /on input line/);
});

test('a package warning is captured and attributed', () => {
  const log = [
    '(./paper.tex',
    'Package hyperref Warning: Token not allowed in a PDF string on input line 8.',
    ')',
  ].join('\n');
  const diags = parseLatexLog(log);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, 'warning');
  assert.equal(diags[0].line, 8);
  assert.match(diags[0].message, /Token not allowed/);
});

test('an undefined-citation warning without a line gets line null', () => {
  const log = [
    '(./paper.tex',
    'LaTeX Warning: Citation `smith2020\' undefined.',
    ')',
  ].join('\n');
  const diags = parseLatexLog(log);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, 'warning');
  assert.equal(diags[0].line, null);
  assert.match(diags[0].message, /Citation `smith2020'/);
});

test('mixed errors and warnings preserve order and file context', () => {
  const log = [
    '(./paper.tex',
    'LaTeX Warning: Label `x\' multiply defined on input line 3.',
    '(./sub.tex',
    '! Undefined control sequence.',
    'l.5 \\bad',
    ')',
    'LaTeX Warning: Reference `y\' undefined on input line 20.',
    ')',
  ].join('\n');
  const diags = parseLatexLog(log);
  assert.equal(diags.length, 3);
  assert.equal(diags[0].kind, 'warning');
  assert.equal(diags[0].file, './paper.tex');
  assert.equal(diags[1].kind, 'error');
  assert.equal(diags[1].file, './sub.tex');
  assert.equal(diags[1].line, 5);
  assert.equal(diags[2].kind, 'warning');
  assert.equal(diags[2].file, './paper.tex');
  assert.equal(diags[2].line, 20);
});

test('unbalanced / grouping parens do not crash or mis-attribute', () => {
  // A grouping paren `(3 pages)` and a stray close paren must not be
  // treated as a file open/close that corrupts the stack.
  const log = [
    '(./paper.tex',
    'Some text (with grouping) and a count (3) here.',
    '! LaTeX Error: Something bad.',
    'l.11 text',
    'Output written on paper.pdf (3 pages).',
  ].join('\n');
  const diags = parseLatexLog(log);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, 'error');
  assert.equal(diags[0].file, './paper.tex');
  assert.equal(diags[0].line, 11);
});

test('an error with no following l.NN keeps line null', () => {
  const log = [
    '(./paper.tex',
    '! Emergency stop.',
    '*** (job aborted, no legal \\end found)',
  ].join('\n');
  const diags = parseLatexLog(log);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, 'error');
  assert.equal(diags[0].line, null);
  assert.equal(diags[0].message, 'Emergency stop');
});

// --- TeX line-wrapping (max_print_line = 79) -------------------------------
// TeX hard-wraps every log line at 79 chars, so long error/warning messages
// spill onto continuation lines. The parser rejoins them so the captured
// message is the whole thing, not just the first ~79 chars (the truncation
// users saw in the *TeX errors* view). The split is verbatim at column 79.

/** Re-wrap STRING the way TeX emits it: a hard cut every 79 chars. */
function wrap79(string) {
  const out = [];
  for (let i = 0; i < string.length; i += 79) out.push(string.slice(i, i + 79));
  return out;
}

test('a wrapped package error message is rejoined in full', () => {
  const full =
    "! Package embedfile Error: File `/Volumes/iDisk/Documents/Bibliography.bib' not found.";
  assert.equal(wrap79(full)[0].length, 79, 'fixture really wraps at 79');
  const log = ['(./paper.tex', ...wrap79(full), '', 'l.10 \\embedfile{...}', ')'].join('\n');
  const [diag] = parseLatexLog(log);
  assert.equal(diag.kind, 'error');
  assert.equal(diag.line, 10);
  assert.equal(
    diag.message,
    "Package embedfile Error: File `/Volumes/iDisk/Documents/Bibliography.bib' not found"
  );
});

test('a wrapped package warning is rejoined and its line still parsed', () => {
  // A real-world line: mathdesign warns about amsfonts; it wraps at 79.
  const full =
    "Package mathdesign/mdugm Warning: Package 'amsfonts' shouldn't be used in conjonction with package mdugm, on input line 20.";
  assert.equal(wrap79(full)[0].length, 79, 'fixture really wraps at 79');
  const log = ['(./paper.tex', ...wrap79(full), ')'].join('\n');
  const [diag] = parseLatexLog(log);
  assert.equal(diag.kind, 'warning');
  assert.equal(diag.line, 20);
  assert.equal(
    diag.message,
    "Package 'amsfonts' shouldn't be used in conjonction with package mdugm,"
  );
});

test('a new error after a genuine 79-char line is not swallowed by the unwrapper', () => {
  // A non-message log line of exactly 79 chars, immediately followed by an error:
  // the construct guard keeps the `! ` line as its own diagnostic.
  const filler = 'x'.repeat(79);
  const log = ['(./paper.tex', filler, '! Undefined control sequence.', 'l.5 \\foo', ')'].join('\n');
  const diags = parseLatexLog(log);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].kind, 'error');
  assert.equal(diags[0].message, 'Undefined control sequence');
  assert.equal(diags[0].line, 5);
});
