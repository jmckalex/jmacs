/**
 * @file Server-side port test for auto-pair.lisp (G3).
 *
 * auto-pair.lisp is fully model-side (point / buffer-substring / insert! /
 * goto! / delete-region! / delete-backward! + a defcustom). Its one
 * render-coupled line — binding the bracket characters into `the-keymap` —
 * is satisfied by the spine's model-side the-keymap shim, AND handle-key
 * consults it before self-insert, so a typed "(" auto-pairs server-side
 * end-to-end. This test drives BOTH the keystroke path (handleKey) and the
 * commands directly. See PRIMITIVE-SPLIT.md "Auto-pair".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpine } from './spine.js';

function makeSpine(initialText = '', name = 'scratch.txt') {
  const spine = createSpine(
    { initialText, name },
    {
      onStatus: () => {},
      onMinibufferOpen: () => {},
      onMinibufferClose: () => {},
      onScroll: () => {},
      onPicker: () => {},
    }
  );
  return { spine };
}

test('typing "(" inserts a matching ) with point between (end-to-end keystroke)', () => {
  const { spine } = makeSpine('');
  spine.handleKey('('); // resolves via the-keymap → auto-pair-open-paren
  assert.equal(spine.buffer.text, '()');
  assert.equal(spine.buffer.point, 1, 'point sits between the pair');
});

test('typing a closing ) over an existing ) steps past it (no duplicate)', () => {
  const { spine } = makeSpine('');
  spine.handleKey('('); // "()" with point at 1
  spine.handleKey(')'); // should step over the auto-inserted ")"
  assert.equal(spine.buffer.text, '()', 'no duplicate close inserted');
  assert.equal(spine.buffer.point, 2, 'point stepped past the close');
});

test('a quote pairs with itself; typing the close steps over it', () => {
  const { spine } = makeSpine('');
  spine.handleKey('"');
  assert.equal(spine.buffer.text, '""');
  assert.equal(spine.buffer.point, 1);
  spine.handleKey('"'); // a quote in front → step over rather than duplicate
  assert.equal(spine.buffer.text, '""');
  assert.equal(spine.buffer.point, 2);
});

test('backspace between an empty pair deletes both characters', () => {
  const { spine } = makeSpine('');
  spine.handleKey('['); // "[]" point at 1
  assert.equal(spine.buffer.text, '[]');
  spine.handleKey('backspace'); // between the empty pair → delete both
  assert.equal(spine.buffer.text, '');
});

test('with *auto-pair* off the bracket keys self-insert (no partner)', () => {
  const { spine } = makeSpine('');
  // Turn the setting off through the real custom registry.
  spine.interpreter.evaluate("(custom-apply! '*auto-pair* #f)");
  spine.handleKey('(');
  assert.equal(spine.buffer.text, '(', 'opener self-inserts, no close added');
  spine.handleKey(')');
  assert.equal(spine.buffer.text, '()', 'close self-inserts too');
});

test('the auto-pair commands are M-x-visible and run through run-command', () => {
  const { spine } = makeSpine('');
  assert.ok(spine.commandNames().includes('auto-pair-open-brace'));
  spine.runCommand('auto-pair-open-brace');
  assert.equal(spine.buffer.text, '{}');
  assert.equal(spine.buffer.point, 1);
});
