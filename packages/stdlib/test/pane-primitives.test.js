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
import { NIL, listToArray, sym, cons } from '@editor/lisp';
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

// --- tabline-view primitives (phase 3b) ----------------------------------
//
// The tabline-view operations live on `paneHost` alongside the split /
// delete / navigate methods. Tests build a small rich host and assert
// the primitive forwards through it cleanly.

/** A rich host with both pane-tree and tabline-view operations.
 *  Tracks every call; the tabline ops mutate the tabline-view shape
 *  directly the way the desktop app's implementations do. */
function buildTablineHost(initialPane, initialTabline = null) {
  let pane = initialPane;
  let tabline = initialTabline;
  const calls = [];
  return {
    calls,
    host: {
      currentPane: () => pane,
      currentTabline: () => tabline,
      promoteToTabline: (target) => {
        calls.push({ name: 'promoteToTabline', target });
        const tlv = createView({
          kind: 'tabline',
          extras: { tabs: [target.view], active: 0, edge: 'top' },
        });
        target.view = tlv;
        tabline = tlv;
        return tlv;
      },
      demoteTabline: (tlv) => {
        calls.push({ name: 'demoteTabline', tlv });
        const survivor = tlv.tabs[tlv.active] ?? null;
        if (pane.view === tlv) pane.view = survivor;
        tabline = null;
        return survivor;
      },
      addTab: (tlv, view, index) => {
        calls.push({ name: 'addTab', tlv, view, index });
        const target =
          typeof index === 'number' && index >= 0 && index <= tlv.tabs.length
            ? index
            : tlv.tabs.length;
        tlv.tabs.splice(target, 0, view);
        return tlv;
      },
      removeTab: (tlv, index) => {
        calls.push({ name: 'removeTab', tlv, index });
        tlv.tabs.splice(index, 1);
        if (tlv.active >= tlv.tabs.length) {
          tlv.active = Math.max(0, tlv.tabs.length - 1);
        }
        return tlv;
      },
      activateTab: (tlv, index) => {
        calls.push({ name: 'activateTab', tlv, index });
        tlv.active = index;
        return tlv;
      },
      setTablineEdge: (tlv, edge) => {
        calls.push({ name: 'setTablineEdge', tlv, edge });
        tlv.edge = edge;
        return tlv;
      },
      moveTab: (srcTlv, srcIdx, dstTlv, dstIdx) => {
        calls.push({ name: 'moveTab', srcTlv, srcIdx, dstTlv, dstIdx });
        const view = srcTlv.tabs[srcIdx];
        if (!view) return dstTlv;
        srcTlv.tabs.splice(srcIdx, 1);
        const target =
          typeof dstIdx === 'number' && dstIdx >= 0 && dstIdx <= dstTlv.tabs.length
            ? dstIdx
            : dstTlv.tabs.length;
        dstTlv.tabs.splice(target, 0, view);
        dstTlv.active = target;
        return dstTlv;
      },
      swapPanes: (a, b) => {
        calls.push({ name: 'swapPanes', a, b });
        if (!a || !b || a === b) return false;
        const av = a.view; a.view = b.view; b.view = av;
        return true;
      },
    },
    setPane(next) { pane = next; },
    setTabline(next) { tabline = next; },
  };
}

test('current-tabline returns the focused pane\'s tabline-view', () => {
  const view = createView({ kind: 'text', name: 'a.txt' });
  const tlv = createView({
    kind: 'tabline',
    extras: { tabs: [view], active: 0, edge: 'top' },
  });
  const leaf = createLeafPane({ view: tlv });
  const { host } = buildTablineHost(leaf, tlv);
  const prims = createPanePrimitives(host);
  assert.equal(prims['current-tabline'](), tlv);
});

test('current-tabline returns nil when the focused pane has no tabline', () => {
  const leaf = createLeafPane();
  const { host } = buildTablineHost(leaf, null);
  const prims = createPanePrimitives(host);
  assert.equal(prims['current-tabline'](), NIL);
});

