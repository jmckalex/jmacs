/**
 * @file path-resolve.test.js — unit tests for the pure POSIX path
 * helpers used by the RefTeX file-walking logic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  pathDirname,
  pathBasename,
  pathResolve,
  normalizePath,
} from '../src/path-resolve.js';

// --- pathDirname -----------------------------------------------------

test('pathDirname returns the directory portion', () => {
  assert.equal(pathDirname('/a/b/c'), '/a/b');
  assert.equal(pathDirname('a/b'), 'a');
});

test('pathDirname ignores a trailing slash', () => {
  assert.equal(pathDirname('/a/b/c/'), '/a/b');
});

test('pathDirname on a bare name is "."', () => {
  assert.equal(pathDirname('file.tex'), '.');
});

test('pathDirname handles root edge cases', () => {
  assert.equal(pathDirname('/'), '/');
  assert.equal(pathDirname('/a'), '/');
  assert.equal(pathDirname(''), '.');
});

// --- pathBasename ----------------------------------------------------

test('pathBasename returns the final component', () => {
  assert.equal(pathBasename('/a/b/c.tex'), 'c.tex');
  assert.equal(pathBasename('a'), 'a');
});

test('pathBasename ignores a trailing slash', () => {
  assert.equal(pathBasename('/a/b/c/'), 'c');
});

test('pathBasename root / empty edge cases', () => {
  assert.equal(pathBasename('/'), '');
  assert.equal(pathBasename(''), '');
});

// --- normalizePath ---------------------------------------------------

test('normalizePath collapses "." and "//"', () => {
  assert.equal(normalizePath('/a/./b//c'), '/a/b/c');
});

test('normalizePath collapses ".."', () => {
  assert.equal(normalizePath('/a/b/../c'), '/a/c');
});

test('normalizePath keeps leading ".." on a relative path', () => {
  assert.equal(normalizePath('a/../../b'), '../b');
});

test('normalizePath at root ignores extra ".."', () => {
  assert.equal(normalizePath('/..'), '/');
  assert.equal(normalizePath('/../../a'), '/a');
});

test('normalizePath drops a trailing slash', () => {
  assert.equal(normalizePath('/a/b/'), '/a/b');
});

// --- pathResolve -----------------------------------------------------

test('pathResolve joins a relative path against a base dir', () => {
  assert.equal(pathResolve('/a/b', 'c.tex'), '/a/b/c.tex');
});

test('pathResolve resolves "./"', () => {
  assert.equal(pathResolve('/a/b', './c.tex'), '/a/b/c.tex');
});

test('pathResolve resolves "../"', () => {
  assert.equal(pathResolve('/a/b', '../c.tex'), '/a/c.tex');
  assert.equal(pathResolve('/a/b/c', '../../d.tex'), '/a/d.tex');
});

test('pathResolve passes an absolute relative through, normalised', () => {
  assert.equal(pathResolve('/a/b', '/x/y.tex'), '/x/y.tex');
  assert.equal(pathResolve('/a/b', '/x/../y.tex'), '/y.tex');
});

test('pathResolve with an empty base returns the normalised relative', () => {
  assert.equal(pathResolve('', 'c.tex'), 'c.tex');
  assert.equal(pathResolve('', './sub/c.tex'), 'sub/c.tex');
});

test('the RefTeX call shape resolves a chapter against a master', () => {
  const master = '/home/user/book/main.tex';
  assert.equal(
    pathResolve(pathDirname(master), 'chapters/intro.tex'),
    '/home/user/book/chapters/intro.tex'
  );
});
