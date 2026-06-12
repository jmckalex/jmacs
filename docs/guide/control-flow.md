## Control Flow and Iteration

In jmacs Lisp, control flow is not a set of statements that *do*
things — it is a set of expressions that *are* things. An `if` has a
value, a `cond` has a value, and even a sequence of side effects has a
value: the last one. This chapter walks through every branching
construct the language offers, then turns to the question every
newcomer asks sooner or later — where is the `while` loop? — and
answers it honestly. One rule from *Lisp Data Types* governs
everything below: **only `#f` is false**. `nil`, `0`, and `""` are
all true, and every conditional here tests against that rule and no
other.

### Branching with if

`if` is a special form with two shapes:

```lisp
(if test then)
(if test then else)
```

The evaluation rule: `test` is evaluated first; if its value is
anything but `#f`, the `then` expression is evaluated and its value is
the value of the whole form; otherwise the `else` expression is. The
branch not taken is never evaluated at all — which is why `if` must be
a special form rather than a function. When the `else` is omitted and
the test is false, the form's value is `nil`. Any other shape is an
error: `if: expected (if test then else?)`.

Because `if` is an expression, the idiomatic move is to use its value
directly rather than assigning from inside each branch:

```lisp
(define parity (if (even? 7) :even :odd))
parity                                ; ⇒ :odd

(if 0 "zero is true" "unreachable")   ; ⇒ "zero is true"
```

The second example is the truthiness rule biting for the first time:
`0` is not `#f`, so the first branch wins. Both branches of an `if`
are tail positions, so a function whose result is an `if` can recurse
from either branch in constant stack — *Functions and Closures*
explains what that buys you. Each branch is a single expression; when
one side needs several side effects, wrap them in `begin` (recapped
below), or reach for `when` and `unless`, which exist for this case.

### Multi-Way Choice with cond

When there are more than two ways forward, nesting `if`s gets noisy.
`cond` lays the alternatives out flat:

```lisp
(cond (test body...)
      ...
      (else body...))
```

Clauses are tried in order; the first clause whose test evaluates
truthy wins, and no later test is evaluated. The winning clause's body
is an implicit `begin`: every form runs in order and the last one's
value — evaluated in tail position — is the value of the whole `cond`.
The symbol `else` is recognised literally in the test slot and always
matches. If no clause matches and there is no `else`, the value is
`nil`. (There is no Scheme-style `(test => receiver)` clause syntax.)

```lisp
(define (describe-count n)
  "A human-sized description of a count."
  (cond ((zero? n) "none")
        ((= n 1)   "exactly one")
        ((< n 5)   "a few")
        (else      "many")))

(describe-count 3)   ; ⇒ "a few"
```

> note: **a one-element clause evaluates its test twice.** A clause of
> the form `(expr)` — a test with no body — returns the test's own
> value, but the implementation gets that value by evaluating the
> expression a second time: once for the truth check, once for the
> result. For a pure expression you will never notice. For one with
> side effects, you will:
>
> ```lisp
> (define calls 0)
> (define (next-id)
>   (set! calls (inc calls))
>   calls)
>
> (cond ((next-id)))   ; ⇒ 2 — next-id ran twice
> calls                ; ⇒ 2
> ```
>
> If you mean "this value, or else keep trying", `or` already does
> that with single evaluation. Otherwise bind the value once and test
> the binding — `(let ((v expr)) (if v v fallback))` — or give the
> clause an explicit body. A related edge: a bare `(else)` clause has
> no body to run, so it tail-evaluates the symbol `else` itself and
> throws `unbound symbol: else`.

### Conditional Shorthands: when and unless

`(when test body...)` evaluates its body — any number of forms, an
implicit `begin` — only if the test is truthy, returning the last body
form's value; on a false test it returns `nil` without touching the
body. `(unless test body...)` is the mirror image: its body runs only
when the test is *false*.

```lisp
(when (string-prefix? ";" line)
  (set! comment-count (inc comment-count))
  (println "comment:" line))

(when #t 1 2)            ; ⇒ 2
(unless #f "fallback")   ; ⇒ "fallback"
```

