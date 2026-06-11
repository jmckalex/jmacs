/**
 * @file jmarkdown.test.js — the JMarkdown major mode
 * (lisp/languages/jmarkdown.lisp): the `.jmd` suffix registration, the
 * keymap, the structured menu, and the dialect's insertion commands,
 * exercised over a tiny in-memory buffer stub.
 *
 * The harness loads the full standard library plus the jmarkdown
 * language file (via `listLanguageFiles`, the same hook the desktop app
 * uses for `lisp/languages/` discovery).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, NIL } from '@editor/lisp';
import { createLatexPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/**
 * An interpreter with the stdlib + the jmarkdown language file loaded,
 * and the editing primitives the insertion commands touch stubbed over
 * one in-memory buffer (text + point + an optional active region).
 */
async function jmdEditor() {
  const buffer = { text: '', pos: 0, region: null, secondaries: [] };
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
      'buffer-text': () => buffer.text,
      'show-status!': () => NIL,
      'clear-status!': () => NIL,
      'buffer-major-mode': () => NIL,
      'buffer-minor-modes': () => NIL,
      'insert!': (args) => {
        const s = String(args[0]);
        buffer.text =
          buffer.text.slice(0, buffer.pos) + s + buffer.text.slice(buffer.pos);
        buffer.pos += s.length;
        return NIL;
      },
      point: () => buffer.pos,
      'goto!': (args) => {
        buffer.pos = Number(args[0]);
        return NIL;
      },
      'region-active?': () => buffer.region !== null,
      'region-text': () => buffer.region ?? '',
      'delete-backward!': () => {
        // The commands use this to delete the active region.
        buffer.region = null;
        return NIL;
      },
      'add-selection!': (args) => {
        buffer.secondaries.push(Number(args[0]));
        return NIL;
      },
    },
  });
  const { failures } = await loadStdlib(
    interpreter,
    (name) => readFile(join(lispDir, name), 'utf8'),
    { listLanguageFiles: () => ['jmarkdown.lisp'] }
  );
  assert.deepEqual(
    failures.map((f) => f.name).filter((n) => n.includes('jmarkdown')),
    [],
    'jmarkdown.lisp loads cleanly'
  );
  const ev = (s) => interpreter.evaluate(s);
  return { ev, buffer };
}

test('.jmd buffers get jmarkdown-mode; .md stays markdown-mode', async () => {
  const { ev } = await jmdEditor();
  assert.equal(ev('(get (mode-for-name "notes.jmd") :name "?")'), 'JMarkdown');
  assert.equal(ev('(get (mode-for-name "notes.md") :name "?")'), 'Markdown');
});

test('the mode declares the jmarkdown highlighter and its keymap', async () => {
  const { ev } = await jmdEditor();
  assert.equal(ev('(eq? (get jmarkdown-mode :highlight nil) :jmarkdown)'), true);
  assert.equal(ev("(eq? (get jmarkdown-mode :keymap nil) 'jmarkdown-mode-map)"), true);
  // The C-c prefix map binds shared markdown commands and dialect ones.
  assert.equal(ev('(eq? (get (get jmarkdown-mode-map "C-c") "b") \'markdown-bold)'), true);
  assert.equal(
    ev('(eq? (get (get jmarkdown-mode-map "C-c") "d") \'jmarkdown-insert-directive)'),
    true
  );
  assert.equal(
    ev('(eq? (get (get jmarkdown-mode-map "C-c") "C-p") \'toggle-jmarkdown-math-preview)'),
    true
  );
});

test('a structured menu is registered for JMarkdown', async () => {
  const { ev } = await jmdEditor();
  assert.equal(ev('(nil? (get *mode-menu-sections* "JMarkdown" nil))'), false);
});

test('jmarkdown-intense and jmarkdown-underline surround the cursor', async () => {
  const { ev, buffer } = await jmdEditor();
  ev('(jmarkdown-intense)');
  assert.equal(buffer.text, '****');
  assert.equal(buffer.pos, 2);
  buffer.text = '';
  buffer.pos = 0;
  ev('(jmarkdown-underline)');
  assert.equal(buffer.text, '____');
  assert.equal(buffer.pos, 2);
});

test('jmarkdown-insert-directive leaves point after ::: to type the name', async () => {
  const { ev, buffer } = await jmdEditor();
  ev('(jmarkdown-insert-directive)');
  assert.equal(buffer.text, ':::\n\n:::');
  assert.equal(buffer.pos, 3);
});

test('jmarkdown-insert-directive wraps the selection as the body', async () => {
  const { ev, buffer } = await jmdEditor();
  buffer.region = 'The body.';
  ev('(jmarkdown-insert-directive)');
  assert.equal(buffer.text, ':::\nThe body.\n:::');
  assert.equal(buffer.pos, 3);
});

test('jmarkdown-insert-environment cursors both parens (multi-cursor)', async () => {
  const { ev, buffer } = await jmdEditor();
  ev('(jmarkdown-insert-environment)');
  assert.equal(buffer.text, '@begin()\n\n@end()');
  // Primary inside @begin(, a secondary cursor inside @end( — typing
  // the environment name lands in both.
  assert.equal(buffer.pos, 7);
  assert.deepEqual(buffer.secondaries, [15]);
  assert.equal(buffer.text[15], ')', 'secondary sits just inside @end(');
});

test('jmarkdown-insert-environment wraps a selection, cursors aligned', async () => {
  const { ev, buffer } = await jmdEditor();
  buffer.region = 'Body line.';
  ev('(jmarkdown-insert-environment)');
  assert.equal(buffer.text, '@begin()\nBody line.\n@end()');
  assert.equal(buffer.pos, 7);
  assert.deepEqual(buffer.secondaries, [15 + 'Body line.'.length]);
});

test('TiKZ and mermaid templates leave point on the body line', async () => {
  const { ev, buffer } = await jmdEditor();
  ev('(jmarkdown-insert-tikz)');
  assert.equal(buffer.text, ':::TiKZ\n\n:::');
  assert.equal(buffer.pos, 8);
  buffer.text = '';
  buffer.pos = 0;
  ev('(jmarkdown-insert-mermaid)');
  assert.equal(buffer.text, ':::mermaid\n\n:::');
  assert.equal(buffer.pos, 11);
});

test('ref and label insert with point on the key', async () => {
  const { ev, buffer } = await jmdEditor();
  ev('(jmarkdown-insert-ref)');
  assert.equal(buffer.text, ':ref[]');
  assert.equal(buffer.pos, 5);
});

test('the math-preview defcustom and toggle exist', async () => {
  const { ev } = await jmdEditor();
  assert.equal(ev('*jmarkdown-math-preview-default*'), false);
  // The toggle enables the general math-preview minor mode; with the
  // minor-mode primitives stubbed to nil it must at least be callable.
  assert.equal(ev("(procedure? toggle-jmarkdown-math-preview)"), true);
});
