/**
 * @file jmarkdown-fill.test.js — the JMarkdown-aware fill-paragraph
 * (languages/jmarkdown.lisp): @begin/@end and other structural lines
 * bound the paragraph, indentation survives the re-wrap, fenced code is
 * protected, and a too-long @begin line wraps its [label] / {attrs}
 * parts onto indented lines of their own. Exercised end-to-end over an
 * in-memory buffer stub (the line-indent.test.js harness).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, NIL } from '@editor/lisp';
import { createLatexPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

async function fillEditor() {
  const buffer = { text: '', pos: 0 };
  const clamp = (n) => Math.max(0, Math.min(buffer.text.length, n));
  const interpreter = createInterpreter({
    write: () => {},
    primitives: {
      ...createLatexPrimitives(),
      'read-file-text!': () => NIL,
      'file-exists?': () => false,
      'list-directory-paths': () => NIL,
      'current-view': () => NIL,
      'view-list': () => NIL,
      'view-file-path': () => NIL,
      'view-buffer': () => NIL,
      'show-status!': () => NIL,
      'clear-status!': () => NIL,
      'buffer-major-mode': () => NIL,
      'begin-change-group!': () => NIL,
      'end-change-group!': () => NIL,
      'buffer-minor-modes': () => NIL,
      'buffer-text': () => buffer.text,
      'buffer-length': () => buffer.text.length,
      'buffer-substring': (args) =>
        buffer.text.slice(Number(args[0]), Number(args[1])),
      point: () => buffer.pos,
      'goto!': (args) => {
        buffer.pos = clamp(Number(args[0]));
        return NIL;
      },
      'insert!': (args) => {
        const s = String(args[0]);
        buffer.text =
          buffer.text.slice(0, buffer.pos) + s + buffer.text.slice(buffer.pos);
        buffer.pos += s.length;
        return NIL;
      },
      'delete-region!': (args) => {
        const a = Number(args[0]);
        const b = Number(args[1]);
        buffer.text = buffer.text.slice(0, a) + buffer.text.slice(b);
        buffer.pos = clamp(buffer.pos <= a ? buffer.pos : Math.max(a, buffer.pos - (b - a)));
        return NIL;
      },
    },
  });
  await loadStdlib(
    interpreter,
    (name) => readFile(join(lispDir, name), 'utf8'),
    { listLanguageFiles: () => ['jmarkdown.lisp'] }
  );
  const ev = (s) => interpreter.evaluate(s);
  /** Place the cursor inside the first occurrence of FRAG and fill. */
  const fillAt = (frag) => {
    const at = buffer.text.indexOf(frag);
    assert.notEqual(at, -1, `fragment ${JSON.stringify(frag)} not found`);
    buffer.pos = at;
    ev('(jmarkdown-fill-paragraph)');
  };
  return { ev, buffer, fillAt };
}

const LONG =
  'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod ' +
  'tempor incididunt ut labore et dolore magna aliqua ut enim ad minim.';

test('filling inside an environment leaves @begin/@end lines alone', async () => {
  const { buffer, fillAt } = await fillEditor();
  buffer.text = `@begin(theorem)\n${LONG}\n@end(theorem)\n`;
  fillAt('Lorem');
  const lines = buffer.text.split('\n');
  assert.equal(lines[0], '@begin(theorem)');
  assert.equal(lines[lines.length - 2], '@end(theorem)');
  // The body wrapped to the fill column.
  const body = lines.slice(1, -2);
  assert.ok(body.length >= 2, 'long body wraps onto multiple lines');
  assert.ok(body.every((l) => l.length <= 72));
  assert.equal(body.join(' ').trim(), LONG.replace(/\s+/g, ' '));
});

test('the body keeps its indent level when re-wrapped', async () => {
  const { buffer, fillAt } = await fillEditor();
  buffer.text = `@begin(quote)\n    ${LONG}\n@end(quote)\n`;
  fillAt('Lorem');
  const body = buffer.text.split('\n').slice(1, -2);
  assert.ok(body.length >= 2);
  assert.ok(body.every((l) => l.startsWith('    ')), 'indent preserved on every line');
  assert.ok(body.every((l) => l.length <= 72));
});

