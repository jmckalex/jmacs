import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldGlobalRouterDefer } from '../src/server-router-gate.js';

test('flag-off: the router never defers (byte-for-byte today)', () => {
  // serverMode false — the shipping default — always runs the router.
  assert.equal(shouldGlobalRouterDefer(false, false), false);
  assert.equal(shouldGlobalRouterDefer(false, true), false);
});

test('server-mode with the server view mounted: the router defers', () => {
  // Both conditions met → the server owns dispatch → stand down.
  assert.equal(shouldGlobalRouterDefer(true, true), true);
});

test('server-mode but no view mounted yet: the router still runs', () => {
  // The port connected but the SNAPSHOT/mount has not landed — there is no
  // server dispatcher yet, so the in-renderer router must still handle keys.
  assert.equal(shouldGlobalRouterDefer(true, false), false);
});

test('defer is focus-independent: it does not consult preventDefault/focus', () => {
  // The whole point — the predicate is purely (serverMode, mounted). It returns
  // true even though the legacy guard (defaultPrevented) is not consulted here:
  // a key reaching <body> with focus drifted off the overlay still defers.
  assert.equal(shouldGlobalRouterDefer(true, true), true);
});

test('only the strict boolean `true` pair defers', () => {
  // Defensive: a truthy-but-not-true value does not accidentally defer (the
  // call sites pass `!!(...)`, but guard against a stray object/string).
  assert.equal(shouldGlobalRouterDefer(1, 1), false);
  assert.equal(shouldGlobalRouterDefer('yes', 'yes'), false);
  assert.equal(shouldGlobalRouterDefer(true, 1), false);
  assert.equal(shouldGlobalRouterDefer(1, true), false);
});
