/**
 * @file Tests for the primitive procedures (`src/primitives.js`) — the
 * built-in library. Before this file there was no `primitives.test.js`;
 * the interpreter suite touched a handful of primitives only incidentally.
 *
 * These are characterization tests: each asserts the behaviour the
 * primitive ACTUALLY has today (observed against the running interpreter),
 * so a regression in any one primitive trips a red test. Grouped by the
 * families `primitives.js` defines. Error cases (wrong-type / arity /
 * out-of-range) that raise a `LispError` are pinned alongside the happy
 * paths.
 *
 * Audit ticket E2.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInterpreter, LispError, writeString } from '../src/index.js';

/** Evaluate Lisp source in a fresh interpreter; return the last value. */
function run(source) {
  return createInterpreter().evaluate(source);
}

/** Evaluate Lisp source and render the result to text. */
function show(source) {
  return writeString(run(source));
}

// =======================================================================
// Constants
// =======================================================================

test('the boolean and nil constants are bound', () => {
  assert.equal(run('true'), true);
  assert.equal(run('false'), false);
  assert.equal(show('nil'), 'nil');
});

// =======================================================================
// Arithmetic and numeric
// =======================================================================

test('+ and * fold, with identity elements for the empty call', () => {
  assert.equal(run('(+ 1 2 3 4)'), 10);
  assert.equal(run('(+)'), 0);
  assert.equal(run('(* 2 3 4)'), 24);
  assert.equal(run('(*)'), 1);
});

test('- negates a single argument and subtracts a chain', () => {
  assert.equal(run('(- 7)'), -7);
  assert.equal(run('(- 10 3 2)'), 5);
  assert.throws(() => run('(-)'), LispError); // needs at least one arg
});

test('/ reciprocates a single argument and divides a chain', () => {
  assert.equal(run('(/ 5)'), 0.2);
  assert.equal(run('(/ 100 5 2)'), 10);
  assert.throws(() => run('(/)'), LispError);
});

test('division by zero is a LispError', () => {
  assert.throws(() => run('(/ 1 0)'), LispError);
  assert.throws(() => run('(/ 10 2 0)'), LispError); // mid-chain zero too
});

test('mod is floored (result follows the divisor sign)', () => {
  assert.equal(run('(mod -1 3)'), 2);
  assert.equal(run('(mod 7 3)'), 1);
  assert.throws(() => run('(mod 1 0)'), LispError);
});

test('quotient truncates toward zero; remainder follows the dividend', () => {
  assert.equal(run('(quotient 7 2)'), 3);
  assert.equal(run('(quotient -7 2)'), -3);
  assert.equal(run('(remainder -1 3)'), -1); // unlike mod's 2
});

test('abs / min / max / inc / dec / expt', () => {
  assert.equal(run('(abs -5)'), 5);
  assert.equal(run('(min 3 1 2)'), 1);
  assert.equal(run('(max 3 1 2)'), 3);
  assert.equal(run('(inc 4)'), 5);
  assert.equal(run('(dec 4)'), 3);
  assert.equal(run('(expt 2 10)'), 1024);
});

test('sqrt / floor / ceiling / round', () => {
  assert.equal(run('(sqrt 9)'), 3);
  assert.equal(run('(floor 3.7)'), 3);
  assert.equal(run('(ceiling 3.2)'), 4);
  // round is JS Math.round: half rounds UP (toward +Infinity), not
  // banker's rounding. Pinned so a change to half-even is deliberate.
  assert.equal(run('(round 2.5)'), 3);
  assert.equal(run('(round -2.5)'), -2);
});

test('arithmetic on a non-number is a LispError', () => {
  assert.throws(() => run('(+ 1 "two")'), LispError);
  assert.throws(() => run('(* 2 nil)'), LispError);
  assert.throws(() => run('(abs "x")'), LispError);
});

// =======================================================================
// Numeric comparison
// =======================================================================

test('comparison operators chain across all arguments', () => {
  assert.equal(run('(< 1 2 3)'), true);
  assert.equal(run('(< 1 3 2)'), false);
  assert.equal(run('(> 3 2 1)'), true);
  assert.equal(run('(<= 1 1 2)'), true);
  assert.equal(run('(>= 3 3 1)'), true);
  assert.equal(run('(= 5 5 5)'), true);
  assert.equal(run('(= 5 5 6)'), false);
});

test('a comparison with fewer than two arguments is vacuously true', () => {
  assert.equal(run('(<)'), true);
  assert.equal(run('(< 1)'), true);
  assert.equal(run('(= 42)'), true);
});

