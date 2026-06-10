/**
 * @file Lifecycle / behaviour tests for the `<tabline-view>` custom
 * element (`tabline-view.js`) — the per-pane container that holds N tab
 * views and renders the tab strip.
 *
 * Why a hand-built DOM: there is no jsdom in this repo, and the existing
 * renderer convention is a minimal fake DOM that implements only what the
 * code under test touches (see `splitter.test.js`, `markdown-preview.test.js`).
 * `tabline-view.js` is heavier than those — it appends real child
 * elements, toggles attributes, queries `:scope > [active]`, and mounts
 * the `tabline.js` strip widget (which builds tab DOM and dispatches
 * `tab-close`). So this file provides a compact but faithful DOM that
 * supports element trees, attributes/dataset, `classList`, the single
 * `querySelector(':scope > [active]')` selector the element uses, and
 * bubbling `dispatchEvent`. That lets us drive the element exactly as the
 * host does and assert *its* observable behaviour, not the fake DOM's.
 *
 * The fake is installed on `globalThis` BEFORE importing the module under
 * test, because `view-elements.js` chooses its `ViewElement` base class
 * (`HTMLElement` vs a Node stub) at module-evaluation time; with the fake
 * present, `class TablineView extends ViewElement` extends our Node and
 * `new TablineView()` constructs a working element.
 *
 * Coverage: add / insert / append-out-of-range; remove (active vs
 * non-active, last tab, out-of-range guard); active re-anchoring when the
 * active tab is closed; activate (clears siblings, out-of-range no-op);
 * reorder (up, down, no-op cases); the Q9 single-parent move invariant;
 * `tab-close` event dispatch + bubbling (incl. via the strip's close
 * button); the edge accessor; and destroy() teardown (DOM removed, nulled,
 * idempotent, later mutations are safe no-ops).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- minimal fake DOM -------------------------------------------------

class FakeClassList {
  constructor() { this._set = new Set(); }
  add(...cs) { for (const c of cs) this._set.add(c); }
  remove(...cs) { for (const c of cs) this._set.delete(c); }
  contains(c) { return this._set.has(c); }
  get value() { return [...this._set].join(' '); }
}

class FakeNode {
  constructor(tag) {
    this.localName = String(tag || '').toLowerCase();
    this.children = [];
    this.parentNode = null;
    this._attrs = new Map();
    this.classList = new FakeClassList();
    this.dataset = {};
    // `style` is touched by tabline.js only via `.dataset`/`className`;
    // a permissive proxy keeps any stray `style.foo = …` harmless.
    this.style = new Proxy({}, { get: () => '', set: () => true });
    this._listeners = new Map();
    this.textContent = '';
    this.title = '';
    this.type = '';
    this.draggable = false;
    this.ownerDocument = fakeDocument;
  }

  get className() { return this.classList.value; }
  set className(v) {
    this.classList = new FakeClassList();
    if (v) for (const c of String(v).split(/\s+/).filter(Boolean)) this.classList.add(c);
  }

  setAttribute(n, v) {
    this._attrs.set(n, String(v));
    if (n === 'class') this.className = String(v);
    if (n.startsWith('data-')) this.dataset[dataKey(n)] = String(v);
  }
  getAttribute(n) {
    if (n === 'class') return this.className || null;
    return this._attrs.has(n) ? this._attrs.get(n) : null;
  }
  hasAttribute(n) {
    if (n === 'class') return this.className !== '';
    return this._attrs.has(n);
  }
  removeAttribute(n) {
    this._attrs.delete(n);
    if (n.startsWith('data-')) delete this.dataset[dataKey(n)];
  }

  _adopt(node) { if (node.parentNode) node.parentNode._detach(node); node.parentNode = this; }
  _detach(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
  }
  append(...kids) { for (const k of kids) { this._adopt(k); this.children.push(k); } }
  appendChild(k) { this._adopt(k); this.children.push(k); return k; }
  insertBefore(node, ref) {
    this._adopt(node);
    if (ref == null) { this.children.push(node); return node; }
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(node); else this.children.splice(i, 0, node);
    return node;
  }
  removeChild(k) { this._detach(k); return k; }
  remove() { if (this.parentNode) this.parentNode._detach(this); }
  replaceChildren(...kids) {
    for (const c of [...this.children]) this._detach(c);
    this.children = [];
    this.append(...kids);
  }

  querySelector(sel) {
    if (sel === ':scope > [active]') {
      return this.children.find((c) => c.hasAttribute('active')) ?? null;
    }
    throw new Error(`fake-dom querySelector: unsupported selector ${sel}`);
  }
  querySelectorAll(sel) {
    const out = [];
    const want = sel.replace(/^\./, '');
    this._walk((c) => { if (c.classList.contains(want)) out.push(c); });
    return out;
  }
  _walk(fn) { for (const c of this.children) { fn(c); c._walk(fn); } }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    let node = this;
    while (node) {
      event.currentTarget = node;
      const set = node._listeners.get(event.type);
      if (set) for (const fn of [...set]) fn(event);
      if (!event.bubbles) break;
      node = node.parentNode;
    }
    return !event.defaultPrevented;
  }

  focus() { this._focused = true; }
}

function dataKey(attr) {
  return attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
    this.bubbles = !!init.bubbles;
    this.composed = !!init.composed;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.bubbles = false; }
}

const fakeDocument = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => { const n = new FakeNode('#text'); n.textContent = text; return n; },
};

// Install on globalThis before importing the module under test (see file
// header for why the order matters).
globalThis.document = fakeDocument;
globalThis.CustomEvent = FakeCustomEvent;
globalThis.HTMLElement = FakeNode;
globalThis.customElements = { get: () => undefined, define: () => {} };

const { TablineView } = await import('../src/tabline-view.js');

// --- helpers ----------------------------------------------------------

/** A document root the tabline can be parented under (so events bubble). */
function makeRoot() { return new FakeNode('div'); }

