import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import { createInterpreter, listToArray, NIL } from '@editor/lisp';
import { createBufferPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');
const languagesDir = join(lispDir, 'languages');

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
  const noteCalls = [];
  const replCalls = [];
  const previewCalls = [];
  const minibufferPrompts = [];
  const output = [];
  const docCalls = [];
  const evalCalls = [];
  const foldCalls = [];
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
      'kill-buffer!': () => {
        bufferCalls.push('kill');
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
      'open-minibuffer!': (a) => {
        minibufferPrompts.push(a[0]);
        return NIL;
      },
      'goto-line!': () => NIL,
      'replace-all!': () => NIL,
      'recenter!': () => NIL,
      'page-lines': () => 3,
      'toggle-fold-at-point!': () => {
        foldCalls.push('toggle');
        return NIL;
      },
      'fold-all!': () => {
        foldCalls.push('all');
        return NIL;
      },
      'unfold-all!': () => {
        foldCalls.push('unfold');
        return NIL;
      },
      'toggle-repl!': () => {
        replCalls.push('toggle');
        return NIL;
      },
      'markdown-preview!': () => {
        previewCalls.push('toggle');
        return NIL;
      },
      'quit-editor!': () => NIL,
      'note-create!': () => {
        noteCalls.push('create');
        return 'note-1';
      },
      'note-edit!': () => {
        noteCalls.push('edit');
        return NIL;
      },
      'note-delete!': () => {
        noteCalls.push('delete');
        return NIL;
      },
      'note-at-point': () => {
        noteCalls.push('at-point');
        return 'note-1';
      },
      'note-next!': () => {
        noteCalls.push('next');
        return NIL;
      },
      'note-prev!': () => {
        noteCalls.push('prev');
        return NIL;
      },
      'notes-toggle!': () => {
        noteCalls.push('toggle');
        return NIL;
      },
      'write-custom-file!': () => NIL,
      'apply-theme!': () => NIL,
      // Documentation primitives: by default the test environment
      // has no doc manifest (`()`), so `doc-known?` is always false
      // and help commands fall back to the REPL. Individual tests
      // can override these by re-creating the editor with a custom
      // set of primitives if needed.
      'load-doc-manifest!': () => NIL,
      'open-doc!': (args) => {
        docCalls.push(String(args[0] ?? ''));
        return NIL;
      },
      'open-docstring-page!': (args) => {
        docCalls.push(`docstring:${String(args[0] ?? '')}`);
        return NIL;
      },
      'start-doc-search!': () => {
        docCalls.push('search');
        return NIL;
      },
      'form-bounds-at-point!': () => {
        evalCalls.push('bounds-at');
        return NIL;
      },
      'form-bounds-before-point!': () => {
        evalCalls.push('bounds-before');
        return NIL;
      },
      'eval-region!': (args) => {
        evalCalls.push(`eval-region:${args[0]}-${args[1]}`);
        return NIL;
      },
      'show-eval-log!': () => {
        evalCalls.push('show-log');
        return NIL;
      },
    },
  });
  await loadStdlib(
    interpreter,
    (name) => readFile(join(lispDir, name), 'utf8'),
    {
      listLanguageFiles: async () =>
        (await readdir(languagesDir)).filter((n) => n.endsWith('.lisp')),
    }
  );
  return {
    buffer,
    interpreter,
    fileCalls,
    bufferCalls,
    searchCalls,
    paletteCalls,
    noteCalls,
    replCalls,
    previewCalls,
    minibufferPrompts,
    output,
    docCalls,
    evalCalls,
    foldCalls,
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

test('C-SPC sets the mark, and then movement extends the region', async () => {
  const { buffer, interpreter } = await editor('hello world');
  buffer.moveTo(0);
  press(interpreter, 'C-space');
  press(interpreter, 'C-f');
  press(interpreter, 'C-f');
  assert.deepEqual(buffer.selection, { start: 0, end: 2 });
});

test('with no mark, plain movement does not select', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(0);
  press(interpreter, 'C-f');
  assert.equal(buffer.selection, null);
});

test('C-g deactivates the region', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(0);
  press(interpreter, 'C-space');
  press(interpreter, 'C-f');
  assert.notEqual(buffer.selection, null);
  press(interpreter, 'C-g');
  assert.equal(buffer.selection, null);
});

test('C-S-f extends the selection by a character', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(0);
  press(interpreter, 'C-S-f');
  press(interpreter, 'C-S-f');
  assert.deepEqual(buffer.selection, { start: 0, end: 2 });
});

test('word movement extends an active region', async () => {
  const { buffer, interpreter } = await editor('alpha beta');
  buffer.moveTo(0);
  press(interpreter, 'C-space');
  press(interpreter, 'M-f');
  assert.deepEqual(buffer.selection, { start: 0, end: 5 });
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
  // The sequence completed: dispatch is back at rest.
  assert.equal(interpreter.evaluate('(nil? active-keymap)'), true);
});

