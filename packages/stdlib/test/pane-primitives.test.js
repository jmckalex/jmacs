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
import { NIL, listToArray, sym } from '@editor/lisp';
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

/** A host that records calls into its split / delete / focus / ratio
 *  methods so the new primitives can be exercised without a live
 *  desktop app. */
function buildRichHost(initialPane) {
  let pane = initialPane;
  const calls = [];
  return {
    calls,
    host: {
      currentPane: () => pane,
      splitHorizontal: (target, ratio) => {
        calls.push({ name: 'splitHorizontal', target, ratio });
        const first = createLeafPane({ view: target?.view ?? null });
        const second = createLeafPane();
        return { first, second };
      },
      splitVertical: (target, ratio) => {
        calls.push({ name: 'splitVertical', target, ratio });
        const first = createLeafPane({ view: target?.view ?? null });
        const second = createLeafPane();
        return { first, second };
      },
      deletePane: (target) => { calls.push({ name: 'deletePane', target }); },
      deleteOtherPanes: (target) => {
        calls.push({ name: 'deleteOtherPanes', target });
      },
      otherPane: () => {
        calls.push({ name: 'otherPane' });
        return pane;
      },
      focusPaneDirection: (direction) => {
        calls.push({ name: 'focusPaneDirection', direction });
        return direction === 'left' ? null : pane;
      },
      balancePanes: () => { calls.push({ name: 'balancePanes' }); },
      setSplitRatio: (target, ratio) => {
        calls.push({ name: 'setSplitRatio', target, ratio });
      },
    },
    setPane(next) { pane = next; },
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

// --- split / delete / navigate -----------------------------------------

test('split-horizontal! delegates and returns the two handles as a list', () => {
  const view = createView({ kind: 'text', name: 'a.txt' });
  const leaf = createLeafPane({ view });
  const { host, calls } = buildRichHost(leaf);
  const prims = createPanePrimitives(host);
  const result = prims['split-horizontal!']([]);
  const items = listToArray(result);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'leaf');
  assert.equal(items[1].kind, 'leaf');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'splitHorizontal');
  assert.equal(calls[0].target, leaf);
  assert.equal(calls[0].ratio, 0.5);
});

test('split-horizontal! honours an explicit ratio and clamps out-of-range', () => {
  const leaf = createLeafPane();
  const { host, calls } = buildRichHost(leaf);
  const prims = createPanePrimitives(host);
  prims['split-horizontal!']([0.3]);
  assert.equal(calls[0].ratio, 0.3);
  prims['split-horizontal!']([0.01]);
  assert.equal(calls[1].ratio, 0.05);
  prims['split-horizontal!']([0.99]);
  assert.equal(calls[2].ratio, 0.95);
});

test('split-vertical! is symmetric with split-horizontal!', () => {
  const leaf = createLeafPane();
  const { host, calls } = buildRichHost(leaf);
  const prims = createPanePrimitives(host);
  const result = prims['split-vertical!']([0.4]);
  const items = listToArray(result);
  assert.equal(items.length, 2);
  assert.equal(calls[0].name, 'splitVertical');
  assert.equal(calls[0].ratio, 0.4);
});

test('split-{horizontal,vertical}! return nil when no pane is current', () => {
  const { host } = buildRichHost(null);
  const prims = createPanePrimitives(host);
  assert.equal(prims['split-horizontal!']([]), NIL);
  assert.equal(prims['split-vertical!']([]), NIL);
});

test('delete-pane! defaults to the current pane and returns nil', () => {
  const leaf = createLeafPane();
  const { host, calls } = buildRichHost(leaf);
  const prims = createPanePrimitives(host);
  assert.equal(prims['delete-pane!']([]), NIL);
  assert.equal(calls[0].name, 'deletePane');
  assert.equal(calls[0].target, leaf);
});

test('delete-pane! accepts an explicit pane', () => {
  const focused = createLeafPane();
  const target = createLeafPane();
  const { host, calls } = buildRichHost(focused);
  const prims = createPanePrimitives(host);
  prims['delete-pane!']([target]);
  assert.equal(calls[0].target, target);
});

test('delete-other-panes! defaults to the current pane and returns nil', () => {
  const leaf = createLeafPane();
  const { host, calls } = buildRichHost(leaf);
  const prims = createPanePrimitives(host);
  assert.equal(prims['delete-other-panes!']([]), NIL);
  assert.equal(calls[0].name, 'deleteOtherPanes');
  assert.equal(calls[0].target, leaf);
});

test('other-pane! delegates and returns the new current pane', () => {
  const leaf = createLeafPane();
  const { host } = buildRichHost(leaf);
  const prims = createPanePrimitives(host);
  assert.equal(prims['other-pane!']([]), leaf);
});

test('focus-pane-direction! accepts a symbol or a string', () => {
  const leaf = createLeafPane();
  const { host, calls } = buildRichHost(leaf);
  const prims = createPanePrimitives(host);
  assert.equal(prims['focus-pane-direction!']([sym('right')]), leaf);
  assert.equal(calls[0].direction, 'right');
  assert.equal(prims['focus-pane-direction!'](['down']), leaf);
  assert.equal(calls[1].direction, 'down');
});

test('focus-pane-direction! returns nil for an unknown direction', () => {
  const leaf = createLeafPane();
  const { host } = buildRichHost(leaf);
  const prims = createPanePrimitives(host);
  assert.equal(prims['focus-pane-direction!']([sym('sideways')]), NIL);
});

test('focus-pane-direction! returns nil when no neighbour exists', () => {
  const leaf = createLeafPane();
  const { host } = buildRichHost(leaf);
  const prims = createPanePrimitives(host);
  // The host returns null for 'left' in buildRichHost — emulating
  // the no-neighbour case.
  assert.equal(prims['focus-pane-direction!']([sym('left')]), NIL);
});

test('balance-panes! returns nil and delegates', () => {
  const leaf = createLeafPane();
  const { host, calls } = buildRichHost(leaf);
  const prims = createPanePrimitives(host);
  assert.equal(prims['balance-panes!']([]), NIL);
  assert.equal(calls[0].name, 'balancePanes');
});

test('set-split-ratio! clamps and only fires for split nodes', () => {
  const leaf = createLeafPane();
  const split = createSplitPane({
    orientation: SPLIT_HORIZONTAL,
    ratio: 0.5,
    first: createLeafPane(),
    second: createLeafPane(),
  });
  const { host, calls } = buildRichHost(leaf);
  const prims = createPanePrimitives(host);
  prims['set-split-ratio!']([split, 0.7]);
  assert.equal(calls[0].name, 'setSplitRatio');
  assert.equal(calls[0].ratio, 0.7);
  // Clamp.
  prims['set-split-ratio!']([split, 0.001]);
  assert.equal(calls[1].ratio, 0.05);
  prims['set-split-ratio!']([split, 1.5]);
  assert.equal(calls[2].ratio, 0.95);
  // A leaf-pane handle is ignored (the primitive is a no-op).
  prims['set-split-ratio!']([leaf, 0.4]);
  assert.equal(calls.length, 3);
});
