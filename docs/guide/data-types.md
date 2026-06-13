## Lisp Data Types

Every value in jmacs Lisp is one of a small number of types: numbers,
strings, booleans, symbols, keywords, pairs, vectors, maps, and
procedures — plus `nil`, a type with exactly one member. This chapter
is the inventory: for each type, the syntax you write, the object you
get, the way it prints back — and, along the way, the three questions
that trip up newcomers from other Lisps: what is true, what is equal
to what, and what you can mutate. The next chapter, *The Evaluation
Model*, explains what the evaluator *does* with these values.

### Reading and Printing Lisp Values

A Lisp program is made of the same stuff as Lisp data. The *reader*
turns text into values — each type below has a literal syntax it
recognises — and the *printer* turns values back into text, in one of
two forms. The *written* form is re-readable: strings come back
quoted, with `\n`, `\t`, `\r`, `\"` and `\\` escaped. The *display*
form is for humans: strings appear raw, everything else prints the
same. The `write` primitive uses the first; `display`, `print`, and
`str` use the second. Every type in this chapter except procedures
round-trips — reading its written form gives an equal value back.
Examples show written results in a trailing comment marked `; ⇒`.

One more thing the reader does quietly: it records the line and column
of every *list form* it reads (atoms, vectors, and maps carry no
positions) — that is where `where-defined` and `describe` get a
procedure's `:defined-at` position.

### Numbers and Numeric Behaviour

