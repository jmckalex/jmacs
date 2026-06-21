import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectNameFromRoot, upsertProject } from '../src/project-index.js';

test('projectNameFromRoot returns the final path segment', () => {
  assert.equal(projectNameFromRoot('/Users/jalex/Source/jmacs'), 'jmacs');
  assert.equal(projectNameFromRoot('/Users/jalex/btt'), 'btt');
});

test('projectNameFromRoot ignores a trailing slash', () => {
  assert.equal(projectNameFromRoot('/Users/jalex/Source/jmacs/'), 'jmacs');
  assert.equal(projectNameFromRoot('/Users/jalex/Source/jmacs///'), 'jmacs');
});

test('projectNameFromRoot is empty for an empty / non-string root', () => {
  assert.equal(projectNameFromRoot(''), '');
  assert.equal(projectNameFromRoot(null), '');
  assert.equal(projectNameFromRoot(undefined), '');
});

test('upsertProject inserts a fresh project at the front', () => {
  const next = upsertProject([], '/Users/jalex/btt');
  assert.deepEqual(next, [{ path: '/Users/jalex/btt', name: 'btt' }]);
});

test('upsertProject moves an existing project to the front, deduped', () => {
  const list = [
    { path: '/a/one', name: 'one' },
    { path: '/a/two', name: 'two' },
    { path: '/a/three', name: 'three' },
  ];
  const next = upsertProject(list, '/a/three');
  assert.deepEqual(next.map((p) => p.path), ['/a/three', '/a/one', '/a/two']);
  // No duplicate of /a/three.
  assert.equal(next.filter((p) => p.path === '/a/three').length, 1);
});

test('upsertProject normalises a trailing slash when deduping', () => {
  const list = [{ path: '/a/one', name: 'one' }];
  const next = upsertProject(list, '/a/one/');
  assert.equal(next.length, 1);
  assert.equal(next[0].path, '/a/one');
});

test('upsertProject preserves the relative order of the untouched tail', () => {
  const list = [
    { path: '/a/one', name: 'one' },
    { path: '/a/two', name: 'two' },
  ];
  const next = upsertProject(list, '/a/new');
  assert.deepEqual(next.map((p) => p.path), ['/a/new', '/a/one', '/a/two']);
});

test('upsertProject honours an explicit display name', () => {
  const next = upsertProject([], '/a/proj', 'My Project');
  assert.deepEqual(next, [{ path: '/a/proj', name: 'My Project' }]);
});

test('upsertProject ignores a blank root and drops malformed entries', () => {
  const list = [{ path: '/a/one', name: 'one' }, null, { name: 'no path' }];
  const next = upsertProject(list, '');
  assert.deepEqual(next, [{ path: '/a/one', name: 'one' }]);
});