test('C-x C-c is bound to quit-editor', async () => {
  const { interpreter } = await editor();
  assert.ok(
    interpreter.evaluate('(eq? (get c-x-keymap "C-c") (quote quit-editor))')
  );
  press(interpreter, 'C-x');
  assert.equal(press(interpreter, 'C-c'), true);
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

// --- yank-pop -----------------------------------------------------------

test('M-y is bound to yank-pop', async () => {
  const { interpreter } = await editor();
  assert.ok(
    interpreter.evaluate('(eq? (get the-keymap "M-y") (quote yank-pop))')
  );
});

test('M-y after a yank replaces it with the previous kill', async () => {
  const { buffer, interpreter } = await editor('');
  // Build a kill ring: "second" is newer, so on top.
  interpreter.evaluate('(kill-ring-add! "first")');
  interpreter.evaluate('(kill-ring-add! "second")');
  press(interpreter, 'C-y');
  assert.equal(buffer.text, 'second');
  press(interpreter, 'M-y');
  assert.equal(buffer.text, 'first', 'M-y swaps in the previous kill');
});

test('repeated M-y keeps cycling back through the kill ring', async () => {
  const { buffer, interpreter } = await editor('');
  interpreter.evaluate('(kill-ring-add! "one")');
  interpreter.evaluate('(kill-ring-add! "two")');
  interpreter.evaluate('(kill-ring-add! "three")');
  press(interpreter, 'C-y');
  assert.equal(buffer.text, 'three');
  press(interpreter, 'M-y');
  assert.equal(buffer.text, 'two');
  press(interpreter, 'M-y');
  assert.equal(buffer.text, 'one');
  // The ring wraps: a further M-y returns to the most recent kill.
  press(interpreter, 'M-y');
  assert.equal(buffer.text, 'three');
});

test('M-y leaves the cursor after the swapped-in text', async () => {
  const { buffer, interpreter } = await editor('[]');
  buffer.moveTo(1); // between the brackets
  interpreter.evaluate('(kill-ring-add! "x")');
  interpreter.evaluate('(kill-ring-add! "longer")');
  press(interpreter, 'C-y');
  assert.equal(buffer.text, '[longer]');
  press(interpreter, 'M-y');
  assert.equal(buffer.text, '[x]');
  assert.equal(buffer.point, 2, 'cursor sits just after the swapped text');
});

test('M-y with no preceding yank does nothing to the buffer', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(5);
  interpreter.evaluate('(kill-ring-add! "world")');
  press(interpreter, 'M-y'); // not after a yank
  assert.equal(buffer.text, 'hello', 'yank-pop is inert without a prior yank');
});

test('a command between yank and M-y invalidates yank-pop', async () => {
  const { buffer, interpreter } = await editor('');
  interpreter.evaluate('(kill-ring-add! "first")');
  interpreter.evaluate('(kill-ring-add! "second")');
  press(interpreter, 'C-y');
  assert.equal(buffer.text, 'second');
  press(interpreter, 'right'); // any non-yank command breaks the chain
  press(interpreter, 'M-y');
  assert.equal(buffer.text, 'second', 'yank-pop no longer applies');
});

test('run-command tracks the previous command in *last-command*', async () => {
  const { interpreter } = await editor();
  press(interpreter, 'C-y'); // yank
  press(interpreter, 'M-x'); // execute-command
  assert.ok(
    interpreter.evaluate("(eq? *last-command* 'yank)"),
    '*last-command* holds the command that ran before this one'
  );
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

test('C-t transposes the two characters before the cursor', async () => {
  const { buffer, interpreter } = await editor('abcd');
  buffer.moveTo(3); // after "abc"
  press(interpreter, 'C-t');
  assert.equal(buffer.text, 'acbd');
});

test('C-t at the buffer start does nothing', async () => {
  const { buffer, interpreter } = await editor('ab');
  buffer.moveTo(1);
  press(interpreter, 'C-t');
  assert.equal(buffer.text, 'ab');
});

test('C-l is bound to recenter', async () => {
  const { interpreter } = await editor();
  assert.ok(interpreter.evaluate('(eq? (get the-keymap "C-l") (quote recenter))'));
  assert.equal(press(interpreter, 'C-l'), true);
});

// --- more classic Emacs keys --------------------------------------------

test('C-o opens a line after the cursor', async () => {
  const { buffer, interpreter } = await editor('abc');
  buffer.moveTo(1);
  press(interpreter, 'C-o');
  assert.equal(buffer.text, 'a\nbc');
  assert.equal(buffer.point, 1);
});

test('M-m moves to the first non-blank character', async () => {
  const { buffer, interpreter } = await editor('    hello');
  buffer.moveTo(9);
  press(interpreter, 'M-m');
  assert.equal(buffer.point, 4);
});

test('C-x C-x exchanges point and mark', async () => {
  const { buffer, interpreter } = await editor('hello world');
  buffer.moveTo(2);
  buffer.setMark(8);
  press(interpreter, 'C-x');
  press(interpreter, 'C-x');
  assert.equal(buffer.point, 8);
  assert.equal(buffer.mark, 2);
});

test('C-v moves forward by a screenful', async () => {
  const { buffer, interpreter } = await editor('l0\nl1\nl2\nl3\nl4\nl5');
  buffer.moveTo(0);
  press(interpreter, 'C-v'); // page-lines is mocked to 3
  assert.equal(buffer.positionAt(buffer.point).line, 3);
});

test('M-< and M-> jump to the buffer ends', async () => {
  const { buffer, interpreter } = await editor('first\nmiddle\nlast');
  buffer.moveTo(8);
  press(interpreter, 'M-S-period');
  assert.equal(buffer.point, buffer.length);
  press(interpreter, 'M-S-comma');
  assert.equal(buffer.point, 0);
});

// --- fill-paragraph and sentence commands -------------------------------

test('M-q joins a short paragraph onto one line', async () => {
  const { buffer, interpreter } = await editor('aaa\nbbb\nccc');
  buffer.moveTo(0);
  press(interpreter, 'M-q');
  assert.equal(buffer.text, 'aaa bbb ccc');
});

test('M-q re-wraps only the paragraph the cursor is in', async () => {
  const { buffer, interpreter } = await editor('aaa\nbbb\n\nccc ddd');
  buffer.moveTo(0);
  press(interpreter, 'M-q');
  assert.equal(buffer.text, 'aaa bbb\n\nccc ddd');
});

test('M-q wraps a long paragraph at the fill column', async () => {
  const { buffer, interpreter } = await editor(Array(20).fill('wxyz').join(' '));
  buffer.moveTo(0);
  press(interpreter, 'M-q');
  const lines = buffer.text.split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(line.length <= 72);
});

test('M-e and M-a move by sentence', async () => {
  const { buffer, interpreter } = await editor('First sentence. Second one.');
  buffer.moveTo(0);
  press(interpreter, 'M-e');
  assert.equal(buffer.point, 15);
  press(interpreter, 'M-e');
  assert.equal(buffer.point, 27);
  press(interpreter, 'M-a');
  assert.equal(buffer.point, 16);
});

test('M-k kills to the end of the sentence', async () => {
  const { buffer, interpreter } = await editor('First sentence. Second.');
  buffer.moveTo(0);
  press(interpreter, 'M-k');
  assert.equal(buffer.text, ' Second.');
  press(interpreter, 'C-y');
  assert.equal(buffer.text, 'First sentence. Second.');
});

// --- modes --------------------------------------------------------------

test('define-mode builds a mode the accessors can read', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate('(set-major-mode! lisp-mode)');
  assert.equal(interpreter.evaluate('(major-mode-name)'), 'Lisp');
  assert.equal(interpreter.evaluate('(comment-prefix)'), ';; ');
});

test('mode-for-name picks a major mode by filename suffix', async () => {
  const { interpreter } = await editor();
  assert.ok(interpreter.evaluate('(eq? (mode-for-name "core.lisp") lisp-mode)'));
  assert.ok(interpreter.evaluate('(eq? (mode-for-name "notes.md") markdown-mode)'));
  assert.ok(interpreter.evaluate('(eq? (mode-for-name "x.txt") fundamental-mode)'));
});

test('mode-for-name resolves HTML, LaTeX, Python and Makefile', async () => {
  const { interpreter } = await editor();
  assert.ok(interpreter.evaluate('(eq? (mode-for-name "page.html") html-mode)'));
  assert.ok(interpreter.evaluate('(eq? (mode-for-name "paper.tex") latex-mode)'));
  assert.ok(interpreter.evaluate('(eq? (mode-for-name "app.py") python-mode)'));
  assert.ok(interpreter.evaluate('(eq? (mode-for-name "Makefile") makefile-mode)'));
});

test('choose-major-mode! sets the buffer mode from its name', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate('(choose-major-mode!)'); // the test buffer is "test"
  assert.ok(interpreter.evaluate('(eq? (buffer-major-mode) fundamental-mode)'));
});

test('comment-line uses the major mode comment prefix', async () => {
  const { buffer, interpreter } = await editor('hello');
  interpreter.evaluate('(set-major-mode! javascript-mode)');
  buffer.moveTo(0);
  press(interpreter, 'C-x');
  press(interpreter, ';');
  assert.equal(buffer.text, '// hello');
});

test('a mode keymap shadows the global keymap', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(0);
  // A mode whose keymap rebinds C-d (globally delete-forward).
  interpreter.evaluate(
    '(set-major-mode! (hash-map :keymap (hash-map "C-d" (quote forward-char))))'
  );
  press(interpreter, 'C-d');
  assert.equal(buffer.text, 'hello'); // not deleted
  assert.equal(buffer.point, 1); // moved forward instead
});

test('keys the mode does not bind fall through to the global keymap', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(0);
  interpreter.evaluate(
    '(set-major-mode! (hash-map :keymap (hash-map "C-d" (quote forward-char))))'
  );
  press(interpreter, 'C-f'); // not in the mode map → global keymap
  assert.equal(buffer.point, 1);
});

// --- mode hooks and minor modes -----------------------------------------

test('switching major mode runs the on-disable and on-enable hooks', async () => {
  const { interpreter, output } = await editor();
  interpreter.evaluate(
    '(define mode-a (hash-map :on-disable (lambda () (println "leave-a"))))'
  );
  interpreter.evaluate(
    '(define mode-b (hash-map :on-enable (lambda () (println "enter-b"))))'
  );
  interpreter.evaluate('(switch-major-mode mode-a)');
  interpreter.evaluate('(switch-major-mode mode-b)');
  const text = output.join('');
  assert.ok(text.includes('leave-a'));
  assert.ok(text.includes('enter-b'));
});

test('a minor mode keymap joins the dispatch chain', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(0);
  interpreter.evaluate(
    '(enable-minor-mode (hash-map :keymap (hash-map "C-d" (quote forward-char))))'
  );
  press(interpreter, 'C-d');
  assert.equal(buffer.text, 'hello'); // the minor mode shadowed C-d
  assert.equal(buffer.point, 1);
});

test('enable-minor-mode is idempotent and runs on-enable once', async () => {
  const { interpreter, output } = await editor();
  interpreter.evaluate(
    '(define mm (hash-map :on-enable (lambda () (println "on"))))'
  );
  interpreter.evaluate('(enable-minor-mode mm)');
  interpreter.evaluate('(enable-minor-mode mm)');
  assert.equal(output.join('').split('on').length - 1, 1);
  assert.equal(interpreter.evaluate('(length (minor-modes))'), 1);
});

