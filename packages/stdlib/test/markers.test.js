/**
 * @file markers.test.js — the Lisp marker surface: the host primitives
 * (`make-marker`, `marker-position`, `set-marker!`,
 * `marker-buffer-current?`, `release-marker!`) over REAL L2 buffers,
 * and the editing.lisp macros built on them (`with-marker`,
 * `save-excursion`).
 *
 * The harness loads only `commands.lisp` and `editing.lisp` — the two
 * files the macros live in; neither calls a host primitive at load
 * time — against `createBufferPrimitives` over a real
 * `@editor/buffer` buffer, so markers track genuine L1 changes
 * (insert, delete, undo) rather than stubs. The session object is kept
 * mutable so tests can swap in a second real buffer and exercise the
 * cross-buffer rules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import { createInterpreter } from '@editor/lisp';
import { createBufferPrimitives } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/**
 * An interpreter over a real L2 buffer, with the marker macros loaded.
 * Returns the buffer, the (swappable) session and the interpreter.
 */
async function markerEditor(initialText = 'hello world') {
  const buffer = createBuffer(initialText, { name: 'main' });
  const session = { current: buffer };
  const interpreter = createInterpreter({
    write: () => {},
    primitives: createBufferPrimitives(session),
  });
  for (const name of ['commands.lisp', 'editing.lisp']) {
    interpreter.evaluate(await readFile(join(lispDir, name), 'utf8'));
  }
  return { buffer, session, interpreter };
}

/**
 * Wrap BUFFER's `createMarker` so the test can count live L2 markers —
 * the host-side leak probe. Returns a function reading the live count.
 */
function probeMarkers(buffer) {
  const original = buffer.createMarker.bind(buffer);
  let live = 0;
  buffer.createMarker = (at) => {
    const marker = original(at);
    live += 1;
    return {
      get offset() {
        return marker.offset;
      },
      remove() {
        live -= 1;
        marker.remove();
      },
    };
  };
  return () => live;
}

// --- the primitives ------------------------------------------------------

test('make-marker defaults to point; marker-position reads it', async () => {
  const { interpreter } = await markerEditor();
  interpreter.evaluate('(goto! 5)');
  assert.equal(
    interpreter.evaluate('(marker-position (make-marker))'),
    5
  );
});

test('make-marker takes an explicit offset', async () => {
  const { interpreter } = await markerEditor();
  assert.equal(interpreter.evaluate('(marker-position (make-marker 3))'), 3);
});

test('a marker rides an insertion made before it', async () => {
  const { interpreter } = await markerEditor();
  interpreter.evaluate('(define m (make-marker 5))');
  interpreter.evaluate('(goto! 0) (insert! "abc")');
  assert.equal(interpreter.evaluate('(marker-position m)'), 8);
});

test('a marker rides a deletion made before it', async () => {
  const { interpreter } = await markerEditor();
  interpreter.evaluate('(define m (make-marker 5))');
  interpreter.evaluate('(delete-region! 0 2)');
  assert.equal(interpreter.evaluate('(marker-position m)'), 3);
});

test('an edit after the marker leaves it alone', async () => {
  const { interpreter } = await markerEditor();
  interpreter.evaluate('(define m (make-marker 2))');
  interpreter.evaluate('(goto! 7) (insert! "zzz")');
  assert.equal(interpreter.evaluate('(marker-position m)'), 2);
});

test('a deletion spanning the marker collapses it to the edit point', async () => {
  const { interpreter } = await markerEditor();
  interpreter.evaluate('(define m (make-marker 5))');
  interpreter.evaluate('(delete-region! 3 8)');
  assert.equal(interpreter.evaluate('(marker-position m)'), 3);
});

test('a marker rides undo too — every L1 change shifts it', async () => {
  const { interpreter } = await markerEditor();
  interpreter.evaluate('(define m (make-marker 5))');
  interpreter.evaluate('(goto! 0) (insert! "abc")');
  assert.equal(interpreter.evaluate('(marker-position m)'), 8);
  interpreter.evaluate('(undo!)');
  assert.equal(interpreter.evaluate('(marker-position m)'), 5);
});

test('set-marker! moves the marker, and it keeps tracking from there', async () => {
  const { interpreter } = await markerEditor();
  interpreter.evaluate('(define m (make-marker 5))');
  interpreter.evaluate('(set-marker! m 2)');
  assert.equal(interpreter.evaluate('(marker-position m)'), 2);
  interpreter.evaluate('(goto! 0) (insert! "ab")');
  assert.equal(interpreter.evaluate('(marker-position m)'), 4);
});

