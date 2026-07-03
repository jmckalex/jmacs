/**
 * @file Tests for the follow-the-caret decision (`follow-cursor.js`).
 *
 * This is the pure core of the fix for the "autosave (or any background
 * repaint) scrolls my editor" bug: the editor must follow the caret only when
 * the caret may have moved — a real edit, a switch/reveal, or an actual offset
 * change — and never on a pure repaint that leaves the caret put. The DOM
 * scroll plumbing around it (`scrollIntoView`) is exercised live / by the
 * smoke arm; the decision is tested here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFollowTracker } from '../src/follow-cursor.js';

test('the first follow always scrolls (nothing followed yet)', () => {
  const t = createFollowTracker();
  assert.equal(t.shouldScroll(0), true);
});

test('a follow to the SAME offset does not scroll again', () => {
  const t = createFollowTracker();
  t.shouldScroll(42); // caret shown at 42
  assert.equal(t.shouldScroll(42), false); // a repaint at 42: no yank
  assert.equal(t.shouldScroll(42), false); // still no yank
});

test('a follow to a NEW offset scrolls (the caret moved)', () => {
  const t = createFollowTracker();
  t.shouldScroll(42);
  assert.equal(t.shouldScroll(43), true); // cursor advanced: keep it visible
});

test('the bug scenario: repeated background repaints never yank a scrolled-away viewport', () => {
  const t = createFollowTracker();
  // The user typed; the caret was followed to offset 100.
  assert.equal(t.shouldScroll(100), true);
  // The user scrolls away (caret unchanged) and the server sends periodic
  // reconciles / overlay refreshes — each is a follow render at the SAME
  // offset. None may scroll, or the viewport is yanked back to the caret.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(t.shouldScroll(100), false);
  }
});

test('forceOnce() scrolls even when the offset is unchanged (a real edit)', () => {
  const t = createFollowTracker();
  t.shouldScroll(100); // caret at 100
  // A forward-delete edits text without advancing the offset; Emacs keeps the
  // caret visible anyway, so a real edit forces the follow.
  t.forceOnce();
  assert.equal(t.shouldScroll(100), true);
});

test('forceOnce() is a one-shot: it does not stick to later repaints', () => {
  const t = createFollowTracker();
  t.shouldScroll(100);
  t.forceOnce();
  assert.equal(t.shouldScroll(100), true); // forced once
  assert.equal(t.shouldScroll(100), false); // and only once — repaint stays put
});

test('forceOnce() models a switch/reveal whose caret sits at the same offset', () => {
  const t = createFollowTracker();
  t.shouldScroll(7); // was following a view whose caret is at 7
  // Switch to another buffer whose caret is ALSO at offset 7 but off-screen:
  // the caller forces so it is shown despite the numeric offset matching.
  t.forceOnce();
  assert.equal(t.shouldScroll(7), true);
});

test('recentered() syncs the offset so the following repaint stays put', () => {
  const t = createFollowTracker();
  t.shouldScroll(10);
  // C-l recenters at offset 250 (it scrolls on its own; the tracker just
  // records it). A subsequent plain repaint at 250 must not re-scroll.
  t.recentered(250);
  assert.equal(t.shouldScroll(250), false);
  // But a genuine move away from 250 still follows.
  assert.equal(t.shouldScroll(251), true);
});

test('recentered() clears a pending force', () => {
  const t = createFollowTracker();
  t.forceOnce();
  t.recentered(30); // the recenter already scrolled; drop the pending force
  assert.equal(t.shouldScroll(30), false);
});

test('a non-finite offset never scrolls and does not disturb the recorded offset', () => {
  const t = createFollowTracker();
  t.shouldScroll(100);
  assert.equal(t.shouldScroll(Number.NaN), false);
  assert.equal(t.shouldScroll(Infinity), false);
  // 100 is still the recorded offset — a repaint there stays put.
  assert.equal(t.shouldScroll(100), false);
  // and a real move still follows.
  assert.equal(t.shouldScroll(101), true);
});
