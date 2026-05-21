import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read, readOne } from '../src/reader.js';
import {
  Keyword,
  LispError,
  NIL,
  Pair,
  sourceLocations,
  Sym,
  writeString,
} from '../src/index.js';

/** Read one form and render it back to text. */
const roundtrip = (src) => writeString(readOne(src));

test('reads integers and floats', () => {
  assert.equal(readOne('42'), 42);
  assert.equal(readOne('-3.5'), -3.5);
  assert.equal(readOne('+7'), 7);
  assert.equal(readOne('1e3'), 1000);
});

test('reads strings with escapes', () => {
  assert.equal(readOne('"hello"'), 'hello');
  assert.equal(readOne('"a\\nb"'), 'a\nb');
  assert.equal(readOne('"quote: \\""'), 'quote: "');
});

test('reads booleans', () => {
  assert.equal(readOne('#t'), true);
  assert.equal(readOne('#f'), false);
});

test('reads symbols and keywords', () => {
  assert.ok(readOne('foo-bar') instanceof Sym);
  assert.equal(readOne('foo-bar').name, 'foo-bar');
  assert.ok(readOne(':kw') instanceof Keyword);
  assert.equal(readOne(':kw').name, 'kw');
});

test('symbols are interned', () => {
  assert.equal(readOne('same'), readOne('same'));
});

test('the empty list reads as nil', () => {
  assert.equal(readOne('()'), NIL);
});

test('reads proper lists', () => {
  const form = readOne('(1 2 3)');
  assert.ok(form instanceof Pair);
  assert.equal(roundtrip('(1 2 3)'), '(1 2 3)');
  assert.equal(roundtrip('(a (b c) d)'), '(a (b c) d)');
});

test('reads dotted pairs', () => {
  assert.equal(roundtrip('(1 . 2)'), '(1 . 2)');
  assert.equal(roundtrip('(1 2 . 3)'), '(1 2 . 3)');
});

test('reads vectors and maps', () => {
  assert.equal(roundtrip('[1 2 3]'), '[1 2 3]');
  assert.equal(roundtrip('{:a 1 :b 2}'), '{:a 1 :b 2}');
});

test('a map literal rejects an odd number of forms', () => {
  assert.throws(() => readOne('{:a}'), LispError);
});

test('reads the quote family', () => {
  assert.equal(roundtrip("'x"), '(quote x)');
  assert.equal(roundtrip('`x'), '(quasiquote x)');
  assert.equal(roundtrip(',x'), '(unquote x)');
  assert.equal(roundtrip(',@x'), '(unquote-splicing x)');
});

test('skips line comments', () => {
  assert.equal(readOne('; a comment\n42'), 42);
  assert.equal(roundtrip('(1 ; inline\n 2)'), '(1 2)');
});

test('reads several top-level forms', () => {
  const forms = read('1 2 3');
  assert.equal(forms.length, 3);
});

test('list forms carry a source location', () => {
  const form = readOne('\n  (a b)');
  const loc = sourceLocations.get(form);
  assert.deepEqual(loc, { line: 2, col: 3 });
});

test('unclosed and mismatched brackets throw', () => {
  assert.throws(() => readOne('(1 2'), LispError);
  assert.throws(() => readOne('(1 2]'), LispError);
  assert.throws(() => readOne(')'), LispError);
});

test('readOne rejects zero or many forms', () => {
  assert.throws(() => readOne(''), LispError);
  assert.throws(() => readOne('1 2'), LispError);
});
