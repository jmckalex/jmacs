/**
 * @file citation-format-entries.test.js — unit tests for the citation
 * picker's professional-formatting helpers: `splitBibliographyEntries`
 * (pure HTML splitter), `formatBibliographyEntries` (CSL → per-entry
 * HTML), and `registerCslStyle` (custom `.csl` registration).
 *
 * The splitter is tested against a hand-built blob (including the nested
 * divs Vancouver emits) so the balancing logic is exercised without the
 * engine; the formatter and registrar go through the vendored Citation.js
 * bundle against a small BibTeX fixture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCitations,
  splitBibliographyEntries,
  formatBibliographyEntries,
  registerCslStyle,
} from '../src/citation.js';

const BIB = `
@article{lee2021,
  author = {Lee, Jane and Smith, Bob},
  title = {A Theory of Everything},
  journal = {Journal of Physics},
  year = {2021}, volume = {12}, number = {3}, pages = {1--40}
}
@book{patel2020,
  author = {Patel, Riya}, title = {Foundations},
  publisher = {Springer}, year = {2020}
}`;

// --- splitBibliographyEntries (pure) ----------------------------------

test('splits a flat bibliography blob into per-key entries', () => {
  const html =
    '<div class="csl-bib-body">' +
    '<div data-csl-entry-id="a1" class="csl-entry">First <i>title</i>.</div>' +
    '<div data-csl-entry-id="b2" class="csl-entry">Second.</div>' +
    '</div>';
  assert.deepEqual(splitBibliographyEntries(html), [
    { key: 'a1', html: 'First <i>title</i>.' },
    { key: 'b2', html: 'Second.' },
  ]);
});

test('balances nested divs (Vancouver-style numbering)', () => {
  const html =
    '<div class="csl-bib-body">' +
    '<div data-csl-entry-id="lee2021" class="csl-entry">' +
    '<div class="csl-left-margin">1. </div>' +
    '<div class="csl-right-inline">Lee J. A Theory. 2021.</div>' +
    '</div>' +
    '<div data-csl-entry-id="patel2020" class="csl-entry">' +
    '<div class="csl-left-margin">2. </div>' +
    '<div class="csl-right-inline">Patel R. Foundations. 2020.</div>' +
    '</div>' +
    '</div>';
  const out = splitBibliographyEntries(html);
  assert.equal(out.length, 2);
  assert.equal(out[0].key, 'lee2021');
  assert.match(out[0].html, /csl-left-margin">1\. /);
  assert.match(out[0].html, /A Theory\. 2021\.<\/div>$/);
  assert.equal(out[1].key, 'patel2020');
  assert.match(out[1].html, /Patel R\./);
});

test('returns [] for empty / non-string input', () => {
  assert.deepEqual(splitBibliographyEntries(''), []);
  assert.deepEqual(splitBibliographyEntries(null), []);
  assert.deepEqual(splitBibliographyEntries('<div>no entries</div>'), []);
});

// --- formatBibliographyEntries (through Citation.js) -------------------

test('formats each entry to HTML, keyed, in order, with style markup', () => {
  const handle = parseCitations(BIB);
  const out = formatBibliographyEntries(handle, { style: 'harvard1' });
  assert.deepEqual(out.map((e) => e.key), ['lee2021', 'patel2020']);
  // Harvard italicises the journal / book title — proves CSL markup survives.
  assert.match(out[0].html, /<i>Journal of Physics<\/i>/);
  assert.match(out[0].html, /Lee, J\. and Smith, B\./);
  assert.match(out[1].html, /<i>Foundations<\/i>/);
});

test('a numbered style (vancouver) yields nested-div entry HTML', () => {
  const handle = parseCitations(BIB);
  const out = formatBibliographyEntries(handle, { style: 'vancouver' });
  assert.equal(out.length, 2);
  assert.match(out[0].html, /csl-right-inline/);
});

// --- registerCslStyle -------------------------------------------------

test('registers a custom CSL style and formats with its id', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="en-US">
  <info><title>Tiny Test</title><id>tiny-test-style</id><updated>2020-01-01T00:00:00+00:00</updated></info>
  <citation><layout><text variable="title"/></layout></citation>
  <bibliography><layout>
    <names variable="author"><name form="short"/></names>
    <text variable="title" font-style="italic" prefix=": "/>
  </layout></bibliography>
</style>`;
  const id = registerCslStyle(xml);
  assert.equal(id, 'tiny-test-style', 'returns the style’s own <id>');
  // Idempotent: registering again returns the same id, no throw.
  assert.equal(registerCslStyle(xml), 'tiny-test-style');
  const out = formatBibliographyEntries(parseCitations(BIB), { style: id });
  assert.match(out[0].html, /<i>A Theory of Everything<\/i>/);
});
