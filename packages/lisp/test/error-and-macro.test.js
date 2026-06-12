/**
 * @file Characterization tests for error handling and macros — the gaps
 * the 2026-06-10 audit flagged (E2). These pin down the interpreter's
 * *current* behaviour so it can't drift silently, and document the
 * deliberate v0 limitations (non-hygienic macros, single-level
 * quasiquote). They also lay groundwork for surfacing source locations
 * in errors (B6): the behaviour they assert must survive that change.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInterpreter, LispError, writeString } from '../src/index.js';

/** Evaluate Lisp source in a fresh interpreter; return the last value. */
function run(source) {
  return createInterpreter().evaluate(source);
}

// --- try / catch -------------------------------------------------------

test('try returns the body value when nothing throws', () => {
  assert.equal(run('(try 42 (catch e 0))'), 42);
});

test('try/catch binds the error message and irritants', () => {
  assert.equal(run('(try (error "boom" 1 2) (catch e (get e :message)))'), 'boom');
  assert.equal(
    writeString(run('(try (error "boom" 1 2) (catch e (get e :irritants)))')),
    '(1 2)'
  );
});

test('try/catch catches a runtime error raised by the interpreter', () => {
  // Not just explicit (error ...) — an unbound-symbol LispError thrown
  // mid-evaluation is catchable and surfaces its message.
  assert.equal(
    run('(try (foo-unbound) (catch e (get e :message)))'),
    'unbound symbol: foo-unbound'
  );
});

// --- arity errors ------------------------------------------------------

test('calling a lambda with too few arguments is an arity error', () => {
  assert.throws(
    () => run('((lambda (x y) x) 1)'),
    (err) => {
      assert.ok(err instanceof LispError);
      assert.match(err.message, /expected 2 argument\(s\), got 1/);
      return true;
    }
  );
});

test('calling a lambda with too many arguments is an arity error', () => {
  assert.throws(
    () => run('((lambda (x) x) 1 2)'),
    (err) => {
      assert.ok(err instanceof LispError);
      assert.match(err.message, /expected 1 argument\(s\), got 2/);
      return true;
    }
  );
});

test('a named function reports its name in an arity error', () => {
  assert.throws(
    () => run('(define (f x y) x) (f 1)'),
    (err) => {
      assert.ok(err instanceof LispError);
      assert.match(err.message, /^f: expected 2 argument\(s\), got 1/);
      return true;
    }
  );
});

// --- source locations in errors (B6) -----------------------------------

test('a runtime error carries the source location of the offending form', () => {
  // `(bar x)` opens at line 2, column 3 (1-based). bar is unbound, so the
  // error should point there — the innermost form being evaluated.
  const interp = createInterpreter();
  assert.throws(
    () => interp.evaluate('(define (f x)\n  (bar x))\n(f 1)'),
    (err) => {
      assert.ok(err instanceof LispError);
      assert.match(err.message, /unbound symbol: bar/);
      assert.deepEqual(err.location, { line: 2, col: 3 });
      return true;
    }
  );
});

test('an arity error points at the call form, not its last argument', () => {
  // The call form `(f ...)` opens at line 2, col 1; its argument `(+ 1 2)`
  // is on line 3. The error belongs to the application, so it must report
  // 2:1 — proof the call form's location is re-stamped after the args run.
  const interp = createInterpreter();
  assert.throws(
    () => interp.evaluate('(define (f x y) x)\n(f\n  (+ 1 2))'),
    (err) => {
      assert.ok(err instanceof LispError);
      assert.match(err.message, /expected 2 argument\(s\), got 1/);
      assert.deepEqual(err.location, { line: 2, col: 1 });
      return true;
    }
  );
});

test('try/catch exposes the error source location to the handler', () => {
  // `(oops)` is on line 2, column 3; the handler reads it back as data.
  assert.equal(run('(try\n  (oops)\n  (catch e (get e :line)))'), 2);
  assert.equal(run('(try\n  (oops)\n  (catch e (get e :column)))'), 3);
});

test('a clean evaluation does not leave a stale location on a later error', () => {
  // A bare unbound symbol is an atom (the reader records no location for
  // atoms), so its error must NOT inherit the previous form's location.
  const interp = createInterpreter();
  interp.evaluate('(+ 1 2)'); // a located form runs and succeeds
  assert.throws(
    () => interp.evaluate('nope'),
    (err) => {
      assert.ok(err instanceof LispError);
      assert.equal(err.location, null);
      return true;
    }
  );
});

// --- macros: deliberately non-hygienic (v0) ----------------------------

test('macros are not hygienic — a macro binding captures caller names (v0)', () => {
  // The macro wraps the caller's form in its own `tmp` binding. Because
  // expansion is unhygienic, the caller's `tmp` resolves to the macro's
  // binding (99), not the outer definition (5). This is a documented v0
  // limitation; pinned here so any future move toward hygiene is a
  // conscious, test-breaking decision rather than a silent change.
  assert.equal(
    run(`(define tmp 5)
         (defmacro cap (form)
           (list (quote let) (list (list (quote tmp) 99)) form))
         (cap tmp)`),
    99
  );
});

// --- quasiquote: single-level (v0) -------------------------------------

test('quasiquote evaluates unquote and splicing at its own level', () => {
  assert.equal(writeString(run('`(a ,(+ 1 2) c)')), '(a 3 c)');
  assert.equal(writeString(run('`(a ,@(list 1 2) c)')), '(a 1 2 c)');
});

test('quasiquote processes only its outermost level; nesting is preserved', () => {
  // A nested quasiquote is left as data — the inner unquote is NOT
  // evaluated at the outer level. Documents the single-level quasiquote
  // semantics so a change to fully-nested behaviour is deliberate.
  assert.equal(
    writeString(run('`(a `(b ,(+ 1 2)))')),
    '(a (quasiquote (b (unquote (+ 1 2)))))'
  );
});
