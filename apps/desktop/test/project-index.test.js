import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  projectNameFromRoot,
  upsertProject,
  setProjectThumbnail,
  filterProjects,
  projectTileAppearance,
} from '../src/project-index.js';

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

test('upsertProject preserves an existing thumbnail when moving to front', () => {
  const list = [
    { path: '/a/one', name: 'one' },
    { path: '/a/two', name: 'two', thumbnail: '/img/two.png' },
  ];
  const next = upsertProject(list, '/a/two');
  assert.equal(next[0].path, '/a/two');
  assert.equal(next[0].thumbnail, '/img/two.png');
  assert.equal(next[0].name, 'two');
});

test('upsertProject keeps the existing name when none is supplied', () => {
  const list = [{ path: '/a/proj', name: 'Custom Name' }];
  const next = upsertProject(list, '/a/proj/');
  assert.equal(next[0].name, 'Custom Name');
});

test('setProjectThumbnail sets a thumbnail without reordering', () => {
  const list = [
    { path: '/a/one', name: 'one' },
    { path: '/a/two', name: 'two' },
  ];
  const next = setProjectThumbnail(list, '/a/two', '/img/two.png');
  assert.deepEqual(next.map((p) => p.path), ['/a/one', '/a/two']);
  assert.equal(next[1].thumbnail, '/img/two.png');
  assert.equal(next[0].thumbnail, undefined);
});

test('setProjectThumbnail normalises a trailing slash and clears on null/empty', () => {
  const list = [{ path: '/a/one', name: 'one', thumbnail: '/img/one.png' }];
  const set = setProjectThumbnail(list, '/a/one/', '/img/new.png');
  assert.equal(set[0].thumbnail, '/img/new.png');
  const cleared = setProjectThumbnail(set, '/a/one', null);
  assert.equal('thumbnail' in cleared[0], false);
  const clearedEmpty = setProjectThumbnail(set, '/a/one', '');
  assert.equal('thumbnail' in clearedEmpty[0], false);
});

test('setProjectThumbnail is a no-op for an unknown root', () => {
  const list = [{ path: '/a/one', name: 'one' }];
  const next = setProjectThumbnail(list, '/a/missing', '/img/x.png');
  assert.deepEqual(next, list);
});

test('filterProjects matches name or path, case-insensitively', () => {
  const list = [
    { path: '/src/jmacs', name: 'jmacs' },
    { path: '/src/btt', name: 'BTT toolkit' },
    { path: '/docs/notes', name: 'notes' },
  ];
  assert.deepEqual(filterProjects(list, 'JM').map((p) => p.name), ['jmacs']);
  assert.deepEqual(filterProjects(list, 'toolkit').map((p) => p.name), ['BTT toolkit']);
  assert.deepEqual(filterProjects(list, '/docs/').map((p) => p.name), ['notes']);
});

test('filterProjects returns every entry for a blank query', () => {
  const list = [{ path: '/a/one', name: 'one' }, { path: '/a/two', name: 'two' }];
  assert.equal(filterProjects(list, '').length, 2);
  assert.equal(filterProjects(list, '   ').length, 2);
});

test('projectTileAppearance derives initials from words or a single name', () => {
  assert.equal(projectTileAppearance('BTT toolkit').initials, 'BT');
  assert.equal(projectTileAppearance('jmacs').initials, 'JM');
  assert.equal(projectTileAppearance('the-rise-of').initials, 'TR');
  assert.equal(projectTileAppearance('').initials, '?');
});

test('projectTileAppearance colour is deterministic per name and stable', () => {
  const a = projectTileAppearance('jmckalex.org');
  const b = projectTileAppearance('jmckalex.org');
  assert.equal(a.bg, b.bg);
  assert.equal(a.hue, b.hue);
  assert.ok(a.hue >= 0 && a.hue < 360);
  assert.match(a.bg, /^hsl\(/);
  // Different names generally differ in hue.
  assert.notEqual(projectTileAppearance('alpha').hue, projectTileAppearance('omega').hue);
});