test('::: directive lines also bound the paragraph', async () => {
  const { buffer, fillAt } = await fillEditor();
  buffer.text = `:::note\n${LONG}\n:::\n`;
  fillAt('Lorem');
  const lines = buffer.text.split('\n');
  assert.equal(lines[0], ':::note');
  assert.equal(lines[lines.length - 2], ':::');
});

test('a long @begin line wraps its parts, indented one tab-width', async () => {
  const { buffer, fillAt } = await fillEditor();
  buffer.text =
    '  @begin(theorem)[A rather long and very descriptive label for it]' +
    '{.numbered #thm-main author="someone"}\nBody.\n@end(theorem)\n';
  fillAt('@begin');
  assert.deepEqual(buffer.text.split('\n'), [
    '  @begin(theorem)',
    '      [A rather long and very descriptive label for it]',
    '      {.numbered #thm-main author="someone"}',
    'Body.',
    '@end(theorem)',
    '',
  ]);
});

test('a short @begin line is left untouched', async () => {
  const { buffer, fillAt } = await fillEditor();
  buffer.text = '@begin(theorem)[Euclid]\nBody.\n@end(theorem)\n';
  const before = buffer.text;
  fillAt('@begin');
  assert.equal(buffer.text, before);
});

test('M-q on an @end or ::: line is a no-op', async () => {
  const { buffer, fillAt } = await fillEditor();
  buffer.text = `@begin(x)\n${LONG}\n@end(x)\n:::\n`;
  const before = buffer.text;
  fillAt('@end');
  assert.equal(buffer.text, before);
  fillAt(':::');
  assert.equal(buffer.text, before);
});

test('plain paragraphs still fill between blank lines', async () => {
  const { buffer, fillAt } = await fillEditor();
  buffer.text = `Intro.\n\n${LONG}\n\nOutro.\n`;
  fillAt('Lorem');
  const lines = buffer.text.split('\n');
  assert.equal(lines[0], 'Intro.');
  assert.equal(lines[1], '');
  assert.equal(lines[lines.length - 2], 'Outro.');
  assert.ok(lines.slice(2, -3).every((l) => l.length <= 72));
});

test('headings bound the paragraph even with no blank line between', async () => {
  const { buffer, fillAt } = await fillEditor();
  buffer.text = `# Heading\n${LONG}\n## Next\n`;
  fillAt('Lorem');
  const lines = buffer.text.split('\n');
  assert.equal(lines[0], '# Heading');
  assert.equal(lines[lines.length - 2], '## Next');
});

test('fenced code is never filled', async () => {
  const { buffer, fillAt } = await fillEditor();
  buffer.text = '```js\nconst x = 1;          // lots of    spacing\n```\n';
  const before = buffer.text;
  fillAt('const');
  assert.equal(buffer.text, before);
});

test('an already-filled paragraph is a no-op', async () => {
  const { buffer, fillAt } = await fillEditor();
  buffer.text = '@begin(note)\nShort body.\n@end(note)\n';
  const before = buffer.text;
  fillAt('Short');
  assert.equal(buffer.text, before);
});

test('M-q is bound to the JMarkdown fill in jmarkdown-mode-map', async () => {
  const { ev } = await fillEditor();
  assert.equal(
    ev(`(eq? (get jmarkdown-mode-map "M-q") 'jmarkdown-fill-paragraph)`),
    true
  );
});

// --- structural prefixes: the shared list/blockquote/definition brain ----

test('-jmd-structural-prefixes: bullets give a hanging indent', async () => {
  const { ev } = await fillEditor();
  const pair = (line) =>
    [ev(`(car (-jmd-structural-prefixes ${JSON.stringify(line)}))`),
     ev(`(cdr (-jmd-structural-prefixes ${JSON.stringify(line)}))`)];
  assert.deepEqual(pair('- item'), ['- ', '  ']);
  assert.deepEqual(pair('* item'), ['* ', '  ']);
  assert.deepEqual(pair('+ item'), ['+ ', '  ']);
});

