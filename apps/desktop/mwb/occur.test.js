/**
 * @file Server-side port test for occur.lisp (G3).
 *
 * Drives `occur` (M-s o) through the REAL spine. occur.lisp is pure Lisp
 * over buffer-text + new-view! + insert!: under Model B, new-view! mints a
 * fresh registry buffer and switches the active client onto it, so the
 * *Occur: PATTERN* results land in a real server buffer the window sees.
 * Fully model-side. See PRIMITIVE-SPLIT.md "View / pane addressing".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpine } from './spine.js';

function makeSpine(initialText = '', name = 'scratch.txt') {
  const log = { minibufferOpens: [], minibufferCloses: 0 };
  const spine = createSpine(
    { initialText, name },
    {
      onStatus: () => {},
      onMinibufferOpen: (p) => log.minibufferOpens.push(p),
      onMinibufferClose: () => { log.minibufferCloses += 1; },
      onScroll: () => {},
      onPicker: () => {},
    }
  );
  return { spine, log };
}

test('occur lists matching lines (with 1-based line numbers) in a new buffer', () => {
  const { spine, log } = makeSpine(
    'alpha\nbeta cat\ngamma\ndelta cat\nepsilon',
    'src.txt'
  );
  spine.runCommand('occur');
  assert.deepEqual(log.minibufferOpens, ['Occur: ']);
  spine.deliverMinibuffer('cat'); // resumes occur → builds the *Occur* buffer

  // The active buffer is now the freshly-created results view.
  const result = spine.buffer.text;
  assert.match(result, /2 matches for "cat":/);
  assert.match(result, /2: beta cat/);
  assert.match(result, /4: delta cat/);
  // The source line that lacks 'cat' is not listed.
  assert.doesNotMatch(result, /alpha/);
  // The results view has the conventional *Occur: PATTERN* name.
  assert.equal(spine.view.name, '*Occur: cat*');
});

test('occur with no matches says so rather than producing an empty buffer', () => {
  const { spine } = makeSpine('one\ntwo\nthree', 'src.txt');
  spine.runCommand('occur');
  spine.deliverMinibuffer('zzz');
  const result = spine.buffer.text;
  assert.match(result, /0 matches for "zzz":/);
  assert.match(result, /\(no matches\)/);
});

test('occur leaves the source buffer intact (the results go to a new buffer)', () => {
  const { spine } = makeSpine('foo\nfoo bar\nbaz', 'src.txt');
  const srcId = spine.currentBufferIdOf(0);
  spine.runCommand('occur');
  spine.deliverMinibuffer('foo');
  // A new buffer is now current; the original source buffer is untouched.
  const occurId = spine.currentBufferIdOf(0);
  assert.notEqual(occurId, srcId, 'occur switched to a fresh buffer');
  const records = spine.bufferListRecords(0);
  const src = records.find((r) => r.id === srcId);
  assert.ok(src, 'the source buffer still exists');
  assert.equal(src.name, 'src.txt');
});
