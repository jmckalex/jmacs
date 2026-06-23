/**
 * @file Tests for mwb/data-source.js — the non-text source-of-truth registry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDataSourceRegistry } from './data-source.js';

test('add mints a ds-prefixed id and a descriptor; get/has/list/remove', () => {
  const ds = createDataSourceRegistry();
  const a = ds.add({ kind: 'video', name: 'clip.mp4', filePath: '/v/clip.mp4' });
  assert.match(a.id, /^ds\d+$/, 'distinct from buffer b-ids');
  assert.equal(ds.has(a.id), true);
  assert.equal(ds.get(a.id), a);
  assert.deepEqual(ds.descriptor(a.id), {
    viewKind: 'video', name: 'clip.mp4', filePath: '/v/clip.mp4', state: {},
  });
  assert.equal(ds.list().length, 1);
  assert.equal(ds.remove(a.id), true);
  assert.equal(ds.has(a.id), false);
  assert.equal(ds.descriptor(a.id), null);
});

test('findByPath reuses an open source (find-file reuse for media)', () => {
  const ds = createDataSourceRegistry();
  const a = ds.add({ kind: 'image', name: 'p.png', filePath: '/p.png' });
  assert.equal(ds.findByPath('/p.png'), a);
  assert.equal(ds.findByPath('/other.png'), null);
  assert.equal(ds.findByPath(''), null);
});

test('add defaults: name falls back to *kind*, filePath to null, state to {}', () => {
  const ds = createDataSourceRegistry();
  const a = ds.add({ kind: 'stella' });
  assert.equal(a.name, '*stella*');
  assert.equal(a.filePath, null);
  assert.deepEqual(a.state, {});
});

test('setState replaces shared state and fires the fan-out seam', () => {
  const changes = [];
  const ds = createDataSourceRegistry({ onStateChange: (id, s) => changes.push([id, s.state]) });
  const a = ds.add({ kind: 'stella', name: 'Adventure' });
  assert.equal(ds.setState(a.id, { rom: 'adventure.bin' }), true);
  assert.deepEqual(a.state, { rom: 'adventure.bin' });
  assert.deepEqual(ds.descriptor(a.id).state, { rom: 'adventure.bin' });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], [a.id, { rom: 'adventure.bin' }]);
  assert.equal(ds.setState('nope', {}), false, 'unknown id');
});
