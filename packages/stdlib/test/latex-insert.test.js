/**
 * @file latex-insert.test.js — unit tests for AUCTeX Phase 2's pure core
 * (latex-insert.lisp): the environment-template generator, the
 * candidate-merge (static list + buffer scan), the innermost-open-env
 * finder (for close-environment), and the section-level handling.
 *
 * Phase 2 is the smart-insertion layer. Everything that can be a pure
 * function is one, parameterised by a text string (+ offset / indent /
 * region body), so it is exercised here directly over in-memory fixtures
 * — no buffer, view, or minibuffer needed. The minibuffer/insert
 * round-trip itself is live-smoke.
 *
 * The harness loads the full standard library (so `*latex-environments*`,
 * `*latex-macros*`, the section-level list, and the RefTeX prefixes are
 * present) with the same minimal stub primitives reftex-refs.test uses.
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
 * Build an interpreter with the whole standard library loaded and the
 * minimal stub primitives the insertion helpers touch when reached. The
 * pure helpers under test need none of these, but loading the stdlib does
 * (RefTeX's accessors etc.), so they are stubbed as no-ops.
 */
async function insertEditor() {
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

// The cursor sentinel the template carries — NUL, matching
// *latex-point-mark* in latex-insert.lisp. Kept here so assertions can
// show exactly where point lands.
const MARK = '\0';

// --- environment templates ---------------------------------------------

test('env-template: itemize gets a first \\item with point after it', async () => {
  const { ev } = await insertEditor();
  assert.equal(
    ev(`(-latex-env-template "itemize" "" "" "")`),
    `\\begin{itemize}\n  \\item ${MARK}\n\\end{itemize}`
  );
});

test('env-template: enumerate gets a first \\item', async () => {
  const { ev } = await insertEditor();
  assert.equal(
    ev(`(-latex-env-template "enumerate" "" "" "")`),
    `\\begin{enumerate}\n  \\item ${MARK}\n\\end{enumerate}`
  );
});

test('env-template: description gets \\item[] with point after', async () => {
  const { ev } = await insertEditor();
  assert.equal(
    ev(`(-latex-env-template "description" "" "" "")`),
    `\\begin{description}\n  \\item[] ${MARK}\n\\end{description}`
  );
});

test('env-template: figure gets centering / body / caption / label', async () => {
  const { ev } = await insertEditor();
  // The label key carries RefTeX's fig: prefix (RefTeX is loaded). Point
  // lands on the body line between \centering and \caption.
  assert.equal(
    ev(`(-latex-env-template "figure" "" "" "")`),
    `\\begin{figure}\n` +
      `  \\centering\n` +
      `  ${MARK}\n` +
      `  \\caption{}\n` +
      `  \\label{fig:}\n` +
      `\\end{figure}`
  );
});

test('env-template: table gets a tab: label prefix', async () => {
  const { ev } = await insertEditor();
  assert.equal(
    ev(`(-latex-env-template "table" "" "" "")`),
    `\\begin{table}\n` +
      `  \\centering\n` +
      `  ${MARK}\n` +
      `  \\caption{}\n` +
      `  \\label{tab:}\n` +
      `\\end{table}`
  );
});

test('env-template: tabular puts the column spec on the \\begin line', async () => {
  const { ev } = await insertEditor();
  assert.equal(
    ev(`(-latex-env-template "tabular" "" "" "lcr")`),
    `\\begin{tabular}{lcr}\n  ${MARK}\n\\end{tabular}`
  );
});

test('env-template: equation gets a bare math body line', async () => {
  const { ev } = await insertEditor();
  assert.equal(
    ev(`(-latex-env-template "equation" "" "" "")`),
    `\\begin{equation}\n  ${MARK}\n\\end{equation}`
  );
  // align / gather / multline are math too.
  assert.equal(
    ev(`(-latex-env-template "align" "" "" "")`),
    `\\begin{align}\n  ${MARK}\n\\end{align}`
  );
});

test('env-template: an unknown env gets a single empty content line', async () => {
  const { ev } = await insertEditor();
  assert.equal(
    ev(`(-latex-env-template "widgetbox" "" "" "")`),
    `\\begin{widgetbox}\n  ${MARK}\n\\end{widgetbox}`
  );
});

test('env-template: region-wrap uses the region text as the body', async () => {
  const { ev } = await insertEditor();
  // With a non-empty body, the body becomes the single content line and
  // the kind-specific template is bypassed (point lands after the body).
  assert.equal(
    ev(`(-latex-env-template "quote" "" "Hello there." "")`),
    `\\begin{quote}\n  Hello there.${MARK}\n\\end{quote}`
  );
  // Region-wrap overrides even an itemize template.
  assert.equal(
    ev(`(-latex-env-template "itemize" "" "wrapped" "")`),
    `\\begin{itemize}\n  wrapped${MARK}\n\\end{itemize}`
  );
});

test('env-template: indentation is applied to every line', async () => {
  const { ev } = await insertEditor();
  // A 4-space line indent: \begin / content (indent + 2) / \end.
  assert.equal(
    ev(`(-latex-env-template "equation" "    " "" "")`),
    `    \\begin{equation}\n      ${MARK}\n    \\end{equation}`
  );
});

// --- candidate merge (static + buffer scan, deduped) -------------------

test('env-candidates: static list merged with buffer \\begin names, deduped', async () => {
  const { ev, arr } = await insertEditor();
  // The buffer uses one listed env (itemize) and one novel env (myenv).
  const text = '\\begin{itemize}\\end{itemize}\n\\begin{myenv}\\end{myenv}\n';
  const cands = arr(`(-latex-env-candidates ${lispString(text)})`);
  // Static names come first (so the defaults stay in their declared order)
  // and the novel buffer env is appended once.
  assert.ok(cands.includes('itemize'));
  assert.ok(cands.includes('myenv'));
  // itemize appears exactly once despite being in both sources.
  assert.equal(cands.filter((c) => c === 'itemize').length, 1);
  // A static-only name (equation) is present.
  assert.ok(cands.includes('equation'));
});

test('scan-env-names: collects \\begin names in document order, deduped', async () => {
  const { arr } = await insertEditor();
  const text =
    '\\begin{align}\nx\n\\end{align}\n\\begin{foo}\n\\end{foo}\n\\begin{align}\n\\end{align}\n';
  assert.deepEqual(
    arr(`(-latex-scan-env-names ${lispString(text)})`),
    ['align', 'foo']
  );
});

test('macro-candidates: static list merged with buffer \\macro names', async () => {
  const { ev, arr } = await insertEditor();
  // \mycmd is novel; \emph is in the static list; \, (a control symbol)
  // and \\ are skipped (no letter run).
  const text = 'Text \\mycmd{x} and \\emph{y} with a \\, thin space.\n';
  const cands = arr(`(-latex-macro-candidates ${lispString(text)})`);
  assert.ok(cands.includes('emph'));
  assert.ok(cands.includes('mycmd'));
  assert.equal(cands.filter((c) => c === 'emph').length, 1);
  // The control symbol "\," contributes no candidate.
  assert.ok(!cands.includes(','));
  assert.ok(!cands.includes(''));
});

test('scan-macro-names: only letter-run macros, in order, deduped', async () => {
  const { arr } = await insertEditor();
  const text = '\\section{A} \\label{x} \\section{B} \\\\ \\[ math \\]\n';
  assert.deepEqual(
    arr(`(-latex-scan-macro-names ${lispString(text)})`),
    ['section', 'label']
  );
});

// --- innermost-open-environment finder (close-environment) -------------

test('innermost-open-env: one open env returns its name', async () => {
  const { ev } = await insertEditor();
  const text = '\\begin{itemize}\n  \\item one\n';
  const offset = text.length; // point at end, inside the open itemize
  assert.equal(
    ev(`(-latex-innermost-open-env ${lispString(text)} ${offset})`),
    'itemize'
  );
});

test('innermost-open-env: nested begins return the innermost', async () => {
  const { ev } = await insertEditor();
  const text = '\\begin{figure}\n\\begin{tabular}{lc}\n  a & b\n';
  const offset = text.length;
  assert.equal(
    ev(`(-latex-innermost-open-env ${lispString(text)} ${offset})`),
    'tabular'
  );
});

test('innermost-open-env: an already-closed inner env is not reported', async () => {
  const { ev } = await insertEditor();
  // The inner equation is closed; only the outer figure remains open.
  const text =
    '\\begin{figure}\n\\begin{equation}\nx=1\n\\end{equation}\nmore\n';
  const offset = text.length;
  assert.equal(
    ev(`(-latex-innermost-open-env ${lispString(text)} ${offset})`),
    'figure'
  );
});

test('innermost-open-env: a fully balanced document returns nil', async () => {
  const { ev } = await insertEditor();
  const text =
    '\\begin{itemize}\n  \\item x\n\\end{itemize}\nafter the list\n';
  const offset = text.length;
  assert.equal(
    ev(`(nil? (-latex-innermost-open-env ${lispString(text)} ${offset}))`),
    true
  );
});

test('innermost-open-env: only counts begins before the offset', async () => {
  const { ev } = await insertEditor();
  // The \begin{align} starts AFTER the offset, so it does not count; at
  // the offset only the itemize is open.
  const text = '\\begin{itemize}\nHERE\n\\begin{align}\n';
  const offset = text.indexOf('HERE');
  assert.equal(
    ev(`(-latex-innermost-open-env ${lispString(text)} ${offset})`),
    'itemize'
  );
});

test('innermost-open-env: a stray \\end before any \\begin is tolerated', async () => {
  const { ev } = await insertEditor();
  // A mismatched \end with no open env leaves the stack empty -> nil,
  // not an error.
  const text = '\\end{itemize}\ntext\n';
  const offset = text.length;
  assert.equal(
    ev(`(nil? (-latex-innermost-open-env ${lispString(text)} ${offset}))`),
    true
  );
});

// --- section-level handling --------------------------------------------

test('section-level?: recognises the seven levels', async () => {
  const { ev } = await insertEditor();
  for (const lvl of [
    'part',
    'chapter',
    'section',
    'subsection',
    'subsubsection',
    'paragraph',
    'subparagraph',
  ]) {
    assert.equal(ev(`(-latex-section-level? "${lvl}")`), true, lvl);
  }
  assert.equal(ev('(-latex-section-level? "frame")'), false);
  assert.equal(ev('(-latex-section-level? "")'), false);
});

test('normalize-level: a recognised level passes through; else "section"', async () => {
  const { ev } = await insertEditor();
  assert.equal(ev('(-latex-normalize-level "subsection")'), 'subsection');
  assert.equal(ev('(-latex-normalize-level "")'), 'section');
  assert.equal(ev('(-latex-normalize-level "bogus")'), 'section');
});

// --- soft RefTeX prefix reuse ------------------------------------------

test('section label prefix reuses RefTeX sec: (RefTeX loaded here)', async () => {
  const { ev } = await insertEditor();
  assert.equal(ev('(-latex-section-label-prefix)'), 'sec:');
  assert.equal(ev('(-latex-float-prefix "figure")'), 'fig:');
  assert.equal(ev('(-latex-float-prefix "table")'), 'tab:');
});

// --- keymap wiring -----------------------------------------------------

test('latex-c-c-map has the Phase-2 chords and keeps the existing ones', async () => {
  const { ev } = await insertEditor();
  // New Phase-2 bindings.
  assert.equal(
    ev("(eq? (get latex-c-c-map \"C-e\") 'latex-insert-environment)"),
    true
  );
  assert.equal(
    ev("(eq? (get latex-c-c-map \"]\") 'latex-close-environment)"),
    true
  );
  assert.equal(
    ev("(eq? (get latex-c-c-map \"C-m\") 'latex-insert-macro)"),
    true
  );
  assert.equal(
    ev("(eq? (get latex-c-c-map \"C-s\") 'latex-insert-section)"),
    true
  );
  // C-f is a nested sub-map (the font map), not a bare command symbol.
  assert.equal(ev('(map? (get latex-c-c-map "C-f"))'), true);
  // The font sub-map wires the four font commands.
  assert.equal(
    ev("(eq? (get (get latex-c-c-map \"C-f\") \"C-b\") 'latex-textbf)"),
    true
  );
  assert.equal(
    ev("(eq? (get (get latex-c-c-map \"C-f\") \"C-i\") 'latex-textit)"),
    true
  );
  assert.equal(
    ev("(eq? (get (get latex-c-c-map \"C-f\") \"C-e\") 'latex-emph)"),
    true
  );
  assert.equal(
    ev("(eq? (get (get latex-c-c-map \"C-f\") \"C-t\") 'latex-texttt)"),
    true
  );
  // Existing bindings are intact (latex.lisp + latex-compile + reftex).
  assert.equal(ev("(eq? (get latex-c-c-map \"b\") 'latex-textbf)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"s\") 'latex-section)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"S\") 'latex-subsection)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"C-c\") 'latex-compile)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"C-v\") 'latex-view)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"`\") 'latex-next-error)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \"(\") 'reftex-label)"), true);
  assert.equal(ev("(eq? (get latex-c-c-map \")\") 'reftex-reference)"), true);
});

test('the four Phase-2 commands and latex-texttt are registered', async () => {
  const { ev } = await insertEditor();
  for (const cmd of [
    'latex-insert-environment',
    'latex-close-environment',
    'latex-insert-macro',
    'latex-insert-section',
    'latex-texttt',
  ]) {
    assert.equal(ev(`(command-registered? '${cmd})`), true, cmd);
  }
});
