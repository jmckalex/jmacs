Title: Godot Core Lisp Reference
Author: J. McKenzie Alexander
Date: 2026-07-21
---

## Godot Core Lisp Reference

This document describes the *core primitives* — the procedures built
into the Godot Lisp itself — and the *prelude*, a small amount of Lisp
evaluated at startup. Together they are the language's standard library,
independent of the editor: they would be present in any program written
in this Lisp. The spec's own overview of the standard library is
`docs/spec/lisp.md` §10.

- The primitives are defined in `packages/lisp/src/primitives.js`
  (JavaScript) and installed into the *base* environment at startup.
  The global environment — where the REPL and your own `define`s live —
  is a child of the base, which is why a user definition can shadow a
  primitive, and why modules (each another child of the base) get
  namespaces of their own.
- Three of them — `eval`, `macroexpand-1` and `macroexpand` — are
  defined in `packages/lisp/src/interpreter.js` instead, because they
  must close over the global environment. That is also *why* `eval`
  sees only global bindings.
- The prelude is defined in `packages/lisp/src/interpreter.js` as a
  string of Lisp, evaluated once the primitives are in place.

For the editor's own procedures — commands, buffer operations — see
`commands.md` and `buffer-primitives.md`. For the language's
*special forms* (`define`, `lambda`, `if`, `let`, `defmacro`, …), which
are not procedures and so not listed here, see `docs/spec/lisp.md` §4.

Conventions (see `index.md`): predicates end in `?`; conversions are
written `from->to`; a trailing `…` marks a variadic procedure; a
bracketed argument is optional. The primitives raise a `LispError` on a
type or arity mismatch. One further convention deserves stating up
front — the *miss convention*: where a lookup can fail (`get`, `doc`,
`where-defined`), absence is `#f`, the language's only falsy value, so
a bare `(if (get m k) …)` test is safe. `nil` would not do as a miss
value: `nil` is truthy here.

---

### Constants

:::function{name="nil" aliases="true false" path="reference/lisp-core/nil.html"}
#### `nil`, `true`, `false`

`nil` is the empty list — also the editor's "no value". `true` and
`false` are the booleans, equal to the reader's `#t` and `#f`. Only
`#f` is false; `nil`, `0` and `""` are all truthy (`docs/spec/lisp.md`
§3).
:::

### Arithmetic

:::function{name="+" aliases="*" path="reference/lisp-core/%2B.html"}
#### `+` / `*`
`(+ x …)` / `(* x …)`

Sum and product of the arguments. `(+)` is `0`, `(*)` is `1`.
:::

:::function{name="-" path="reference/lisp-core/-.html"}
#### `-`
`(- x …)`

With one argument, negation; with more, left-to-right subtraction.
:::

:::function{name="/" path="reference/lisp-core/%2F.html"}
#### `/`
`(/ x …)`

With one argument, reciprocal; with more, left-to-right division.
Raises an error on division by zero.
:::

:::function{name="mod" aliases="quotient remainder" path="reference/lisp-core/mod.html"}
#### `mod` / `quotient` / `remainder`
`(mod a b)` / `(quotient a b)` / `(remainder a b)`

`mod` is the result with the sign of the divisor (always non-negative
for a positive `b`); `quotient` is truncating integer division;
`remainder` keeps the sign of the dividend. `mod` signals an error
(`mod: division by zero`) when `b` is zero.
:::

:::function{name="abs" path="reference/lisp-core/abs.html"}
#### `abs`
`(abs x)`

Absolute value.
:::

:::function{name="min" aliases="max" path="reference/lisp-core/min.html"}
#### `min` / `max`
`(min x …)` / `(max x …)`

Least and greatest of the arguments.
:::

:::function{name="inc" aliases="dec" path="reference/lisp-core/inc.html"}
#### `inc` / `dec`
`(inc x)` / `(dec x)`

`x` plus one / minus one.
:::

:::function{name="expt" path="reference/lisp-core/expt.html"}
#### `expt`
`(expt base power)`

`base` raised to `power`.
:::

