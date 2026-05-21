import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInterpreter, LispError } from '../src/index.js';

test('a module exports definitions that import brings into scope', () => {
  const lisp = createInterpreter();
  lisp.evaluate('(module math (export square) (define (square n) (* n n)))');
  lisp.evaluate('(import math)');
  assert.equal(lisp.evaluate('(square 9)'), 81);
});

test('non-exported bindings stay private to the module', () => {
  const lisp = createInterpreter();
  lisp.evaluate(`(module m (export public)
    (define secret 42)
    (define (public) secret))`);
  lisp.evaluate('(import m)');
  // The module can use its own secret...
  assert.equal(lisp.evaluate('(public)'), 42);
  // ...but the importer cannot see it.
  assert.throws(() => lisp.evaluate('secret'), LispError);
});

test('two modules can use the same internal name without colliding', () => {
  const lisp = createInterpreter();
  lisp.evaluate('(module a (export tag) (define name "a") (define (tag) name))');
  lisp.evaluate('(module b (export tag) (define name "b") (define (tag) name))');
  lisp.evaluate('(import a)');
  assert.equal(lisp.evaluate('(tag)'), 'a');
  lisp.evaluate('(import b)');
  assert.equal(lisp.evaluate('(tag)'), 'b');
});

test('importing an unknown module is an error', () => {
  const lisp = createInterpreter();
  assert.throws(() => lisp.evaluate('(import nonexistent)'), LispError);
});

test('a module sees the primitives and the prelude', () => {
  const lisp = createInterpreter();
  lisp.evaluate(`(module m (export check)
    (define (check) (when (odd? 3) (+ 1 2 3))))`);
  lisp.evaluate('(import m)');
  assert.equal(lisp.evaluate('(check)'), 6);
});

test('a module can import another module', () => {
  const lisp = createInterpreter();
  lisp.evaluate('(module base-m (export base-fn) (define (base-fn) 10))');
  lisp.evaluate(`(module derived (export derived-fn)
    (import base-m)
    (define (derived-fn) (* 2 (base-fn))))`);
  lisp.evaluate('(import derived)');
  assert.equal(lisp.evaluate('(derived-fn)'), 20);
});

test('reloading a module updates code that already holds it', () => {
  const lisp = createInterpreter();
  lisp.evaluate(`(module greeter (export greet)
    (define (greet) (message))
    (define (message) "hi"))`);
  lisp.evaluate('(import greeter)');
  assert.equal(lisp.evaluate('(greet)'), 'hi');

  // Reload the module, changing only the private helper.
  lisp.evaluate(`(module greeter (export greet)
    (define (greet) (message))
    (define (message) "hello"))`);
  // The already-imported greet resolves message through the module's
  // environment, which the reload reused — so it sees the new helper.
  assert.equal(lisp.evaluate('(greet)'), 'hello');
});

test('re-importing picks up a redefined export', () => {
  const lisp = createInterpreter();
  lisp.evaluate('(module m (export v) (define (v) 1))');
  lisp.evaluate('(import m)');
  assert.equal(lisp.evaluate('(v)'), 1);

  lisp.evaluate('(module m (export v) (define (v) 2))');
  // A snapshot import is stale until re-imported.
  assert.equal(lisp.evaluate('(v)'), 1);
  lisp.evaluate('(import m)');
  assert.equal(lisp.evaluate('(v)'), 2);
});

test('reloading clears definitions removed from the module', () => {
  const lisp = createInterpreter();
  lisp.evaluate(`(module m (export run)
    (define (helper) 7)
    (define (run) (helper)))`);
  lisp.evaluate('(import m)');
  assert.equal(lisp.evaluate('(run)'), 7);

  // Reload without `helper`, though `run` still calls it.
  lisp.evaluate('(module m (export run) (define (run) (helper)))');
  // The reused module environment was cleared, so `helper` is gone.
  assert.throws(() => lisp.evaluate('(run)'), LispError);
});
