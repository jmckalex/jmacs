import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  materialFileIconName,
  materialFolderIconName,
  materialIconUrl,
  materialIconUrlForEntry,
} from '../src/material-icons.js';

const BASE = 'app://editor/apps/desktop/vendor/material-icons/';

test('file icon by extension', () => {
  assert.equal(materialFileIconName('app.js'), 'javascript');
  assert.equal(materialFileIconName('main.ts'), 'typescript');
  assert.equal(materialFileIconName('index.php'), 'php');
  assert.equal(materialFileIconName('notes.md'), 'markdown');
});

test('compound extensions win over the simple suffix', () => {
  // foo.test.js → test-js, not javascript.
  assert.equal(materialFileIconName('foo.test.js'), 'test-js');
});

test('exact filename beats extension', () => {
  assert.equal(materialFileIconName('package.json'), 'nodejs'); // not 'json'
  assert.equal(materialFileIconName('tsconfig.json'), 'tsconfig');
  assert.equal(materialFileIconName('README.md'), 'readme'); // not 'markdown'
});

test('filename match is case-insensitive', () => {
  assert.equal(materialFileIconName('Dockerfile'), 'docker');
  assert.equal(materialFileIconName('dockerfile'), 'docker');
  assert.equal(materialFileIconName('Makefile'), 'makefile');
  assert.equal(materialFileIconName('LICENSE'), 'license');
});

test('our own file kinds via overrides', () => {
  assert.equal(materialFileIconName('paper.jmd'), 'markdown'); // JMarkdown
  assert.equal(materialFileIconName('nb.rxlisp'), 'lisp');
  assert.equal(materialFileIconName('init.el'), 'lisp');
});

test('unknown / extensionless files fall back to the default file icon', () => {
  assert.equal(materialFileIconName('mystery.zzz'), 'file');
  assert.equal(materialFileIconName('noext'), 'file');
  assert.equal(materialFileIconName(''), 'file');
  assert.equal(materialFileIconName(null), 'file');
});

test('folder icons, per-name + open variants', () => {
  assert.equal(materialFolderIconName('src', false), 'folder-src');
  assert.equal(materialFolderIconName('src', true), 'folder-src-open');
  assert.equal(materialFolderIconName('SRC', false), 'folder-src'); // case-insensitive
  assert.equal(materialFolderIconName('whatever', false), 'folder');
  assert.equal(materialFolderIconName('whatever', true), 'folder-open');
});

test('icon URL builds an app:// path to the vendored SVG', () => {
  assert.equal(materialIconUrl('javascript'), `${BASE}javascript.svg`);
  assert.equal(materialIconUrl(null), null);
  assert.equal(materialIconUrl(''), null);
});

test('entry URL: file vs directory', () => {
  assert.equal(materialIconUrlForEntry('index.php', false, false), `${BASE}php.svg`);
  assert.equal(materialIconUrlForEntry('src', true, true), `${BASE}folder-src-open.svg`);
  assert.equal(materialIconUrlForEntry('src', true, false), `${BASE}folder-src.svg`);
});