:::function{name="sqrt" path="reference/lisp-core/sqrt.html"}
#### `sqrt`
`(sqrt x)`

Square root.
:::

:::function{name="floor" aliases="ceiling round" path="reference/lisp-core/floor.html"}
#### `floor` / `ceiling` / `round`
`(floor x)` / `(ceiling x)` / `(round x)`

`x` as an integer: `floor` rounds down, `ceiling` rounds up, `round`
to the nearest integer. Halves round *up* (towards +∞) — `(round 2.5)`
is `3` and `(round -2.5)` is `-2` — not Scheme's round-to-even.
:::

:::function{name="random" path="reference/lisp-core/random.html"}
#### `random`
`(random)` / `(random n)`

With no argument, a random real in the interval [0, 1); with `n`, a
random integer in [0, n). Each call draws afresh.
:::

### Numeric comparison

:::function{name="=" aliases="< > <= >=" path="reference/lisp-core/%3D.html"}
#### `=` `<` `>` `<=` `>=`
`(= x …)`, `(< x …)`, `(> x …)`, `(<= x …)`, `(>= x …)`

Chained numeric comparison: true when every adjacent pair is in the
given relation. `(< 1 2 3)` is true. Numbers only — for general
equality use `equal?`.
:::

### Type predicates

:::function{name="nil?" aliases="pair? list?" path="reference/lisp-core/nil%3F.html"}
#### `nil?` `pair?` `list?`
`(nil? x)` `(pair? x)` `(list? x)`

`nil?` — the empty list; `pair?` — a cons cell; `list?` — `nil` or a
proper (`nil`-terminated) chain of pairs.
:::

:::function{name="number?" aliases="string? symbol? keyword? boolean? procedure? vector? map?" path="reference/lisp-core/number%3F.html"}
#### `number?` `string?` `symbol?` `keyword?` `boolean?` `procedure?` `vector?` `map?`
`(number? x)` … `(map? x)`

True when `x` is of the named type. `procedure?` is true for
primitives and closures, but *not* for macros — a macro is a source
transformer, not a value you can call, and `procedure?` reflects that:
`(procedure? when)` is `#f`. (`describe` still classifies one, as
`:macro`.)
:::

:::function{name="zero?" aliases="positive? negative? even? odd?" path="reference/lisp-core/zero%3F.html"}
#### `zero?` `positive?` `negative?` `even?` `odd?`
`(zero? x)` … `(odd? x)`

Numeric predicates on a single number.
:::

:::function{name="empty?" path="reference/lisp-core/empty%3F.html"}
#### `empty?`
`(empty? x)`

True when `x` is empty: `nil`, an empty vector, an empty string, or an
empty map. False for any other value.
:::

### Equality and logic

:::function{name="eq?" path="reference/lisp-core/eq%3F.html"}
#### `eq?`
`(eq? a b)`

Identity equality — JavaScript `===`. True for identical objects, equal
numbers, interned symbols and keywords.
:::

:::function{name="equal?" path="reference/lisp-core/equal%3F.html"}
#### `equal?`
`(equal? a b)`

Deep structural equality — compares the contents of pairs, vectors and
maps recursively.
:::

:::function{name="not" path="reference/lisp-core/not.html"}
#### `not`
`(not x)`

True when `x` is exactly `false`; false for every other value
(including `nil`).
:::

### Pairs and lists

:::function{name="cons" path="reference/lisp-core/cons.html"}
#### `cons`
`(cons head tail)`

A new pair. With a list `tail`, prepends an element.
:::

:::function{name="car" aliases="cdr" path="reference/lisp-core/car.html"}
#### `car` / `cdr`
`(car pair)` / `(cdr pair)`

The head and tail of a pair. Both raise an error on a non-pair.
:::

:::function{name="first" aliases="rest" path="reference/lisp-core/first.html"}
#### `first` / `rest`
`(first x)` / `(rest x)`

Like `car` / `cdr`, but return `nil` for a non-pair rather than
erroring — the gentle accessors.
:::

:::function{name="list" path="reference/lisp-core/list.html"}
#### `list`
`(list x …)`

A list of the arguments.
:::

