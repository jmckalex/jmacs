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
      'recenter!': () => NIL,
      'page-lines': () => 3,
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
  // The sequence completed: dispatch is back at rest.
  assert.equal(interpreter.evaluate('(nil? active-keymap)'), true);
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

test('C-c b runs markdown-bold in a markdown buffer', async () => {
  const { buffer, interpreter } = await editor('word');
  interpreter.evaluate('(set-major-mode! markdown-mode)');
  buffer.moveTo(0);
  buffer.setMark(4);
  press(interpreter, 'C-c');
  press(interpreter, 'b');
  assert.equal(buffer.text, '*word*');
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
