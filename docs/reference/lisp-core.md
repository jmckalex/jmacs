Title: jmacs Core Lisp Reference
Author: J. McKenzie Alexander
Date: 2026-05-22
---

# jmacs Core Lisp Reference

This document describes the *core primitives* — the procedures built
into the jmacs Lisp itself — and the *prelude*, a small amount of Lisp
evaluated at startup. Together they are the language's standard library,
independent of the editor: they would be present in any program written
in this Lisp.

- The primitives are defined in `packages/lisp/src/primitives.js`
  (JavaScript) and installed into the global environment at startup.
- The prelude is defined in `packages/lisp/src/interpreter.js` as a
  string of Lisp, evaluated once the primitives are in place.

For the editor's own procedures — commands, buffer operations — see
`commands.jmd` and `buffer-primitives.jmd`. For the language's
*special forms* (`define`, `lambda`, `if`, `let`, `defmacro`, …), which
are not procedures and so not listed here, see `docs/spec/lisp.md` §4.

Conventions (see `index.jmd`): predicates end in `?`; conversions are
written `from->to`; a trailing `…` marks a variadic procedure; a
bracketed argument is optional. The primitives raise a `LispError` on a
type or arity mismatch.

---

## Constants

### `nil`, `true`, `false`

`nil` is the empty list — also the editor's "no value". `true` and
`false` are the booleans, equal to the reader's `#t` and `#f`. Only
`#f` is false; `nil`, `0` and `""` are all truthy (`docs/spec/lisp.md`
§3).

## Arithmetic

### `+` / `*`
`(+ x …)` / `(* x …)`

Sum and product of the arguments. `(+)` is `0`, `(*)` is `1`.

### `-`
`(- x …)`

With one argument, negation; with more, left-to-right subtraction.

### `/`
`(/ x …)`

With one argument, reciprocal; with more, left-to-right division.
Raises an error on division by zero.

### `mod` / `quotient` / `remainder`
`(mod a b)` / `(quotient a b)` / `(remainder a b)`

`mod` is the result with the sign of the divisor (always non-negative
for a positive `b`); `quotient` is truncating integer division;
`remainder` keeps the sign of the dividend.

### `abs`
`(abs x)`

Absolute value.

### `min` / `max`
`(min x …)` / `(max x …)`

Least and greatest of the arguments.

### `inc` / `dec`
`(inc x)` / `(dec x)`

`x` plus one / minus one.

### `expt`
`(expt base power)`

`base` raised to `power`.

### `sqrt`
`(sqrt x)`

Square root.

## Numeric comparison

### `=` `<` `>` `<=` `>=`
`(= x …)`, `(< x …)`, `(> x …)`, `(<= x …)`, `(>= x …)`

Chained numeric comparison: true when every adjacent pair is in the
given relation. `(< 1 2 3)` is true. Numbers only — for general
equality use `equal?`.

## Type predicates

### `nil?` `pair?` `list?`
`(nil? x)` `(pair? x)` `(list? x)`

`nil?` — the empty list; `pair?` — a cons cell; `list?` — `nil` or a
proper (`nil`-terminated) chain of pairs.

### `number?` `string?` `symbol?` `keyword?` `boolean?` `procedure?` `vector?` `map?`
`(number? x)` … `(map? x)`

True when `x` is of the named type. `procedure?` is true for
primitives, closures and macros alike.

### `zero?` `positive?` `negative?` `even?` `odd?`
`(zero? x)` … `(odd? x)`

Numeric predicates on a single number.

### `empty?`
`(empty? x)`

True when `x` is empty: `nil`, an empty vector, an empty string, or an
empty map. False for any other value.

## Equality and logic

### `eq?`
`(eq? a b)`

Identity equality — JavaScript `===`. True for identical objects, equal
numbers, interned symbols and keywords.

### `equal?`
`(equal? a b)`

Deep structural equality — compares the contents of pairs, vectors and
maps recursively.

### `not`
`(not x)`

True when `x` is exactly `false`; false for every other value
(including `nil`).

## Pairs and lists

### `cons`
`(cons head tail)`

A new pair. With a list `tail`, prepends an element.

### `car` / `cdr`
`(car pair)` / `(cdr pair)`

The head and tail of a pair. Both raise an error on a non-pair.

### `first` / `rest`
`(first x)` / `(rest x)`

Like `car` / `cdr`, but return `nil` for a non-pair rather than
erroring — the gentle accessors.

### `list`
`(list x …)`

A list of the arguments.

### `length`
`(length x)`

The number of elements in a list, vector or string, or entries in a
map.

### `append`
`(append list … tail)`

Concatenate the lists, sharing the final argument as the tail (it need
not be a list — `(append '(1 2) 3)` is the improper list `(1 2 . 3)`).

### `reverse`
`(reverse list)`

The list, reversed.

### `nth`
`(nth seq i)`

The element of a list or vector `seq` at zero-based index `i`. Errors
when `i` is out of range.

### `last`
`(last list)`

The final element of a list, or `nil` when it is empty.

### `member`
`(member x list)`

The first sublist of `list` whose head is `equal?` to `x`, or `false`
when `x` is not present. The truthy result doubles as a "found" flag.

## Higher-order procedures

These accept lists *or* vectors for their sequence arguments; they
return lists.

### `apply`
`(apply proc arg … list)`

Call `proc` with the leading arguments followed by the elements of the
final `list`.

### `map`
`(map proc seq …)`

Apply `proc` across one or more sequences in step, collecting the
results. With several sequences, stops at the shortest.

### `filter`
`(filter pred seq)`

The elements of `seq` for which `pred` does not return `false`.

### `reduce`
`(reduce proc init seq)`

Fold `seq` left-to-right: `(proc (proc init e1) e2) …`.

