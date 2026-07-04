/**
 * @file jmarkdown-fill-indent.test.js — the JMarkdown auto-fill
 * continuation indenter (`jmarkdown-fill-indent`, the mode's
 * `:fill-indent-function`) and its end-to-end behaviour with
 * auto-fill-mode.
 *
 * Over a REAL L2 buffer (`createBufferPrimitives` + `@editor/buffer`) with
 * the full stdlib + the jmarkdown language file loaded, so `line-start`,
 * markers, the mode registry and the self-insert → post-self-insert-hook →
 * do-auto-fill chain are all genuine. A list item wraps with a hanging
 * indent, a blockquote keeps its `>` — matching M-q's fill-paragraph.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import { createInterpreter, NIL } from '@editor/lisp';
import {
  createBufferPrimitives,
  createLatexPrimitives,
  loadStdlib,
} from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

async function jmdEditor(initialText = '') {
  const buffer = createBuffer(initialText, { name: 'doc.jmd' });
  const session = { current: buffer };
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
      ...createBufferPrimitives(session),
    },
  });
  await loadStdlib(
    interpreter,
    (name) => readFile(join(lispDir, name), 'utf8'),
    { listLanguageFiles: () => ['jmarkdown.lisp'] }
  );
  const ev = (s) => interpreter.evaluate(s);
  return { buffer, ev };
}

// --- wiring --------------------------------------------------------------

test('jmarkdown-mode carries :fill-indent-function', async () => {
  const { ev } = await jmdEditor();
  assert.equal(
    ev(`(eq? (get jmarkdown-mode :fill-indent-function nil)
             'jmarkdown-fill-indent)`),
    true
  );
});

// --- jmarkdown-fill-indent in isolation ----------------------------------

test('jmarkdown-fill-indent hangs the continuation under a list item', async () => {
  // "- hello\n" with point at the start of the (empty) second line.
  const { buffer, ev } = await jmdEditor('- hello\n');
  ev('(goto! 8)');
  ev('(jmarkdown-fill-indent)');
  assert.equal(buffer.text, '- hello\n  '); // two-space hanging indent
});

test('jmarkdown-fill-indent repeats the > for a blockquote continuation', async () => {
  const { buffer, ev } = await jmdEditor('> hello\n');
  ev('(goto! 8)');
  ev('(jmarkdown-fill-indent)');
  assert.equal(buffer.text, '> hello\n> ');
});

test('jmarkdown-fill-indent copies plain-prose indentation', async () => {
  const { buffer, ev } = await jmdEditor('    hello\n');
  ev('(goto! 10)'); // start of the empty next line
  ev('(jmarkdown-fill-indent)');
  assert.equal(buffer.text, '    hello\n    ');
});

// --- end to end: auto-fill-mode wrapping in a JMarkdown buffer ------------

test('auto-fill wraps a JMarkdown list item with a hanging indent', async () => {
  const { buffer, ev } = await jmdEditor('- one two three fou');
  ev('(set-major-mode! jmarkdown-mode)');
  ev('(enable-minor-mode auto-fill-minor-mode)');
  ev('(set! *fill-column* 12)');
  ev('(goto! 19)'); // end
  ev('(handle-key "r")'); // "…four" pushes past 12 -> wrap
  assert.equal(buffer.text, '- one two\n  three four');
});

test('auto-fill keeps the > when wrapping a blockquote', async () => {
  const { buffer, ev } = await jmdEditor('> one two three fou');
  ev('(set-major-mode! jmarkdown-mode)');
  ev('(enable-minor-mode auto-fill-minor-mode)');
  ev('(set! *fill-column* 12)');
  ev('(goto! 19)');
  ev('(handle-key "r")');
  assert.equal(buffer.text, '> one two\n> three four');
});

test('auto-fill in plain JMarkdown prose just wraps flush-left', async () => {
  const { buffer, ev } = await jmdEditor('one two three four fiv');
  ev('(set-major-mode! jmarkdown-mode)');
  ev('(enable-minor-mode auto-fill-minor-mode)');
  ev('(set! *fill-column* 12)');
  ev('(goto! 22)');
  ev('(handle-key "e")'); // "five" pushes past 12
  assert.equal(buffer.text, 'one two\nthree four five');
});
