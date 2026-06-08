/**
 * @file latex-scan.test.js — unit tests for the pure LaTeX scanner.
 *
 * Exercises each record type, multi-key citations, starred sections,
 * the enclosing-environment tag for labels, 1-based line numbers across
 * multi-line input, and — the load-bearing case for RefTeX — that
 * commented-out lines are ignored.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanLatex } from '../src/latex-scan.js';

test('extracts labels with 1-based line and 0-based column', () => {
  const text = [
    '\\documentclass{article}',
    '\\begin{document}',
    'Some text \\label{sec:intro} here.',
  ].join('\n');
  const { labels } = scanLatex(text);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].name, 'sec:intro');
  assert.equal(labels[0].line, 3); // 1-based
  assert.equal(labels[0].col, 10); // 0-based offset of the backslash
});

test('tags a label with its enclosing environment', () => {
  const text = [
    '\\begin{equation}',
    '  E = mc^2 \\label{eq:einstein}',
    '\\end{equation}',
    '\\label{outside}',
  ].join('\n');
  const { labels } = scanLatex(text);
  const byName = Object.fromEntries(labels.map((l) => [l.name, l]));
  assert.equal(byName['eq:einstein'].env, 'equation');
  assert.equal(byName['outside'].env, null);
});

test('uses the innermost environment for nested labels', () => {
  const text = [
    '\\begin{figure}',
    '  \\begin{subfigure}',
    '    \\label{fig:sub}',
    '  \\end{subfigure}',
    '  \\label{fig:outer}',
    '\\end{figure}',
  ].join('\n');
  const { labels } = scanLatex(text);
  const byName = Object.fromEntries(labels.map((l) => [l.name, l]));
  assert.equal(byName['fig:sub'].env, 'subfigure');
  assert.equal(byName['fig:outer'].env, 'figure');
});

test('extracts sections of every level, including starred', () => {
  const text = [
    '\\part{One}',
    '\\chapter{Two}',
    '\\section{Three}',
    '\\subsection{Four}',
    '\\subsubsection{Five}',
    '\\paragraph{Six}',
    '\\subparagraph{Seven}',
    '\\section*{Unnumbered}',
  ].join('\n');
  const { sections } = scanLatex(text);
  assert.deepEqual(
    sections.map((s) => s.level),
    [
      'part',
      'chapter',
      'section',
      'subsection',
      'subsubsection',
      'paragraph',
      'subparagraph',
      'section',
    ]
  );
  assert.equal(sections[0].title, 'One');
  assert.equal(sections[7].title, 'Unnumbered'); // starred form captured
  assert.equal(sections[2].line, 3);
});

test('does not confuse subsection with section', () => {
  const { sections } = scanLatex('\\subsection{S}\n\\subsubsection{T}');
  assert.deepEqual(sections.map((s) => s.level), ['subsection', 'subsubsection']);
  assert.deepEqual(sections.map((s) => s.title), ['S', 'T']);
});

test('extracts cross-references of every macro', () => {
  const text = [
    'See \\ref{a}, \\eqref{b}, \\pageref{c},',
    '\\autoref{d}, \\cref{e}, \\Cref{f}.',
  ].join('\n');
  const { refs } = scanLatex(text);
  assert.deepEqual(
    refs.map((r) => [r.macro, r.name, r.line]),
    [
      ['ref', 'a', 1],
      ['eqref', 'b', 1],
      ['pageref', 'c', 1],
      ['autoref', 'd', 2],
      ['cref', 'e', 2],
      ['Cref', 'f', 2],
    ]
  );
});

test('splits multi-key citations and records the macro', () => {
  const text = '\\cite{smith2020, jones2019,doe2021}';
  const { cites } = scanLatex(text);
  assert.equal(cites.length, 1);
  assert.deepEqual(cites[0].keys, ['smith2020', 'jones2019', 'doe2021']);
  assert.equal(cites[0].macro, 'cite');
  assert.equal(cites[0].line, 1);
});

test('handles the natbib / biblatex citation family', () => {
  const text = [
    '\\citep{a}',
    '\\citet{b}',
    '\\parencite{c}',
    '\\citeauthor{d}',
  ].join('\n');
  const { cites } = scanLatex(text);
  assert.deepEqual(
    cites.map((c) => [c.macro, c.keys[0]]),
    [
      ['citep', 'a'],
      ['citet', 'b'],
      ['parencite', 'c'],
      ['citeauthor', 'd'],
    ]
  );
});

test('tolerates a pre-note argument on a citation', () => {
  const { cites } = scanLatex('\\cite[p.~5]{smith2020}');
  assert.equal(cites.length, 1);
  assert.deepEqual(cites[0].keys, ['smith2020']);
});

test('extracts index entries', () => {
  const text = 'word\\index{topic}\nmore\\index{other!sub}';
  const { index } = scanLatex(text);
  assert.deepEqual(
    index.map((i) => [i.entry, i.line]),
    [
      ['topic', 1],
      ['other!sub', 2],
    ]
  );
});

test('extracts input / include / subfile inclusions', () => {
  const text = [
    '\\input{preamble}',
    '\\include{chapter1}',
    '\\subfile{sections/intro}',
  ].join('\n');
  const { inputs } = scanLatex(text);
  assert.deepEqual(
    inputs.map((i) => [i.kind, i.path, i.line]),
    [
      ['input', 'preamble', 1],
      ['include', 'chapter1', 2],
      ['subfile', 'sections/intro', 3],
    ]
  );
});

test('combines \\import{DIR}{FILE} into a single path', () => {
  const { inputs } = scanLatex('\\import{chapters/}{intro.tex}');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].kind, 'import');
  assert.equal(inputs[0].path, 'chapters/intro.tex');
});

test('combines \\import without a trailing slash on DIR', () => {
  const { inputs } = scanLatex('\\import{chapters}{intro.tex}');
  assert.equal(inputs[0].path, 'chapters/intro.tex');
});

test('extracts bibliography declarations, comma-splitting', () => {
  const text = [
    '\\bibliography{refs, more}',
    '\\addbibresource{biblio.bib}',
  ].join('\n');
  const { bib } = scanLatex(text);
  assert.deepEqual(bib[0].paths, ['refs', 'more']);
  assert.equal(bib[0].line, 1);
  assert.deepEqual(bib[1].paths, ['biblio.bib']);
  assert.equal(bib[1].line, 2);
});

test('ignores commented-out content (the RefTeX-critical case)', () => {
  const text = [
    '\\label{kept}',
    '% \\label{commented}',
    '\\section{Real}   % \\section{fake}',
    '\\cite{realkey}   % \\cite{fakekey}',
    '%\\ref{nope}',
  ].join('\n');
  const scan = scanLatex(text);
  assert.deepEqual(scan.labels.map((l) => l.name), ['kept']);
  assert.deepEqual(scan.sections.map((s) => s.title), ['Real']);
  assert.deepEqual(scan.cites.map((c) => c.keys[0]), ['realkey']);
  assert.deepEqual(scan.refs.map((r) => r.name), []);
});

test('an escaped percent does not start a comment', () => {
  // `\%` is a literal percent sign, not a comment marker, so the
  // \label after it is still live.
  const text = 'Rate is 5\\% \\label{rate}';
  const { labels } = scanLatex(text);
  assert.deepEqual(labels.map((l) => l.name), ['rate']);
});

test('a comment inside an environment does not break env tracking', () => {
  const text = [
    '\\begin{theorem}',
    '% a comment with \\end{theorem} inside it',
    '\\label{thm:main}',
    '\\end{theorem}',
  ].join('\n');
  const { labels } = scanLatex(text);
  assert.equal(labels[0].env, 'theorem');
});

test('correct line numbers across a long multi-line document', () => {
  const lines = [];
  for (let i = 0; i < 50; i += 1) lines.push(`line ${i}`);
  lines.push('\\label{deep}'); // line 51 (1-based)
  const { labels } = scanLatex(lines.join('\n'));
  assert.equal(labels[0].line, 51);
});

test('empty / non-string input yields empty record lists', () => {
  for (const value of ['', null, undefined, 42]) {
    const scan = scanLatex(value);
    assert.deepEqual(scan.labels, []);
    assert.deepEqual(scan.sections, []);
    assert.deepEqual(scan.refs, []);
    assert.deepEqual(scan.cites, []);
    assert.deepEqual(scan.index, []);
    assert.deepEqual(scan.inputs, []);
    assert.deepEqual(scan.bib, []);
  }
});

test('tolerates whitespace between macro and brace', () => {
  const { labels } = scanLatex('\\label {spaced}');
  assert.deepEqual(labels.map((l) => l.name), ['spaced']);
});
