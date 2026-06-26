/**
 * @file Unit tests for the pure exports of `<svg-editor-view>`.
 *
 * The element class itself touches the DOM (DOMParser, getBBox, pointer
 * events) and is exercised live in Electron — the renderer suite runs
 * under Node without a DOM. These tests cover the module-level pure bits
 * (the tool table and key→tool mapping) and assert the module loads
 * cleanly under Node (no top-level DOM access at import time).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, toolForKey, SvgEditorView } from './svg-editor-view.js';

test('TOOLS includes the MVP tool set with unique keys', () => {
  const ids = TOOLS.map((t) => t.id);
  for (const id of ['select', 'rect', 'ellipse', 'line', 'text', 'math']) {
    assert.ok(ids.includes(id), `has ${id} tool`);
  }
  const keys = TOOLS.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length, 'tool keys are unique');
});

test('toolForKey maps a letter to its tool, null otherwise', () => {
  assert.equal(toolForKey('r'), 'rect');
  assert.equal(toolForKey('m'), 'math');
  assert.equal(toolForKey('z'), null);
});

test('SvgEditorView class is exported and constructs under Node', () => {
  // Under Node, ViewElement is a no-op stub, so `new` must not throw and
  // the kind getter must report the registered tag's kind.
  const view = new SvgEditorView();
  assert.equal(view.kind, 'svg-editor');
  assert.equal(view.tool, 'select');
});
