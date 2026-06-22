/**
 * @file Tests for the G2 single-live-view sweep (`server-view-mount.js`).
 *
 * The sweep enforces "one `<text-view>` in the container" across a server-pushed
 * buffer switch: `app.js`'s `mountServerView` calls it before appending the new
 * view, so dead empty `<text-view>` elements (the inner editor's destroy leaves
 * the host element behind) don't accumulate on each switch. These run under
 * `node --test` with a minimal fake host — no Electron, no real DOM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clearStaleServerViews } from '../src/server-view-mount.js';

/** A fake `<text-view>` recording destroy()/remove() and whether it is still
 *  linked to the host. `destroyThrows` simulates a half-built element. */
function fakeTextView({ destroyThrows = false } = {}) {
  return {
    tag: 'text-view',
    destroyed: false,
    removed: false,
    destroy() {
      this.destroyed = true;
      if (destroyThrows) throw new Error('half-built');
    },
    remove() { this.removed = true; },
  };
}

/** A fake host whose querySelectorAll('text-view') returns its current
 *  text-view children. remove() on a child unlinks it from the host (so a
 *  later query doesn't see it). */
function fakeHost(children = []) {
  const host = {
    children: [...children],
    querySelectorAll(selector) {
      if (selector !== 'text-view') return [];
      // Patch each child's remove to also unlink from the host, mirroring DOM.
      for (const c of this.children) {
        const orig = c.remove.bind(c);
        c.remove = () => {
          orig();
          host.children = host.children.filter((x) => x !== c);
        };
      }
      return this.children.filter((c) => c.tag === 'text-view');
    },
  };
  return host;
}

test('the initial mount (empty host) sweeps nothing', () => {
  const host = fakeHost([]);
  assert.equal(clearStaleServerViews(host), 0);
  assert.equal(host.children.length, 0);
});

test('a switch sweeps the one stale view: destroy() + remove() it', () => {
  const stale = fakeTextView();
  const host = fakeHost([stale]);
  const swept = clearStaleServerViews(host);
  assert.equal(swept, 1, 'reported one swept');
  assert.equal(stale.destroyed, true, 'the stale view was destroyed');
  assert.equal(stale.removed, true, 'the stale view was removed from the host');
  assert.equal(host.children.length, 0, 'the host is now empty for the re-mount');
});

test('several accumulated stale views are ALL swept (the bug being fixed)', () => {
  // The regression: without the sweep, each switch left a dead element behind.
  const a = fakeTextView();
  const b = fakeTextView();
  const c = fakeTextView();
  const host = fakeHost([a, b, c]);
  assert.equal(clearStaleServerViews(host), 3);
  assert.ok([a, b, c].every((v) => v.removed), 'every stale view removed');
  assert.equal(host.children.length, 0);
});

test('a stale view whose destroy() throws is still removed (no leak)', () => {
  const stale = fakeTextView({ destroyThrows: true });
  const host = fakeHost([stale]);
  // Must not throw out (the guardrail: never throw into the main process).
  assert.doesNotThrow(() => clearStaleServerViews(host));
  assert.equal(stale.removed, true, 'removed despite the destroy() throw');
  assert.equal(host.children.length, 0);
});

test('an element without destroy() is removed (no-op destroy)', () => {
  const stale = { tag: 'text-view', removed: false, remove() { this.removed = true; } };
  const host = fakeHost([stale]);
  assert.doesNotThrow(() => clearStaleServerViews(host));
  assert.equal(stale.removed, true);
});

test('a missing / malformed host is a safe no-op (returns 0)', () => {
  assert.equal(clearStaleServerViews(null), 0);
  assert.equal(clearStaleServerViews(undefined), 0);
  assert.equal(clearStaleServerViews({}), 0);
});
