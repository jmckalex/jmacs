import { test } from 'node:test';
import assert from 'node:assert/strict';

import { highlightLine, languageForName } from '../src/highlight.js';
// `languageForName` consults the language registry for tree-sitter
// languages; loading these modules registers JavaScript, HTML and
// Python. The desktop app does the same discovery dynamically at
// startup. See `../src/languages/README.md`.
import '../src/languages/javascript.js';
import '../src/languages/html.js';
import '../src/languages/python.js';

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

test('languageForName recognises the new languages', () => {
  assert.equal(languageForName('index.html'), 'html');
  assert.equal(languageForName('paper.tex'), 'latex');
  assert.equal(languageForName('script.py'), 'python');
  assert.equal(languageForName('Makefile'), 'makefile');
  assert.equal(languageForName('build.mk'), 'makefile');
});

test('HTML: tags, attributes, strings and comments', () => {
  assert.equal(faced('<div class="a">', 'html', 'tag').text, '<div');
  assert.equal(faced('<div class="a">', 'html', 'constant').text, 'class');
  assert.equal(faced('<div class="a">', 'html', 'string').text, '"a"');
  assert.equal(faced('<!-- note -->', 'html', 'comment').text, '<!-- note -->');
});

test('LaTeX: commands, math and comments', () => {
  assert.equal(faced('\\section{Intro}', 'latex', 'keyword').text, '\\section');
  assert.equal(faced('the $x^2$ term', 'latex', 'string').text, '$x^2$');
  assert.equal(faced('% a remark', 'latex', 'comment').text, '% a remark');
});

test('Python: keywords, strings, numbers, comments, decorators', () => {
  assert.equal(faced('def f():', 'python', 'keyword').text, 'def');
  assert.equal(faced('x = "hi"', 'python', 'string').text, '"hi"');
  assert.equal(faced('n = 42', 'python', 'number').text, '42');
  assert.equal(faced('# note', 'python', 'comment').text, '# note');
  assert.equal(faced('@decorator', 'python', 'constant').text, '@decorator');
  assert.equal(faced('x = None', 'python', 'constant').text, 'None');
});

test('Makefile: targets, variables and comments', () => {
  assert.equal(faced('build: deps', 'makefile', 'keyword').text, 'build');
  assert.equal(faced('CC = gcc', 'makefile', 'constant').text, 'CC');
  assert.equal(faced('\t$(CC) -o', 'makefile', 'constant').text, '$(CC)');
  assert.deepEqual(highlightLine('# a comment', 'makefile'), [
    { text: '# a comment', face: 'comment' },
  ]);
});

test('the new languages reconstruct the line', () => {
  for (const [text, lang] of [
    ['<a href="x">link</a>', 'html'],
    ['\\emph{word} and $math$', 'latex'],
    ['def f(x): return x + 1  # ok', 'python'],
    ['all: build  # the default', 'makefile'],
  ]) {
    assert.equal(highlightLine(text, lang).map((r) => r.text).join(''), text);
  }
});
