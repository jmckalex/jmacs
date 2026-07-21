/**
 * @file emacs-parity.test.js — the standard Emacs editing commands,
 * exercised over REAL L2 buffers via `createBufferPrimitives` (no
 * stubbed motion/editing primitives, so word boundaries, code-point
 * stepping and cursor mechanics are the production ones).
 *
 * Covers the 2026-07 parity audit: transpose-chars/words/lines drag
 * semantics, Unicode-aware word motion, kill accumulation, yank over a
 * selection, the case-conversion family, whitespace and blank-line
 * commands, paragraph motion, mark-word, kill-whole-line, zap-to-char.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import { createInterpreter, NIL } from '@editor/lisp';
import { createBufferPrimitives } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

const LISP_FILES = [
  'commands.lisp',
  'editing.lisp',
  'kill.lisp',
  'yank-pop.lisp',
  'line-ops.lisp',
  'keymap.lisp',
];

/**
 * An interpreter over a real L2 buffer with the editing stdlib loaded.
 * The clipboard is stubbed to a local record so kill-ring tests can
 * assert the interprogram mirror without a display server.
 */
async function editor(initialText = '') {
  const buffer = createBuffer(initialText, { name: 'main' });
  const session = { current: buffer };
  const clipboard = { text: '' };
  const interpreter = createInterpreter({
    write: () => {},
    primitives: {
      ...createBufferPrimitives(session),
      'clipboard-set-text!': (args) => {
        clipboard.text = String(args[0]);
        return NIL;
      },
      'clipboard-text': () => clipboard.text,
      'show-status!': () => NIL,
      'clear-status!': () => NIL,
      'buffer-major-mode': () => NIL,
      'buffer-minor-modes': () => NIL,
    },
  });
  for (const name of LISP_FILES) {
    interpreter.evaluate(await readFile(join(lispDir, name), 'utf8'));
  }
  const run = (src) => interpreter.evaluate(src);
  return { buffer, interpreter, run, clipboard };
}

// --- transpose-chars ----------------------------------------------------

test('transpose-chars mid-line drags the previous char forward', async () => {
  const { buffer, run } = await editor('abcd');
  run('(goto! 2)');
  run("(run-command 'transpose-chars)");
  assert.equal(buffer.text, 'acbd');
  assert.equal(buffer.point, 3);
});

test('repeated transpose-chars keeps dragging the char rightward', async () => {
  const { buffer, run } = await editor('abcd');
  run('(goto! 1)');
  run("(run-command 'transpose-chars)");
  assert.equal(buffer.text, 'bacd');
  run("(run-command 'transpose-chars)");
  assert.equal(buffer.text, 'bcad');
  run("(run-command 'transpose-chars)");
  assert.equal(buffer.text, 'bcda');
  assert.equal(buffer.point, 4);
});

test('transpose-chars at end of line swaps the two before, point stays', async () => {
  const { buffer, run } = await editor('ab\ncd');
  run('(goto! 2)');
  run("(run-command 'transpose-chars)");
  assert.equal(buffer.text, 'ba\ncd');
  assert.equal(buffer.point, 2);
});

test('transpose-chars at buffer start / single char is a no-op', async () => {
  const { buffer, run } = await editor('ab');
  run('(goto! 0)');
  run("(run-command 'transpose-chars)");
  assert.equal(buffer.text, 'ab');
  const single = await editor('a');
  single.run('(goto! 1)');
  single.run("(run-command 'transpose-chars)");
  assert.equal(single.buffer.text, 'a');
});

test('transpose-chars keeps an emoji whole', async () => {
  const { buffer, run } = await editor('a\u{1F600}b');
  run('(goto! 3)'); // after the surrogate pair
  run("(run-command 'transpose-chars)");
  assert.equal(buffer.text, 'ab\u{1F600}');
  assert.equal(buffer.point, 4);
});

test('transpose-chars undoes as one step', async () => {
  const { buffer, run } = await editor('abcd');
  run('(goto! 2)');
  run("(run-command 'transpose-chars)");
  run('(undo!)');
  assert.equal(buffer.text, 'abcd');
});

// --- transpose-words ----------------------------------------------------

