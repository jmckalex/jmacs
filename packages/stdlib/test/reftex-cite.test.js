/**
 * @file reftex-cite.test.js — unit tests for RefTeX R3 (citations),
 * reftex-cite.lisp.
 *
 * The harness loads the whole standard library (so reftex.lisp /
 * reftex-refs.lisp / reftex-cite.lisp and their helpers are present) and
 * stubs the host primitives the cite flow touches over a tiny in-memory
 * model that records what was opened and inserted. The pure row/field
 * helpers and the style resolver are tested directly; the command flow
 * (format menu → cite picker → insert) is driven end to end with the
 * panel openers stubbed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, arrayToList, listToArray, NIL, keyword } from '@editor/lisp';
import { createLatexPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/** A CSL-JSON-ish entry record {:key :author :year :title}. */
function entry({ key, author, year, title }) {
  const m = new Map();
  m.set(keyword('key'), key);
  m.set(keyword('author'), author ?? NIL);
  m.set(keyword('year'), year ?? NIL);
  m.set(keyword('title'), title ?? NIL);
  return m;
}

/** A formatted-entry record {:key :html}. */
function formatted(key, html) {
  const m = new Map();
  m.set(keyword('key'), key);
  m.set(keyword('html'), html);
  return m;
}

/** An interpreter with the full stdlib and a recording host model. */
async function citeEditor(model = {}) {
  const rec = { opened: [], inserted: [], status: [], switched: [], gotos: [] };
  let interp;
  const primitives = {
    ...createLatexPrimitives(),
    // citation bridge — return the fixtures the test provides.
    'citation-parse': () => model.handle ?? NIL,
    'citation-entries': () =>
      arrayToList((model.entries ?? []).map((e) => entry(e))),
    'citation-format-entries': () =>
      arrayToList((model.formatted ?? []).map((f) => formatted(f[0], f[1]))),
    'citation-register-style!': (a) => model.registeredId ?? String(a[0] ?? ''),
    // The parsed bib is provided directly as a {:handle :skipped} record
    // (bypassing the full R1 DB walk, which the tiny model doesn't
    // populate). nil when the model gives no handle.
    'cite-parsed-fixture': () => {
      if (model.handle == null || model.handle === NIL) return NIL;
      const m = new Map();
      m.set(keyword('handle'), model.handle);
      m.set(keyword('skipped'), model.skipped ?? 0);
      return m;
    },
    // bottom panel openers — recorded.
    'open-reftex-cite-format!': () => { rec.opened.push('format'); return NIL; },
    'open-reftex-cite-select!': () => { rec.opened.push('select'); return NIL; },
    'open-reftex-select!': () => { rec.opened.push('ref-select'); return NIL; },
    'open-completing-minibuffer!': () => NIL,
    'open-reftex-toc!': () => NIL,
    // file / buffer / view verbs.
    'file-exists?': (a) => (model.fileExists ? model.fileExists(String(a[0])) : true),
    'read-file-text!': (a) => (model.readFile ? model.readFile(String(a[0])) : NIL),
    'list-directory-paths': () => NIL,
    'current-view': () => model.currentView ?? NIL,
    'switch-to-view!': (a) => { rec.switched.push(a[0]); return a[0] ?? NIL; },
    'view-buffer': () => NIL,
    'buffer-text': () => model.bufferText ?? '',
    'view-file-path': () => NIL,
    'point': () => model.point ?? 0,
    'goto!': (a) => { rec.gotos.push(Number(a[0])); return NIL; },
    'insert!': (a) => { rec.inserted.push(String(a[0])); return NIL; },
    'show-status!': (a) => { rec.status.push(String(a[0])); return NIL; },
    'clear-status!': () => NIL,
  };
  interp = createInterpreter({ write: () => {}, primitives });
  await loadStdlib(interp, (name) => readFile(join(lispDir, name), 'utf8'), {});
  // Bypass the R1 DB walk: the cite flow's only dependency on it is the
  // parsed bib record, which the model supplies via `cite-parsed-fixture`.
  interp.evaluate('(define (-reftex-cite-parsed) (cite-parsed-fixture))');
  return { rec, interp, ev: (src) => interp.evaluate(src) };
}

// --- pure helpers -----------------------------------------------------

test('reftex-cite-formats returns the default format list', async () => {
  const { ev } = await citeEditor();
  const macros = listToArray(ev('(map (lambda (r) (cadr r)) (reftex-cite-formats))'));
  assert.deepEqual(macros, [
    '\\cite', '\\citep', '\\citet', '\\parencite', '\\textcite',
    '\\citeauthor', '\\citeyear',
  ]);
});

