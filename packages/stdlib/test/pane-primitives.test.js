/**
 * @file Tests for the pane primitives — (current-pane), (pane-kind),
 * (pane-view). Phase 2 of plans/PANES.md exposes them with one leaf;
 * the tests cover the full shape so phase 3's split case lands on
 * already-proven behaviour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createView } from '@editor/view';
import { createLeafPane, createSplitPane, SPLIT_HORIZONTAL } from '@editor/pane';
import { NIL } from '@editor/lisp';
import { createPanePrimitives } from '../src/index.js';

function buildHost(initialPane) {
  let pane = initialPane;
  return {
    host: {
      currentPane: () => pane,
    },
    setPane(next) {
      pane = next;
    },
  };
}

test('current-pane returns the focused leaf-pane handle', () => {
  const view = createView({ kind: 'text', name: 'a.txt' });
  const leaf = createLeafPane({ view });
  const { host } = buildHost(leaf);
  const prims = createPanePrimitives(host);
  assert.equal(prims['current-pane'](), leaf);
});

test('current-pane returns nil when no pane is focused', () => {
  const { host } = buildHost(null);
  const prims = createPanePrimitives(host);
  assert.equal(prims['current-pane'](), NIL);
});

test('pane-kind reads the pane kind as a string', () => {
  const leaf = createLeafPane();
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: createLeafPane(),
    second: createLeafPane(),
  });
  const { host } = buildHost(leaf);
  const prims = createPanePrimitives(host);
  assert.equal(prims['pane-kind']([leaf]), 'leaf');
  assert.equal(prims['pane-kind']([split]), 'split');
});

test('pane-kind returns nil for a missing / malformed handle', () => {
  const { host } = buildHost(null);
  const prims = createPanePrimitives(host);
  assert.equal(prims['pane-kind']([NIL]), NIL);
  assert.equal(prims['pane-kind']([null]), NIL);
  assert.equal(prims['pane-kind']([undefined]), NIL);
  assert.equal(prims['pane-kind']([{}]), NIL);
});

test('pane-view returns the view held by a leaf pane', () => {
  const view = createView({ kind: 'text', name: 'a.txt' });
  const leaf = createLeafPane({ view });
  const { host } = buildHost(leaf);
  const prims = createPanePrimitives(host);
  assert.equal(prims['pane-view']([leaf]), view);
});

test('pane-view returns nil for a leaf with no view', () => {
  const leaf = createLeafPane();
  const { host } = buildHost(leaf);
  const prims = createPanePrimitives(host);
  assert.equal(prims['pane-view']([leaf]), NIL);
});

test('pane-view returns nil for a split pane (it holds no view directly)', () => {
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: createLeafPane(),
    second: createLeafPane(),
  });
  const { host } = buildHost(split);
  const prims = createPanePrimitives(host);
  assert.equal(prims['pane-view']([split]), NIL);
});

test('pane-view returns nil for a malformed handle', () => {
  const { host } = buildHost(null);
  const prims = createPanePrimitives(host);
  assert.equal(prims['pane-view']([NIL]), NIL);
  assert.equal(prims['pane-view']([null]), NIL);
  assert.equal(prims['pane-view']([undefined]), NIL);
  assert.equal(prims['pane-view']([{}]), NIL);
});
