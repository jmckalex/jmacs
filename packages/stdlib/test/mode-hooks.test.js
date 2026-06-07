/**
 * @file mode-hooks.test.js — Emacs-style additive mode hooks in
 * modes.lisp: `add-hook` / `remove-hook` and the `run-mode-hook` that
 * runs a mode's built-in :on-enable/:on-disable slot AND every
 * registered hook, in order, on major-mode switch.
 *
 * Harness: the full stdlib with `buffer-major-mode` / `set-major-mode!`
 * stubbed over a mutable cell so a test can switch the major mode and
 * watch the hooks fire (matches mode-menu.test.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, listToArray, NIL } from '@editor/lisp';
import { createLatexPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/** A fresh interpreter with the whole stdlib loaded and the major-mode
 *  primitives stubbed over a mutable cell. Also seeds a `*log*` list and
 *  a `noter` helper that appends a marker (so hook run-order is visible
 *  directly in `*log*`). */
async function hookEditor() {
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
  ev('(define *log* (list))');
  ev('(define (noter x) (lambda () (set! *log* (append *log* (list x)))))');
  return { interpreter, ev };
}

test('add-hook runs on entering a major mode', async () => {
  const { ev } = await hookEditor();
  ev('(add-hook markdown-mode (noter "entered"))');
  assert.deepEqual(listToArray(ev('*log*')), []); // not run until switched
  ev('(switch-major-mode markdown-mode)');
  assert.deepEqual(listToArray(ev('*log*')), ['entered']);
});

test('multiple hooks run in the order they were added', async () => {
  const { ev } = await hookEditor();
  ev('(add-hook markdown-mode (noter "first"))');
  ev('(add-hook markdown-mode (noter "second"))');
  ev('(switch-major-mode markdown-mode)');
  assert.deepEqual(listToArray(ev('*log*')), ['first', 'second']);
});

test('add-hook is idempotent for the same procedure object', async () => {
  const { ev } = await hookEditor();
  ev('(define h (noter "once"))');
  ev('(add-hook markdown-mode h)');
  ev('(add-hook markdown-mode h)');
  ev('(switch-major-mode markdown-mode)');
  assert.deepEqual(listToArray(ev('*log*')), ['once']);
});

test('remove-hook undoes add-hook', async () => {
  const { ev } = await hookEditor();
  ev('(define h (noter "x"))');
  ev('(add-hook markdown-mode h)');
  ev('(remove-hook markdown-mode h)');
  ev('(switch-major-mode markdown-mode)');
  assert.deepEqual(listToArray(ev('*log*')), []);
});

test(':on-disable hooks run when leaving the mode', async () => {
  const { ev } = await hookEditor();
  ev('(add-hook markdown-mode (noter "left") :on-disable)');
  ev('(switch-major-mode markdown-mode)'); // enter — no disable hook yet
  assert.deepEqual(listToArray(ev('*log*')), []);
  ev('(switch-major-mode lisp-mode)'); // leave markdown → its :on-disable
  assert.deepEqual(listToArray(ev('*log*')), ['left']);
});

test('a built-in :on-enable slot still runs, before add-hook hooks', async () => {
  const { ev } = await hookEditor();
  // A mode object carrying a built-in :on-enable, plus an added hook.
  ev(
    '(define probe-mode {:name "Probe" ' +
      ':on-enable (lambda () (set! *log* (append *log* (list "builtin"))))})'
  );
  ev('(add-hook probe-mode (noter "added"))');
  ev('(switch-major-mode probe-mode)');
  assert.deepEqual(listToArray(ev('*log*')), ['builtin', 'added']);
});

test('hooks can be keyed by display name as well as the mode object', async () => {
  const { ev } = await hookEditor();
  ev('(add-hook "Markdown" (noter "by-name"))');
  ev('(switch-major-mode markdown-mode)');
  assert.deepEqual(listToArray(ev('*log*')), ['by-name']);
});
