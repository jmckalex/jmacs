/**
 * @file Tests for lexical environments (`src/environment.js`) — the whole
 * of the editor Lisp's scoping. Two halves: direct unit tests of the
 * `Environment` class (define / lookup / has / assign and the parent
 * chain), and integration tests that exercise the same machinery through
 * the interpreter (closures capturing their defining frame, `set!` on an
 * outer binding, shadowing, child-frame isolation).
 *
 * Audit ticket E2: `environment.js` had no dedicated tests before this.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInterpreter,
  Environment,
  LispError,
  writeString,
} from '../src/index.js';

/** Evaluate Lisp source in a fresh interpreter; return the last value. */
function run(source) {
  return createInterpreter().evaluate(source);
}

/** Evaluate Lisp source and render the result to text. */
function show(source) {
  return writeString(run(source));
}

// --- the Environment class: define and lookup --------------------------

test('define binds a name; lookup retrieves it', () => {
  const env = new Environment();
  assert.equal(env.define('x', 1), 1); // define returns the value
  assert.equal(env.lookup('x'), 1);
});

test('redefining a name in a frame overwrites it', () => {
  const env = new Environment();
  env.define('x', 1);
  env.define('x', 2);
  assert.equal(env.lookup('x'), 2);
});

test('lookup of an unbound symbol raises a LispError', () => {
  const env = new Environment();
  assert.throws(
    () => env.lookup('nope'),
    (err) => {
      assert.ok(err instanceof LispError);
      assert.equal(err.message, 'unbound symbol: nope');
      return true;
    }
  );
});

// --- the parent chain --------------------------------------------------

test('a child frame sees a binding in its parent', () => {
  const parent = new Environment();
  parent.define('x', 1);
  const child = new Environment(parent);
  assert.equal(child.lookup('x'), 1);
});

test('a child binding shadows the parent without mutating it', () => {
  const parent = new Environment();
  parent.define('x', 1);
  const child = new Environment(parent);
  child.define('x', 2);
  assert.equal(child.lookup('x'), 2);
  assert.equal(parent.lookup('x'), 1); // parent is untouched
});

test('sibling frames are isolated from each other', () => {
  const parent = new Environment();
  const a = new Environment(parent);
  const b = new Environment(parent);
  a.define('x', 1);
  assert.equal(b.has('x'), false);
  assert.throws(() => b.lookup('x'), LispError);
});

// --- has ---------------------------------------------------------------

test('has reports local and inherited bindings, false otherwise', () => {
  const parent = new Environment();
  parent.define('outer', 1);
  const child = new Environment(parent);
  child.define('inner', 2);
  assert.equal(child.has('inner'), true); // local
  assert.equal(child.has('outer'), true); // inherited
  assert.equal(child.has('missing'), false);
});

// --- assign (set!) -----------------------------------------------------

test('assign updates the nearest existing binding (outer frame)', () => {
  const parent = new Environment();
  parent.define('x', 1);
  const child = new Environment(parent);
  assert.equal(child.assign('x', 9), 9); // assign returns the value
  assert.equal(parent.lookup('x'), 9); // the outer binding changed
  assert.equal(child.vars.has('x'), false); // no new local binding made
});

test('assign prefers a shadowing local binding over the outer one', () => {
  const parent = new Environment();
  parent.define('x', 1);
  const child = new Environment(parent);
  child.define('x', 2);
  child.assign('x', 9);
  assert.equal(child.lookup('x'), 9);
  assert.equal(parent.lookup('x'), 1); // the outer one is left alone
});

test('assign to an unbound symbol raises a LispError', () => {
  const env = new Environment();
  assert.throws(
    () => env.assign('x', 1),
    (err) => {
      assert.ok(err instanceof LispError);
      assert.equal(err.message, 'cannot set! an unbound symbol: x');
      return true;
    }
  );
});

// --- closures capture their defining environment -----------------------

test('a closure captures its defining frame and keeps mutable state', () => {
  // `n` lives in the frame `make-counter` created; the returned lambda
  // closes over it, so successive calls share and mutate that one cell.
  const src = `(define (make-counter)
                 (define n 0)
                 (lambda () (set! n (+ n 1)) n))
               (define c (make-counter))
               (c) (c) (c)`;
  assert.equal(run(src), 3);
});

test('two closures from the same factory have independent state', () => {
  const src = `(define (make-counter)
                 (define n 0)
                 (lambda () (set! n (+ n 1)) n))
               (define a (make-counter))
               (define b (make-counter))
               (a) (a) (b)`;
  assert.equal(run(src), 1); // b has its own n, untouched by a's two bumps
});

test('the classic adder closure captures its parameter', () => {
  assert.equal(
    run('(define (adder n) (lambda (x) (+ x n))) ((adder 10) 5)'),
    15
  );
});

// --- shadowing through the interpreter ---------------------------------

test('a lambda parameter shadows a global of the same name', () => {
  assert.equal(run('(define x 100) ((lambda (x) x) 5)'), 5);
});

test('an inner define shadows an outer one without changing it', () => {
  assert.equal(
    show('(define x 1) (define (f) (define x 2) x) (list (f) x)'),
    '(2 1)'
  );
});

// --- set! on an outer binding through the interpreter ------------------

test('set! mutates an outer binding from an inner let frame', () => {
  assert.equal(run('(define x 10) (let ((y 1)) (set! x (+ x y))) x'), 11);
});

test('set! on an unbound symbol is an error through the interpreter', () => {
  assert.throws(() => run('(set! never-bound 5)'), LispError);
});

// --- let frames do not leak --------------------------------------------

test("a let binding does not leak into the enclosing scope", () => {
  assert.throws(() => run('(let ((temp 1)) temp) temp'), LispError);
});
