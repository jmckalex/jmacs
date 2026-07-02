/**
 * @file latex-fill.test.js — unit tests for AUCTeX-style
 * `latex-fill-paragraph` (latex-fill.lisp).
 *
 * The bulk of the suite drives the PURE core `latex-fill-block` directly
 * over string fixtures — given a newline-joined block, the env depth at
 * its first line, the indent level, the item indent, and the fill column,
 * it returns the re-indented + re-wrapped block. No buffer, view or
 * minibuffer is needed for those. The acceptance targets mirror the
 * feature brief's examples A–E (nested envs, a wrapping itemize, a custom
 * indent level, a plain paragraph, idempotency) plus a description list,
 * deep nesting, the spaces-not-tabs invariant, and "items don't merge".
 *
 * Two further tests exercise the impure layers: the open-env-stack depth
 * helper, and a single end-to-end `latex-fill-paragraph` run against a
 * real L2 buffer (point inside the prose line, region replaced in place).
 *
 * The harness loads the whole standard library (so latex-insert's
 * `-latex-env-markers` / `-latex-pop-env` and the keymaps are present),
 * with the same minimal stub primitives latex-nav.test uses for the pure
 * tests, and a real buffer for the end-to-end one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, NIL } from '@editor/lisp';
import { createBuffer } from '@editor/buffer';
import {
  createBufferPrimitives,
  createLatexPrimitives,
  loadStdlib,
} from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/**
 * An interpreter with the whole standard library loaded and the minimal
 * stub primitives the fill helpers touch when reached. The pure helpers
 * under test need none of these, but loading the stdlib does, so they are
 * stubbed as no-ops.
 */
async function fillEditor() {
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
  return { interpreter, ev };
}

/**
 * An interpreter wired to a REAL L2 buffer for the end-to-end command
 * test: `point`, `goto!`, `insert!`, `delete-region!`, `buffer-text` and
 * `set-major-mode!` all operate on the live buffer.
 */
