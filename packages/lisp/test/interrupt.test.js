/**
 * @file Tests for the cooperative interrupt + step budget — the `C-g`
 * mechanism that lets a runaway Lisp command be aborted. A synchronous
 * tree-walker can't be preempted from outside, so abortion is cooperative:
 * the eval trampoline checks an installed interrupt-check (and a step
 * ceiling) every few thousand bounces and throws a distinct, catchable
 * `LispInterrupt` when either fires.
 *
 * These prove: (a) the interrupt-check aborts a runaway loop, (b) the step
 * budget aborts a runaway loop with no external signal, (c) the interrupt
 * unwinds cleanly through `finally` / a Lisp `catch`, (d) the interpreter is
 * still usable after an interrupt, and (e) a normal program is unaffected —
 * no spurious interrupts, identical results, cleanup still runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInterpreter, LispError, LispInterrupt } from '../src/index.js';

// A runaway loop the dialect supports: an infinite tail loop. It bounces the
// trampoline forever, which is exactly where the interrupt must catch it.
const RUNAWAY = '(while #t (+ 1 1))';

// --- the interrupt-check (the C-g path) --------------------------------

test('an interrupt-check aborts a runaway loop', () => {
  const lisp = createInterpreter();
  // Fire on the third check — i.e. after some bounces, not immediately.
  let calls = 0;
  lisp.setInterruptCheck(() => {
    calls += 1;
    return calls >= 3;
  });

  assert.throws(() => lisp.evaluate(RUNAWAY), LispInterrupt);
  // It really did run a while before aborting (the check was polled, not
  // consulted once).
  assert.ok(calls >= 3, `expected the check to be polled, got ${calls} call(s)`);
});

test('the interrupt error is a distinct, flagged LispError', () => {
  const lisp = createInterpreter();
  lisp.setInterruptCheck(() => true);
  let caught;
  try {
    lisp.evaluate(RUNAWAY);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof LispInterrupt, 'should be a LispInterrupt');
  assert.ok(caught instanceof LispError, 'LispInterrupt is a LispError');
  assert.equal(caught.interrupt, true, 'carries the interrupt flag');
});

test('the interpreter is still usable after an interrupt', () => {
  const lisp = createInterpreter();
  lisp.setInterruptCheck(() => true);
  assert.throws(() => lisp.evaluate(RUNAWAY), LispInterrupt);

  // Clearing the check, a later evaluation runs normally — no stale state,
  // no spurious abort.
  lisp.setInterruptCheck(null);
  assert.equal(lisp.evaluate('(+ 2 3)'), 5);
  assert.equal(lisp.evaluate('(let loop ((i 0)) (if (>= i 100000) i (loop (+ i 1))))'), 100000);
});

test('setInterruptCheck(null) disables the check', () => {
  const lisp = createInterpreter();
  lisp.setInterruptCheck(() => true);
  lisp.setInterruptCheck(null);
  // A finite loop now completes; nothing aborts it.
  assert.equal(lisp.evaluate('(let loop ((i 0)) (if (>= i 50000) i (loop (+ i 1))))'), 50000);
});

// --- the step budget (no external signal) ------------------------------

test('the step budget aborts a runaway loop', () => {
  const lisp = createInterpreter();
  lisp.setStepBudget(50000);
  let caught;
  try {
    lisp.evaluate(RUNAWAY);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof LispInterrupt, 'budget overflow is an interrupt');
  assert.match(caught.lispMessage, /step budget/);
});

test('a deep non-tail recursion is bounded by the budget', () => {
  // Non-tail recursion grows the JS stack; with a modest budget the step
  // ceiling fires before any stack overflow, turning a hang/crash into a
  // catchable interrupt.
  const lisp = createInterpreter();
  lisp.setStepBudget(20000);
  assert.throws(
    () => lisp.evaluate('(define (count n) (+ 1 (count (+ n 1)))) (count 0)'),
    LispInterrupt
  );
});

test('the budget is per top-level form, not cumulative', () => {
  const lisp = createInterpreter();
  // One 20000-iteration loop costs a few hundred thousand bounces; this
  // budget clears one comfortably. Running ten in a row would blow any fixed
  // budget if the counter accumulated — it must reset per top-level form.
  lisp.setStepBudget(400000);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(
      lisp.evaluate('(let loop ((i 0)) (if (>= i 20000) i (loop (+ i 1))))'),
      20000
    );
  }
});

test('the budget also fires through the call (keystroke) path', () => {
  // `call` is the host's way into Lisp — handle-key on every keystroke. A
  // runaway command invoked this way must be interruptible too, and the
  // counter resets per call (the budget is per-command, not lifetime).
  const lisp = createInterpreter();
  lisp.evaluate('(define (runaway) (while #t (+ 1 1)))');
  lisp.evaluate('(define (quick) (+ 1 1))');
  lisp.setStepBudget(50000);
  assert.throws(() => lisp.call('runaway'), LispInterrupt);
  // A subsequent fast command is unaffected — the counter reset.
  assert.equal(lisp.call('quick'), 2);
});

// --- clean unwind through try / catch / finally ------------------------

test('finally cleanup runs when a budget interrupt unwinds', () => {
  const ran = [];
  const lisp = createInterpreter({
    primitives: { 'note!': (args) => { ran.push(args[0]); return args[0]; } },
  });
  lisp.setStepBudget(30000);
  assert.throws(
    () => lisp.evaluate('(try (while #t (+ 1 1)) (finally (note! "cleanup")))'),
    LispInterrupt
  );
  assert.deepEqual(ran, ['cleanup'], 'finally must run on interrupt');
});

test('a Lisp catch can catch the interrupt (it is a LispError)', () => {
  const lisp = createInterpreter();
  lisp.setStepBudget(30000);
  // Being a LispError subclass, the interrupt is catchable by (catch …); the
  // handler sees its message. (The host can still tell it apart by the JS
  // class — that distinction is exercised above.)
  const message = lisp.evaluate('(try (while #t (+ 1 1)) (catch e (get e :message)))');
  assert.match(message, /step budget/);
});

// --- defaults are a no-op (the existing app must be unaffected) ----------

test('with no check and no budget, behaviour is unchanged', () => {
  const lisp = createInterpreter();
  // A loop that bounces far more than the check interval (4096) completes
  // with no spurious interrupt and the identical result.
  assert.equal(
    lisp.evaluate('(let loop ((i 0) (acc 0)) (if (>= i 1000000) acc (loop (+ i 1) (+ acc 1))))'),
    1000000
  );
});

test('a fresh interpreter does not inherit a previous one’s budget', () => {
  const a = createInterpreter();
  a.setStepBudget(10000);
  assert.throws(() => a.evaluate(RUNAWAY), LispInterrupt);

  // A brand-new interpreter starts with the defaults restored — the module
  // state from `a` must not leak in.
  const b = createInterpreter();
  assert.equal(
    b.evaluate('(let loop ((i 0)) (if (>= i 1000000) i (loop (+ i 1))))'),
    1000000
  );
});

test('a fresh interpreter does not inherit a previous one’s check', () => {
  const a = createInterpreter();
  a.setInterruptCheck(() => true);
  assert.throws(() => a.evaluate(RUNAWAY), LispInterrupt);

  const b = createInterpreter();
  assert.equal(b.evaluate('(+ 40 2)'), 42);
});

test('normal finally still runs and yields the body value', () => {
  const ran = [];
  const lisp = createInterpreter({
    primitives: { 'note!': (args) => { ran.push(args[0]); return args[0]; } },
  });
  assert.equal(lisp.evaluate('(try (+ 1 2) (finally (note! "x")))'), 3);
  assert.deepEqual(ran, ['x']);
});

// --- API validation -----------------------------------------------------

test('setInterruptCheck rejects a non-function, non-null argument', () => {
  const lisp = createInterpreter();
  assert.throws(() => lisp.setInterruptCheck(42), TypeError);
});

test('setStepBudget rejects a non-positive argument', () => {
  const lisp = createInterpreter();
  assert.throws(() => lisp.setStepBudget(0), TypeError);
  assert.throws(() => lisp.setStepBudget(-1), TypeError);
  // Infinity is the explicit "no limit" value and must be accepted.
  assert.doesNotThrow(() => lisp.setStepBudget(Infinity));
});
