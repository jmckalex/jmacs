/**
 * @file synctex-parse.test.js — unit tests for the pure SyncTeX output
 * parsers (`parseSynctexView` forward, `parseSynctexEdit` inverse).
 *
 * Covers the well-formed record, the `SyncTeX result begin/end` framing,
 * multi-record stdout (first record wins), CRLF endings, missing-field
 * tolerance, and the empty / non-parsable → null cases that the Lisp
 * caller treats as "no sync result".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSynctexView, parseSynctexEdit } from '../src/synctex-parse.js';

// --- parseSynctexView (forward: source -> PDF) ------------------------

test('parseSynctexView reads a framed single record', () => {
  const stdout = [
    'This is SyncTeX command line utility, version 1.5',
    'SyncTeX result begin',
    'Output:paper.pdf',
    'Page:3',
    'x:123.4',
    'y:56.7',
    'h:120.0',
    'v:650.0',
    'W:300.0',
    'H:12.0',
    'SyncTeX result end',
  ].join('\n');
  assert.deepEqual(parseSynctexView(stdout), {
    page: 3, x: 123.4, y: 56.7, h: 120.0, v: 650.0, W: 300.0, H: 12.0,
  });
});

test('parseSynctexView returns the FIRST of several records', () => {
  const stdout = [
    'SyncTeX result begin',
    'Page:2',
    'x:10',
    'y:20',
    'h:11',
    'v:22',
    'W:100',
    'H:8',
    'Page:5',
    'x:99',
    'y:88',
    'h:77',
    'v:66',
    'W:200',
    'H:9',
    'SyncTeX result end',
  ].join('\n');
  const box = parseSynctexView(stdout);
  assert.equal(box.page, 2);
  assert.equal(box.h, 11);
  assert.equal(box.W, 100);
});

test('parseSynctexView tolerates CRLF line endings', () => {
  const stdout = 'Page:1\r\nh:5.5\r\nv:6.5\r\nW:50\r\nH:4\r\n';
  const box = parseSynctexView(stdout);
  assert.equal(box.page, 1);
  assert.equal(box.h, 5.5);
  assert.equal(box.v, 6.5);
});

test('parseSynctexView fills missing numeric fields with 0', () => {
  // A page with no W/H still yields a usable point (zero-size box).
  const box = parseSynctexView('Page:4\nh:30\nv:40\n');
  assert.deepEqual(box, {
    page: 4, x: 0, y: 0, h: 30, v: 40, W: 0, H: 0,
  });
});

test('parseSynctexView returns null with no Page record', () => {
  assert.equal(parseSynctexView('SyncTeX result begin\nOutput:x.pdf\n'), null);
});

test('parseSynctexView returns null on empty / non-string input', () => {
  assert.equal(parseSynctexView(''), null);
  assert.equal(parseSynctexView(null), null);
  assert.equal(parseSynctexView(undefined), null);
});

// --- parseSynctexEdit (inverse: PDF -> source) ------------------------

test('parseSynctexEdit reads a framed record', () => {
  const stdout = [
    'This is SyncTeX command line utility, version 1.5',
    'SyncTeX result begin',
    'Output:paper.pdf',
    'Input:/Users/me/doc/main.tex',
    'Line:42',
    'Column:-1',
    'SyncTeX result end',
  ].join('\n');
  assert.deepEqual(parseSynctexEdit(stdout), {
    file: '/Users/me/doc/main.tex',
    line: 42,
    column: -1,
  });
});

test('parseSynctexEdit returns the FIRST Input/Line pair', () => {
  const stdout = [
    'Input:/abs/a.tex',
    'Line:10',
    'Column:3',
    'Input:/abs/b.tex',
    'Line:99',
    'Column:7',
  ].join('\n');
  assert.deepEqual(parseSynctexEdit(stdout), {
    file: '/abs/a.tex',
    line: 10,
    column: 3,
  });
});

test('parseSynctexEdit defaults Column to -1 when absent', () => {
  const stdout = 'Input:/abs/main.tex\nLine:7\n';
  assert.deepEqual(parseSynctexEdit(stdout), {
    file: '/abs/main.tex',
    line: 7,
    column: -1,
  });
});

test('parseSynctexEdit tolerates CRLF endings', () => {
  const stdout = 'Input:/abs/main.tex\r\nLine:5\r\nColumn:2\r\n';
  assert.deepEqual(parseSynctexEdit(stdout), {
    file: '/abs/main.tex',
    line: 5,
    column: 2,
  });
});

test('parseSynctexEdit returns null without an Input', () => {
  assert.equal(parseSynctexEdit('Line:3\nColumn:1\n'), null);
});

test('parseSynctexEdit returns null without a Line', () => {
  assert.equal(parseSynctexEdit('Input:/abs/main.tex\n'), null);
});

test('parseSynctexEdit returns null on empty / non-string input', () => {
  assert.equal(parseSynctexEdit(''), null);
  assert.equal(parseSynctexEdit(null), null);
});
