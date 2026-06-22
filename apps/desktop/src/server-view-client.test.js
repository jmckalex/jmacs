/**
 * @file Tests for the G2 server-view client (`server-view-client.js`).
 *
 * These run under `node --test` with NO Electron and NO real DOM: the client
 * takes its port + view collaborators by injection, so the
 * handshake → open-buffer → mirror → key-routing wiring is assertable with
 * fakes. They are the automated half of the G2 verification; mounting the REAL
 * `<text-view>` + the native "typing feels native" feel is an architect-run
 * electron self-test (see `mwb/server-view-selftest.js`).
 *
 * The mirror under test is the REAL `ClientBuffer` (it reuses `@editor/storage`
 * verbatim, no DOM), so these assert real replication: a typed char predicts on
 * the mirror, the matching server delta reconciles, a motion CURSOR moves the
 * point, a server-originated delta applies fresh, overlays/cursors sync.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createServerViewClient, isBarePrintable } from './server-view-client.js';
import { MSG, INTENT } from '../mwb/protocol.js';

/** A fake MessagePort recording everything posted up, with hooks to push
 *  messages down (as the server would). */
function fakePort() {
  const sent = [];
  let onmessage = null;
  let started = false;
  return {
    sent,
    get started() { return started; },
    postMessage(msg) { sent.push(msg); },
    start() { started = true; },
    set onmessage(fn) { onmessage = fn; },
    get onmessage() { return onmessage; },
    /** Push a message down to the client as the server would. */
    deliver(msg) { if (onmessage) onmessage({ data: msg }); },
  };
}

/** A fake mountView recording the buffer + options it was handed and how many
 *  times it re-rendered (setView) / was destroyed. */
function fakeMount() {
  const calls = [];
  function mountView(buffer, options) {
    const instance = {
      buffer,
      options,
      setViewCount: 0,
      focused: false,
      destroyed: false,
      recentered: false,
      setView() { this.setViewCount += 1; },
      focus() { this.focused = true; },
      destroy() { this.destroyed = true; },
      recenter() { this.recentered = true; },
    };
    calls.push(instance);
    return instance;
  }
  return { mountView, calls };
}

/** Build a connected client sitting on a snapshot — the common fixture. */
function connectedClient(snapshotText = 'hello world\n') {
  const port = fakePort();
  const mount = fakeMount();
  const client = createServerViewClient({ port, mountView: mount.mountView });
  client.connect();
  port.deliver({
    type: MSG.SNAPSHOT,
    text: snapshotText,
    point: 0,
    name: 'view.js',
    bufferId: 'buf-1',
    seq: 0,
  });
  return { port, mount, client };
}

// --- isBarePrintable ---------------------------------------------------

test('isBarePrintable is true for a single code point, false for chords/empty', () => {
  assert.equal(isBarePrintable('a'), true);
  assert.equal(isBarePrintable('1'), true);
  assert.equal(isBarePrintable('😀'), true); // one code point
  assert.equal(isBarePrintable('C-x'), false);
  assert.equal(isBarePrintable('enter'), false);
  assert.equal(isBarePrintable(''), false);
  assert.equal(isBarePrintable(undefined), false);
});

// --- the handshake -----------------------------------------------------

test('connect() starts the port and sends HELLO', () => {
  const port = fakePort();
  const mount = fakeMount();
  const client = createServerViewClient({ port, mountView: mount.mountView });
  client.connect();
  assert.equal(port.started, true);
  assert.equal(client.isConnected(), true);
  assert.deepEqual(port.sent, [{ type: MSG.HELLO }]);
});

test('a SNAPSHOT opens the buffer through the server: builds a mirror + mounts a view', () => {
  const { mount, client } = connectedClient('abc\n');
  assert.equal(mount.calls.length, 1, 'mounted exactly one view');
  const mirror = client.getMirror();
  assert.ok(mirror, 'a ClientBuffer mirror exists');
  assert.equal(mirror.text, 'abc\n', 'mirror holds the snapshot text');
  assert.equal(client.currentBufferId(), 'buf-1');
  assert.equal(mount.calls[0].buffer, mirror, 'the view is bound to the mirror');
  assert.equal(mount.calls[0].focused, true, 'the mounted view was focused');
});

test('the mounted view is given onKey + the mirror-reading closures', () => {
  const { mount, client } = connectedClient();
  const opts = mount.calls[0].options;
  assert.equal(typeof opts.onKey, 'function');
  assert.equal(typeof opts.getPoint, 'function');
  assert.equal(typeof opts.getCursors, 'function');
  assert.equal(typeof opts.getDecorations, 'function');
  // The closures read the live mirror.
  const mirror = client.getMirror();
  assert.equal(opts.getPoint(), mirror.point);
  assert.deepEqual(opts.getCursors(), mirror.cursors);
});

// --- key routing → intents --------------------------------------------

test('a bare printable self-inserts with local echo + a SELF_INSERT intent', () => {
  const { port, client } = connectedClient('X\n');
  const before = client.getMirror().text;
  const ok = client.dispatchKey('a');
  assert.equal(ok, true, 'the key was claimed');
  // Local echo: the mirror predicted the insert immediately (instant typing).
  assert.equal(client.getMirror().text, `a${before}`);
  // And exactly one SELF_INSERT intent went up (the HELLO is sent[0]).
  const intents = port.sent.filter((m) => m.type === MSG.INTENT);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].intent.kind, INTENT.SELF_INSERT);
  assert.equal(intents[0].intent.text, 'a');
});

