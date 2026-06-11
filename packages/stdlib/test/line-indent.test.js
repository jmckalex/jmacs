/**
 * @file line-indent.test.js — the Sublime-style block indentation
 * commands in line-ops.lisp: `indent-region` (M-]) and `outdent-region`
 * (M-[), exercised over an in-memory buffer stub that models point,
 * mark, and the line-geometry primitives.
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
 * An interpreter with the stdlib loaded and the buffer/cursor
 * primitives the indent commands touch stubbed over one mutable
 * buffer model: `{ text, pos, mark }` (mark null = no region).
 */
async function indentEditor() {
  const buffer = { text: '', pos: 0, mark: null };
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
      'buffer-minor-modes': () => NIL,
      'buffer-text': () => buffer.text,
      'buffer-length': () => buffer.text.length,
      'buffer-substring': (args) =>
        buffer.text.slice(Number(args[0]), Number(args[1])),
      point: () => buffer.pos,
      mark: () => (buffer.mark === null ? NIL : buffer.mark),
      'region-active?': () => buffer.mark !== null,
      'set-mark!': (args) => {
        buffer.mark = clamp(Number(args[0]));
        return NIL;
      },
      'goto!': (args) => {
        buffer.pos = clamp(Number(args[0]));
        return NIL;
      },
      'line-start': () => buffer.text.lastIndexOf('\n', buffer.pos - 1) + 1,
      'line-end': () => {
        const at = buffer.text.indexOf('\n', buffer.pos);
        return at === -1 ? buffer.text.length : at;
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
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'), {});
  const ev = (s) => interpreter.evaluate(s);
  return { ev, buffer };
}

test('indent-region with no region indents the current line, cursor follows', async () => {
  const { ev, buffer } = await indentEditor();
  buffer.text = 'alpha\nbeta\ngamma\n';
  buffer.pos = buffer.text.indexOf('eta'); // inside "beta"
  ev('(indent-region)');
  assert.equal(buffer.text, 'alpha\n    beta\ngamma\n');
  assert.equal(buffer.text.slice(buffer.pos), 'eta\ngamma\n', 'cursor stays on its character');
});

test('a cursor at column 0 stays at column 0 after indenting', async () => {
  const { ev, buffer } = await indentEditor();
  buffer.text = 'alpha\n';
  buffer.pos = 0;
  ev('(indent-region)');
  assert.equal(buffer.text, '    alpha\n');
  assert.equal(buffer.pos, 0);
});

test('indent-region shifts every line the region touches and keeps the region', async () => {
  const { ev, buffer } = await indentEditor();
  buffer.text = 'one\ntwo\nthree\nfour\n';
  buffer.mark = buffer.text.indexOf('ne'); // inside "one"
  buffer.pos = buffer.text.indexOf('ree'); // inside "three"
  ev('(indent-region)');
  assert.equal(buffer.text, '    one\n    two\n    three\nfour\n');
  // Region survives, shifted with its text.
  assert.equal(buffer.text.slice(buffer.mark, buffer.pos), 'ne\n    two\n    th');
  // A second press keeps going.
  ev('(indent-region)');
  assert.equal(buffer.text, '        one\n        two\n        three\nfour\n');
});

test('a region ending at column 0 does not indent that line (Sublime rule)', async () => {
  const { ev, buffer } = await indentEditor();
  buffer.text = 'one\ntwo\nthree\n';
  buffer.mark = 0;
  buffer.pos = buffer.text.indexOf('three'); // exactly at line start
  ev('(indent-region)');
  assert.equal(buffer.text, '    one\n    two\nthree\n');
});

test('blank lines are left alone by indent-region', async () => {
  const { ev, buffer } = await indentEditor();
  buffer.text = 'one\n\ntwo\n';
  buffer.mark = 0;
  buffer.pos = buffer.text.length - 1;
  ev('(indent-region)');
  assert.equal(buffer.text, '    one\n\n    two\n');
});

test('outdent-region removes up to a tab-width of spaces per line', async () => {
  const { ev, buffer } = await indentEditor();
  buffer.text = '    one\n  two\nthree\n';
  buffer.mark = 0;
  buffer.pos = buffer.text.length - 1;
  ev('(outdent-region)');
  assert.equal(buffer.text, 'one\ntwo\nthree\n');
});

test('outdent-region removes a single leading tab as one level', async () => {
  const { ev, buffer } = await indentEditor();
  buffer.text = '\t\tone\n';
  buffer.pos = buffer.text.indexOf('one');
  ev('(outdent-region)');
  assert.equal(buffer.text, '\tone\n');
  assert.equal(buffer.text.slice(buffer.pos), 'one\n', 'cursor stays on its character');
});

test('a cursor inside the removed prefix clamps to the line start', async () => {
  const { ev, buffer } = await indentEditor();
  buffer.text = '    one\n';
  buffer.pos = 2; // inside the removed indentation
  ev('(outdent-region)');
  assert.equal(buffer.text, 'one\n');
  assert.equal(buffer.pos, 0);
});

test('outdent-region on already-flush lines is a no-op', async () => {
  const { ev, buffer } = await indentEditor();
  buffer.text = 'one\ntwo\n';
  buffer.mark = 0;
  buffer.pos = buffer.text.length - 1;
  const before = buffer.text;
  ev('(outdent-region)');
  assert.equal(buffer.text, before);
});

test('*tab-width* drives the indent amount', async () => {
  const { ev, buffer } = await indentEditor();
  ev('(set! *tab-width* 2)');
  buffer.text = 'one\n';
  buffer.pos = 1;
  ev('(indent-region)');
  assert.equal(buffer.text, '  one\n');
});

test('the bracket bindings match what the architect\'s keyboard delivers', async () => {
  // Karabiner re-emits both bracket keys on the BracketRight code:
  // the [ key arrives as "M-]", the ] key as "M-S-]". "M-[" stays
  // bound for an unremapped keyboard.
  const { ev } = await indentEditor();
  assert.equal(ev(`(eq? (get the-keymap "M-S-]") 'indent-region)`), true);
  assert.equal(ev(`(eq? (get the-keymap "M-]") 'outdent-region)`), true);
  assert.equal(ev(`(eq? (get the-keymap "M-[") 'outdent-region)`), true);
});
