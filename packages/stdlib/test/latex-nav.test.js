/**
 * @file latex-nav.test.js — unit tests for AUCTeX Phase 5's pure core
 * (latex-nav.lisp): section next/prev offset finders (starred forms,
 * none-after / none-before), the \begin<->\end matcher (nested same-name
 * envs, mismatch tolerance), the smart-quote decision (open / close /
 * literal by the char before point), and list-environment detection
 * (inside itemize vs not). Plus a keymap-wiring test: the two new
 * top-level keys (M-RET, "), the three new C-c slots, and the survival of
 * every prior binding + the C-c prefix.
 *
 * Phase 5 is navigation & niceties. Everything that can be a pure function
 * is one, parameterised by a text string (+ offset, or the char before
 * point), so it is exercised here directly over in-memory fixtures — no
 * buffer, view, or minibuffer needed. The point-movement / insert
 * round-trips themselves are live-smoke.
 *
 * The harness loads the full standard library (so latex-insert's
 * `-latex-innermost-open-env`, the section macros, and the keymaps are all
 * present) with the same minimal stub primitives latex-math.test uses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, listToArray, NIL } from '@editor/lisp';
import { createLatexPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/**
 * An interpreter with the whole standard library loaded and the minimal
 * stub primitives the nav helpers touch when reached. The pure helpers
 * under test need none of these, but loading the stdlib does (RefTeX's
 * accessors etc.), so they are stubbed as no-ops.
 */
async function navEditor() {
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
      'buffer-text': () => '',
      'show-status!': () => NIL,
      'clear-status!': () => NIL,
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'), {});
  const ev = (s) => interpreter.evaluate(s);
  const arr = (s) => listToArray(ev(s));
  return { interpreter, ev, arr };
}