Here is the teaching moment: <a href="reference/lisp-core/when.html" data-jmacs-doc="when">when</a>
and <a href="reference/lisp-core/unless.html" data-jmacs-doc="unless">unless</a>
are **not special forms**. They are ordinary macros, defined in the
interpreter's prelude in a few lines each:

```lisp
(defmacro when (test . body)
  (list 'if test (cons 'begin body)))

(defmacro unless (test . body)
  (list 'if test 'nil (cons 'begin body)))
```

Each use rewrites itself into the `if`-plus-`begin` you would
otherwise write by hand. Nothing about them is built in — and in
*Writing Macros* they return as the first worked examples. Prefer
them over a one-armed `if` whenever the point of the form is its side
effects: they hold several body forms without an explicit `begin`,
and they tell the reader there is deliberately no other branch. When
both outcomes matter — when you are *choosing a value* — use `if`.

### Short-Circuiting with and and or

`and` and `or` are special forms, not functions, because they must be
able to stop early. Both evaluate their operands left to right, and
both return a deciding *value*, not a boolean made from it.

`(and a b ...)` evaluates operands until one is false, returns that
`#f` immediately, and never evaluates the rest; if every operand is
truthy it returns the value of the last one. `(and)` is `#t`.
`(or a b ...)` evaluates operands until one is *truthy* and returns
that value, untouched; if all are false it returns `#f`, as is
`(or)`. In both forms the final operand sits in tail position.

```lisp
(and 1 2 3)    ; ⇒ 3
(and 1 #f 3)   ; ⇒ #f  — 3 never evaluated
(or #f 7 9)    ; ⇒ 7   — 9 never evaluated
```

Returning the value powers two idioms you will meet constantly. The
first is *or as default*: `(or requested-title "untitled")` yields
the fallback when `requested-title` is `#f`, and otherwise passes its
value through unchanged. Mind the truthiness rule, though — only `#f`
triggers the fallback. `nil`, `0`, and `""` sail straight through, so
`(or (get options :indent) 4)` does *not* supply a default: `get`
signals a missing key by returning `nil`, which is true. The right
tool there is `get`'s own fallback argument,
`(get options :indent 4)`.

The second idiom is *and as guard* — establish that a value is safe
to use, then use it, in one expression: `(and (pair? x) (car x))` is
the head of `x`, or `#f` when `x` is not a pair. The `car` is never
reached on the guard's failure, and chains of requirements read the
same way: each link must pass before the next is tried, and the last
link's value is the answer.

### begin for Side Effects

`(begin form...)` evaluates its forms in order and returns the value
of the last, with that last form in tail position; `(begin)` is `nil`.
It exists purely for side effects, and you need it rarely, because
most bodies are already implicit `begin`s — a function body, a `let`
body, a `cond` clause, the body of `when`. Its natural habitat is an
arm of `if`: `(if (even? n) (begin (println "halving") (/ n 2)) n)`
logs on one branch and stays silent on the other. The full story of
sequencing and evaluation order is in *The Evaluation Model*.

### Iterating Without Loops

Now the absence you may have been circling: jmacs Lisp has **no
looping construct**. There is no `while`, no `for`, no `dolist`, no
`loop` — not among the seventeen special forms, not in the prelude,
not in the standard library. This is a design position, not a gap.
Iteration is expressed two ways — higher-order functions over lists,
and recursion in tail position — and both return values while they
work.

#### Mapping, Filtering, and Reducing

The four workhorses are
<a href="reference/lisp-core/map.html" data-jmacs-doc="map">map</a>,
<a href="reference/lisp-core/filter.html" data-jmacs-doc="filter">filter</a>,
<a href="reference/lisp-core/reduce.html" data-jmacs-doc="reduce">reduce</a>, and
<a href="reference/lisp-core/for-each.html" data-jmacs-doc="for-each">for-each</a>
— full signatures in *Functions and Closures* and the reference.

```lisp
(map (lambda (x) (* x x)) '(1 2 3 4))   ; ⇒ (1 4 9 16)
(filter even? (range 10))                ; ⇒ (0 2 4 6 8)
(reduce + 0 '(3 4 5))                    ; ⇒ 12
(for-each println '("one" "two"))        ; prints one, two — ⇒ nil
```