test('disable-minor-mode removes the mode and runs on-disable', async () => {
  const { interpreter, output } = await editor();
  interpreter.evaluate(
    '(define mm (hash-map :on-disable (lambda () (println "off"))))'
  );
  interpreter.evaluate('(enable-minor-mode mm)');
  interpreter.evaluate('(disable-minor-mode mm)');
  assert.ok(output.join('').includes('off'));
  assert.equal(interpreter.evaluate('(length (minor-modes))'), 0);
});

test('minor modes stack by descending priority', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate('(enable-minor-mode (hash-map :name "low" :priority 1))');
  interpreter.evaluate('(enable-minor-mode (hash-map :name "high" :priority 9))');
  assert.equal(
    interpreter.evaluate('(get (car (minor-modes)) :name "?")'),
    'high'
  );
});

test('a mode resolves its keymap by name, so set! is seen live', async () => {
  const { buffer, interpreter } = await editor('hello');
  buffer.moveTo(0);
  interpreter.evaluate('(define live-map (hash-map))');
  interpreter.evaluate('(set-major-mode! (hash-map :keymap (quote live-map)))');
  // Bind a key in the keymap *after* the mode is already set.
  interpreter.evaluate('(set! live-map (hash-map "C-d" (quote forward-char)))');
  press(interpreter, 'C-d');
  assert.equal(buffer.text, 'hello'); // C-d was the live-bound forward-char
  assert.equal(buffer.point, 1);
});

// --- markdown mode ------------------------------------------------------

test('markdown-bold wraps the selection in strong markers', async () => {
  const { buffer, interpreter } = await editor('hello world');
  buffer.moveTo(0);
  buffer.setMark(5); // select "hello"
  interpreter.evaluate('(markdown-bold)');
  assert.equal(buffer.text, '*hello* world');
});

test('markdown-italic with no selection inserts a slash pair', async () => {
  const { buffer, interpreter } = await editor('');
  interpreter.evaluate('(markdown-italic)');
  assert.equal(buffer.text, '//');
  assert.equal(buffer.point, 1); // the cursor sits between the slashes
});

test('markdown-heading-2 prepends the heading marker', async () => {
  const { buffer, interpreter } = await editor('a title');
  buffer.moveTo(3);
  interpreter.evaluate('(markdown-heading-2)');
  assert.equal(buffer.text, '## a title');
  assert.equal(buffer.point, 6); // the cursor kept its place in the line
});

test('C-c 6 makes the line a level-6 heading', async () => {
  const { buffer, interpreter } = await editor('deep');
  interpreter.evaluate('(set-major-mode! markdown-mode)');
  buffer.moveTo(0);
  press(interpreter, 'C-c');
  press(interpreter, '6');
  assert.equal(buffer.text, '###### deep');
});

test('C-c b runs markdown-bold in a markdown buffer', async () => {
  const { buffer, interpreter } = await editor('word');
  interpreter.evaluate('(set-major-mode! markdown-mode)');
  buffer.moveTo(0);
  buffer.setMark(4);
  press(interpreter, 'C-c');
  press(interpreter, 'b');
  assert.equal(buffer.text, '*word*');
});

test('markdown-preview toggles the preview pane through the host', async () => {
  const { interpreter, previewCalls } = await editor('# notes');
  interpreter.evaluate('(markdown-preview)');
  assert.deepEqual(previewCalls, ['toggle']);
});

test('C-c v runs markdown-preview in a markdown buffer', async () => {
  const { interpreter, previewCalls } = await editor('# notes');
  interpreter.evaluate('(set-major-mode! markdown-mode)');
  press(interpreter, 'C-c');
  press(interpreter, 'v');
  assert.deepEqual(previewCalls, ['toggle']);
});

test('math mode: backtick then a key inserts a LaTeX symbol', async () => {
  const { buffer, interpreter } = await editor('');
  interpreter.evaluate('(toggle-math-mode)'); // enable math mode
  press(interpreter, '`');
  press(interpreter, 'a');
  assert.equal(buffer.text, '\\alpha');
});

test('math mode: backtick then an unmapped key inserts the key', async () => {
  const { buffer, interpreter } = await editor('');
  interpreter.evaluate('(toggle-math-mode)');
  press(interpreter, '`');
  press(interpreter, '`'); // not a math key — a literal backtick
  assert.equal(buffer.text, '`');
});

test('toggle-math-mode toggles the minor mode on and off', async () => {
  const { interpreter } = await editor('');
  interpreter.evaluate('(toggle-math-mode)');
  assert.equal(interpreter.evaluate('(length (minor-modes))'), 1);
  interpreter.evaluate('(toggle-math-mode)');
  assert.equal(interpreter.evaluate('(length (minor-modes))'), 0);
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

// --- sticky notes -------------------------------------------------------

test('M-n n adds a sticky note and opens it for editing', async () => {
  const { interpreter, noteCalls } = await editor();
  press(interpreter, 'M-n');
  press(interpreter, 'n');
  assert.deepEqual(noteCalls, ['create', 'edit']);
});

test('M-n d deletes the sticky note nearest the cursor', async () => {
  const { interpreter, noteCalls } = await editor();
  press(interpreter, 'M-n');
  press(interpreter, 'd');
  assert.deepEqual(noteCalls, ['at-point', 'delete']);
});

test('M-n e edits the sticky note nearest the cursor', async () => {
  const { interpreter, noteCalls } = await editor();
  press(interpreter, 'M-n');
  press(interpreter, 'e');
  assert.deepEqual(noteCalls, ['at-point', 'edit']);
});

test('M-n f and M-n b move between sticky notes', async () => {
  const { interpreter, noteCalls } = await editor();
  press(interpreter, 'M-n');
  press(interpreter, 'f');
  press(interpreter, 'M-n');
  press(interpreter, 'b');
  assert.deepEqual(noteCalls, ['next', 'prev']);
});

test('M-n t toggles sticky-note visibility', async () => {
  const { interpreter, noteCalls } = await editor();
  press(interpreter, 'M-n');
  press(interpreter, 't');
  assert.deepEqual(noteCalls, ['toggle']);
});

test('the Markdown interpreter is a registered custom setting', async () => {
  const { interpreter } = await editor();
  assert.equal(interpreter.evaluate('*markdown-interpreter*'), 'marked');
  assert.equal(
    interpreter.evaluate('(custom-registered? (quote *markdown-interpreter*))'),
    true
  );
});

// --- toggle-repl --------------------------------------------------------

test('C-x p toggles the REPL panel', async () => {
  const { interpreter, replCalls } = await editor();
  press(interpreter, 'C-x');
  press(interpreter, 'p');
  assert.deepEqual(replCalls, ['toggle']);
});

// --- mode menus ---------------------------------------------------------

test('mode-menu-entries lists a mode keymap command with its keys', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate('(set-major-mode! markdown-mode)');
  const entries = listToArray(interpreter.call('mode-menu-entries')).map(
    (entry) => listToArray(entry)
  );
  assert.ok(entries.length > 5);
  const bold = entries.find(([, command]) => command === 'markdown-bold');
  assert.ok(bold, 'markdown-bold should appear in the mode menu');
  assert.equal(bold[0], 'C-c b'); // the key sequence reaching it
  assert.ok(bold[2].length > 0); // a non-empty docstring
});

test('mode-menu-entries is empty for a mode that binds no commands', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate('(set-major-mode! lisp-mode)'); // lisp-mode-map is empty
  assert.deepEqual(listToArray(interpreter.call('mode-menu-entries')), []);
});

// --- customisation registry ---------------------------------------------

const DECLARE =
  '(defcustom *test-opt* 7 :integer :group (quote jmacs) :doc "a test")';

test('defcustom defines a variable and registers the setting', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate(DECLARE);
  assert.equal(interpreter.evaluate('*test-opt*'), 7);
  assert.equal(interpreter.evaluate('(custom-value (quote *test-opt*))'), 7);
  assert.equal(
    interpreter.evaluate('(custom-registered? (quote *test-opt*))'),
    true
  );
});

test('custom-apply! changes the variable and the registry', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate(DECLARE);
  interpreter.evaluate('(custom-apply! (quote *test-opt*) 12)');
  assert.equal(interpreter.evaluate('*test-opt*'), 12);
  assert.equal(interpreter.evaluate('(custom-value (quote *test-opt*))'), 12);
});

