## Functions and Closures

Procedures are the working material of jmacs Lisp: every command you
bind, every hook you register, every callback a prompt resumes is a
value of one type — a *procedure*, made with `lambda`, carrying the
environment it was created in. This chapter covers how procedures are
written and named, what a closure captures, how calls are checked and
spread, the higher-order toolkit you will use daily, and two facts to
internalise before writing recursive code: tail calls run in constant
stack, and everything shares one namespace. It builds directly on *The
Evaluation Model*; looping constructs belong to *Control Flow and
Iteration*.

### Lambda and Parameter Lists

```lisp
(lambda params body…)
```

Evaluating a `lambda` form builds a procedure: an object pairing the
parameter list and body forms (held unevaluated) with the environment
in force at that moment. The result is a first-class value — pass it to
another procedure, store it in a map, return it — printed as
`#<procedure anonymous>` until a `define` adopts it. At least one body
form is required; `(lambda (x))` is the error
`lambda: expected (lambda params body...)`.

`params` takes three shapes:

```lisp
(lambda (a b c) …)       ; exactly three arguments
(lambda (a b . rest) …)  ; two or more — extras arrive in rest as a list
(lambda args …)          ; any number — the whole argument list binds to args
```

The dotted form declares a *rest parameter*: the names before the dot
are required, and the extras arrive as a fresh proper list (`nil` when
there are none). The bare-symbol form binds the entire argument list to
one name; `()` declares a procedure of no arguments. Parameter names
must be symbols.

A call runs the body as an implicit `begin` — the forms evaluate in
order, and the value of the last is the value of the call:

```lisp
((lambda (a b) (+ a b)) 3 4)   ; ⇒ 7
```

A `lambda` has no docstring slot — in `(lambda (x) "doc" x)` the string
is just a body form, evaluated and discarded. Documentation enters the
language in exactly one place: the `define` shorthand below.

### Defining Named Functions

`define` has two shapes:

```lisp
(define name value)
(define (name params…) docstring? body…)
```

The first evaluates `value` and binds it to `name` in the current
frame. One nicety: a procedure still named `anonymous` takes on the
defined name — after `(define double (lambda (x) (* 2 x)))`, `double`
prints as `#<procedure double>` — but it gains no docstring this way.

The second shape is the function shorthand, and it is how nearly every
procedure in the standard library is written: it builds the lambda,
names it, records where it was defined, and — this is the only position
in the language that attaches documentation — stores a leading string
literal as the docstring:

```lisp
(define (greet name)
  "Return a greeting for NAME."
  (str "Hello, " name "!"))
; ⇒ greet — define returns the name symbol, not the procedure
```

The docstring rule, precisely: a leading string counts as documentation
only when **at least one more body form follows it** — a function whose
entire body is one string has no docstring; it returns that string.
(`defcommand`'s docstring slot, covered in *Commands, Keymaps, and the
Minibuffer*, expands to exactly this shorthand.) The shorthand also
accepts rest parameters — `(define (f a . rest) …)` — and a definition
with no body is the error `define: a function needs a body`.

Finally, `define` is not restricted to the top level: it binds in
whatever frame is current, so a `define` inside a function body is a
local definition private to that call — the local-helper idiom in the
tail-call section depends on this.

### Closures Capture Their Environment

A procedure remembers the environment its `lambda` was evaluated in and
resolves its free variables there *at call time*. That combination —
code plus captured environment — is a *closure*. The classic
demonstration is a function factory:

```lisp
(define (make-adder n)
  "Return a procedure that adds N to its argument."
  (lambda (x) (+ x n)))

(define add3 (make-adder 3))
(add3 10)   ; ⇒ 13
```

Each call to `make-adder` creates a fresh frame binding `n`, and the
returned lambda holds onto that frame long after `make-adder` returns.
The captured environment is live, not a snapshot — `set!` against a
captured binding gives a closure private, persistent state:

```lisp
(define (make-counter)
  "Return a procedure that counts its own calls."
  (let ((count 0))
    (lambda ()
      (set! count (+ count 1))
      count)))

(define tick (make-counter))
(tick)   ; ⇒ 1
(tick)   ; ⇒ 2

(define tock (make-counter))
(tock)   ; ⇒ 1 — a fresh frame, a fresh count
```

`set!` assigns to the nearest existing binding — here the `count` in
the `let` frame the lambda captured, private to each counter.

Late, by-name resolution is also why redefinition works so well in a
live editor: a closure does not bake in the procedures it calls, it
looks each name up when the call happens. Redefine a helper — at the
REPL, or by reloading a module whose environment is reused in place —
and every closure referring to it uses the new definition on its next
call. The full story, including the one stale-snapshot edge around
imported module exports, is in *Modules and Program Structure*.

### Calling Conventions and apply