Transformation is `map`; selection is `filter`; collapsing a list to
one value is `reduce` — note its argument order, `(reduce f init
seq)`, with the initial value required and the function receiving
`(acc x)`. `for-each` is `map` for pure side effects: it returns
`nil`. `map` also takes several lists at once, calling the function
with one element from each and stopping at the shortest — the worked
example below leans on that.

#### Counting with range

For index-driven loops — "do this for i from 0 to n" — build the
indices as a list with
<a href="reference/lisp-core/range.html" data-jmacs-doc="range">range</a>
and map over them. Ranges are half-open (the end value is excluded)
and a negative step counts down:

```lisp
(range 4)          ; ⇒ (0 1 2 3)
(range 10 0 -2)    ; ⇒ (10 8 6 4 2)

(map (lambda (i) (* i i)) (range 5))   ; ⇒ (0 1 4 9 16)
```

#### The Tail-Recursive Helper

When no higher-order function fits — the loop's length is unknown, or
each step depends on running state — write a small recursive helper
that carries its state in an *accumulator* parameter:

```lisp
(define (count-matching pred lst)
  "How many elements of lst satisfy pred."
  (define (loop rest n)
    (if (nil? rest)
        n
        (loop (cdr rest)
              (if (pred (car rest)) (inc n) n))))
  (loop lst 0))

(count-matching odd? (range 100))   ; ⇒ 50
```

The shape to internalise: the helper takes the remaining work plus the
answer-so-far; the base case returns the accumulator; the recursive
call is the *entire* result of its branch. That makes it a tail call,
and tail calls run in constant stack — a list of a million elements is
no deeper than a list of three. Had the recursion been buried in an
argument, as in `(+ 1 (loop (cdr rest)))`, the stack underneath would
grow with the list. The precise rules are in *Functions and Closures*;
the working summary is: make the recursive call the whole branch, not
part of an expression.

#### Building a List in Reverse

There is a tension in the helper pattern: `(cons x (loop ...))` builds
the result in order but is not a tail call. The standard resolution is
to cons onto the accumulator — backwards, but in tail position — and
hand the result to
<a href="reference/lisp-core/reverse.html" data-jmacs-doc="reverse">reverse</a>
once at the end:

```lisp
(define (squares-upto n)
  "The first n squares, in order."
  (define (loop i acc)
    (if (= i n)
        (reverse acc)
        (loop (inc i) (cons (* i i) acc))))
  (loop 0 nil))

(squares-upto 5)   ; ⇒ (0 1 4 9 16)
```

One pass to build, one pass to reverse — both in constant stack.

#### A Worked Example: Numbering Lines

The idioms compose. Suppose you want each line of a string prefixed
with its line number — a miniature of what a display routine does.
Split the text into lines with `(string-split s sep)`, pair each line
with its index by mapping over the lines and a `range` of equal
length together, and stitch the result back with
`(string-join seq sep)`:

```lisp
(define (number-lines text)
  "Prefix each line of text with its 1-based line number."
  (let ((lines (string-split text "\n")))
    (string-join
     (map (lambda (i line) (str (inc i) ": " line))
          (range (length lines))
          lines)
     "\n")))

(number-lines "alpha\nbeta\ngamma")
; ⇒ "1: alpha\n2: beta\n3: gamma"
```

No loop variable, no mutation, no off-by-one to defend: the indices
are data, and the two-list `map` walks them in lockstep with the
lines.

### Choosing the Right Construct

| You have | Reach for |
|----------|-----------|
| one test, two outcomes that both matter | `if` |
| one test, side effects on one side only | `when` / `unless` |
| several tests, tried in order | `cond` |
| a value that may be `#f`, plus a fallback | `or` |
| a chain of checks that must all pass | `and` |
| the same operation on every element | `map` |
| keeping only some elements | `filter` |
| collapsing a list to one value | `reduce` |
| a side effect per element | `for-each` |
| a counted, index-driven loop | `range` + `map` |
| anything else — unknown length, evolving state | a tail-recursive helper |

Two neighbouring chapters finish the picture. When a computation can
*fail* rather than merely branch, you want `try` — see *Errors and
Error Handling*. And when you find yourself writing the same control
shape three times, the language lets you name it: *Writing Macros*
shows how `when` was made, and how to make your own.