// =======================================================================
// Pairs and lists
// =======================================================================

test('cons / car / cdr build and take apart pairs', () => {
  assert.equal(show('(cons 1 2)'), '(1 . 2)');
  assert.equal(show('(cons 0 (list 1 2))'), '(0 1 2)');
  assert.equal(run('(car (list 8 9))'), 8);
  assert.equal(show('(cdr (list 8 9))'), '(9)');
});

test('cons requires exactly two arguments', () => {
  assert.throws(() => run('(cons 1)'), LispError);
  assert.throws(() => run('(cons 1 2 3)'), LispError);
});

test('car / cdr on a non-pair are LispErrors', () => {
  assert.throws(() => run('(car (list))'), LispError); // nil is not a pair
  assert.throws(() => run('(cdr 5)'), LispError);
});

test('first / rest are nil-safe where car / cdr are not', () => {
  assert.equal(run('(first (list 8 9))'), 8);
  assert.equal(show('(rest (list 8 9))'), '(9)');
  assert.equal(show('(first (list))'), 'nil');
  assert.equal(show('(rest (list))'), 'nil');
});

test('list builds a proper list; length counts it', () => {
  assert.equal(show('(list 1 2 3)'), '(1 2 3)');
  assert.equal(show('(list)'), 'nil');
  assert.equal(run('(length (list 1 2 3 4))'), 4);
});

test('length also measures strings, vectors and maps', () => {
  assert.equal(run('(length "hello")'), 5);
  assert.equal(run('(length (vector 1 2 3))'), 3);
  assert.equal(run('(length (hash-map :a 1 :b 2))'), 2);
});

test('append concatenates and leaves the final tail in place', () => {
  assert.equal(show('(append)'), 'nil');
  assert.equal(show('(append (list 1) (list 2) (list 3 4))'), '(1 2 3 4)');
  // The last argument becomes the tail verbatim — an improper list here.
  assert.equal(show('(append (list 1 2) 3)'), '(1 2 . 3)');
});

test('reverse reverses a list', () => {
  assert.equal(show('(reverse (list 1 2 3))'), '(3 2 1)');
  assert.equal(show('(reverse (list))'), 'nil');
});

test('nth indexes lists and vectors and errors out of range', () => {
  assert.equal(run('(nth (list 10 20 30) 1)'), 20);
  assert.equal(run('(nth (vector 10 20 30) 2)'), 30);
  assert.throws(() => run('(nth (list 1) 5)'), LispError);
  assert.throws(() => run('(nth (list 1) -1)'), LispError);
});

test('last returns the final element, nil for the empty list', () => {
  assert.equal(run('(last (list 1 2 3))'), 3);
  assert.equal(show('(last (list))'), 'nil');
});

test('member returns the tail from the match, #f when absent', () => {
  assert.equal(show('(member 2 (list 1 2 3))'), '(2 3)');
  assert.equal(run('(member 9 (list 1 2 3))'), false);
  // member compares with `equal?`, so structural matches work.
  assert.equal(show('(member (list 1) (list (list 0) (list 1) (list 2)))'), '((1) (2))');
});

// =======================================================================
// Higher-order functions
// =======================================================================

test('map applies over one list', () => {
  assert.equal(show('(map inc (list 1 2 3))'), '(2 3 4)');
});

test('map over several lists stops at the shortest', () => {
  assert.equal(show('(map + (list 1 2 3) (list 10 20 30))'), '(11 22 33)');
  assert.equal(show('(map + (list 1 2 3) (list 10 20))'), '(11 22)');
});

test('map and friends accept vectors as sequences', () => {
  assert.equal(show('(map inc (vector 1 2 3))'), '(2 3 4)');
});

test('filter keeps the elements for which the predicate is not #f', () => {
  assert.equal(show('(filter even? (list 1 2 3 4 5 6))'), '(2 4 6)');
  assert.equal(show('(filter odd? (list 1 2 3 4 5))'), '(1 3 5)');
});

test('reduce folds with an explicit seed', () => {
  assert.equal(run('(reduce + 0 (list 1 2 3 4 5))'), 15);
  assert.equal(run('(reduce * 1 (list 1 2 3 4))'), 24);
});

test('for-each runs for side effects and returns nil', () => {
  assert.equal(
    run('(define s 0) (for-each (lambda (x) (set! s (+ s x))) (list 1 2 3)) s'),
    6
  );
  assert.equal(show('(for-each display (list))'), 'nil');
});