test('promote-to-tabline! defaults to the current pane and returns the new tabline', () => {
  const view = createView({ kind: 'text', name: 'a.txt' });
  const leaf = createLeafPane({ view });
  const { host, calls } = buildTablineHost(leaf);
  const prims = createPanePrimitives(host);
  const tlv = prims['promote-to-tabline!']([]);
  assert.equal(calls[0].name, 'promoteToTabline');
  assert.equal(calls[0].target, leaf);
  assert.equal(tlv.kind, 'tabline');
  assert.deepEqual(tlv.tabs, [view]);
});

test('promote-to-tabline! accepts an explicit pane', () => {
  const view = createView({ kind: 'text', name: 'a.txt' });
  const focused = createLeafPane();
  const target = createLeafPane({ view });
  const { host, calls } = buildTablineHost(focused);
  const prims = createPanePrimitives(host);
  prims['promote-to-tabline!']([target]);
  assert.equal(calls[0].target, target);
});

test('demote-tabline! defaults to the current pane\'s tabline', () => {
  const v1 = createView({ kind: 'text', name: 'a.txt' });
  const v2 = createView({ kind: 'text', name: 'b.txt' });
  const tlv = createView({
    kind: 'tabline',
    extras: { tabs: [v1, v2], active: 1, edge: 'top' },
  });
  const leaf = createLeafPane({ view: tlv });
  const { host, calls } = buildTablineHost(leaf, tlv);
  const prims = createPanePrimitives(host);
  const survivor = prims['demote-tabline!']([]);
  assert.equal(calls[0].name, 'demoteTabline');
  assert.equal(calls[0].tlv, tlv);
  assert.equal(survivor, v2);
});

test('demote-tabline! returns nil for a non-tabline argument', () => {
  const view = createView({ kind: 'text', name: 'a.txt' });
  const leaf = createLeafPane({ view });
  const { host } = buildTablineHost(leaf, null);
  const prims = createPanePrimitives(host);
  // current-tabline returns null, so the no-arg call also yields nil.
  assert.equal(prims['demote-tabline!']([]), NIL);
  assert.equal(prims['demote-tabline!']([view]), NIL); // wrong shape
});

test('make-tabline-view builds a fresh tabline-view handle from a Lisp list', () => {
  const v1 = createView({ kind: 'text', name: 'a.txt' });
  const v2 = createView({ kind: 'text', name: 'b.txt' });
  const leaf = createLeafPane();
  const { host } = buildTablineHost(leaf);
  const prims = createPanePrimitives(host);
  // Build a Lisp list (v1 v2) by hand.
  const tabsList = cons(v1, cons(v2, NIL));
  const tlv = prims['make-tabline-view']([tabsList, sym('bottom')]);
  assert.equal(tlv.kind, 'tabline');
  assert.deepEqual(tlv.tabs, [v1, v2]);
  assert.equal(tlv.active, 0);
  assert.equal(tlv.edge, 'bottom');
});

test('make-tabline-view defaults edge to top and tabs to []', () => {
  const leaf = createLeafPane();
  const { host } = buildTablineHost(leaf);
  const prims = createPanePrimitives(host);
  const tlv = prims['make-tabline-view']([NIL, NIL]);
  assert.equal(tlv.kind, 'tabline');
  assert.deepEqual(tlv.tabs, []);
  assert.equal(tlv.edge, 'top');
});

test('add-tab! appends by default and returns the tabline-view', () => {
  const v1 = createView({ kind: 'text', name: 'a.txt' });
  const v2 = createView({ kind: 'text', name: 'b.txt' });
  const tlv = createView({
    kind: 'tabline',
    extras: { tabs: [v1], active: 0, edge: 'top' },
  });
  const leaf = createLeafPane({ view: tlv });
  const { host, calls } = buildTablineHost(leaf, tlv);
  const prims = createPanePrimitives(host);
  const result = prims['add-tab!']([tlv, v2]);
  assert.equal(result, tlv);
  assert.deepEqual(tlv.tabs, [v1, v2]);
  assert.equal(calls[0].name, 'addTab');
  assert.equal(calls[0].index, undefined);
});

