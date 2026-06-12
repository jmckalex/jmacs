/**
 * @file Tests for the inline-eval pill (`inline-eval.js`) — in
 * particular `setOverlayLayer`, the per-pane re-pointing the host does
 * when pane focus moves (the same dance as sticky notes). Regression:
 * the pill was wired once at boot to the first editor instance's
 * overlay layer, so it rendered invisibly in any pane served by a
 * different instance — e.g. every pane of a restored session.
 *
 * Per renderer-test convention (see tabline-view-lifecycle.test.js),
 * a minimal hand-built DOM provides exactly what the module touches:
 * append/remove, ownerDocument.createElement, classList, style.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInlineEval } from '../src/inline-eval.js';

function makeDoc() {
  return {
    createElement(tagName) {
      return {
        tagName,
        className: '',
        textContent: '',
        style: {},
        parentNode: null,
        classList: { add() {} },
        remove() {
          if (this.parentNode) {
            const siblings = this.parentNode.children;
            const i = siblings.indexOf(this);
            if (i >= 0) siblings.splice(i, 1);
            this.parentNode = null;
          }
        },
      };
    },
  };
}

function makeLayer(doc) {
  return {
    ownerDocument: doc,
    children: [],
    append(el) {
      this.children.push(el);
      el.parentNode = this;
    },
  };
}

function makeBuffer() {
  return {
    text: '(+ 1 2)',
    positionAt(offset) {
      return { line: 0, column: offset };
    },
    subscribe() {
      return () => {};
    },
  };
}

test('showResult renders a pill into the current overlay layer', () => {
  const doc = makeDoc();
  const layer = makeLayer(doc);
  const ui = createInlineEval({ overlayLayer: layer, getBuffer: makeBuffer });
  ui.showResult(7, '⇒ 3');
  assert.equal(layer.children.length, 1);
  assert.equal(layer.children[0].className, 'inline-eval is-result');
  assert.equal(layer.children[0].textContent, '⇒ 3');
  ui.destroy();
});

test('setOverlayLayer re-points the pill at the new layer', () => {
  const doc = makeDoc();
  const layerA = makeLayer(doc);
  const layerB = makeLayer(doc);
  const ui = createInlineEval({ overlayLayer: layerA, getBuffer: makeBuffer });
  ui.showResult(7, '⇒ 3');
  assert.equal(layerA.children.length, 1, 'first pill in the boot layer');

  // Pane focus moves: the host re-points the overlay. The old pill
  // hides (its anchor belonged to the previous pane's buffer).
  ui.setOverlayLayer(layerB);
  assert.equal(layerA.children.length, 0, 'old pill removed on re-point');

  ui.showError(3, '! boom');
  assert.equal(layerA.children.length, 0, 'nothing lands in the old layer');
  assert.equal(layerB.children.length, 1, 'pill lands in the active layer');
  assert.equal(layerB.children[0].className, 'inline-eval is-error');
  ui.destroy();
});

test('setOverlayLayer with the same layer keeps the pill', () => {
  const doc = makeDoc();
  const layer = makeLayer(doc);
  const ui = createInlineEval({ overlayLayer: layer, getBuffer: makeBuffer });
  ui.showResult(7, '⇒ 3');
  ui.setOverlayLayer(layer);
  assert.equal(layer.children.length, 1, 'no-op re-point keeps the pill');
  ui.destroy();
});

test('a null layer makes show a safe no-op', () => {
  const doc = makeDoc();
  const layer = makeLayer(doc);
  const ui = createInlineEval({ overlayLayer: layer, getBuffer: makeBuffer });
  ui.setOverlayLayer(null);
  ui.showResult(7, '⇒ 3');
  assert.equal(layer.children.length, 0);
  ui.destroy();
});
