/**
 * @file Tests for the snippet engine (snippets-parser.lisp,
 * snippets.lisp, snippets-keymap.lisp).
 *
 * The parser tests load just `snippets-parser.lisp` into a bare
 * interpreter — it is pure data-in / data-out, so no buffer or host
 * stubs are needed. The engine and navigation tests load the full
 * standard library against a live buffer with the snippet host
 * primitives stubbed (a fake snippet filesystem).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import {
  arrayToList,
  cons,
  createInterpreter,
  keyword,
  listToArray,
  NIL,
} from '@editor/lisp';
import { createBufferPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');
const languagesDir = join(lispDir, 'languages');

// --- parser-only harness -------------------------------------------------

/** A bare interpreter with only the snippet parser loaded. */
function parserInterp() {
  const interp = createInterpreter({ write: () => {} });
  interp.evaluate(readFileSync(join(lispDir, 'snippets-parser.lisp'), 'utf8'));
  return interp;
}

const kw = (map, name) => map.get(keyword(name));

/** Read a parsed-body field list into plain JS objects. */
function fieldsOf(interp, bindingExpr) {
  return listToArray(interp.evaluate(`(get ${bindingExpr} :fields nil)`)).map(
    (f) => ({
      index: kw(f, 'index'),
      start: kw(f, 'start'),
      end: kw(f, 'end'),
      default: kw(f, 'default'),
    })
  );
}

function mirrorsOf(interp, bindingExpr) {
  return listToArray(interp.evaluate(`(get ${bindingExpr} :mirrors nil)`)).map(
    (m) => ({ index: kw(m, 'index'), start: kw(m, 'start'), end: kw(m, 'end') })
  );
}

// --- parser: file format -------------------------------------------------

test('parse-snippet-file reads the yasnippet header and body', () => {
  const interp = parserInterp();
  interp.evaluate(
    '(define f (parse-snippet-file ' +
      '"# -*- mode: snippet -*-\n# key: for\n# name: for-loop\n' +
      '# group: control-flow\n# --\nfor (x) {}\n"))'
  );
  assert.equal(interp.evaluate('(get f :key nil)'), 'for');
  assert.equal(interp.evaluate('(get f :name nil)'), 'for-loop');
  assert.equal(interp.evaluate('(get f :group nil)'), 'control-flow');
  assert.equal(interp.evaluate('(get f :body nil)'), 'for (x) {}\n');
});

test('parse-snippet-file tolerates a file with no header block', () => {
  const interp = parserInterp();
  interp.evaluate('(define f (parse-snippet-file "just a body\nline two"))');
  assert.equal(interp.evaluate('(get f :key nil)'), NIL);
  assert.equal(interp.evaluate('(get f :body nil)'), 'just a body\nline two');
});

test('parse-snippet-file keeps a body that itself contains "#" lines', () => {
  const interp = parserInterp();
  interp.evaluate(
    '(define f (parse-snippet-file "# key: sh\n# --\n#!/bin/sh\necho hi"))'
  );
  assert.equal(interp.evaluate('(get f :key nil)'), 'sh');
  assert.equal(interp.evaluate('(get f :body nil)'), '#!/bin/sh\necho hi');
});

// --- parser: body / tab stops --------------------------------------------

test('parse-snippet-body resolves defaults into the inserted text', () => {
  const interp = parserInterp();
  interp.evaluate(
    '(define b (parse-snippet-body "for (${1:i} = 0; $1 < ${2:n}) {\n  $0\n}"))'
  );
  assert.equal(
    interp.evaluate('(get b :text nil)'),
    'for (i = 0; i < n) {\n  \n}'
  );
});

test('parse-snippet-body sorts fields by tab index with correct ranges', () => {
  const interp = parserInterp();
  interp.evaluate('(define b (parse-snippet-body "${2:b}-${1:a}-${3:c}"))');
  // text is "b-a-c"
  assert.equal(interp.evaluate('(get b :text nil)'), 'b-a-c');
  const fields = fieldsOf(interp, 'b');
  assert.deepEqual(
    fields.map((f) => f.index),
    [1, 2, 3]
  );
  // field 1 ('a') sits at offset 2..3, field 2 ('b') at 0..1, 3 ('c') 4..5.
  const byIndex = Object.fromEntries(fields.map((f) => [f.index, f]));
  assert.deepEqual(
    [byIndex[1].start, byIndex[1].end, byIndex[1].default],
    [2, 3, 'a']
  );
  assert.deepEqual(
    [byIndex[2].start, byIndex[2].end, byIndex[2].default],
    [0, 1, 'b']
  );
});

test('parse-snippet-body records the $0 exit position', () => {
  const interp = parserInterp();
  interp.evaluate('(define b (parse-snippet-body "abc$0def"))');
  assert.equal(interp.evaluate('(get b :text nil)'), 'abcdef');
  assert.equal(interp.evaluate('(get b :exit nil)'), 3);
});

test('parse-snippet-body defaults the exit to text end when no $0', () => {
  const interp = parserInterp();
  interp.evaluate('(define b (parse-snippet-body "hello ${1:world}"))');
  assert.equal(interp.evaluate('(get b :exit nil)'), 11);
});

test('parse-snippet-body resolves a bare $N to an empty default', () => {
  const interp = parserInterp();
  interp.evaluate('(define b (parse-snippet-body "x$1y"))');
  assert.equal(interp.evaluate('(get b :text nil)'), 'xy');
  const fields = fieldsOf(interp, 'b');
  assert.equal(fields.length, 1);
  assert.deepEqual([fields[0].start, fields[0].end], [1, 1]);
});

test('parse-snippet-body treats $$ as a literal dollar', () => {
  const interp = parserInterp();
  interp.evaluate('(define b (parse-snippet-body "cost: $$5"))');
  assert.equal(interp.evaluate('(get b :text nil)'), 'cost: $5');
  assert.equal(listToArray(interp.evaluate('(get b :fields nil)')).length, 0);
});

test('parse-snippet-body records mirrors of a repeated index', () => {
  const interp = parserInterp();
  interp.evaluate('(define b (parse-snippet-body "${1:x} and $1 and $1"))');
  // text: "x and x and x"
  assert.equal(interp.evaluate('(get b :text nil)'), 'x and x and x');
  const fields = fieldsOf(interp, 'b');
  assert.equal(fields.length, 1);
  // The canonical field is the one carrying the default (offset 0..1).
  assert.deepEqual([fields[0].start, fields[0].end], [0, 1]);
  const mirrors = mirrorsOf(interp, 'b');
  assert.equal(mirrors.length, 2);
  assert.deepEqual(
    mirrors.map((m) => m.start).sort((a, b) => a - b),
    [6, 12]
  );
});

test('a default declared at a later occurrence fills every occurrence', () => {
  const interp = parserInterp();
  // bare $1 occurs first, the default-bearing ${1:v} second. Both render
  // the resolved default "v"; the first occurrence is canonical (where
  // point lands), the second is a mirror.
  interp.evaluate('(define b (parse-snippet-body "$1 then ${1:v}"))');
  assert.equal(interp.evaluate('(get b :text nil)'), 'v then v');
  const fields = fieldsOf(interp, 'b');
  assert.equal(fields.length, 1);
  assert.equal(fields[0].default, 'v');
  // The canonical field is the first occurrence, at offset 0..1.
  assert.deepEqual([fields[0].start, fields[0].end], [0, 1]);
  const mirrors = mirrorsOf(interp, 'b');
  assert.equal(mirrors.length, 1);
  assert.deepEqual([mirrors[0].start, mirrors[0].end], [7, 8]);
});
