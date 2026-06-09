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

import { createInterpreter, NIL, arrayToList, cons, keyword, listToArray } from '@editor/lisp';
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

// --- minibuffer-tab-complete: completions-panel routing ---------------
//
// Ambiguous TAB candidates now go to the scrollable completions panel
// (`show-completions!`) instead of the crammed inline status line; every
// branch that resolves or makes progress clears the panel
// (`clear-completions!`). The harness feeds a fixed directory listing and
// records which completion-UI primitive each TAB drives.

/** Interpreter with the full stdlib loaded over a fixed directory listing
 *  (ENTRIES: [name, 'file'|'directory'] pairs). Returns `ev` plus the
 *  ordered record of completion-UI primitive calls. */
async function tabCompleteEditor(entries) {
  const display = [];
  const dirList = arrayToList(
    entries.map(([name, type]) => cons(name, keyword(type)))
  );
  const interpreter = createInterpreter({
    write: () => {},
    primitives: {
      ...createLatexPrimitives(),
      'list-directory-paths': () => dirList,
      'home-directory': () => '/home/u',
      'file-exists?': () => false,
      'open-file-path!': () => NIL,
      'find-file-new!': () => NIL,
      'read-file-text!': () => NIL,
      'current-view': () => NIL,
      'view-list': () => NIL,
      'view-file-path': () => NIL,
      'view-buffer': () => NIL,
      'buffer-text': () => '',
      'open-completing-minibuffer!': () => NIL,
      'show-status!': (args) => { display.push(['status', String(args[0] ?? '')]); return NIL; },
      'clear-status!': () => { display.push(['clear-status']); return NIL; },
      'show-completions!': (args) => {
        // [names, directory] — directory is the prefix a panel click
        // rebuilds the full path from.
        display.push(['completions', listToArray(args[0] ?? NIL).map(String), String(args[1] ?? '')]);
        return NIL;
      },
      'clear-completions!': () => { display.push(['clear-completions']); return NIL; },
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'), {});
  return { ev: (s) => interpreter.evaluate(s), display };
}

/** The display strings the last `show-completions!` received, or null. */
const lastCompletions = (display) => {
  const rec = [...display].reverse().find((r) => r[0] === 'completions');
  return rec ? rec[1] : null;
};

test('-completion-names suffixes directories with a slash', async () => {
  const { ev } = await tabCompleteEditor([]);
  assert.deepEqual(
    listToArray(ev('(-completion-names (list (cons "a" :file) (cons "b" :directory)))')),
    ['a', 'b/']
  );
});

test('ambiguous candidates with no progress list in the completions panel', async () => {
  // basename "z" matches both; their LCP is "z" (== the typed basename) →
  // no inline progress, so the candidates go to the panel, directory
  // slashed, with the directory prefix passed for click-to-complete.
  const { ev, display } = await tabCompleteEditor([
    ['zebra', 'file'],
    ['zoo', 'directory'],
  ]);
  const result = ev('(minibuffer-tab-complete "/home/u/z")');
  assert.equal(result, '/home/u/z'); // value unchanged
  const rec = [...display].reverse().find((r) => r[0] === 'completions');
  assert.deepEqual(rec[1], ['zebra', 'zoo/']); // display names
  assert.equal(rec[2], '/home/u/'); // directory prefix for a click
  // It must NOT fall back to cramming the inline status with candidates.
  assert.ok(!display.some((r) => r[0] === 'status' && r[1] !== '(no matches)'));
});

test('a single match clears the panel and completes the value', async () => {
  const { ev, display } = await tabCompleteEditor([
    ['zebra', 'file'],
    ['zoo', 'directory'],
  ]);
  assert.equal(ev('(minibuffer-tab-complete "ze")'), 'zebra');
  assert.ok(display.some((r) => r[0] === 'clear-completions'));
  assert.equal(lastCompletions(display), null); // never opened
});

test('a single directory match completes with a trailing slash', async () => {
  const { ev } = await tabCompleteEditor([
    ['zebra', 'file'],
    ['zoo', 'directory'],
  ]);
  assert.equal(ev('(minibuffer-tab-complete "zo")'), 'zoo/');
});

test('LCP progress extends the value and clears the panel', async () => {
  // "zebra"/"zealot" share "ze" — longer than "z", so TAB extends inline
  // and removes any open panel rather than listing.
  const { ev, display } = await tabCompleteEditor([
    ['zebra', 'file'],
    ['zealot', 'file'],
  ]);
  assert.equal(ev('(minibuffer-tab-complete "z")'), 'ze');
  assert.ok(display.some((r) => r[0] === 'clear-completions'));
  assert.equal(lastCompletions(display), null);
});

test('no matches clears the panel and shows an inline note', async () => {
  const { ev, display } = await tabCompleteEditor([['zebra', 'file']]);
  assert.equal(ev('(minibuffer-tab-complete "q")'), 'q');
  assert.ok(display.some((r) => r[0] === 'clear-completions'));
  assert.ok(display.some((r) => r[0] === 'status' && r[1] === '(no matches)'));
  assert.equal(lastCompletions(display), null);
});