test('-jmd-structural-prefixes: ordered lists indent to the marker width', async () => {
  const { ev } = await fillEditor();
  const pair = (line) =>
    [ev(`(car (-jmd-structural-prefixes ${JSON.stringify(line)}))`),
     ev(`(cdr (-jmd-structural-prefixes ${JSON.stringify(line)}))`)];
  assert.deepEqual(pair('1. item'), ['1. ', '   ']);
  assert.deepEqual(pair('12. item'), ['12. ', '    ']);
  assert.deepEqual(pair('3) item'), ['3) ', '   ']);
});

test('-jmd-structural-prefixes: a description-list definition (: ) hangs by two', async () => {
  const { ev } = await fillEditor();
  assert.equal(ev(`(car (-jmd-structural-prefixes ": a definition"))`), ': ');
  assert.equal(ev(`(cdr (-jmd-structural-prefixes ": a definition"))`), '  ');
});

test('-jmd-structural-prefixes: blockquote markers repeat verbatim', async () => {
  const { ev } = await fillEditor();
  assert.equal(ev(`(cdr (-jmd-structural-prefixes "> quote"))`), '> ');
  assert.equal(ev(`(cdr (-jmd-structural-prefixes "> > nested"))`), '> > ');
});

test('-jmd-structural-prefixes: plain / indented prose keeps its indent', async () => {
  const { ev } = await fillEditor();
  assert.equal(ev(`(car (-jmd-structural-prefixes "plain text"))`), '');
  assert.equal(ev(`(cdr (-jmd-structural-prefixes "    indented"))`), '    ');
  // A double dash is not a bullet (no space after the first "-").
  assert.equal(ev(`(car (-jmd-structural-prefixes "-- not a list"))`), '');
});

// --- fill-paragraph now respects list items and blockquotes ---------------

test('fill-paragraph gives a list item a hanging indent', async () => {
  const { buffer, fillAt } = await fillEditor();
  buffer.text = `- ${LONG}\n`;
  fillAt('Lorem');
  const lines = buffer.text.split('\n').slice(0, -1);
  assert.ok(lines.length >= 2, 'a long item wraps');
  assert.ok(lines[0].startsWith('- '), 'the bullet stays on the first line');
  assert.ok(
    lines.slice(1).every((l) => l.startsWith('  ') && !l.startsWith('- ')),
    'continuation lines hang under the text, no repeated bullet'
  );
  assert.ok(lines.every((l) => l.length <= 72));
  // The prose is preserved.
  const text = lines.map((l) => l.replace(/^(- |\s+)/, '')).join(' ');
  assert.equal(text, LONG.replace(/\s+/g, ' '));
});

test('fill-paragraph indents an ordered item to its marker width', async () => {
  const { buffer, fillAt } = await fillEditor();
  buffer.text = `1. ${LONG}\n`;
  fillAt('Lorem');
  const lines = buffer.text.split('\n').slice(0, -1);
  assert.ok(lines[0].startsWith('1. '));
  assert.ok(lines.slice(1).every((l) => l.startsWith('   ')), 'hang by three');
  assert.ok(lines.every((l) => l.length <= 72));
});

test('fill-paragraph keeps the > on every line of a blockquote', async () => {
  const { buffer, fillAt } = await fillEditor();
  buffer.text = `> ${LONG}\n`;
  fillAt('Lorem');
  const lines = buffer.text.split('\n').slice(0, -1);
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((l) => l.startsWith('> ')), 'quote marker on each line');
  assert.ok(lines.every((l) => l.length <= 72));
  const text = lines.map((l) => l.replace(/^>\s+/, '')).join(' ');
  assert.equal(text, LONG.replace(/\s+/g, ' '));
});
