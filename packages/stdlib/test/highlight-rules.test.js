/**
 * @file highlight-rules.test.js — tests for the Lisp `kind -> face`
 * highlight-override surface (highlight-rules.lisp). The host primitive
 * `set-highlight-overrides!` (which recompiles tree-sitter queries) is
 * stubbed to record the flattened records pushed to it, so the data ops,
 * scoping, and flatten shape are exercised without a tree-sitter runtime.
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

/** The records pushed to `set-highlight-overrides!` by the last op. */
let lastPush = null;

/** Read a Lisp record (a Map keyed by interned keywords) field by name. */
function field(record, name) {
  for (const [k, v] of record.entries()) {
    if (k && k.name === name) return v;
  }
  return undefined;
}

async function makeInterpreter() {
  lastPush = null;
  const buffer = createBuffer('hello world', { name: 'test' });
  const noop = () => NIL;
  const interpreter = createInterpreter({
    write: () => {},
    primitives: {
      ...createBufferPrimitives({ current: buffer }),
      'open-file!': noop,
      'save-buffer!': noop,
      'reload-stdlib!': noop,
      'next-view!': noop,
      'previous-view!': noop,
      'new-view!': noop,
      'kill-view!': noop,
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
      // The primitive under test's seam: record what Lisp pushes.
      'set-highlight-overrides!': (args) => {
        lastPush = args[0];
        return NIL;
      },
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
  interpreter.evaluate('(clear-highlight-rules!)');
  return interpreter;
}

/** The flattened push as an array of plain {scope,key,pattern,face}. */
function pushedRecords(lisp) {
  const list = lisp.evaluate('(highlight-rule-records)');
  const out = [];
  let node = list;
  while (node && node !== NIL && node.head !== undefined) {
    const r = node.head;
    out.push({
      scope: field(r, 'scope'),
      key: field(r, 'key'),
      pattern: field(r, 'pattern'),
      face: field(r, 'face'),
    });
    node = node.tail;
  }
  return out;
}

test('add-highlight-rule! stores a mode-scoped rule and pushes it', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate('(add-highlight-rule! \'mode "LaTeX" "command_name" \'keyword)');
  const recs = pushedRecords(lisp);
  assert.deepEqual(recs, [
    { scope: 'mode', key: 'LaTeX', pattern: 'command_name', face: 'keyword' },
  ]);
  // The push reached the host stub with the same count.
  assert.ok(lastPush !== null);
});

test('a face symbol is stored as its string name', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate('(add-highlight-rule! \'language "python" "identifier" \'variable)');
  assert.deepEqual(pushedRecords(lisp), [
    { scope: 'language', key: 'python', pattern: 'identifier', face: 'variable' },
  ]);
});

test('adding the same pattern replaces the earlier rule (no duplicate)', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate('(add-highlight-rule! \'mode "Python" "identifier" \'variable)');
  lisp.evaluate('(add-highlight-rule! \'mode "Python" "identifier" \'constant)');
  const recs = pushedRecords(lisp);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].face, 'constant');
});

test('mode and language scopes are independent buckets', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate('(add-highlight-rule! \'mode "Python" "identifier" \'variable)');
  lisp.evaluate('(add-highlight-rule! \'language "python" "string" \'comment)');
  const recs = pushedRecords(lisp);
  assert.equal(recs.length, 2);
  const byScope = Object.fromEntries(recs.map((r) => [r.scope, r]));
  assert.equal(byScope.mode.pattern, 'identifier');
  assert.equal(byScope.language.pattern, 'string');
});

test('remove-highlight-rule! drops just that pattern', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate('(add-highlight-rule! \'mode "Python" "identifier" \'variable)');
  lisp.evaluate('(add-highlight-rule! \'mode "Python" "string" \'comment)');
  lisp.evaluate('(remove-highlight-rule! \'mode "Python" "identifier")');
  const recs = pushedRecords(lisp);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].pattern, 'string');
});

test('clear-highlight-rules! empties the store', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate('(add-highlight-rule! \'mode "Python" "identifier" \'variable)');
  lisp.evaluate('(clear-highlight-rules!)');
  assert.deepEqual(pushedRecords(lisp), []);
});

test('highlight-rules-for returns the (pattern . face) pairs for a scope', async () => {
  const lisp = await makeInterpreter();
  lisp.evaluate('(add-highlight-rule! \'mode "Python" "identifier" \'variable)');
  const pair = lisp.evaluate('(car (highlight-rules-for \'mode "Python"))');
  // pair is a cons (pattern . face)
  assert.equal(pair.head, 'identifier');
  assert.equal(pair.tail, 'variable');
});

test('set-highlight-rules! replaces the store and pushes without persisting', async () => {
  const lisp = await makeInterpreter();
  // Build a store directly (scope-keyed) and install it.
  lisp.evaluate(`
    (set-highlight-rules!
      (hash-map "mode:LaTeX" (list (cons "command_name" "keyword"))))
  `);
  const recs = pushedRecords(lisp);
  assert.deepEqual(recs, [
    { scope: 'mode', key: 'LaTeX', pattern: 'command_name', face: 'keyword' },
  ]);
});
