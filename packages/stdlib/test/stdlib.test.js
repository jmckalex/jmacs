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
  const searchCalls = [];
  const paletteCalls = [];
  const output = [];
  const interpreter = createInterpreter({
    write: (text) => output.push(text),
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
      'start-buffer-switcher!': () => {
        bufferCalls.push('switch');
        return NIL;
      },
      'start-search!': () => {
        searchCalls.push('search');
        return NIL;
      },
      'start-search-backward!': () => {
        searchCalls.push('search-backward');
        return NIL;
      },
      'start-command-palette!': () => {
        paletteCalls.push('palette');
        return NIL;
      },
      'start-describe-command!': () => {
        paletteCalls.push('describe');
        return NIL;
      },
      'start-goto-line!': () => NIL,
      'start-replace!': () => NIL,
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'));
  return {
    buffer,
    interpreter,
    fileCalls,
    bufferCalls,
    searchCalls,
    paletteCalls,
    output,
  };
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

test('C-x b opens the buffer switcher', async () => {
  const { interpreter, bufferCalls } = await editor();
  press(interpreter, 'C-x');
  press(interpreter, 'b');
  assert.deepEqual(bufferCalls, ['switch']);
});

test('C-x right switches to the next buffer', async () => {
  const { interpreter, bufferCalls } = await editor();
  press(interpreter, 'C-x');
  press(interpreter, 'right');
  assert.deepEqual(bufferCalls, ['next']);
});

test('C-x left switches to the previous buffer', async () => {
  const { interpreter, bufferCalls } = await editor();
  press(interpreter, 'C-x');
  press(interpreter, 'left');
  assert.deepEqual(bufferCalls, ['previous']);
});

test('C-x n creates a new buffer', async () => {
  const { interpreter, bufferCalls } = await editor();
  press(interpreter, 'C-x');
  press(interpreter, 'n');
  assert.deepEqual(bufferCalls, ['new']);
});

test('C-s starts an incremental search', async () => {
  const { interpreter, searchCalls } = await editor();
  press(interpreter, 'C-s');
  assert.deepEqual(searchCalls, ['search']);
});

test('C-r starts a backward search', async () => {
  const { interpreter, searchCalls } = await editor();
  press(interpreter, 'C-r');
  assert.deepEqual(searchCalls, ['search-backward']);
});

test('M-x opens the command palette', async () => {
  const { interpreter, paletteCalls } = await editor();
  press(interpreter, 'M-x');
  assert.deepEqual(paletteCalls, ['palette']);
});

test('command-names lists the keymap commands', async () => {
  const { interpreter } = await editor();
  assert.ok(interpreter.evaluate('(> (length (command-names)) 5)'));
  assert.notEqual(
    interpreter.evaluate('(member "forward-char" (command-names))'),
    false
  );
});

// --- kill ring ----------------------------------------------------------

test('C-w cuts the selection and C-y yanks it back', async () => {
  const { buffer, interpreter } = await editor('hello world');
  buffer.moveTo(0);
  buffer.setMark(6); // select "hello "
  press(interpreter, 'C-w');
  assert.equal(buffer.text, 'world');
  press(interpreter, 'C-y');
  assert.equal(buffer.text, 'hello world');
});

test('M-w copies the selection without deleting it', async () => {
  const { buffer, interpreter } = await editor('abc');
  buffer.moveTo(0);
  buffer.setMark(3);
  press(interpreter, 'M-w');
  assert.equal(buffer.text, 'abc');
  buffer.moveTo(3);
  press(interpreter, 'C-y');
  assert.equal(buffer.text, 'abcabc');
});

test('C-k kills to the end of the line', async () => {
  const { buffer, interpreter } = await editor('keep me\nsecond');
  buffer.moveTo(4);
  press(interpreter, 'C-k');
  assert.equal(buffer.text, 'keep\nsecond');
  press(interpreter, 'C-y');
  assert.equal(buffer.text, 'keep me\nsecond');
});

test('C-k at the end of a line kills the newline', async () => {
  const { buffer, interpreter } = await editor('a\nb');
  buffer.moveTo(1);
  press(interpreter, 'C-k');
  assert.equal(buffer.text, 'ab');
});

// --- word movement ------------------------------------------------------

test('M-f moves forward by a word', async () => {
  const { buffer, interpreter } = await editor('hello world foo');
  buffer.moveTo(0);
  press(interpreter, 'M-f');
  assert.equal(buffer.point, 5);
  press(interpreter, 'M-f');
  assert.equal(buffer.point, 11);
});

test('M-b moves backward by a word', async () => {
  const { buffer, interpreter } = await editor('hello world');
  buffer.moveTo(11);
  press(interpreter, 'M-b');
  assert.equal(buffer.point, 6);
});

test('M-d kills the next word', async () => {
  const { buffer, interpreter } = await editor('hello world');
  buffer.moveTo(0);
  press(interpreter, 'M-d');
  assert.equal(buffer.text, ' world');
  press(interpreter, 'C-y');
  assert.equal(buffer.text, 'hello world');
});

test('M-backspace kills the previous word', async () => {
  const { buffer, interpreter } = await editor('hello world');
  buffer.moveTo(11);
  press(interpreter, 'M-backspace');
  assert.equal(buffer.text, 'hello ');
});

// --- help ---------------------------------------------------------------

test('C-h k describes the next key pressed', async () => {
  const { buffer, interpreter, output } = await editor('hello');
  buffer.moveTo(0);
  press(interpreter, 'C-h');
  press(interpreter, 'k');
  press(interpreter, 'right'); // the key being described
  const text = output.join('');
  assert.ok(text.includes('forward-char'), 'names the bound command');
  assert.ok(text.includes('one character'), 'shows the docstring');
  assert.equal(buffer.point, 0, 'the described key does not also run');
});

test('C-h k reports an unbound key', async () => {
  const { interpreter, output } = await editor();
  press(interpreter, 'C-h');
  press(interpreter, 'k');
  press(interpreter, 'C-q');
  assert.ok(output.join('').includes('unbound'));
});

test('C-h f opens the describe-command prompt', async () => {
  const { interpreter, paletteCalls } = await editor();
  press(interpreter, 'C-h');
  press(interpreter, 'f');
  assert.deepEqual(paletteCalls, ['describe']);
});

test('describe-named-command prints a command docstring', async () => {
  const { interpreter, output } = await editor();
  interpreter.evaluate('(describe-named-command "forward-char")');
  assert.ok(output.join('').includes('one character'));
});

// --- Emacs movement keys ------------------------------------------------

test('C-f and C-b move by a character', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(2);
  press(interpreter, 'C-f');
  assert.equal(buffer.point, 3);
  press(interpreter, 'C-b');
  assert.equal(buffer.point, 2);
});

test('C-a and C-e move to the line edges', async () => {
  const { buffer, interpreter } = await editor('a long line');
  buffer.moveTo(5);
  press(interpreter, 'C-a');
  assert.equal(buffer.point, 0);
  press(interpreter, 'C-e');
  assert.equal(buffer.point, 11);
});

test('C-g clears the selection', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(0);
  buffer.setMark(3);
  assert.notEqual(buffer.selection, null);
  press(interpreter, 'C-g');
  assert.equal(buffer.selection, null);
});

