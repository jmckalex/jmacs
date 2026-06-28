/**
 * @file Tests for the G1 server bridge (`server-bridge.js`).
 *
 * These run under `node --test` with NO real Electron: the bridge takes its
 * Electron collaborators (`utilityProcess`, `MessageChannelMain`) by
 * injection, so the flag-gating, fork config, and per-window port-transfer
 * dance are all assertable with fakes. They are the automated half of the G1
 * verification; the actual spawn/boot is an architect-run electron self-test
 * (see `mwb/server-bridge-selftest.js`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isServerMode,
  serverModulePath,
  buildServerForkConfig,
  createServerBridge,
  SERVER_PORT_CHANNEL,
} from './server-bridge.js';

// --- the single gate ---------------------------------------------------

test('isServerMode is on by default — Model B is the default mode', () => {
  assert.equal(isServerMode({}), true);
});

test('isServerMode stays on for any value except the explicit "0" escape hatch', () => {
  assert.equal(isServerMode({ GODOT_SERVER: '1' }), true);
  assert.equal(isServerMode({ GODOT_SERVER: 'true' }), true);
  assert.equal(isServerMode({ GODOT_SERVER: '' }), true);
});

test('isServerMode is off only when GODOT_SERVER === "0" (transitional legacy path)', () => {
  assert.equal(isServerMode({ GODOT_SERVER: '0' }), false);
});

// --- the static config -------------------------------------------------

test('serverModulePath points at the reused mwb/server.js', () => {
  const p = serverModulePath();
  assert.ok(p.endsWith('/mwb/server.js'), `expected …/mwb/server.js, got ${p}`);
});

test('buildServerForkConfig names the process and inherits stdio', () => {
  const cfg = buildServerForkConfig();
  assert.equal(cfg.serviceName, 'godot-server');
  assert.equal(cfg.stdio, 'inherit');
});

// --- the bridge factory (with fakes) -----------------------------------

/** A fake utilityProcess child capturing the fork + the messages/ports. */
function makeFakeChild() {
  return {
    forkArgs: null,
    posted: [],
    listeners: {},
    killed: false,
    on(evt, fn) { (this.listeners[evt] ||= []).push(fn); },
    postMessage(msg, ports) { this.posted.push({ msg, ports }); },
    kill() { this.killed = true; },
    emit(evt, ...args) { (this.listeners[evt] || []).forEach((fn) => fn(...args)); },
  };
}

/** A fake utilityProcess module whose fork returns the captured child. */
function makeFakeUtilityProcess() {
  const child = makeFakeChild();
  return {
    child,
    forkCalls: [],
    fork(module, args, options) {
      this.forkCalls.push({ module, args, options });
      child.forkArgs = { module, args, options };
      return child;
    },
  };
}

/** A fake MessageChannelMain: each construction yields fresh sentinel ports. */
function makeFakeChannelClass() {
  let n = 0;
  return class FakeChannel {
    constructor() {
      n += 1;
      this.port1 = { id: `p1-${n}` };
      this.port2 = { id: `p2-${n}` };
    }
  };
}

/** A fake webContents capturing the transferred port + load callback. */
function makeFakeWebContents() {
  return {
    posted: [],
    loadCb: null,
    once(evt, fn) { if (evt === 'did-finish-load') this.loadCb = fn; },
    postMessage(channel, payload, ports) {
      this.posted.push({ channel, payload, ports });
    },
    finishLoad() { if (this.loadCb) this.loadCb(); },
  };
}

test('createServerBridge forks the server module with the fork config', () => {
  const up = makeFakeUtilityProcess();
  const Channel = makeFakeChannelClass();
  const bridge = createServerBridge({
    utilityProcess: up,
    MessageChannelMain: Channel,
    modulePath: '/fake/server.js',
    log: () => {},
  });

  assert.equal(up.forkCalls.length, 1);
  assert.equal(up.forkCalls[0].module, '/fake/server.js');
  assert.deepEqual(up.forkCalls[0].options, buildServerForkConfig());
  assert.equal(bridge.process, up.child);
});

test('attachWindow transfers port1 to the server and port2 to the renderer after load', () => {
  const up = makeFakeUtilityProcess();
  const Channel = makeFakeChannelClass();
  const bridge = createServerBridge({
    utilityProcess: up,
    MessageChannelMain: Channel,
    modulePath: '/fake/server.js',
    log: () => {},
  });

  const wc = makeFakeWebContents();
  bridge.attachWindow(wc);

  // port1 went to the server immediately, as an `init` message.
  assert.equal(up.child.posted.length, 1);
  const toServer = up.child.posted[0];
  assert.equal(toServer.msg.type, 'init');
  assert.equal(toServer.ports.length, 1);
  assert.equal(toServer.ports[0].id, 'p1-1');

  // port2 is NOT delivered until the page finishes loading.
  assert.equal(wc.posted.length, 0);
  wc.finishLoad();
  assert.equal(wc.posted.length, 1);
  assert.equal(wc.posted[0].channel, SERVER_PORT_CHANNEL);
  assert.equal(wc.posted[0].ports.length, 1);
  assert.equal(wc.posted[0].ports[0].id, 'p2-1');
});