test('transpose-words swaps the two words around point', async () => {
  const { buffer, run } = await editor('foo bar');
  run('(goto! 3)');
  run("(run-command 'transpose-words)");
  assert.equal(buffer.text, 'bar foo');
  assert.equal(buffer.point, 7);
});

test('transpose-words keeps the separator and works mid-word', async () => {
  const { buffer, run } = await editor('alpha, beta!');
  run('(goto! 9)'); // inside "beta"
  run("(run-command 'transpose-words)");
  assert.equal(buffer.text, 'beta, alpha!');
  assert.equal(buffer.point, 11);
});

test('transpose-words with only one word is a no-op', async () => {
  const { buffer, run } = await editor('solo ');
  run('(goto! 2)');
  run("(run-command 'transpose-words)");
  assert.equal(buffer.text, 'solo ');
  assert.equal(buffer.point, 2);
});

// --- transpose-lines ----------------------------------------------------

test('transpose-lines exchanges with the line above, point after both', async () => {
  const { buffer, run } = await editor('aaa\nbbb\nccc');
  run('(goto! 5)');
  run("(run-command 'transpose-lines)");
  assert.equal(buffer.text, 'bbb\naaa\nccc');
  assert.equal(buffer.point, 8);
});

test('transpose-lines on the first line is a no-op', async () => {
  const { buffer, run } = await editor('aaa\nbbb');
  run('(goto! 1)');
  run("(run-command 'transpose-lines)");
  assert.equal(buffer.text, 'aaa\nbbb');
});

test('transpose-lines on the last line without trailing newline', async () => {
  const { buffer, run } = await editor('aaa\nbbb');
  run('(goto! 5)');
  run("(run-command 'transpose-lines)");
  assert.equal(buffer.text, 'bbb\naaa');
  assert.equal(buffer.point, 7);
});

// --- Unicode word motion ------------------------------------------------

test('forward-word treats accented letters as word constituents', async () => {
  const { run } = await editor('café au lait');
  run('(goto! 0)');
  run("(run-command 'forward-word)");
  assert.equal(run('(point)'), 4); // past "café", not stuck at "caf"
  run("(run-command 'forward-word)");
  assert.equal(run('(point)'), 7); // past "au"
});

test('backward-word and kill-word cross non-ASCII words whole', async () => {
  const { buffer, run } = await editor('naïve café');
  run('(goto! 10)');
  run("(run-command 'backward-word)");
  assert.equal(run('(point)'), 6);
  run('(goto! 0)');
  run("(run-command 'kill-word)");
  assert.equal(buffer.text, ' café');
});

// --- kill accumulation --------------------------------------------------

test('consecutive kill-lines grow one kill-ring entry', async () => {
  const { run } = await editor('line1\nline2\nline3');
  run('(goto! 0)');
  run("(run-command 'kill-line)"); // kills "line1"
  run("(run-command 'kill-line)"); // kills the newline — same entry
  run("(run-command 'kill-line)"); // kills "line2" — same entry
  assert.equal(run('(kill-ring-top)'), 'line1\nline2');
  assert.equal(run('(kill-ring-length)'), 1);
});

test('an intervening command breaks the kill run', async () => {
  const { run } = await editor('line1\nline2\nline3');
  run('(goto! 0)');
  run("(run-command 'kill-line)");
  run("(run-command 'forward-char)");
  run('(goto! 0)');
  run("(run-command 'kill-line)");
  assert.equal(run('(kill-ring-length)'), 2);
});

test('backward kills prepend to the accumulated entry', async () => {
  const { run, clipboard } = await editor('one two three');
  run('(goto! 13)');
  run("(run-command 'backward-kill-word)"); // "three"
  run("(run-command 'backward-kill-word)"); // "two " prepends
  assert.equal(run('(kill-ring-top)'), 'two three');
  assert.equal(run('(kill-ring-length)'), 1);
  assert.equal(clipboard.text, 'two three'); // the mirror follows the merge
});

test('kill-whole-line kills newline included and accumulates', async () => {
  const { buffer, run } = await editor('aaa\nbbb\nccc');
  run('(goto! 5)');
  run("(run-command 'kill-whole-line)");
  assert.equal(buffer.text, 'aaa\nccc');
  assert.equal(buffer.point, 4);
  run("(run-command 'kill-whole-line)");
  assert.equal(run('(kill-ring-top)'), 'bbb\nccc');
});

