/**
 * @file Tests for config-home.js — the `~/.godot` config home, its
 * GODOT_HOME override, and the one-time legacy-userData migration.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configHomePath,
  ensureConfigHome,
  migrateLegacyConfig,
  setupConfigHome,
} from '../src/config-home.js';

/**
 * Run FN with an isolated temp root, restoring $GODOT_HOME afterwards so the
 * override never leaks into another test.
 */
function withTemp(fn) {
  const saved = process.env.GODOT_HOME;
  const root = mkdtempSync(join(tmpdir(), 'godot-cfg-'));
  try {
    fn(root);
  } finally {
    if (saved === undefined) delete process.env.GODOT_HOME;
    else process.env.GODOT_HOME = saved;
    rmSync(root, { recursive: true, force: true });
  }
}

test('configHomePath honours $GODOT_HOME when set', () => {
  withTemp((root) => {
    const home = join(root, 'home');
    process.env.GODOT_HOME = home;
    assert.equal(configHomePath(), home);
  });
});

test('configHomePath defaults to ~/.godot when GODOT_HOME is unset', () => {
  withTemp(() => {
    delete process.env.GODOT_HOME;
    assert.equal(configHomePath(), join(homedir(), '.godot'));
  });
});

test('ensureConfigHome creates the directory', () => {
  withTemp((root) => {
    const home = join(root, 'home');
    process.env.GODOT_HOME = home;
    assert.equal(existsSync(home), false);
    assert.equal(ensureConfigHome(), home);
    assert.equal(existsSync(home), true);
  });
});

test('migrateLegacyConfig copies the whitelisted config — files and dirs', () => {
  withTemp((root) => {
    const home = join(root, 'home');
    const legacy = join(root, 'legacy');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(legacy, 'snippets', 'js-mode'), { recursive: true });
    writeFileSync(join(legacy, 'custom.lisp'), '(custom)');
    writeFileSync(join(legacy, 'session.json'), '{}');
    writeFileSync(join(legacy, 'snippets', 'js-mode', 'for.yas'), 'snip');

    const copied = migrateLegacyConfig(legacy, home);
    assert.deepEqual(
      copied.slice().sort(),
      ['custom.lisp', 'session.json', 'snippets'].sort()
    );
    assert.equal(readFileSync(join(home, 'custom.lisp'), 'utf8'), '(custom)');
    assert.equal(
      readFileSync(join(home, 'snippets', 'js-mode', 'for.yas'), 'utf8'),
      'snip'
    );
  });
});

test('migrateLegacyConfig leaves Chromium machinery behind', () => {
  withTemp((root) => {
    const home = join(root, 'home');
    const legacy = join(root, 'legacy');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(legacy, 'Cache'), { recursive: true });
    writeFileSync(join(legacy, 'Cache', 'data'), 'x');
    writeFileSync(join(legacy, 'Cookies'), 'c');
    writeFileSync(join(legacy, 'custom.lisp'), '(c)');

    migrateLegacyConfig(legacy, home);
    assert.equal(existsSync(join(home, 'Cache')), false);
    assert.equal(existsSync(join(home, 'Cookies')), false);
    assert.equal(existsSync(join(home, 'custom.lisp')), true);
  });
});

test('migrateLegacyConfig does not overwrite an entry already in the home', () => {
  withTemp((root) => {
    const home = join(root, 'home');
    const legacy = join(root, 'legacy');
    mkdirSync(home, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(home, 'custom.lisp'), 'NEW');
    writeFileSync(join(legacy, 'custom.lisp'), 'OLD');

    const copied = migrateLegacyConfig(legacy, home);
    assert.equal(copied.includes('custom.lisp'), false);
    assert.equal(readFileSync(join(home, 'custom.lisp'), 'utf8'), 'NEW');
  });
});

test('migrateLegacyConfig is non-destructive to the legacy dir', () => {
  withTemp((root) => {
    const home = join(root, 'home');
    const legacy = join(root, 'legacy');
    mkdirSync(home, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'custom.lisp'), '(c)');
    migrateLegacyConfig(legacy, home);
    assert.equal(existsSync(join(legacy, 'custom.lisp')), true);
  });
});

test('migrateLegacyConfig is a no-op when legacy === home', () => {
  withTemp((root) => {
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'custom.lisp'), '(c)');
    assert.deepEqual(migrateLegacyConfig(home, home), []);
  });
});

test('setupConfigHome migrates on the first run only', () => {
  withTemp((root) => {
    const home = join(root, 'home');
    const legacy = join(root, 'legacy');
    process.env.GODOT_HOME = home;
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'custom.lisp'), '(c)');

    // First run: the home is created and config migrates in.
    assert.equal(setupConfigHome(legacy), home);
    assert.equal(existsSync(join(home, 'custom.lisp')), true);

    // The user deletes a migrated file; a later run must NOT resurrect it.
    rmSync(join(home, 'custom.lisp'));
    setupConfigHome(legacy);
    assert.equal(existsSync(join(home, 'custom.lisp')), false);
  });
});