test('custom-reset! restores a setting to its default', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate(DECLARE);
  interpreter.evaluate('(custom-apply! (quote *test-opt*) 99)');
  interpreter.evaluate('(custom-reset! (quote *test-opt*))');
  assert.equal(interpreter.evaluate('*test-opt*'), 7);
});

test('custom-state reports standard, then set after a change', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate(DECLARE);
  assert.equal(
    interpreter.evaluate('(symbol->string (custom-state (quote *test-opt*)))'),
    'standard'
  );
  interpreter.evaluate('(custom-apply! (quote *test-opt*) 8)');
  assert.equal(
    interpreter.evaluate('(symbol->string (custom-state (quote *test-opt*)))'),
    'set'
  );
});

test('re-declaring a customised setting keeps its value', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate(DECLARE);
  interpreter.evaluate('(custom-apply! (quote *test-opt*) 20)');
  interpreter.evaluate(DECLARE); // a hot reload re-runs the same defcustom
  assert.equal(interpreter.evaluate('*test-opt*'), 20);
  assert.equal(interpreter.evaluate('(custom-value (quote *test-opt*))'), 20);
});

test('defgroup registers a group and customs-in-group finds members', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate('(defgroup (quote test-group) (quote jmacs) "tests")');
  interpreter.evaluate('(defcustom *test-a* 1 :integer :group (quote test-group) :doc "")');
  interpreter.evaluate('(defcustom *test-b* 2 :integer :group (quote test-group) :doc "")');
  assert.equal(
    interpreter.evaluate('(length (customs-in-group (quote test-group)))'),
    2
  );
  assert.notEqual(
    interpreter.evaluate(
      '(member "test-group" (map symbol->string (custom-group-names)))'
    ),
    false
  );
});

test('custom-set-saved! records a setting as saved', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate(DECLARE);
  interpreter.evaluate('(custom-set-saved! (quote *test-opt*) 30)');
  assert.equal(interpreter.evaluate('*test-opt*'), 30);
  assert.equal(
    interpreter.evaluate('(symbol->string (custom-state (quote *test-opt*)))'),
    'saved'
  );
});

test('customs-to-save lists only settings with a saved value', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate(DECLARE);
  assert.equal(interpreter.evaluate('(length (customs-to-save))'), 0);
  interpreter.evaluate('(custom-apply! (quote *test-opt*) 5)');
  interpreter.evaluate('(custom-save! (quote *test-opt*))');
  assert.equal(interpreter.evaluate('(length (customs-to-save))'), 1);
});

test('custom-apply-and-save! sets a setting and marks it saved', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate(DECLARE);
  interpreter.evaluate('(custom-apply-and-save! (quote *test-opt*) 42)');
  assert.equal(interpreter.evaluate('*test-opt*'), 42);
  assert.equal(
    interpreter.evaluate('(symbol->string (custom-state (quote *test-opt*)))'),
    'saved'
  );
});

test('custom-field returns a setting as flat data for the view', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate(DECLARE);
  const field = listToArray(
    interpreter.evaluate('(custom-field (quote *test-opt*))')
  );
  assert.equal(field[0], '*test-opt*'); // name
  assert.equal(field[1], ':integer'); // type
  assert.equal(field[2], 7); // value
  assert.equal(field[5], 'standard'); // state
});

test('custom-group-model lists a group title and its settings', async () => {
  const { interpreter } = await editor();
  // The sticky-notes group and *markdown-interpreter* are declared by
  // the standard library itself.
  const model = listToArray(
    interpreter.evaluate('(custom-group-model (quote sticky-notes))')
  );
  assert.equal(model[0], 'sticky-notes'); // title
  assert.ok(listToArray(model[4]).length >= 1); // settings
});

// --- command system -----------------------------------------------------

test('defcommand defines the procedure and registers the command', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate('(defcommand greet () "Say hi." (quote hi))');
  assert.equal(
    interpreter.evaluate('(command-registered? (quote greet))'),
    true
  );
  assert.equal(
    interpreter.evaluate('(symbol->string (run-command (quote greet)))'),
    'hi'
  );
});

test('defcommand works without a docstring', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate('(defcommand plain () 42)');
  assert.equal(interpreter.evaluate('(run-command (quote plain))'), 42);
  assert.equal(
    interpreter.evaluate('(command-registered? (quote plain))'),
    true
  );
});

test('command-names lists a registered command bound to no key', async () => {
  const { interpreter } = await editor();
  // `customize` is declared with defcommand but bound to no key — the
  // case the keymap-only palette used to miss.
  const names = listToArray(interpreter.call('command-names'));
  assert.ok(names.includes('customize'));
});

test('a keymap-bound command is also a registered command', async () => {
  const { interpreter } = await editor();
  assert.equal(
    interpreter.evaluate('(command-registered? (quote forward-char))'),
    true
  );
});

test('an interactive command gathers a synchronous source (point)', async () => {
  const { interpreter, buffer } = await editor('hello world');
  interpreter.evaluate('(define *got* nil)');
  interpreter.evaluate(
    '(defcommand at-point (p) (interactive point) (set! *got* p))'
  );
  buffer.moveTo(6);
  interpreter.evaluate('(run-command (quote at-point))');
  assert.equal(interpreter.evaluate('*got*'), 6);
});

test('an interactive command gathers a number from the minibuffer', async () => {
  const { interpreter, minibufferPrompts } = await editor();
  interpreter.evaluate('(define *n* nil)');
  interpreter.evaluate(
    '(defcommand take-n (n) (interactive (number "N: ")) (set! *n* n))'
  );
  interpreter.evaluate('(run-command (quote take-n))');
  // The gather suspended, awaiting the minibuffer.
  assert.deepEqual(minibufferPrompts, ['N: ']);
  assert.equal(interpreter.evaluate('(nil? *n*)'), true);
  interpreter.evaluate('(minibuffer-delivered "42")');
  assert.equal(interpreter.evaluate('*n*'), 42);
});

test('an interactive command gathers two minibuffer arguments in order', async () => {
  const { interpreter, minibufferPrompts } = await editor();
  interpreter.evaluate('(define *pair* nil)');
  interpreter.evaluate(
    '(defcommand take-two (a b)' +
      ' (interactive (string "A: ") (string "B: "))' +
      ' (set! *pair* (list a b)))'
  );
  interpreter.evaluate('(run-command (quote take-two))');
  assert.deepEqual(minibufferPrompts, ['A: ']);
  interpreter.evaluate('(minibuffer-delivered "one")');
  assert.deepEqual(minibufferPrompts, ['A: ', 'B: ']);
  interpreter.evaluate('(minibuffer-delivered "two")');
  assert.deepEqual(listToArray(interpreter.evaluate('*pair*')), [
    'one',
    'two',
  ]);
});

test('cancelling a minibuffer prompt aborts the command', async () => {
  const { interpreter } = await editor();
  interpreter.evaluate('(define *ran* #f)');
  interpreter.evaluate(
    '(defcommand maybe (x) (interactive (string "X: ")) (set! *ran* #t))'
  );
  interpreter.evaluate('(run-command (quote maybe))');
  interpreter.evaluate('(minibuffer-delivered nil)'); // cancelled
  assert.equal(interpreter.evaluate('*ran*'), false);
});

// --- line operations ----------------------------------------------------

test('M-Down moves the current line down one', async () => {
  const { buffer, interpreter } = await editor('one\ntwo\nthree');
  buffer.moveTo(1); // on "one"
  press(interpreter, 'M-down');
  assert.equal(buffer.text, 'two\none\nthree');
});

test('M-Down carries the cursor with the moved line', async () => {
  const { buffer, interpreter } = await editor('one\ntwo\nthree');
  buffer.moveTo(2); // column 2 of "one"
  press(interpreter, 'M-down');
  assert.equal(buffer.text, 'two\none\nthree');
  assert.equal(buffer.point, 6, 'cursor stays at column 2 of the moved line');
});

test('M-Down on the last line does nothing', async () => {
  const { buffer, interpreter } = await editor('one\ntwo');
  buffer.moveTo(5); // on "two"
  press(interpreter, 'M-down');
  assert.equal(buffer.text, 'one\ntwo');
  assert.equal(buffer.point, 5);
});

test('M-Up moves the current line up one', async () => {
  const { buffer, interpreter } = await editor('one\ntwo\nthree');
  buffer.moveTo(5); // on "two"
  press(interpreter, 'M-up');
  assert.equal(buffer.text, 'two\none\nthree');
});

