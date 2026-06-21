import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installBootGuard } from '../src/boot-guard.js';

// --- minimal fake DOM/window ------------------------------------------------

function makeEl(tag) {
  return {
    tagName: tag,
    id: '',
    type: '',
    textContent: '',
    disabled: false,
    style: { cssText: '' },
    children: [],
    _listeners: {},
    setAttribute() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(t, fn) {
      (this._listeners[t] ||= []).push(fn);
    },
  };
}

function makeEnv() {
  const body = makeEl('body');
  const doc = {
    body,
    documentElement: makeEl('html'),
    createElement: (tag) => makeEl(tag),
  };
  const winListeners = {};
  const reloads = [];
  const writes = [];
  const quits = [];
  const win = {
    addEventListener: (t, fn) => {
      (winListeners[t] ||= []).push(fn);
    },
    console: { error() {} },
    location: { reload: () => reloads.push(1) },
    host: {
      writeSession: (data) => {
        writes.push(data);
        return Promise.resolve();
      },
      quit: () => quits.push(1),
    },
  };
  return { win, doc, body, winListeners, reloads, writes, quits };
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findById(c, id);
    if (hit) return hit;
  }
  return null;
}

function findByTag(root, tag) {
  if (root.tagName === tag) return root;
  for (const c of root.children) {
    const hit = findByTag(c, tag);
    if (hit) return hit;
  }
  return null;
}

// --- tests ------------------------------------------------------------------

test('registers error + unhandledrejection handlers and a guard handle', () => {
  const env = makeEnv();
  const guard = installBootGuard(env.win, env.doc);
  assert.ok(env.winListeners.error?.length);
  assert.ok(env.winListeners.unhandledrejection?.length);
  assert.equal(env.win.__bootGuard, guard);
  assert.equal(guard.isShown(), false);
});

test('a fatal error overlays a recovery card with the message', () => {
  const env = makeEnv();
  const guard = installBootGuard(env.win, env.doc);
  env.winListeners.error[0]({ error: { message: 'TDZ boom', stack: 'at boot' } });
  const overlay = findById(env.body, 'boot-error-overlay');
  assert.ok(overlay, 'overlay was appended to body');
  assert.equal(guard.isShown(), true);
  const pre = findByTag(overlay, 'pre');
  assert.match(pre.textContent, /TDZ boom/);
  assert.match(pre.textContent, /at boot/);
});

test('an unhandled rejection also triggers the overlay', () => {
  const env = makeEnv();
  installBootGuard(env.win, env.doc);
  env.winListeners.unhandledrejection[0]({ reason: new Error('async boom') });
  const overlay = findById(env.body, 'boot-error-overlay');
  assert.ok(overlay);
  assert.match(findByTag(overlay, 'pre').textContent, /async boom/);
});

test('after markBooted the boundary stands down (no overlay)', () => {
  const env = makeEnv();
  const guard = installBootGuard(env.win, env.doc);
  guard.markBooted();
  env.winListeners.error[0]({ error: { message: 'late error' } });
  assert.equal(findById(env.body, 'boot-error-overlay'), null);
  assert.equal(guard.isShown(), false);
});

test('only one overlay even if several errors fire', () => {
  const env = makeEnv();
  installBootGuard(env.win, env.doc);
  env.winListeners.error[0]({ error: { message: 'first' } });
  env.winListeners.error[0]({ error: { message: 'second' } });
  assert.equal(env.body.children.length, 1);
});

test('Reload and Quit buttons wire to the host', () => {
  const env = makeEnv();
  installBootGuard(env.win, env.doc);
  env.winListeners.error[0]({ error: { message: 'x' } });
  const overlay = findById(env.body, 'boot-error-overlay');
  // Collect buttons (they live in the action row).
  const buttons = [];
  (function walk(n) {
    if (n.tagName === 'button') buttons.push(n);
    n.children.forEach(walk);
  })(overlay);
  const labels = buttons.map((b) => b.textContent);
  assert.deepEqual(labels, ['Reload', 'Reset layout & reload', 'Quit']);
  // Click Reload → location.reload.
  buttons[0]._listeners.click[0]();
  assert.equal(env.reloads.length, 1);
  // Click Quit → host.quit.
  buttons[2]._listeners.click[0]();
  assert.equal(env.quits.length, 1);
});