### `for-each`
`(for-each proc seq)`

Apply `proc` to each element of `seq` for its side effect; returns
`nil`.

### `range`
`(range end)` / `(range start end)` / `(range start end step)`

A list of numbers from `start` (default `0`) up to but excluding
`end`, by `step` (default `1`). A negative step counts down. A zero
step is an error.

## Strings

### `str`
`(str x …)`

Concatenate the arguments' display forms into one string — coerces
non-strings (numbers, symbols, …). The everyday string-builder.

### `string-append`
`(string-append s …)`

Concatenate strings. Unlike `str`, every argument must already be a
string.

### `string-length`
`(string-length s)`

The number of characters in `s`.

### `substring`
`(substring s start [end])`

The slice of `s` from `start` to `end` (or to the end of the string).

### `string-upcase` / `string-downcase`
`(string-upcase s)` / `(string-downcase s)`

`s` with every letter in upper or lower case.

### `string-split`
`(string-split s sep)`

`s` split on every occurrence of the string `sep`, as a list of
substrings.

### `string-contains?`
`(string-contains? s sub)`

True when `s` contains `sub`.

### `string-prefix?` / `string-suffix?`
`(string-prefix? prefix s)` / `(string-suffix? suffix s)`

True when `s` starts with `prefix` / ends with `suffix`. Note the
argument order: the affix comes first. `string-suffix?` is what the
mode registry matches filenames with.

### `string->symbol` / `symbol->string`
`(string->symbol s)` / `(symbol->string sym)`

Convert between a string and an interned symbol.

### `string->number`
`(string->number s)`

The number `s` denotes, or `false` when it is not numeric.

### `number->string`
`(number->string n)`

The decimal string for the number `n`.

## Vectors

A vector is a fixed JavaScript array; vectors are frozen (immutable).

### `vector`
`(vector x …)`

A vector of the arguments.

### `vector-ref`
`(vector-ref v i)`

The element at zero-based index `i`. Errors when `i` is out of range.

### `vector-length`
`(vector-length v)`

The number of elements in `v`.

### `vector->list` / `list->vector`
`(vector->list v)` / `(list->vector list)`

Convert between a vector and a list.

## Maps

A map is an immutable key-value table. The "mutating" operations return
a *new* map.

### `hash-map`
`(hash-map k v …)`

A map from alternating key/value arguments. The map literal `{…}` is
sugar for this. Requires an even number of arguments.

### `get`
`(get coll key [fallback])`

The value for `key` in a map, or the element at index `key` in a
vector. Returns `fallback` (default `nil`) when the key or index is
absent.

### `assoc`
`(assoc map key value)`

A copy of `map` with `key` set to `value`.

### `dissoc`
`(dissoc map key)`

A copy of `map` with `key` removed.

### `contains?`
`(contains? map key)`

True when `map` has an entry for `key`.

### `keys` / `vals`
`(keys map)` / `(vals map)`

The keys / values of `map`, as a list.

## Symbols

### `gensym`
`(gensym [prefix])`

A fresh, unique symbol — `prefix` (default `g`) plus a counter. Use it
for names introduced by a macro, since macros are not hygienic in v0
(`docs/spec/lisp.md` §5).

## Output

The output sink is the REPL.

### `display`
`(display x)`

Write `x` in its human-readable display form (a string is written
without quotes).

### `write`
`(write x)`

Write `x` in its machine-readable form (a string is written *with*
quotes and escapes) — the form the reader could read back.

### `newline`
`(newline)`

Write a line break.

### `print` / `println`
`(print x …)` / `(println x …)`

Write the arguments' display forms, space-separated. `println` adds a
trailing newline.

## Errors

### `error`
`(error message irritant …)`

Signal an error: raise a `LispError` carrying `message` and any
`irritant` values. Caught by `(try … (catch e …))`, where `e` is bound
to a condition map with `:message` and `:irritants` (`docs/spec/lisp.md`
§7).

## Introspection

The editor's "explain itself" principle. See also `commands.jmd` —
`describe-key`, `describe-command` — for the interactive surface.

### `identity`
`(identity x)`

`x`, unchanged. Useful as a default transform.

### `type-of`
`(type-of x)`

A keyword naming `x`'s type — `:number`, `:string`, `:pair`, and so on.

### `doc`
`(doc proc)`

The docstring of a procedure defined with `define`, or `nil`. A
procedure's docstring is the leading string literal in its body.

### `where-defined`
`(where-defined proc)`

The `"line:col"` a procedure was defined at, or `nil` for a primitive.

### `describe`
`(describe x)`

A map describing `x`: its `:kind`, and — for a procedure — its `:name`,
`:params`, `:doc` and `:defined-at`. The structured form behind the
`describe-command` command.

---

# The prelude

The prelude is a little Lisp evaluated at startup, on top of the
primitives — defining the common control macros in Lisp dogfoods the
macro system. It is in `packages/lisp/src/interpreter.js`.

## Control-flow macros

Both are built from the `if` special form.

### `when`
`(when test body …)` — *macro*

Evaluate `body` in sequence when `test` is truthy; otherwise `nil`. An
`if` with no else branch and an implicit `begin`.

### `unless`
`(unless test body …)` — *macro*

Evaluate `body` in sequence when `test` is *false*y; otherwise `nil`.
The complement of `when`.

## List accessors

Composed `car`/`cdr` accessors, read inside-out as usual.

### `caar` / `cadr` / `caddr` / `cddr`
`(caar p)` `(cadr p)` `(caddr p)` `(cddr p)`

`caar` — the head of the head; `cadr` — the second element; `caddr` —
the third element; `cddr` — the list with its first two elements
dropped.

### `second` / `third`
`(second list)` / `(third list)`

The second and third elements of a list — readable names for `cadr`
and `caddr`.