test('apply spreads its final list argument', () => {
  assert.equal(run('(apply + (list 1 2 3 4))'), 10);
  assert.equal(run('(apply + 1 2 (list 3 4))'), 10); // leading args too
});

test('range: one, two and three argument forms', () => {
  assert.equal(show('(range 5)'), '(0 1 2 3 4)');
  assert.equal(show('(range 2 6)'), '(2 3 4 5)');
  assert.equal(show('(range 0 10 2)'), '(0 2 4 6 8)');
  assert.equal(show('(range 10 0 -2)'), '(10 8 6 4 2)');
  assert.throws(() => run('(range 0 10 0)'), LispError); // zero step
});

// =======================================================================
// Strings
// =======================================================================

test('str coerces and concatenates anything; string-append needs strings', () => {
  assert.equal(run('(str "n=" 42 " ok")'), 'n=42 ok');
  assert.equal(run('(str (list 1 2 3))'), '(1 2 3)');
  assert.equal(run('(string-append "a" "b" "c")'), 'abc');
  assert.throws(() => run('(string-append "a" 1)'), LispError);
});

test('substring with two and three arguments', () => {
  assert.equal(run('(substring "abcdef" 2)'), 'cdef');
  assert.equal(run('(substring "abcdef" 1 4)'), 'bcd');
});

test('case folding', () => {
  assert.equal(run('(string-upcase "aBc")'), 'ABC');
  assert.equal(run('(string-downcase "aBc")'), 'abc');
});

test('string-repeat repeats and clamps a negative count to empty', () => {
  assert.equal(run('(string-repeat "ab" 3)'), 'ababab');
  assert.equal(run('(string-repeat "ab" 0)'), '');
  assert.equal(run('(string-repeat "ab" -2)'), '');
});

test('string-split splits on a separator', () => {
  assert.equal(show('(string-split "a,b,c" ",")'), '("a" "b" "c")');
});

test('string-contains? / string-index-of', () => {
  assert.equal(run('(string-contains? "hello" "ell")'), true);
  assert.equal(run('(string-contains? "hello" "xyz")'), false);
  assert.equal(run('(string-index-of "hello" "l")'), 2);
  assert.equal(run('(string-index-of "hello" "l" 3)'), 3); // from index
  assert.equal(run('(string-index-of "hello" "z")'), -1); // not found
});

test('string-prefix? / string-suffix? / string=?', () => {
  assert.equal(run('(string-prefix? "ab" "abcd")'), true);
  assert.equal(run('(string-prefix? "" "abc")'), true);
  assert.equal(run('(string-suffix? "cd" "abcd")'), true);
  assert.equal(run('(string=? "ab" "ab")'), true);
  assert.equal(run('(string=? "ab" "ba")'), false);
});

test('string-length errors on a non-string', () => {
  assert.equal(run('(string-length "hello")'), 5);
  assert.throws(() => run('(string-length 5)'), LispError);
});

test('symbol / keyword / number string conversions', () => {
  assert.equal(show('(string->symbol "foo")'), 'foo');
  assert.equal(run('(symbol->string (quote foo))'), 'foo');
  assert.equal(run('(symbol->string :kw)'), 'kw'); // keywords accepted too
  assert.equal(show('(string->keyword "kw")'), ':kw');
  assert.equal(run('(keyword->string :kw)'), 'kw');
  assert.equal(run('(string->number "3.14")'), 3.14);
  assert.equal(run('(string->number "notnum")'), false); // #f, not NaN
  assert.equal(run('(number->string 42)'), '42');
});

test('keyword->string rejects a non-keyword', () => {
  assert.throws(() => run('(keyword->string (quote foo))'), LispError);
});

test('read-string parses source into a list of forms', () => {
  assert.equal(show('(read-string "(+ 1 2) 3")'), '((+ 1 2) 3)');
});

// =======================================================================
// Vectors
// =======================================================================

test('vector constructs an immutable (frozen) vector', () => {
  const v = run('(vector 1 2 3)');
  assert.ok(Array.isArray(v));
  assert.equal(Object.isFrozen(v), true); // vectors are immutable
  assert.equal(show('(vector 1 2 3)'), '[1 2 3]');
});

test('vector-ref reads by index and errors out of range or on non-vector', () => {
  assert.equal(run('(vector-ref (vector 10 20 30) 1)'), 20);
  assert.throws(() => run('(vector-ref (vector 1) 5)'), LispError);
  assert.throws(() => run('(vector-ref 5 0)'), LispError);
});

