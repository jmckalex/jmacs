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

// --- named let -----------------------------------------------------------

test('named let loops and returns a value', () => {
  assert.equal(
    run(`(let loop ((n 5) (acc 1))
           (if (= n 0) acc (loop (- n 1) (* acc n))))`),
    120
  );
});

test('named let inits see the outer scope, not each other or the name', () => {
  // `y`'s init refers to the OUTER x (1), not the loop binding (10).
  assert.equal(run('(let ((x 1)) (let loop ((x 10) (y x)) y))'), 1);
  // The loop name is not visible to the inits.
  assert.throws(() => run('(let loop ((f loop)) f)'), LispError);
});

test('named let recursion runs in constant stack', () => {
  assert.equal(
    run('(let loop ((n 1000000)) (if (= n 0) (quote done) (loop (- n 1))))'),
    run('(quote done)')
  );
});

test('named let with zero bindings', () => {
  assert.equal(run('(let loop () 42)'), 42);
});

test('the named-let name does not leak into the surrounding scope', () => {
  assert.throws(
    () => run('(begin (let loop ((n 0)) n) loop)'),
    (err) => {
      assert.ok(err instanceof LispError);
      assert.match(err.message, /unbound symbol: loop/);
      return true;
    }
  );
});

test('plain let is unaffected by the named form', () => {
  assert.equal(run('(let ((a 1) (b 2)) (+ a b))'), 3);
  assert.equal(run('(let () 7)'), 7);
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

// --- sort -----------------------------------------------------------------

test('sort orders numbers and strings by default', () => {
  assert.equal(show('(sort (list 3 1 2))'), '(1 2 3)');
  assert.equal(show('(sort (list "pear" "apple" "fig"))'), '("apple" "fig" "pear")');
  assert.equal(show('(sort nil)'), 'nil');
});

test('sort takes a less? comparator, e.g. for descending order', () => {
  assert.equal(show('(sort (list 1 3 2) >)'), '(3 2 1)');
  assert.equal(
    show('(sort (list "bb" "a" "ccc") (lambda (x y) (< (string-length x) (string-length y))))'),
    '("a" "bb" "ccc")'
  );
});

test('sort is stable — equal keys keep their input order', () => {
  assert.equal(
    show(`(sort (list (cons 1 'a) (cons 0 'b) (cons 1 'c) (cons 0 'd))
                (lambda (x y) (< (car x) (car y))))`),
    '((0 . b) (0 . d) (1 . a) (1 . c))'
  );
});

test('sort returns the input type: vector in, vector out', () => {
  assert.equal(show('(sort [3 1 2])'), '[1 2 3]');
  assert.equal(show('(sort (list 2 1))'), '(1 2)');
});

test('sort leaves the original untouched and returns a new object', () => {
  assert.equal(show('(define v [3 1 2]) (sort v) v'), '[3 1 2]');
  assert.equal(show('(define l (list 3 1 2)) (sort l) l'), '(3 1 2)');
  assert.equal(run('(define l (list 1 2)) (eq? l (sort l))'), false);
});

test('sort without a comparator rejects mixed or unordered elements', () => {
  const unsortable = ['(sort (list 1 "a"))', "(sort (list 'b 'a))"];
  for (const src of unsortable) {
    assert.throws(
      () => run(src),
      (err) => {
        assert.ok(err instanceof LispError);
        assert.match(err.message, /sort: mixed or unordered elements need a comparator/);
        return true;
      }
    );
  }
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

// --- loop macros (while / dotimes / dolist) ------------------------------

test('while loops on a set!-driven condition and returns nil', () => {
  assert.equal(run('(define i 0) (while (< i 5) (set! i (+ i 1))) i'), 5);
  assert.equal(run('(define i 0) (while (< i 3) (set! i (+ i 1)))'), NIL);
  assert.equal(run('(while #f (error "never"))'), NIL);
});

test('dotimes binds var to 0..count-1 and returns nil', () => {
  assert.equal(
    show('(define acc nil) (dotimes i 4 (set! acc (cons i acc))) acc'),
    '(3 2 1 0)'
  );
  assert.equal(run('(dotimes i 3 i)'), NIL);
  assert.equal(run('(define hits 0) (dotimes i 0 (set! hits 1)) hits'), 0);
});

test('dolist binds var to each element in order and returns nil', () => {
  assert.equal(
    show(`(define acc nil)
          (dolist x (list 1 2 3) (set! acc (cons (* x 10) acc)))
          acc`),
    '(30 20 10)'
  );
  assert.equal(run('(dolist x (list 1 2) x)'), NIL);
  assert.equal(run('(define hits 0) (dolist x nil (set! hits 1)) hits'), 0);
});

test('while and dotimes run a million iterations in constant stack', () => {
  assert.equal(
    run('(define i 0) (while (< i 1000000) (set! i (+ i 1))) i'),
    1000000
  );
  assert.equal(
    run('(define sum 0) (dotimes i 1000000 (set! sum (+ sum 1))) sum'),
    1000000
  );
});

test('dotimes evaluates its count expression exactly once', () => {
  assert.equal(
    run(`(define calls 0)
         (define (count!) (set! calls (+ calls 1)) 3)
         (dotimes i (count!) i)
         calls`),
    1
  );
});

test('dolist evaluates its list expression exactly once', () => {
  assert.equal(
    run(`(define calls 0)
         (define (items!) (set! calls (+ calls 1)) (list 1 2 3))
         (dolist x (items!) x)
         calls`),
    1
  );
});

test('loop macros allow an empty body', () => {
  assert.equal(run('(while #f)'), NIL);
  assert.equal(run('(dotimes i 3)'), NIL);
  assert.equal(run('(dolist x (list 1 2))'), NIL);
});

test('a loop body sees outer bindings', () => {
  assert.equal(
    run(`(define base 100) (define acc 0)
         (dotimes i 3 (set! acc (+ acc base i)))
         acc`),
    303
  );
});

test('loop macros do not capture caller bindings (gensym discipline)', () => {
  // The expansions' internal names (the loop procedure, the saved count,
  // the list walker) are gensyms — a caller's own `rest`, `n` or `loop`
  // binding stays visible, untouched, inside the body.
  assert.equal(
    run(`(define rest 99) (define seen nil)
         (dolist x (list 1) (set! seen rest))
         seen`),
    99
  );
  assert.equal(
    run(`(define n 99) (define seen nil)
         (dotimes i 1 (set! seen n))
         seen`),
    99
  );
  assert.equal(
    run(`(define loop 99) (define i 0) (define seen nil)
         (while (< i 1) (set! i (+ i 1)) (set! seen loop))
         seen`),
    99
  );
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

// --- macroexpand ----------------------------------------------------------

test('macroexpand-1 expands a macro use one step, as data', () => {
  assert.equal(
    show("(macroexpand-1 '(when a b c))"),
    '(if a (begin b c))'
  );
});

test('macroexpand-1 passes non-macro forms through unchanged', () => {
  assert.equal(show("(macroexpand-1 '(+ 1 2))"), '(+ 1 2)');
  assert.equal(show("(macroexpand-1 '(if a b))"), '(if a b)'); // special form
  assert.equal(run('(macroexpand-1 42)'), 42);
  assert.equal(show("(macroexpand-1 'foo)"), 'foo');
  assert.equal(run('(macroexpand-1 nil)'), NIL);
});

test('macroexpand expands until the head is no longer a macro', () => {
  assert.equal(
    show(`(defmacro my-unless (test . body)
            (cons 'when (cons (list 'not test) body)))
          (macroexpand '(my-unless p q))`),
    '(if (not p) (begin q))'
  );
  // macroexpand-1 stops after the first step.
  assert.equal(
    show(`(defmacro my-unless (test . body)
            (cons 'when (cons (list 'not test) body)))
          (macroexpand-1 '(my-unless p q))`),
    '(when (not p) q)'
  );
});

test('macroexpand errors on a self-expanding macro (the cap)', () => {
  assert.throws(
    () => run("(defmacro forever (x) (list 'forever x)) (macroexpand '(forever 1))"),
    (err) => {
      assert.ok(err instanceof LispError);
      assert.match(err.message, /macroexpand: expansion did not terminate/);
      return true;
    }
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

test('string-suffix? tests how a string ends', () => {
  assert.equal(run('(string-suffix? "cd" "abcd")'), true);
  assert.equal(run('(string-suffix? "x" "abcd")'), false);
  assert.equal(run('(string-suffix? "" "abc")'), true);
});

test('string-join joins a list with a separator', () => {
  assert.equal(run('(string-join (list "a" "b" "c") "-")'), 'a-b-c');
  assert.equal(run('(string-join (list "x" "y"))'), 'xy'); // default separator
  assert.equal(run('(string-join (list) ",")'), '');
  assert.equal(run('(string-join (list "solo") ",")'), 'solo');
  // Elements are coerced like `str` (numbers, etc.).
  assert.equal(run('(string-join (list 1 2 3) ".")'), '1.2.3');
});

test('string-join is iterative — no stack overflow on a long list', () => {
  // The interpreter has no TCO; a hand-written Lisp join would overflow
  // here. `string-join` joins in one host pass.
  assert.equal(
    run('(string-length (string-join (map number->string (range 50000)) ","))') > 0,
    true
  );
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

// --- tail-call optimisation (the trampoline) ----------------------------
// Tail calls run in constant JS stack; depths here would overflow a
// naive tree-walker. `run`/`show` use a fresh interpreter (core forms
// only), so the tests define what they need with `define`/`defmacro`.

test('deep self tail-recursion runs in constant stack', () => {
  const src = `(begin
    (define (loop n) (if (= n 0) (quote done) (loop (- n 1))))
    (loop 1000000))`;
  assert.equal(show(src), 'done');
});

test('a tail-recursive accumulator is correct (sum 1..100000)', () => {
  const src = `(begin
    (define (sum n acc) (if (= n 0) acc (sum (- n 1) (+ acc n))))
    (sum 100000 0))`;
  assert.equal(run(src), 5000050000);
});

test('mutual tail-recursion runs in constant stack', () => {
  const src = `(begin
    (define (ev? n) (if (= n 0) #t (od? (- n 1))))
    (define (od? n) (if (= n 0) #f (ev? (- n 1))))
    (ev? 500000))`;
  assert.equal(run(src), true);
});

test('the tail slot of cond/let/begin/and/or is optimised', () => {
  const cases = {
    cond: '(define (f n) (cond ((= n 0) (quote ok)) (else (f (- n 1)))))',
    let: '(define (f n) (let ((m (- n 1))) (if (= n 0) (quote ok) (f m))))',
    begin: '(define (f n) (begin 1 (if (= n 0) (quote ok) (f (- n 1)))))',
    and: '(define (f n) (and #t (if (= n 0) (quote ok) (f (- n 1)))))',
    or: '(define (f n) (or #f (if (= n 0) (quote ok) (f (- n 1)))))',
  };
  for (const [name, def] of Object.entries(cases)) {
    assert.equal(show(`(begin ${def} (f 200000))`), 'ok', `tail via ${name}`);
  }
});

test('tail position survives macro expansion', () => {
  const src = `(begin
    (defmacro my-if (c t e) (list (quote cond) (list c t) (list (quote else) e)))
    (define (f n) (my-if (= n 0) (quote ok) (f (- n 1))))
    (f 200000))`;
  assert.equal(show(src), 'ok');
});

test('non-tail recursion is unchanged (correct at safe depth)', () => {
  // The recursive call sits inside `cons` (an argument), so it is NOT a
  // tail call — TCO does not (and should not) flatten it. Still correct.
  const src = `(begin
    (define (build n) (if (= n 0) (list) (cons n (build (- n 1)))))
    (length (build 500)))`;
  assert.equal(run(src), 500);
});