There is one numeric type. Integers and floats are not distinct: every
number is an IEEE double (the host's JavaScript number), so `1` and
`1.0` are the same value, integers are exact up to 2^53, and familiar
floating-point behaviour applies. Literals: `42`, `-3.5`, `+7`, `1e3`,
`.5`, `42.`. There is no radix syntax and no rationals — `0x10` and
`1/2` read as *symbols*, not numbers — and `NaN` and `Infinity` are
not literals either, though both can arise as results. A whole-number
result prints without a decimal point.

```lisp
(/ 7 2)          ; ⇒ 3.5 — division is real division
(/ 2)            ; ⇒ 0.5 — one argument takes the reciprocal
(/ 1 0)          ; error: division by zero
(+ 0.1 0.2)      ; ⇒ 0.30000000000000004 — doubles, honestly
(mod -1 3)       ; ⇒ 2 — sign follows the divisor
(remainder -1 3) ; ⇒ -1 — sign follows the dividend
(quotient 7 2)   ; ⇒ 3 — truncating integer division
(expt 2 10)      ; ⇒ 1024
```

`/` checks every divisor and raises `division by zero`; `quotient` and
`remainder` do not — `(quotient 1 0)` is `Infinity`, `(remainder 1 0)`
is `NaN`, the host arithmetic showing through, and `(sqrt -1)` is
`NaN`. The comparisons `=`, `<`, `>`, `<=`, `>=` take any number of
arguments and test the whole chain — `(< 1 2 3)` is `#t` — and apply
only to numbers. The rest of the catalog (`abs`, `min`, `max`, `inc`,
`dec`, `floor`, `ceiling`, `round`, `random`) is in the
<a href="nodes/jmacs-core-lisp-reference.html" data-jmacs-doc="jmacs-core-lisp-reference">Core Lisp Reference</a>.

### Strings and Their Escapes

A string literal is double-quoted: `"hello"`. Six escapes are
recognised — `\n`, `\t`, `\r`, `\0`, `\\`, `\"`; a backslash before
any other character simply yields that character (`"\q"` is `"q"`),
and there is no `\u` or `\x` notation. A raw newline inside the quotes
is legal, so multi-line strings need no special syntax. Strings are
immutable, and there is no character type: the unit of string work is
the substring, and `substring` has slice semantics — negative indices
count from the end, out-of-range indices clamp silently.

```lisp
(string-length "jmacs")    ; ⇒ 5
(substring "jmacs" 1 3)    ; ⇒ "ma"
(substring "jmacs" -3)     ; ⇒ "acs" — negative counts from the end
(str "line 1" "\n" 42)     ; ⇒ "line 1\n42"
```

The string procedures in summary — each has a full entry in the
reference's <a href="nodes/strings.html" data-jmacs-doc="strings">string section</a>:

| Procedures | Purpose |
|---|---|
| `str`, `string-append`, `string-join`, `string-repeat` | Building — `str` display-coerces anything; `string-append` insists on strings |
| `string-length`, `substring` | Measuring and slicing |
| `string-upcase`, `string-downcase` | Case |
| `string-split` | String to list of substrings |
| `string-contains?`, `string-prefix?`, `string-suffix?`, `string-index-of`, `string=?` | Searching and testing |
| `read-string` | String to Lisp forms, unevaluated |

Two conventions to memorise: `string-prefix?` and `string-suffix?`
take the *affix first* — `(string-prefix? "jm" "jmacs")` — and
`string-index-of` answers `-1` when the needle is absent, not `#f`.

### Booleans, True and False

The booleans are written `#t` and `#f`, with the long forms `#true`
and `#false` accepted as synonyms; all print as `#t` and `#f`. The
names `true` and `false` are also bound as ordinary variables to the
same two values, so `(eq? true #t)` is `#t`. Which values *count* as
true in a test is settled in the section on `nil` below.

### Symbols and Interning

A *symbol* is a name as a value. The token rule is liberal: a symbol
is any run of characters that is not whitespace and not one of the
delimiters — the brackets, `"`, `;`, and the quote and unquote
characters — so `+`, `set!`, `view-list!`, `string->symbol`, and even
`a:b` are single symbols. Symbols are *interned*: the reader hands out one object per
name, ever, so two symbols that look alike *are* the same object and
identity comparison is name comparison.

```lisp
(eq? 'apple 'apple)                    ; ⇒ #t — one interned object
(eq? (string->symbol "apple") 'apple)  ; ⇒ #t — interning again
```

A symbol prints as its name. Evaluating one looks up the variable it
names — which is why these examples quote them (*The Evaluation
Model*). The one exception to interning is `gensym`, which makes a
fresh *uninterned* symbol, never `eq?` to anything the reader
produces even with the same printed name; its use belongs to
*Writing Macros*.

### Self-Evaluating Keywords

A token starting with a colon — `:name`, `:on-enable` — is a
*keyword*. Keywords are interned like symbols, but unlike symbols they
are *self-evaluating*: `:name` evaluates to `:name`, no quote needed.
That suits their two jobs: map keys, where interning means a keyword
always matches itself (which matters, given how map lookup works
below), and option markers in editor-facing forms — the `:name` and
`:keymap` of a `define-mode`, the `:doc` of a `defcustom` — where a
literal tag is wanted and quoting would be noise.

```lisp
:title                        ; ⇒ :title — evaluates to itself
(eq? :title :title)           ; ⇒ #t
(get {:title "Emma"} :title)  ; ⇒ "Emma"
```

Keywords are not callable — `(:title m)` is an error, not a lookup —
and the bare colon `:` is a symbol, not a keyword (`::a`, for
completeness, is the keyword named `:a`).

### Pairs, Lists, and Dotted Pairs

The *pair* (or *cons cell*) is the structure Lisp is named for: one
object with two slots, built by `cons` and taken apart by `car` (the
head) and `cdr` (the tail). A *proper list* is a chain of pairs whose
final tail is `nil`; `(1 2 3)` is shorthand for exactly that chain. A
pair whose tail is not a list prints — and can be written — in
*dotted* notation: `(1 . 2)`. The dot is recognised only inside
parentheses, not in vectors or maps.

```lisp
(cons 1 2)             ; ⇒ (1 . 2)
(cons 1 (cons 2 nil))  ; ⇒ (1 2) — a list is just this chain
(list 1 2 3)           ; ⇒ (1 2 3)
(car '(1 2 3))         ; ⇒ 1
(cdr '(1 2 3))         ; ⇒ (2 3)
(append '(1 2) '(3 4)) ; ⇒ (1 2 3 4)
(append '(1) 2)        ; ⇒ (1 . 2) — the last argument becomes the tail
```

`car` and `cdr` insist on a pair; their total cousins `first` and
`rest` return `nil` for anything else instead of erroring. The prelude
adds the compositions `caar`, `cadr`, `caddr`, `cddr` and the readable
`second` and `third` — `(second '(a b c))` is `b`. Pairs are frozen at
construction — there is no `set-car!` or `set-cdr!`; every list
operation that seems to change a list builds a new one. The rest of
the toolkit (`length`, `reverse`, `nth`, `last`, `member`) lives in
the reference's
<a href="nodes/pairs-and-lists.html" data-jmacs-doc="pairs-and-lists">pairs and lists section</a>.

### Vectors in Square Brackets

A *vector* is a fixed-length, immutable, indexable sequence, written
in square brackets. Where a list is a chain of pairs, a vector is one
flat block — constant-time indexing, no sharing of tails.

```lisp
[1 2 3]                    ; ⇒ [1 2 3]
(vector 1 2)               ; ⇒ [1 2]
(vector-ref [10 20 30] 1)  ; ⇒ 20 — zero-based, bounds-checked
(vector-length [1 2 3])    ; ⇒ 3
```

Vectors are frozen when built; no vector mutation exists. The sequence
functions are even-handed: `map`, `filter`, `nth`, `get`, and `length`
accept a vector as readily as a list (though `map` and `filter` always
return lists), and `vector->list` / `list->vector` convert. One
caution: an unquoted vector literal *evaluates its elements* — see
*Quoting Literal Data* below.

### Maps in Curly Braces

A *map* associates keys with values, written as braces around an even
number of forms: `{:a 1 :b 2}`. Insertion order is preserved — it is
the order entries print, and the order `keys` and `vals` report. Like
vectors, an unquoted map literal evaluates its contents — both keys
*and* values. The map operations never mutate: `assoc` and `dissoc`
return a new map. `hash-map` is the procedural constructor. A `get` with
no fallback answers a missing key with `#f` — absence is `#f` here, the
library's miss convention (set out under `nil`, below) — so supply the
third argument when a stored `#f` must be told apart from a miss.

```lisp
(get {:a 1} :a)        ; ⇒ 1
(get {:a 1} :c)        ; ⇒ #f — a miss with no fallback is #f, not nil
(get {:a 1} :c 0)      ; ⇒ 0 — the third argument is the fallback
(assoc {:a 1} :b 2)    ; ⇒ {:a 1 :b 2} — a copy; the original survives
(keys {:a 1 :b 2})     ; ⇒ (:a :b)
```

#### Map Keys Compare by Identity

Map lookup matches keys by *identity*, not by structure. For the key
types you will normally use this is invisible: keywords and symbols
are interned, and numbers, strings, and booleans compare by value, so
all of them behave exactly as you expect. But a *composite* key — a
list or a vector — matches only the very object that was stored, never
a reconstruction of it:

```lisp
(define m {(list 1 2) "found"})
(get m (list 1 2))   ; ⇒ #f — a fresh (1 2) is a different object, so a miss
(define k (list 1 2))
(get {k "found"} k)  ; ⇒ "found" — the same object matches
```

The same rule shows up in structural equality: `equal?` compares map
*values* deeply but looks keys up by identity, so two maps built with
structurally-equal list keys are not `equal?`. The advice is simple:
key your maps with keywords, symbols, strings, or numbers; if you need
a composite key, hold on to the key object itself.

### Procedures as Values

Procedures are ordinary values: a `lambda` or `define`d function and a
built-in primitive can both be passed as arguments, stored in maps,
returned from functions, and bound to new names; `procedure?` answers
`#t` for both (and `#f` for macros, a different kind of thing). A
procedure prints as `#<procedure name>` — or `#<primitive name>` — a
form the reader cannot read back. How procedures capture their
surroundings is the subject of *Functions and Closures*.

### nil, the Empty List — and Why It Is True

`nil` is the empty list. It is a singleton: the literal `()` is it,
quoted or not; the name `nil` is bound to it; the tail of every proper
list ends at it; and it prints as `nil`. It doubles as the language's
"no value" — the result of an `if` with no else branch, of a `cond`
with no matching clause. The predicate for it is `nil?` (there is no
`null?` in this Lisp); `empty?` is the broader test, true of `nil` and
of empty strings, vectors, and maps alike.

Now the rule this section exists to make prominent:

> *Only `#f` is false. Every other value — `nil` included, and `0`,
> and `""` — is true.*

If you arrive from Emacs Lisp or Common Lisp, where `nil` and false
are the same thing, this is the single fact most worth internalising:
an empty list does not fail a test. The idiom that follows is to test
lists with <a href="reference/lisp-core/nil%3F.html" data-jmacs-doc="nil?">nil?</a>,
never by truthiness.

```lisp
(if '() "yes" "no")      ; ⇒ "yes" — nil is true
(not nil)                ; ⇒ #f — nil is not false
(if 0 "zero" "no")       ; ⇒ "zero"
(if (nil? '()) "empty" "items")  ; ⇒ "empty" — the right test
```

The library leans on this rule through one convention worth learning
once: **absence is `#f`, emptiness is `nil`**. A lookup that finds
*nothing there* — `get` with no fallback, `member`, `string->number`,
`doc`, `where-defined`, `find-view`, `mark` when unset, the search
primitives — returns `#f`, so it is safe as a bare `if`. A function that
returns *the empty thing* keeps `nil`: `(first '())` is `nil`, because
the first of nothing is nothing. So test a possible miss bare and a
possible emptiness with `nil?`; the two are different questions. (One
corner the rule creates: `(nil? #f)` is `#f`, so `nil?` does *not*
detect a `#f` miss — *Lisp Style and Pitfalls* recaps that trap.)

### Three Kinds of Equality

jmacs Lisp has two general equality predicates and one numeric one.
<a href="reference/lisp-core/eq%3F.html" data-jmacs-doc="eq?">eq?</a>
is *identity*: are these the same object? Because numbers, strings,
and booleans are host primitives, identity on them is value equality;
because symbols and keywords are interned, identity on them is name
equality; pairs, vectors, maps, and procedures are equal only to
themselves.
<a href="reference/lisp-core/equal%3F.html" data-jmacs-doc="equal?">equal?</a>
is *structural*: it recurses into pairs (head and tail), vectors
(elementwise), and maps (same size, values compared deeply — but keys
looked up by identity, as above); everything else falls back to
identity. `=` compares numbers only, and errors on anything else.

| `a` | `b` | `(eq? a b)` | `(equal? a b)` |
|---|---|---|---|
| `'foo` | `'foo` | `#t` | `#t` |
| `"ab"` | `"ab"` | `#t` | `#t` |
| `1` | `1.0` | `#t` | `#t` |
| `'(1 2)` | `'(1 2)` | `#f` | `#t` |
| `{:a '(1)}` | `{:a '(1)}` | `#f` | `#t` |
| `{'(1) :a}` | `{'(1) :a}` | `#f` | `#f` |
| `nil` | `#f` | `#f` | `#f` |

(Each quoted literal is read fresh, hence the `#f`s in the `eq?`
column for compound data.) The last row bears repeating: `nil` and
`#f` differ under every predicate. One numeric corner: a `NaN` — from
`(sqrt -1)`, say — is not `=`, `eq?`, or `equal?` to itself.

### The Type Predicate Catalog

Each type has a predicate. All accept any value without erroring,
except the numeric tests at the end, which insist on numbers.

| Predicate | True of |
|---|---|
| `nil?` | the empty list, and nothing else |
| `boolean?`, `number?`, `string?`, `keyword?`, `vector?`, `map?` | values of the eponymous type |
| `symbol?` | symbols — `#f` for keywords |
| `pair?` | any cons cell, proper or dotted |
| `list?` | proper lists — `nil` qualifies, `(1 . 2)` does not |
| `procedure?` | lambdas and primitives — `#f` for macros |
| `zero?`, `positive?`, `negative?` | numbers in the named region (error on non-numbers) |
| `even?`, `odd?` | integer parity (error on non-numbers) |
| `empty?` | `nil`, `""`, `[]`, `{}` — `#f` for everything else |

The companion to the predicates is `type-of`, which names a value's
type as a keyword: `(type-of [1])` is `:vector`, `(type-of nil)` is
`:nil`.

### Converting Between Types

The conversion functions follow the `from->to` naming convention; this
is the complete set:

| Conversion | Example |
|---|---|
| `string->symbol` | `(string->symbol "foo")` ⇒ `foo` — interned |
| `symbol->string` | `(symbol->string 'foo)` ⇒ `"foo"` — also accepts keywords |
| `string->keyword` | `(string->keyword "tag")` ⇒ `:tag` — no colon in the argument |
| `keyword->string` | `(keyword->string :tag)` ⇒ `"tag"` |
| `string->number` | `(string->number "3.5")` ⇒ `3.5` — `#f` when unparseable |
| `number->string` | `(number->string 42)` ⇒ `"42"` |
| `vector->list` | `(vector->list [1 2])` ⇒ `(1 2)` |
| `list->vector` | `(list->vector '(1 2))` ⇒ `[1 2]` |

`string->number` is looser than the reader: it trims whitespace,
accepts hex (`(string->number "0x10")` ⇒ `16`), and — a quirk worth
knowing — maps the empty string to `0`. For everything-to-string there
is `str` — `(str 1 " and " :two)` ⇒ `"1 and :two"` — and
`read-string` converts the other way entirely, from a string to the
list of Lisp forms it contains, unevaluated.

### Quoting Literal Data

Evaluating a list applies a procedure and evaluating a symbol looks up
a variable — so to mean a list or a symbol *as data*, quote it. `'x`
is reader shorthand for `(quote x)`, which returns its argument
untouched.

```lisp
'foo       ; ⇒ foo — the symbol, not the variable's value
'(+ 1 2)   ; ⇒ (+ 1 2) — code held as data, not a call
```

Vectors and maps sit in between: their literals are self-delimiting,
but their *elements evaluate* unless the whole literal is quoted —

```lisp
[1 (+ 1 1)]    ; ⇒ [1 2]
'[1 (+ 1 1)]   ; ⇒ [1 (+ 1 1)] — quoted: elements stay literal
{:n (+ 1 1)}   ; ⇒ {:n 2} — keys and values both evaluate
'{:n (+ 1 1)}  ; ⇒ {:n (+ 1 1)}
```

— which is what makes unquoted map literals pleasant for options whose
values are computed. The full evaluation story, quasiquotation
included, is *The Evaluation Model*.

### What Is Immutable and What Mutates

Nearly everything in this chapter is immutable by construction. Pairs
are frozen the moment `cons` builds them; vectors are frozen when read
or built; strings are immutable outright; symbols and keywords are
frozen and interned. Maps are the one aggregate not literally frozen,
but no mutating map primitive exists — `assoc` and `dissoc` are
copy-on-write — so in practice they might as well be. The payoff:
values can be shared freely; no list you hand to another procedure
comes back changed.

Mutation lives in exactly two places. Bindings: `set!` re-points an
existing variable at a new value, rebinding the name without altering
the old value (*The Evaluation Model*). And the editor itself: the
buffer behind your text is a mutable host object, and primitives like
`insert!` change it in place (*Editing Text from Lisp*). Between those
poles, jmacs Lisp is a language of immutable values flowing through
mutable places.
