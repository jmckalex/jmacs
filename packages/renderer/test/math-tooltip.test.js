/**
 * @file Tests for math-tooltip.js — the pure positioning + keep-last-valid
 * decision, and the controller's state machine over a fake DOM. (The real
 * SVG mount needs a live smoke test.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseRender, placeAbove, createMathTooltip } from '../src/math-tooltip.js';

// --- placeAbove (pure) ---------------------------------------------------

test('placeAbove centers the tooltip above the anchor', () => {
  const pos = placeAbove(
    { left: 100, top: 200, right: 140, bottom: 220, width: 40 },
    { width: 200, height: 60 },
    { width: 1000, height: 800 }
  );
  assert.equal(pos.left, 20); // center 120 - 100
  assert.equal(pos.top, 132); // 200 - 60 - 8
  assert.equal(pos.below, false);
});

test('placeAbove clamps to the left and right viewport edges', () => {
  const left = placeAbove(
    { left: 0, top: 300, right: 10, bottom: 320, width: 10 },
    { width: 200, height: 60 },
    { width: 1000, height: 800 }
  );
  assert.equal(left.left, 4);
  const right = placeAbove(
    { left: 990, top: 300, right: 1000, bottom: 320, width: 10 },
    { width: 200, height: 60 },
    { width: 1000, height: 800 }
  );
  assert.equal(right.left, 796); // 1000 - 200 - 4
});

test('placeAbove flips below when there is no room above', () => {
  const pos = placeAbove(
    { left: 100, top: 10, right: 140, bottom: 30, width: 40 },
    { width: 200, height: 60 },
    { width: 1000, height: 800 }
  );
  assert.equal(pos.below, true);
  assert.equal(pos.top, 38); // bottom 30 + gap 8
});

// --- chooseRender (pure) -------------------------------------------------

test('chooseRender shows a fresh node and remembers it', () => {
  const node = { id: 'n1' };
  const r = chooseRender({ node, lastValid: null });
  assert.equal(r.mount, node);
  assert.equal(r.error, false);
  assert.equal(r.lastValid, node);
});

test('chooseRender keeps the last valid render on a parse error', () => {
  const prev = { id: 'prev' };
  const r = chooseRender({ node: null, lastValid: prev });
  assert.equal(r.mount, prev);
  assert.equal(r.error, true);
  assert.equal(r.lastValid, prev);
});

test('chooseRender shows nothing (badge only) when nothing valid yet', () => {
  const r = chooseRender({ node: null, lastValid: null });
  assert.equal(r.mount, null);
  assert.equal(r.error, true);
});

// --- createMathTooltip (controller over a fake DOM) ----------------------

function fakeEl(doc, tag) {
  return {
    tag,
    ownerDocument: doc,
    className: '',
    textContent: '',
    title: '',
    style: {
      setProperty(k, v) {
        this[k] = v;
      },
    },
    children: [],
    parentNode: null,
    get firstChild() {
      return this.children[0] || null;
    },
    appendChild(c) {
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      c.parentNode = null;
      return c;
    },
    replaceChildren() {
      this.children = [];
    },
    classList: {
      _s: new Set(),
      add(c) {
        this._s.add(c);
      },
      remove(c) {
        this._s.delete(c);
      },
      toggle(c, on) {
        if (on) this._s.add(c);
        else this._s.delete(c);
        return Boolean(on);
      },
      contains(c) {
        return this._s.has(c);
      },
    },
    getBoundingClientRect() {
      return { width: 220, height: 64, left: 0, top: 0, right: 220, bottom: 64 };
    },
    cloneNode() {
      return this;
    },
  };
}

function fakeHost() {
  const doc = {
    defaultView: { innerWidth: 1000, innerHeight: 800 },
    createElement(tag) {
      return fakeEl(doc, tag);
    },
  };
  return fakeEl(doc, 'host');
}

test('createMathTooltip mounts a node and shows the tooltip', () => {
  const host = fakeHost();
  const tip = createMathTooltip(host);
  const node = host.ownerDocument.createElement('svg');
  tip.update({
    node,
    key: 5,
    display: false,
    anchorRect: { left: 100, top: 200, right: 120, bottom: 220, width: 20 },
  });
  assert.notEqual(tip.element.style.display, 'none');
  assert.equal(tip.element.children[0].children.length, 1, 'body has the node');
  assert.equal(tip.element.children[1].style.display, 'none', 'badge hidden');
});

test('createMathTooltip keeps the last valid image and flags the badge on error', () => {
  const host = fakeHost();
  const tip = createMathTooltip(host);
  const good = host.ownerDocument.createElement('svg');
  tip.update({ node: good, key: 5, anchorRect: null });
  tip.update({ node: null, key: 5, anchorRect: null }); // error at same construct
  assert.equal(tip.element.children[0].children.length, 1, 'last valid image stays');
  assert.notEqual(tip.element.children[1].style.display, 'none', 'error badge shown');
});

test('entering a new construct resets the kept image (no stale render)', () => {
  const host = fakeHost();
  const tip = createMathTooltip(host);
  const good = host.ownerDocument.createElement('svg');
  tip.update({ node: good, key: 5, anchorRect: null });
  tip.update({ node: null, key: 99, anchorRect: null }); // new construct, invalid
  assert.equal(tip.element.children[0].children.length, 0, 'no image from the previous construct');
  assert.notEqual(tip.element.children[1].style.display, 'none');
});

test('hide() hides the tooltip and clears the kept image', () => {
  const host = fakeHost();
  const tip = createMathTooltip(host);
  const good = host.ownerDocument.createElement('svg');
  tip.update({ node: good, key: 5, anchorRect: null });
  tip.hide();
  assert.equal(tip.element.style.display, 'none');
  tip.update({ node: null, key: 5, anchorRect: null }); // must not resurrect
  assert.equal(tip.element.children[0].children.length, 0);
});

test('positions in content coordinates and freezes horizontally', () => {
  const host = fakeHost();
  const tip = createMathTooltip(host);
  const n = host.ownerDocument.createElement('svg');
  const contentRect = { top: 100, left: 40 };
  tip.update({ node: n, key: 5, caretRect: { top: 300, bottom: 320, left: 200, width: 20 }, contentRect });
  // content-Y = 300 - 100 = 200; top = 200 - 64 (fake height) - 8 (gap) = 128.
  assert.equal(tip.element.style.top, '128px');
  const frozen = tip.element.style.left;
  // Same construct, caret moved right (typing) → horizontal must NOT move.
  tip.update({ node: n, key: 5, caretRect: { top: 300, bottom: 320, left: 500, width: 20 }, contentRect });
  assert.equal(tip.element.style.left, frozen, 'horizontal frozen while editing');
  // A different construct → re-anchors horizontally.
  tip.update({ node: n, key: 9, caretRect: { top: 300, bottom: 320, left: 500, width: 20 }, contentRect });
  assert.notEqual(tip.element.style.left, frozen, 're-anchors for a new construct');
});

test('flips below when there is no room above the construct', () => {
  const host = fakeHost();
  const tip = createMathTooltip(host);
  const n = host.ownerDocument.createElement('svg');
  // caret near the content top: content-Y is small → no room above → below.
  tip.update({
    node: n, key: 5,
    caretRect: { top: 105, bottom: 125, left: 200, width: 20 },
    contentRect: { top: 100, left: 40 },
  });
  assert.equal(tip.element.classList.contains('math-tooltip-below'), true);
});

test('mount re-parents the tooltip into the given element', () => {
  const host = fakeHost();
  const tip = createMathTooltip(host);
  const doc = host.ownerDocument;
  const contentA = doc.createElement('div');
  const contentB = doc.createElement('div');
  tip.mount(contentA);
  assert.equal(tip.element.parentNode, contentA);
  tip.mount(contentB);
  assert.equal(tip.element.parentNode, contentB);
});

test('update applies the configured scale as a CSS variable', () => {
  const host = fakeHost();
  const tip = createMathTooltip(host);
  const n = host.ownerDocument.createElement('svg');
  tip.update({ node: n, key: 5, scale: 2, anchorRect: null });
  assert.equal(tip.element.style['--math-tooltip-scale'], '2');
});
