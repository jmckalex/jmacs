/**
 * @file Unit tests for the pure helpers of the *View List* view
 * (`packages/renderer/src/view-list-view.js`). These run under Node with
 * no DOM — the custom element's `defineViewElement` registration is a
 * no-op there, so importing the module just exercises `kindLabel` and
 * `fileLabel`. The table's DOM behaviour (clicking a row, the ✕ button,
 * live refresh) is covered by the live hand-off, not here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { kindLabel, fileLabel } from '../src/view-list-view.js';

test('kindLabel: a text view shows its major-mode name', () => {
  assert.equal(kindLabel('text', 'Markdown'), 'Markdown');
  assert.equal(kindLabel('text', 'Lisp'), 'Lisp');
});

test('kindLabel: a text view with no/blank mode falls back to Fundamental', () => {
  assert.equal(kindLabel('text', null), 'Fundamental');
  assert.equal(kindLabel('text', undefined), 'Fundamental');
  assert.equal(kindLabel('text', ''), 'Fundamental');
});

test('kindLabel: non-text kinds show a pretty kind label, ignoring mode', () => {
  // The headline fix: a browser reads "Browser", never "Fundamental".
  assert.equal(kindLabel('browser', null), 'Browser');
  assert.equal(kindLabel('browser', 'Fundamental'), 'Browser');
  assert.equal(kindLabel('gnuplot', null), 'Gnuplot');
  assert.equal(kindLabel('notebook', null), 'Notebook');
  assert.equal(kindLabel('pdf', null), 'PDF');
  assert.equal(kindLabel('image', null), 'Image');
  assert.equal(kindLabel('shell', null), 'Shell');
  assert.equal(kindLabel('directory-tree', null), 'Directory tree');
  assert.equal(kindLabel('view-list', null), 'View list');
});

test('kindLabel: an unknown kind is capitalised rather than dropped', () => {
  assert.equal(kindLabel('widget', null), 'Widget');
  assert.equal(kindLabel('', null), '');
});

test('fileLabel: a path is shown as-is, a missing file is empty', () => {
  assert.equal(fileLabel('/path/to/main.js'), '/path/to/main.js');
  assert.equal(fileLabel(null), '');
  assert.equal(fileLabel(undefined), '');
  assert.equal(fileLabel(''), '');
});