A call `(f a b …)` evaluates `f` and then the arguments, left to right,
before the procedure runs (*The Evaluation Model* covers the dispatch).
Arity is checked on every call. A fixed parameter list must be matched
exactly: too few or too many arguments raise
`name: expected N argument(s), got M` — so `(greet)` is the error
`greet: expected 1 argument(s), got 0`. A rest parameter sets a floor,
not a ceiling: `name: expected at least N argument(s), got M` when the
parameters before the dot are not all supplied. A procedure that was
never named reports itself as `anonymous`. These are ordinary Lisp
errors, catchable with `try` (*Errors and Error Handling*).

When the arguments you want to pass are already in a list, spread them
with <a href="reference/lisp-core/apply.html" data-jmacs-doc="apply">apply</a>
— `(apply proc arg … list)` calls `proc` with the leading arguments
followed by the elements of the final argument, a proper list:

```lisp
(apply + 1 2 '(3 4))      ; ⇒ 10
(apply max '(3 1 4 1 5))  ; ⇒ 5
```

### The Everyday Higher-Order Toolkit

The natural way to traverse a sequence is to hand a procedure to a
procedure. The core toolkit is deliberately small — five workhorses
beyond `apply`, all accepting lists *or* vectors as sequence arguments,
all returning lists. Their one-page entries live in the core Lisp
reference; this is the teaching tour.

<a href="reference/lisp-core/map.html" data-jmacs-doc="map">map</a> —
`(map proc seq …)` — applies `proc` across one or more sequences in
step, collecting the results:

```lisp
(map (lambda (x) (* x x)) [1 2 3])   ; ⇒ (1 4 9) — a vector in, a list out
(map + '(1 2 3) '(10 20 30 40))      ; ⇒ (11 22 33) — stops at the shortest
```

<a href="reference/lisp-core/filter.html" data-jmacs-doc="filter">filter</a> —
`(filter pred seq)` — keeps the elements for which `pred` does not
return `#f`. Remember the truthiness rule: only `#f` rejects; a
predicate returning `nil` or `0` *keeps* the element.

```lisp
(filter odd? (range 10))   ; ⇒ (1 3 5 7 9)
```

<a href="reference/lisp-core/reduce.html" data-jmacs-doc="reduce">reduce</a> —
`(reduce proc init seq)` — folds left-to-right:
`(proc (proc init e1) e2) …`. The shape is exactly three arguments and
**the initial value is required** — there is no two-argument form that
seeds from the first element. `proc` receives the accumulator first:

```lisp
(reduce + 0 '(1 2 3 4))                              ; ⇒ 10
(reduce (lambda (acc x) (cons x acc)) nil '(1 2 3))  ; ⇒ (3 2 1)
```

<a href="reference/lisp-core/for-each.html" data-jmacs-doc="for-each">for-each</a> —
`(for-each proc seq)` — applies `proc` to each element purely for its
side effects and returns `nil`; use it where `map` would build a result
nobody reads:

```lisp
(for-each println '("one" "two"))   ; prints one, then two; ⇒ nil
```

<a href="reference/lisp-core/range.html" data-jmacs-doc="range">range</a> —
`(range end)`, `(range start end)`, or `(range start end step)` — a
list of numbers from `start` (default `0`) up to but excluding `end`,
by `step` (default `1`). A negative step counts down; a zero step is
the error `range: step must not be zero`.

```lisp
(range 5)         ; ⇒ (0 1 2 3 4)
(range 10 0 -2)   ; ⇒ (10 8 6 4 2)
```

That is the whole catalog: there is no `sort`, no `any`/`every`, no
`vector-map` — what you would reach to those for is usually a short
`reduce` or `filter` away. The complete inventory of sequence
primitives is in the core Lisp reference.

### Tail Calls and Recursion Depth

This Lisp has no loop syntax; iteration is recursion. That is only
comfortable because the interpreter implements proper tail calls: a
call in *tail position* — one whose value becomes the caller's value
with no further work — is bounced through a trampoline instead of
growing the JavaScript stack, so a tail-recursive procedure runs at any
depth, a million iterations and beyond, in constant stack.

The guarantee is positional, so you need the exact list. These are tail
positions:

- the last form of a `lambda` body (and so of a `define`d function);
- both branches of an `if` (the test is not);
- the last form of a `begin`;
- the last body form of `let`, `let*`, and `letrec` (binding value
  expressions are not);
- the body of the chosen `cond` clause;
- the last operand of `and` and of `or`;
- a macro's expansion — tail position survives expansion, so the bodies
  of `when` and `unless` are tail by composition.

And these positions are **not** constant-stack:

- any argument position — `(+ n (f …))`, `(cons x (f …))`,
  `(str line (f …))` all grow the stack by one frame per call;
- the `try` body and `catch` handler (the JavaScript `try`/`catch`
  frame must stay live);
- the `module` body;
- calls routed through `apply`, `map`, `filter`, `reduce`, `for-each`,
  or `eval` — these primitives re-enter the trampoline afresh, so the
  callee's own tail recursion is safe *inside* the call, but looping by
  repeatedly going *through* them accumulates a frame per hop;
  `(apply f …)` in tail position is not a real tail call.

