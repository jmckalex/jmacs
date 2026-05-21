import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import { createInterpreter, NIL } from '@editor/lisp';
import { createBufferPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/**
 * Build a buffer with the standard library loaded against it. The file
 * primitives are mocked: each call is recorded in `fileCalls`.
 */
async function editor(initialText = 'hello world') {
  const buffer = createBuffer(initialText, { name: 'test' });
  const fileCalls = [];
  const bufferCalls = [];
  const interpreter = createInterpreter({
    primitives: {
      ...createBufferPrimitives({ current: buffer }),
      'open-file!': () => {
        fileCalls.push('open');
        return NIL;
      },
      'save-buffer!': () => {
        fileCalls.push('save');
        return NIL;
      },
      'reload-stdlib!': () => NIL,
      'next-buffer!': () => {
        bufferCalls.push('next');
        return NIL;
      },
      'previous-buffer!': () => {
        bufferCalls.push('previous');
        return NIL;
      },
      'new-buffer!': () => {
        bufferCalls.push('new');
        return NIL;
      },
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'));
  return { buffer, interpreter, fileCalls, bufferCalls };
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

// --- key sequences ------------------------------------------------------

test('a prefix key begins a key sequence', async () => {
  const { interpreter } = await editor();
  assert.equal(press(interpreter, 'C-x'), true);
  // Dispatch has moved off the root keymap, waiting for the next key.
  assert.equal(
    interpreter.evaluate('(not (eq? active-keymap the-keymap))'),
    true
  );
});

test('C-x C-s runs save-buffer', async () => {
  const { interpreter, fileCalls } = await editor();
  press(interpreter, 'C-x');
  press(interpreter, 'C-s');
  assert.deepEqual(fileCalls, ['save']);
  // The sequence completed: dispatch is back at the root keymap.
  assert.equal(interpreter.evaluate('(eq? active-keymap the-keymap)'), true);
});

test('C-x C-f runs find-file', async () => {
  const { interpreter, fileCalls } = await editor();
  press(interpreter, 'C-x');
  press(interpreter, 'C-f');
  assert.deepEqual(fileCalls, ['open']);
});

test('an unbound key mid-sequence aborts it without acting', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(0);
  press(interpreter, 'C-x');
  press(interpreter, 'right'); // not in the C-x map — aborts
  assert.equal(buffer.point, 0, 'the aborting key must not also move');
  // Dispatch is back at the root, so the next key works normally.
  press(interpreter, 'right');
  assert.equal(buffer.point, 1);
});

test('plain keys still work after a completed sequence', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(0);
  press(interpreter, 'C-x');
  press(interpreter, 'C-s');
  press(interpreter, 'right');
  assert.equal(buffer.point, 1);
});

// --- multiple buffers ---------------------------------------------------

test('C-x b switches to the next buffer', async () => {
  const { interpreter, bufferCalls } = await editor();
  press(interpreter, 'C-x');
  press(interpreter, 'b');
  assert.deepEqual(bufferCalls, ['next']);
});

test('C-x p switches to the previous buffer', async () => {
  const { interpreter, bufferCalls } = await editor();
  press(interpreter, 'C-x');
  press(interpreter, 'p');
  assert.deepEqual(bufferCalls, ['previous']);
});

test('C-x n creates a new buffer', async () => {
  const { interpreter, bufferCalls } = await editor();
  press(interpreter, 'C-x');
  press(interpreter, 'n');
  assert.deepEqual(bufferCalls, ['new']);
});
