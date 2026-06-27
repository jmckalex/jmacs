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

/** A fake DOM chrome recording every call + the callbacks it was handed, so a
 *  test can assert what the server drives + drive input back up. The hooks are
 *  closures (not `this`-methods) since the client destructures them off the
 *  object, matching how app.js passes plain functions. */
function fakeChrome() {
  const c = {
    modeline: null,
    echo: null,
    minibuffer: null, // { prompt, value, cbs } while open, else null
    minibufferCloses: 0,
    picker: null, // { request, cbs } while open, else null
    pickerCloses: 0,
    bufferList: null, // the last server BUFFER_LIST pushed, else null
    quitRequests: 0, // how many times the client asked the host to quit
  };
  c.setModeline = (modeline) => { c.modeline = modeline; };
  c.setEcho = (status) => { c.echo = status; };
  c.openMinibuffer = (prompt, value, cbs) => { c.minibuffer = { prompt, value, cbs }; };
  c.closeMinibuffer = () => { c.minibuffer = null; c.minibufferCloses += 1; };
  c.openPicker = (request, cbs) => { c.picker = { request, cbs }; };
  c.closePicker = () => { c.picker = null; c.pickerCloses += 1; };
  c.setBufferList = (buffers) => { c.bufferList = buffers; };
  c.requestQuit = () => { c.quitRequests += 1; };
  return c;
}

/** A connected client wired to a fake chrome — the Part-2 fixture. */
function connectedClientWithChrome(snapshotText = 'hi\n') {
  const port = fakePort();
  const mount = fakeMount();
  const chrome = fakeChrome();
  const client = createServerViewClient({ port, mountView: mount.mountView, chrome });
  client.connect();
  port.deliver({
    type: MSG.SNAPSHOT, text: snapshotText, point: 0,
    name: 'view.js', bufferId: 'buf-1', seq: 0,
  });
  return { port, mount, chrome, client };
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

test('a bare printable routes as a pure KEY intent (the keymap decides) — no local echo', () => {
  const { port, client } = connectedClient('X\n');
  const before = client.getMirror().text;
  const ok = client.dispatchKey('a');
  assert.equal(ok, true, 'the key was claimed');
  // NO local prediction: the mirror is untouched until the server's delta.
  // This is what lets the server's `handle-key`/keymap run first (auto-pair,
  // electric keys) instead of the client blindly self-inserting.
  assert.equal(client.getMirror().text, before, 'no optimistic insert');
  // Exactly one KEY intent went up carrying the raw key.
  const intents = port.sent.filter((m) => m.type === MSG.INTENT);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].intent.kind, INTENT.KEY);
  assert.equal(intents[0].intent.key, 'a');
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

test('typing "(" round-trips to an auto-paired "()" via the server keymap', () => {
  // The CLIENT sends "(" as a KEY intent (it does NOT self-insert "("); the
  // server's handle-key runs auto-pair-open-paren and echoes back a DELTA that
  // inserts the PAIR. The client applies that fresh (no prediction to match).
  const { port, client } = connectedClient('\n');
  client.dispatchKey('(');
  // What went UP is a single bare KEY "(" — not a SELF_INSERT of "(".
  const intents = port.sent.filter((m) => m.type === MSG.INTENT);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].intent.kind, INTENT.KEY);
  assert.equal(intents[0].intent.key, '(');
  // The server inserts the pair and echoes it down; the mirror applies it fresh.
  port.deliver({
    type: MSG.DELTA,
    delta: { start: 0, removed: '', inserted: '()', point: 1, seq: 1 },
  });
  assert.equal(client.getMirror().text, '()\n', 'the pair landed');
  assert.equal(client.getMirror().point, 1, 'point sits between the pair');
});

