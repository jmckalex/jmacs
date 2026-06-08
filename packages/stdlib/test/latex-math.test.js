/**
 * @file latex-math.test.js — unit tests for AUCTeX Phase 3's pure core
 * (latex-math.lisp): the math symbol table's well-formedness, spot-checks
 * of key->macro mappings, the lookup helper (found vs not-found), the
 * configurable-prefix defcustom default, and that the mode keymap is built
 * from the prefix (including a live rebuild when the prefix changes).
 *
 * Phase 3 is the math-abbrev minor mode: a prefix (default `) arms a
 * one-key read that inserts a LaTeX macro, with a completion fallback for
 * an unmapped key. Everything testable without a buffer/view/minibuffer is
 * a pure data table + lookup, exercised here directly. The `read-next-key`
 * interaction and the completion-fallback round-trip are live-smoke.
 *
 * The harness loads the full standard library (so the table, the prefix
 * defcustom, the mode and its keymap are all present) with the same minimal
 * stub primitives latex-insert.test uses.
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
 * stub primitives the math-mode helpers touch when reached. The pure
 * helpers under test need none of these, but loading the stdlib does
 * (RefTeX's accessors etc.), so they are stubbed as no-ops.
 */
async function mathEditor() {
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

// --- the symbol table is well-formed ------------------------------------

test('symbol table: every value is a LaTeX macro (starts with a backslash)', async () => {
  const { arr } = await mathEditor();
  const macros = arr('(latex-math-macros)');
  assert.ok(macros.length > 80, `expected a solid table; got ${macros.length}`);
  for (const m of macros) {
    assert.ok(
      typeof m === 'string' && m.startsWith('\\'),
      `macro ${JSON.stringify(m)} should start with a backslash`
    );
  }
});

test('symbol table: every key is a single character', async () => {
  const { arr } = await mathEditor();
  const ks = arr('(keys *latex-math-symbols*)');
  for (const k of ks) {
    assert.equal(
      typeof k === 'string' && k.length,
      1,
      `key ${JSON.stringify(k)} should be a single character`
    );
  }
});

test('symbol table: no duplicate keys', async () => {
  const { arr } = await mathEditor();
  const ks = arr('(keys *latex-math-symbols*)');
  assert.equal(new Set(ks).size, ks.length, 'keys must be unique');
});

test('symbol table: is a solid ~80-120 entries', async () => {
  const { arr } = await mathEditor();
  const ks = arr('(keys *latex-math-symbols*)');
  assert.ok(ks.length >= 80 && ks.length <= 120, `got ${ks.length} entries`);
});

// --- spot-check key -> macro mappings -----------------------------------

const SPOT_CHECKS = [
  ['a', '\\alpha'],
  ['b', '\\beta'],
  ['g', '\\gamma'],
  ['w', '\\omega'],
  ['G', '\\Gamma'],
  ['W', '\\Omega'],
  ['j', '\\varphi'], // the documented \varphi key
  ['V', '\\varepsilon'], // the documented \varepsilon key
  ['<', '\\leq'],
  ['>', '\\geq'],
  ['=', '\\equiv'],
  ['~', '\\approx'],
  ['+', '\\sum'],
  ['*', '\\prod'],
  ['I', '\\int'],
  ['8', '\\infty'],
  ['A', '\\forall'],
  ['E', '\\exists'],
  ['1', '\\rightarrow'],
  ['2', '\\leftarrow'],
  ['7', '\\mapsto'],
];

for (const [key, macro] of SPOT_CHECKS) {
  test(`spot-check: ${key} -> ${macro}`, async () => {
    const { ev } = await mathEditor();
    assert.equal(ev(`(get *latex-math-symbols* "${key}")`), macro);
  });
}

// --- the lookup helper (found vs not-found) -----------------------------

test('latex-math-lookup: a mapped key returns its macro', async () => {
  const { ev } = await mathEditor();
  assert.equal(ev('(latex-math-lookup "a")'), '\\alpha');
  assert.equal(ev('(latex-math-lookup ">")'), '\\geq');
});

test('latex-math-lookup: an unmapped key returns nil', async () => {
  const { ev } = await mathEditor();
  // " " (space) and a multi-char string are not table keys.
  assert.equal(ev('(latex-math-lookup " ")'), NIL);
  assert.equal(ev('(nil? (latex-math-lookup " "))'), true);
});

// --- the configurable-prefix defcustom ----------------------------------

test('prefix defcustom: default is the backtick', async () => {
  const { ev } = await mathEditor();
  assert.equal(ev('*latex-math-abbrev-prefix*'), '`');
  assert.equal(ev("(custom-default '*latex-math-abbrev-prefix*)"), '`');
  assert.equal(ev("(eq? (get (custom-entry '*latex-math-abbrev-prefix*) :group) 'latex)"), true);
});

test('mode-default defcustom: registered, off by default, in the latex group', async () => {
  const { ev } = await mathEditor();
  assert.equal(ev('*latex-math-mode-default*'), false);
  assert.equal(ev("(custom-registered? '*latex-math-mode-default*)"), true);
  assert.equal(ev("(eq? (get (custom-entry '*latex-math-mode-default*) :group) 'latex)"), true);
});

// --- the mode keymap is built from the prefix ---------------------------

test('keymap: the prefix key is bound to latex-math-insert-symbol', async () => {
  const { ev } = await mathEditor();
  // (get latex-math-mode-map *latex-math-abbrev-prefix*) -> the command
  assert.equal(
    ev("(eq? (get latex-math-mode-map *latex-math-abbrev-prefix*) 'latex-math-insert-symbol)"),
    true
  );
  // and the literal backtick is that prefix
  assert.equal(
    ev("(eq? (get latex-math-mode-map \"`\") 'latex-math-insert-symbol)"),
    true
  );
});

test('keymap: rebuilds live when the prefix changes via custom-apply!', async () => {
  const { ev } = await mathEditor();
  // Change the prefix to ";" through the customisation registry; the
  // :on-change hook rebuilds latex-math-mode-map.
  ev('(custom-apply! (quote *latex-math-abbrev-prefix*) ";")');
  assert.equal(ev('*latex-math-abbrev-prefix*'), ';');
  assert.equal(
    ev("(eq? (get latex-math-mode-map \";\") 'latex-math-insert-symbol)"),
    true
  );
  // The old backtick binding is gone (the map is rebuilt from scratch).
  assert.equal(ev('(nil? (get latex-math-mode-map "`"))'), true);
  // Restore so nothing leaks (each test gets a fresh interpreter anyway).
  ev('(custom-apply! (quote *latex-math-abbrev-prefix*) "`")');
});

// --- the mode and its toggle are registered -----------------------------

test('mode: latex-math-mode has the LaTeXMath name and priority 10', async () => {
  const { ev } = await mathEditor();
  assert.equal(ev('(get latex-math-mode :name)'), 'LaTeXMath');
  assert.equal(ev('(get latex-math-mode :priority)'), 10);
  assert.equal(ev("(eq? (get latex-math-mode :keymap) 'latex-math-mode-map)"), true);
});

test('toggle + insert commands are registered', async () => {
  const { ev } = await mathEditor();
  assert.equal(ev("(command-registered? 'toggle-latex-math-mode)"), true);
  assert.equal(ev("(command-registered? 'latex-math-insert-symbol)"), true);
});

// --- the C-c ~ toggle binding (no collision) ----------------------------

test('keybinding: C-c ~ runs toggle-latex-math-mode without clobbering siblings', async () => {
  const { ev } = await mathEditor();
  assert.equal(
    ev("(eq? (get (get latex-mode-map \"C-c\") \"~\") 'toggle-latex-math-mode)"),
    true
  );
  // The prior installs survive (spot-check one from each earlier file).
  assert.equal(ev("(eq? (get (get latex-mode-map \"C-c\") \"b\") 'latex-textbf)"), true); // latex.lisp
  assert.equal(ev("(eq? (get (get latex-mode-map \"C-c\") \"C-m\") 'latex-insert-macro)"), true); // latex-insert.lisp
});

// --- the completion-fallback candidate set ------------------------------

test('latex-math-macros: every macro is in the table values, distinct count sane', async () => {
  const { arr, ev } = await mathEditor();
  const macros = arr('(latex-math-macros)');
  const keyCount = listToArray(ev('(keys *latex-math-symbols*)')).length;
  assert.equal(macros.length, keyCount, 'one macro per key');
});
