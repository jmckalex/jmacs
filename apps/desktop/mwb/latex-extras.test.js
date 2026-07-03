/**
 * @file Server-side port test for the LaTeX extras chain (G3):
 * latex-insert.lisp (Phase 2), latex-math.lisp (Phase 3),
 * latex-nav.lisp (Phase 5), latex-fill.lisp.
 *
 * The model-side commands — font wrappers, close-environment, section
 * navigation, \begin/\end matching, M-RET \item, smart quotes, and
 * fill-paragraph — run server-side over plain buffer primitives. The
 * completion-driven inserts (insert-environment / insert-macro / math
 * symbol) route through the spine's completing-minibuffer (the prompt
 * round-trips; the candidate list is the deferred render half). See
 * PRIMITIVE-SPLIT.md "Modes / latex".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpine } from './spine.js';

function makeSpine(initialText = '', name = 'paper.tex') {
  const log = { minibufferOpens: [] };
  const spine = createSpine(
    { initialText, name },
    {
      onStatus: () => {}, onMinibufferOpen: (p) => log.minibufferOpens.push(p),
      onMinibufferClose: () => {}, onScroll: () => {}, onPicker: () => {},
    }
  );
  return { spine, log };
}

function select(spine, start, end) {
  spine.buffer.moveTo(start);
  spine.buffer.moveTo(end, { extend: true });
}

// --- latex-insert (Phase 2) -------------------------------------------

test('latex-texttt / latex-textsc wrap the selection (Phase-2 font commands)', () => {
  const { spine } = makeSpine('mono');
  select(spine, 0, 4);
  spine.runCommand('latex-texttt');
  assert.equal(spine.buffer.text, '\\texttt{mono}');
});

test('latex-close-environment closes the innermost open \\begin', () => {
  const { spine } = makeSpine('\\begin{quote}\n');
  spine.buffer.moveTo(spine.buffer.text.length);
  spine.runCommand('latex-close-environment');
  assert.equal(spine.buffer.text, '\\begin{quote}\n\\end{quote}');
});

test('latex-insert-environment routes through the completing-minibuffer (prompt round-trips)', () => {
  const { spine, log } = makeSpine('');
  spine.runCommand('latex-insert-environment');
  // The prompt opened via the spine's minibuffer channel (the candidate
  // list is the deferred render half); the command suspended awaiting input.
  assert.ok(log.minibufferOpens.length >= 1, 'a prompt opened');
  assert.match(log.minibufferOpens[0], /Environment/);
});

// --- latex-nav (Phase 5) ----------------------------------------------

test('latex-insert-item adds an \\item inside an itemize (M-RET)', () => {
  const { spine } = makeSpine('\\begin{itemize}\n  \\item one\n\\end{itemize}\n');
  spine.buffer.moveTo('\\begin{itemize}\n  \\item one'.length);
  spine.runCommand('latex-insert-item');
  assert.equal(
    spine.buffer.text,
    '\\begin{itemize}\n  \\item one\n  \\item \n\\end{itemize}\n'
  );
});

test('latex-smart-quote inserts the opening `` at the start of a line', () => {
  const { spine } = makeSpine('');
  spine.runCommand('latex-smart-quote');
  assert.equal(spine.buffer.text, '``');
});

test('latex-next-section jumps point to the next \\section', () => {
  const { spine } = makeSpine('intro\n\\section{A}\nbody\n\\section{B}\n');
  spine.buffer.moveTo(0);
  spine.runCommand('latex-next-section');
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 1,
    'point moved to the first \\section line');
});

// --- latex-fill -------------------------------------------------------

test('latex-fill-paragraph re-indents and wraps a list item, server-side', () => {
  const initial = [
    '\\begin{itemize}',
    '\\item This is a long item that goes well past the fill column and therefore needs to be wrapped onto continuation lines that align nicely under it.',
    '\\item Short one.',
    '\\end{itemize}',
  ].join('\n');
  const { spine } = makeSpine(initial);
  spine.buffer.moveTo(initial.indexOf('goes well'));
  spine.runCommand('latex-fill-paragraph');
  const expected = [
    '\\begin{itemize}',
    '  \\item This is a long item that goes well past the fill column and',
    '    therefore needs to be wrapped onto continuation lines that align',
    '    nicely under it.',
    '  \\item Short one.',
    '\\end{itemize}',
  ].join('\n');
  assert.equal(spine.buffer.text, expected);
});

// --- M-x visibility ---------------------------------------------------

test('the LaTeX-extras commands are M-x-visible', () => {
  const { spine } = makeSpine('');
  const names = spine.commandNames();
  for (const c of [
    'latex-texttt', 'latex-close-environment', 'latex-insert-environment',
    'latex-insert-item', 'latex-smart-quote', 'latex-next-section',
    'latex-fill-paragraph', 'latex-math-insert-symbol',
  ]) {
    assert.ok(names.includes(c), `${c} is a real command`);
  }
});

// --- keymap install regression (the spine load order) --------------------
// latex.lisp, the latex feature files and the reftex files each install
// keys onto latex-mode-map; the spine's SPINE_STDLIB order loads reftex
// AFTER latex-nav/latex-fill, and a wholesale `{...}` reinstall used to
// wipe M-q / M-enter / `"` from the live app while the stdlib test order
// masked it (live report 2026-07-02: M-q ran the generic fill-paragraph
// and inlined a \begin{equation} block into prose). These tests walk the
// REAL spine loader and dispatch through the keymap — not runCommand.

test('latex-mode top-level keys survive the spine load order', () => {
  const { spine } = makeSpine('x');
  const ev = (s) => spine.interpreter.evaluate(s);
  assert.equal(ev(`(eq? (get latex-mode-map "M-q" nil) 'latex-fill-paragraph)`), true, 'M-q');
  assert.equal(ev(`(eq? (get latex-mode-map "M-enter" nil) 'latex-insert-item)`), true, 'M-enter');
  assert.equal(ev(`(eq? (get latex-mode-map "\\"" nil) 'latex-smart-quote)`), true, 'smart quote');
  // The shared C-c prefix map accumulated every file's chords:
  assert.equal(ev(`(eq? (get (get latex-mode-map "C-c") "[" nil) 'reftex-citation)`), true, 'C-c [ (reftex-cite)');
  assert.equal(ev(`(eq? (get (get latex-mode-map "C-c") "C-e" nil) 'latex-insert-environment)`), true, 'C-c C-e (latex-insert)');
  assert.equal(ev(`(eq? (get (get latex-mode-map "C-c") "C-c" nil) 'latex-compile)`), true, 'C-c C-c (latex-compile)');
});

test('M-q through the keymap runs the AUCTeX fill (not the generic one)', () => {
  const initial = [
    '\\begin{itemize}',
    '\\item alpha beta',
    '\\end{itemize}',
  ].join('\n');
  const { spine } = makeSpine(initial);
  spine.buffer.moveTo(initial.indexOf('alpha'));
  spine.handleKey('M-q');
  assert.equal(spine.buffer.text, [
    '\\begin{itemize}',
    '  \\item alpha beta',
    '\\end{itemize}',
  ].join('\n'), 'the item re-indented: latex-fill-paragraph ran');
});

test('M-q never merges a \\begin/\\end block into the prose (the live report)', () => {
  const initial = [
    'Some prose that precedes the equation block goes right here.',
    '\\begin{equation}',
    '  \\label{eq:d}',
    '  x = 1',
    '\\end{equation}',
    'And some prose after it.',
  ].join('\n');
  const { spine } = makeSpine(initial);
  spine.buffer.moveTo(0);
  spine.handleKey('M-q');
  const t = spine.buffer.text;
  assert.ok(t.includes('\n\\begin{equation}\n'), '\\begin keeps its own line');
  assert.ok(t.includes('\n  \\label{eq:d}\n  x = 1\n'), 'the equation body is byte-identical');
  assert.ok(t.includes('\n\\end{equation}\n'), '\\end keeps its own line');
});