async function bufferEditor(initialText) {
  const buffer = createBuffer(initialText, { name: 'test.tex' });
  const interpreter = createInterpreter({
    write: () => {},
    primitives: {
      ...createBufferPrimitives({ current: buffer }),
      'read-file-text!': () => NIL,
      'file-exists?': () => false,
      'list-directory-paths': () => NIL,
      'show-status!': () => NIL,
      'clear-status!': () => NIL,
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'), {});
  const ev = (s) => interpreter.evaluate(s);
  return { interpreter, ev, buffer };
}

/** A Lisp string literal for embedding fixture text safely. */
function lispString(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** Call the pure core with the given block and (level, item-indent, column). */
function fill(ev, block, { depth = 0, level = 2, item = -2, column = 72 } = {}) {
  return ev(`(latex-fill-block ${lispString(block)} ${depth} ${level} ${item} ${column})`);
}

// --- A) nested environments ---------------------------------------------

test('A: nested environments indent and the prose wraps at column 72', async () => {
  const { ev } = await fillEditor();
  const input = [
    '\\begin{proof}',
    '\\begin{quote}',
    'This is a fairly long line of prose that certainly exceeds the seventy-two column fill boundary and must be wrapped by the fill command.',
    '\\end{quote}',
    '\\end{proof}',
  ].join('\n');
  const expected = [
    '\\begin{proof}',
    '  \\begin{quote}',
    '    This is a fairly long line of prose that certainly exceeds the',
    '    seventy-two column fill boundary and must be wrapped by the fill',
    '    command.',
    '  \\end{quote}',
    '\\end{proof}',
  ].join('\n');
  assert.equal(fill(ev, input), expected);
});

// --- B) itemize with a wrapping item ------------------------------------

test('B: itemize \\item wraps with continuations one level deeper', async () => {
  const { ev } = await fillEditor();
  const input = [
    '\\begin{itemize}',
    '\\item This is a long item that goes well past the fill column and therefore needs to be wrapped onto continuation lines that align nicely under it.',
    '\\item Short one.',
    '\\end{itemize}',
  ].join('\n');
  const expected = [
    '\\begin{itemize}',
    '  \\item This is a long item that goes well past the fill column and',
    '    therefore needs to be wrapped onto continuation lines that align',
    '    nicely under it.',
    '  \\item Short one.',
    '\\end{itemize}',
  ].join('\n');
  assert.equal(fill(ev, input), expected);
});

// --- C) custom indent level scales every indent -------------------------

test('C: a custom indent level (4) scales all indents proportionally', async () => {
  const { ev } = await fillEditor();
  const input = [
    '\\begin{proof}',
    '\\begin{quote}',
    'This is a fairly long line of prose that certainly exceeds the seventy-two column fill boundary and must be wrapped by the fill command.',
    '\\end{quote}',
    '\\end{proof}',
  ].join('\n');
  const expected = [
    '\\begin{proof}',
    '    \\begin{quote}',
    '        This is a fairly long line of prose that certainly exceeds the',
    '        seventy-two column fill boundary and must be wrapped by the fill',
    '        command.',
    '    \\end{quote}',
    '\\end{proof}',
  ].join('\n');
  // Item indent -4 keeps the same proportional relationship as the default.
  assert.equal(fill(ev, input, { level: 4, item: -4 }), expected);
});

test('C: with level 4 an item sits at depth*4 and continuations at (depth+1)*4', async () => {
  const { ev } = await fillEditor();
  const input = [
    '\\begin{itemize}',
    '\\item A reasonably long item whose body certainly needs to wrap across more than a single output line so the continuation indent is exercised.',
    '\\end{itemize}',
  ].join('\n');
  const out = fill(ev, input, { level: 4, item: -4 });
  const lines = out.split('\n');
  // \item at depth 1 -> 1*4 = 4 spaces; continuation at (1+1)*4 = 8 spaces.
  assert.match(lines[1], /^ {4}\\item /);
  assert.match(lines[2], /^ {8}\S/);
});

// --- D) a plain paragraph in no environment -----------------------------

test('D: a plain paragraph wraps to column 72 at indent 0', async () => {
  const { ev } = await fillEditor();
  const input =
    'This is a plain paragraph in no environment whatsoever and it is quite long so it should wrap to seventy-two columns at indent zero exactly here today.';
  const out = fill(ev, input);
  const lines = out.split('\n');
  assert.ok(lines.length > 1, 'a long paragraph wraps onto multiple lines');
  for (const line of lines) {
    assert.ok(line.length <= 72, `line within 72 cols: ${JSON.stringify(line)}`);
    assert.equal(/^[ \t]/.test(line), false, 'no leading indent at depth 0');
  }
  // Re-joining the words round-trips the prose.
  assert.equal(out.replace(/\n/g, ' '), input);
});

// --- E) idempotency -----------------------------------------------------

test('E: filling an already-filled paragraph is a fixed point', async () => {
  const { ev } = await fillEditor();
  const input = [
    '\\begin{proof}',
    '\\begin{quote}',
    'This is a fairly long line of prose that certainly exceeds the seventy-two column fill boundary and must be wrapped by the fill command.',
    '\\end{quote}',
    '\\end{proof}',
  ].join('\n');
  const once = fill(ev, input);
  const twice = fill(ev, once);
  assert.equal(twice, once);

  // And idempotent for the itemize example too.
  const item = [
    '\\begin{itemize}',
    '\\item This is a long item that goes well past the fill column and therefore needs to be wrapped onto continuation lines that align nicely under it.',
    '\\end{itemize}',
  ].join('\n');
  const itemOnce = fill(ev, item);
  assert.equal(fill(ev, itemOnce), itemOnce);
});

// --- description list ---------------------------------------------------

test('description list: \\item[...] lines indent like itemize items', async () => {
  const { ev } = await fillEditor();
  const input = [
    '\\begin{description}',
    '\\item[First] A description item whose body text is long enough that it must wrap across more than one line in the output here today for sure.',
    '\\item[Second] Short.',
    '\\end{description}',
  ].join('\n');
  const expected = [
    '\\begin{description}',
    '  \\item[First] A description item whose body text is long enough that it',
    '    must wrap across more than one line in the output here today for',
    '    sure.',
    '  \\item[Second] Short.',
    '\\end{description}',
  ].join('\n');
  assert.equal(fill(ev, input), expected);
});

// --- deeply nested envs -------------------------------------------------

test('deeply nested environments accumulate indent per level', async () => {
  const { ev } = await fillEditor();
  const input = [
    '\\begin{a}',
    '\\begin{b}',
    '\\begin{c}',
    'Deeply nested prose that runs on long enough to require wrapping across at least two output lines for the test to be meaningful here today.',
    '\\end{c}',
    '\\end{b}',
    '\\end{a}',
  ].join('\n');
  const out = fill(ev, input).split('\n');
  assert.equal(out[0], '\\begin{a}');
  assert.equal(out[1], '  \\begin{b}');
  assert.equal(out[2], '    \\begin{c}');
  assert.match(out[3], /^ {6}\S/);        // body at depth 3 -> 6 spaces
  // The \end lines dedent back symmetrically.
  assert.equal(out[out.length - 3], '    \\end{c}');
  assert.equal(out[out.length - 2], '  \\end{b}');
  assert.equal(out[out.length - 1], '\\end{a}');
});

// --- spaces, not tabs ---------------------------------------------------

test('indentation uses spaces, never tabs', async () => {
  const { ev } = await fillEditor();
  const input = [
    '\\begin{proof}',
    '\\begin{quote}',
    'A line of prose long enough to wrap and so to exercise the continuation indentation produced by the fill command across several lines here.',
    '\\end{quote}',
    '\\end{proof}',
  ].join('\n');
  const out = fill(ev, input);
  assert.equal(out.includes('\t'), false, 'no tab characters in the output');
});

// --- items don't merge --------------------------------------------------

test("items don't merge: two short items stay on separate lines", async () => {
  const { ev } = await fillEditor();
  const input = [
    '\\begin{itemize}',
    '\\item one',
    '\\item two',
    '\\end{itemize}',
  ].join('\n');
  const expected = [
    '\\begin{itemize}',
    '  \\item one',
    '  \\item two',
    '\\end{itemize}',
  ].join('\n');
  assert.equal(fill(ev, input), expected);
});

test("items don't merge even when both are short prose that would fit one line", async () => {
  const { ev } = await fillEditor();
  // Without the \item boundary these would collapse onto one filled line.
  const input = [
    '\\begin{enumerate}',
    '\\item alpha beta',
    '\\item gamma delta',
    '\\end{enumerate}',
  ].join('\n');
  const out = fill(ev, input).split('\n');
  assert.equal(out[1], '  \\item alpha beta');
  assert.equal(out[2], '  \\item gamma delta');
});

// --- paragraph commands keep their own line -----------------------------

test('a paragraph command (\\section) is not merged into surrounding prose', async () => {
  const { ev } = await fillEditor();
  const input = [
    'Some short intro prose.',
    '\\section{A Heading}',
    'And some more short prose after the heading line here.',
  ].join('\n');
  const out = fill(ev, input).split('\n');
  // The \section stays on its own line; the prose above/below is not
  // pulled into it.
  assert.ok(out.includes('\\section{A Heading}'));
  assert.equal(out[0], 'Some short intro prose.');
});

// --- a nested itemize inside a non-list env -----------------------------

test('an itemize nested inside a quote indents at the deeper depth', async () => {
  const { ev } = await fillEditor();
  const input = [
    '\\begin{quote}',
    '\\begin{itemize}',
    '\\item An item nested two environments deep whose body wraps across more than one line to exercise the depth-two continuation indentation here.',
    '\\end{itemize}',
    '\\end{quote}',
  ].join('\n');
  const out = fill(ev, input).split('\n');
  assert.equal(out[0], '\\begin{quote}');
  assert.equal(out[1], '  \\begin{itemize}');
  // depth 2: item at 2*2 = 4, continuation at (2+1)*2 = 6.
  assert.match(out[2], /^ {4}\\item /);
  assert.match(out[3], /^ {6}\S/);
});

// --- the env-depth helper -----------------------------------------------

test('-latex-env-depth-at counts unmatched \\begin at an offset', async () => {
  const { ev } = await fillEditor();
  const text = '\\begin{a}\n\\begin{b}\nHERE\n\\end{b}\n\\end{a}';
  const at = text.indexOf('HERE');
  assert.equal(ev(`(-latex-env-depth-at ${lispString(text)} ${at})`), 2);
  // Before any \begin -> depth 0.
  assert.equal(ev(`(-latex-env-depth-at ${lispString(text)} 0)`), 0);
  // After both \end -> back to 0.
  assert.equal(ev(`(-latex-env-depth-at ${lispString(text)} ${text.length})`), 0);
});

test('-latex-open-env-stack returns the innermost env first', async () => {
  const { ev } = await fillEditor();
  const text = '\\begin{a}\n\\begin{b}\nHERE';
  const at = text.indexOf('HERE');
  assert.equal(ev(`(car (-latex-open-env-stack ${lispString(text)} ${at}))`), 'b');
});

// --- end-to-end: the command on a real buffer ---------------------------

test('latex-fill-paragraph re-indents and wraps the block at point', async () => {
  const initial = [
    '\\begin{itemize}',
    '\\item This is a long item that goes well past the fill column and therefore needs to be wrapped onto continuation lines that align nicely under it.',
    '\\item Short one.',
    '\\end{itemize}',
  ].join('\n');
  const { ev, buffer } = await bufferEditor(initial);
  // Put point inside the long \item's prose.
  const pointAt = initial.indexOf('goes well');
  ev(`(goto! ${pointAt})`);
  ev('(latex-fill-paragraph)');
  const expected = [
    '\\begin{itemize}',
    '  \\item This is a long item that goes well past the fill column and',
    '    therefore needs to be wrapped onto continuation lines that align',
    '    nicely under it.',
    '  \\item Short one.',
    '\\end{itemize}',
  ].join('\n');
  assert.equal(buffer.text, expected);
});

test('latex-fill-paragraph leaves a blank line unchanged', async () => {
  const initial = 'first paragraph\n\nsecond paragraph';
  const { ev, buffer } = await bufferEditor(initial);
  // Point on the empty middle line.
  ev(`(goto! ${initial.indexOf('\n\n') + 1})`);
  ev('(latex-fill-paragraph)');
  assert.equal(buffer.text, initial);
});

test('latex-fill-paragraph does not reflow a verbatim environment', async () => {
  const initial = [
    '\\begin{verbatim}',
    'this   is    spaced   text   that   must   stay   exactly   as   written here without any reflow whatsoever no matter how long the line gets okay',
    '\\end{verbatim}',
  ].join('\n');
  const { ev, buffer } = await bufferEditor(initial);
  ev(`(goto! ${initial.indexOf('spaced')})`);
  ev('(latex-fill-paragraph)');
  assert.equal(buffer.text, initial, 'verbatim contents are left untouched');
});

// --- keymap wiring ------------------------------------------------------

test('latex-fill-paragraph is registered and bound to M-q', async () => {
  const { ev } = await fillEditor();
  assert.equal(ev("(command-registered? 'latex-fill-paragraph)"), true);
  assert.equal(
    ev("(eq? (get latex-mode-map \"M-q\") 'latex-fill-paragraph)"), true);
});

test('the M-q binding does not disturb the C-c sub-map or the Phase-5 keys', async () => {
  const { ev } = await fillEditor();
  assert.equal(ev('(map? (get latex-mode-map "C-c"))'), true);
  assert.equal(
    ev("(eq? (get latex-mode-map \"M-enter\") 'latex-insert-item)"), true);
  assert.equal(
    ev("(eq? (get latex-mode-map \"\\\"\") 'latex-smart-quote)"), true);
  // A prior C-c chord still resolves through the sub-map.
  assert.equal(
    ev("(eq? (get (get latex-mode-map \"C-c\") \"C-e\") 'latex-insert-environment)"),
    true);
});

test('the indent-level and item-indent defcustoms have the AUCTeX defaults', async () => {
  const { ev } = await fillEditor();
  assert.equal(ev('*latex-indent-level*'), 2);
  assert.equal(ev('*latex-item-indent*'), -2);
});

// --- the `document' (non-indenting) environment exclusion ----------------
// AUCTeX's `LaTeX-document-regexp': content inside \begin{document} is not
// pushed in a level. Mirrored via `*latex-non-indenting-environments*'.

test('*latex-non-indenting-environments* defaults to ("document")', async () => {
  const { ev } = await fillEditor();
  assert.equal(
    ev('(equal? *latex-non-indenting-environments* (list "document"))'), true);
});

test('-latex-env-depth-at does not count the document environment', async () => {
  const { ev } = await fillEditor();
  // Prose directly inside \begin{document} -> depth 0 (document excluded).
  const top = '\\begin{document}\nHERE\n\\end{document}';
  assert.equal(ev(`(-latex-env-depth-at ${lispString(top)} ${top.indexOf('HERE')})`), 0);
  // document + proof -> depth 1 (only proof counts).
  const nested = '\\begin{document}\n\\begin{proof}\nHERE\n\\end{proof}\n\\end{document}';
  assert.equal(
    ev(`(-latex-env-depth-at ${lispString(nested)} ${nested.indexOf('HERE')})`), 1);
});

test('latex-fill-block leaves a \\begin{document} body at column 0', async () => {
  const { ev } = await fillEditor();
  // A block that itself contains the document begin/end lines: the body must
  // NOT pick up a level (the walk skips the non-indenting env's depth).
  const block = '\\begin{document}\nHello world\n\\end{document}';
  assert.equal(ev(`(latex-fill-block ${lispString(block)} 0 2 -2 72)`), block);
});

test('latex-fill-paragraph keeps document-level prose flush-left', async () => {
  // Without the document exclusion this prose would gain a 2-space indent.
  const initial = '\\begin{document}\n\nProse paragraph here.\n\n\\end{document}';
  const { ev, buffer } = await bufferEditor(initial);
  ev(`(goto! ${initial.indexOf('Prose')})`);
  ev('(latex-fill-paragraph)');
  assert.equal(buffer.text, initial, 'document-level prose stays at column 0');
});

test('latex-fill-paragraph: a list inside document indents from column 0', async () => {
  const initial = [
    '\\begin{document}',
    '',
    '\\begin{itemize}',
    '\\item This is a long item that goes well past the fill column and therefore needs to be wrapped onto continuation lines that align nicely under it.',
    '\\item Short one.',
    '\\end{itemize}',
    '',
    '\\end{document}',
  ].join('\n');
  const { ev, buffer } = await bufferEditor(initial);
  ev(`(goto! ${initial.indexOf('goes well')})`);
  ev('(latex-fill-paragraph)');
  const expected = [
    '\\begin{document}',
    '',
    '\\begin{itemize}',           // column 0, not indented by `document`
    '  \\item This is a long item that goes well past the fill column and',
    '    therefore needs to be wrapped onto continuation lines that align',
    '    nicely under it.',
    '  \\item Short one.',
    '\\end{itemize}',
    '',
    '\\end{document}',
  ].join('\n');
  assert.equal(buffer.text, expected);
});

test('*latex-non-indenting-environments* is customisable (e.g. a frame env)', async () => {
  const { ev } = await fillEditor();
  ev('(set! *latex-non-indenting-environments* (list "document" "frame"))');
  const text = '\\begin{frame}\nHERE\n\\end{frame}';
  assert.equal(ev(`(-latex-env-depth-at ${lispString(text)} ${text.indexOf('HERE')})`), 0);
});

// --- latex-fill-block honours its fill-column argument -------------------
// Regression: the wrap step once read the global `*latex-fill-column*`
// rather than the threaded FILL-COLUMN parameter, so a custom column was
// ignored. Wrapping the same prose at 20 vs 72 must differ.

test('latex-fill-block wraps at the passed fill column, not the global', async () => {
  const { ev } = await fillEditor();
  const prose = 'one two three four five six seven eight nine ten eleven twelve';
  const at72 = ev(`(latex-fill-block ${lispString(prose)} 0 2 -2 72)`);
  const at20 = ev(`(latex-fill-block ${lispString(prose)} 0 2 -2 20)`);
  assert.equal(at72, prose, 'fits on one line at column 72');
  assert.ok(at20.split('\n').length > 1, 'breaks into several lines at column 20');
  for (const line of at20.split('\n')) {
    assert.ok(line.length <= 20, `"${line}" within the 20-column budget`);
  }
});

// --- the completed AUCTeX port: comments ---------------------------------
// AUCTeX `LaTeX-fill-paragraph` fills comment paragraphs behind their
// %-run prefix, and treats a code line's trailing comment ("code
// comment") as the end of its fill unit — glued on, never filled.

test('a comment paragraph fills behind its % prefix', async () => {
  const { ev } = await fillEditor();
  const input = [
    '% alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi',
    '% rho sigma tau upsilon',
  ].join('\n');
  const expected = [
    '% alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu',
    '% xi omicron pi rho sigma tau upsilon',
  ].join('\n');
  assert.equal(fill(ev, input), expected);
  // Idempotent.
  assert.equal(fill(ev, expected), expected);
});

test('comment runs of different %-depth never merge', async () => {
  const { ev } = await fillEditor();
  const input = [
    '%% Section header comment',
    '% body comment text here',
  ].join('\n');
  assert.equal(fill(ev, input), input, '%% and % stay separate paragraphs');
});

test('a comment inside an environment indents to the env depth', async () => {
  const { ev } = await fillEditor();
  const input = [
    '\\begin{itemize}',
    '% a comment inside the list',
    '\\end{itemize}',
  ].join('\n');
  const expected = [
    '\\begin{itemize}',
    '  % a comment inside the list',
    '\\end{itemize}',
  ].join('\n');
  assert.equal(fill(ev, input), expected);
});

test('a bare % line is a boundary between comment paragraphs', async () => {
  const { ev } = await fillEditor();
  const input = [
    '% first part',
    '%',
    '% second part',
  ].join('\n');
  assert.equal(fill(ev, input), input);
});

test('a trailing code comment ends the fill unit and stays glued', async () => {
  const { ev } = await fillEditor();
  const input = [
    'alpha beta',
    'gamma delta % note',
    'epsilon zeta',
  ].join('\n');
  const expected = [
    'alpha beta gamma delta % note',
    'epsilon zeta',
  ].join('\n');
  assert.equal(fill(ev, input), expected, 'code joins, comment glues, next line starts fresh');
  assert.equal(fill(ev, expected), expected, 'idempotent');
});

test("an item's trailing comment keeps later lines at the continuation indent", async () => {
  const { ev } = await fillEditor();
  const input = [
    '\\begin{itemize}',
    '\\item first words % note',
    'continuation prose',
    '\\end{itemize}',
  ].join('\n');
  const expected = [
    '\\begin{itemize}',
    '  \\item first words % note',
    '    continuation prose',
    '\\end{itemize}',
  ].join('\n');
  assert.equal(fill(ev, input), expected);
});

test('\\% is not a comment start (backslash parity)', async () => {
  const { ev } = await fillEditor();
  const input = [
    'Costs fifty \\% of the total amount',
    'and continues here',
  ].join('\n');
  const expected = 'Costs fifty \\% of the total amount and continues here';
  assert.equal(fill(ev, input), expected);
});

test('a % inside a \\verb group is not a comment', async () => {
  const { ev } = await fillEditor();
  const input = [
    'use \\verb|50%| here',
    'and more words',
  ].join('\n');
  assert.equal(fill(ev, input), 'use \\verb|50%| here and more words');
});

// --- the completed port: \verb and break-at-separators -------------------

test('a \\verb group never breaks across lines', async () => {
  const { ev } = await fillEditor();
  const input =
    'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk \\verb|one two three four| tail';
  const result = fill(ev, input);
  const lines = result.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk');
  assert.equal(lines[1], '\\verb|one two three four| tail', 'verb group moved whole, spaces intact');
});

test('an inline \\(…\\) group moves whole to the next line (break-at-separators)', async () => {
  const { ev } = await fillEditor();
  const input =
    'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk \\(alpha + beta + gamma = delta\\) tail';
  const result = fill(ev, input);
  const lines = result.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '\\(alpha + beta + gamma = delta\\) tail');
});

test('with *latex-fill-break-at-separators* off, math splits like prose', async () => {
  const { ev } = await fillEditor();
  ev('(set! *latex-fill-break-at-separators* #f)');
  const input =
    'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk \\(alpha + beta + gamma = delta\\) tail';
  const result = fill(ev, input);
  assert.ok(result.includes('\\(alpha + beta +\ngamma'), 'break lands inside the math group');
});

test('an unclosed \\( wraps as ordinary words', async () => {
  const { ev } = await fillEditor();
  const input =
    'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk \\(alpha + beta + gamma = delta tail';
  const result = fill(ev, input);
  for (const line of result.split('\n')) {
    assert.ok(line.length <= 72, `"${line}" within the column`);
  }
});

// --- the completed port: sentence-end double space ------------------------

test('sentence-end double space on joins when the custom is on', async () => {
  const { ev } = await fillEditor();
  ev('(set! *latex-sentence-end-double-space* #t)');
  const input = [
    'First sentence ends here.',
    'Second sentence follows.',
  ].join('\n');
  assert.equal(fill(ev, input), 'First sentence ends here.  Second sentence follows.');
  // An existing intra-line double space is preserved.
  assert.equal(fill(ev, 'One.  Two.'), 'One.  Two.');
});

test('sentence-end double space is OFF by default (single-space joins)', async () => {
  const { ev } = await fillEditor();
  const input = [
    'First sentence ends here.',
    'Second sentence follows.',
  ].join('\n');
  assert.equal(fill(ev, input), 'First sentence ends here. Second sentence follows.');
  // With the custom off, stray runs collapse to one space.
  assert.equal(fill(ev, 'One.  Two.'), 'One. Two.');
});

// --- the completed port: protected envs inside the block ------------------

test('a protected env inside the block passes through byte-identical', async () => {
  const { ev } = await fillEditor();
  const input = [
    '\\begin{proof}',
    '\\begin{align}',
    'x &= 1 \\\\',
    'y &= 2',
    '\\end{align}',
    '\\end{proof}',
  ].join('\n');
  const expected = [
    '\\begin{proof}',
    '  \\begin{align}',
    'x &= 1 \\\\',
    'y &= 2',
    '  \\end{align}',
    '\\end{proof}',
  ].join('\n');
  assert.equal(fill(ev, input), expected,
    'begin/end re-indent, the align body does not move');
});

test('prose around a protected env fills; the env body does not', async () => {
  const { ev } = await fillEditor();
  const input = [
    'Some prose before the alignment environment which is certainly long enough to need wrapping.',
    '\\begin{align}',
    '  x &= 1',
    '\\end{align}',
    'Prose after.',
  ].join('\n');
  const result = fill(ev, input);
  assert.ok(result.includes('\n  x &= 1\n'), 'align body byte-identical');
  const lines = result.split('\n');
  for (const line of lines) {
    if (!line.includes('&')) assert.ok(line.length <= 72, `"${line}" wrapped`);
  }
  assert.ok(lines[lines.length - 1] === 'Prose after.', 'walk resumes after the env');
});

// --- the completed port: point restoration --------------------------------

test('latex-fill-paragraph keeps point at its prose position', async () => {
  const initial = [
    '\\begin{itemize}',
    '\\item This is a long item that goes well past the fill column and therefore needs to be wrapped onto continuation lines that align nicely under it.',
    '\\item Short one.',
    '\\end{itemize}',
  ].join('\n');
  const { ev, buffer } = await bufferEditor(initial);
  ev(`(goto! ${initial.indexOf('goes well')})`);
  ev('(latex-fill-paragraph)');
  assert.equal(ev('(point)'), buffer.text.indexOf('goes well'),
    'point still sits on the word it was on');
});

// --- the completed port: the command over comments end-to-end -------------

test('latex-fill-paragraph fills a comment paragraph in the buffer', async () => {
  const initial = [
    '% alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi',
    '% rho sigma tau upsilon',
  ].join('\n');
  const { ev, buffer } = await bufferEditor(initial);
  ev(`(goto! ${initial.indexOf('gamma')})`);
  ev('(latex-fill-paragraph)');
  const expected = [
    '% alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu',
    '% xi omicron pi rho sigma tau upsilon',
  ].join('\n');
  assert.equal(buffer.text, expected);
});

test('the new fill defcustoms have the intended defaults', async () => {
  const { ev } = await fillEditor();
  assert.equal(ev('*latex-fill-break-at-separators*'), true);
  assert.equal(ev('*latex-sentence-end-double-space*'), false);
});

// --- describe-key resolves through the mode chain --------------------------
// C-h k used to look only at the global keymap, so in a latex buffer it
// reported "M-q runs fill-paragraph" while the mode map's
// latex-fill-paragraph was what actually ran (live report 2026-07-02).

test('describe-key reports the mode binding that shadows the global (M-q)', async () => {
  const out = [];
  const buffer = createBuffer('some latex prose', { name: 'test.tex' });
  const interpreter = createInterpreter({
    write: (s) => out.push(String(s)),
    primitives: {
      ...createBufferPrimitives({ current: buffer }),
      'read-file-text!': () => NIL,
      'file-exists?': () => false,
      'list-directory-paths': () => NIL,
      'show-status!': () => NIL,
      'clear-status!': () => NIL,
      'load-doc-manifest!': () => NIL,
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'), {});
  const ev = (s) => interpreter.evaluate(s);
  ev('(set-major-mode! latex-mode)');
  ev('(describe-key)');
  ev('(handle-key "M-q")');
  assert.ok(out.join('\n').includes('M-q runs latex-fill-paragraph'),
    `C-h k resolves through the mode chain, got: ${out.join(' | ')}`);
});
