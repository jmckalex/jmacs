/**
 * @file Tests for the pure attribute-coercion helpers in
 * `view-elements.js`. The custom-element registration and lifecycle
 * pieces live behind a real DOM and are exercised by the smoke arm
 * once a kind has been converted; the pure helpers are tested here
 * against a minimal attribute-bag mock.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  boolAttr,
  numAttr,
  setBoolAttr,
  strAttr,
} from '../src/view-elements.js';

/**
 * A minimum-viable element-like object that implements just the
 * attribute API the helpers touch. Cheaper than depending on jsdom
 * for these pure tests.
 */
function mockEl(initial = {}) {
  const attrs = new Map(Object.entries(initial));
  return {
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    hasAttribute(name) {
      return attrs.has(name);
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
    /** Testing-only — peek at the internal state. */
    _attrs() {
      return Object.fromEntries(attrs);
    },
  };
}

// --- strAttr --------------------------------------------------------

test('strAttr returns the attribute value when set', () => {
  const el = mockEl({ name: 'hello' });
  assert.equal(strAttr(el, 'name'), 'hello');
});

test('strAttr returns the fallback when absent', () => {
  const el = mockEl();
  assert.equal(strAttr(el, 'name', 'default'), 'default');
});

test('strAttr fallback defaults to empty string', () => {
  const el = mockEl();
  assert.equal(strAttr(el, 'name'), '');
});

test('strAttr returns empty string for an explicit empty attribute', () => {
  const el = mockEl({ name: '' });
  assert.equal(strAttr(el, 'name', 'default'), '');
});

// --- numAttr --------------------------------------------------------

test('numAttr parses a positive integer', () => {
  const el = mockEl({ count: '42' });
  assert.equal(numAttr(el, 'count'), 42);
});

test('numAttr parses a negative integer', () => {
  const el = mockEl({ count: '-7' });
  assert.equal(numAttr(el, 'count'), -7);
});

test('numAttr returns fallback when absent', () => {
  const el = mockEl();
  assert.equal(numAttr(el, 'count', 99), 99);
});

test('numAttr returns fallback for a non-numeric value', () => {
  const el = mockEl({ count: 'abc' });
  assert.equal(numAttr(el, 'count', 99), 99);
});

test('numAttr default fallback is 0', () => {
  const el = mockEl();
  assert.equal(numAttr(el, 'count'), 0);
});

test('numAttr accepts an integer prefix and ignores trailing junk', () => {
  // parseInt's well-known behaviour — documented so future-us doesn't
  // try to tighten this without thinking about cost.
  const el = mockEl({ count: '42px' });
  assert.equal(numAttr(el, 'count'), 42);
});

// --- boolAttr / setBoolAttr -----------------------------------------

test('boolAttr is true when the attribute is present with any value', () => {
  assert.equal(boolAttr(mockEl({ active: '' }), 'active'), true);
  assert.equal(boolAttr(mockEl({ active: 'true' }), 'active'), true);
  assert.equal(boolAttr(mockEl({ active: 'false' }), 'active'), true);
});

test('boolAttr is false when the attribute is absent', () => {
  assert.equal(boolAttr(mockEl(), 'active'), false);
});

test('setBoolAttr(true) writes an empty-string attribute', () => {
  const el = mockEl();
  setBoolAttr(el, 'active', true);
  assert.equal(el._attrs().active, '');
  assert.equal(boolAttr(el, 'active'), true);
});

test('setBoolAttr(false) removes the attribute', () => {
  const el = mockEl({ active: 'whatever' });
  setBoolAttr(el, 'active', false);
  assert.equal(el.hasAttribute('active'), false);
  assert.equal(boolAttr(el, 'active'), false);
});

test('setBoolAttr round-trips with boolAttr', () => {
  const el = mockEl();
  setBoolAttr(el, 'x', true);
  assert.equal(boolAttr(el, 'x'), true);
  setBoolAttr(el, 'x', false);
  assert.equal(boolAttr(el, 'x'), false);
  setBoolAttr(el, 'x', true);
  assert.equal(boolAttr(el, 'x'), true);
});
