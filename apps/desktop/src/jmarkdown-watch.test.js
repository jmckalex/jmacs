/**
 * @file Unit tests for the pure helpers of the JMarkdown preview watcher.
 *
 * The spawn / port-probe / reaping paths are I/O against a real subprocess and
 * are verified live (a running watch server); the argument + environment
 * builders are pure and tested here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWatchArgs,
  watchEnv,
  shadowPathFor,
  shadowHtmlSibling,
} from './jmarkdown-watch-args.js';

test('buildWatchArgs runs `watch <file> --port <port>` with a stringified port', () => {
  assert.deepEqual(
    buildWatchArgs('/docs/paper.jmd', 4321),
    ['watch', '/docs/paper.jmd', '--port', '4321']
  );
});

test('buildWatchArgs passes the path verbatim (spaces are an arg, not shell)', () => {
  // No shell, so a space-bearing path is a single argv entry — no quoting.
  assert.deepEqual(
    buildWatchArgs('/My Docs/a b.md', 3000),
    ['watch', '/My Docs/a b.md', '--port', '3000']
  );
});

test('watchEnv appends the common bin dirs, keeping existing PATH priority', () => {
  const env = watchEnv({ PATH: '/usr/bin:/bin', HOME: '/home/x' });
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin');
  assert.equal(env.HOME, '/home/x', 'other vars are preserved');
});

test('watchEnv does not duplicate a bin dir already on PATH', () => {
  const env = watchEnv({ PATH: '/opt/homebrew/bin:/usr/bin' });
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/bin:/usr/local/bin');
});

test('watchEnv tolerates a missing PATH', () => {
  const env = watchEnv({});
  assert.equal(env.PATH, '/usr/local/bin:/opt/homebrew/bin');
});

test('shadowPathFor is a hidden .godot-preview sibling in the same directory', () => {
  // Same directory ⇒ relative CSS / bib / image / [[include]] paths resolve as
  // for the real file; hidden + .godot-preview infix ⇒ out of the way.
  assert.equal(
    shadowPathFor('/docs/paper.jmd'),
    '/docs/.paper.godot-preview.jmd'
  );
  assert.equal(
    shadowPathFor('/My Docs/a b.md'),
    '/My Docs/.a b.godot-preview.md'
  );
});

test('shadowPathFor keeps the original extension (jmd vs md matters to jmarkdown)', () => {
  assert.ok(shadowPathFor('/x/n.jmd').endsWith('.godot-preview.jmd'));
  assert.ok(shadowPathFor('/x/n.md').endsWith('.godot-preview.md'));
});

test('shadowHtmlSibling is the .html build-output next to the shadow', () => {
  assert.equal(
    shadowHtmlSibling('/docs/.paper.godot-preview.jmd'),
    '/docs/.paper.godot-preview.html'
  );
});
