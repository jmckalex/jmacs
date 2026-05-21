import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  arrayToList,
  cons,
  displayString,
  equal,
  isList,
  isTruthy,
  keyword,
  list,
  listToArray,
  NIL,
  sym,
  writeString,
} from '../src/index.js';

test('list and listToArray round-trip', () => {
  const l = list(1, 2, 3);
  assert.deepEqual(listToArray(l), [1, 2, 3]);
  assert.equal(listToArray(NIL).length, 0);
});

test('arrayToList can build an improper list', () => {
  assert.equal(writeString(arrayToList([1, 2], 3)), '(1 2 . 3)');
});

test('isList distinguishes proper lists', () => {
  assert.equal(isList(list(1, 2)), true);
  assert.equal(isList(NIL), true);
  assert.equal(isList(cons(1, 2)), false);
});

test('listToArray rejects an improper list', () => {
  assert.throws(() => listToArray(cons(1, 2)));
});

test('writeString quotes strings, displayString does not', () => {
  assert.equal(writeString('hi'), '"hi"');
  assert.equal(displayString('hi'), 'hi');
  assert.equal(writeString('a\nb'), '"a\\nb"');
});

test('writeString renders the core types', () => {
  assert.equal(writeString(NIL), 'nil');
  assert.equal(writeString(true), '#t');
  assert.equal(writeString(false), '#f');
  assert.equal(writeString(42), '42');
  assert.equal(writeString(sym('foo')), 'foo');
  assert.equal(writeString(keyword('bar')), ':bar');
  assert.equal(writeString(list(1, 2, 3)), '(1 2 3)');
  assert.equal(writeString(Object.freeze([1, 2])), '[1 2]');
});

test('symbols and keywords are interned', () => {
  assert.equal(sym('x'), sym('x'));
  assert.equal(keyword('y'), keyword('y'));
  assert.notEqual(sym('x'), sym('z'));
});

test('isTruthy follows Scheme: only #f is false', () => {
  assert.equal(isTruthy(false), false);
  assert.equal(isTruthy(true), true);
  assert.equal(isTruthy(NIL), true);
  assert.equal(isTruthy(0), true);
  assert.equal(isTruthy(''), true);
});

test('equal is deep over lists, vectors and maps', () => {
  assert.equal(equal(list(1, 2, 3), list(1, 2, 3)), true);
  assert.equal(equal(list(1, 2), list(1, 2, 3)), false);
  assert.equal(equal([1, [2, 3]], [1, [2, 3]]), true);
  assert.equal(
    equal(new Map([['a', 1]]), new Map([['a', 1]])),
    true
  );
  assert.equal(equal(sym('a'), sym('a')), true);
});
