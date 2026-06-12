/**
 * @file Lifecycle tests for the `<text-view>` custom-element wrapper
 * (`text-view.js`). The element wraps the inner editor produced by
 * `createEditorView`; this file pins the *wrapper's* lifecycle contract —
 * buffer-binding, mount/reuse gating, and teardown — none of which needs
 * the inner editor's heavy DOM machinery.
 *
 * Why no full mount: `createEditorView` touches a large real-DOM surface
 * (`createTreeWalker`, `createRange`, layers, `requestAnimationFrame`,
 * …) and there is no jsdom in this repo. Following the existing renderer
 * convention (`text-view-passthrough.test.js`, `colour-swatches.test.js`),
 * we exercise the wrapper against a recording stub for the inner editor
 * and a minimal attribute bag, asserting only behaviour the wrapper
 * itself owns. Under Node `ViewElement` degrades to a plain `class {}`
 * (see `view-elements.js`), so `new TextView()` constructs cleanly; we
 * supply the few `*Attribute` methods the wrapper calls.
 *
 * The deeper subscribe/unsubscribe behaviour (no callback fires after
 * destroy) lives inside the inner editor and is exercised live / by the
 * smoke arm; here we pin the wrapper-level guarantee that destroy()
 * forwards the teardown to that editor exactly once and detaches it, so
 * no later binding can reach a torn-down editor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TextView } from '../src/text-view.js';

/**
 * Give a bare-stub `ViewElement` instance the attribute API the wrapper
 * touches (`_syncFilePathAttr` reads/writes `data-file-path`). Returns
 * the same instance for chaining.
 */
function withAttrBag(el) {
  const attrs = new Map();
  el.getAttribute = (n) => (attrs.has(n) ? attrs.get(n) : null);
  el.setAttribute = (n, v) => { attrs.set(n, String(v)); };
  el.hasAttribute = (n) => attrs.has(n);
  el.removeAttribute = (n) => { attrs.delete(n); };
  el._attrs = () => Object.fromEntries(attrs);
  return el;
}

/** A recording stub standing in for the inner editor. */
function editorSpy() {
  const calls = [];
  return {
    calls,
    setView: (view) => calls.push({ method: 'setView', view }),
    destroy: () => calls.push({ method: 'destroy' }),
    focus: () => calls.push({ method: 'focus' }),
    recenter: () => calls.push({ method: 'recenter' }),
  };
}

/** A minimal buffer-shaped object: just the fields the wrapper reads. */
function fakeBuffer(over = {}) {
  return { name: 'buf', filePath: null, ...over };
}

/** A fresh TextView with the attribute bag mixed in. */
function freshView() {
  return withAttrBag(new TextView());
}

// --- initial state ----------------------------------------------------

test('a freshly-constructed TextView has no editor and no buffer', () => {
  const tv = freshView();
  assert.equal(tv._editor, null);
  assert.equal(tv.buffer, null);
  assert.equal(tv.boundView, null);
  assert.equal(tv.kind, 'text');
  assert.equal(tv.name, '*text*'); // placeholder while unbound
  assert.equal(tv.filePath, null);
});

// --- setBuffer: binding while unmounted -------------------------------

test('setBuffer records the pending buffer without an editor', () => {
  const tv = freshView();
  const buf = fakeBuffer({ name: 'notes.txt' });
  tv.setBuffer(buf);
  assert.equal(tv.buffer, buf);
  assert.equal(tv.boundView, null);
  assert.equal(tv.name, 'notes.txt'); // tab label now reflects the buffer
});

test('setBuffer mirrors a filePath onto data-file-path; clears it when absent', () => {
  const tv = freshView();
  tv.setBuffer(fakeBuffer({ filePath: '/tmp/a.txt' }));
  assert.equal(tv.getAttribute('data-file-path'), '/tmp/a.txt');
  assert.equal(tv.filePath, '/tmp/a.txt');
  // Re-bind to a buffer with no path: the mirror attribute is removed.
  tv.setBuffer(fakeBuffer({ filePath: null }));
  assert.equal(tv.hasAttribute('data-file-path'), false);
  assert.equal(tv.filePath, null);
});

test('setBuffer clears any prior boundView', () => {
  const tv = freshView();
  const buf = fakeBuffer();
  tv.setView({ buffer: buf, point: 3, mark: null });
  assert.notEqual(tv.boundView, null);
  tv.setBuffer(fakeBuffer({ name: 'other' }));
  assert.equal(tv.boundView, null);
});

// --- setBuffer: swapping content on a mounted editor ------------------

test('setBuffer on a mounted editor re-points it via setView (swap + re-render)', () => {
  const tv = freshView();
  const editor = editorSpy();
  tv._editor = editor; // simulate "already mounted"
  const buf = fakeBuffer({ name: 'b' });
  tv.setBuffer(buf);
  assert.equal(editor.calls.length, 1);
  assert.equal(editor.calls[0].method, 'setView');
  // The wrapper wraps the bare buffer in a minimal view shape.
  assert.equal(editor.calls[0].view.buffer, buf);
  assert.equal(editor.calls[0].view.point, 0);
  assert.equal(editor.calls[0].view.mark, null);
  assert.equal(tv.buffer, buf);
});

