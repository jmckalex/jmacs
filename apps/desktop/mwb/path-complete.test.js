/**
 * @file Tests for mwb/path-complete.js — case-insensitive find-file completion.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { completePath } from './path-complete.js';

/** A listDir over a fixed tree keyed by dir prefix. */
function tree(map) {
  return (dirPrefix) => map[dirPrefix] ?? null;
}

const ROOT = [
  { name: 'README.md', isDir: false },
  { name: 'src', isDir: true },
  { name: 'docs', isDir: true },
  { name: 'data.txt', isDir: false },
];

test('a unique match completes fully; a directory gets a trailing slash', () => {
  const listDir = tree({ '': ROOT });
  assert.deepEqual(completePath('READ', listDir).value, 'README.md');
  // 'src' is the only entry starting with 's' → completes + trailing slash.
  assert.deepEqual(completePath('s', listDir).value, 'src/');
});

test('matching is CASE-INSENSITIVE', () => {
  const listDir = tree({ '': ROOT });
  assert.equal(completePath('readme', listDir).value, 'README.md'); // lower → real name
  assert.equal(completePath('SR', listDir).value, 'src/');
});

test('multiple matches complete to the common prefix + list the candidates', () => {
  const listDir = tree({ '': ROOT });
  const r = completePath('d', listDir); // docs/, data.txt
  assert.equal(r.value, 'd');           // common prefix is just 'd'
  assert.deepEqual(r.items.sort(), ['data.txt', 'docs/']);
});

test('the typed partial casing is preserved; only the common run extends it', () => {
  const listDir = tree({ 'src/': [
    { name: 'main.js', isDir: false },
    { name: 'Makefile', isDir: false },
  ] });
  // 'Ma' matches both (case-insensitive); common run beyond 'Ma' is empty, so
  // the typed 'Ma' is kept verbatim (not lower-cased to 'ma').
  const r = completePath('src/Ma', listDir);
  assert.equal(r.value, 'src/Ma');
  assert.deepEqual(r.items.sort(), ['Makefile', 'main.js']);
});

test('the directory prefix is preserved in the completed value', () => {
  const listDir = tree({ 'src/': [
    { name: 'index.js', isDir: false },
    { name: 'internal', isDir: true },
  ] });
  const r = completePath('src/in', listDir); // index.js, internal/
  assert.equal(r.value, 'src/in');           // common prefix 'in'
  assert.deepEqual(r.items.sort(), ['index.js', 'internal/']);
  assert.equal(r.directory, 'src/');
});

test('no matches leaves the value unchanged with an empty list', () => {
  const listDir = tree({ '': ROOT });
  const r = completePath('zzz', listDir);
  assert.equal(r.value, 'zzz');
  assert.deepEqual(r.items, []);
});

test('an empty input lists everything (no common prefix)', () => {
  const r = completePath('', tree({ '': ROOT }));
  assert.equal(r.value, '');
  assert.equal(r.items.length, 4);
});

test('an unreadable directory yields no candidates', () => {
  const r = completePath('nope/x', tree({}));
  assert.deepEqual(r.items, []);
  assert.equal(r.value, 'nope/x');
});
