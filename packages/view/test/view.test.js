import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '@editor/buffer';
import { createView, isView, createKindRegistry } from '../src/index.js';

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

test('a non-text view has no buffer; state defaults to an empty object', () => {
  const view = createView({ kind: 'image', state: { src: 'data:...' } });
  assert.equal(view.kind, 'image');
  assert.equal(view.buffer, null);
  assert.deepEqual(view.state, { src: 'data:...' });
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
  assert.equal(isView({ kind: 'text' }), false); // missing buffer/state
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