test('vector-length / vector->list / list->vector', () => {
  assert.equal(run('(vector-length (vector 1 2 3))'), 3);
  assert.equal(show('(vector->list (vector 1 2 3))'), '(1 2 3)');
  assert.equal(show('(list->vector (list 1 2 3))'), '[1 2 3]');
  assert.equal(Object.isFrozen(run('(list->vector (list 1 2))')), true);
});

// =======================================================================
// Maps
// =======================================================================

test('hash-map builds a map; an odd argument count is an error', () => {
  assert.equal(run('(get (hash-map :a 1 :b 2) :b)'), 2);
  assert.throws(() => run('(hash-map :a)'), LispError);
});

test('get reads maps and vectors, with an optional fallback', () => {
  assert.equal(run('(get (hash-map :a 1) :a)'), 1);
  assert.equal(run('(get (hash-map :a 1) :z 99)'), 99); // fallback
  assert.equal(run('(get (hash-map :a 1) :z)'), false); // miss -> #f
  assert.equal(run('(get (vector 10 20) 1)'), 20);
  assert.equal(run('(get (vector 10 20) 5)'), false); // out of range -> #f
  assert.throws(() => run('(get 5 0)'), LispError); // not a map or vector
});

test('get: absence is #f, so a bare if-test works (miss convention)', () => {
  // The motivating idiom — nil is truthy here, so the old nil-on-miss
  // sent this down the wrong branch.
  assert.equal(show("(if (get (hash-map :a 1) :missing) 'yes 'no)"), 'no');
  // A key PRESENT with a nil value still yields nil — only a genuine
  // miss is #f; the 3-arg form discriminates a stored #f.
  assert.equal(show('(get (hash-map :a nil) :a)'), 'nil');
  assert.equal(run('(get (hash-map :a #f) :a 99)'), false);
  // nil? on a miss is #f (a miss is not nil) — callers test with `not`.
  assert.equal(run('(nil? (get (hash-map) :missing))'), false);
  assert.equal(run('(not (get (hash-map) :missing))'), true);
});

test('assoc and dissoc return new maps without mutating the original', () => {
  assert.equal(run('(get (assoc (hash-map :a 1) :b 2) :b)'), 2);
  assert.equal(run('(contains? (dissoc (hash-map :a 1 :b 2) :a) :a)'), false);
  // The original is untouched (functional update).
  assert.equal(
    run('(define m (hash-map :a 1)) (assoc m :b 2) (contains? m :b)'),
    false
  );
});

test('contains? / keys / vals operate on maps', () => {
  assert.equal(run('(contains? (hash-map :a 1) :a)'), true);
  assert.equal(run('(contains? (hash-map :a 1) :z)'), false);
  assert.equal(show('(keys (hash-map :a 1 :b 2))'), '(:a :b)');
  assert.equal(show('(vals (hash-map :a 1 :b 2))'), '(1 2)');
  assert.throws(() => run('(contains? (list 1) 1)'), LispError); // not a map
});

// =======================================================================
// Predicates and equality
// =======================================================================

test('type predicates classify the core types', () => {
  assert.equal(run('(nil? (list))'), true);
  assert.equal(run('(nil? 0)'), false);
  assert.equal(run('(pair? (cons 1 2))'), true);
  assert.equal(run('(pair? (list))'), false); // nil is not a pair
  assert.equal(run('(list? (list 1 2))'), true);
  assert.equal(run('(list? (cons 1 2))'), false); // improper
  assert.equal(run('(number? 5)'), true);
  assert.equal(run('(string? "x")'), true);
  assert.equal(run('(symbol? (quote foo))'), true);
  assert.equal(run('(keyword? :foo)'), true);
  assert.equal(run('(boolean? #t)'), true);
  assert.equal(run('(procedure? +)'), true);
  assert.equal(run('(procedure? (lambda (x) x))'), true);
  assert.equal(run('(vector? (vector 1))'), true);
  assert.equal(run('(map? (hash-map :a 1))'), true);
});

test('numeric predicates', () => {
  assert.equal(run('(zero? 0)'), true);
  assert.equal(run('(positive? 3)'), true);
  assert.equal(run('(negative? -3)'), true);
  assert.equal(run('(even? 4)'), true);
  assert.equal(run('(odd? 3)'), true);
});

test('empty? spans lists, strings, vectors and maps', () => {
  assert.equal(run('(empty? (list))'), true);
  assert.equal(run('(empty? "")'), true);
  assert.equal(run('(empty? (vector))'), true);
  assert.equal(run('(empty? (hash-map))'), true);
  assert.equal(run('(empty? (list 1))'), false);
  assert.equal(run('(empty? 5)'), false); // a number is "not empty"
});