// --- yank over a selection ----------------------------------------------

test('yank over an active selection records the true insertion start', async () => {
  const { buffer, run } = await editor('hello world');
  run('(kill-ring-add! "NEW")');
  run('(set-mark! 0)');
  run('(goto! 5)'); // "hello" selected, point at its END
  run("(run-command 'yank)");
  assert.equal(buffer.text, 'NEW world');
  assert.equal(run('*yank-start*'), 0);
  // A following yank-pop must replace the *inserted* range, not [5, 8).
  run("(run-command 'yank-pop)"); // one-entry ring wraps to the same text
  assert.equal(buffer.text, 'NEW world');
});

// --- case conversion ----------------------------------------------------

test('upcase-word / downcase-word convert to the word end and move there', async () => {
  const { buffer, run } = await editor('hello world');
  run('(goto! 0)');
  run("(run-command 'upcase-word)");
  assert.equal(buffer.text, 'HELLO world');
  assert.equal(buffer.point, 5);
  run('(goto! 8)'); // mid "world" — converts the remainder only
  run("(run-command 'upcase-word)");
  assert.equal(buffer.text, 'HELLO woRLD');
  run('(goto! 6)');
  run("(run-command 'downcase-word)");
  assert.equal(buffer.text, 'HELLO world');
});

test('capitalize-word capitalizes from point', async () => {
  const { buffer, run } = await editor('hELLO world');
  run('(goto! 0)');
  run("(run-command 'capitalize-word)");
  assert.equal(buffer.text, 'Hello world');
  assert.equal(buffer.point, 5);
});

test('the word case commands act on an active region (dwim)', async () => {
  const { buffer, run } = await editor('two words here');
  run('(set-mark! 0)');
  run('(goto! 9)');
  run("(run-command 'upcase-word)");
  assert.equal(buffer.text, 'TWO WORDS here');
});

test('upcase-region / downcase-region via the interactive region spec', async () => {
  const { buffer, run } = await editor('hello world');
  run('(set-mark! 6)');
  run('(goto! 11)');
  run("(run-command 'upcase-region)");
  assert.equal(buffer.text, 'hello WORLD');
});

test('case conversion is Unicode-aware', async () => {
  const { buffer, run } = await editor('café');
  run('(goto! 0)');
  run("(run-command 'upcase-word)");
  assert.equal(buffer.text, 'CAFÉ');
  assert.equal(buffer.point, 4);
});

// --- whitespace ---------------------------------------------------------

test('delete-horizontal-space removes blanks around point', async () => {
  const { buffer, run } = await editor('a  \t b');
  run('(goto! 3)');
  run("(run-command 'delete-horizontal-space)");
  assert.equal(buffer.text, 'ab');
  assert.equal(buffer.point, 1);
});

test('delete-horizontal-space stays on its line', async () => {
  const { buffer, run } = await editor('a  \n  b');
  run('(goto! 3)'); // end of line 0
  run("(run-command 'delete-horizontal-space)");
  assert.equal(buffer.text, 'a\n  b');
});

test('just-one-space collapses to one space, or inserts one', async () => {
  const { buffer, run } = await editor('a   b');
  run('(goto! 2)');
  run("(run-command 'just-one-space)");
  assert.equal(buffer.text, 'a b');
  assert.equal(buffer.point, 2);
  const tight = await editor('ab');
  tight.run('(goto! 1)');
  tight.run("(run-command 'just-one-space)");
  assert.equal(tight.buffer.text, 'a b');
});

test('delete-indentation joins onto the previous line', async () => {
  const { buffer, run } = await editor('  foo\n    bar');
  run('(goto! 10)');
  run("(run-command 'delete-indentation)");
  assert.equal(buffer.text, '  foo bar');
  assert.equal(buffer.point, 5);
});

// --- blank lines --------------------------------------------------------

test('delete-blank-lines collapses a run to one blank line', async () => {
  const { buffer, run } = await editor('aaa\n\n\n\nbbb');
  run('(goto! 5)');
  run("(run-command 'delete-blank-lines)");
  assert.equal(buffer.text, 'aaa\n\nbbb');
  assert.equal(buffer.point, 4);
});

test('delete-blank-lines deletes an isolated blank line', async () => {
  const { buffer, run } = await editor('aaa\n\nbbb');
  run('(goto! 4)');
  run("(run-command 'delete-blank-lines)");
  assert.equal(buffer.text, 'aaa\nbbb');
});

