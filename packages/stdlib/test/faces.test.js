/**
 * @file faces.test.js — tests for the face system, focused on
 * inheritance (`from PARENT`) added on the `agent-face-inheritance`
 * branch. Loads the full stdlib so all 13 built-in faces are present
 * via `defface`; new test-only faces are declared inside each test
 * with `interpreter.evaluate` to keep cases isolated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import { createInterpreter, NIL } from '@editor/lisp';
import { createBufferPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');
const languagesDir = join(lispDir, 'languages');

/**
 * A minimal stdlib-loaded interpreter. The full set of host primitives
 * the standard library expects are stubbed as no-ops; faces only needs
 * `apply-face-styles!` to be present.
 */
async function makeInterpreter() {
  const buffer = createBuffer('hello world', { name: 'test' });
  const noop = () => NIL;
  const interpreter = createInterpreter({
    write: () => {},
    primitives: {
      ...createBufferPrimitives({ current: buffer }),
      'open-file!': noop,
      'save-buffer!': noop,
      'reload-stdlib!': noop,
      'next-buffer!': noop,
      'previous-buffer!': noop,
      'new-buffer!': noop,
      'kill-buffer!': noop,
      'start-buffer-switcher!': noop,
      'start-search!': noop,
      'start-search-backward!': noop,
      'start-command-palette!': noop,
      'start-describe-command!': noop,
      'open-minibuffer!': noop,
      'goto-line!': noop,
      'replace-all!': noop,
      'recenter!': noop,
      'page-lines': () => 3,
      'toggle-repl!': noop,
      'markdown-preview!': noop,
      'quit-editor!': noop,
      'note-create!': () => 'note-1',
      'note-edit!': noop,
      'note-delete!': noop,
      'note-at-point': () => 'note-1',
      'note-next!': noop,
      'note-prev!': noop,
      'notes-toggle!': noop,
      'write-custom-file!': noop,
      'apply-theme!': noop,
      'apply-face-styles!': noop,
      'load-doc-manifest!': noop,
      'open-doc!': noop,
      'open-docstring-page!': noop,
      'start-doc-search!': noop,
      'form-bounds-at-point!': noop,
      'form-bounds-before-point!': noop,
      'eval-region!': noop,
      'show-eval-log!': noop,
    },
  });
  await loadStdlib(
    interpreter,
    (name) => readFile(join(lispDir, name), 'utf8'),
    {
      listLanguageFiles: async () =>
        (await readdir(languagesDir)).filter((n) => n.endsWith('.lisp')),
    }
  );
  // Every test starts from a clean overrides slate so per-test mutations
  // do not bleed across cases.
  interpreter.evaluate('(reset-all-faces)');
  return interpreter;
}

test('a face with no parent has no inherited attributes', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate(`
    (defface 'orphan
      :doc "no parent."
      :default-dark (face :foreground "#aaa"))
  `);
  assert.equal(lisp.evaluate(`(face-attribute 'orphan :foreground :theme 'dark)`), '#aaa');
  assert.equal(lisp.evaluate(`(face-attribute 'orphan :weight :theme 'dark)`), NIL);
});

test('parent attributes propagate to child where child does not override', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate(`
    (defface 'p-base
      :doc "the parent."
      :default-dark (face :foreground "#268bd2" :underline true :weight :bold))
    (defface 'p-child from 'p-base
      :doc "the child."
      :default-dark (face :foreground "#6c71c4"))
  `);
  // Child overrides foreground but inherits underline and weight.
  assert.equal(lisp.evaluate(`(face-attribute 'p-child :foreground :theme 'dark)`), '#6c71c4');
  assert.equal(lisp.evaluate(`(face-attribute 'p-child :underline :theme 'dark)`), true);
  const weight = lisp.evaluate(`(face-attribute 'p-child :weight :theme 'dark)`);
  assert.equal(weight && weight.name, 'bold');
});

test('child attributes win over parent on the same key', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate(`
    (defface 'a-parent :default-dark (face :foreground "#111" :weight :bold))
    (defface 'a-child from 'a-parent :default-dark (face :foreground "#222"))
  `);
  assert.equal(lisp.evaluate(`(face-attribute 'a-child :foreground :theme 'dark)`), '#222');
});

