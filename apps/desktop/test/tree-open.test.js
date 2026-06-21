import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickEditingLeaf } from '../src/tree-open.js';

// The canonical project layout: directory-tree (left, the source) |
// tabline (middle, the editing area) | bookmark (right, a sidebar).
const PROJECT = [
  { id: 'tree', kind: 'directory-tree', isTabline: false },
  { id: 'mid', kind: 'tabline', isTabline: true },
  { id: 'book', kind: 'bookmark', isTabline: false },
];

test('editing-pane targets the middle tabline, not the tree or a sidebar', () => {
  assert.equal(pickEditingLeaf(PROJECT, 'tree', 'editing-pane'), 'mid');
});

test('editing-pane never returns the source (tree) pane', () => {
  const onlyTree = [{ id: 'tree', kind: 'directory-tree', isTabline: false }];
  assert.equal(pickEditingLeaf(onlyTree, 'tree', 'editing-pane'), null);
});

test('editing-pane skips bookmark/minimap/directory sidebars', () => {
  const leaves = [
    { id: 'tree', kind: 'directory-tree', isTabline: false },
    { id: 'book', kind: 'bookmark', isTabline: false },
    { id: 'map', kind: 'minimap', isTabline: false },
  ];
  // Only sidebars besides the source → no editing target.
  assert.equal(pickEditingLeaf(leaves, 'tree', 'editing-pane'), null);
});

test('editing-pane prefers a tabline over a plain text leaf', () => {
  const leaves = [
    { id: 'tree', kind: 'directory-tree', isTabline: false },
    { id: 'plain', kind: 'text', isTabline: false },
    { id: 'tabs', kind: 'tabline', isTabline: true },
  ];
  assert.equal(pickEditingLeaf(leaves, 'tree', 'editing-pane'), 'tabs');
});

test('editing-pane falls back to a plain text leaf when no tabline exists', () => {
  const leaves = [
    { id: 'tree', kind: 'directory-tree', isTabline: false },
    { id: 'plain', kind: 'text', isTabline: false },
  ];
  assert.equal(pickEditingLeaf(leaves, 'tree', 'editing-pane'), 'plain');
});

test('other-pane returns the next editing leaf after the source', () => {
  const leaves = [
    { id: 'a', kind: 'text', isTabline: false },
    { id: 'tree', kind: 'directory-tree', isTabline: false },
    { id: 'b', kind: 'tabline', isTabline: true },
  ];
  assert.equal(pickEditingLeaf(leaves, 'tree', 'other-pane'), 'b');
});

test('other-pane wraps around, skipping the source and sidebars', () => {
  const leaves = [
    { id: 'edit', kind: 'tabline', isTabline: true },
    { id: 'book', kind: 'bookmark', isTabline: false },
    { id: 'tree', kind: 'directory-tree', isTabline: false },
  ];
  // After 'tree' wraps to 'edit' (skips 'book' sidebar).
  assert.equal(pickEditingLeaf(leaves, 'tree', 'other-pane'), 'edit');
});

test('empty / malformed input yields null', () => {
  assert.equal(pickEditingLeaf([], 'tree', 'editing-pane'), null);
  assert.equal(pickEditingLeaf(null, 'tree', 'editing-pane'), null);
});

test('an empty leaf (no view) is not an editing target', () => {
  const leaves = [
    { id: 'tree', kind: 'directory-tree', isTabline: false },
    { id: 'empty', kind: null, isTabline: false },
  ];
  assert.equal(pickEditingLeaf(leaves, 'tree', 'editing-pane'), null);
});
