/**
 * @file Tests for the Model-B server's user-path resolution (find-file /
 * write-file). Regression for: `~/tmp/results.txt` was treated as a literal
 * `~` directory under the seed-file dir, so find-file couldn't open a file
 * given by a tilde path (only a full absolute path worked).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveUserPath } from './path-resolve.js';

const HOME = '/Users/jalex';
const BASE = '/repo/packages/renderer/src';

test('resolveUserPath: ~/path expands to the home directory (the bug)', () => {
  assert.equal(
    resolveUserPath('~/tmp/results.txt', BASE, HOME),
    '/Users/jalex/tmp/results.txt'
  );
});

test('resolveUserPath: a bare ~ is the home directory', () => {
  assert.equal(resolveUserPath('~', BASE, HOME), '/Users/jalex');
});

test('resolveUserPath: an absolute path passes through unchanged', () => {
  assert.equal(resolveUserPath('/etc/hosts', BASE, HOME), '/etc/hosts');
});

test('resolveUserPath: a relative path resolves against the base dir', () => {
  assert.equal(
    resolveUserPath('notes.txt', BASE, HOME),
    '/repo/packages/renderer/src/notes.txt'
  );
});

test('resolveUserPath: ~user is NOT tilde-expanded (only ~ and ~/)', () => {
  // A literal segment beginning with ~ but not ~/ resolves against the base.
  assert.equal(
    resolveUserPath('~bob/x', BASE, HOME),
    '/repo/packages/renderer/src/~bob/x'
  );
});

test('resolveUserPath: empty / nullish path yields the base dir', () => {
  assert.equal(resolveUserPath('', BASE, HOME), BASE);
  assert.equal(resolveUserPath(null, BASE, HOME), BASE);
});