/** A stand-in tab view element: just a node carrying a `name`. */
function makeTab(name) {
  const n = new FakeNode('text-view');
  n.name = name;
  return n;
}

/** A connected tabline pre-seeded with NAMES as tabs. */
function freshTabline(names = [], root = makeRoot()) {
  const tl = new TablineView();
  root.append(tl);
  tl.connectedCallback();
  for (const n of names) tl.addTab(makeTab(n));
  return tl;
}

/** Tab labels in document order. */
const labelsOf = (tl) => tl.tabs.map((t) => t.name);

// --- initial state ----------------------------------------------------

test('a connected tabline mounts a strip + content and starts empty', () => {
  const tl = freshTabline();
  assert.equal(tl.tabCount, 0);
  assert.equal(tl.activeChild, null);
  assert.equal(tl.activeIndex, -1);
  // Inner structural children: the strip and the content container.
  assert.ok(tl.children.some((c) => c.classList.contains('tabline-strip')));
  assert.ok(tl.children.some((c) => c.classList.contains('tabline-content')));
  // Defaults to the top edge.
  assert.equal(tl.edge, 'top');
});

// --- addTab -----------------------------------------------------------

test('addTab appends in order', () => {
  const tl = freshTabline(['a', 'b', 'c']);
  assert.equal(tl.tabCount, 3);
  assert.deepEqual(labelsOf(tl), ['a', 'b', 'c']);
});

test('addTab with an in-range index inserts at that position', () => {
  const tl = freshTabline(['a', 'b', 'c']);
  tl.addTab(makeTab('x'), 1);
  assert.deepEqual(labelsOf(tl), ['a', 'x', 'b', 'c']);
});

test('addTab with an out-of-range or negative index appends', () => {
  const hi = freshTabline(['a', 'b']);
  hi.addTab(makeTab('z'), 99);
  assert.deepEqual(labelsOf(hi), ['a', 'b', 'z']);

  const lo = freshTabline(['a', 'b']);
  lo.addTab(makeTab('z'), -1);
  assert.deepEqual(labelsOf(lo), ['a', 'b', 'z']);
});

test('a newly added tab does not become active', () => {
  const tl = freshTabline(['a']);
  tl.activateTab(0);
  tl.addTab(makeTab('b'));
  assert.equal(tl.activeChild.name, 'a'); // still 'a', not the new tab
});

// --- activateTab ------------------------------------------------------

