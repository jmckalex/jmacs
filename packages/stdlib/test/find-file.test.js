/**
 * @file find-file.test.js — `-find-file-deliver` routing (files.lisp).
 *
 * Emacs's C-x C-f opens an existing file and *creates* a buffer visiting a
 * path that doesn't exist yet (written on the first save). The deliver
 * handler routes accordingly: `open-file-path!` for an existing file,
 * `find-file-new!` for a missing one. We stub both host primitives to
 * record which fired, with `file-exists?` deciding the branch.
 *
 * The harness loads the whole standard library (so `files.lisp` and its
 * `-expand-tilde` helper are present) with the minimal stub primitives the
 * latex-nav suite uses, plus the three find-file primitives recorded here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, NIL } from '@editor/lisp';
import { createLatexPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/** Interpreter with the full stdlib loaded; EXISTING is the set of paths
 *  `file-exists?` reports true for. Returns the recorded open/new calls. */
async function findFileEditor(existing) {
  const calls = [];
  const interpreter = createInterpreter({
    write: () => {},
    primitives: {
      ...createLatexPrimitives(),
      'file-exists?': (args) => existing.includes(String(args[0])),
      'open-file-path!': (args) => { calls.push(['open', String(args[0])]); return NIL; },
      'find-file-new!': (args) => { calls.push(['new', String(args[0])]); return NIL; },
      'read-file-text!': () => NIL,
      'list-directory-paths': () => NIL,
      'current-view': () => NIL,
      'view-list': () => NIL,
      'view-file-path': () => NIL,
      'view-buffer': () => NIL,
      'buffer-text': () => '',
      'home-directory': () => '/home/u',
      'open-completing-minibuffer!': () => NIL,
      'show-status!': () => NIL,
      'clear-status!': () => NIL,
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'), {});
  return { ev: (s) => interpreter.evaluate(s), calls };
}

test('-find-file-deliver opens an existing file via open-file-path!', async () => {
  const { ev, calls } = await findFileEditor(['/home/u/exists.txt']);
  ev('(-find-file-deliver "/home/u/exists.txt")');
  assert.deepEqual(calls, [['open', '/home/u/exists.txt']]);
});

test('-find-file-deliver creates a new buffer for a missing path', async () => {
  const { ev, calls } = await findFileEditor([]);
  ev('(-find-file-deliver "/home/u/new.txt")');
  assert.deepEqual(calls, [['new', '/home/u/new.txt']]);
});

test('-find-file-deliver ignores empty / nil input', async () => {
  const { ev, calls } = await findFileEditor([]);
  ev('(-find-file-deliver "")');
  ev('(-find-file-deliver nil)');
  assert.deepEqual(calls, []);
});
