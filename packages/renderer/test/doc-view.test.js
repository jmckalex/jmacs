import { test } from 'node:test';
import assert from 'node:assert/strict';

import { docLinkName } from '../src/doc-view.js';

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
