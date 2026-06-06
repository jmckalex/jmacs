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

// --- multi-line tokenizers --------------------------------------------

import {
  highlightBuffer,
  highlightLatexBuffer,
  highlightMakefileBuffer,
  highlightMarkdownBuffer,
} from '../src/highlight.js';

/** A line's faces, in order. */
const lineFaces = (lines, n) => lines[n].map((r) => r.face);
/** A line's text, reconstructed. */
const lineText = (lines, n) => lines[n].map((r) => r.text).join('');

test('the whole-buffer dispatcher returns null for languages without one', () => {
  assert.equal(highlightBuffer('x = 1', 'python'), null);
  assert.equal(highlightBuffer('const x = 1', 'javascript'), null);
});

test('LaTeX: a single line still tokenizes', () => {
  const lines = highlightLatexBuffer('\\emph{word} % note');
  assert.equal(lines.length, 1);
  assert.deepEqual(lineFaces(lines, 0), ['keyword', 'paren', null, 'paren', null, 'comment']);
  assert.equal(lineText(lines, 0), '\\emph{word} % note');
});

test('LaTeX verbatim: every body line is styled past the begin', () => {
  const src = '\\begin{verbatim}\nfoo bar\nbaz\n\\end{verbatim}';
  const lines = highlightLatexBuffer(src);
  assert.equal(lines.length, 4);
  // The opening line: the \begin{verbatim} is keyword-styled.
  assert.ok(lines[0].some((r) => r.face === 'keyword'));
  // Body lines are styled wholesale as 'string'.
  assert.deepEqual(lines[1], [{ text: 'foo bar', face: 'string' }]);
  assert.deepEqual(lines[2], [{ text: 'baz', face: 'string' }]);
  // The closing line: the \end{verbatim} is keyword-styled.
  assert.ok(lines[3].some((r) => r.face === 'keyword'));
});

test('LaTeX display math \\[...\\]: spans across lines', () => {
  const src = '\\[\nE = mc^2\n\\]';
  const lines = highlightLatexBuffer(src);
  assert.equal(lines.length, 3);
  // The body is one 'string' run; the closing \] is keyword.
  assert.deepEqual(lines[1], [{ text: 'E = mc^2', face: 'string' }]);
  assert.ok(lines[2].some((r) => r.face === 'keyword' && r.text === '\\]'));
});

test('LaTeX: comments do not start a block, even when next to \\begin', () => {
  const lines = highlightLatexBuffer('% \\begin{verbatim}\nplain text');
  assert.equal(lines.length, 2);
  // The first line is the whole comment, no block entered.
  assert.deepEqual(lines[0], [{ text: '% \\begin{verbatim}', face: 'comment' }]);
  // The second line is plain text, NOT styled as string.
  assert.deepEqual(lines[1], [{ text: 'plain text', face: null }]);
});

test('LaTeX: lines reconstruct the source after splitting on \\n', () => {
  const src = '\\section{Intro}\n\\begin{align}\na = b\nc = d\n\\end{align}\n% done';
  const lines = highlightLatexBuffer(src);
  const expected = src.split('\n');
  assert.equal(lines.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    assert.equal(lineText(lines, i), expected[i]);
  }
});

test('Makefile define ... endef: the body lines are styled', () => {
  const src = 'define greeting\n  hello\n  world\nendef\nall:';
  const lines = highlightMakefileBuffer(src);
  assert.equal(lines.length, 5);
  // The opening "define greeting" — `define` keyword, the name as constant.
  assert.ok(lines[0].some((r) => r.face === 'keyword' && r.text === 'define'));
  assert.ok(lines[0].some((r) => r.face === 'constant' && r.text === 'greeting'));
  assert.deepEqual(lines[1], [{ text: '  hello', face: 'string' }]);
  assert.deepEqual(lines[2], [{ text: '  world', face: 'string' }]);
  // The closing endef.
  assert.ok(lines[3].some((r) => r.face === 'keyword' && r.text === 'endef'));
  // After endef, normal makefile tokenizing resumes — `all` is a target.
  assert.ok(lines[4].some((r) => r.face === 'keyword' && r.text === 'all'));
});

