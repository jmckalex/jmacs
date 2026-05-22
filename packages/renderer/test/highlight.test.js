import { test } from 'node:test';
import assert from 'node:assert/strict';

import { highlightLine, languageForName } from '../src/highlight.js';

/** The faces of a highlighted line, in order. */
const faces = (text, lang) => highlightLine(text, lang).map((r) => r.face);

/** A run with a given face, if present. */
const faced = (text, lang, face) =>
  highlightLine(text, lang).find((r) => r.face === face);

test('languageForName maps extensions', () => {
  assert.equal(languageForName('editing.lisp'), 'lisp');
  assert.equal(languageForName('app.js'), 'javascript');
  assert.equal(languageForName('main.mjs'), 'javascript');
  assert.equal(languageForName('notes.txt'), 'plain');
  assert.equal(languageForName(undefined), 'plain');
});

test('plain text is one faceless run', () => {
  assert.deepEqual(highlightLine('just words', 'plain'), [
    { text: 'just words', face: null },
  ]);
  assert.deepEqual(highlightLine('', 'plain'), []);
});

test('runs always reconstruct the original line', () => {
  for (const [text, lang] of [
    ['(define (sq x) (* x x)) ; square', 'lisp'],
    ['const x = "hi"; // a comment', 'javascript'],
    ['  :keyword #t 42 nil', 'lisp'],
  ]) {
    const joined = highlightLine(text, lang).map((r) => r.text).join('');
    assert.equal(joined, text);
  }
});

test('Lisp: comments, strings, numbers, keywords', () => {
  assert.equal(faced('; a comment', 'lisp', 'comment').text, '; a comment');
  assert.equal(faced('"text"', 'lisp', 'string').text, '"text"');
  assert.equal(faced('42', 'lisp', 'number').text, '42');
  assert.equal(faced('(define x 1)', 'lisp', 'keyword').text, 'define');
});

test('Lisp: keywords and booleans are constants, parens are parens', () => {
  assert.equal(faced(':name', 'lisp', 'constant').text, ':name');
  assert.equal(faced('#t', 'lisp', 'constant').text, '#t');
  assert.equal(faced('()', 'lisp', 'paren').text, '(');
});

test('Lisp: an ordinary symbol has no face', () => {
  const runs = highlightLine('my-symbol', 'lisp');
  assert.deepEqual(runs, [{ text: 'my-symbol', face: null }]);
});

test('JavaScript: keywords, strings, comments, numbers', () => {
  assert.equal(faced('const a = 1', 'javascript', 'keyword').text, 'const');
  assert.equal(faced('"hello"', 'javascript', 'string').text, '"hello"');
  assert.equal(faced('// note', 'javascript', 'comment').text, '// note');
  assert.equal(faced('x = 3.5', 'javascript', 'number').text, '3.5');
});

test('JavaScript: a block comment on one line is a comment', () => {
  assert.equal(
    faced('a /* mid */ b', 'javascript', 'comment').text,
    '/* mid */'
  );
});

test('an empty line yields no runs in a code language', () => {
  assert.deepEqual(highlightLine('', 'lisp'), []);
  assert.deepEqual(highlightLine('', 'javascript'), []);
});

test('languageForName recognises markdown', () => {
  assert.equal(languageForName('notes.md'), 'markdown');
  assert.equal(languageForName('book.jmd'), 'markdown');
});

test('Markdown: a heading faces the whole line', () => {
  assert.deepEqual(highlightLine('## A heading', 'markdown'), [
    { text: '## A heading', face: 'heading' },
  ]);
});

test('Markdown: inline code, strong, emphasis, highlight', () => {
  assert.equal(faced('use `code` here', 'markdown', 'code').text, '`code`');
  assert.equal(faced('a *strong* word', 'markdown', 'strong').text, '*strong*');
  assert.equal(faced('an /italic/ word', 'markdown', 'emphasis').text, '/italic/');
  assert.equal(faced('a ==mark== word', 'markdown', 'constant').text, '==mark==');
});

test('Markdown: links, JMarkdown citations and directives', () => {
  assert.equal(faced('see [docs](u)', 'markdown', 'link').text, '[docs](u)');
  assert.equal(
    faced('text \\cite{ref} more', 'markdown', 'keyword').text,
    '\\cite{ref}'
  );
  assert.deepEqual(highlightLine(':::TeX', 'markdown'), [
    { text: ':::TeX', face: 'keyword' },
  ]);
});

test('Markdown: list and blockquote markers', () => {
  assert.equal(faced('- an item', 'markdown', 'operator').text, '-');
  assert.equal(faced('> a quote', 'markdown', 'operator').text, '>');
});

test('Markdown runs reconstruct the line', () => {
  for (const line of ['a *b* /c/ `d` [e](f)', '> quote with *strong*', '1. item']) {
    assert.equal(
      highlightLine(line, 'markdown').map((r) => r.text).join(''),
      line
    );
  }
});
