/**
 * @file Interpreter characterization tests (E2) — the audit gaps not
 * covered by `error-and-macro.test.js`: quasiquote at nesting depth > 2
 * and over vectors and maps, and lambda rest / all-arguments binding.
 *
 * Kept in their own file so they don't collide with the try/catch and
 * error-location work in `error-and-macro.test.js`. Each test PINS the
 * current behaviour (observed, then asserted), so a change to the
 * quasiquote depth algorithm or the argument binder becomes a deliberate,
 * test-breaking decision rather than a silent drift.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInterpreter, writeString } from '../src/index.js';

/** Evaluate Lisp source in a fresh interpreter; print the last value. */
const run = (source) => writeString(createInterpreter().evaluate(source));

// --- quasiquote: nesting deeper than two levels ------------------------

test('quasiquote preserves an unquote nested three levels deep', () => {
  // Each inner `quasiquote` raises the depth; an unquote only fires at
  // depth 1, so three levels down it is left untouched as data.
  assert.equal(
    run('`(a `(b `(c ,(+ 1 2))))'),
    '(a (quasiquote (b (quasiquote (c (unquote (+ 1 2)))))))'
  );
});

test('a double unquote evaluates at the matching inner depth', () => {
  // `,,x` inside one nested quasiquote: the outer comma is consumed at
  // depth 2 (left as data), the inner comma fires at depth 1 → 3.
  assert.equal(run('`(a `(b ,,(+ 1 2)))'), '(a (quasiquote (b (unquote 3))))');
});

// --- quasiquote: over vectors ------------------------------------------

test('quasiquote evaluates an unquote inside a vector', () => {
  assert.equal(run('`[a ,(+ 1 2) c]'), '[a 3 c]');
});

test('quasiquote splices into a vector', () => {
  assert.equal(run('`[a ,@(list 1 2) c]'), '[a 1 2 c]');
});

test('a bare unquote outside quasiquote is an error (unquote is not a value)', () => {
  // A plain vector literal evaluates its elements; `,(…)` reads as
  // (unquote …), and `unquote` has no binding outside a quasiquote.
  assert.throws(() => run('[1 ,(+ 1 2)]'), /unbound symbol: unquote/);
});

// --- quasiquote: over maps ---------------------------------------------

test('quasiquote evaluates an unquote in a map value', () => {
  assert.equal(run('`{:k ,(+ 1 2)}'), '{:k 3}');
});

test('unquote-splicing in a lone map value is left literal (v0)', () => {
  // Splicing only expands in list / vector element position; a single map
  // value is not a splice site, so the form is preserved as data.
  assert.equal(run('`{:k ,@(list 1 2)}'), '{:k (unquote-splicing (list 1 2))}');
});

// --- lambda argument binding: rest and all-arguments -------------------

test('a dotted rest parameter collects the trailing arguments', () => {
  assert.equal(run('((lambda (a . rest) rest) 1 2 3)'), '(2 3)');
});

test('a bare-symbol parameter binds the whole argument list', () => {
  assert.equal(run('((lambda args args) 1 2 3)'), '(1 2 3)');
});

test('a rest lambda still requires its fixed parameters', () => {
  // (a . rest) needs at least one argument; calling with none is an error.
  assert.throws(
    () => run('((lambda (a . rest) rest))'),
    /expected at least 1 argument/
  );
});