test('Makefile: lines outside define still go through the per-line tokenizer', () => {
  const src = 'CC = gcc\nall: build\n\t$(CC) -o app';
  const lines = highlightMakefileBuffer(src);
  assert.ok(lines[0].some((r) => r.face === 'constant' && r.text === 'CC'));
  assert.ok(lines[1].some((r) => r.face === 'keyword' && r.text === 'all'));
  assert.ok(lines[2].some((r) => r.face === 'constant' && r.text === '$(CC)'));
});

// --- Markdown with embedded LaTeX math --------------------------------

/** All runs of a line whose face matches. */
const lineRunsWithFace = (lines, n, face) =>
  lines[n].filter((r) => r.face === face);

test('Markdown: inline $…$ tokenizes the body as LaTeX, delimiters as string', () => {
  const lines = highlightMarkdownBuffer('the $\\alpha + x$ end');
  assert.equal(lines.length, 1);
  assert.deepEqual(lineFaces(lines, 0), [
    null, 'string', 'keyword', null, 'string', null,
  ]);
  // The control sequence in the body is keyword-styled.
  assert.ok(lines[0].some((r) => r.face === 'keyword' && r.text === '\\alpha'));
  // The delimiters are the string face.
  assert.deepEqual(
    lineRunsWithFace(lines, 0, 'string').map((r) => r.text),
    ['$', '$']
  );
  assert.equal(lineText(lines, 0), 'the $\\alpha + x$ end');
});

test('Markdown: display $$…$$ spans lines, body highlighted as LaTeX', () => {
  const src = '$$\n\\frac{a}{b}\n$$';
  const lines = highlightMarkdownBuffer(src);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], [{ text: '$$', face: 'string' }]);
  assert.ok(lines[1].some((r) => r.face === 'keyword' && r.text === '\\frac'));
  assert.ok(lines[1].some((r) => r.face === 'paren' && r.text === '{'));
  assert.deepEqual(lines[2], [{ text: '$$', face: 'string' }]);
  assert.equal(src.split('\n').join('\n'),
    lines.map((_, i) => lineText(lines, i)).join('\n'));
});

test('Markdown: \\(…\\) and \\[…\\] are recognised', () => {
  const inline = highlightMarkdownBuffer('see \\(a+b\\) ok');
  assert.deepEqual(
    lineRunsWithFace(inline, 0, 'string').map((r) => r.text),
    ['\\(', '\\)']
  );
  assert.equal(lineText(inline, 0), 'see \\(a+b\\) ok');

  const block = highlightMarkdownBuffer('\\[\nx = y\n\\]');
  assert.deepEqual(block[0], [{ text: '\\[', face: 'string' }]);
  assert.deepEqual(block[2], [{ text: '\\]', face: 'string' }]);
});

test('Markdown: an escaped \\$ is not a math delimiter', () => {
  const lines = highlightMarkdownBuffer('it cost \\$5 today');
  assert.equal(lineRunsWithFace(lines, 0, 'string').length, 0);
  assert.equal(lineText(lines, 0), 'it cost \\$5 today');
});

test('Markdown: $…$ inside an inline code span is not math', () => {
  const lines = highlightMarkdownBuffer('use `$x$` here');
  // No math: the code span keeps its markdown `code` face, no `string`.
  assert.equal(lineRunsWithFace(lines, 0, 'string').length, 0);
  assert.ok(lines[0].some((r) => r.face === 'code' && r.text === '`$x$`'));
});

test('Markdown: $…$ inside a fenced code block is not math', () => {
  const lines = highlightMarkdownBuffer('```\n$x$\n```');
  assert.equal(lines.length, 3);
  // The fenced body line has no math `string` run.
  assert.equal(lineRunsWithFace(lines, 1, 'string').length, 0);
  assert.equal(lineText(lines, 1), '$x$');
});

test('Markdown: non-math lines are byte-identical to the per-line tokenizer', () => {
  const src =
    '# Heading\n\nA *strong* and `code` and [link](u).\n- item\n> quote';
  const lines = highlightMarkdownBuffer(src);
  const expected = src.split('\n');
  assert.equal(lines.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    assert.deepEqual(lines[i], highlightLine(expected[i], 'markdown'));
  }
});

test('Markdown: the whole-buffer dispatcher routes markdown here', () => {
  assert.deepEqual(
    highlightBuffer('a $x$ b', 'markdown'),
    highlightMarkdownBuffer('a $x$ b')
  );
});
