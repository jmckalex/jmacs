import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '@editor/buffer';
import {
  createView,
  isView,
  isTablineView,
  tablineActiveChild,
  createKindRegistry,
} from '../src/index.js';

test('createView requires a kind', () => {
  assert.throws(() => createView({}), /kind is required/);
  assert.throws(() => createView({ kind: '' }), /kind is required/);
});

test('a text view holds an L2 buffer; name comes from the buffer', () => {
  const buffer = createBuffer('hi', { name: 'hello.txt' });
  const view = createView({ kind: 'text', buffer });
  assert.equal(view.kind, 'text');
  assert.equal(view.buffer, buffer);
  assert.equal(view.name, 'hello.txt');
  // No view-level mode for text views — modes live on the buffer.
  assert.equal(view.mode, null);
});

test('a text view starts with its own point=0 and mark=null', () => {
  const buffer = createBuffer('hi', { name: 'hello.txt' });
  const view = createView({ kind: 'text', buffer });
  assert.equal(view.point, 0);
  assert.equal(view.mark, null);
});

test('a non-text view leaves point and mark undefined', () => {
  const view = createView({ kind: 'image', extras: { src: 'data:...' } });
  assert.equal(view.point, undefined);
  assert.equal(view.mark, undefined);
});

test('createView honours explicit point and mark options', () => {
  const buffer = createBuffer('hello', { name: 'x.txt' });
  const view = createView({ kind: 'text', buffer, point: 3, mark: 1 });
  assert.equal(view.point, 3);
  assert.equal(view.mark, 1);
});

test('binding a text view to its buffer routes cursor reads/writes', () => {
  const buffer = createBuffer('hello', { name: 'x.txt' });
  const view = createView({ kind: 'text', buffer });
  buffer.bindCursor(view);
  buffer.moveTo(3);
  assert.equal(view.point, 3, 'the view owns the cursor');
  buffer.insert('!');
  assert.equal(view.point, 4);
});

test('a non-text view has no buffer; extras spread onto the view', () => {
  const view = createView({ kind: 'image', extras: { src: 'data:...' } });
  assert.equal(view.kind, 'image');
  assert.equal(view.buffer, null);
  assert.equal(view.src, 'data:...');
});

test('name falls back to *kind* when neither name nor buffer is given', () => {
  const view = createView({ kind: 'tabline' });
  assert.equal(view.name, '*tabline*');
});

test('explicit name overrides the buffer name', () => {
  const buffer = createBuffer('', { name: 'on-buffer' });
  const view = createView({ kind: 'text', buffer, name: 'on-view' });
  assert.equal(view.name, 'on-view');
});

test('isView recognises view-shaped objects', () => {
  const view = createView({ kind: 'text', buffer: createBuffer('') });
  assert.equal(isView(view), true);
  assert.equal(isView({}), false);
  assert.equal(isView(null), false);
  assert.equal(isView({ kind: 'text' }), false); // missing buffer
});

test('each view gets a unique id', () => {
  const v1 = createView({ kind: 'text', buffer: createBuffer('') });
  const v2 = createView({ kind: 'text', buffer: createBuffer('') });
  assert.notEqual(v1.id, v2.id);
});

test('registry: register + lookup', () => {
  const registry = createKindRegistry();
  const mounted = [];
  registry.register('text', { hasBuffer: true, mount: (v) => mounted.push(v) });
  assert.equal(registry.has('text'), true);
  assert.equal(registry.has('image'), false);
  assert.deepEqual(registry.kinds(), ['text']);
  const spec = registry.get('text');
  assert.equal(spec.hasBuffer, true);
});

test('registry: mount dispatches to the spec', () => {
  const registry = createKindRegistry();
  const mounted = [];
  registry.register('image', { hasBuffer: false, mount: (v) => mounted.push(v) });
  const view = createView({ kind: 'image' });
  registry.mount(view);
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0], view);
});

test('registry: mount throws for an unknown kind', () => {
  const registry = createKindRegistry();
  const view = createView({ kind: 'mystery' });
  assert.throws(() => registry.mount(view), /unknown view kind: mystery/);
});

test('registry: dispose runs the spec hook when present', () => {
  const registry = createKindRegistry();
  const disposed = [];
  registry.register('shell', {
    hasBuffer: false,
    mount: () => {},
    dispose: (v) => disposed.push(v),
  });
  const view = createView({ kind: 'shell' });
  registry.dispose(view);
  assert.deepEqual(disposed, [view]);
});

