import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveKey } from '../src/keymap.js';

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

test('a printable character resolves to an insert', () => {
  assert.deepEqual(resolveKey(key({ key: 'a' })), {
    type: 'insert',
    text: 'a',
  });
});

test('space is an insert', () => {
  assert.deepEqual(resolveKey(key({ key: ' ' })), {
    type: 'insert',
    text: ' ',
  });
});

test('Enter inserts a newline, Tab inserts spaces', () => {
  assert.deepEqual(resolveKey(key({ key: 'Enter' })).text, '\n');
  assert.deepEqual(resolveKey(key({ key: 'Tab' })).text, '  ');
});

test('Backspace and Delete resolve to delete commands', () => {
  assert.equal(resolveKey(key({ key: 'Backspace' })).name, 'deleteBackward');
  assert.equal(resolveKey(key({ key: 'Delete' })).name, 'deleteForward');
});

test('arrow keys resolve to movement without extend', () => {
  assert.deepEqual(resolveKey(key({ key: 'ArrowLeft' })), {
    type: 'command',
    name: 'moveLeft',
    extend: false,
  });
});

test('shift with an arrow extends the selection', () => {
  assert.equal(resolveKey(key({ key: 'ArrowRight', shiftKey: true })).extend, true);
});

test('Cmd with an arrow jumps to a line or buffer edge', () => {
  assert.equal(resolveKey(key({ key: 'ArrowLeft', metaKey: true })).name, 'moveLineStart');
  assert.equal(resolveKey(key({ key: 'ArrowUp', metaKey: true })).name, 'moveBufferStart');
});

test('Ctrl is treated like Cmd', () => {
  assert.equal(resolveKey(key({ key: 'ArrowRight', ctrlKey: true })).name, 'moveLineEnd');
});

test('Cmd+Z is undo, Cmd+Shift+Z is redo', () => {
  assert.equal(resolveKey(key({ key: 'z', metaKey: true })).name, 'undo');
  assert.equal(
    resolveKey(key({ key: 'z', metaKey: true, shiftKey: true })).name,
    'redo'
  );
});

test('a character with a command modifier is not an insert', () => {
  // Cmd+a is not bound here; it must not type an "a".
  assert.equal(resolveKey(key({ key: 'a', metaKey: true })), null);
});

test('an unbound key resolves to null', () => {
  assert.equal(resolveKey(key({ key: 'F5' })), null);
});
