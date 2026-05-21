import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import { createInterpreter } from '@editor/lisp';
import { createBufferPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/** Build a buffer with the standard library loaded against it. */
async function editor(initialText = 'hello world') {
  const buffer = createBuffer(initialText, { name: 'test' });
  const interpreter = createInterpreter({
    primitives: createBufferPrimitives(buffer),
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'));
  return { buffer, interpreter };
}

/** Send a key through the Lisp keymap; returns whether it was handled. */
const press = (interpreter, key) => interpreter.call('handle-key', key);

test('the standard library loads its commands', async () => {
  const { interpreter } = await editor();
  assert.equal(interpreter.evaluate('(procedure? forward-char)'), true);
  assert.equal(typeof interpreter.evaluate('(doc forward-char)'), 'string');
});

test('a printable key self-inserts', async () => {
  const { buffer, interpreter } = await editor('ello');
  assert.equal(press(interpreter, 'h'), true);
  assert.equal(buffer.text, 'hello');
});

test('space self-inserts', async () => {
  const { buffer, interpreter } = await editor('ab');
  buffer.moveTo(1);
  press(interpreter, ' ');
  assert.equal(buffer.text, 'a b');
});

test('enter inserts a newline', async () => {
  const { buffer, interpreter } = await editor('ab');
  buffer.moveTo(1);
  press(interpreter, 'enter');
  assert.equal(buffer.text, 'a\nb');
});

test('arrow keys move the cursor', async () => {
  const { buffer, interpreter } = await editor('hello');
  press(interpreter, 'right');
  press(interpreter, 'right');
  assert.equal(buffer.point, 2);
  press(interpreter, 'left');
  assert.equal(buffer.point, 1);
});

test('backspace deletes the character before the cursor', async () => {
  const { buffer, interpreter } = await editor('hello world');
  buffer.moveTo(5);
  press(interpreter, 'backspace');
  assert.equal(buffer.text, 'hell world');
});

test('delete removes the character after the cursor', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(0);
  press(interpreter, 'delete');
  assert.equal(buffer.text, 'ello');
});

test('shift with an arrow extends the selection', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(1);
  press(interpreter, 'S-right');
  press(interpreter, 'S-right');
  assert.deepEqual(buffer.selection, { start: 1, end: 3 });
});

test('C-z undoes the last change', async () => {
  const { buffer, interpreter } = await editor('start');
  buffer.moveTo(5);
  press(interpreter, '!');
  assert.equal(buffer.text, 'start!');
  press(interpreter, 'C-z');
  assert.equal(buffer.text, 'start');
});

test('handle-key reports whether the key was handled', async () => {
  const { interpreter } = await editor();
  assert.equal(press(interpreter, 'right'), true);
  assert.equal(press(interpreter, 'C-q'), false);
});

test('the keymap is an inspectable Lisp value', async () => {
  const { interpreter } = await editor();
  assert.equal(interpreter.evaluate('(map? the-keymap)'), true);
  // Keys bind to command names (symbols), resolved late.
  assert.equal(interpreter.evaluate('(symbol? (get the-keymap "left"))'), true);
});

test('redefining a command changes the editor behaviour', async () => {
  // The point of a Lisp-defined editor: commands are live.
  const { buffer, interpreter } = await editor('');
  interpreter.evaluate('(define (newline) (insert! " / "))');
  press(interpreter, 'enter');
  assert.equal(buffer.text, ' / ');
});
