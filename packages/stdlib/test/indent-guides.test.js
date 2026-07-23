/**
 * @file indent-guides.test.js — the per-buffer indent-guide policy in
 * modes.lisp: `indent-guides-active?` resolves the buffer's own override
 * (the `buffer-indent-guides` / `set-indent-guides!` primitives, real
 * here) over the major mode's :indent-guides property, defaulting on.
 * The Markdown modes ship the property off; `toggle-indent-guides`
 * flips a sticky per-buffer override; `indent-guides-off` is the
 * mode-hook helper.
 *
 * Harness: the full stdlib (languages included, for jmarkdown-mode)
 * over a REAL L2 buffer + the real buffer primitives, so the override
 * slot lives where it does in the spine — on the buffer object.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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
const languagesDir = join(lispDir, 'languages');

/** A fresh interpreter over a real buffer, whole stdlib loaded. */
async function guidesEditor() {
  const buffer = createBuffer('hello', { name: 'test' });
  const statusCalls = [];
  const interpreter = createInterpreter({
    write: () => {},
    primitives: {
      ...createLatexPrimitives(),
      ...createBufferPrimitives({ current: buffer }),
      'read-file-text!': () => NIL,
      'file-exists?': () => false,
      'list-directory-paths': () => NIL,
      'current-view': () => NIL,
      'view-list': () => NIL,
      'view-file-path': () => NIL,
      'view-buffer': () => NIL,
      'show-status!': (args) => {
        statusCalls.push(String(args[0] ?? ''));
        return NIL;
      },
      'clear-status!': () => NIL,
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
  const ev = (s) => interpreter.evaluate(s);
  return { buffer, ev, statusCalls };
}

test('guides default on with no override and no mode opinion', async () => {
  const { ev } = await guidesEditor();
  assert.equal(ev('(nil? (buffer-indent-guides))'), true);
  assert.equal(ev('(indent-guides-active?)'), true);
  ev('(switch-major-mode lisp-mode)');
  assert.equal(ev('(indent-guides-active?)'), true);
});

test('markdown-mode and jmarkdown-mode ship :indent-guides off', async () => {
  const { ev } = await guidesEditor();
  ev('(switch-major-mode markdown-mode)');
  assert.equal(ev('(indent-guides-active?)'), false);
  ev('(switch-major-mode jmarkdown-mode)');
  assert.equal(ev('(indent-guides-active?)'), false);
  // The property, not a buffer override: the buffer slot is still unset.
  assert.equal(ev('(nil? (buffer-indent-guides))'), true);
});

test('toggle-indent-guides overrides the mode default, both ways', async () => {
  const { ev, statusCalls } = await guidesEditor();
  ev('(switch-major-mode markdown-mode)');
  ev('(toggle-indent-guides)');
  assert.equal(ev('(indent-guides-active?)'), true);
  ev('(toggle-indent-guides)');
  assert.equal(ev('(indent-guides-active?)'), false);
  assert.deepEqual(statusCalls, ['Indent guides on', 'Indent guides off']);
});

test('the override sticks to the buffer across a mode re-derive', async () => {
  const { ev } = await guidesEditor();
  ev('(switch-major-mode markdown-mode)');
  ev('(toggle-indent-guides)');
  assert.equal(ev('(indent-guides-active?)'), true);
  // The spine re-runs choose-major-mode constantly (background modeline
  // reads); the override must survive, unlike minor-mode state.
  ev('(switch-major-mode markdown-mode)');
  assert.equal(ev('(indent-guides-active?)'), true);
});

test('set-indent-guides! nil clears the override back to the mode default', async () => {
  const { ev } = await guidesEditor();
  ev('(switch-major-mode markdown-mode)');
  ev('(indent-guides-on)');
  assert.equal(ev('(indent-guides-active?)'), true);
  ev('(set-indent-guides! nil)');
  assert.equal(ev('(nil? (buffer-indent-guides))'), true);
  assert.equal(ev('(indent-guides-active?)'), false);
});

test('indent-guides-off works as a mode-hook helper', async () => {
  const { ev } = await guidesEditor();
  ev('(add-hook lisp-mode (lambda () (indent-guides-off)))');
  ev('(switch-major-mode lisp-mode)');
  assert.equal(ev('(indent-guides-active?)'), false);
  // Re-entering the mode re-runs the hook; idempotent.
  ev('(switch-major-mode lisp-mode)');
  assert.equal(ev('(indent-guides-active?)'), false);
});