test('attachWindow gives each window its OWN channel (distinct ports)', () => {
  const up = makeFakeUtilityProcess();
  const Channel = makeFakeChannelClass();
  const bridge = createServerBridge({
    utilityProcess: up,
    MessageChannelMain: Channel,
    modulePath: '/fake/server.js',
    log: () => {},
  });

  const w1 = makeFakeWebContents();
  const w2 = makeFakeWebContents();
  bridge.attachWindow(w1);
  bridge.attachWindow(w2);
  w1.finishLoad();
  w2.finishLoad();

  // Two distinct port1s reached the server, two distinct port2s reached the
  // two renderers.
  const serverPortIds = up.child.posted.map((p) => p.ports[0].id);
  assert.deepEqual(serverPortIds, ['p1-1', 'p1-2']);
  assert.equal(w1.posted[0].ports[0].id, 'p2-1');
  assert.equal(w2.posted[0].ports[0].id, 'p2-2');
});

test('attachWindow with no `once` delivers the port immediately (no load wait)', () => {
  const up = makeFakeUtilityProcess();
  const Channel = makeFakeChannelClass();
  const bridge = createServerBridge({
    utilityProcess: up,
    MessageChannelMain: Channel,
    modulePath: '/fake/server.js',
    log: () => {},
  });

  // A webContents-like object lacking `once` (e.g. already-loaded).
  const posted = [];
  const wc = { postMessage: (channel, payload, ports) => posted.push({ channel, ports }) };
  bridge.attachWindow(wc);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].channel, SERVER_PORT_CHANNEL);
});

test('dispose kills the server process and is idempotent', () => {
  const up = makeFakeUtilityProcess();
  const Channel = makeFakeChannelClass();
  const bridge = createServerBridge({
    utilityProcess: up,
    MessageChannelMain: Channel,
    modulePath: '/fake/server.js',
    log: () => {},
  });

  assert.equal(up.child.killed, false);
  bridge.dispose();
  assert.equal(up.child.killed, true);
  // A second dispose is a no-op, never throws.
  bridge.dispose();
  assert.equal(up.child.killed, true);
});

test('attachWindow after dispose is a no-op (no port plumbed)', () => {
  const up = makeFakeUtilityProcess();
  const Channel = makeFakeChannelClass();
  const bridge = createServerBridge({
    utilityProcess: up,
    MessageChannelMain: Channel,
    modulePath: '/fake/server.js',
    log: () => {},
  });

  bridge.dispose();
  const wc = makeFakeWebContents();
  bridge.attachWindow(wc);
  wc.finishLoad();
  // Nothing was transferred — neither to the server nor the renderer.
  assert.equal(up.child.posted.length, 0);
  assert.equal(wc.posted.length, 0);
});

test('a port-transfer failure is caught, not thrown (no main-process dialog)', () => {
  const up = makeFakeUtilityProcess();
  const Channel = makeFakeChannelClass();
  const logs = [];
  const bridge = createServerBridge({
    utilityProcess: up,
    MessageChannelMain: Channel,
    modulePath: '/fake/server.js',
    log: (m) => logs.push(m),
  });

  // A renderer whose postMessage throws (e.g. destroyed contents).
  const wc = {
    once(evt, fn) { if (evt === 'did-finish-load') this._fn = fn; },
    postMessage() { throw new Error('contents destroyed'); },
    finishLoad() { this._fn && this._fn(); },
  };
  // Must not throw out of attachWindow / the load callback.
  assert.doesNotThrow(() => { bridge.attachWindow(wc); wc.finishLoad(); });
  assert.ok(logs.some((l) => l.includes('could not deliver port')));
});

test('the server exit is logged once (and not after dispose)', () => {
  const up = makeFakeUtilityProcess();
  const Channel = makeFakeChannelClass();
  const logs = [];
  const bridge = createServerBridge({
    utilityProcess: up,
    MessageChannelMain: Channel,
    modulePath: '/fake/server.js',
    log: (m) => logs.push(m),
  });

  up.child.emit('exit', 1);
  assert.ok(logs.some((l) => l.includes('server exited (code 1)')));

  // After an explicit dispose, a later exit event is silent (we asked it to die).
  logs.length = 0;
  bridge.dispose();
  up.child.emit('exit', 0);
  assert.equal(logs.filter((l) => l.includes('server exited')).length, 0);
});