test('set-marker! does not leak the marker it replaces', async () => {
  const { buffer, interpreter } = await markerEditor();
  const liveCount = probeMarkers(buffer);
  interpreter.evaluate('(define m (make-marker 5))');
  interpreter.evaluate('(set-marker! m 2)');
  assert.equal(liveCount(), 1);
  interpreter.evaluate('(release-marker! m)');
  assert.equal(liveCount(), 0);
});

test('marker-buffer-current? is true while the buffer is current', async () => {
  const { interpreter } = await markerEditor();
  assert.equal(
    interpreter.evaluate('(marker-buffer-current? (make-marker))'),
    true
  );
});

test('a marker prints readably', async () => {
  const { interpreter } = await markerEditor();
  assert.equal(
    interpreter.evaluate('(str (make-marker 2))'),
    '#<marker 2 in main>'
  );
});

// --- type checks ----------------------------------------------------------

test('marker primitives reject non-markers in the house style', async () => {
  const { interpreter } = await markerEditor();
  assert.throws(
    () => interpreter.evaluate('(marker-position 42)'),
    /marker-position: expected a marker, got number/
  );
  assert.throws(
    () => interpreter.evaluate('(set-marker! "x" 0)'),
    /set-marker!: expected a marker, got string/
  );
  assert.throws(
    () => interpreter.evaluate("(release-marker! 'm)"),
    /release-marker!: expected a marker, got symbol/
  );
  assert.throws(
    () => interpreter.evaluate('(marker-buffer-current? nil)'),
    /marker-buffer-current\?: expected a marker, got nil/
  );
});

test('make-marker and set-marker! reject a non-integer offset', async () => {
  const { interpreter } = await markerEditor();
  assert.throws(
    () => interpreter.evaluate('(make-marker "three")'),
    /expected an integer offset/
  );
  assert.throws(
    () => interpreter.evaluate('(set-marker! (make-marker) 1.5)'),
    /expected an integer offset/
  );
});

// --- release semantics ------------------------------------------------------

test('operations on a released marker raise; release itself is idempotent', async () => {
  const { interpreter } = await markerEditor();
  interpreter.evaluate('(define m (make-marker 3))');
  interpreter.evaluate('(release-marker! m)');
  // Double release is explicitly safe.
  interpreter.evaluate('(release-marker! m)');
  assert.throws(
    () => interpreter.evaluate('(marker-position m)'),
    /marker-position: the marker has been released/
  );
  assert.throws(
    () => interpreter.evaluate('(set-marker! m 0)'),
    /set-marker!: the marker has been released/
  );
  assert.throws(
    () => interpreter.evaluate('(marker-buffer-current? m)'),
    /marker-buffer-current\?: the marker has been released/
  );
});

test('a released marker stops costing the buffer work', async () => {
  const { buffer, interpreter } = await markerEditor();
  const liveCount = probeMarkers(buffer);
  interpreter.evaluate('(define m (make-marker 3))');
  assert.equal(liveCount(), 1);
  interpreter.evaluate('(release-marker! m)');
  interpreter.evaluate('(release-marker! m)');
  assert.equal(liveCount(), 0);
});

// --- the cross-buffer rules -------------------------------------------------

test('marker-position reads even when the marker buffer is not current', async () => {
  const { buffer, session, interpreter } = await markerEditor();
  interpreter.evaluate('(define m (make-marker 5))');
  session.current = createBuffer('other text', { name: 'other' });
  // Still readable from the other buffer…
  assert.equal(interpreter.evaluate('(marker-position m)'), 5);
  assert.equal(interpreter.evaluate('(marker-buffer-current? m)'), false);
  // …and still tracking edits made to ITS buffer behind the scenes.
  buffer.moveTo(0);
  buffer.insert('xx');
  assert.equal(interpreter.evaluate('(marker-position m)'), 7);
});

test('set-marker! refuses to move a marker whose buffer is not current', async () => {
  const { session, interpreter } = await markerEditor();
  interpreter.evaluate('(define m (make-marker 5))');
  const original = session.current;
  session.current = createBuffer('other text', { name: 'other' });
  assert.throws(
    () => interpreter.evaluate('(set-marker! m 0)'),
    /set-marker!: the marker's buffer is not current/
  );
  // Back in its own buffer the move works again.
  session.current = original;
  interpreter.evaluate('(set-marker! m 1)');
  assert.equal(interpreter.evaluate('(marker-position m)'), 1);
});