test('multi-level chain (A from B from C) resolves bottom-up', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate(`
    (defface 'gc :default-dark (face :foreground "#c00" :underline true :weight :bold))
    (defface 'gb from 'gc :default-dark (face :foreground "#0c0"))
    (defface 'ga from 'gb :default-dark (face :weight :normal))
  `);
  // foreground: ga has none -> gb's #0c0 (gb overrode gc's #c00).
  assert.equal(lisp.evaluate(`(face-attribute 'ga :foreground :theme 'dark)`), '#0c0');
  // underline: only gc declared it -> propagates all the way down.
  assert.equal(lisp.evaluate(`(face-attribute 'ga :underline :theme 'dark)`), true);
  // weight: ga overrode gc's :bold with :normal.
  const weight = lisp.evaluate(`(face-attribute 'ga :weight :theme 'dark)`);
  assert.equal(weight && weight.name, 'normal');
});

test('a cycle (A from B, B from A) is detected with a clear error', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate(`
    (defface 'cyc-a from 'cyc-b :default-dark (face :foreground "#111"))
    (defface 'cyc-b from 'cyc-a :default-dark (face :foreground "#222"))
  `);
  assert.throws(
    () => lisp.evaluate(`(face-attribute 'cyc-a :foreground :theme 'dark)`),
    (err) => /face inheritance cycle/.test(String(err.message))
      && /cyc-a/.test(String(err.message))
      && /cyc-b/.test(String(err.message))
  );
});

test('a self-cycle (A from A) is detected', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate(`
    (defface 'self-cyc from 'self-cyc :default-dark (face :foreground "#abc"))
  `);
  assert.throws(
    () => lisp.evaluate(`(face-attribute 'self-cyc :foreground :theme 'dark)`),
    /face inheritance cycle/
  );
});

test('user override on a child wins over inherited attributes', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate(`
    (defface 'uo-parent :default-dark (face :foreground "#111" :weight :bold))
    (defface 'uo-child from 'uo-parent :default-dark (face :foreground "#222"))
    (set-face-attribute 'uo-child :foreground "#333" :theme 'dark)
  `);
  assert.equal(lisp.evaluate(`(face-attribute 'uo-child :foreground :theme 'dark)`), '#333');
  // The inherited :weight from the parent still flows through.
  const weight = lisp.evaluate(`(face-attribute 'uo-child :weight :theme 'dark)`);
  assert.equal(weight && weight.name, 'bold');
});

test('user override on parent flows down to children that do not override', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate(`
    (defface 'flow-parent :default-dark (face :foreground "#111" :weight :bold))
    (defface 'flow-child from 'flow-parent :default-dark (face :foreground "#222"))
    ;; Override only the parent's weight; child inherits the new weight.
    (set-face-attribute 'flow-parent :weight :normal :theme 'dark)
  `);
  const weight = lisp.evaluate(`(face-attribute 'flow-child :weight :theme 'dark)`);
  assert.equal(weight && weight.name, 'normal');
  // Child's own foreground still wins.
  assert.equal(lisp.evaluate(`(face-attribute 'flow-child :foreground :theme 'dark)`), '#222');
});

test('parent declared at a different theme than child still composes per-theme', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate(`
    ;; Parent declares only :default-light; child declares only :default-dark.
    (defface 'theme-mix-p :default-light (face :foreground "#abc"))
    (defface 'theme-mix-c from 'theme-mix-p :default-dark (face :weight :bold))
  `);
  // Under light: parent contributes foreground, child contributes nothing
  // — so child's foreground inherits from parent.
  assert.equal(lisp.evaluate(`(face-attribute 'theme-mix-c :foreground :theme 'light)`), '#abc');
  // Under dark: parent's :default-light is not used; parent's :default-dark
  // is {} (the fallback for an unset theme map). Child's :weight wins.
  const weight = lisp.evaluate(`(face-attribute 'theme-mix-c :weight :theme 'dark)`);
  assert.equal(weight && weight.name, 'bold');
});

test('a face with `from` records its parent in the registry', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate(`
    (defface 'reg-p :default-dark (face :foreground "#abc"))
    (defface 'reg-c from 'reg-p :default-dark (face :weight :bold))
  `);
  const parent = lisp.evaluate(`(face-parent 'reg-c)`);
  assert.equal(parent && parent.name, 'reg-p');
  assert.equal(lisp.evaluate(`(face-parent 'reg-p)`), NIL);
});

test('a face declared without `from` still works (no regression)', async () => {
  const lisp = await makeInterpreter();
  // The 13 built-in faces are all declared without `from`. Spot-check one.
  assert.equal(lisp.evaluate(`(face-attribute 'comment :foreground :theme 'dark)`), '#7c8f9e');
  const slant = lisp.evaluate(`(face-attribute 'comment :slant :theme 'dark)`);
  assert.equal(slant && slant.name, 'italic');
});
