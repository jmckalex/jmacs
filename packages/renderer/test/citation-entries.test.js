/**
 * @file citation-entries.test.js — unit tests for `citationEntries`,
 * the CSL-JSON → picker-row projection used by the citation picker.
 *
 * The handle is the JSON string `parseCitations` produces (CSL-JSON).
 * These tests build that string directly rather than going through
 * Citation.js, so they exercise the projection in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { citationEntries } from '../src/citation.js';

/** Build a CSL-JSON handle string from entry objects. */
const handle = (...entries) => JSON.stringify(entries);

test('projects key, author family, year, and title', () => {
  const result = citationEntries(
    handle({
      id: 'smith2020',
      author: [{ family: 'Smith', given: 'Jane' }],
      issued: { 'date-parts': [[2020, 6, 1]] },
      title: 'On Things',
    })
  );
  assert.deepEqual(result, [
    { key: 'smith2020', author: 'Jane Smith', year: 2020, title: 'On Things' },
  ]);
});

test('uses only the first author', () => {
  const result = citationEntries(
    handle({
      id: 'multi',
      author: [
        { family: 'Alpha', given: 'A' },
        { family: 'Beta', given: 'B' },
      ],
      issued: { 'date-parts': [[1999]] },
      title: 'T',
    })
  );
  assert.equal(result[0].author, 'A Alpha');
});

test('falls back to the family name when there is no given name', () => {
  const result = citationEntries(
    handle({ id: 'k', author: [{ family: 'Solo' }], title: 'T' })
  );
  assert.equal(result[0].author, 'Solo');
});

test('uses an institutional literal author', () => {
  const result = citationEntries(
    handle({ id: 'org', author: [{ literal: 'The Working Group' }] })
  );
  assert.equal(result[0].author, 'The Working Group');
});

test('missing fields project to null consistently', () => {
  const result = citationEntries(handle({ id: 'bare' }));
  assert.deepEqual(result, [
    { key: 'bare', author: null, year: null, title: null },
  ]);
});

test('an entry with no id projects to an empty key', () => {
  const result = citationEntries(handle({ title: 'No Id' }));
  assert.equal(result[0].key, '');
  assert.equal(result[0].title, 'No Id');
});

test('a non-numeric or absent year is null', () => {
  const noIssued = citationEntries(handle({ id: 'a' }));
  assert.equal(noIssued[0].year, null);
  const emptyParts = citationEntries(
    handle({ id: 'b', issued: { 'date-parts': [[]] } })
  );
  assert.equal(emptyParts[0].year, null);
});

test('projects several entries in order', () => {
  const result = citationEntries(
    handle(
      { id: 'one', title: 'First' },
      { id: 'two', title: 'Second' }
    )
  );
  assert.deepEqual(result.map((e) => e.key), ['one', 'two']);
});