Here is the shape to aim for — the recursive call is the entire `else`
branch, so the stack never grows:

```lisp
(define (sum-to n acc)
  "Sum the integers 1..N onto ACC, in constant stack."
  (if (= n 0)
      acc
      (sum-to (- n 1) (+ acc n))))

(sum-to 1000000 0)   ; ⇒ 500000500000
```

Compare the version a mathematician would write first:

```lisp
(define (sum-to-naive n)
  (if (= n 0)
      0
      (+ n (sum-to-naive (- n 1)))))
```

The recursive call sits in an argument position of `+` — the addition
still has work to do after the call returns, so every level holds a
JavaScript frame open. At moderate depth that is correct and fine; deep
enough, it exhausts the JS stack, a raw JavaScript failure no Lisp
`try` can catch (see *Errors and Error Handling*).

The transformation between the two is mechanical: add an *accumulator*
parameter carrying the work done so far, combine *before* the recursive
call (in the accumulator argument) rather than after it returns, and
return the accumulator in the base case — the recursive call then has
nothing left to do and is the whole branch. To keep the extra parameter
out of your public signature, hide the worker as a local definition:

```lisp
(define (sum-to n)
  "Sum the integers 1..N."
  (define (loop n acc)
    (if (= n 0) acc (loop (- n 1) (+ acc n))))
  (loop n 0))
```

Schemers will look for named `let` here — `(let loop ((n n) (acc 0)) …)`
— and should know it does not exist in this Lisp. The local `define` is
the honest equivalent, and the standard library's own style: a public
function with a private `-helper` or local `loop` carrying the
accumulator.

The trampoline does not care that a tail call is to a *different*
procedure. Mutually recursive definitions — most naturally written with
`letrec`, whose bindings can see each other — are equally safe at
depth, because each crossing call below is the whole branch of its
`if`, a tail position:

```lisp
(letrec ((even-n? (lambda (n) (if (= n 0) #t (odd-n? (- n 1)))))
         (odd-n?  (lambda (n) (if (= n 0) #f (even-n? (- n 1))))))
  (even-n? 100000))   ; ⇒ #t
```

### One Namespace: Values, Procedures, Commands

jmacs Lisp is a Lisp-1: one namespace, in which a name means one thing.
The `f` in `(f x)` is looked up exactly as the variable `f` would be —
no separate function cell, no `funcall`; a procedure is a value that
happens to be callable, which is what makes `(map car pairs)` work
without ceremony.

The same rule has an editor-level consequence you must respect. Host
primitives live in the base environment; your `define`s — and every
`defcommand`, which expands to a `define` — bind in the global
environment, a child of it. Lookup finds the child first: **a command
silently shadows a same-named primitive** for every Lisp caller in the
editor. The standard library's convention keeps the two apart — a
side-effecting opener takes a `!` suffix, leaving the bare name to the
data-returning primitive:

```lisp
(view-list)    ; ⇒ the open views, as data — a host primitive
(view-list!)   ; opens the *View List* panel — a command, hence the !
```

Had the command been named `view-list`, every piece of Lisp that
enumerates views would open the GUI instead of getting its data — and
nothing would warn you. Name your own commands accordingly; the rest
of `defcommand` is in *Commands, Keymaps, and the Minibuffer*.

### Asking a Procedure About Itself

Procedures defined with the `define` shorthand carry their own
documentation and provenance, and three primitives surface them:

- <a href="reference/lisp-core/doc.html" data-jmacs-doc="doc">doc</a> —
  `(doc f)` — the docstring, or `nil` when there is none; always `nil`
  for primitives and macros, since only the shorthand attaches one.
- <a href="reference/lisp-core/where-defined.html" data-jmacs-doc="where-defined">where-defined</a> —
  `(where-defined f)` — the definition site as a `"line:col"` string,
  or `nil`; the position is within whatever source was read — a file's
  line for standard-library code, your submission at the REPL.
- <a href="reference/lisp-core/describe.html" data-jmacs-doc="describe">describe</a> —
  `(describe x)` — a map describing any value:
  `{:kind :procedure :name … :params … :doc … :defined-at …}` for a
  defined procedure (the parameter list dotted when there is a rest
  parameter); `{:kind :primitive :name …}` for a primitive;
  `{:kind :macro :name …}` for a macro; `{:kind :value :type …}` for
  anything else.

A REPL session shows all three at work:

```
λ (define (shout s) "Upcase S, add a bang." (str (string-upcase s) "!"))
shout
λ (doc shout)
"Upcase S, add a bang."
λ (where-defined shout)
"1:1"
λ (describe shout)
{:kind :procedure :name shout :params (s) :doc "Upcase S, add a bang." :defined-at "1:1"}
λ (describe car)
{:kind :primitive :name car}
```

This is the floor under the editor's "explains itself" principle: the
`C-h` help commands described in *Extending jmacs* are built on these
three primitives, so the docstring you write in a `define` today is
what the editor shows back to you tomorrow.