test('C-g aborts a partial key sequence', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(0);
  press(interpreter, 'C-x'); // begin a sequence
  press(interpreter, 'C-g'); // abort it
  press(interpreter, 'C-f'); // back to normal dispatch
  assert.equal(buffer.point, 1);
});

// --- indentation and select-all -----------------------------------------

test('Enter copies the current line indentation', async () => {
  const { buffer, interpreter } = await editor('    indented');
  buffer.moveTo(12);
  press(interpreter, 'enter');
  assert.equal(buffer.text, '    indented\n    ');
});

test('Enter on an unindented line adds no indentation', async () => {
  const { buffer, interpreter } = await editor('flush');
  buffer.moveTo(5);
  press(interpreter, 'enter');
  assert.equal(buffer.text, 'flush\n');
});

test('C-x h selects the whole buffer', async () => {
  const { buffer, interpreter } = await editor('hello world');
  buffer.moveTo(3);
  press(interpreter, 'C-x');
  press(interpreter, 'h');
  assert.deepEqual(buffer.selection, { start: 0, end: 11 });
});

test('M-g is bound to goto-line', async () => {
  const { interpreter } = await editor();
  assert.ok(interpreter.evaluate('(eq? (get the-keymap "M-g") (quote goto-line))'));
  assert.equal(press(interpreter, 'M-g'), true);
});

test('M-r is bound to replace-string', async () => {
  const { interpreter } = await editor();
  assert.ok(
    interpreter.evaluate('(eq? (get the-keymap "M-r") (quote replace-string))')
  );
  assert.equal(press(interpreter, 'M-r'), true);
});

test('C-x ; comments and uncomments a line', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(0);
  press(interpreter, 'C-x');
  press(interpreter, ';');
  assert.equal(buffer.text, ';; hello');
  press(interpreter, 'C-x');
  press(interpreter, ';');
  assert.equal(buffer.text, 'hello');
});

test('comment-line keeps the indentation', async () => {
  const { buffer, interpreter } = await editor('  indented');
  buffer.moveTo(0);
  press(interpreter, 'C-x');
  press(interpreter, ';');
  assert.equal(buffer.text, '  ;; indented');
});