test('registry: dispose is a no-op for a spec without a dispose hook', () => {
  const registry = createKindRegistry();
  registry.register('image', { hasBuffer: false, mount: () => {} });
  const view = createView({ kind: 'image' });
  // Should not throw.
  registry.dispose(view);
});

test('registry: register rejects duplicate kinds', () => {
  const registry = createKindRegistry();
  registry.register('text', { hasBuffer: true, mount: () => {} });
  assert.throws(
    () => registry.register('text', { hasBuffer: true, mount: () => {} }),
    /already registered: text/
  );
});

test('registry: register rejects a spec without a mount function', () => {
  const registry = createKindRegistry();
  assert.throws(
    () => registry.register('bad', { hasBuffer: false }),
    /spec\.mount is required/
  );
});

test('registry: dispose silently ignores an unregistered kind', () => {
  const registry = createKindRegistry();
  const view = createView({ kind: 'mystery' });
  registry.dispose(view); // no throw — defensive.
});

// --- tabline-view shape -------------------------------------------------
// A tabline-view is a structural view: it has no buffer and instead
// carries a `tabs` list, an `active` index, and an `edge`. The shape
// defaults sensibly so a bare `createView({ kind: 'tabline' })` is
// usable (empty top-edge strip).

test('a tabline-view has no buffer and defaults tabs/active/edge', () => {
  const tlv = createView({ kind: 'tabline' });
  assert.equal(tlv.kind, 'tabline');
  assert.equal(tlv.buffer, null);
  assert.deepEqual(tlv.tabs, []);
  assert.equal(tlv.active, 0);
  assert.equal(tlv.edge, 'top');
});

test('a tabline-view accepts initial tabs/active/edge through extras', () => {
  const a = createView({ kind: 'text', buffer: createBuffer('', { name: 'a' }) });
  const b = createView({ kind: 'text', buffer: createBuffer('', { name: 'b' }) });
  const tlv = createView({
    kind: 'tabline',
    extras: { tabs: [a, b], active: 1, edge: 'bottom' },
  });
  assert.equal(tlv.tabs.length, 2);
  assert.equal(tlv.tabs[0], a);
  assert.equal(tlv.tabs[1], b);
  assert.equal(tlv.active, 1);
  assert.equal(tlv.edge, 'bottom');
});

test('a tabline-view defaults width to null and accepts width through extras', () => {
  const bare = createView({ kind: 'tabline' });
  assert.equal(bare.width, null);

  const sized = createView({ kind: 'tabline', extras: { edge: 'left', width: 220 } });
  assert.equal(sized.width, 220);

  // Non-numeric width gets normalised away — a callers' bad extras
  // shouldn't leave the view in an unusable state.
  const bogus = createView({ kind: 'tabline', extras: { width: 'wide' } });
  assert.equal(bogus.width, null);
});

test('isTablineView recognises a tabline-view and rejects other shapes', () => {
  const tlv = createView({ kind: 'tabline' });
  assert.equal(isTablineView(tlv), true);

  const text = createView({ kind: 'text', buffer: createBuffer('') });
  assert.equal(isTablineView(text), false);

  assert.equal(isTablineView(null), false);
  assert.equal(isTablineView({}), false);
  // A kind: 'tabline' object missing `tabs` isn't a tabline-view (it
  // wasn't built through createView).
  assert.equal(isTablineView({ kind: 'tabline', buffer: null }), false);
});

test('tablineActiveChild returns the active child', () => {
  const a = createView({ kind: 'text', buffer: createBuffer('', { name: 'a' }) });
  const b = createView({ kind: 'text', buffer: createBuffer('', { name: 'b' }) });
  const tlv = createView({
    kind: 'tabline',
    extras: { tabs: [a, b], active: 1 },
  });
  assert.equal(tablineActiveChild(tlv), b);
  tlv.active = 0;
  assert.equal(tablineActiveChild(tlv), a);
});

test('tablineActiveChild returns null for empty tabs or out-of-range active', () => {
  const tlv = createView({ kind: 'tabline' });
  assert.equal(tablineActiveChild(tlv), null);

  const a = createView({ kind: 'text', buffer: createBuffer('') });
  const tlv2 = createView({ kind: 'tabline', extras: { tabs: [a], active: 5 } });
  assert.equal(tablineActiveChild(tlv2), null);
});

test('tablineActiveChild returns null for non-tabline values', () => {
  const text = createView({ kind: 'text', buffer: createBuffer('') });
  assert.equal(tablineActiveChild(text), null);
  assert.equal(tablineActiveChild(null), null);
  assert.equal(tablineActiveChild(undefined), null);
});
