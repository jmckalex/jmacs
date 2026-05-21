import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuffer } from '@editor/buffer';
import { applyIntent, handleKeyEvent } from '../src/commands.js';

/** Build a key event with sensible defaults. */
function key(over) {
  return {
    key: '',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...over,
  };
}

test('applyIntent inserts text', () => {
  const buf = createBuffer();
  assert.equal(applyIntent(buf, { type: 'insert', text: 'hi' }), true);
  assert.equal(buf.text, 'hi');
});

test('applyIntent runs a movement command with extend', () => {
  const buf = createBuffer('hello');
  buf.moveTo(0);
  applyIntent(buf, { type: 'command', name: 'moveRight', extend: true });
  assert.equal(buf.point, 1);
  assert.deepEqual(buf.selection, { start: 0, end: 1 });
});

test('applyIntent runs delete and history commands', () => {
  const buf = createBuffer('hello');
  buf.moveTo(5);
  applyIntent(buf, { type: 'command', name: 'deleteBackward' });
  assert.equal(buf.text, 'hell');
  applyIntent(buf, { type: 'command', name: 'undo' });
  assert.equal(buf.text, 'hello');
});

test('applyIntent returns false for a null intent', () => {
  assert.equal(applyIntent(createBuffer(), null), false);
});

test('applyIntent returns false for an unknown command', () => {
  assert.equal(
    applyIntent(createBuffer(), { type: 'command', name: 'fly' }),
    false
  );
});

test('handleKeyEvent types a character end to end', () => {
  const buf = createBuffer();
  assert.equal(handleKeyEvent(buf, key({ key: 'x' })), true);
  assert.equal(buf.text, 'x');
});

test('handleKeyEvent moves the cursor end to end', () => {
  const buf = createBuffer('hello');
  buf.moveTo(0);
  handleKeyEvent(buf, key({ key: 'ArrowRight' }));
  assert.equal(buf.point, 1);
});

test('handleKeyEvent reports an unhandled key', () => {
  assert.equal(handleKeyEvent(createBuffer(), key({ key: 'F5' })), false);
});

test('typing a word through key events composes', () => {
  const buf = createBuffer();
  for (const ch of 'hello') handleKeyEvent(buf, key({ key: ch }));
  handleKeyEvent(buf, key({ key: 'Enter' }));
  for (const ch of 'world') handleKeyEvent(buf, key({ key: ch }));
  assert.equal(buf.text, 'hello\nworld');
});
