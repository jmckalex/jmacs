import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickEditingLeaf } from '../src/tree-open.js';

// The canonical project layout: directory-tree (left, the source) |
// editing tabline (middle, showing text) | bookmark (right, a sidebar).
// `kind` is the SHOWN content kind (the host peels a tabline to its active
// child), so the middle editing tabline reads as kind 'text'.
const PROJECT = [
  { id: 'tree', kind: 'directory-tree', isTabline: false },
  { id: 'mid', kind: 'text', isTabline: true },
  { id: 'book', kind: 'bookmark', isTabline: false },
];

// A tabline that's WRAPPING the directory-tree (the bug case): structurally a
// tabline, but its shown content is the dir-tree, so kind 'directory-tree' —
// it must not be picked as an editing target.
const WRAPPED_TREE = [
  { id: 'treeTab', kind: 'directory-tree', isTabline: true },
  { id: 'mid', kind: 'text', isTabline: true },
  { id: 'book', kind: 'bookmark', isTabline: false },
];

test('editing-pane targets the middle tabline, not the tree or a sidebar', () => {
  // currentId 'tree' is a sidebar kind → excluded; falls through to the tabline.
  assert.equal(pickEditingLeaf(PROJECT, 'tree', 'editing-pane'), 'mid');
});

test('editing-pane opens in the current pane when it IS an editing pane', () => {
  // In a project the dir-tree is non-focusable, so a double-click leaves focus
  // on the middle tabline — currentId='mid' — and the file opens THERE (not a
  // new split). This is the regression the explicit-target work also covers.
  assert.equal(pickEditingLeaf(PROJECT, 'mid', 'editing-pane'), 'mid');
});

test('editing-pane never returns the tree (a sidebar kind)', () => {
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
    { id: 'tabs', kind: 'text', isTabline: true },
  ];
  assert.equal(pickEditingLeaf(leaves, 'tree', 'editing-pane'), 'tabs');
});

test('a tabline wrapping the directory-tree is NOT an editing target', () => {
  // The bug: the dir-tree got promoted to a tabline, so its leaf is
  // structurally a tabline — but its shown kind is 'directory-tree', so it
  // must be skipped, and the middle text tabline chosen.
  assert.equal(pickEditingLeaf(WRAPPED_TREE, 'treeTab', 'editing-pane'), 'mid');
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
    { id: 'b', kind: 'text', isTabline: true },
  ];
  assert.equal(pickEditingLeaf(leaves, 'tree', 'other-pane'), 'b');
});

test('other-pane wraps around, skipping the source and sidebars', () => {
  const leaves = [
    { id: 'edit', kind: 'text', isTabline: true },
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