test('M-Up carries the cursor with the moved line', async () => {
  const { buffer, interpreter } = await editor('one\ntwo\nthree');
  buffer.moveTo(6); // column 2 of "two"
  press(interpreter, 'M-up');
  assert.equal(buffer.text, 'two\none\nthree');
  assert.equal(buffer.point, 2, 'cursor stays at column 2 of the moved line');
});

test('M-Up on the first line does nothing', async () => {
  const { buffer, interpreter } = await editor('one\ntwo');
  buffer.moveTo(1); // on "one"
  press(interpreter, 'M-up');
  assert.equal(buffer.text, 'one\ntwo');
  assert.equal(buffer.point, 1);
});

test('move-line-down then move-line-up is a round trip', async () => {
  const { buffer, interpreter } = await editor('a\nb\nc');
  buffer.moveTo(0); // on "a"
  press(interpreter, 'M-down');
  assert.equal(buffer.text, 'b\na\nc');
  press(interpreter, 'M-up');
  assert.equal(buffer.text, 'a\nb\nc');
});

test('C-x C-d duplicates the current line below it', async () => {
  const { buffer, interpreter } = await editor('one\ntwo');
  buffer.moveTo(1); // on "one"
  press(interpreter, 'C-x');
  press(interpreter, 'C-d');
  assert.equal(buffer.text, 'one\none\ntwo');
});

test('duplicate-line moves the cursor onto the copy, keeping its column', async () => {
  const { buffer, interpreter } = await editor('hello\nworld');
  buffer.moveTo(2); // column 2 of "hello"
  press(interpreter, 'C-x');
  press(interpreter, 'C-d');
  assert.equal(buffer.text, 'hello\nhello\nworld');
  assert.equal(buffer.point, 8, 'cursor at column 2 of the duplicated line');
});

test('duplicate-line works on the last line', async () => {
  const { buffer, interpreter } = await editor('one\ntwo');
  buffer.moveTo(5); // on "two"
  press(interpreter, 'C-x');
  press(interpreter, 'C-d');
  assert.equal(buffer.text, 'one\ntwo\ntwo');
});

test('C-x C-j joins the next line onto the current one', async () => {
  const { buffer, interpreter } = await editor('hello\nworld');
  buffer.moveTo(0); // on "hello"
  press(interpreter, 'C-x');
  press(interpreter, 'C-j');
  assert.equal(buffer.text, 'hello world');
});

test('join-line collapses the next line indentation to one space', async () => {
  const { buffer, interpreter } = await editor('hello\n    world');
  buffer.moveTo(0);
  press(interpreter, 'C-x');
  press(interpreter, 'C-j');
  assert.equal(buffer.text, 'hello world');
});

test('join-line lands the cursor at the join', async () => {
  const { buffer, interpreter } = await editor('foo\nbar');
  buffer.moveTo(1); // anywhere on "foo"
  press(interpreter, 'C-x');
  press(interpreter, 'C-j');
  assert.equal(buffer.text, 'foo bar');
  assert.equal(buffer.point, 3, 'cursor sits at the join, before the space');
});

test('join-line on the last line does nothing', async () => {
  const { buffer, interpreter } = await editor('only');
  buffer.moveTo(2);
  press(interpreter, 'C-x');
  press(interpreter, 'C-j');
  assert.equal(buffer.text, 'only');
});

test('the line-op commands are bound to their keys', async () => {
  const { interpreter } = await editor();
  assert.ok(
    interpreter.evaluate('(eq? (get the-keymap "M-up") (quote move-line-up))')
  );
  assert.ok(
    interpreter.evaluate(
      '(eq? (get the-keymap "M-down") (quote move-line-down))'
    )
  );
  assert.ok(
    interpreter.evaluate(
      '(eq? (get c-x-keymap "C-d") (quote duplicate-line))'
    )
  );
  assert.ok(
    interpreter.evaluate('(eq? (get c-x-keymap "C-j") (quote join-line))')
  );
});

// --- auto-pairing -------------------------------------------------------

test('*auto-pair* is a registered boolean setting, on by default', async () => {
  const { interpreter } = await editor();
  assert.equal(
    interpreter.evaluate('(custom-registered? (quote *auto-pair*))'),
    true
  );
  assert.equal(interpreter.evaluate('*auto-pair*'), true);
  const field = listToArray(
    interpreter.evaluate('(custom-field (quote *auto-pair*))')
  );
  assert.equal(field[1], ':boolean'); // type
});

test('typing ( inserts a matching ) with the cursor between', async () => {
  const { buffer, interpreter } = await editor('');
  press(interpreter, '(');
  assert.equal(buffer.text, '()');
  assert.equal(buffer.point, 1, 'cursor sits between the brackets');
});

test('typing [ and { auto-pairs their partners', async () => {
  const { buffer, interpreter } = await editor('');
  press(interpreter, '[');
  assert.equal(buffer.text, '[]');
  assert.equal(buffer.point, 1);
  const second = await editor('');
  press(second.interpreter, '{');
  assert.equal(second.buffer.text, '{}');
  assert.equal(second.buffer.point, 1);
});

test('typing " inserts a matching quote pair', async () => {
  const { buffer, interpreter } = await editor('');
  press(interpreter, '"');
  assert.equal(buffer.text, '""');
  assert.equal(buffer.point, 1);
});

test('typing ` inserts a matching backtick pair', async () => {
  const { buffer, interpreter } = await editor('');
  press(interpreter, '`');
  assert.equal(buffer.text, '``');
  assert.equal(buffer.point, 1);
});

test('typing ) over an existing ) steps past it instead of duplicating', async () => {
  const { buffer, interpreter } = await editor('');
  press(interpreter, '('); // inserts "()", cursor between
  press(interpreter, ')'); // the close key over the inserted ")"
  assert.equal(buffer.text, '()', 'no duplicate close inserted');
  assert.equal(buffer.point, 2, 'cursor stepped past the close');
});

test('typing ] and } step past their matching closer', async () => {
  const { buffer, interpreter } = await editor('');
  press(interpreter, '[');
  press(interpreter, ']');
  assert.equal(buffer.text, '[]');
  assert.equal(buffer.point, 2);
});

test('typing ) with no close ahead self-inserts the close', async () => {
  const { buffer, interpreter } = await editor('');
  press(interpreter, ')');
  assert.equal(buffer.text, ')');
  assert.equal(buffer.point, 1);
});

test('typing " over an existing closing " steps past it', async () => {
  const { buffer, interpreter } = await editor('');
  press(interpreter, '"'); // inserts the quote pair, cursor between
  press(interpreter, '"'); // the closing quote
  assert.equal(buffer.text, '""', 'no third quote inserted');
  assert.equal(buffer.point, 2, 'cursor stepped past the closing quote');
});

test('backspace between an empty pair deletes both characters', async () => {
  const { buffer, interpreter } = await editor('');
  press(interpreter, '(');
  assert.equal(buffer.text, '()');
  press(interpreter, 'backspace');
  assert.equal(buffer.text, '', 'both the opener and closer were removed');
  assert.equal(buffer.point, 0);
});

test('backspace between an empty quote pair deletes both', async () => {
  const { buffer, interpreter } = await editor('');
  press(interpreter, '"');
  press(interpreter, 'backspace');
  assert.equal(buffer.text, '');
});

test('backspace not between a pair deletes one character as usual', async () => {
  const { buffer, interpreter } = await editor('abc');
  buffer.moveTo(3);
  press(interpreter, 'backspace');
  assert.equal(buffer.text, 'ab', 'ordinary backspace still deletes one');
});

test('backspace with a non-empty pair deletes only the opener', async () => {
  const { buffer, interpreter } = await editor('');
  press(interpreter, '('); // "()", cursor between
  press(interpreter, 'x'); // "(x)", cursor after x
  buffer.moveTo(1); // back between "(" and "x"
  press(interpreter, 'backspace');
  assert.equal(buffer.text, 'x)', 'a non-empty pair is not collapsed');
});

test('with *auto-pair* off, ( self-inserts with no partner', async () => {
  const { buffer, interpreter } = await editor('');
  interpreter.evaluate('(custom-apply! (quote *auto-pair*) #f)');
  press(interpreter, '(');
  assert.equal(buffer.text, '(', 'no closing bracket added');
  assert.equal(buffer.point, 1);
});

