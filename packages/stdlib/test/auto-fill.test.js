/**
 * @file auto-fill.test.js — the wrap-as-you-type minor mode (auto-fill.lisp).
 *
 * Two layers, matching the file's own split:
 *   1. `-auto-fill-break-index` — the PURE wrapping decision (where to
 *      break a line, or not). Exhaustive, no buffer needed.
 *   2. `do-auto-fill` and the whole self-insert chain — over a REAL L2
 *      buffer (`createBufferPrimitives` + `@editor/buffer`), so markers,
 *      line geometry, undo grouping and the mode registry are genuine, not
 *      stubbed. The full stdlib is loaded (keymap.lisp's
 *      `*post-self-insert-hook*` seam + auto-fill.lisp both need to be in
 *      play); the handful of host primitives the unrelated stdlib files
 *      touch are stubbed to safe no-ops, and the buffer primitives win
 *      (spread last).
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

/**
 * An interpreter with the whole stdlib loaded over a real L2 buffer.
 * `ev` evaluates a form; `buffer` is the live buffer (read `.text` /
 * `.point`); `bool` evaluates a form as a JS boolean (member/`nil?`
 * results are otherwise a cons or #f, awkward to assert on).
 */
async function fillEditor(initialText = '') {
  const buffer = createBuffer(initialText, { name: 'test.txt' });
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
      // The real buffer primitives win over any stub of the same name
      // (buffer-text / buffer-major-mode / …) — spread last.
      ...createBufferPrimitives(session),
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'), {});
  const ev = (s) => interpreter.evaluate(s);
  const bool = (s) => ev(`(if ${s} #t #f)`);
  return { buffer, session, interpreter, ev, bool };
}

// --- 1. the pure break decision -----------------------------------------

test('-auto-fill-break-index: breaks at the last space at/before the column', async () => {
  const { ev } = await fillEditor();
  // "hello world" (len 11), column 8, no indent: the space at index 5.
  assert.equal(ev('(-auto-fill-break-index "hello world" 8 0)'), 5);
});

test('-auto-fill-break-index: nil when the line already fits', async () => {
  const { ev } = await fillEditor();
  assert.equal(ev('(-auto-fill-break-index "hello world" 40 0)'), false);
  assert.equal(ev('(-auto-fill-break-index "hello world" 11 0)'), false); // == column
});

test('-auto-fill-break-index: falls back to the first space AFTER the column for an over-long word', async () => {
  const { ev } = await fillEditor();
  // "hello world" column 3: no breakpoint <= 3, so break at the space (5).
  assert.equal(ev('(-auto-fill-break-index "hello world" 3 0)'), 5);
});

test('-auto-fill-break-index: nil for an unbreakable long token (no whitespace)', async () => {
  const { ev } = await fillEditor();
  assert.equal(ev('(-auto-fill-break-index "abcdefghij" 5 0)'), false);
});

test('-auto-fill-break-index: never breaks inside the leading indentation', async () => {
  const { ev } = await fillEditor();
  // "    ab cd" (4-space indent), column 4, prefix-len 4: the only usable
  // break is the space at index 6 (after "ab"), not within the indent.
  assert.equal(ev('(-auto-fill-break-index "    ab cd" 4 4)'), 6);
});

test('-auto-fill-break-index: a tab counts as a breakable whitespace', async () => {
  const { ev } = await fillEditor();
  // "aa\tbb cc" — the tab at index 2 is the last break at/before column 4.
  assert.equal(ev('(-auto-fill-break-index "aa\tbb cc" 4 0)'), 2);
});

// --- 2. do-auto-fill over a real buffer ---------------------------------

test('do-auto-fill wraps a line past the column and keeps point on its char', async () => {
  const { buffer, ev } = await fillEditor();
  ev('(set! *fill-column* 10)');
  ev('(set-buffer-text! "the quick brown")');
  ev('(goto! 15)'); // point at end
  ev('(do-auto-fill)');
  assert.equal(buffer.text, 'the quick\nbrown');
  assert.equal(buffer.point, 15); // still after the final "n"
});

test('do-auto-fill reproduces the leading indentation on the continuation line', async () => {
  const { buffer, ev } = await fillEditor();
  ev('(set! *fill-column* 10)');
  ev('(set-buffer-text! "    the quick brown")');
  ev('(goto! 19)');
  ev('(do-auto-fill)');
  assert.equal(buffer.text, '    the\n    quick brown');
});

test('do-auto-fill is a no-op when the line fits', async () => {
  const { buffer, ev } = await fillEditor();
  ev('(set! *fill-column* 80)');
  ev('(set-buffer-text! "short line")');
  ev('(goto! 10)');
  ev('(do-auto-fill)');
  assert.equal(buffer.text, 'short line');
});

