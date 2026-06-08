/**
 * @file Unit tests for the pure helpers behind the split-placeholder
 * chooser (`packages/renderer/src/placeholder-actions.js`). These run
 * under Node with no DOM. The element's interaction and the host wiring
 * (mount, focus-on-split, replacePlaceholder, run-command landing) are
 * covered by the live hand-off, not here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLACEHOLDER_ACTIONS,
  DEFAULT_PLACEHOLDER_ACTION,
  resolvePlaceholderAction,
  cloneTargetForKind,
  isPlaceholderView,
} from '../src/placeholder-actions.js';

test('the canonical action set is the five spec values, default clone', () => {
  assert.deepEqual([...PLACEHOLDER_ACTIONS], [
    'open',
    'clone',
    'new',
    'command',
    'none',
  ]);
  assert.equal(DEFAULT_PLACEHOLDER_ACTION, 'clone');
});

test('resolvePlaceholderAction: accepts each canonical string', () => {
  for (const a of PLACEHOLDER_ACTIONS) {
    assert.equal(resolvePlaceholderAction(a), a);
  }
});

test('resolvePlaceholderAction: accepts a Lisp-symbol-like object', () => {
  assert.equal(resolvePlaceholderAction({ name: 'open' }), 'open');
  assert.equal(resolvePlaceholderAction({ name: 'command' }), 'command');
});

test('resolvePlaceholderAction: tolerates case, whitespace, and a quote', () => {
  assert.equal(resolvePlaceholderAction('  CLONE '), 'clone');
  assert.equal(resolvePlaceholderAction("'new"), 'new');
  assert.equal(resolvePlaceholderAction('None'), 'none');
});

test('resolvePlaceholderAction: junk and nil fall back to clone', () => {
  assert.equal(resolvePlaceholderAction(null), 'clone');
  assert.equal(resolvePlaceholderAction(undefined), 'clone');
  assert.equal(resolvePlaceholderAction('frobnicate'), 'clone');
  assert.equal(resolvePlaceholderAction(42), 'clone');
});

test('cloneTargetForKind: text shares its buffer', () => {
  assert.equal(cloneTargetForKind('text'), 'same-buffer');
});

test('cloneTargetForKind: browser clones the URL', () => {
  assert.equal(cloneTargetForKind('browser'), 'same-url');
});

test('cloneTargetForKind: file-backed media clone the same file', () => {
  assert.equal(cloneTargetForKind('pdf'), 'same-file');
  assert.equal(cloneTargetForKind('image'), 'same-file');
  assert.equal(cloneTargetForKind('audio'), 'same-file');
  assert.equal(cloneTargetForKind('video'), 'same-file');
});

test('cloneTargetForKind: session-bearing kinds get a fresh instance', () => {
  assert.equal(cloneTargetForKind('shell'), 'fresh');
  assert.equal(cloneTargetForKind('gnuplot'), 'fresh');
  assert.equal(cloneTargetForKind('notebook'), 'fresh');
  assert.equal(cloneTargetForKind('directory-tree'), 'fresh');
  assert.equal(cloneTargetForKind('directory-columns'), 'fresh');
});

test('cloneTargetForKind: anything else falls back to scratch', () => {
  assert.equal(cloneTargetForKind('customize'), 'scratch');
  assert.equal(cloneTargetForKind('doc'), 'scratch');
  assert.equal(cloneTargetForKind('jukebox'), 'scratch');
  assert.equal(cloneTargetForKind('view-list'), 'scratch');
  assert.equal(cloneTargetForKind('placeholder'), 'scratch');
  assert.equal(cloneTargetForKind(null), 'scratch');
  assert.equal(cloneTargetForKind(undefined), 'scratch');
});

test('isPlaceholderView: only a placeholder-kind view matches', () => {
  assert.equal(isPlaceholderView({ kind: 'placeholder' }), true);
  assert.equal(isPlaceholderView({ kind: 'text' }), false);
  assert.equal(isPlaceholderView({ kind: 'browser' }), false);
  assert.equal(isPlaceholderView(null), false);
  assert.equal(isPlaceholderView(undefined), false);
  assert.equal(isPlaceholderView({}), false);
});