test('with *auto-pair* off, ) self-inserts even ahead of a )', async () => {
  const { buffer, interpreter } = await editor(')');
  interpreter.evaluate('(custom-apply! (quote *auto-pair*) #f)');
  buffer.moveTo(0);
  press(interpreter, ')');
  assert.equal(buffer.text, '))', 'the close key does not step past');
});

test('with *auto-pair* off, backspace does not collapse a pair', async () => {
  const { buffer, interpreter } = await editor('()');
  interpreter.evaluate('(custom-apply! (quote *auto-pair*) #f)');
  buffer.moveTo(1);
  press(interpreter, 'backspace');
  assert.equal(buffer.text, ')', 'only the opener is removed');
});

test('the bracket and quote keys are bound in the global keymap', async () => {
  const { interpreter } = await editor();
  assert.ok(
    interpreter.evaluate(
      '(eq? (get the-keymap "(") (quote auto-pair-open-paren))'
    )
  );
  assert.ok(
    interpreter.evaluate(
      '(eq? (get the-keymap ")") (quote auto-pair-close-paren))'
    )
  );
});

test('auto-pairing surrounds text typed inside a fresh pair', async () => {
  const { buffer, interpreter } = await editor('');
  press(interpreter, '(');
  press(interpreter, 'a');
  press(interpreter, 'b');
  assert.equal(buffer.text, '(ab)');
  assert.equal(buffer.point, 3, 'cursor stays inside, before the close');
});

// --- occur --------------------------------------------------------------

test('occur-matching-lines returns 1-based line numbers and texts', async () => {
  const { interpreter } = await editor();
  // Each pair is (lineno . text); we read them out one by one.
  const pairs = listToArray(
    interpreter.evaluate(
      '(occur-matching-lines "foo" "foo\\nbar\\nfoo bar\\nbaz")'
    )
  );
  assert.equal(pairs.length, 2);
  assert.equal(interpreter.call('car', pairs[0]), 1);
  assert.equal(interpreter.call('cdr', pairs[0]), 'foo');
  assert.equal(interpreter.call('car', pairs[1]), 3);
  assert.equal(interpreter.call('cdr', pairs[1]), 'foo bar');
});

test('occur-matching-lines finds nothing when the pattern is absent', async () => {
  const { interpreter } = await editor();
  assert.equal(
    interpreter.evaluate('(nil? (occur-matching-lines "xyz" "abc\\ndef"))'),
    true
  );
});

test('occur-result-text formats matches with padded line numbers', async () => {
  const { interpreter } = await editor();
  const text = interpreter.evaluate(
    '(occur-result-text "f" "foo\\nbar\\nfizz\\nbaz")'
  );
  assert.ok(text.includes('2 matches for "f":'));
  assert.ok(text.includes('1: foo'));
  assert.ok(text.includes('3: fizz'));
});

test('occur-result-text reports an empty result in words', async () => {
  const { interpreter } = await editor();
  const text = interpreter.evaluate(
    '(occur-result-text "nope" "alpha\\nbeta")'
  );
  assert.ok(text.includes('0 matches for "nope":'));
  assert.ok(text.includes('(no matches)'));
});

test('occur-result-text uses the singular "match" for a single hit', async () => {
  const { interpreter } = await editor();
  const text = interpreter.evaluate(
    '(occur-result-text "alp" "alpha\\nbeta")'
  );
  assert.ok(
    text.includes('1 match for "alp":'),
    'one hit is "1 match", not "1 matches"'
  );
});

test('occur-buffer-name embeds the pattern', async () => {
  const { interpreter } = await editor();
  assert.equal(
    interpreter.evaluate('(occur-buffer-name "needle")'),
    '*Occur: needle*'
  );
});

test('occur is a registered command with the M-s o binding', async () => {
  const { interpreter } = await editor();
  assert.equal(
    interpreter.evaluate('(command-registered? (quote occur))'),
    true
  );
  assert.ok(
    interpreter.evaluate('(map? (get the-keymap "M-s"))'),
    'M-s is a prefix map'
  );
  assert.ok(
    interpreter.evaluate('(eq? (get m-s-keymap "o") (quote occur))')
  );
});

test('M-s o begins a sequence then prompts the minibuffer for a pattern', async () => {
  const { interpreter, minibufferPrompts } = await editor('foo\nbar\nfoo bar');
  press(interpreter, 'M-s');
  // Mid-sequence: the dispatch is parked at the M-s prefix.
  assert.equal(interpreter.evaluate('(nil? active-keymap)'), false);
  press(interpreter, 'o');
  assert.deepEqual(minibufferPrompts, ['Occur: ']);
});

test('occur creates a *Occur: PATTERN* buffer and inserts the matches', async () => {
  // The test mock for new-buffer! does not switch buffers, so insert!
  // after it writes into the original buffer — that gives the test a
  // direct view of the inserted text. Real app code switches first.
  const { buffer, interpreter, bufferCalls } = await editor(
    'foo\nbar\nfoo bar\nbaz'
  );
  press(interpreter, 'M-s');
  press(interpreter, 'o');
  interpreter.evaluate('(minibuffer-delivered "foo")');
  // The command asked for a new buffer.
  assert.deepEqual(bufferCalls, ['new']);
  // The result text shows the header and both matches.
  assert.ok(buffer.text.includes('2 matches for "foo":'));
  assert.ok(buffer.text.includes('1: foo'));
  assert.ok(buffer.text.includes('3: foo bar'));
});

test('occur with no matches still opens a results buffer that says so', async () => {
  const { buffer, interpreter, bufferCalls } = await editor('alpha\nbeta');
  press(interpreter, 'M-s');
  press(interpreter, 'o');
  interpreter.evaluate('(minibuffer-delivered "missing")');
  assert.deepEqual(bufferCalls, ['new']);
  assert.ok(buffer.text.includes('0 matches for "missing":'));
  assert.ok(buffer.text.includes('(no matches)'));
});

test('cancelling the occur prompt does not open a buffer', async () => {
  const { buffer, interpreter, bufferCalls } = await editor('one\ntwo');
  const original = buffer.text;
  press(interpreter, 'M-s');
  press(interpreter, 'o');
  interpreter.evaluate('(minibuffer-delivered nil)'); // cancelled
  assert.deepEqual(bufferCalls, [], 'no new buffer is created on cancel');
  assert.equal(buffer.text, original, 'the source buffer is untouched');
});

// --- expand-region ------------------------------------------------------

test('expand-region is a registered command bound to C-equal (the C-= key)', async () => {
  const { interpreter } = await editor();
  assert.equal(
    interpreter.evaluate('(command-registered? (quote expand-region))'),
    true
  );
  assert.ok(
    interpreter.evaluate(
      '(eq? (get the-keymap "C-equal") (quote expand-region))'
    )
  );
});

test('expand-region-word-bounds finds the word at an interior offset', async () => {
  const { interpreter } = await editor();
  // "alpha beta": cursor at offset 7 sits inside "beta" (b=6 e=7 t=8 a=9).
  const pair = interpreter.evaluate(
    '(expand-region-word-bounds "alpha beta" 7)'
  );
  assert.equal(interpreter.call('car', pair), 6);
  assert.equal(interpreter.call('cdr', pair), 10);
});

test('expand-region-word-bounds uses the word just before an interword offset', async () => {
  const { interpreter } = await editor();
  // Cursor at offset 5 (the space) — there is no word at it, but the
  // character just before is a word char, so the word ending there wins.
  const pair = interpreter.evaluate(
    '(expand-region-word-bounds "alpha beta" 5)'
  );
  assert.equal(interpreter.call('car', pair), 0);
  assert.equal(interpreter.call('cdr', pair), 5);
});

test('expand-region-word-bounds returns nil between two non-word chars', async () => {
  const { interpreter } = await editor();
  assert.equal(
    interpreter.evaluate('(nil? (expand-region-word-bounds "  alpha" 0))'),
    true
  );
});

test('expand-region-line-bounds spans from line start to line end', async () => {
  const { interpreter } = await editor();
  // "one\ntwo\nthree": offset 5 is inside "two" (line 2 — chars 4..7).
  const pair = interpreter.evaluate(
    '(expand-region-line-bounds "one\\ntwo\\nthree" 5)'
  );
  assert.equal(interpreter.call('car', pair), 4);
  assert.equal(interpreter.call('cdr', pair), 7);
});

