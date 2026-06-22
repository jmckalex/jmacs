/**
 * @file Server-side port test for makefile.lisp (G3).
 *
 * makefile.lisp is fully model-side (insert!/goto!/set-mark!), exactly
 * like latex.lisp: modes.lisp declares makefile-mode + makefile-mode-map
 * (which this file fills). The C-c chord dispatches via the mode-keymap
 * chain on a Makefile buffer. See PRIMITIVE-SPLIT.md "Modes".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpine } from './spine.js';

function makeSpine(initialText = '', name = 'Makefile') {
  const spine = createSpine(
    { initialText, name },
    {
      onStatus: () => {}, onMinibufferOpen: () => {}, onMinibufferClose: () => {},
      onScroll: () => {}, onPicker: () => {},
    }
  );
  return { spine };
}

test('makefile-target inserts a target stub with the name pre-selected', () => {
  const { spine } = makeSpine('');
  spine.runCommand('makefile-target');
  assert.equal(spine.buffer.text, 'target: deps\n\trecipe\n');
  // The name "target" is selected (mark at 0, point at 6) for a quick rename.
  const v = spine.view;
  const lo = Math.min(v.point, v.mark);
  const hi = Math.max(v.point, v.mark);
  assert.equal(spine.buffer.text.slice(lo, hi), 'target');
});

test('makefile-phony and makefile-tab insert their text (model commands)', () => {
  const { spine } = makeSpine('');
  spine.runCommand('makefile-phony');
  assert.equal(spine.buffer.text, '.PHONY: \n');
  assert.equal(spine.buffer.text.slice(0, spine.buffer.point), '.PHONY: ');

  const { spine: s2 } = makeSpine('');
  s2.runCommand('makefile-tab');
  assert.equal(s2.buffer.text, '\t');
});

test('the C-c t chord dispatches makefile-target via the makefile-mode keymap', () => {
  const { spine } = makeSpine('');
  const h1 = spine.handleKey('C-c');
  const h2 = spine.handleKey('t');
  assert.ok(h1 && h2, 'both keys handled');
  assert.equal(spine.buffer.text, 'target: deps\n\trecipe\n');
});

test('the makefile commands are M-x-visible', () => {
  const { spine } = makeSpine('');
  const names = spine.commandNames();
  for (const c of ['makefile-target', 'makefile-phony', 'makefile-variable', 'makefile-include']) {
    assert.ok(names.includes(c), `${c} is a real command`);
  }
});