:::function{name="length" path="reference/lisp-core/length.html"}
#### `length`
`(length x)`

The number of elements in a list, vector or string, or entries in a
map.
:::

:::function{name="append" path="reference/lisp-core/append.html"}
#### `append`
`(append list … tail)`

Concatenate the lists, sharing the final argument as the tail (it need
not be a list — `(append '(1 2) 3)` is the improper list `(1 2 . 3)`).
:::

:::function{name="reverse" path="reference/lisp-core/reverse.html"}
#### `reverse`
`(reverse list)`

The list, reversed.
:::

:::function{name="nth" path="reference/lisp-core/nth.html"}
#### `nth`
`(nth seq i)`

The element of a list or vector `seq` at zero-based index `i`. Errors
when `i` is out of range.
:::

:::function{name="last" path="reference/lisp-core/last.html"}
#### `last`
`(last list)`

The final element of a list, or `nil` when it is empty.
:::

:::function{name="member" path="reference/lisp-core/member.html"}
#### `member`
`(member x list)`

The first sublist of `list` whose head is `equal?` to `x`, or `false`
when `x` is not present: `(member 2 '(1 2 3))` is `(2 3)`. The truthy
result doubles as a "found" flag — `(when (member x xs) …)` is the
membership-test idiom.
:::

### Higher-order procedures

These accept lists *or* vectors for their sequence arguments. What
comes back varies by procedure: `map` and `filter` return lists;
`sort` preserves its input's type; `reduce` returns the fold's
accumulator; `for-each` returns `nil`; `apply` returns whatever `proc`
returns.

:::function{name="apply" path="reference/lisp-core/apply.html"}
#### `apply`
`(apply proc arg … list)`

Call `proc` with the leading arguments followed by the elements of the
final `list`.
:::

:::function{name="eval" path="reference/lisp-core/eval.html"}
#### `eval`
`(eval form)`

Evaluate `form` — a form as data, not a string — in the *global*
environment, wherever the call appears: local bindings at the call
site are invisible to it. Given a symbol, returns its current global
binding, which is how the keymap resolves command *names* afresh on
every keystroke. To evaluate source text, read it first with
`read-string`.
:::

:::function{name="map" path="reference/lisp-core/map.html"}
#### `map`
`(map proc seq …)`

Apply `proc` across one or more sequences in step, collecting the
results. With several sequences, stops at the shortest.
:::

:::function{name="filter" path="reference/lisp-core/filter.html"}
#### `filter`
`(filter pred seq)`

The elements of `seq` for which `pred` does not return `false`.
:::

:::function{name="reduce" path="reference/lisp-core/reduce.html"}
#### `reduce`
`(reduce proc init seq)`

Fold `seq` left-to-right: `(proc (proc init e1) e2) …`.
:::

:::function{name="for-each" path="reference/lisp-core/for-each.html"}
#### `for-each`
`(for-each proc seq)`

Apply `proc` to each element of `seq` for its side effect; returns
`nil`.
:::

:::function{name="sort" path="reference/lisp-core/sort.html"}
#### `sort`
`(sort seq [less?])`

A sorted copy of `seq` — a list or a vector; the result has the
input's type, and the input is untouched. `less?` is a strict
less-than: `(less? a b)` truthy means `a` orders before `b`, and two
elements neither of which orders before the other compare equal. The
sort is *stable* — equal elements keep their input order. When `less?`
is omitted, all-numbers and all-strings sequences sort by `<`;
anything else raises `sort: mixed or unordered elements need a
comparator`. `(sort '(3 1 2) >)` is `(3 2 1)`.
:::

:::function{name="range" path="reference/lisp-core/range.html"}
#### `range`
`(range end)` / `(range start end)` / `(range start end step)`

A list of numbers from `start` (default `0`) up to but excluding
`end`, by `step` (default `1`). A negative step counts down. A zero
step is an error.
:::

### Strings

:::function{name="str" path="reference/lisp-core/str.html"}
#### `str`
`(str x …)`

Concatenate the arguments' display forms into one string — coerces
non-strings (numbers, symbols, …). The everyday string-builder.
:::

