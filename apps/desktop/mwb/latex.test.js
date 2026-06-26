/**
 * @file Server-side port test for latex.lisp (G3) — the base LaTeX
 * writing commands.
 *
 * latex.lisp is fully model-side: latex-surround is pure buffer ops
 * (region-active? / region-text / insert! / goto! / delete-backward!).
 * Its C-c keymap (latex-c-c-map) dispatches through the spine's
 * mode-keymap chain on a .tex buffer (latex-mode, from modes.lisp). This
 * drives the commands both directly and via the C-c chord. See
 * PRIMITIVE-SPLIT.md "Modes / latex".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpine } from './spine.js';

function makeSpine(initialText = '', name = 'paper.tex') {
  const spine = createSpine(
    { initialText, name },
    {
      onStatus: () => {}, onMinibufferOpen: () => {}, onMinibufferClose: () => {},
      onScroll: () => {}, onPicker: () => {},
    }
  );
  return { spine };
}

/** Select [start, end) in the active buffer (mark at start, point at end). */
function select(spine, start, end) {
  spine.buffer.moveTo(start);
  spine.buffer.moveTo(end, { extend: true });
}

test('latex-textbf wraps the selection in \\textbf{…} (server-side)', () => {
  const { spine } = makeSpine('hello world');
  select(spine, 0, 5); // "hello"
  spine.runCommand('latex-textbf');
  assert.equal(spine.buffer.text, '\\textbf{hello} world');
});

test('latex-emph / latex-math-inline wrap with no selection (cursor between)', () => {
  const { spine } = makeSpine('');
  spine.runCommand('latex-emph');
  assert.equal(spine.buffer.text, '\\emph{}');
  assert.equal(spine.buffer.point, '\\emph{'.length, 'point sits inside the braces');

  const { spine: s2 } = makeSpine('');
  s2.runCommand('latex-math-inline');
  assert.equal(s2.buffer.text, '$$');
  assert.equal(s2.buffer.point, 1, 'point between the dollar signs');
});

test('latex-itemize inserts a stub environment with point after \\item', () => {
  const { spine } = makeSpine('');
  spine.runCommand('latex-itemize');
  assert.equal(spine.buffer.text, '\\begin{itemize}\n  \\item \n\\end{itemize}\n');
  // Point parks right after "\\item " (before the \\end line).
  assert.equal(spine.buffer.text.slice(0, spine.buffer.point), '\\begin{itemize}\n  \\item ');
});

test('the C-c b chord dispatches latex-textbf via the latex-mode keymap chain', () => {
  const { spine } = makeSpine('bold');
  select(spine, 0, 4);
  const h1 = spine.handleKey('C-c'); // a mode prefix in latex-mode
  const h2 = spine.handleKey('b'); // → latex-textbf
  assert.ok(h1 && h2, 'both keys were handled');
  assert.equal(spine.buffer.text, '\\textbf{bold}');
});

test('the C-c s chord dispatches latex-section', () => {
  const { spine } = makeSpine('Intro');
  select(spine, 0, 5);
  spine.handleKey('C-c');
  spine.handleKey('s');
  assert.equal(spine.buffer.text, '\\section{Intro}');
});

test('the latex writing commands are M-x-visible', () => {
  const { spine } = makeSpine('');
  const names = spine.commandNames();
  for (const c of ['latex-textbf', 'latex-emph', 'latex-section', 'latex-enumerate']) {
    assert.ok(names.includes(c), `${c} is a real command`);
  }
});