test('delete-blank-lines empties a whitespace-only survivor', async () => {
  const { buffer, run } = await editor('aaa\n  \n\t\nbbb');
  run('(goto! 5)');
  run("(run-command 'delete-blank-lines)");
  assert.equal(buffer.text, 'aaa\n\nbbb');
});

test('delete-blank-lines from a non-blank line deletes the following run', async () => {
  const { buffer, run } = await editor('aaa\n\n\nbbb');
  run('(goto! 1)');
  run("(run-command 'delete-blank-lines)");
  assert.equal(buffer.text, 'aaa\nbbb');
  assert.equal(buffer.point, 1);
});

// --- paragraphs ---------------------------------------------------------

test('forward-paragraph lands on the separating blank line, then the end', async () => {
  const { run } = await editor('one\ntwo\n\nthree\nfour');
  run('(goto! 0)');
  run("(run-command 'forward-paragraph)");
  assert.equal(run('(point)'), 8);
  run("(run-command 'forward-paragraph)");
  assert.equal(run('(point)'), 19);
});

test('backward-paragraph lands on the blank line above, then the start', async () => {
  const { run } = await editor('one\ntwo\n\nthree\nfour');
  run('(goto! 12)');
  run("(run-command 'backward-paragraph)");
  assert.equal(run('(point)'), 8);
  run("(run-command 'backward-paragraph)");
  assert.equal(run('(point)'), 0);
});

test('mark-paragraph selects the paragraph around point', async () => {
  const { run } = await editor('one\ntwo\n\nthree\nfour');
  run('(goto! 5)');
  run("(run-command 'mark-paragraph)");
  assert.equal(run('(point)'), 0);
  assert.equal(run('(mark)'), 8);
});

// --- mark-word ----------------------------------------------------------

test('mark-word marks the next word and extends on repeat', async () => {
  const { run } = await editor('foo bar baz');
  run('(goto! 0)');
  run("(run-command 'mark-word)");
  assert.equal(run('(mark)'), 3);
  assert.equal(run('(point)'), 0);
  run("(run-command 'mark-word)");
  assert.equal(run('(mark)'), 7);
});

// --- zap-to-char --------------------------------------------------------

test('zap-to-char kills through the next occurrence of the char', async () => {
  const { buffer, run } = await editor('hello world');
  run('(goto! 0)');
  run("(run-command 'zap-to-char)");
  run('(handle-key "o")'); // the key-reader consumes the char
  assert.equal(buffer.text, ' world');
  assert.equal(run('(kill-ring-top)'), 'hello');
});

test('zap-to-char with no match leaves the buffer alone', async () => {
  const { buffer, run } = await editor('hello');
  run('(goto! 0)');
  run("(run-command 'zap-to-char)");
  run('(handle-key "z")');
  assert.equal(buffer.text, 'hello');
});

// --- keybindings --------------------------------------------------------

test('the new commands are bound to their Emacs keys', async () => {
  const { run } = await editor('');
  const expect = {
    'M-t': 'transpose-words',
    'M-u': 'upcase-word',
    'M-l': 'downcase-word',
    'M-c': 'capitalize-word',
    'M-backslash': 'delete-horizontal-space',
    'M-space': 'just-one-space',
    'M-S-6': 'delete-indentation',
    'M-S-[': 'backward-paragraph',
    'M-S-]': 'forward-paragraph',
    'M-S-2': 'mark-word',
    'M-h': 'mark-paragraph',
    'C-S-backspace': 'kill-whole-line',
    'C-t': 'transpose-chars',
  };
  for (const [key, command] of Object.entries(expect)) {
    assert.equal(
      run(`(symbol->string (get the-keymap "${key}" nil))`),
      command,
      `${key} should be bound to ${command}`
    );
  }
  for (const [key, command] of Object.entries({
    'C-t': 'transpose-lines',
    'C-o': 'delete-blank-lines',
    'C-u': 'upcase-region',
    'C-l': 'downcase-region',
  })) {
    assert.equal(
      run(`(symbol->string (get c-x-keymap "${key}" nil))`),
      command,
      `C-x ${key} should be bound to ${command}`
    );
  }
});