:::function{name="string-append" path="reference/lisp-core/string-append.html"}
#### `string-append`
`(string-append s …)`

Concatenate strings. Unlike `str`, every argument must already be a
string — a non-string signals an error.
:::

:::function{name="string-join" path="reference/lisp-core/string-join.html"}
#### `string-join`
`(string-join seq [sep])`

Join the elements of a list or vector into one string, separated by
`sep` (default `""`). Each element is coerced through its display
form, as `str` does: `(string-join '(1 2 3) ", ")` is `"1, 2, 3"`. The
join happens in a single host pass — prefer it to building a long
string element-by-element in Lisp.
:::

:::function{name="string-length" path="reference/lisp-core/string-length.html"}
#### `string-length`
`(string-length s)`

The number of characters in `s`.
:::

:::function{name="substring" path="reference/lisp-core/substring.html"}
#### `substring`
`(substring s start [end])`

The slice of `s` from `start` to `end` (or to the end of the string).
:::

:::function{name="string-upcase" aliases="string-downcase" path="reference/lisp-core/string-upcase.html"}
#### `string-upcase` / `string-downcase`
`(string-upcase s)` / `(string-downcase s)`

`s` with every letter in upper or lower case.
:::

:::function{name="string-capitalize" path="reference/lisp-core/string-capitalize.html"}
#### `string-capitalize`
`(string-capitalize s)`

`s` with the first character of every word upcased and the rest
downcased: `(string-capitalize "hello WORLD")` is `"Hello World"`. A
"word" here is a run of letters, digits or underscores, in any script
(Unicode-aware). Emacs's `capitalize`.
:::

:::function{name="char-word?" path="reference/lisp-core/char-word%3F.html"}
#### `char-word?`
`(char-word? ch)`

Whether `ch` — a one-character string — is a word constituent: a
letter or digit in any script, or an underscore. This is the single
word-character definition the editor's word motion and word selection
share, so a Lisp extension that tests characters with `char-word?`
agrees with cmd(forward-word) about where words end. See
`commands.md` for the word commands themselves.
:::

:::function{name="string-repeat" path="reference/lisp-core/string-repeat.html"}
#### `string-repeat`
`(string-repeat s n)`

`s` concatenated with itself `n` times. `n` is truncated to an
integer; zero or negative gives `""`.
:::

:::function{name="string-split" path="reference/lisp-core/string-split.html"}
#### `string-split`
`(string-split s sep)`

`s` split on every occurrence of the string `sep`, as a list of
substrings.
:::

:::function{name="string-contains?" path="reference/lisp-core/string-contains%3F.html"}
#### `string-contains?`
`(string-contains? s sub)`

True when `s` contains `sub`.
:::

:::function{name="string-index-of" path="reference/lisp-core/string-index-of.html"}
#### `string-index-of`
`(string-index-of s sub [start])`

The zero-based index of the first occurrence of `sub` in `s` at or
after `start` (default `0`), or `-1` when there is none. Note the
not-found value is `-1`, not `false` — and `-1` is truthy.
:::

:::function{name="string-prefix?" aliases="string-suffix?" path="reference/lisp-core/string-prefix%3F.html"}
#### `string-prefix?` / `string-suffix?`
`(string-prefix? prefix s)` / `(string-suffix? suffix s)`

True when `s` starts with `prefix` / ends with `suffix`. Note the
argument order: the affix comes first. `string-suffix?` is what the
mode registry matches filenames with.
:::

:::function{name="read-string" path="reference/lisp-core/read-string.html"}
#### `read-string`
`(read-string s)`

Parse `s` as Lisp source — the reader, exposed to Lisp. Returns a list
of *all* the forms read, unevaluated: `(read-string "(+ 1 2)")` is the
one-element list `((+ 1 2))`. Raises a `LispError` on malformed
source. Pair with `eval`: `(eval (car (read-string s)))`.
:::

:::function{name="string=?" path="reference/lisp-core/string%3D%3F.html"}
#### `string=?`
`(string=? a b)`

True when the strings `a` and `b` are identical. Exactly two
arguments, both strings — unlike `equal?`, which compares strings the
same way but accepts any values.
:::

