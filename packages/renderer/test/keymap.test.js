import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveKey, keyEventToString } from '../src/keymap.js';

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

// --- keyEventToString ---------------------------------------------------

test('a bare printable key is returned as typed', () => {
  assert.equal(keyEventToString(key({ key: 'a' })), 'a');
  assert.equal(keyEventToString(key({ key: 'A' })), 'A');
  assert.equal(keyEventToString(key({ key: '(' })), '(');
  assert.equal(keyEventToString(key({ key: ' ' })), ' ');
});

test('named keys get readable names', () => {
  assert.equal(keyEventToString(key({ key: 'ArrowLeft' })), 'left');
  assert.equal(keyEventToString(key({ key: 'Backspace' })), 'backspace');
  assert.equal(keyEventToString(key({ key: 'Enter' })), 'enter');
});

test('modifiers become C- / M- / S- prefixes', () => {
  assert.equal(keyEventToString(key({ key: 'ArrowLeft', shiftKey: true })), 'S-left');
  assert.equal(keyEventToString(key({ key: 'ArrowLeft', metaKey: true })), 'C-left');
  assert.equal(keyEventToString(key({ key: 'z', ctrlKey: true })), 'C-z');
});

test('a modified printable key is named, not self-inserting', () => {
  // Ctrl+Shift+Z normalises to a stable "C-S-z" regardless of casing.
  assert.equal(
    keyEventToString(key({ key: 'Z', ctrlKey: true, shiftKey: true })),
    'C-S-z'
  );
  assert.equal(keyEventToString(key({ key: 'a', metaKey: true })), 'C-a');
});

test('a modified key uses event.code, independent of event.key', () => {
  // On macOS, Option+X composes event.key to "≈"; event.code stays KeyX.
  assert.equal(
    keyEventToString(key({ key: '≈', code: 'KeyX', altKey: true })),
    'M-x'
  );
  assert.equal(
    keyEventToString(key({ key: 'z', code: 'KeyZ', ctrlKey: true })),
    'C-z'
  );
});

test('the bracket keys name as their characters under modifiers', () => {
  // Option+] composes "'" on macOS; the code names the physical key,
  // and the brackets map to their characters so bindings read "M-]".
  assert.equal(
    keyEventToString(key({ key: '\u2018', code: 'BracketLeft', altKey: true })),
    'M-['
  );
  assert.equal(
    keyEventToString(key({ key: '\u2019', code: 'BracketRight', altKey: true })),
    'M-]'
  );
});

test('event.code resolves named and digit keys under a modifier', () => {
  assert.equal(
    keyEventToString(key({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true })),
    'C-left'
  );
  assert.equal(
    keyEventToString(key({ key: '1', code: 'Digit1', ctrlKey: true })),
    'C-1'
  );
});
