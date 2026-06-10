/**
 * @file load-isolation.test.js — `loadStdlib` must isolate each file.
 *
 * A single broken Lisp file (syntax error, unbound reference) used to
 * abort the whole standard library, leaving the editor with no commands
 * and a dead keymap. The loader now wraps each file: a failure is
 * recorded and loading continues. These tests pin that down with a fake
 * interpreter and source fetcher, so the isolation logic is exercised
 * without the real interpreter or the filesystem.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STDLIB_FILES, loadStdlib } from '../src/index.js';

/**
 * A fake interpreter whose `evaluate` records the source it was given and
 * throws for any source in `badSources`. The source for a file is just
 * its name (see `getSource` below), so `badSources` is a set of names.
 */
function makeFakeInterpreter(badSources = new Set()) {
  const evaluated = [];
  return {
    evaluated,
    evaluate(source) {
      if (badSources.has(source)) {
        throw new Error(`boom: ${source}`);
      }
      evaluated.push(source);
      return null;
    },
  };
}

/** Source-for-name is just the name — keeps the fake interpreter simple. */
const getSource = (name) => name;

test('happy path: every file loads, no failures', async () => {
  const interp = makeFakeInterpreter();
  const { failures } = await loadStdlib(interp, getSource);
  assert.equal(failures.length, 0);
  assert.deepEqual(interp.evaluated, [...STDLIB_FILES]);
});

test('a broken file is recorded and does not abort the rest', async () => {
  // Pick a file that is NOT last, so there is a file after it to prove
  // loading continued.
  const broken = 'keymap.lisp';
  const idx = STDLIB_FILES.indexOf(broken);
  assert.ok(idx >= 0 && idx < STDLIB_FILES.length - 1, 'broken file has successors');

  const interp = makeFakeInterpreter(new Set([broken]));
  const { failures } = await loadStdlib(interp, getSource);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, broken);
  assert.equal(failures[0].phase, 'evaluate');
  assert.match(failures[0].error.message, /boom/);

  // The broken file was skipped, but everything else loaded — including
  // the files that come after it.
  assert.ok(!interp.evaluated.includes(broken), 'broken file not recorded as loaded');
  assert.equal(interp.evaluated.length, STDLIB_FILES.length - 1);
  assert.ok(
    interp.evaluated.includes(STDLIB_FILES[idx + 1]),
    'the file after the broken one still loaded'
  );
});

test('multiple broken files are all reported, in attempt order', async () => {
  const bad = ['custom.lisp', 'snippets.lisp'];
  const interp = makeFakeInterpreter(new Set(bad));
  const { failures } = await loadStdlib(interp, getSource);
  assert.deepEqual(failures.map((f) => f.name), bad
    .slice()
    .sort((a, b) => STDLIB_FILES.indexOf(a) - STDLIB_FILES.indexOf(b)));
  assert.equal(interp.evaluated.length, STDLIB_FILES.length - bad.length);
});

test('a fetch failure is isolated with phase "fetch"', async () => {
  const interp = makeFakeInterpreter();
  const failingFetch = async (name) => {
    if (name === 'files.lisp') throw new Error('ENOENT files.lisp');
    return name;
  };
  const { failures } = await loadStdlib(interp, failingFetch);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, 'files.lisp');
  assert.equal(failures[0].phase, 'fetch');
  assert.ok(!interp.evaluated.includes('files.lisp'));
  // The rest still loaded.
  assert.equal(interp.evaluated.length, STDLIB_FILES.length - 1);
});

test('language files load after the ordered set and are isolated too', async () => {
  const interp = makeFakeInterpreter(new Set(['languages/bad.lisp']));
  const { failures } = await loadStdlib(interp, getSource, {
    listLanguageFiles: () => ['good.lisp', 'bad.lisp', 'notes.txt'],
  });
  // The non-.lisp entry is ignored; bad.lisp fails; good.lisp loads.
  assert.deepEqual(failures.map((f) => f.name), ['languages/bad.lisp']);
  assert.ok(interp.evaluated.includes('languages/good.lisp'));
  assert.ok(!interp.evaluated.includes('languages/notes.txt'));
});

test('a thrown language lister is isolated, ordered set still loads', async () => {
  const interp = makeFakeInterpreter();
  const { failures } = await loadStdlib(interp, getSource, {
    listLanguageFiles: () => {
      throw new Error('cannot list languages dir');
    },
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].phase, 'list');
  // The whole ordered standard library still loaded despite the lister
  // blowing up.
  assert.deepEqual(interp.evaluated, [...STDLIB_FILES]);
});