/** A Lisp string literal for embedding fixture text safely. */
function lispString(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

// --- section navigation: next-section-offset ----------------------------

test('next-section-offset finds the next sectioning macro after point', async () => {
  const { ev } = await navEditor();
  // "\section{A}\n\subsection{B}\n\section{C}"
  const text = '\\section{A}\n\\subsection{B}\n\\section{C}';
  // From 0 (on the first \section) -> the \subsection at index 12.
  assert.equal(ev(`(next-section-offset ${lispString(text)} 0)`), 12);
  // From 12 (on the \subsection) -> the second \section.
  const sub = text.indexOf('\\subsection');
  const sec2 = text.indexOf('\\section', sub + 1);
  assert.equal(ev(`(next-section-offset ${lispString(text)} ${sub})`), sec2);
});

test('next-section-offset returns nil when none follows', async () => {
  const { ev } = await navEditor();
  const text = '\\section{Last}\nbody text';
  assert.equal(ev(`(nil? (next-section-offset ${lispString(text)} 0))`), true);
});

test('next-section-offset matches starred forms', async () => {
  const { ev } = await navEditor();
  const text = 'intro\n\\section*{Unnumbered}\nmore';
  const at = text.indexOf('\\section*');
  assert.equal(ev(`(next-section-offset ${lispString(text)} 0)`), at);
});

test('next-section-offset matches all sectioning levels', async () => {
  const { ev } = await navEditor();
  for (const macro of [
    '\\part', '\\chapter', '\\section', '\\subsection',
    '\\subsubsection', '\\paragraph', '\\subparagraph',
  ]) {
    const text = `lead ${macro}{T}`;
    const at = text.indexOf(macro);
    assert.equal(
      ev(`(next-section-offset ${lispString(text)} 0)`), at,
      `${macro} should be found`
    );
  }
});

test('next-section-offset does not match a longer macro as a prefix', async () => {
  const { ev } = await navEditor();
  // \sectioning is NOT \section (the char after is a letter).
  const text = 'x \\sectioning{nope} \\section{yes}';
  const yes = text.indexOf('\\section{yes}');
  assert.equal(ev(`(next-section-offset ${lispString(text)} 0)`), yes);
});

// --- section navigation: prev-section-offset ----------------------------

test('prev-section-offset finds the previous sectioning macro before point', async () => {
  const { ev } = await navEditor();
  const text = '\\section{A}\n\\subsection{B}\n\\section{C}';
  const sec2 = text.lastIndexOf('\\section');
  const sub = text.indexOf('\\subsection');
  // From the end -> the second \section.
  assert.equal(
    ev(`(prev-section-offset ${lispString(text)} ${text.length})`), sec2);
  // From the second \section -> the \subsection.
  assert.equal(ev(`(prev-section-offset ${lispString(text)} ${sec2})`), sub);
});

test('prev-section-offset returns nil when none precedes', async () => {
  const { ev } = await navEditor();
  const text = 'preamble\n\\section{First}';
  // From offset 3 (in the preamble, before any section) -> nil.
  assert.equal(ev(`(nil? (prev-section-offset ${lispString(text)} 3))`), true);
});

// --- the section title (for the echo) -----------------------------------

test('section title is read from the macro argument', async () => {
  const { ev } = await navEditor();
  const text = '\\section{Hello World}';
  assert.equal(ev(`(-latex-section-title ${lispString(text)} 0)`), 'Hello World');
});

// --- \begin <-> \end matcher --------------------------------------------

test('latex-match-offset jumps from \\begin to its \\end', async () => {
  const { ev } = await navEditor();
  const text = '\\begin{itemize}\n\\item a\n\\end{itemize}';
  const end = text.indexOf('\\end{itemize}');
  // Point on the \begin (offset 0) -> the matching \end.
  assert.equal(ev(`(latex-match-offset ${lispString(text)} 0)`), end);
});

test('latex-match-offset jumps from \\end back to its \\begin', async () => {
  const { ev } = await navEditor();
  const text = '\\begin{itemize}\n\\item a\n\\end{itemize}';
  const end = text.indexOf('\\end{itemize}');
  assert.equal(ev(`(latex-match-offset ${lispString(text)} ${end})`), 0);
});

test('latex-match-offset works when point is within the macro name', async () => {
  const { ev } = await navEditor();
  const text = '\\begin{itemize}\n\\end{itemize}';
  const end = text.indexOf('\\end{itemize}');
  // Offset 3 is inside "\begin", offset 8 inside "{itemize}" — both on the
  // begin delimiter span.
  assert.equal(ev(`(latex-match-offset ${lispString(text)} 3)`), end);
  assert.equal(ev(`(latex-match-offset ${lispString(text)} 8)`), end);
});

test('latex-match-offset respects nested same-name environments (forward)', async () => {
  const { ev } = await navEditor();
  // Outer/inner both "a": from the OUTER begin we must reach the OUTER end.
  const text = '\\begin{a}\n  \\begin{a}\n  \\end{a}\n\\end{a}';
  const outerEnd = text.lastIndexOf('\\end{a}');
  assert.equal(ev(`(latex-match-offset ${lispString(text)} 0)`), outerEnd);
});

test('latex-match-offset respects nested same-name environments (backward)', async () => {
  const { ev } = await navEditor();
  const text = '\\begin{a}\n  \\begin{a}\n  \\end{a}\n\\end{a}';
  const outerEnd = text.lastIndexOf('\\end{a}');
  // From the OUTER end, back to the OUTER begin (offset 0).
  assert.equal(ev(`(latex-match-offset ${lispString(text)} ${outerEnd})`), 0);
  // From the INNER end, back to the INNER begin.
  const innerEnd = text.indexOf('\\end{a}');
  const innerBegin = text.indexOf('\\begin{a}', 1);
  assert.equal(
    ev(`(latex-match-offset ${lispString(text)} ${innerEnd})`), innerBegin);
});

test('latex-match-offset does not confuse different env names', async () => {
  const { ev } = await navEditor();
  const text = '\\begin{a}\n\\begin{b}\n\\end{b}\n\\end{a}';
  const endA = text.lastIndexOf('\\end{a}');
  // From the \begin{a}, the matching \end is \end{a}, NOT \end{b}.
  assert.equal(ev(`(latex-match-offset ${lispString(text)} 0)`), endA);
});

test('latex-match-offset returns nil for an unbalanced \\begin', async () => {
  const { ev } = await navEditor();
  const text = '\\begin{itemize}\n\\item only';
  assert.equal(ev(`(nil? (latex-match-offset ${lispString(text)} 0))`), true);
});

test('latex-match-offset returns nil when point is not on a delimiter', async () => {
  const { ev } = await navEditor();
  const text = '\\begin{itemize}\nplain text here\n\\end{itemize}';
  const mid = text.indexOf('plain');
  assert.equal(ev(`(nil? (latex-match-offset ${lispString(text)} ${mid}))`), true);
});

// --- smart-quote decision ------------------------------------------------

test('smart-quote-for opens at line/buffer start', async () => {
  const { ev } = await navEditor();
  assert.equal(ev('(smart-quote-for "")'), '``');
});

test('smart-quote-for opens after whitespace and open delimiters', async () => {
  const { ev } = await navEditor();
  for (const c of [' ', '\\t', '\\n', '(', '[', '{', '<', '-', '~']) {
    assert.equal(ev(`(smart-quote-for "${c}")`), '``', `after ${JSON.stringify(c)}`);
  }
});

test('smart-quote-for closes after a word char or closing delimiter', async () => {
  const { ev } = await navEditor();
  for (const c of ['a', 'Z', '0', '.', ',', ')', ']', '}', '!', '?']) {
    assert.equal(ev(`(smart-quote-for "${c}")`), "''", `after ${JSON.stringify(c)}`);
  }
});

test('smart-quote-for inserts a literal " on a double-press / after a quote', async () => {
  const { ev } = await navEditor();
  // After a straight " (the double-press), after ` (an open just typed),
  // and after ' (a close just typed) -> a literal straight quote.
  assert.equal(ev('(smart-quote-for "\\"")'), '"');
  assert.equal(ev('(smart-quote-for "`")'), '"');
  assert.equal(ev("(smart-quote-for \"'\")"), '"');
});

// --- list-environment detection (for M-RET) -----------------------------

test('latex-list-env-at reports the innermost list env at point', async () => {
  const { ev } = await navEditor();
  const text = '\\begin{itemize}\n  \\item one\n  HERE\n\\end{itemize}';
  const at = text.indexOf('HERE');
  assert.equal(ev(`(latex-list-env-at ${lispString(text)} ${at})`), 'itemize');
});

test('latex-list-env-at recognises enumerate and description', async () => {
  const { ev } = await navEditor();
  const enumText = '\\begin{enumerate}\n  X\n\\end{enumerate}';
  const descText = '\\begin{description}\n  X\n\\end{description}';
  assert.equal(
    ev(`(latex-list-env-at ${lispString(enumText)} ${enumText.indexOf('X')})`),
    'enumerate');
  assert.equal(
    ev(`(latex-list-env-at ${lispString(descText)} ${descText.indexOf('X')})`),
    'description');
});

test('latex-list-env-at returns nil outside a list', async () => {
  const { ev } = await navEditor();
  // Inside a non-list env.
  const figText = '\\begin{figure}\n  HERE\n\\end{figure}';
  assert.equal(
    ev(`(nil? (latex-list-env-at ${lispString(figText)} ${figText.indexOf('HERE')}))`),
    true);
  // Not in any environment at all.
  const plain = 'just some prose, no environment';
  assert.equal(ev(`(nil? (latex-list-env-at ${lispString(plain)} 5))`), true);
});

test('latex-list-env-at picks the INNERMOST list (nested in a float)', async () => {
  const { ev } = await navEditor();
  const text = '\\begin{figure}\n\\begin{itemize}\nHERE\n\\end{itemize}\n\\end{figure}';
  const at = text.indexOf('HERE');
  assert.equal(ev(`(latex-list-env-at ${lispString(text)} ${at})`), 'itemize');
});

// --- keymap wiring ------------------------------------------------------

test('latex-mode-map gains the two top-level Phase-5 keys', async () => {
  const { ev } = await navEditor();
  // M-RET is normalised by the renderer as "M-enter" (NOT "M-return" — the
  // Enter key's name is "enter"), so the live binding is "M-enter".
  // The double-quote key -> smart-quote.
  assert.equal(
    ev("(eq? (get latex-mode-map \"M-enter\") 'latex-insert-item)"), true);
  assert.equal(
    ev("(eq? (get latex-mode-map \"\\\"\") 'latex-smart-quote)"), true);
  // The C-c prefix is still a nested sub-map (the accumulated latex-c-c-map).
  assert.equal(ev('(map? (get latex-mode-map "C-c"))'), true);
});

test('latex-c-c-map gains the Phase-5 chords', async () => {
  const { ev } = await navEditor();
  assert.equal(
    ev("(eq? (get latex-c-c-map \"C-n\") 'latex-next-section)"), true);
  assert.equal(
    ev("(eq? (get latex-c-c-map \"C-r\") 'latex-previous-section)"), true);
  assert.equal(
    ev("(eq? (get latex-c-c-map \"%\") 'latex-goto-matching-env)"), true);
  // And reachable through latex-mode-map's "C-c" sub-map.
  assert.equal(
    ev("(eq? (get (get latex-mode-map \"C-c\") \"C-n\") 'latex-next-section)"),
    true);
});

test('every prior C-c binding survives the Phase-5 re-install', async () => {
  const { ev } = await navEditor();
  // latex.lisp
  assert.equal(ev("(eq? (get latex-c-c-map \"b\") 'latex-textbf)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"i\") 'latex-textit)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"e\") 'latex-emph)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"m\") 'latex-math-inline)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"M\") 'latex-math-display)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"s\") 'latex-section)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"S\") 'latex-subsection)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"l\") 'latex-itemize)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"n\") 'latex-enumerate)"), true);
  assert.equal(
    ev("(eq? (get latex-c-c-map \"C-p\") 'toggle-latex-math-preview)"), true);
  // latex-compile.lisp
  assert.equal(ev("(eq? (get latex-c-c-map \"C-c\") 'latex-compile)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"C-v\") 'latex-view)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"`\") 'latex-next-error)"), true);
  // reftex-refs.lisp
  assert.equal(ev("(eq? (get latex-c-c-map \"(\") 'reftex-label)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \")\") 'reftex-reference)"), true);
  // latex-insert.lisp
  assert.equal(
    ev("(eq? (get latex-c-c-map \"C-e\") 'latex-insert-environment)"), true);
  assert.equal(
    ev("(eq? (get latex-c-c-map \"]\") 'latex-close-environment)"), true);
  assert.equal(
    ev("(eq? (get latex-c-c-map \"C-m\") 'latex-insert-macro)"), true);
  assert.equal(
    ev("(eq? (get latex-c-c-map \"C-s\") 'latex-insert-section)"), true);
  assert.equal(ev('(map? (get latex-c-c-map "C-f"))'), true);
  // latex-math.lisp
  assert.equal(
    ev("(eq? (get latex-c-c-map \"~\") 'toggle-latex-math-mode)"), true);
});

test('the Phase-5 commands are registered', async () => {
  const { ev } = await navEditor();
  for (const cmd of [
    'latex-next-section', 'latex-previous-section', 'latex-goto-matching-env',
    'latex-insert-item', 'latex-smart-quote',
  ]) {
    assert.equal(ev(`(command-registered? '${cmd})`), true, `${cmd} registered`);
  }
});