test('add-tab! at an explicit index inserts there', () => {
  const v1 = createView({ kind: 'text', name: 'a.txt' });
  const v2 = createView({ kind: 'text', name: 'b.txt' });
  const v3 = createView({ kind: 'text', name: 'c.txt' });
  const tlv = createView({
    kind: 'tabline',
    extras: { tabs: [v1, v3], active: 0, edge: 'top' },
  });
  const leaf = createLeafPane({ view: tlv });
  const { host } = buildTablineHost(leaf, tlv);
  const prims = createPanePrimitives(host);
  prims['add-tab!']([tlv, v2, 1]);
  assert.deepEqual(tlv.tabs, [v1, v2, v3]);
});

test('add-tab! returns nil for a non-tabline argument', () => {
  const v1 = createView({ kind: 'text', name: 'a.txt' });
  const v2 = createView({ kind: 'text', name: 'b.txt' });
  const leaf = createLeafPane();
  const { host } = buildTablineHost(leaf);
  const prims = createPanePrimitives(host);
  assert.equal(prims['add-tab!']([v1, v2]), NIL);
});

test('remove-tab! removes the tab at INDEX and returns the tabline', () => {
  const v1 = createView({ kind: 'text', name: 'a.txt' });
  const v2 = createView({ kind: 'text', name: 'b.txt' });
  const tlv = createView({
    kind: 'tabline',
    extras: { tabs: [v1, v2], active: 1, edge: 'top' },
  });
  const leaf = createLeafPane({ view: tlv });
  const { host, calls } = buildTablineHost(leaf, tlv);
  const prims = createPanePrimitives(host);
  const result = prims['remove-tab!']([tlv, 0]);
  assert.equal(result, tlv);
  assert.deepEqual(tlv.tabs, [v2]);
  assert.equal(calls[0].name, 'removeTab');
});

test('activate-tab! sets the active tab through the host', () => {
  const v1 = createView({ kind: 'text', name: 'a.txt' });
  const v2 = createView({ kind: 'text', name: 'b.txt' });
  const tlv = createView({
    kind: 'tabline',
    extras: { tabs: [v1, v2], active: 0, edge: 'top' },
  });
  const leaf = createLeafPane({ view: tlv });
  const { host, calls } = buildTablineHost(leaf, tlv);
  const prims = createPanePrimitives(host);
  const result = prims['activate-tab!']([tlv, 1]);
  assert.equal(result, tlv);
  assert.equal(tlv.active, 1);
  assert.equal(calls[0].name, 'activateTab');
});

test('tabline-edge returns the edge as a keyword', () => {
  const tlv = createView({
    kind: 'tabline',
    extras: { tabs: [], active: 0, edge: 'right' },
  });
  const leaf = createLeafPane({ view: tlv });
  const { host } = buildTablineHost(leaf, tlv);
  const prims = createPanePrimitives(host);
  const k = prims['tabline-edge']([tlv]);
  // Keywords carry a `.name` matching the underlying string.
  assert.equal(typeof k, 'object');
  assert.equal(k.name, 'right');
});

test('tabline-edge returns nil for a non-tabline argument', () => {
  const view = createView({ kind: 'text', name: 'a.txt' });
  const leaf = createLeafPane({ view });
  const { host } = buildTablineHost(leaf);
  const prims = createPanePrimitives(host);
  assert.equal(prims['tabline-edge']([view]), NIL);
});

