/**
 * @file Regression tests for the `<text-view>` element's pass-through
 * API. The element wraps the inner editor (`createEditorView`) and
 * hand-forwards a whitelist of methods; a method that exists on the
 * inner editor but is *missing from the whitelist* silently becomes a
 * no-op on the element. That bit SyncTeX inverse search: `recenter()`
 * was forwarded but `flashCurrentLine()` was not, so the host's
 * `(flash-current-line!)` — guarded by `typeof … === 'function'` —
 * skipped the flash entirely and the landed line never lit up.
 *
 * These tests run under Node without a DOM. `ViewElement` degrades to a
 * plain class there, so `new TextView()` constructs, and each forwarding
 * method only touches `this._editor` — which we replace with a spy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TextView } from '../src/text-view.js';

/** A TextView whose inner editor is a call-recording spy. */
function mountedTextView() {
  const calls = [];
  const editor = new Proxy(
    {},
    {
      get(_t, prop) {
        return (...args) => {
          calls.push({ method: prop, args });
        };
      },
    }
  );
  const tv = new TextView();
  tv._editor = editor;
  return { tv, calls };
}

test('flashCurrentLine forwards to the inner editor', () => {
  const { tv, calls } = mountedTextView();
  assert.equal(
    typeof tv.flashCurrentLine,
    'function',
    'the element must expose flashCurrentLine (host guards on typeof)'
  );
  tv.flashCurrentLine();
  assert.deepEqual(calls, [{ method: 'flashCurrentLine', args: [] }]);
});

test('recenter forwards to the inner editor', () => {
  const { tv, calls } = mountedTextView();
  tv.recenter();
  assert.deepEqual(calls, [{ method: 'recenter', args: [] }]);
});

test('flashCurrentLine is a safe no-op before the editor is mounted', () => {
  const tv = new TextView(); // _editor stays null (never connected)
  assert.doesNotThrow(() => tv.flashCurrentLine());
});
