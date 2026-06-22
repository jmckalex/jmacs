/**
 * @file Tests for the server-side citation host bridge (citation-bridge.js).
 *
 * These prove the `citation-*` host primitives resolve + work in a bare
 * Node process (no Electron, no DOM) — the import of the renderer's
 * citation.js + its vendored Citation.js bundle succeeds, a real BibTeX
 * entry parses to CSL-JSON, and formats to the expected CSL string. This
 * is the "bar" the brief sets: parse a real .bib, format entries.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keyword, NIL, listToArray } from '@editor/lisp';

import { createCitationPrimitives } from './citation-bridge.js';

const P = createCitationPrimitives();

/** Read a keyword slot from a Lisp record (a Map keyed by keywords). */
function slot(map, name) {
  return map.get(keyword(name));
}

/** Walk a Lisp cons list (head/tail cells) into a JS array, nil -> []. */
function listToArr(list) {
  return list === NIL ? [] : listToArray(list);
}

const SMITH =
  '@article{smith2020, author = {Smith, John}, title = {A Study of Things}, ' +
  'journal = {Journal of Testing}, year = {2020}, volume = {7}, pages = {1--10}}';

const TWO =
  SMITH +
  '\n@book{jones2018, author = {Jones, Mary}, title = {The Big Book}, ' +
  'publisher = {Test Press}, year = {2018}}';

test('citation-parse: a real BibTeX entry parses to a CSL-JSON handle', () => {
  const handle = P['citation-parse']([SMITH]);
  assert.equal(typeof handle, 'string');
  const data = JSON.parse(handle);
  assert.equal(data.length, 1);
  assert.equal(data[0].id, 'smith2020');
  assert.equal(data[0].title, 'A Study of Things');
  assert.equal(data[0].author[0].family, 'Smith');
});

test('citation-parse: empty source is the absence convention ("")', () => {
  assert.equal(P['citation-parse'](['']), '');
  assert.equal(P['citation-parse']([NIL]), '');
});

test('citation-format-bibliography: APA text matches the expected CSL string', () => {
  const handle = P['citation-parse']([SMITH]);
  const out = P['citation-format-bibliography']([handle, 'apa', 'text']);
  // The exact CSL/APA rendering of the entry.
  assert.equal(
    out.trim(),
    'Smith, J. (2020). A Study of Things. Journal of Testing, 7, 1–10.'
  );
});

test('citation-format-bibliography: default style is apa/text', () => {
  const handle = P['citation-parse']([SMITH]);
  const withDefaults = P['citation-format-bibliography']([handle]);
  const explicit = P['citation-format-bibliography']([handle, 'apa', 'text', 'en-US']);
  assert.equal(withDefaults, explicit);
});

test('citation-keys: returns the bib keys as a Lisp list', () => {
  const handle = P['citation-parse']([TWO]);
  const keys = listToArr(P['citation-keys']([handle]));
  assert.deepEqual(keys, ['smith2020', 'jones2018']);
});

test('citation-entries: projects to {:key :author :year :title} records', () => {
  const handle = P['citation-parse']([TWO]);
  const entries = listToArr(P['citation-entries']([handle]));
  assert.equal(entries.length, 2);
  assert.equal(slot(entries[0], 'key'), 'smith2020');
  assert.equal(slot(entries[0], 'author'), 'John Smith');
  assert.equal(slot(entries[0], 'year'), 2020);
  assert.equal(slot(entries[0], 'title'), 'A Study of Things');
  assert.equal(slot(entries[1], 'key'), 'jones2018');
});

test('citation-format-keys: formats only the requested subset, as {:key :html}', () => {
  const handle = P['citation-parse']([TWO]);
  const rows = listToArr(P['citation-format-keys']([handle, 'jones2018', 'apa']));
  assert.equal(rows.length, 1);
  assert.equal(slot(rows[0], 'key'), 'jones2018');
  const html = slot(rows[0], 'html');
  assert.equal(typeof html, 'string');
  assert.match(html, /Jones/);
  assert.match(html, /Big Book/);
});

test('citation-parse-lenient: clean input parses whole, skipped = 0', () => {
  const rec = P['citation-parse-lenient']([TWO]);
  assert.equal(slot(rec, 'skipped'), 0);
  const data = JSON.parse(slot(rec, 'handle'));
  assert.equal(data.length, 2);
});

test('citation-format: renders an in-text citation', () => {
  const handle = P['citation-parse']([SMITH]);
  const out = P['citation-format']([handle, 'apa', 'text']);
  assert.match(out, /Smith/);
  assert.match(out, /2020/);
});

test('citation-keys / citation-entries on empty input follow the absence convention', () => {
  assert.equal(P['citation-keys'](['']), NIL);
  assert.equal(P['citation-entries']([NIL]), NIL);
});