test('a prefix chord (C-x then b) reaches the server as TWO bare KEYs', () => {
  // The chord-eating bug: a printable AFTER a prefix used to be local-echoed as
  // a literal "b". Now BOTH keys go up as KEY intents, so the server's prefix
  // map sees C-x then b → switch-to-buffer (and opens the minibuffer).
  const { port, client } = connectedClient('text\n');
  client.dispatchKey('C-x');
  client.dispatchKey('b');
  const keys = port.sent
    .filter((m) => m.type === MSG.INTENT && m.intent.kind === INTENT.KEY)
    .map((m) => m.intent.key);
  assert.deepEqual(keys, ['C-x', 'b'], 'C-x then b, both as KEY intents');
  // And the mirror text is untouched — neither key self-inserted client-side.
  assert.equal(client.getMirror().text, 'text\n');
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

test('a typed char produces a KEY intent whose echoed delta applies fresh (no local prediction)', () => {
  const { port, client } = connectedClient('Z\n');
  client.dispatchKey('q'); // sends KEY "q"; the mirror is NOT mutated yet
  const intentId = port.sent.find((m) => m.type === MSG.INTENT).intent.id;
  assert.equal(client.getMirror().text, 'Z\n', 'no optimistic insert');
  // The server's handle-key self-inserts "q" and echoes the delta back, tagged
  // with our intent id. With no prediction to confirm, the delta applies fresh.
  port.deliver({
    type: MSG.DELTA,
    delta: { start: 0, removed: '', inserted: 'q', point: 1, seq: 1, echoId: intentId },
  });
  assert.equal(client.getMirror().text, 'qZ\n', 'the server delta landed');
  assert.equal(client.getMirror().point, 1);
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

test('a VIEW point reconciles the cursor after a typed char (server is authoritative)', () => {
  // With local echo gone, a typed key does NOT move the mirror point on the
  // client; the server's DELTA/VIEW carries the authoritative point. So a VIEW
  // reconcile is no longer at risk of "rewinding" an optimistic point — it just
  // adopts the server's truth.
  const { port, client } = connectedClient('abc\n');
  client.dispatchKey('x'); // sends KEY "x"; mirror point unchanged locally
  assert.equal(client.getMirror().point, 0, 'no optimistic move');
  // The server self-inserts "x" and reports the new point via VIEW.
  port.deliver({
    type: MSG.DELTA,
    delta: { start: 0, removed: '', inserted: 'x', point: 1, seq: 1 },
  });
  port.deliver({ type: MSG.VIEW, view: { point: 1 } });
  assert.equal(client.getMirror().point, 1, 'adopted the server point');
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

// --- Part 2: the server-driven DOM chrome -----------------------------

test('a VIEW renders the server modeline string into the modeline DOM', () => {
  const { port, chrome } = connectedClientWithChrome();
  port.deliver({
    type: MSG.VIEW,
    view: { point: 0, modeline: '●  view.js   L1:C0  (javascript)', status: '' },
  });
  assert.equal(chrome.modeline, '●  view.js   L1:C0  (javascript)');
});

test('a VIEW renders the pending-prefix / echo status into the echo area', () => {
  const { port, chrome } = connectedClientWithChrome();
  // A chord in progress: the server reports its pending prefix as the status.
  port.deliver({ type: MSG.VIEW, view: { point: 0, modeline: '–  x', status: 'C-x-' } });
  assert.equal(chrome.echo, 'C-x-', 'the chord-in-progress is visible');
  // Resolving the chord clears it.
  port.deliver({ type: MSG.VIEW, view: { point: 0, modeline: '–  x', status: '' } });
  assert.equal(chrome.echo, '');
});

test('an active minibuffer VIEW opens the DOM minibuffer with the prompt', () => {
  const { port, chrome } = connectedClientWithChrome();
  port.deliver({
    type: MSG.VIEW,
    view: { point: 0, modeline: '–  x', status: '',
      minibuffer: { active: true, prompt: 'Switch to buffer: ', value: '' } },
  });
  assert.ok(chrome.minibuffer, 'the minibuffer opened');
  assert.equal(chrome.minibuffer.prompt, 'Switch to buffer: ');
});

test('the minibuffer opens once and closes when the server clears it', () => {
  const { port, chrome } = connectedClientWithChrome();
  const open = { active: true, prompt: 'M-x ', value: '' };
  port.deliver({ type: MSG.VIEW, view: { point: 0, modeline: '–  x', minibuffer: open } });
  // A second VIEW with the SAME open prompt must NOT re-open (no flicker).
  port.deliver({ type: MSG.VIEW, view: { point: 0, modeline: '–  x', minibuffer: open } });
  assert.equal(chrome.minibufferCloses, 0);
  assert.ok(chrome.minibuffer);
  // The server resolves the read → minibuffer inactive → close once.
  port.deliver({
    type: MSG.VIEW,
    view: { point: 0, modeline: '–  x', minibuffer: { active: false, prompt: '', value: '' } },
  });
  assert.equal(chrome.minibuffer, null);
  assert.equal(chrome.minibufferCloses, 1);
});

test('the echo area is not painted while a minibuffer prompt is open (the prompt owns the line)', () => {
  const { port, chrome } = connectedClientWithChrome();
  port.deliver({
    type: MSG.VIEW,
    view: { point: 0, modeline: '–  x', status: 'stale-status',
      minibuffer: { active: true, prompt: 'Find file: ', value: '' } },
  });
  assert.equal(chrome.echo, null, 'the status did not clobber the open prompt');
});

test('minibuffer input routes back up as MINIBUFFER_CHANGE / SUBMIT / CANCEL intents', () => {
  const { port, chrome } = connectedClientWithChrome();
  port.deliver({
    type: MSG.VIEW,
    view: { point: 0, modeline: '–  x',
      minibuffer: { active: true, prompt: 'M-x ', value: '' } },
  });
  const { cbs } = chrome.minibuffer;
  cbs.onChange('for');
  cbs.onSubmit('forward-char');
  // A fresh prompt + cancel.
  cbs.onCancel();
  const kinds = port.sent
    .filter((m) => m.type === MSG.INTENT)
    .map((m) => m.intent.kind);
  assert.ok(kinds.includes(INTENT.MINIBUFFER_CHANGE));
  assert.ok(kinds.includes(INTENT.MINIBUFFER_SUBMIT));
  assert.ok(kinds.includes(INTENT.MINIBUFFER_CANCEL));
  const submit = port.sent.find(
    (m) => m.type === MSG.INTENT && m.intent.kind === INTENT.MINIBUFFER_SUBMIT);
  assert.equal(submit.intent.value, 'forward-char');
});

test('a PICKER message opens the picker panel; a choice routes PICKER_CHOOSE with the pickerId', () => {
  const { port, chrome } = connectedClientWithChrome();
  port.deliver({
    type: MSG.PICKER,
    picker: {
      id: 'picker-1', title: 'Buffer list',
      rows: [{ label: 'a.js', value: 'buf-a' }, { label: 'b.js', value: 'buf-b' }],
      options: { filter: true },
    },
  });
  assert.ok(chrome.picker, 'the picker opened');
  assert.equal(chrome.picker.request.title, 'Buffer list');
  chrome.picker.cbs.onChoose('buf-b');
  const choose = port.sent.find(
    (m) => m.type === MSG.INTENT && m.intent.kind === INTENT.PICKER_CHOOSE);
  assert.ok(choose, 'a PICKER_CHOOSE intent went up');
  assert.equal(choose.intent.value, 'buf-b');
  assert.equal(choose.intent.pickerId, 'picker-1', 'tagged with the picker id');
});

test('a picker cancel routes PICKER_CANCEL with the pickerId', () => {
  const { port, chrome } = connectedClientWithChrome();
  port.deliver({
    type: MSG.PICKER,
    picker: { id: 'picker-7', title: 'M-x', rows: [{ label: 'undo', value: 'undo' }], options: {} },
  });
  chrome.picker.cbs.onCancel();
  const cancel = port.sent.find(
    (m) => m.type === MSG.INTENT && m.intent.kind === INTENT.PICKER_CANCEL);
  assert.ok(cancel);
  assert.equal(cancel.intent.pickerId, 'picker-7');
});

test('a superseded PICKER (new id) closes the old panel before opening the new', () => {
  const { port, chrome } = connectedClientWithChrome();
  port.deliver({
    type: MSG.PICKER,
    picker: { id: 'picker-1', title: 'first', rows: [{ label: 'x', value: 'x' }], options: {} },
  });
  port.deliver({
    type: MSG.PICKER,
    picker: { id: 'picker-2', title: 'second', rows: [{ label: 'y', value: 'y' }], options: {} },
  });
  assert.equal(chrome.pickerCloses, 1, 'the first panel was torn down');
  assert.equal(chrome.picker.request.title, 'second');
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

test('destroy() closes an open minibuffer + picker', () => {
  const { port, chrome, client } = connectedClientWithChrome();
  port.deliver({
    type: MSG.VIEW,
    view: { point: 0, modeline: '–  x',
      minibuffer: { active: true, prompt: 'M-x ', value: '' } },
  });
  port.deliver({
    type: MSG.PICKER,
    picker: { id: 'p1', title: 't', rows: [{ label: 'x', value: 'x' }], options: {} },
  });
  client.destroy();
  assert.equal(chrome.minibuffer, null);
  assert.equal(chrome.picker, null);
});

// --- VIEWPORT report (the C-v/M-v screenful measurement, plan §5d) --------

/** A mountView whose instance exposes a measurable pageLines() (the real
 *  <text-view> delegates pageLines to the inner editor). */
function fakeMountWithPageLines(lines) {
  const calls = [];
  let measured = lines;
  function mountView(buffer, options) {
    const instance = {
      buffer, options,
      setView() {}, focus() {}, destroy() {}, recenter() {},
      pageLines() { return measured; },
      setMeasured(n) { measured = n; },
    };
    calls.push(instance);
    return instance;
  }
  return { mountView, calls };
}

/** A recording resize subscription: the test triggers a resize by calling
 *  `fire()`, and can assert it was unsubscribed on destroy. */
function fakeResize() {
  let cb = null;
  let unsubscribed = false;
  return {
    subscribe(fn) { cb = fn; return () => { unsubscribed = true; cb = null; }; },
    fire() { if (cb) cb(); },
    get unsubscribed() { return unsubscribed; },
  };
}

test('the client reports its viewport line count UP on mount (VIEWPORT)', () => {
  const port = fakePort();
  const mount = fakeMountWithPageLines(40);
  const client = createServerViewClient({
    port, mountView: mount.mountView,
  });
  client.connect();
  port.deliver({ type: MSG.SNAPSHOT, text: 'a\nb\n', point: 0, name: 'v', bufferId: 'b', seq: 0 });
  const viewports = port.sent.filter((m) => m.type === MSG.VIEWPORT);
  assert.ok(viewports.length >= 1, 'a VIEWPORT was reported on mount');
  assert.equal(viewports[viewports.length - 1].lines, 40);
});

test('a window resize re-reports the (new) viewport line count', () => {
  const port = fakePort();
  const mount = fakeMountWithPageLines(40);
  const resize = fakeResize();
  const client = createServerViewClient({
    port, mountView: mount.mountView, subscribeResize: resize.subscribe,
  });
  client.connect();
  port.deliver({ type: MSG.SNAPSHOT, text: 'a\n', point: 0, name: 'v', bufferId: 'b', seq: 0 });
  // Grow the pane, then fire a resize: a fresh VIEWPORT with the new count.
  mount.calls[0].setMeasured(72);
  resize.fire();
  const last = port.sent.filter((m) => m.type === MSG.VIEWPORT).pop();
  assert.equal(last.lines, 72);
});

test('a zero / non-finite measurement is NOT reported (server keeps last good)', () => {
  const port = fakePort();
  const mount = fakeMountWithPageLines(0); // a 0-height view before first layout
  const client = createServerViewClient({ port, mountView: mount.mountView });
  client.connect();
  port.deliver({ type: MSG.SNAPSHOT, text: 'a\n', point: 0, name: 'v', bufferId: 'b', seq: 0 });
  assert.equal(port.sent.filter((m) => m.type === MSG.VIEWPORT).length, 0);
});

test('destroy() unsubscribes the resize listener', () => {
  const port = fakePort();
  const mount = fakeMountWithPageLines(40);
  const resize = fakeResize();
  const client = createServerViewClient({
    port, mountView: mount.mountView, subscribeResize: resize.subscribe,
  });
  client.connect();
  assert.equal(resize.unsubscribed, false);
  client.destroy();
  assert.equal(resize.unsubscribed, true);
});

// --- BUFFER_LIST (the server's open-buffer set → tabs / View List) ------

test('getBufferList() is empty before the server pushes a BUFFER_LIST', () => {
  const { client } = connectedClient();
  assert.deepEqual(client.getBufferList(), []);
});

test('a BUFFER_LIST caches the records and drives the chrome setBufferList hook', () => {
  const { port, chrome, client } = connectedClientWithChrome();
  const buffers = [
    { id: 'b1', name: 'view.js', lineCount: 40, modified: false, filePath: '/x/view.js', current: true },
    { id: 'b2', name: 'foo.html', lineCount: 12, modified: true, filePath: '/x/foo.html', current: false },
  ];
  port.deliver({ type: MSG.BUFFER_LIST, buffers, seq: 1 });
  assert.deepEqual(client.getBufferList(), buffers);
  assert.deepEqual(chrome.bufferList, buffers);
});

test('a later BUFFER_LIST supersedes the previous one (a switch re-marks current)', () => {
  const { port, chrome, client } = connectedClientWithChrome();
  port.deliver({ type: MSG.BUFFER_LIST, buffers: [{ id: 'b1', name: 'a', current: true }], seq: 1 });
  port.deliver({ type: MSG.BUFFER_LIST, buffers: [
    { id: 'b1', name: 'a', current: false },
    { id: 'b2', name: 'b', current: true },
  ], seq: 2 });
  assert.equal(client.getBufferList().length, 2);
  assert.equal(client.getBufferList().find((b) => b.current).id, 'b2');
  assert.equal(chrome.bufferList.find((b) => b.current).id, 'b2');
});

test('a malformed BUFFER_LIST (non-array) is ignored, not crashed', () => {
  const { port, client } = connectedClient();
  port.deliver({ type: MSG.BUFFER_LIST, buffers: null, seq: 1 });
  assert.deepEqual(client.getBufferList(), []);
});

test('switchBuffer(id) sends a SWITCH_BUFFER intent carrying the buffer id', () => {
  const { port, client } = connectedClient();
  client.switchBuffer('b2');
  const switches = port.sent.filter(
    (m) => m.type === MSG.INTENT && m.intent.kind === INTENT.SWITCH_BUFFER
  );
  assert.equal(switches.length, 1);
  assert.equal(switches[0].intent.bufferId, 'b2');
});

test('switchBuffer with a falsy id is a no-op', () => {
  const { port, client } = connectedClient();
  const before = port.sent.length;
  client.switchBuffer('');
  client.switchBuffer(null);
  assert.equal(port.sent.length, before);
});

test('closeBuffer(id) switches to the buffer then sends C-x k to kill it', () => {
  const { port, client } = connectedClient();
  client.closeBuffer('b2');
  const intents = port.sent.filter((m) => m.type === MSG.INTENT).map((m) => m.intent);
  // SWITCH_BUFFER b2, then KEY 'C-x', then KEY 'k'.
  const sw = intents.find((i) => i.kind === INTENT.SWITCH_BUFFER);
  assert.equal(sw.bufferId, 'b2');
  const keys = intents.filter((i) => i.kind === INTENT.KEY).map((i) => i.key);
  assert.deepEqual(keys, ['C-x', 'k']);
});

// --- C-x C-c quit (server-resolved now; forwarded as keys) --------------

test('C-x C-c is forwarded to the server as keys; the client does not quit itself', () => {
  const { port, chrome, client } = connectedClientWithChrome();
  const before = port.sent.length;
  assert.equal(client.dispatchKey('C-x'), true);
  assert.equal(client.dispatchKey('C-c'), true);
  // Both go up as KEY intents — the server's keymap owns quit (C-x C-c ->
  // quit-editor); the client no longer intercepts the chord.
  const newKeys = port.sent.slice(before)
    .filter((m) => m.type === MSG.INTENT && m.intent.kind === INTENT.KEY)
    .map((m) => m.intent.key);
  assert.deepEqual(newKeys, ['C-x', 'C-c']);
  assert.equal(chrome.quitRequests ?? 0, 0, 'the client does not request quit itself');
});