test('do-auto-fill leaves an unbreakable long word alone', async () => {
  const { buffer, ev } = await fillEditor();
  ev('(set! *fill-column* 5)');
  ev('(set-buffer-text! "abcdefghij")');
  ev('(goto! 10)');
  ev('(do-auto-fill)');
  assert.equal(buffer.text, 'abcdefghij');
});

test('do-auto-fill undoes as a single step', async () => {
  const { buffer, ev } = await fillEditor('the quick brown'); // baseline text
  ev('(set! *fill-column* 10)');
  ev('(goto! 15)');
  ev('(do-auto-fill)');
  assert.equal(buffer.text, 'the quick\nbrown');
  ev('(undo!)');
  assert.equal(buffer.text, 'the quick brown'); // one undo restores the whole break
});

// --- 3. customisable column: global + per-mode --------------------------

test('a major mode\'s :fill-column overrides the global *fill-column*', async () => {
  const { buffer, ev } = await fillEditor();
  ev('(set! *fill-column* 80)'); // global would never break this line
  ev('(define narrow-mode {:name "Narrow" :fill-column 5})');
  ev('(set-major-mode! narrow-mode)');
  ev('(set-buffer-text! "aa bb cc")');
  ev('(goto! 8)');
  ev('(do-auto-fill)');
  assert.equal(buffer.text, 'aa bb\ncc');
});

test('set-fill-column changes *fill-column*', async () => {
  const { ev } = await fillEditor();
  ev('(set-fill-column 42)');
  assert.equal(ev('*fill-column*'), 42);
});

// --- 4. the mode-specified :fill-indent-function seam -------------------

test(':fill-indent-function (a procedure) indents the continuation line', async () => {
  const { buffer, ev } = await fillEditor();
  ev('(set! *fill-column* 6)');
  ev('(define (quote-indent) (insert! "> "))');
  ev('(define quote-mode {:name "Q" :fill-indent-function quote-indent})');
  ev('(set-major-mode! quote-mode)');
  ev('(set-buffer-text! "aaa bbb")');
  ev('(goto! 7)');
  ev('(do-auto-fill)');
  assert.equal(buffer.text, 'aaa\n> bbb'); // mode fn ran; prose default bypassed
});

test(':fill-indent-function may be a SYMBOL naming the procedure', async () => {
  const { buffer, ev } = await fillEditor();
  ev('(set! *fill-column* 6)');
  ev('(define (quote-indent) (insert! "> "))');
  ev("(define quote-mode {:name \"Q\" :fill-indent-function 'quote-indent})");
  ev('(set-major-mode! quote-mode)');
  ev('(set-buffer-text! "aaa bbb")');
  ev('(goto! 7)');
  ev('(do-auto-fill)');
  assert.equal(buffer.text, 'aaa\n> bbb');
});

// --- 5. the self-insert chain (the hook wiring) -------------------------

test('typing (handle-key) wraps when auto-fill-mode is on', async () => {
  const { buffer, ev } = await fillEditor('the quick brow'); // 14 chars
  ev('(set! *fill-column* 10)');
  ev('(enable-minor-mode auto-fill-minor-mode)');
  ev('(goto! 14)');
  ev('(handle-key "n")'); // "…brown" pushes past 10 → the hook fires
  assert.equal(buffer.text, 'the quick\nbrown');
  assert.equal(buffer.point, 15); // after the typed "n"
});

test('typing does NOT wrap when the mode is off (the per-buffer guard)', async () => {
  const { buffer, ev } = await fillEditor('the quick brow');
  ev('(set! *fill-column* 10)');
  // mode NOT enabled
  ev('(goto! 14)');
  ev('(handle-key "n")');
  assert.equal(buffer.text, 'the quick brown'); // plain self-insert, no break
});

test('the auto-fill hook is registered on *post-self-insert-hook*', async () => {
  const { bool } = await fillEditor();
  assert.equal(bool('(member auto-fill-after-self-insert *post-self-insert-hook*)'), true);
});

// --- 6. the toggle command + the keybinding -----------------------------

test('auto-fill-mode toggles the minor mode on and off', async () => {
  const { ev, bool } = await fillEditor();
  assert.equal(bool('(auto-fill-active?)'), false);
  ev('(auto-fill-mode)');
  assert.equal(bool('(auto-fill-active?)'), true);
  ev('(auto-fill-mode)');
  assert.equal(bool('(auto-fill-active?)'), false);
});

test('C-x f is bound to set-fill-column', async () => {
  const { ev } = await fillEditor();
  assert.equal(ev("(eq? (get c-x-keymap \"f\") 'set-fill-column)"), true);
});
