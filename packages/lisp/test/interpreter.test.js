import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInterpreter, LispError, NIL, writeString } from '../src/index.js';

/** Evaluate Lisp source in a fresh interpreter; return the last value. */
function run(source) {
  return createInterpreter().evaluate(source);
}

/** Evaluate Lisp source and render the result to text. */
function show(source) {
  return writeString(run(source));
}

// --- literals and arithmetic -------------------------------------------

test('literals are self-evaluating', () => {
  assert.equal(run('42'), 42);
  assert.equal(run('"hi"'), 'hi');
  assert.equal(run('#t'), true);
  assert.equal(run('nil'), NIL);
});

test('arithmetic', () => {
  assert.equal(run('(+ 1 2 3 4)'), 10);
  assert.equal(run('(- 10 3 2)'), 5);
  assert.equal(run('(- 7)'), -7);
  assert.equal(run('(* 2 3 4)'), 24);
  assert.equal(run('(/ 100 5 2)'), 10);
  assert.equal(run('(mod -1 3)'), 2);
  assert.equal(run('(+ (* 2 3) (- 10 4))'), 12);
});

test('division by zero is an error', () => {
  assert.throws(() => run('(/ 1 0)'), LispError);
});

test('numeric comparison chains', () => {
  assert.equal(run('(< 1 2 3)'), true);
  assert.equal(run('(< 1 3 2)'), false);
  assert.equal(run('(= 5 5 5)'), true);
  assert.equal(run('(>= 3 3 1)'), true);
});

// --- conditionals -------------------------------------------------------

test('if', () => {
  assert.equal(run('(if #t 1 2)'), 1);
  assert.equal(run('(if #f 1 2)'), 2);
  assert.equal(run('(if (< 1 2) "yes" "no")'), 'yes');
});

test('cond with else', () => {
  assert.equal(
    run('(cond ((= 1 2) "a") ((= 1 1) "b") (else "c"))'),
    'b'
  );
  assert.equal(run('(cond (#f "a") (else "fallback"))'), 'fallback');
});

test('and / or short-circuit', () => {
  assert.equal(run('(and 1 2 3)'), 3);
  assert.equal(run('(and 1 #f 3)'), false);
  assert.equal(run('(or #f #f 7)'), 7);
  assert.equal(run('(or #f #f #f)'), false);
});

// --- definitions, lambdas, scope ---------------------------------------

test('define a value and a function', () => {
  assert.equal(run('(define x 10) (* x x)'), 100);
  assert.equal(run('(define (square n) (* n n)) (square 9)'), 81);
});

test('lambda and closures', () => {
  assert.equal(run('((lambda (x y) (+ x y)) 3 4)'), 7);
  assert.equal(
    run('(define (adder n) (lambda (x) (+ x n))) ((adder 10) 5)'),
    15
  );
});

test('rest parameters', () => {
  assert.equal(show('(define (rest-args a . more) more) (rest-args 1 2 3 4)'), '(2 3 4)');
});

test('recursion', () => {
  assert.equal(
    run('(define (fact n) (if (= n 0) 1 (* n (fact (- n 1))))) (fact 6)'),
    720
  );
});

test('let, let* and letrec', () => {
  assert.equal(run('(let ((a 1) (b 2)) (+ a b))'), 3);
  assert.equal(run('(let* ((a 1) (b (+ a 1))) (+ a b))'), 3);
  assert.equal(
    run(`(letrec ((ev? (lambda (n) (if (= n 0) #t (od? (- n 1)))))
                   (od? (lambda (n) (if (= n 0) #f (ev? (- n 1))))))
           (ev? 10))`),
    true
  );
});

test('set! mutates the nearest binding', () => {
  assert.equal(run('(define c 0) (set! c (+ c 5)) c'), 5);
});

// --- lists and higher-order --------------------------------------------

test('list construction and access', () => {
  assert.equal(show('(list 1 2 3)'), '(1 2 3)');
  assert.equal(show('(cons 0 (list 1 2))'), '(0 1 2)');
  assert.equal(run('(car (list 8 9))'), 8);
  assert.equal(show('(cdr (list 8 9))'), '(9)');
  assert.equal(run('(length (list 1 2 3 4))'), 4);
});

test('map, filter, reduce', () => {
  assert.equal(show('(map inc (list 1 2 3))'), '(2 3 4)');
  assert.equal(
    show('(filter odd? (list 1 2 3 4 5))'),
    '(1 3 5)'
  );
  assert.equal(run('(reduce + 0 (list 1 2 3 4 5))'), 15);
  assert.equal(show('(map + (list 1 2 3) (list 10 20 30))'), '(11 22 33)');
});

