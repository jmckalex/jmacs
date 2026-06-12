import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  docLinkName,
  breadcrumbTrail,
  navNeighbors,
} from '../src/doc-view.js';

/**
 * The pure click-routing logic in doc-view. The DOM event handler that
 * wraps it is exercised by the desktop smoke test; here we cover the
 * decision in isolation.
 */

// A minimal stand-in for the bit of the DOM the routing actually
// reads — closest() walking up ancestors, and getAttribute() on the
// chosen one. The chain models `<article><p><a data-jmacs-doc="foo">…`
// where target is the inner-most node.
function mockTarget({ name, hasAncestor = true } = {}) {
  const link = {
    getAttribute: (key) => (key === 'data-jmacs-doc' ? name : null),
  };
  return {
    closest: (selector) =>
      selector === '[data-jmacs-doc]' && hasAncestor ? link : null,
  };
}

test('docLinkName returns the doc name for a click inside a cross-link', () => {
  assert.equal(docLinkName(mockTarget({ name: 'forward-char' })), 'forward-char');
});

test('docLinkName returns null when there is no matching ancestor', () => {
  assert.equal(docLinkName(mockTarget({ hasAncestor: false })), null);
});

test('docLinkName returns null on a missing target', () => {
  assert.equal(docLinkName(null), null);
  assert.equal(docLinkName(undefined), null);
});

test('docLinkName returns null on a target without closest()', () => {
  assert.equal(docLinkName({}), null);
});

test('docLinkName returns null when the data attribute is empty', () => {
  assert.equal(docLinkName(mockTarget({ name: '' })), null);
});

test('docLinkName ignores other selectors', () => {
  // The handler should only check the [data-jmacs-doc] selector. If
  // closest() returns nothing for that selector, we don't consult any
  // other.
  const target = {
    closest: () => null,
  };
  assert.equal(docLinkName(target), null);
});

// --- navigation tree helpers (TeXinfo-style nav) -----------------------

// A small sample tree:  top → {a → {a1, a2}, b}
const NODES = {
  top: { id: 'top', title: 'Top', up: null, prev: null, next: 'a', children: ['a', 'b'] },
  a:   { id: 'a',   title: 'A',   up: 'top', prev: 'top', next: 'a1', children: ['a1', 'a2'] },
  a1:  { id: 'a1',  title: 'A1',  up: 'a',   prev: 'a',  next: 'a2', children: [] },
  a2:  { id: 'a2',  title: 'A2',  up: 'a',   prev: 'a1', next: 'b',  children: [] },
  b:   { id: 'b',   title: 'B',   up: 'top', prev: 'a2', next: null, children: [] },
};

test('breadcrumbTrail walks the up-chain from Top to the node (inclusive)', () => {
  assert.deepEqual(
    breadcrumbTrail(NODES, 'a2').map((n) => n.id),
    ['top', 'a', 'a2']
  );
  assert.deepEqual(breadcrumbTrail(NODES, 'top').map((n) => n.id), ['top']);
});

test('breadcrumbTrail is empty for an unknown / null node', () => {
  assert.deepEqual(breadcrumbTrail(NODES, 'nope'), []);
  assert.deepEqual(breadcrumbTrail(NODES, null), []);
  assert.deepEqual(breadcrumbTrail(null, 'a'), []);
});

test('breadcrumbTrail does not loop on a malformed cyclic tree', () => {
  const cyclic = {
    x: { id: 'x', title: 'X', up: 'y' },
    y: { id: 'y', title: 'Y', up: 'x' },
  };
  // Terminates (cycle broken) and includes each node at most once.
  const ids = breadcrumbTrail(cyclic, 'x').map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('navNeighbors returns prev/next/up plus the tree top', () => {
  assert.deepEqual(navNeighbors(NODES, 'top', 'a2'), {
    prev: 'a1', next: 'b', up: 'a', top: 'top',
  });
  // The Top node: no prev/up, but Contents still points at itself.
  assert.deepEqual(navNeighbors(NODES, 'top', 'top'), {
    prev: null, next: 'a', up: null, top: 'top',
  });
});

test('navNeighbors degrades gracefully for an unknown node', () => {
  assert.deepEqual(navNeighbors(NODES, 'top', 'nope'), {
    prev: null, next: null, up: null, top: 'top',
  });
});
