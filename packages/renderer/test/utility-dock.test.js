/**
 * @file utility-dock.test.js — unit tests for the pure tab-state reducer of
 * the utility dock. The DOM host factory is exercised live; the reducer
 * (add/remove/activate/cycle and the strip-visibility rule) is tested here
 * without a DOM, mirroring the reftex-panel test convention.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyUtilityState,
  addTab,
  removeTab,
  activateTab,
  nextTabId,
  tabsVisible,
  activeTab,
} from '../src/utility-dock.js';

const repl = { id: 'repl-view', title: 'REPL', closable: false, modal: false };
const cite = { id: 'reftex-cite', title: 'Insert citation', closable: true, modal: true };
const doc = { id: 'doc:Intro', title: 'Intro', closable: true, modal: true };

// --- addTab -----------------------------------------------------------

test('addTab appends a new tab and makes it active', () => {
  const s = addTab(emptyUtilityState(), repl);
  assert.deepEqual(s.tabs.map((t) => t.id), ['repl-view']);
  assert.equal(s.activeId, 'repl-view');
});

test('addTab on an existing id updates it in place and re-activates', () => {
  let s = addTab(emptyUtilityState(), repl);
  s = addTab(s, cite);
  s = activateTab(s, 'repl-view'); // active elsewhere
  s = addTab(s, { ...cite, title: 'Select citation format' });
  assert.equal(s.tabs.length, 2); // no duplicate
  assert.equal(s.tabs[1].title, 'Select citation format'); // updated
  assert.equal(s.activeId, 'reftex-cite'); // re-activated
});

// --- removeTab --------------------------------------------------------

test('removeTab refuses a non-closable tab', () => {
  const s = addTab(emptyUtilityState(), repl);
  assert.equal(removeTab(s, 'repl-view'), s); // unchanged (same ref)
});

test('removeTab drops a closable tab and falls back to the resident', () => {
  let s = addTab(emptyUtilityState(), repl);
  s = addTab(s, cite); // active = cite
  s = removeTab(s, 'reftex-cite');
  assert.deepEqual(s.tabs.map((t) => t.id), ['repl-view']);
  assert.equal(s.activeId, 'repl-view'); // active fell back
});

test('removeTab on a background tab keeps the active one', () => {
  let s = addTab(emptyUtilityState(), repl);
  s = addTab(s, cite);
  s = addTab(s, doc); // active = doc
  s = removeTab(s, 'reftex-cite'); // remove a background tab
  assert.deepEqual(s.tabs.map((t) => t.id), ['repl-view', 'doc:Intro']);
  assert.equal(s.activeId, 'doc:Intro'); // unchanged
});

test('removeTab picks the right neighbour when the active middle tab closes', () => {
  let s = addTab(emptyUtilityState(), repl);
  s = addTab(s, cite);
  s = addTab(s, doc);
  s = activateTab(s, 'reftex-cite'); // active = middle
  s = removeTab(s, 'reftex-cite');
  assert.equal(s.activeId, 'doc:Intro'); // the tab that shifted into the slot
});

test('removeTab is a no-op for an absent id', () => {
  const s = addTab(emptyUtilityState(), repl);
  assert.equal(removeTab(s, 'nope'), s);
});

// --- activateTab ------------------------------------------------------

test('activateTab switches to an existing tab', () => {
  let s = addTab(emptyUtilityState(), repl);
  s = addTab(s, cite);
  s = activateTab(s, 'repl-view');
  assert.equal(s.activeId, 'repl-view');
});

test('activateTab is a no-op for an absent id', () => {
  const s = addTab(emptyUtilityState(), repl);
  assert.equal(activateTab(s, 'nope'), s);
});

// --- nextTabId (cycle) ------------------------------------------------

test('nextTabId wraps in both directions', () => {
  let s = addTab(emptyUtilityState(), repl);
  s = addTab(s, cite);
  s = addTab(s, doc); // active = doc (index 2)
  assert.equal(nextTabId(s, 1), 'repl-view'); // wrap forward
  assert.equal(nextTabId(s, -1), 'reftex-cite'); // back one
  s = activateTab(s, 'repl-view'); // index 0
  assert.equal(nextTabId(s, -1), 'doc:Intro'); // wrap backward
});

test('nextTabId is null with no tabs', () => {
  assert.equal(nextTabId(emptyUtilityState(), 1), null);
});

// --- tabsVisible / activeTab ------------------------------------------

test('tabsVisible flips at the second tab', () => {
  let s = addTab(emptyUtilityState(), repl);
  assert.equal(tabsVisible(s), false); // only the REPL → strip hidden
  s = addTab(s, cite);
  assert.equal(tabsVisible(s), true);
});

test('activeTab resolves the active record, or null', () => {
  assert.equal(activeTab(emptyUtilityState()), null);
  const s = addTab(emptyUtilityState(), repl);
  assert.equal(activeTab(s).id, 'repl-view');
});