test('expand-region-paragraph-bounds spans contiguous non-blank lines', async () => {
  const { interpreter } = await editor();
  // Two paragraphs separated by a blank line.
  // "a\nb\n\nc" — chars 0..3 are paragraph 1 ("a\nb"), char 5 is paragraph 2.
  const p1 = interpreter.evaluate(
    '(expand-region-paragraph-bounds "a\\nb\\n\\nc" 0)'
  );
  assert.equal(interpreter.call('car', p1), 0);
  assert.equal(interpreter.call('cdr', p1), 3);
  const p2 = interpreter.evaluate(
    '(expand-region-paragraph-bounds "a\\nb\\n\\nc" 5)'
  );
  assert.equal(interpreter.call('car', p2), 5);
  assert.equal(interpreter.call('cdr', p2), 6);
});

test('expand-region selects the current word on its first press', async () => {
  const { buffer, interpreter } = await editor('one two three');
  buffer.moveTo(5); // inside "two"
  press(interpreter, 'C-equal');
  assert.deepEqual(buffer.selection, { start: 4, end: 7 });
});

test('expand-region grows: word, line, paragraph, then buffer', async () => {
  const { buffer, interpreter } = await editor(
    'one two three\nfour five\n\nsix seven'
  );
  buffer.moveTo(5); // inside "two", paragraph "one two three\nfour five"
  press(interpreter, 'C-equal');
  assert.deepEqual(buffer.selection, { start: 4, end: 7 }, 'word "two"');
  press(interpreter, 'C-equal');
  assert.deepEqual(buffer.selection, { start: 0, end: 13 }, 'line 1');
  press(interpreter, 'C-equal');
  assert.deepEqual(buffer.selection, { start: 0, end: 23 }, 'paragraph 1');
  press(interpreter, 'C-equal');
  assert.deepEqual(buffer.selection, { start: 0, end: 34 }, 'whole buffer');
});

test('expand-region: a step that adds nothing is skipped', async () => {
  // On a single-line, single-paragraph buffer, line == paragraph == buffer.
  // The first press grabs the word, the second the line; further presses
  // don't introduce a strictly larger range.
  const { buffer, interpreter } = await editor('alpha beta gamma');
  buffer.moveTo(8); // inside "beta"
  press(interpreter, 'C-equal');
  assert.deepEqual(buffer.selection, { start: 6, end: 10 }, 'word "beta"');
  press(interpreter, 'C-equal');
  assert.deepEqual(buffer.selection, { start: 0, end: 16 }, 'whole line');
  // Further presses see no growth — the selection stays as the line.
  press(interpreter, 'C-equal');
  assert.deepEqual(buffer.selection, { start: 0, end: 16 });
  press(interpreter, 'C-equal');
  assert.deepEqual(buffer.selection, { start: 0, end: 16 });
});

test('an intervening command resets the expand-region chain', async () => {
  const { buffer, interpreter } = await editor(
    'one two three\nfour five\n\nsix seven'
  );
  buffer.moveTo(5);
  press(interpreter, 'C-equal'); // word "two"
  press(interpreter, 'C-equal'); // line 1
  assert.deepEqual(buffer.selection, { start: 0, end: 13 });
  // A non-expand-region command — the chain is broken.
  press(interpreter, 'right');
  press(interpreter, 'C-equal');
  // The new anchor is the current point (14, on "four"), so this grows
  // to the word "four" rather than continuing to the paragraph.
  assert.deepEqual(buffer.selection, { start: 14, end: 18 }, 'word "four"');
});

test('expand-region with the cursor between non-word chars falls through to the line', async () => {
  // The leading space at offset 0 has no adjacent word — step 1 (word)
  // yields nothing, so the first press takes the line directly.
  const { buffer, interpreter } = await editor('   spaced   text');
  buffer.moveTo(1); // between leading spaces
  press(interpreter, 'C-equal');
  assert.deepEqual(buffer.selection, { start: 0, end: 16 });
});

test('expand-region on an empty buffer leaves the selection null', async () => {
  const { buffer, interpreter } = await editor('');
  buffer.moveTo(0);
  press(interpreter, 'C-equal');
  assert.equal(buffer.selection, null);
});

test('expand-region keeps growing around the original anchor, not point', async () => {
  // After the first press, point sits at the word end; the chain must
  // still grow around the original cursor position (the anchor), not
  // jump to a new line because point moved.
  const { buffer, interpreter } = await editor('aaa bbb\nccc ddd');
  buffer.moveTo(1); // inside "aaa"
  press(interpreter, 'C-equal'); // selects "aaa"
  assert.deepEqual(buffer.selection, { start: 0, end: 3 });
  press(interpreter, 'C-equal'); // line containing the anchor
  assert.deepEqual(buffer.selection, { start: 0, end: 7 });
});

// --- themes -----------------------------------------------------------

test('three themes are registered with distinct palettes', async () => {
  const { interpreter } = await editor();
  const names = listToArray(interpreter.call('registered-themes'))
    .map((s) => s.name).sort();
  assert.deepEqual(names, ['dark', 'light', 'midnight']);
  // Each theme defines a --bg value; the three should all differ.
  const bgs = names.map(
    (n) => interpreter.evaluate(`(get (theme-vars (quote ${n})) "--bg" "")`)
  );
  assert.equal(new Set(bgs).size, 3);
});

test('the *theme* setting defaults to dark and is a :choice', async () => {
  const { interpreter } = await editor();
  assert.equal(interpreter.evaluate('*theme*').name, 'dark');
  const field = listToArray(
    interpreter.evaluate('(custom-field (quote *theme*))')
  );
  // field = (name type value default doc state options)
  assert.equal(String(field[1]), ':choice');
  const options = listToArray(field[6]).map((s) => s.name);
  assert.deepEqual(options.sort(), ['dark', 'light', 'midnight']);
});

test('current-theme-css-vars switches with *theme*', async () => {
  const { interpreter } = await editor();
  const bgFor = (name) => {
    interpreter.evaluate(`(custom-apply! (quote *theme*) (quote ${name}))`);
    const pairs = listToArray(interpreter.call('current-theme-css-vars'));
    for (const pair of pairs) {
      if (String(pair.head) === '--bg') return String(pair.tail);
    }
    return '';
  };
  const dark = bgFor('dark');
  const light = bgFor('light');
  const midnight = bgFor('midnight');
  assert.notEqual(dark, light);
  assert.notEqual(dark, midnight);
  assert.notEqual(light, midnight);
});

// --- mode-specific keymaps -------------------------------------------

test('html-mode has a C-c keymap with html-bold under "b"', async () => {
  const { interpreter } = await editor();
  const km = interpreter.evaluate(
    "(get (get (resolve-keymap 'html-mode-map) \"C-c\" {}) \"b\" nil)"
  );
  assert.equal(String(km && km.name), 'html-bold');
});

test('python-mode has a C-c keymap with python-insert-print under "p"', async () => {
  const { interpreter } = await editor();
  const km = interpreter.evaluate(
    "(get (get (resolve-keymap 'python-mode-map) \"C-c\" {}) \"p\" nil)"
  );
  assert.equal(String(km && km.name), 'python-insert-print');
});

test('latex-mode has a C-c keymap with latex-textbf under "b"', async () => {
  const { interpreter } = await editor();
  const km = interpreter.evaluate(
    "(get (get (resolve-keymap 'latex-mode-map) \"C-c\" {}) \"b\" nil)"
  );
  assert.equal(String(km && km.name), 'latex-textbf');
});

test('makefile-mode has a C-c keymap with makefile-target under "t"', async () => {
  const { interpreter } = await editor();
  const km = interpreter.evaluate(
    "(get (get (resolve-keymap 'makefile-mode-map) \"C-c\" {}) \"t\" nil)"
  );
  assert.equal(String(km && km.name), 'makefile-target');
});

test('html-bold wraps the selection in <strong>...</strong>', async () => {
  const { interpreter, buffer } = await editor('hello world');
  buffer.moveTo(0);
  interpreter.evaluate('(set-mark! 5)');
  interpreter.evaluate('(html-bold)');
  assert.equal(buffer.text, '<strong>hello</strong> world');
});