// --- with-marker --------------------------------------------------------------

test('with-marker binds a marker at point (or an offset) and returns the body value', async () => {
  const { interpreter } = await markerEditor();
  interpreter.evaluate('(goto! 4)');
  assert.equal(
    interpreter.evaluate('(with-marker (m) (marker-position m))'),
    4
  );
  assert.equal(
    interpreter.evaluate('(with-marker (m 2) (marker-position m))'),
    2
  );
});

test('with-marker releases on normal exit', async () => {
  const { buffer, interpreter } = await markerEditor();
  const liveCount = probeMarkers(buffer);
  interpreter.evaluate('(define probe nil)');
  interpreter.evaluate('(with-marker (m) (set! probe m))');
  assert.equal(liveCount(), 0);
  assert.throws(
    () => interpreter.evaluate('(marker-position probe)'),
    /the marker has been released/
  );
});

test('with-marker releases when the body raises, and the error propagates', async () => {
  const { buffer, interpreter } = await markerEditor();
  const liveCount = probeMarkers(buffer);
  interpreter.evaluate('(define probe nil)');
  const message = interpreter.evaluate(
    '(try (with-marker (m) (set! probe m) (error "boom"))' +
      ' (catch e (get e :message)))'
  );
  assert.equal(message, 'boom');
  assert.equal(liveCount(), 0);
  assert.throws(
    () => interpreter.evaluate('(marker-position probe)'),
    /the marker has been released/
  );
});

test('with-marker tolerates the body releasing the marker itself', async () => {
  const { interpreter } = await markerEditor();
  assert.equal(
    interpreter.evaluate('(with-marker (m) (release-marker! m) 7)'),
    7
  );
});

// --- save-excursion -----------------------------------------------------------

test('save-excursion restores point across an edit before it', async () => {
  const { interpreter } = await markerEditor('hello world');
  interpreter.evaluate('(goto! 6)'); // at "world"
  interpreter.evaluate('(save-excursion (goto! 0) (insert! "say "))');
  // A plain saved integer would restore 6 — mid-"hello". The marker
  // rides the insertion, so point is back before "world".
  assert.equal(interpreter.evaluate('(point)'), 10);
  assert.equal(
    interpreter.evaluate('(buffer-substring (point) (+ (point) 5))'),
    'world'
  );
});

test('save-excursion returns the body value', async () => {
  const { interpreter } = await markerEditor();
  assert.equal(
    interpreter.evaluate('(save-excursion (goto! 0) (+ 1 2))'),
    3
  );
});

test('save-excursion restores point when the body raises, propagating the error', async () => {
  const { interpreter } = await markerEditor('hello world');
  interpreter.evaluate('(goto! 6)');
  const message = interpreter.evaluate(
    '(try (save-excursion (goto! 0) (insert! "xx") (error "bang"))' +
      ' (catch e (get e :message)))'
  );
  assert.equal(message, 'bang');
  assert.equal(interpreter.evaluate('(point)'), 8);
});

test('save-excursion does not leak its marker — normal and error exits', async () => {
  const { buffer, interpreter } = await markerEditor();
  const liveCount = probeMarkers(buffer);
  interpreter.evaluate('(save-excursion (insert! "x"))');
  assert.equal(liveCount(), 0);
  interpreter.evaluate(
    '(try (save-excursion (error "boom")) (catch e nil))'
  );
  assert.equal(liveCount(), 0);
});

test('save-excursion leaves the mark alone — saved point, untouched region', async () => {
  const { interpreter } = await markerEditor('hello world');
  interpreter.evaluate('(set-mark! 2) (goto! 6)');
  interpreter.evaluate('(save-excursion (goto! 0))');
  assert.equal(interpreter.evaluate('(point)'), 6);
  assert.equal(interpreter.evaluate('(mark)'), 2);
});

test('save-excursion nests — each level restores its own point', async () => {
  const { interpreter } = await markerEditor('hello world');
  interpreter.evaluate('(goto! 6)');
  interpreter.evaluate('(define inner-point nil)');
  interpreter.evaluate(
    '(save-excursion (goto! 3) (save-excursion (goto! 0) (insert! "a"))' +
      ' (set! inner-point (point)))'
  );
  assert.equal(interpreter.evaluate('inner-point'), 4); // 3 shifted by 1
  assert.equal(interpreter.evaluate('(point)'), 7); // 6 shifted by 1
});
