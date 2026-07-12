import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldGlobalRouterDefer, shouldSwallowPreMount } from '../src/server-router-gate.js';

test('flag-off: the router never defers (byte-for-byte today)', () => {
  // serverMode false — the shipping default — always runs the router.
  assert.equal(shouldGlobalRouterDefer(false, false), false);
  assert.equal(shouldGlobalRouterDefer(false, true), false);
});

test('server-mode with the server view mounted: the router defers', () => {
  // Both conditions met → the server owns dispatch → stand down.
  assert.equal(shouldGlobalRouterDefer(true, true), true);
});

test('server-mode but no view mounted yet: the router does not defer', () => {
  // The port connected but the SNAPSHOT/mount has not landed — there is no
  // mounted server view to defer TO. The router does not defer here; instead it
  // swallows the boot keystroke (see shouldSwallowPreMount below).
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

// --- shouldSwallowPreMount: the boot-window swallow (A3) ----------------------
// Server-mode-on but the view not yet mounted. There is no server dispatcher and
// the in-renderer interpreter is the idle mirror (deleted in B7), so the router
// swallows command chords during the boot window rather than dispatching them or
// leaking them to a native menu accelerator.

test('flag-off: never swallows (the router runs as it always did)', () => {
  assert.equal(shouldSwallowPreMount(false, false), false);
  assert.equal(shouldSwallowPreMount(false, true), false);
});

test('server-mode pre-mount (no view yet): swallow the boot keystroke', () => {
  assert.equal(shouldSwallowPreMount(true, false), true);
});

test('server-mode mounted: do not swallow (the mounted arm routes to the server)', () => {
  assert.equal(shouldSwallowPreMount(true, true), false);
});

test('defer and swallow partition server-mode keystrokes (exactly one holds)', () => {
  // In server-mode every keystroke is either deferred (mounted → the server /
  // the view's own onKey dispatches) or swallowed (pre-mount) — never both,
  // never neither. This is what makes the router interpreter-free.
  for (const mounted of [true, false]) {
    const defer = shouldGlobalRouterDefer(true, mounted);
    const swallow = shouldSwallowPreMount(true, mounted);
    assert.notEqual(defer, swallow, `exactly one of defer/swallow at mounted=${mounted}`);
  }
});

test('only the strict booleans drive swallow', () => {
  // Defensive, like shouldGlobalRouterDefer: the call site passes `!!(...)`.
  assert.equal(shouldSwallowPreMount(1, 0), false);
  assert.equal(shouldSwallowPreMount('yes', false), false);
  assert.equal(shouldSwallowPreMount(true, 0), false); // mounted must be strict false
});