test('set-tabline-edge! accepts a symbol or string and forwards through the host', () => {
  const tlv = createView({
    kind: 'tabline',
    extras: { tabs: [], active: 0, edge: 'top' },
  });
  const leaf = createLeafPane({ view: tlv });
  const { host, calls } = buildTablineHost(leaf, tlv);
  const prims = createPanePrimitives(host);
  prims['set-tabline-edge!']([tlv, sym('left')]);
  assert.equal(calls[0].name, 'setTablineEdge');
  assert.equal(calls[0].edge, 'left');
  prims['set-tabline-edge!']([tlv, 'bottom']);
  assert.equal(calls[1].edge, 'bottom');
});

test('set-tabline-edge! ignores an unknown edge value', () => {
  const tlv = createView({
    kind: 'tabline',
    extras: { tabs: [], active: 0, edge: 'top' },
  });
  const leaf = createLeafPane({ view: tlv });
  const { host, calls } = buildTablineHost(leaf, tlv);
  const prims = createPanePrimitives(host);
  prims['set-tabline-edge!']([tlv, sym('sideways')]);
  assert.equal(calls.length, 0);
});

test('move-tab! splices a tab from one tabline into another', () => {
  const va = createView({ kind: 'text', name: 'a.txt' });
  const vb = createView({ kind: 'text', name: 'b.txt' });
  const vc = createView({ kind: 'text', name: 'c.txt' });
  const src = createView({
    kind: 'tabline',
    extras: { tabs: [va, vb], active: 0, edge: 'top' },
  });
  const dst = createView({
    kind: 'tabline',
    extras: { tabs: [vc], active: 0, edge: 'top' },
  });
  const leaf = createLeafPane({ view: src });
  const { host, calls } = buildTablineHost(leaf, src);
  const prims = createPanePrimitives(host);
  // Move src[1] ('b') to dst (end).
  prims['move-tab!']([src, 1, dst]);
  assert.equal(calls[0].name, 'moveTab');
  assert.deepEqual(src.tabs, [va]);
  assert.deepEqual(dst.tabs, [vc, vb]);
  assert.equal(dst.active, 1);
});

test('move-tab! is a no-op for invalid indices or non-tabline args', () => {
  const va = createView({ kind: 'text', name: 'a.txt' });
  const src = createView({
    kind: 'tabline',
    extras: { tabs: [va], active: 0, edge: 'top' },
  });
  const leaf = createLeafPane({ view: src });
  const { host, calls } = buildTablineHost(leaf, src);
  const prims = createPanePrimitives(host);
  // Non-tabline as src → silent no-op.
  prims['move-tab!']([va, 0, src]);
  assert.equal(calls.length, 0);
  // Out-of-range src index → still routed to host but does nothing.
  prims['move-tab!']([src, 9, src]);
  // Some hosts may record the call but mutate nothing; the test
  // tolerates either by asserting the underlying tabs are unchanged.
  assert.deepEqual(src.tabs, [va]);
});

test('swap-panes! exchanges the views of two leaf panes', () => {
  const va = createView({ kind: 'text', name: 'a.txt' });
  const vb = createView({ kind: 'text', name: 'b.txt' });
  const paneA = createLeafPane({ view: va });
  const paneB = createLeafPane({ view: vb });
  const { host, calls } = buildTablineHost(paneA, null);
  const prims = createPanePrimitives(host);
  const result = prims['swap-panes!']([paneA, paneB]);
  assert.equal(result, true);
  assert.equal(calls[0].name, 'swapPanes');
  assert.equal(paneA.view, vb);
  assert.equal(paneB.view, va);
});

test('swap-panes! is a no-op for the same pane handle', () => {
  const va = createView({ kind: 'text', name: 'a.txt' });
  const paneA = createLeafPane({ view: va });
  const { host } = buildTablineHost(paneA, null);
  const prims = createPanePrimitives(host);
  const result = prims['swap-panes!']([paneA, paneA]);
  assert.equal(result, false);
  assert.equal(paneA.view, va);
});