// --- setView ----------------------------------------------------------

test('setView records the view and derives its buffer', () => {
  const tv = freshView();
  const buf = fakeBuffer({ filePath: '/p/f.md' });
  const view = { buffer: buf, point: 5, mark: 2 };
  tv.setView(view);
  assert.equal(tv.boundView, view);
  assert.equal(tv.buffer, buf);
  assert.equal(tv.getAttribute('data-file-path'), '/p/f.md');
});

test('setView on a mounted editor forwards the view object verbatim', () => {
  const tv = freshView();
  const editor = editorSpy();
  tv._editor = editor;
  const view = { buffer: fakeBuffer(), point: 1, mark: null };
  tv.setView(view);
  assert.deepEqual(editor.calls, [{ method: 'setView', view }]);
});

test('setView with a null/bufferless view leaves buffer null', () => {
  const tv = freshView();
  tv.setView({ buffer: null });
  assert.equal(tv.buffer, null);
  assert.equal(tv.hasAttribute('data-file-path'), false);
});

// --- connectedCallback: mount gating (reuse vs rebuild) ---------------

test('connectedCallback is a no-op when no buffer is bound (park-without-buffer)', () => {
  const tv = freshView();
  // _pendingBuffer is null → must return before touching createEditorView.
  assert.doesNotThrow(() => tv.connectedCallback());
  assert.equal(tv._editor, null);
});

test('connectedCallback reuses an existing editor — no rebuild on re-connect', () => {
  const tv = freshView();
  const editor = editorSpy();
  tv._editor = editor; // pretend the first connect already mounted
  tv.setBuffer(fakeBuffer()); // recorded one setView on the mounted editor
  const callsBefore = editor.calls.length;
  // A re-connect (move between panes / out of the warehouse) must NOT
  // build a second editor and must leave the same instance in place.
  tv.connectedCallback();
  tv.connectedCallback();
  assert.equal(tv._editor, editor); // same instance, not rebuilt
  assert.equal(editor.calls.length, callsBefore); // connect added nothing
});

// --- pass-through gating before mount ---------------------------------

test('pass-through methods are safe no-ops before the editor mounts', () => {
  const tv = freshView();
  assert.doesNotThrow(() => tv.recenter());
  assert.doesNotThrow(() => tv.flashCurrentLine());
  assert.doesNotThrow(() => tv.toggleFoldAtPoint());
  assert.equal(tv.pageLines(), 0);
  assert.equal(tv.visibleLineCount(), 0);
  assert.equal(tv.offsetFromPoint(0, 0), null);
  assert.equal(tv.backgroundLayer, null);
  assert.equal(tv.overlayLayer, null);
});

// --- destroy: teardown + leak guard -----------------------------------

test('destroy forwards teardown to the inner editor exactly once and detaches it', () => {
  const tv = freshView();
  const editor = editorSpy();
  tv._editor = editor;
  tv.setView({ buffer: fakeBuffer(), point: 0, mark: null });
  editor.calls.length = 0; // ignore the setView from binding
  tv.destroy();
  assert.deepEqual(editor.calls, [{ method: 'destroy' }]);
  assert.equal(tv._editor, null); // detached — no live editor remains
  assert.equal(tv.buffer, null); // pending refs released
  assert.equal(tv.boundView, null);
});

test('after destroy, a later setBuffer cannot reach the torn-down editor', () => {
  const tv = freshView();
  const editor = editorSpy();
  tv._editor = editor;
  tv.destroy();
  editor.calls.length = 0;
  // The leak guard: the wrapper nulled _editor, so a stray rebind that
  // arrives after teardown forwards to nothing — the dead editor (and
  // thus its buffer subscription) is never touched again.
  tv.setBuffer(fakeBuffer());
  tv.setView({ buffer: fakeBuffer(), point: 0, mark: null });
  assert.equal(editor.calls.length, 0);
});

test('destroy is idempotent and safe when the editor was never mounted', () => {
  const tv = freshView();
  assert.doesNotThrow(() => tv.destroy());
  assert.doesNotThrow(() => tv.destroy()); // second call: still fine
  assert.equal(tv._editor, null);
});

// --- configure guard --------------------------------------------------

test('configure stashes mount options before mount', () => {
  const tv = freshView();
  const opts = { onKey: () => false };
  tv.configure(opts);
  assert.equal(tv._mountOptions, opts);
});

test('configure throws once the editor is mounted (no live reconfigure)', () => {
  const tv = freshView();
  tv._editor = editorSpy();
  assert.throws(
    () => tv.configure({ onKey: () => true }),
    /cannot reconfigure after the editor is mounted/
  );
});
