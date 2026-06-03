/**
 * @file latex-primitives.test.js — tests for the Lisp marshalling of
 * the LaTeX primitives: `latex-scan` returns a keyword-keyed hash-map
 * of record lists, and the path helpers return strings.
 *
 * These assert the *shape* the Lisp side consumes (a JS `Map` keyed by
 * interned `keyword`s, lists built with `arrayToList`), matching the
 * convention in `app.js`'s `listViewRecords`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keyword, NIL, listToArray, Pair } from '@editor/lisp';
import { createLatexPrimitives } from '../src/latex-primitives.js';

const prims = createLatexPrimitives();

/** Read a keyword slot out of a record map. */
const slot = (map, name) => map.get(keyword(name));

test('latex-scan returns a hash-map keyed by section keywords', () => {
  const result = prims['latex-scan'](['\\label{a}\n\\section{S}']);
  assert.ok(result instanceof Map);
  for (const key of ['labels', 'sections', 'refs', 'cites', 'index', 'inputs', 'bib']) {
    assert.ok(result.has(keyword(key)), `missing :${key}`);
  }
});

test('latex-scan label records carry keyword-keyed fields', () => {
  const result = prims['latex-scan'](['\\begin{equation}\\label{eq:1}\\end{equation}']);
  const labels = listToArray(slot(result, 'labels'));
  assert.equal(labels.length, 1);
  const rec = labels[0];
  assert.ok(rec instanceof Map);
  assert.equal(slot(rec, 'name'), 'eq:1');
  assert.equal(slot(rec, 'env'), 'equation');
  assert.equal(typeof slot(rec, 'line'), 'number');
  assert.equal(typeof slot(rec, 'col'), 'number');
});

test('a label with no enclosing environment has :env nil', () => {
  const result = prims['latex-scan'](['\\label{loose}']);
  const labels = listToArray(slot(result, 'labels'));
  assert.equal(slot(labels[0], 'env'), NIL);
});

test('cite :keys is itself a Lisp list', () => {
  const result = prims['latex-scan'](['\\cite{a,b,c}']);
  const cites = listToArray(slot(result, 'cites'));
  const keys = slot(cites[0], 'keys');
  assert.ok(keys instanceof Pair); // a non-empty proper list
  assert.deepEqual(listToArray(keys), ['a', 'b', 'c']);
});

test('bib :paths is a Lisp list', () => {
  const result = prims['latex-scan'](['\\bibliography{one,two}']);
  const bib = listToArray(slot(result, 'bib'));
  assert.deepEqual(listToArray(slot(bib[0], 'paths')), ['one', 'two']);
});

test('empty source yields empty (NIL) lists for every key', () => {
  const result = prims['latex-scan'](['']);
  for (const key of ['labels', 'sections', 'refs', 'cites', 'index', 'inputs', 'bib']) {
    assert.equal(slot(result, key), NIL, `:${key} should be NIL`);
  }
});

test('latex-scan tolerates a non-string argument', () => {
  const result = prims['latex-scan']([42]);
  assert.equal(slot(result, 'labels'), NIL);
});

test('path helpers return plain strings', () => {
  assert.equal(prims['path-dirname'](['/a/b/c.tex']), '/a/b');
  assert.equal(prims['path-basename'](['/a/b/c.tex']), 'c.tex');
  assert.equal(prims['path-resolve'](['/a/b', '../c.tex']), '/a/c.tex');
});

test('parse-latex-log returns keyword-keyed diagnostic records', () => {
  const log = [
    '(./paper.tex',
    '! Undefined control sequence.',
    'l.42 \\foo',
    'LaTeX Warning: Citation `x\' undefined.',
    ')',
  ].join('\n');
  const diags = listToArray(prims['parse-latex-log']([log]));
  assert.equal(diags.length, 2);

  const err = diags[0];
  assert.ok(err instanceof Map);
  assert.equal(slot(err, 'kind'), keyword('error'));
  assert.equal(slot(err, 'line'), 42);
  assert.equal(slot(err, 'file'), './paper.tex');
  assert.equal(slot(err, 'message'), 'Undefined control sequence');

  const warn = diags[1];
  assert.equal(slot(warn, 'kind'), keyword('warning'));
  assert.equal(slot(warn, 'line'), NIL); // no input-line tail
  assert.match(slot(warn, 'message'), /Citation `x'/);
});

test('parse-latex-log on a clean log yields NIL (empty list)', () => {
  assert.equal(prims['parse-latex-log'](['Output written on x.pdf.']), NIL);
  assert.equal(prims['parse-latex-log']([42]), NIL);
});