:::function{name="string->symbol" aliases="symbol->string" path="reference/lisp-core/string-%3Esymbol.html"}
#### `string->symbol` / `symbol->string`
`(string->symbol s)` / `(symbol->string sym)`

Convert between a string and an interned symbol. `symbol->string` also
accepts a keyword — `(symbol->string :tag)` is `"tag"` — though
`keyword->string` is the natural spelling for that.
:::

:::function{name="string->keyword" aliases="keyword->string" path="reference/lisp-core/string-%3Ekeyword.html"}
#### `string->keyword` / `keyword->string`
`(string->keyword s)` / `(keyword->string kw)`

Convert between a string and an interned keyword. The string carries
no leading colon: `(string->keyword "tag")` is `:tag`, and
`(keyword->string :tag)` is `"tag"`.
:::

:::function{name="string->number" path="reference/lisp-core/string-%3Enumber.html"}
#### `string->number`
`(string->number s)`

The number `s` denotes, or `false` when it is not numeric. One
JavaScript inheritance to know: the empty string — and a
whitespace-only string — coerces to `0`, not `false`.
:::

:::function{name="number->string" path="reference/lisp-core/number-%3Estring.html"}
#### `number->string`
`(number->string n)`

The decimal string for the number `n`.
:::

### Vectors

A vector is a fixed JavaScript array; vectors are frozen (immutable).

:::function{name="vector" path="reference/lisp-core/vector.html"}
#### `vector`
`(vector x …)`

A vector of the arguments.
:::

:::function{name="vector-ref" path="reference/lisp-core/vector-ref.html"}
#### `vector-ref`
`(vector-ref v i)`

The element at zero-based index `i`. Errors when `i` is out of range.
:::

:::function{name="vector-length" path="reference/lisp-core/vector-length.html"}
#### `vector-length`
`(vector-length v)`

The number of elements in `v`.
:::

:::function{name="vector->list" aliases="list->vector" path="reference/lisp-core/vector-%3Elist.html"}
#### `vector->list` / `list->vector`
`(vector->list v)` / `(list->vector list)`

Convert between a vector and a list.
:::

### Maps

A map is an immutable key-value table. The "mutating" operations return
a *new* map.

Key equality is *identity* (the JavaScript `Map` rule, SameValueZero),
not `equal?`. Numbers, strings, and interned symbols and keywords
behave as you expect; but a list or vector key matches only the very
same object — a structurally-`equal?` copy misses:
`(get (hash-map '(1) 'x) '(1))` is `#f`, because the two `'(1)`s are
distinct pairs. Compare `member`, which does use `equal?`. Keyword
keys are the idiom.

:::function{name="hash-map" path="reference/lisp-core/hash-map.html"}
#### `hash-map`
`(hash-map k v …)`

A map from alternating key/value arguments. The map literal `{…}` is
sugar for this. Signals an error on an odd number of arguments.
:::

:::function{name="get" path="reference/lisp-core/get.html"}
#### `get`
`(get coll key [fallback])`

The value for `key` in a map, or the element at zero-based index `key`
in a vector. When the key or index is absent, returns `fallback` —
default `#f`, per the miss convention, so a bare `(if (get m k) …)`
test is safe. The three-argument form returns its fallback unchanged:
use it when a stored `#f` (or any other sentinel) must be
distinguishable from a missing key. Signals an error when `coll` is
neither a map nor a vector.
:::

:::function{name="assoc" path="reference/lisp-core/assoc.html"}
#### `assoc`
`(assoc map key value)`

A copy of `map` with `key` set to `value`.
:::

:::function{name="dissoc" path="reference/lisp-core/dissoc.html"}
#### `dissoc`
`(dissoc map key)`

A copy of `map` with `key` removed.
:::

:::function{name="contains?" path="reference/lisp-core/contains%3F.html"}
#### `contains?`
`(contains? map key)`

True when `map` has an entry for `key`. Maps only — unlike `get`, it
does not accept a vector; anything else signals an error.
:::