test('latex-emph wraps the selection in \\emph{...}', async () => {
  const { interpreter, buffer } = await editor('lorem ipsum');
  buffer.moveTo(0);
  interpreter.evaluate('(set-mark! 5)');
  interpreter.evaluate('(latex-emph)');
  assert.equal(buffer.text, '\\emph{lorem} ipsum');
});

test('python-insert-print inserts print() with the cursor between the parens', async () => {
  const { interpreter, buffer } = await editor('');
  interpreter.evaluate('(python-insert-print)');
  assert.equal(buffer.text, 'print()');
  assert.equal(buffer.point, 'print('.length);
});

// --- documentation (docs.lisp + help.lisp integration) ---------------

test('doc-known? returns false when no manifest is loaded', async () => {
  const { interpreter } = await editor();
  assert.equal(interpreter.evaluate('(doc-known? "forward-char")'), false);
});

test('open-doc on an unknown name prints to the REPL', async () => {
  const { interpreter, output } = await editor();
  interpreter.evaluate('(open-doc "no-such-function")');
  assert.ok(
    output.some((line) => line.includes('no doc page for no-such-function')),
    `expected REPL message; got ${JSON.stringify(output)}`
  );
});

test('describe-named-command falls back to REPL when no doc is built', async () => {
  const { interpreter, output, docCalls } = await editor();
  interpreter.evaluate('(describe-named-command "forward-char")');
  // The REPL fallback prints "<name>:" and the docstring (or the
  // marker when no docstring exists).
  assert.ok(
    output.some((line) => line.includes('forward-char:')),
    `expected REPL fallback; got ${JSON.stringify(output)}`
  );
  // open-doc! was NOT called.
  assert.deepEqual(docCalls, []);
});

test('open-doc renders a user-defined docstring through the live path', async () => {
  const { interpreter, docCalls } = await editor();
  // Define a procedure with a Markdown docstring, then ask for its doc.
  interpreter.evaluate(`
    (define (my-cmd)
      "A *user-defined* function with **Markdown** in its docstring.

       Multiple paragraphs are fine."
      42)
  `);
  interpreter.evaluate('(open-doc "my-cmd")');
  // doc-known? is false (no manifest); the docstring path fires.
  assert.deepEqual(docCalls, ['docstring:my-cmd']);
});

test('open-doc still falls back to REPL when the name has no docstring', async () => {
  const { interpreter, docCalls, output } = await editor();
  interpreter.evaluate('(define (no-doc-cmd) 1)');
  interpreter.evaluate('(open-doc "no-doc-cmd")');
  assert.deepEqual(docCalls, []);
  assert.ok(
    output.some((line) => line.includes('no doc page for no-doc-cmd')),
    `expected REPL fallback; got ${JSON.stringify(output)}`
  );
});

test('C-h a runs apropos-doc through the search primitive', async () => {
  const { interpreter, docCalls } = await editor();
  press(interpreter, 'C-h');
  press(interpreter, 'a');
  assert.deepEqual(docCalls, ['search']);
});

// --- symbol-at-point / describe-symbol-at-point --------------------

test('symbol-at-offset returns the Lisp symbol straddling a position', async () => {
  const { interpreter } = await editor();
  const probe = (text, pos) =>
    interpreter.evaluate(
      `(symbol-at-offset ${JSON.stringify(text)} ${pos})`
    );
  // Inside the symbol.
  assert.equal(probe('(forward-char)', 5), 'forward-char');
  // At the start.
  assert.equal(probe('forward-char', 0), 'forward-char');
  // Just past the end (the "char before" rule allows this — same
  // semantics as expand-region-word-bounds).
  assert.equal(probe('forward-char', 'forward-char'.length), 'forward-char');
  // Between two delimiters with nothing in between: nil.
  assert.equal(probe('()', 1), NIL);
  // Inside whitespace with no symbol either side: nil.
  assert.equal(probe('   foo', 1), NIL);
  // Symbols with question marks and bangs are still symbols.
  assert.equal(probe('(nil?)', 1), 'nil?');
  assert.equal(probe('(set! x 1)', 3), 'set!');
  // A keyword (leading colon) is one symbol.
  assert.equal(probe(':highlight', 3), ':highlight');
});

test('describe-symbol-at-point uses the symbol under the cursor', async () => {
  // The buffer's text is what symbol-at-point reads; define a
  // procedure with a Markdown docstring and put the cursor on its
  // name to drive the live-doc path.
  const { interpreter, buffer, docCalls } = await editor('(my-fn)');
  interpreter.evaluate('(define (my-fn) "Live docs for *my-fn*." nil)');
  buffer.moveTo(3); // inside "my-fn"
  interpreter.evaluate('(describe-symbol-at-point)');
  // With no manifest entry, the symbol's docstring is rendered live.
  assert.deepEqual(docCalls, ['docstring:my-fn']);
});

test('describe-symbol-at-point with no symbol at point prints to the REPL', async () => {
  const { interpreter, buffer, docCalls, output } = await editor('(   )');
  buffer.moveTo(2); // on the whitespace, nothing on either side
  interpreter.evaluate('(describe-symbol-at-point)');
  assert.deepEqual(docCalls, []);
  assert.ok(
    output.some((line) => line.includes('no symbol at point')),
    `expected the fallback message; got ${JSON.stringify(output)}`
  );
});

test('C-h . runs describe-symbol-at-point', async () => {
  const { interpreter, output } = await editor('(forward-char)');
  // No symbol under point at offset 0 — point is on the '('
  // which is a delimiter, so the symbol bound starts at 1.
  // The buffer's default cursor is at 0; that gives nil.
  press(interpreter, 'C-h');
  press(interpreter, '.');
  // Either path is acceptable — what matters is the keymap routed
  // here and produced *some* output rather than crashing.
  assert.ok(
    output.length > 0,
    `expected C-h . to produce output; got ${JSON.stringify(output)}`
  );
});

// --- inline eval ---------------------------------------------------

test('C-RET runs eval-expression-at-point through the host primitives', async () => {
  const { interpreter, evalCalls } = await editor();
  press(interpreter, 'C-enter');
  // The command first asks for bounds; the mock returns nil, so the
  // print-fallback fires (no eval-region) — but bounds-at was called.
  assert.ok(evalCalls.includes('bounds-at'),
    `expected bounds-at; got ${JSON.stringify(evalCalls)}`);
});

test('C-x C-e runs eval-expression-before-point through the host primitives', async () => {
  const { interpreter, evalCalls } = await editor();
  press(interpreter, 'C-x');
  press(interpreter, 'C-e');
  assert.ok(evalCalls.includes('bounds-before'),
    `expected bounds-before; got ${JSON.stringify(evalCalls)}`);
});

test('show-eval-log calls the host primitive', async () => {
  const { interpreter, evalCalls } = await editor();
  interpreter.evaluate('(show-eval-log)');
  assert.ok(evalCalls.includes('show-log'),
    `expected show-log; got ${JSON.stringify(evalCalls)}`);
});

test('C-x k runs kill-buffer through the host primitive', async () => {
  const { interpreter, bufferCalls } = await editor();
  press(interpreter, 'C-x');
  press(interpreter, 'k');
  assert.ok(bufferCalls.includes('kill'),
    `expected kill; got ${JSON.stringify(bufferCalls)}`);
});

// --- code folding ------------------------------------------------------

test('C-c TAB runs toggle-fold-at-point through the host primitive', async () => {
  const { interpreter, foldCalls } = await editor();
  press(interpreter, 'C-c');
  press(interpreter, 'tab');
  assert.ok(foldCalls.includes('toggle'),
    `expected toggle; got ${JSON.stringify(foldCalls)}`);
});

test('C-c C-, runs fold-all through the host primitive', async () => {
  const { interpreter, foldCalls } = await editor();
  press(interpreter, 'C-c');
  press(interpreter, 'C-comma');
  assert.ok(foldCalls.includes('all'),
    `expected all; got ${JSON.stringify(foldCalls)}`);
});

test('C-c C-. runs unfold-all through the host primitive', async () => {
  const { interpreter, foldCalls } = await editor();
  press(interpreter, 'C-c');
  press(interpreter, 'C-period');
  assert.ok(foldCalls.includes('unfold'),
    `expected unfold; got ${JSON.stringify(foldCalls)}`);
});