test('-reftex-cite-plain joins key/author/year/title, skipping nils', async () => {
  const { ev } = await citeEditor();
  const plain = ev(
    '(-reftex-cite-plain (hash-map :key "lee2021" :author "Jane Lee" ' +
    ':year 2021 :title "A Theory"))'
  );
  assert.equal(plain, 'lee2021 Jane Lee 2021 A Theory');
  const sparse = ev(
    '(-reftex-cite-plain (hash-map :key "x" :author nil :year nil :title nil))'
  );
  assert.equal(sparse, 'x');
});

test('-reftex-cite-row zips an entry record with its formatted html', async () => {
  const { ev } = await citeEditor();
  const row = listToArray(ev(
    '(-reftex-cite-row (hash-map :key "k" :author "A" :year 2020 :title "T") ' +
    '(hash-map :key "k" :html "<i>T</i>"))'
  ));
  // (key html plain)
  assert.deepEqual(row, ['k', '<i>T</i>', 'k A 2020 T']);
});

// --- style resolution -------------------------------------------------

test('-reftex-cite-template passes a built-in id through', async () => {
  const { ev } = await citeEditor();
  ev('(set! *reftex-cite-style* "harvard1")');
  assert.equal(ev('(-reftex-cite-template)'), 'harvard1');
});

test('-reftex-cite-template registers a .csl file and returns its id', async () => {
  const { ev } = await citeEditor({
    fileExists: (p) => p.endsWith('.csl'),
    readFile: () => '<style><info><id>my-style</id></info></style>',
    registeredId: 'my-style',
  });
  ev('(set! *reftex-cite-style* "/refs/chicago.csl")');
  assert.equal(ev('(-reftex-cite-template)'), 'my-style');
});

// --- the flow ---------------------------------------------------------

test('reftex-citation builds rows and opens the format menu first', async () => {
  const { rec, ev } = await citeEditor({
    handle: '[]',
    entries: [
      { key: 'lee2021', author: 'Jane Lee', year: 2021, title: 'A Theory' },
      { key: 'patel2020', author: 'Riya Patel', year: 2020, title: 'Foundations' },
    ],
    formatted: [
      ['lee2021', 'Lee, J. (2021) ...'],
      ['patel2020', 'Patel, R. (2020) ...'],
    ],
  });
  ev('(reftex-citation)');
  assert.deepEqual(rec.opened, ['format'], 'format menu opens first, not the picker');
  // Rows were prepared for the picker.
  const rows = listToArray(ev('(reftex-cite-select-rows)'));
  assert.equal(rows.length, 2, 'two rows prepared');
});

test('format choice swaps to the picker; RET inserts <macro>{keys} at origin', async () => {
  const view = { kind: 'text' };
  const { rec, ev } = await citeEditor({
    handle: '[]',
    entries: [{ key: 'lee2021', author: 'Lee', year: 2021, title: 'T' }],
    formatted: [['lee2021', 'Lee (2021)']],
    currentView: view,
    point: 42,
  });
  ev('(reftex-citation)');
  ev('(reftex-cite-format-chosen "\\\\citep")');
  assert.deepEqual(rec.opened, ['format', 'select'], 'picker opens after format chosen');
  ev('(reftex-cite-insert "lee2021,patel2020")');
  assert.deepEqual(rec.inserted, ['\\citep{lee2021,patel2020}']);
});

test('reftex-citation reports skipped (unparseable) entries', async () => {
  const { rec, ev } = await citeEditor({
    handle: '[]',
    skipped: 2,
    entries: [{ key: 'a', author: 'A', year: 2000, title: 'T' }],
    formatted: [['a', 'A (2000)']],
  });
  ev('(reftex-citation)');
  assert.ok(
    rec.status.some((s) => /skipped 2 unparseable bib entries/.test(s)),
    'echoes how many entries were skipped'
  );
  assert.deepEqual(rec.opened, ['format'], 'still opens the picker for the rest');
});

test('reftex-citation with no bibliography is a no-op with a status', async () => {
  const { rec, ev } = await citeEditor({ handle: NIL });
  ev('(reftex-citation)');
  assert.deepEqual(rec.opened, [], 'nothing opens');
  assert.ok(
    rec.status.some((s) => /no bibliography/i.test(s)),
    'echoes a no-bibliography status'
  );
});

test('an empty selection inserts nothing', async () => {
  const { rec, ev } = await citeEditor({
    handle: '[]',
    entries: [{ key: 'a', author: 'A', year: 2000, title: 'T' }],
    formatted: [['a', 'A (2000)']],
  });
  ev('(reftex-citation)');
  ev('(reftex-cite-format-chosen "\\\\cite")');
  ev('(reftex-cite-insert "")');
  assert.deepEqual(rec.inserted, [], 'no insert for an empty key list');
});