:::function{name="keys" aliases="vals" path="reference/lisp-core/keys.html"}
#### `keys` / `vals`
`(keys map)` / `(vals map)`

The keys / values of `map`, as a list.
:::

### Symbols

:::function{name="gensym" path="reference/lisp-core/gensym.html"}
#### `gensym`
`(gensym [prefix])`

A fresh, *uninterned* symbol — `prefix` (default `g`) plus a counter,
never `eq?` to any symbol the reader produces. Two symbols can print
alike yet differ: `(eq? (gensym "g") 'g__1)` is `#f` even when the
gensym happens to print as `g__1`, because the reader's `g__1` is
interned and the gensym is not. Use it for names introduced by a
macro, since macros are not hygienic in v0 (`docs/spec/lisp.md` §5).
:::

### Output

These write to a *host-provided* sink — the `write` option of
`createInterpreter` (`packages/lisp/src/interpreter.js`), which
defaults to discarding output. In the running editor that default is
what you get: the server's single interpreter is created with a
discard sink, so `print` and friends produce nothing visible, and the
REPL echoes only the *value* each expression evaluates to. To see
something in the REPL, make it the result — return the value rather
than printing it. An embedding of the language elsewhere can, of
course, wire the sink wherever it likes.

:::function{name="display" path="reference/lisp-core/display.html"}
#### `display`
`(display x)`

Write `x` in its human-readable display form (a string is written
without quotes).
:::

:::function{name="write" path="reference/lisp-core/write.html"}
#### `write`
`(write x)`

Write `x` in its machine-readable form (a string is written *with*
quotes and escapes) — the form the reader could read back.
:::

:::function{name="newline" path="reference/lisp-core/newline.html"}
#### `newline`
`(newline)`

Write a line break.
:::

:::function{name="print" aliases="println" path="reference/lisp-core/print.html"}
#### `print` / `println`
`(print x …)` / `(println x …)`

Write the arguments' display forms, space-separated. `println` adds a
trailing newline.
:::

### Errors

:::function{name="error" path="reference/lisp-core/error.html"}
#### `error`
`(error message irritant …)`

Signal an error: raise a `LispError` carrying `message` and any
`irritant` values. Caught by `(try … (catch e …))`, where `e` is bound
to a condition map with `:message` and `:irritants` (`docs/spec/lisp.md`
§7). When the error carries a source location the map also has `:line`
and `:column` — what a handler needs to report *where* a failure
happened, not just what it said.
:::

### Introspection

The editor's "explain itself" principle (`docs/spec/lisp.md` §11).
See also `commands.md` — `describe-key`, `describe-command` — for the
interactive surface, and the in-app manual (cmd(open-manual), on
`C-h d`, and cmd(open-doc)), which renders these very entries inside
the editor.

:::function{name="identity" path="reference/lisp-core/identity.html"}
#### `identity`
`(identity x)`

`x`, unchanged. Useful as a default transform.
:::

:::function{name="type-of" path="reference/lisp-core/type-of.html"}
#### `type-of`
`(type-of x)`

A keyword naming `x`'s type — `:number`, `:string`, `:pair`, and so on.
:::

:::function{name="doc" path="reference/lisp-core/doc.html"}
#### `doc`
`(doc proc)`

The docstring of a procedure defined with `define`, or `#f` when
there is none — including for any primitive (the miss convention). A
procedure's docstring is the leading string literal in its body.
:::

:::function{name="where-defined" path="reference/lisp-core/where-defined.html"}
#### `where-defined`
`(where-defined proc)`

The `"line:col"` a procedure was defined at, or `#f` for a primitive
or a procedure with no recorded source (the miss convention).
:::

:::function{name="describe" path="reference/lisp-core/describe.html"}
#### `describe`
`(describe x)`

A map describing `x`: its `:kind`, and — for a user-defined procedure
— its `:name`, `:params`, `:doc` and `:defined-at`. `:kind` is one of
`:procedure`, `:primitive`, `:macro` or `:value`; a primitive or a
macro gets just `:kind` and `:name`, and any other value gets `:kind`
plus its `:type`. The structured form behind the `describe-command`
command.
:::

