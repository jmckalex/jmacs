/**
 * @file Tests for the bookmark outline hierarchy logic — subtree spans,
 * indent/outdent (with subtrees), and collapse-aware visible rows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  depthOf,
  subtreeEnd,
  hasChildren,
  canIndent,
  canOutdent,
  indent,
  outdent,
  visibleRows,
  sortByDocumentPosition,
} from '../src/bookmark-outline.js';

/** a, b, [c, d under b], e */
const sample = () => [
  { name: 'a', depth: 0 },
  { name: 'b', depth: 0 },
  { name: 'c', depth: 1 },
  { name: 'd', depth: 1 },
  { name: 'e', depth: 0 },
];

test('depthOf defaults missing/invalid depth to 0', () => {
  assert.equal(depthOf({}), 0);
  assert.equal(depthOf({ depth: 2 }), 2);
  assert.equal(depthOf({ depth: -1 }), 0);
});

test('subtreeEnd spans the run of deeper entries', () => {
  const r = sample();
  assert.equal(subtreeEnd(r, 1), 4); // b + c + d
  assert.equal(subtreeEnd(r, 2), 3); // c alone
  assert.equal(subtreeEnd(r, 4), 5); // e alone (last)
});

test('hasChildren reflects a deeper next entry', () => {
  const r = sample();
  assert.equal(hasChildren(r, 1), true); // b -> c
  assert.equal(hasChildren(r, 0), false); // a -> b (same depth)
  assert.equal(hasChildren(r, 3), false); // d -> e (shallower)
});

test('canIndent needs a same-or-shallower predecessor', () => {
  const r = sample();
  assert.equal(canIndent(r, 0), false); // first entry
  assert.equal(canIndent(r, 3), true); // d under c (siblings)
  assert.equal(canIndent(r, 2), false); // c already as deep as parent b + 1
});

test('indent moves a node and its subtree', () => {
  const r = sample();
  assert.equal(indent(r, 1), true); // indent b (carries c, d)
  assert.deepEqual(r.map((x) => x.depth), [0, 1, 2, 2, 0]);
});

test('outdent moves a node and its subtree, never below 0', () => {
  const r = sample();
  assert.equal(outdent(r, 2), true); // promote c
  assert.deepEqual(r.map((x) => x.depth), [0, 0, 0, 1, 0]);
  assert.equal(canOutdent(r, 0), false);
  assert.equal(outdent(r, 0), false);
});

test('visibleRows hides descendants of a collapsed node', () => {
  const r = sample();
  assert.equal(visibleRows(r).length, 5); // all visible
  r[1].collapsed = true; // collapse b
  const rows = visibleRows(r);
  assert.deepEqual(rows.map((x) => x.index), [0, 1, 4]); // c, d hidden
  assert.equal(rows[1].hasChildren, true);
  assert.equal(rows[1].collapsed, true);
});

// --- sortByDocumentPosition --------------------------------------------

test('sortByDocumentPosition sorts a flat list by anchor', () => {
  const r = [
    { name: 'late', anchor: 900, depth: 0 },
    { name: 'early', anchor: 100, depth: 0 },
    { name: 'mid', anchor: 500, depth: 0 },
  ];
  assert.deepEqual(
    sortByDocumentPosition(r).map((x) => x.name),
    ['early', 'mid', 'late']
  );
});

test('sortByDocumentPosition is stable for equal anchors', () => {
  const r = [
    { name: 'x', anchor: 100, depth: 0 },
    { name: 'y', anchor: 100, depth: 0 },
  ];
  assert.deepEqual(
    sortByDocumentPosition(r).map((x) => x.name),
    ['x', 'y']
  );
});

test('sortByDocumentPosition keeps subtrees contiguous under their parent', () => {
  // parent P at 500 with child C at 100 (child precedes parent in text);
  // a top-level Q at 300 must sort before P but C must stay under P.
  const r = [
    { name: 'P', anchor: 500, depth: 0 },
    { name: 'C', anchor: 100, depth: 1 },
    { name: 'Q', anchor: 300, depth: 0 },
  ];
  const out = sortByDocumentPosition(r);
  assert.deepEqual(out.map((x) => x.name), ['Q', 'P', 'C']);
  assert.deepEqual(out.map((x) => x.depth), [0, 0, 1]);
});

test('sortByDocumentPosition orders siblings within a subtree by anchor', () => {
  const r = [
    { name: 'P', anchor: 100, depth: 0 },
    { name: 'c2', anchor: 400, depth: 1 },
    { name: 'c1', anchor: 200, depth: 1 },
  ];
  assert.deepEqual(
    sortByDocumentPosition(r).map((x) => x.name),
    ['P', 'c1', 'c2']
  );
});
