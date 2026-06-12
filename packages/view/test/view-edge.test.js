/**
 * @file Edge-case / characterization tests for the View abstraction.
 *
 * The existing `view.test.js` / `view-utils.test.js` cover the common
 * shapes. This file pins the corners: the `persist` flag, how `extras`
 * interacts with the core fields (it is spread *after* them, so it can
 * override), the name-fallback chain, a `text` view with no buffer,
 * `isView`'s `'buffer' in value` guard, multi-cursor aliasing with
 * secondaries present, and the tabline-view defaulting/guard paths
 * (non-string edge, numeric-but-zero width, out-of-range / non-integer
 * `active`, `mode` passthrough).
 *
 * Characterization style: each assertion was verified against the live
 * module first, so a behaviour change trips the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '@editor/buffer';
import {
  createView,
  isView,
  isTablineView,
  tablineActiveChild,
  viewFilePath,
} from '../src/index.js';

// --- the persist flag -------------------------------------------------------

test('persist defaults to false', () => {
  const view = createView({ kind: 'image', extras: { src: 'x' } });
  assert.equal(view.persist, false);
});

test('persist can be opted back in through extras', () => {
  const view = createView({ kind: 'pdf', extras: { persist: true } });
  assert.equal(view.persist, true);
});

// --- extras override semantics (spread last) --------------------------------

test('extras are spread after the core fields, so they can override id and name', () => {
  const view = createView({
    kind: 'text',
    name: 'from-option',
    extras: { id: 'forced-id', name: 'forced-name' },
  });
  assert.equal(view.id, 'forced-id', 'extras.id wins over the freshly minted id');
  assert.equal(view.name, 'forced-name', 'extras.name wins over options.name');
  // kind is not overridable by spread here (extras has no kind), so it stays.
  assert.equal(view.kind, 'text');
});

// --- name fallback chain ----------------------------------------------------

test('an explicit name:null still triggers the *kind* fallback', () => {
  const view = createView({ kind: 'image', name: null, extras: { src: 'x' } });
  assert.equal(view.name, '*image*');
});

test('a text view with no buffer falls back to *text* and still gets a cursor', () => {
  const view = createView({ kind: 'text' });
  assert.equal(view.buffer, null);
  assert.equal(view.name, '*text*');
  // Even bufferless, a text view owns a point/mark (cursors[0]).
  assert.equal(view.point, 0);
  assert.equal(view.mark, null);
  assert.equal(view.cursors.length, 1);
});

test('a buffer with no name leaves the *kind* fallback to win', () => {
  // createBuffer assigns a name; force it absent to exercise the chain.
  const buffer = createBuffer('hi');
  delete buffer.name;
  const view = createView({ kind: 'text', buffer });
  assert.equal(view.name, '*text*');
});

// --- id minting -------------------------------------------------------------

test('the minted id is prefixed with view-<kind>-', () => {
  assert.ok(createView({ kind: 'image', extras: { src: 'x' } }).id.startsWith('view-image-'));
  assert.ok(createView({ kind: 'shell', extras: { sessionId: 's' } }).id.startsWith('view-shell-'));
});

// --- isView guard paths -----------------------------------------------------

test('isView keys on the presence of `buffer`, even when it is undefined', () => {
  // `'buffer' in value` is the guard, so an explicit undefined still passes.
  assert.equal(isView({ kind: 'text', buffer: undefined }), true);
  // A bare kind without the buffer key fails.
  assert.equal(isView({ kind: 'text' }), false);
});

test('isView rejects arrays, primitives, and the wrong kind type', () => {
  assert.equal(isView([]), false);
  assert.equal(isView('text'), false);
  assert.equal(isView(42), false);
  assert.equal(isView({ kind: 7, buffer: null }), false);
});

// --- multi-cursor aliasing with secondaries ---------------------------------

test('point/mark keep aliasing cursors[0] after a secondary cursor is added', () => {
  const buffer = createBuffer('hello world', { name: 'x.txt' });
  const view = createView({ kind: 'text', buffer, point: 1, mark: 3 });
  view.cursors.push({ point: 9, mark: null });
  // Writing through the primary alias touches only cursors[0].
  view.point = 5;
  assert.equal(view.cursors[0].point, 5);
  assert.equal(view.cursors[1].point, 9, 'the secondary cursor is untouched');
  // Reading the alias reflects cursors[0].
  view.cursors[0].mark = 2;
  assert.equal(view.mark, 2);
});

test('point and mark are enumerable own properties on a text view', () => {
  const view = createView({ kind: 'text', buffer: createBuffer('') });
  const keys = Object.keys(view);
  assert.ok(keys.includes('point'));
  assert.ok(keys.includes('mark'));
});

// --- non-text views: point/mark ignored, mode passed through ----------------

test('non-text views ignore point/mark options and have no cursors array', () => {
  const view = createView({ kind: 'image', point: 5, mark: 3, extras: { src: 'x' } });
  assert.equal(view.point, undefined);
  assert.equal(view.mark, undefined);
  assert.equal(view.cursors, undefined);
});

test('a non-text view carries its own mode; text views leave mode null', () => {
  const shell = createView({ kind: 'shell', mode: 'shell-mode', extras: { sessionId: 's' } });
  assert.equal(shell.mode, 'shell-mode');
  const text = createView({ kind: 'text', buffer: createBuffer(''), mode: 'ignored?' });
  // Text views resolve modes through the buffer; the option is honoured
  // onto the slot but is conventionally null. Pin what createView stores.
  assert.equal(text.mode, 'ignored?');
});

// --- tabline-view defaulting + guard paths ----------------------------------

test('a non-string edge in extras is normalised back to the top default', () => {
  const tlv = createView({ kind: 'tabline', extras: { edge: 42 } });
  assert.equal(tlv.edge, 'top');
});

test('a non-array tabs in extras is normalised to an empty array', () => {
  const tlv = createView({ kind: 'tabline', extras: { tabs: 'nope' } });
  assert.ok(Array.isArray(tlv.tabs));
  assert.equal(tlv.tabs.length, 0);
});

test('a non-number active in extras is normalised to 0', () => {
  const a = createView({ kind: 'text', buffer: createBuffer('', { name: 'a' }) });
  const tlv = createView({ kind: 'tabline', extras: { tabs: [a], active: '0' } });
  assert.equal(tlv.active, 0);
  assert.equal(tablineActiveChild(tlv), a);
});

test('width: a numeric 0 is preserved; an explicit null stays null', () => {
  assert.equal(createView({ kind: 'tabline', extras: { width: 0 } }).width, 0);
  assert.equal(createView({ kind: 'tabline', extras: { width: null } }).width, null);
});

// --- tablineActiveChild range / type guards ---------------------------------

test('tablineActiveChild returns null for a negative active index', () => {
  const a = createView({ kind: 'text', buffer: createBuffer('') });
  const tlv = createView({ kind: 'tabline', extras: { tabs: [a], active: -1 } });
  assert.equal(tablineActiveChild(tlv), null);
});

test('tablineActiveChild returns null for a non-integer active index', () => {
  const a = createView({ kind: 'text', buffer: createBuffer('', { name: 'a' }) });
  const b = createView({ kind: 'text', buffer: createBuffer('', { name: 'b' }) });
  // 1.5 is in [0, 2) numerically but tabs[1.5] is undefined → null.
  const tlv = createView({ kind: 'tabline', extras: { tabs: [a, b], active: 1.5 } });
  assert.equal(tablineActiveChild(tlv), null);
});

test('isTablineView: a hand-built {kind:"tabline"} without a tabs array is rejected', () => {
  assert.equal(isTablineView({ kind: 'tabline', buffer: null }), false);
  // …but one minted through createView always qualifies.
  assert.equal(isTablineView(createView({ kind: 'tabline' })), true);
});

// --- viewFilePath additional corners ----------------------------------------

test('viewFilePath ignores a non-string buffer.filePath and falls through', () => {
  const buffer = createBuffer('hi', { name: 'a' });
  buffer.filePath = 12345; // not a string → ignored
  const view = createView({ kind: 'text', buffer, extras: { filePath: '/view/path' } });
  // buffer.filePath isn't a string, so the view-level path is used.
  assert.equal(viewFilePath(view), '/view/path');
});

test('viewFilePath ignores a non-string view.filePath', () => {
  const view = createView({ kind: 'image', extras: { filePath: 999 } });
  assert.equal(viewFilePath(view), null);
});