:::function{name="macroexpand-1" path="reference/lisp-core/macroexpand-1.html"}
#### `macroexpand-1`
`(macroexpand-1 form)`

Expand `form` one step, as data — nothing is evaluated. If `form` is a
list whose head symbol names a macro in the *global* environment, the
transformer is applied to the unevaluated argument forms and the
resulting form returned; anything else — an atom, a special form, a
procedure call — comes back unchanged. Expansion looks only at the
head: macro uses nested in argument positions stay folded.
:::

:::function{name="macroexpand" path="reference/lisp-core/macroexpand.html"}
#### `macroexpand`
`(macroexpand form)`

`macroexpand-1` repeated until the result's head no longer names a
macro. Capped at 1000 steps, after which it raises `macroexpand:
expansion did not terminate` — so a macro that expands to itself
cannot hang the editor.
:::

---

## The prelude

The prelude is a little Lisp evaluated at startup, on top of the
primitives — defining the common control macros in Lisp dogfoods the
macro system. It is in `packages/lisp/src/interpreter.js`.

### Control-flow macros

Both are built from the `if` special form.

:::function{name="when" path="reference/lisp-core/when.html"}
#### `when`
`(when test body …)` — *macro*

Evaluate `body` in sequence when `test` is truthy; otherwise `nil`. An
`if` with no else branch and an implicit `begin`.
:::

:::function{name="unless" path="reference/lisp-core/unless.html"}
#### `unless`
`(unless test body …)` — *macro*

Evaluate `body` in sequence when `test` is *false*y; otherwise `nil`.
The complement of `when`.
:::

### Iteration macros

Loops for side effects — all three return `nil`. Each use expands to a
`letrec`-bound procedure whose self-call sits in tail position, so a
million iterations run in constant stack; the loop's name is a gensym,
so it cannot capture a caller binding.

:::function{name="while" path="reference/lisp-core/while.html"}
#### `while`
`(while test body …)` — *macro*

Evaluate `body` repeatedly for as long as `test` — re-evaluated before
each pass — is truthy. Possibly zero passes.
:::

:::function{name="dotimes" path="reference/lisp-core/dotimes.html"}
#### `dotimes`
`(dotimes var count body …)` — *macro*

Evaluate `body` with `var` bound to `0`, `1`, … `count - 1` in turn.
`count` is evaluated once, before the loop.
:::

:::function{name="dolist" path="reference/lisp-core/dolist.html"}
#### `dolist`
`(dolist var lst body …)` — *macro*

Evaluate `body` with `var` bound to each element of the list `lst` in
order. `lst` is evaluated once. Lists only — for a vector, use
`for-each` (or `vector->list` first).
`(let ((sum 0)) (dolist x '(1 2 3) (set! sum (+ sum x))) sum)` is `6`.
:::

### List accessors

Composed `car`/`cdr` accessors, read inside-out as usual.

:::function{name="caar" aliases="cadr caddr cddr" path="reference/lisp-core/caar.html"}
#### `caar` / `cadr` / `caddr` / `cddr`
`(caar p)` `(cadr p)` `(caddr p)` `(cddr p)`

`caar` — the head of the head; `cadr` — the second element; `caddr` —
the third element; `cddr` — the list with its first two elements
dropped.
:::

:::function{name="second" aliases="third" path="reference/lisp-core/second.html"}
#### `second` / `third`
`(second list)` / `(third list)`

The second and third elements of a list — readable names for `cadr`
and `caddr`.
:::

### Sequence predicates

Strict booleans (the `?` convention), short-circuiting. `seq` may be a
list or a vector.

:::function{name="any?" path="reference/lisp-core/any%3F.html"}
#### `any?`
`(any? pred seq)`

Whether `(pred x)` is truthy for *some* element of `seq`. Stops at the
first truthy result; `#f` on an empty sequence.
:::

:::function{name="every?" path="reference/lisp-core/every%3F.html"}
#### `every?`
`(every? pred seq)`

Whether `(pred x)` is truthy for *every* element of `seq`. Stops at
the first false result; vacuously `#t` on an empty sequence.
:::