test('a chord/command key sends a pure KEY intent with NO local echo', () => {
  const { port, client } = connectedClient('hello\n');
  const before = client.getMirror().text;
  client.dispatchKey('C-x');
  // No text change (the server decides the effect of a command key).
  assert.equal(client.getMirror().text, before);
  const intents = port.sent.filter((m) => m.type === MSG.INTENT);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].intent.kind, INTENT.KEY);
  assert.equal(intents[0].intent.key, 'C-x');
});

test('Enter and Backspace route as KEY intents (commands, not naive guesses)', () => {
  const { port, client } = connectedClient('hi\n');
  client.dispatchKey('enter');
  client.dispatchKey('backspace');
  const keys = port.sent
    .filter((m) => m.type === MSG.INTENT && m.intent.kind === INTENT.KEY)
    .map((m) => m.intent.key);
  assert.deepEqual(keys, ['enter', 'backspace']);
});

// --- reconciliation: deltas round-trip --------------------------------

test('the echoed delta confirms a predicted self-insert (text already matches, no double-apply)', () => {
  const { port, client } = connectedClient('Z\n');
  client.dispatchKey('q'); // predicts "qZ\n"
  const intentId = port.sent.find((m) => m.type === MSG.INTENT).intent.id;
  assert.equal(client.getMirror().text, 'qZ\n');
  // The server echoes the delta back, tagged with our intent id.
  port.deliver({
    type: MSG.DELTA,
    delta: { start: 0, removed: '', inserted: 'q', point: 1, seq: 1, echoId: intentId },
  });
  // The text is unchanged (the prediction held — not applied twice).
  assert.equal(client.getMirror().text, 'qZ\n');
});

test('a server-originated delta (no echoId) applies fresh to the mirror', () => {
  const { port, client } = connectedClient('start\n');
  // A change from another window / a command — not one we predicted.
  port.deliver({
    type: MSG.DELTA,
    delta: { start: 0, removed: '', inserted: '>> ', point: 3, seq: 1 },
  });
  assert.equal(client.getMirror().text, '>> start\n');
  assert.equal(client.getMirror().point, 3);
});

// --- motion / view-state ----------------------------------------------

test('a CURSOR message moves the point with no text change', () => {
  const { port, client } = connectedClient('0123456789\n');
  port.deliver({ type: MSG.CURSOR, point: 5, mark: null });
  assert.equal(client.getMirror().point, 5);
  assert.equal(client.getMirror().text, '0123456789\n');
});

test('a VIEW point reconciles the cursor when no prediction is in flight', () => {
  const { port, client } = connectedClient('0123456789\n');
  port.deliver({ type: MSG.VIEW, view: { point: 4, mark: null } });
  assert.equal(client.getMirror().point, 4);
});

test('a VIEW point does NOT rewind the cursor while a self-insert prediction is in flight', () => {
  const { port, client } = connectedClient('abc\n');
  client.dispatchKey('x'); // predicts point at 1, prediction pending
  assert.equal(client.getMirror().point, 1);
  // A lagging VIEW carrying the OLD point arrives — must be ignored.
  port.deliver({ type: MSG.VIEW, view: { point: 0 } });
  assert.equal(client.getMirror().point, 1, 'the optimistic point was preserved');
});

// --- overlays / multi-cursor sync -------------------------------------

test('an OVERLAYS message reaches the mirror decorations (the render-from-mirror seam)', () => {
  const { port, client } = connectedClient('match match\n');
  port.deliver({
    type: MSG.OVERLAYS,
    overlays: [
      { start: 0, end: 5, face: 'search-match' },
      { start: 6, end: 11, face: 'search-match' },
    ],
  });
  const decos = client.getMirror().decorations;
  assert.equal(decos.length, 2);
  assert.ok(decos.every((d) => d.face === 'search-match'));
});

test('a CURSORS message syncs the full multi-cursor set to the mirror', () => {
  const { port, client } = connectedClient('a a a\n');
  port.deliver({
    type: MSG.CURSORS,
    cursors: [{ point: 0, mark: null }, { point: 2, mark: null }, { point: 4, mark: null }],
  });
  assert.equal(client.getMirror().cursors.length, 3);
});

// --- buffer switch / resync -------------------------------------------

test('a SNAPSHOT with a new buffer id rebuilds the mirror + re-mounts the view', () => {
  const port = fakePort();
  const mount = fakeMount();
  const client = createServerViewClient({ port, mountView: mount.mountView });
  client.connect();
  port.deliver({ type: MSG.SNAPSHOT, text: 'A\n', point: 0, name: 'a.js', bufferId: 'buf-A', seq: 0 });
  assert.equal(mount.calls.length, 1);
  port.deliver({ type: MSG.SNAPSHOT, text: 'B contents\n', point: 0, name: 'b.js', bufferId: 'buf-B', seq: 5 });
  assert.equal(mount.calls.length, 2, 're-mounted on the switch');
  assert.equal(mount.calls[0].destroyed, true, 'the old view was destroyed');
  assert.equal(client.getMirror().text, 'B contents\n');
  assert.equal(client.currentBufferId(), 'buf-B');
});

test('a RESYNC adopts canonical text + the cursor set (grouped undo / multi-cursor edit)', () => {
  const { port, client } = connectedClient('xxxxx\n');
  port.deliver({
    type: MSG.RESYNC,
    text: 'YYY\n',
    cursors: [{ point: 0, mark: null }, { point: 1, mark: null }],
    seq: 3,
  });
  assert.equal(client.getMirror().text, 'YYY\n');
  assert.equal(client.getMirror().cursors.length, 2);
});

// --- teardown ----------------------------------------------------------

test('destroy() tears down the view + drops the port handler', () => {
  const { mount, client, port } = connectedClient();
  client.destroy();
  assert.equal(mount.calls[0].destroyed, true);
  assert.equal(client.getMirror(), null);
  assert.equal(client.isConnected(), false);
  assert.equal(port.onmessage, null);
});