test('apply', () => {
  assert.equal(run('(apply + (list 1 2 3 4))'), 10);
  assert.equal(run('(apply + 1 2 (list 3 4))'), 10);
});

test('range', () => {
  assert.equal(show('(range 5)'), '(0 1 2 3 4)');
  assert.equal(show('(range 2 6)'), '(2 3 4 5)');
});

// --- quote and quasiquote ----------------------------------------------

test('quote', () => {
  assert.equal(show("'(1 2 3)"), '(1 2 3)');
  assert.equal(show("'foo"), 'foo');
});

test('quasiquote with unquote and splicing', () => {
  assert.equal(show('`(1 ,(+ 1 1) 3)'), '(1 2 3)');
  assert.equal(show('`(0 ,@(list 1 2 3) 4)'), '(0 1 2 3 4)');
  assert.equal(show('(define n 7) `(the answer is ,n)'), '(the answer is 7)');
});

// --- macros -------------------------------------------------------------

test('prelude macros: when and unless', () => {
  assert.equal(run('(when #t 1 2 3)'), 3);
  assert.equal(run('(when #f 99)'), NIL);
  assert.equal(run('(unless #f 42)'), 42);
  assert.equal(run('(unless #t 99)'), NIL);
});

test('a user-defined macro transforms code', () => {
  // swap-args rewrites (swap-args f a b) to (f b a).
  assert.equal(
    run("(defmacro swap-args (f a b) (list f a b)) (swap-args - 10 3)"),
    7
  );
});

test('a macro using quasiquote', () => {
  assert.equal(
    run(`(defmacro my-when (test . body)
           \`(if ,test (begin ,@body) nil))
         (my-when (> 5 3) 1 2 99)`),
    99
  );
});

// --- vectors and maps ---------------------------------------------------

test('vectors evaluate their elements', () => {
  assert.equal(show('[1 (+ 1 1) (* 2 3)]'), '[1 2 6]');
  assert.equal(run('(vector-ref [10 20 30] 1)'), 20);
});

test('maps: literal, get, assoc', () => {
  assert.equal(run('(get {:a 1 :b 2} :b)'), 2);
  assert.equal(run('(get {:a 1} :missing 0)'), 0);
  assert.equal(run('(get (assoc {:a 1} :c 3) :c)'), 3);
});

// --- errors -------------------------------------------------------------

test('error and try/catch', () => {
  assert.equal(run('(try (+ 1 2) (catch e 99))'), 3);
  assert.equal(run('(try (error "boom") (catch e (get e :message)))'), 'boom');
});

test('an unbound symbol raises a LispError', () => {
  assert.throws(() => run('(+ 1 nonexistent)'), LispError);
});

// --- self-documentation -------------------------------------------------

test('a function keeps its docstring', () => {
  assert.equal(
    run('(define (sq x) "Square a number." (* x x)) (doc sq)'),
    'Square a number.'
  );
});

test('type-of reports the value type', () => {
  assert.equal(show('(type-of 5)'), ':number');
  assert.equal(show('(type-of "x")'), ':string');
  assert.equal(show('(type-of (list))'), ':nil');
});

test('string-prefix? tests how a string begins', () => {
  assert.equal(run('(string-prefix? "ab" "abcd")'), true);
  assert.equal(run('(string-prefix? "x" "abcd")'), false);
  assert.equal(run('(string-prefix? "" "abc")'), true);
});

// --- output -------------------------------------------------------------

test('print writes to the output sink', () => {
  let out = '';
  const lisp = createInterpreter({ write: (text) => (out += text) });
  lisp.evaluate('(print "hello") (print "!")');
  assert.equal(out, 'hello!');
});

test('print joins its arguments with spaces', () => {
  let out = '';
  const lisp = createInterpreter({ write: (text) => (out += text) });
  lisp.evaluate('(print "a" "b" "c")');
  assert.equal(out, 'a b c');
});

test('println adds a newline', () => {
  let out = '';
  const lisp = createInterpreter({ write: (text) => (out += text) });
  lisp.evaluate('(println "line")');
  assert.equal(out, 'line\n');
});

// --- host primitives ----------------------------------------------------

test('host primitives can be registered', () => {
  const lisp = createInterpreter({
    primitives: { 'double!': (args) => args[0] * 2 },
  });
  assert.equal(lisp.evaluate('(double! 21)'), 42);
});
