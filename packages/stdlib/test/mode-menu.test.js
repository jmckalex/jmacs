/**
 * @file mode-menu.test.js — the structured (nested) mode-menu mechanism
 * in menus.lisp: `register-mode-menu!`, `mode-menu-sections`, and the
 * host-friendly `mode-menu-sections-resolved`. Plus the LaTeX menu that
 * latex-menu.lisp registers, and the guarantee that a mode WITHOUT a
 * registration reports no sections (so the host keeps its flat menu).
 *
 * The harness loads the full standard library — so latex-menu.lisp has
 * run and registered the "LaTeX" menu — with a tiny stub for the
 * major-mode read/write primitives so a test can set the current mode.
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
 * An interpreter with the whole stdlib loaded. `buffer-major-mode` /
 * `set-major-mode!` are stubbed over a single mutable cell so a test can
 * switch the current major mode and observe `major-mode-name` /
 * `mode-menu-sections` follow it. The minor-mode reads return nil (no
 * minor modes), and `minor-mode-keymaps` therefore contributes nothing.
 */
async function menuEditor() {
  let majorMode = NIL;
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
      'buffer-major-mode': () => majorMode,
      'set-major-mode!': (args) => {
        majorMode = args[0];
        return NIL;
      },
      'buffer-minor-modes': () => NIL,
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'), {});
  const ev = (s) => interpreter.evaluate(s);
  return { interpreter, ev };
}

test('a mode with no registration reports nil sections (flat menu path)', async () => {
  const { ev } = await menuEditor();
  // fundamental-mode is a real mode that registers no structured menu.
  ev('(switch-major-mode fundamental-mode)');
  assert.equal(ev('(major-mode-name)'), 'Fundamental');
  assert.equal(ev('(nil? (mode-menu-sections))'), true);
  // The host-friendly accessor returns an EMPTY list (not nil) so the
  // host can branch on length and keep the flat menu.
  assert.equal(ev('(length (mode-menu-sections-resolved))'), 0);
});

test('markdown.lisp registers the Markdown structured menu', async () => {
  const { ev } = await menuEditor();
  ev('(switch-major-mode markdown-mode)');
  assert.equal(ev('(major-mode-name)'), 'Markdown');
  assert.equal(ev('(nil? (mode-menu-sections))'), false);
  const labels = listToArray(ev('(map car (mode-menu-sections))'));
  assert.deepEqual(labels, [
    'Format',
    'Insert',
    'Headings',
    'Blocks',
    'Preview & Math',
  ]);
  // The Headings section carries all six levels, resolved to strings.
  const resolved = listToArray(ev('(mode-menu-sections-resolved)'));
  const headings = listToArray(resolved[2]);
  assert.equal(headings[0], 'Headings');
  const headingCommands = headings.slice(1).map((leaf) => listToArray(leaf)[1]);
  assert.deepEqual(headingCommands, [
    'markdown-heading-1',
    'markdown-heading-2',
    'markdown-heading-3',
    'markdown-heading-4',
    'markdown-heading-5',
    'markdown-heading-6',
  ]);
});

test('latex-menu.lisp registers the LaTeX structured menu', async () => {
  const { ev } = await menuEditor();
  ev('(switch-major-mode latex-mode)');
  assert.equal(ev('(major-mode-name)'), 'LaTeX');
  // mode-menu-sections is non-nil and names the six sections in order.
  assert.equal(ev('(nil? (mode-menu-sections))'), false);
  const labels = listToArray(ev('(map car (mode-menu-sections))'));
  assert.deepEqual(labels, [
    'Compile & View',
    'Insert',
    'Fonts',
    'Math',
    'References',
    'Navigation',
  ]);
});

test('mode-menu-sections-resolved normalises leaves to all-strings lists', async () => {
  const { ev } = await menuEditor();
  ev('(switch-major-mode latex-mode)');
  const resolved = listToArray(ev('(mode-menu-sections-resolved)'));
  assert.equal(resolved.length, 6);
  // First section: ("Compile & View" ("Compile" "latex-compile") …)
  const first = listToArray(resolved[0]);
  assert.equal(first[0], 'Compile & View');
  const firstLeaf = listToArray(first[1]);
  assert.deepEqual(firstLeaf, ['Compile', 'latex-compile']);
  // The Fonts section carries the full AUCTeX font set (commands as
  // strings — the resolution to strings is what the host consumes).
  const fonts = listToArray(resolved[2]);
  assert.equal(fonts[0], 'Fonts');
  const fontCommands = fonts.slice(1).map((leaf) => listToArray(leaf)[1]);
  assert.deepEqual(fontCommands, [
    'latex-textbf',
    'latex-textit',
    'latex-emph',
    'latex-texttt',
    'latex-textsc',
    'latex-textsl',
    'latex-textrm',
    'latex-textsf',
    'latex-textmd',
  ]);
});

test('register-mode-menu! is generic — a fresh mode name registers', async () => {
  const { ev } = await menuEditor();
  // Register for a made-up display name and read it back by faking the
  // current mode's name via a one-off mode object.
  ev('(define -fake-mode {:name "FakeMode"})');
  ev('(switch-major-mode -fake-mode)');
  assert.equal(ev('(nil? (mode-menu-sections))'), true);
  ev("(register-mode-menu! \"FakeMode\" (list (cons \"S\" (list (cons \"L\" 'foo)))))");
  assert.equal(ev('(nil? (mode-menu-sections))'), false);
  const labels = listToArray(ev('(map car (mode-menu-sections))'));
  assert.deepEqual(labels, ['S']);
});