test('activateTab sets [active] on the target and clears it from siblings', () => {
  const tl = freshTabline(['a', 'b', 'c']);
  tl.activateTab(0);
  tl.activateTab(2);
  const active = tl.tabs.filter((t) => t.hasAttribute('active')).map((t) => t.name);
  assert.deepEqual(active, ['c']); // exactly one active tab
  assert.equal(tl.activeIndex, 2);
});

test('activateTab focuses the newly active tab', () => {
  const tl = freshTabline(['a', 'b']);
  tl.activateTab(1);
  assert.equal(tl.tabs[1]._focused, true);
});

test('activateTab with an out-of-range index is a no-op', () => {
  const tl = freshTabline(['a', 'b']);
  tl.activateTab(1);
  tl.activateTab(99);
  assert.equal(tl.activeChild.name, 'b'); // unchanged
  tl.activateTab(-1);
  assert.equal(tl.activeChild.name, 'b');
});

// --- removeTab + active re-anchoring ----------------------------------

test('removeTab returns the (now unparented) element', () => {
  const tl = freshTabline(['a', 'b']);
  const removed = tl.removeTab(0);
  assert.equal(removed.name, 'a');
  assert.equal(removed.parentNode, null); // detached, caller owns it
  assert.deepEqual(labelsOf(tl), ['b']);
});

test('removing the ACTIVE tab re-anchors active onto the previous sibling', () => {
  const tl = freshTabline(['a', 'b', 'c']);
  tl.activateTab(1); // 'b' active
  tl.removeTab(1);
  // max(0, index-1) === 0 → 'a' (now at index 0) becomes active.
  assert.equal(tl.activeChild.name, 'a');
  assert.equal(tl.activeIndex, 0);
});

test('removing the FIRST active tab re-anchors onto the new first tab', () => {
  const tl = freshTabline(['a', 'b', 'c']);
  tl.activateTab(0);
  tl.removeTab(0);
  // max(0, 0-1) === 0 → the new index-0 ('b') takes active.
  assert.equal(tl.activeChild.name, 'b');
  assert.equal(tl.activeIndex, 0);
});

test('removing a NON-active tab leaves the active tab active', () => {
  const tl = freshTabline(['a', 'b', 'c']);
  tl.activateTab(2); // 'c'
  tl.removeTab(0); // drop 'a'
  assert.equal(tl.activeChild.name, 'c');
  assert.equal(tl.activeIndex, 1); // shifted down by the removal
});

test('removing the only (active) tab leaves nothing active', () => {
  const tl = freshTabline(['solo']);
  tl.activateTab(0);
  tl.removeTab(0);
  assert.equal(tl.tabCount, 0);
  assert.equal(tl.activeChild, null);
  assert.equal(tl.activeIndex, -1);
});

test('removeTab with an out-of-range index returns null and changes nothing', () => {
  const tl = freshTabline(['a']);
  assert.equal(tl.removeTab(5), null);
  assert.equal(tl.removeTab(-1), null);
  assert.deepEqual(labelsOf(tl), ['a']);
});

// --- reorderTab -------------------------------------------------------

test('reorderTab moves a tab downward (to a higher index)', () => {
  const tl = freshTabline(['a', 'b', 'c', 'd']);
  tl.reorderTab(1, 3); // move 'b' to index 3
  assert.deepEqual(labelsOf(tl), ['a', 'c', 'd', 'b']);
});

test('reorderTab moves a tab upward (to a lower index)', () => {
  const tl = freshTabline(['a', 'b', 'c', 'd']);
  tl.reorderTab(3, 1); // move 'd' to index 1
  assert.deepEqual(labelsOf(tl), ['a', 'd', 'b', 'c']);
});

test('reorderTab is a no-op for equal or out-of-range indices', () => {
  const tl = freshTabline(['a', 'b', 'c']);
  tl.reorderTab(1, 1);
  tl.reorderTab(0, 99);
  tl.reorderTab(-1, 1);
  assert.deepEqual(labelsOf(tl), ['a', 'b', 'c']);
});

// --- Q9 single-parent move invariant ----------------------------------

test('adding a tab already in another tabline moves it (DOM single-parent)', () => {
  const root = makeRoot();
  const tlA = freshTabline(['a', 'b'], root);
  const tlB = freshTabline([], root);
  const moved = tlA.tabs[0]; // 'a'
  tlB.addTab(moved);
  assert.deepEqual(labelsOf(tlA), ['b']); // 'a' left A
  assert.deepEqual(labelsOf(tlB), ['a']); // and is now in B
  assert.equal(moved.parentNode, tlB._contentEl); // single parent: B's content
});

