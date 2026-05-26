import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '@editor/buffer';
import { createView, viewFilePath } from '../src/index.js';

test('viewFilePath returns null for a null/undefined view', () => {
  assert.equal(viewFilePath(null), null);
  assert.equal(viewFilePath(undefined), null);
});

test('viewFilePath returns null when a text view has no buffer.filePath', () => {
  const buffer = createBuffer('hi', { name: 'scratch' });
  const view = createView({ kind: 'text', buffer });
  assert.equal(viewFilePath(view), null);
});

test('viewFilePath reads buffer.filePath for a text view', () => {
  const buffer = createBuffer('hi', { name: 'hello.txt' });
  buffer.filePath = '/tmp/hello.txt';
  const view = createView({ kind: 'text', buffer });
  assert.equal(viewFilePath(view), '/tmp/hello.txt');
});

test('viewFilePath reads view.filePath for non-text views', () => {
  const view = createView({
    kind: 'image',
    extras: { filePath: '/tmp/pic.png' },
  });
  assert.equal(viewFilePath(view), '/tmp/pic.png');
});

test('viewFilePath returns null for non-text views with no filePath', () => {
  const view = createView({ kind: 'shell', extras: { sessionId: 's1' } });
  assert.equal(viewFilePath(view), null);
});

test('viewFilePath prefers buffer.filePath over view.filePath when both exist', () => {
  const buffer = createBuffer('hi', { name: 'a' });
  buffer.filePath = '/buffer/path';
  const view = createView({
    kind: 'text',
    buffer,
    extras: { filePath: '/view/path' },
  });
  assert.equal(viewFilePath(view), '/buffer/path');
});