test('eq? is identity; equal? is deep structural equality', () => {
  assert.equal(run('(eq? 5 5)'), true);
  assert.equal(run('(eq? (quote a) (quote a))'), true); // symbols interned
  assert.equal(run('(eq? (list 1) (list 1))'), false); // distinct objects
  assert.equal(run('(equal? (list 1 2) (list 1 2))'), true);
  assert.equal(run('(equal? (vector 1 (vector 2 3)) (vector 1 (vector 2 3)))'), true);
  assert.equal(run('(equal? (hash-map :a 1) (hash-map :a 1))'), true);
});

test('not is true only for #f (Scheme truthiness)', () => {
  assert.equal(run('(not #f)'), true);
  assert.equal(run('(not #t)'), false);
  assert.equal(run('(not (list))'), false); // nil is truthy
  assert.equal(run('(not 0)'), false); // 0 is truthy
});

// =======================================================================
// Symbols
// =======================================================================

test('gensym makes a fresh, distinct symbol each call', () => {
  assert.equal(run('(eq? (gensym) (gensym))'), false);
  assert.equal(run('(symbol? (gensym))'), true);
  // A prefix is honoured.
  assert.equal(run('(string-prefix? "tmp__" (symbol->string (gensym "tmp")))'), true);
});

// =======================================================================
// Output
// =======================================================================

test('display renders without quotes; write renders readably', () => {
  let out = '';
  const lisp = createInterpreter({ write: (text) => (out += text) });
  lisp.evaluate('(display "hi")');
  lisp.evaluate('(write "hi")');
  assert.equal(out, 'hi"hi"'); // display: hi, write: "hi"
});

test('newline writes a single newline', () => {
  let out = '';
  const lisp = createInterpreter({ write: (text) => (out += text) });
  lisp.evaluate('(newline)');
  assert.equal(out, '\n');
});

// =======================================================================
// Errors
// =======================================================================

test('error raises a LispError carrying the message and irritants', () => {
  assert.throws(
    () => run('(error "boom" 1 2)'),
    (err) => {
      assert.ok(err instanceof LispError);
      assert.equal(err.message, 'boom');
      return true;
    }
  );
  // The irritants are reachable via try/catch.
  assert.equal(show('(try (error "boom" 1 2) (catch e (get e :irritants)))'), '(1 2)');
});

// =======================================================================
// Introspection
// =======================================================================

test('identity returns its argument', () => {
  assert.equal(run('(identity 42)'), 42);
  assert.equal(show('(identity (list 1 2))'), '(1 2)');
});

test('type-of reports a keyword for each value type', () => {
  assert.equal(show('(type-of 5)'), ':number');
  assert.equal(show('(type-of "x")'), ':string');
  assert.equal(show('(type-of (list))'), ':nil');
  assert.equal(show('(type-of (vector 1))'), ':vector');
  assert.equal(show('(type-of (hash-map))'), ':map');
  assert.equal(show('(type-of :k)'), ':keyword');
  assert.equal(show('(type-of #t)'), ':boolean');
  // An improper list reports :list (pair), not a distinct pair type.
  assert.equal(show('(type-of (cons 1 2))'), ':list');
});

test('doc returns a lambda docstring, #f otherwise (miss convention)', () => {
  assert.equal(run('(define (f x) "docs here" x) (doc f)'), 'docs here');
  assert.equal(run('(define (g x) x) (doc g)'), false); // no docstring
  assert.equal(run('(doc +)'), false); // primitives carry no doc
  // Absence is #f, so a bare if-test takes the right branch.
  assert.equal(show("(define (g x) x) (if (doc g) 'documented 'bare)"), 'bare');
});

test('where-defined returns "line:col" for a lambda, #f otherwise', () => {
  assert.match(run('(define (f x) x) (where-defined f)'), /^\d+:\d+$/);
  assert.equal(run('(where-defined +)'), false); // primitives: no source
  assert.equal(run('(where-defined 42)'), false); // not a procedure at all
});

test('describe summarises a procedure, a primitive and a plain value', () => {
  const proc = show('(define (f a b) "sum" (+ a b)) (describe f)');
  assert.match(proc, /:kind :procedure/);
  assert.match(proc, /:name f/);
  assert.match(proc, /:params \(a b\)/);
  assert.match(proc, /:doc "sum"/);

  const prim = show('(describe +)');
  assert.match(prim, /:kind :primitive/);
  assert.match(prim, /:name \+/);

  const val = show('(describe 42)');
  assert.match(val, /:kind :value/);
  assert.match(val, /:type :number/);
});