// --- tab-close dispatch -----------------------------------------------

test('_dispatchTabClose emits a bubbling tab-close with {view, index}', () => {
  const root = makeRoot();
  const tl = freshTabline(['a', 'b'], root);
  let detail = null;
  // Listen on the ROOT to prove the event bubbles up out of the element.
  root.addEventListener('tab-close', (e) => { detail = e.detail; });
  tl._dispatchTabClose(1);
  assert.equal(detail.index, 1);
  assert.equal(detail.view.name, 'b');
});

test('_dispatchTabClose with an out-of-range index emits nothing', () => {
  const root = makeRoot();
  const tl = freshTabline(['a'], root);
  let fired = false;
  root.addEventListener('tab-close', () => { fired = true; });
  tl._dispatchTabClose(9);
  assert.equal(fired, false);
});

// --- strip integration (tabline.js mounted inside the element) --------

test('the strip renders one tab per view, labelled, marking the active one', () => {
  const tl = freshTabline(['alpha', 'beta']);
  tl.activateTab(1);
  const strip = tl.children.find((c) => c.classList.contains('tabline-strip'));
  const tablineEl = strip.children[0]; // the <div class="tabline">
  const tabEls = tablineEl.children;
  assert.equal(tabEls.length, 2);
  assert.deepEqual(tabEls.map((t) => t.children[0].textContent), ['alpha', 'beta']);
  assert.deepEqual(
    tabEls.map((t) => t.classList.contains('is-current')),
    [false, true]
  );
});

test('clicking a strip tab’s close button dispatches tab-close for that index', () => {
  const root = makeRoot();
  const tl = freshTabline(['alpha', 'beta'], root);
  let detail = null;
  root.addEventListener('tab-close', (e) => { detail = e.detail; });
  const tablineEl = tl.children
    .find((c) => c.classList.contains('tabline-strip')).children[0];
  const closeBtn = tablineEl.children[0].children[1]; // tab 0's '×' button
  assert.equal(closeBtn.textContent, '×');
  closeBtn.dispatchEvent(new FakeCustomEvent('click', { bubbles: true }));
  assert.equal(detail.index, 0);
  assert.equal(detail.view.name, 'alpha');
});

// --- edge accessor ----------------------------------------------------

test('the edge accessor round-trips through data-edge and rejects bad values', () => {
  const tl = freshTabline();
  assert.equal(tl.edge, 'top');
  tl.edge = 'left';
  assert.equal(tl.edge, 'left');
  assert.equal(tl.getAttribute('data-edge'), 'left');
  tl.edge = 'bogus';
  assert.equal(tl.edge, 'top'); // invalid → falls back to 'top'
});

// --- destroy: teardown + idempotence + leak guard ---------------------

test('destroy removes the strip + content and nulls the internals', () => {
  const tl = freshTabline(['a', 'b']);
  tl.destroy();
  assert.equal(tl.tabCount, 0); // _contentEl gone → guard returns 0
  assert.equal(tl._stripEl, null);
  assert.equal(tl._contentEl, null);
  assert.equal(tl._stripWidget, null);
  // The structural children are detached from the element.
  assert.equal(tl.children.some((c) => c.classList.contains('tabline-content')), false);
});

test('destroy does NOT destroy the child tabs (they may be re-parented)', () => {
  const tl = freshTabline(['a', 'b']);
  const tabs = tl.tabs; // snapshot before teardown
  tl.destroy();
  // Tabs are plain nodes; destroy must not have thrown or mutated them.
  assert.deepEqual(tabs.map((t) => t.name), ['a', 'b']);
});

test('destroy is idempotent and post-destroy mutations are safe no-ops', () => {
  const tl = freshTabline(['a']);
  tl.destroy();
  assert.doesNotThrow(() => tl.destroy()); // second teardown
  // After teardown the mutation API guards on the nulled content element.
  assert.equal(tl.removeTab(0), null);
  assert.doesNotThrow(() => tl.reorderTab(0, 0));
  assert.doesNotThrow(() => tl.activateTab(0));
  assert.equal(tl.tabCount, 0);
});
