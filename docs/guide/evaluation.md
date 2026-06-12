## The Evaluation Model

Everything you do in jmacs Lisp — typing an expression in the REPL,
pressing a key bound to a command, loading `init.lisp` — funnels
through one procedure: the evaluator. It takes a *form* (a piece of
data the reader produced) and an *environment* (a record of what names
currently mean) and computes a value. *Lisp Data Types* described the
data; this chapter describes the rules that turn data into values. The
rules are few, and they compose: predict what the evaluator does with
one form and you can predict what it does with any program.

> *Evaluation is a conversation between a form and an environment: the
> form says what to do, the environment says what the names mean.*

### How a Form Becomes a Value

The evaluator looks at a form's shape and does one of three things.

**Most atoms are self-evaluating.** Numbers, strings, booleans, and
keywords evaluate to themselves: `42` is `42`, `"hi"` is `"hi"`,
`:name` is `:name`. So does `nil` — and since `()` reads as `nil`, the
empty list evaluates to itself rather than raising an error. Procedure
objects also self-evaluate, which matters when a procedure ends up
embedded in a programmatically built form.

**A symbol is a variable reference.** Evaluating `x` looks the name up
in the current environment (how, exactly, is the subject of a later
section) and yields the value bound there. If no binding exists
anywhere, the evaluator raises an error: `unbound symbol: x`.

**A non-empty list is dispatched by its head**, in a fixed priority
order:

1. **Special form.** If the head is a symbol naming one of the
   seventeen *special forms* — `quote`, `quasiquote`, `if`, `define`,
   `lambda`, `defmacro`, `begin`, `set!`, `let`, `let*`, `letrec`,
   `cond`, `and`, `or`, `try`, `module`, `import` — the evaluator runs
   that form's own rule. Special-form names are checked *before* the
   environment is consulted, so they cannot be shadowed: `(define if 3)`
   binds a perfectly ordinary variable named `if`, but `(if …)` still
   dispatches to the special form.
2. **Macro.** Otherwise, if the head is a symbol bound to a macro, the
   macro's transformer is applied to the *unevaluated* argument forms,
   and the form it returns is evaluated in its place, in the caller's
   environment. That is the whole mechanism — macros rewrite code
   before it runs — and *Writing Macros* is devoted to it; for now,
   only its place in the dispatch matters.
3. **Application.** Otherwise the form is a procedure call, described
   next.

Special forms exist because the application rule — evaluate
everything, then act — is wrong for some constructs: `(if test then
else)` must not evaluate both branches, and `(define x 1)` must not
evaluate `x` before it exists. This chapter covers the special forms
that shape evaluation itself; `if` and `cond` are about choosing and
belong to *Control Flow and Iteration*. (Which values count as true
there is a fact about the data — only `#f` is false; `nil`, `0`, and
`""` are all true — see *Lisp Data Types*.)

### Applying a Procedure

When a list falls through to case 3, the rule is:

1. Evaluate the head. It must yield a procedure — anything else raises
   `not a procedure: …`. The head is an expression like any other, so
   it need not be a bare name: `((if #t + *) 2 3)` evaluates its head
   to `+` and yields `5`.
2. Evaluate the argument forms, **left to right**.
3. Apply the procedure to the resulting values.

Step 2 is *applicative order*: every argument is evaluated exactly
once, before the procedure sees anything. The left-to-right order is
guaranteed, which you can observe with a side effect:

```lisp
(define (noisy n)
  (println "evaluating" n)
  n)

(+ (noisy 1) (noisy 2))
; prints evaluating 1
; prints evaluating 2
; ⇒ 3
```

The procedure receives `1` and `2` — values, not expressions. A
procedure can never decline to evaluate an argument; for that you
need a macro.

### Vectors and Maps Evaluate Their Elements

A vector form evaluates each element in place and yields a new vector;
a map form evaluates **both keys and values**:

```lisp
[1 (+ 1 1) (* 3 3)]     ; ⇒ [1 2 9]
{:label (string-upcase "ada")}   ; ⇒ {:label "ADA"}
{(+ 1 1) "two"}          ; ⇒ {2 "two"} — keys evaluate too
```

So the literal you write is really a template that fills itself in.
When you want the elements left alone, quote the whole thing:
`'[1 (+ 1 1)]` is a two-element vector whose second element is a list.

### Environments and Lexical Scope

An *environment* is a chain of *frames*. Each frame is a table mapping
names to values, plus a pointer to the frame that encloses it. Looking
up a symbol walks the chain outward — current frame first, then its
parent, and so on — and the first binding found wins. A binding in an
inner frame therefore *shadows* one of the same name further out;
walking off the end of the chain is what produces `unbound symbol`.

Your top-level definitions live in the *global environment*, whose
parent is a base frame holding the built-in primitives and the
prelude. Three things create a new frame: **applying a procedure**
(the parameters are bound in a fresh frame for that one call), **the
`let` family** (each evaluates its body in a new frame holding the
local bindings), and **`module`** (each module gets its own
environment — the subject of *Modules and Program Structure*).

The crucial rule is *where* a procedure's call frame hangs: its parent
is the environment in which the `lambda` was **written**, not the one
it is called from. This is *lexical scope*, and a procedure carrying
its birthplace around is a *closure*. The classic demonstration:

```lisp
(define (make-counter)
  (let ((count 0))
    (lambda ()
      (set! count (+ count 1))
      count)))

(define tick (make-counter))
(tick)   ; ⇒ 1
(tick)   ; ⇒ 2
(define tock (make-counter))
(tock)   ; ⇒ 1 — a fresh frame, invisible to tick
```

Each call to `make-counter` builds a new `let` frame; the returned
lambda keeps that frame alive and private — no caller can reach
`count` except through it. *Functions and Closures* builds on this;
the point here is that environments are created by evaluation and
connected by where code was written.

### Creating Bindings with define

`define` has two shapes:

```lisp
(define name value)
(define (name params…) docstring? body…)
```

The first evaluates `value` and binds the result to `name` **in the
current frame** — the frame where the `define` itself is evaluated. At
top level that is the global environment; inside a procedure body it
is that call's frame, so the binding is local to the call:

```lisp
(define (mean-of-squares a b)
  (define (sq x) (* x x))   ; bound in this call's frame only
  (/ (+ (sq a) (sq b)) 2))

(mean-of-squares 3 4)   ; ⇒ 12.5
sq                      ; error: unbound symbol: sq
```

Internal defines like `sq` work in any body — `define` is an ordinary
form evaluated in sequence with its neighbours; the binding exists
from the moment the `define` runs, so place it before its uses.

The second shape is shorthand for defining a procedure, and it is the
only place a *docstring* attaches: a leading string literal is
recorded as documentation when at least one more body form follows it
(a function whose entire body is one string just returns the string).

```lisp
(define (square x)
  "Return x multiplied by itself."
  (* x x))     ; ⇒ square
(square 7)     ; ⇒ 49
(doc square)   ; ⇒ "Return x multiplied by itself."
```

Note the return value: `define` returns the **name symbol**, not the
value — which is why the REPL answers a definition with the name you
just defined. Redefinition is permitted and ordinary: a second
`define` of the same name in the same frame simply rebinds it, which
is what makes re-evaluating an edited definition in a live editor
work.

### Assignment with set!

```lisp
(set! name value)
```

`set!` evaluates `value` and assigns it to the **nearest existing
binding** of `name`, walking outward through the frames exactly as
lookup does. It never creates a binding — if the walk finds nothing,
the error is `cannot set! an unbound symbol: name` — and it returns
the value. The contrast with `define` is the heart of it: `define`
makes a new binding *here*; `set!` mutates one that already exists
*somewhere out there*.

```lisp
(define total 0)
(define (add-to-total n)
  (set! total (+ total n)))   ; finds the global total
(add-to-total 5)
total   ; ⇒ 5

(define (shadow-total)
  (define total 99)   ; a NEW binding in this call's frame
  total)
(shadow-total)   ; ⇒ 99
total            ; ⇒ 5 — the global was never touched
```

### The let Family of Binding Forms

Three special forms make local bindings, all with the same shape:

```lisp
(let    ((name value)…) body…)
(let*   ((name value)…) body…)
(letrec ((name value)…) body…)
```

Each binds the names in a new frame, evaluates the body there, and
returns the body's last value (an empty body is `nil`). They differ
only in *which environment the binding values are evaluated in*.

**`let` — simultaneous.** Every `value` is evaluated in the **outer**
environment; then all the names are bound at once. Because the values
cannot see each other, `let` is for independent bindings.

**`let*` — sequential.** Each `value` is evaluated in the **new**
environment, so it sees every binding before it — for bindings that
build on one another. The difference in one example:

```lisp
(define x 1)

(let ((x 2)
      (y x))   ; this x is the OUTER x
  y)           ; ⇒ 1

(let* ((x 2)
       (y x))  ; this x is the let* binding above it
  y)           ; ⇒ 2
```

**`letrec` — mutually recursive.** All the names are bound first
(initially to `nil`), then each `value` is evaluated in the new frame
and assigned. Because every name is already in scope while the values
are computed, lambdas bound by `letrec` can call each other:

```lisp
(letrec ((my-even? (lambda (n) (if (= n 0) #t (my-odd? (- n 1)))))
         (my-odd?  (lambda (n) (if (= n 0) #f (my-even? (- n 1))))))
  (my-even? 10))   ; ⇒ #t
```

(A `letrec` value that reads a sibling *before* it is computed sees
`nil`, not an error — bind procedures, which only look their siblings
up when called.)

### Sequencing with begin

```lisp
(begin form…)
```

`begin` evaluates its forms in order and yields the value of the
**last** one; the earlier values are discarded, so the earlier forms
are there for their effects. `(begin)` is `nil`.

You rarely write `begin`, because most bodies are *implicit* `begin`s
already: a `lambda` or `define` body, the bodies of the `let` family,
a `cond` clause's body, a `try` body and its `catch` handler, and a
`module` body all accept a sequence of forms and return the last. `begin` earns its keep where the grammar allows
exactly one form — a branch of `if`, say — and you need several. The
last form of a `begin` — and of most implicit bodies, though `try`
and `module` are exceptions — sits in *tail position*, which matters
for deep recursion; *Functions and Closures* explains why, and maps
the exceptions.

### Suppressing Evaluation: the Quote Family

Sometimes you want the form itself, not its value. `quote` switches
evaluation off — the apostrophe is reader shorthand, `'x` reading as
`(quote x)` — and the rule is total: nothing inside a quoted form is
evaluated.

```lisp
(quote x)    ; ⇒ x — the symbol, not its value
'(+ 1 2)     ; ⇒ (+ 1 2) — a three-element list, not 3
```

`quasiquote` (backtick) is quote with windows in it. Inside a
quasiquoted template, `,form` (*unquote*) evaluates that one form and
drops the value in, and `,@form` (*unquote-splicing*) evaluates it to
a list and splices the elements in flat:

```lisp
(define n 3)
`(1 2 ,n)            ; ⇒ (1 2 3)
`(1 ,@(list 2 3) 4)  ; ⇒ (1 2 3 4)
```

Quasiquote is how you build a list *around* computed values without a
chain of `cons` and `list` calls. Templates nest, and nesting is
depth-tracked — an inner backtick shields its unquotes until a
matching extra comma unwraps them — but template craft of that order
belongs to *Writing Macros*.

### Walking Through an Evaluation

To close, a complete trace. Take this three-form program:

```lisp
(define base 100)

(define (scale-and-shift x)
  (let ((doubled (* x 2)))
    (+ doubled base)))

(scale-and-shift 5)   ; ⇒ 110
```

The first `define` evaluates `100` (self-evaluating) and binds `base`
in the global frame; the second builds a procedure that remembers the
global environment as its birthplace and binds it to `scale-and-shift`.
Each returns its name symbol. Now the call, step by step:

1. `(scale-and-shift 5)` is a list whose head names neither a special
   form nor a macro, so it is an application: the head evaluates to
   the procedure, the argument `5` to itself.
2. Applying the procedure makes a fresh frame binding `x` to `5`. Its
   parent is the procedure's defining environment — the global frame —
   so the chain is now *call frame → global → base*.
3. The body is one `let`. Its binding value `(* x 2)` is evaluated in
   the outer environment, the call frame — `*` is found in the base
   frame, `x` in the call frame — giving `10`. The `let` makes a
   second new frame binding `doubled` to `10`, hanging off the call
   frame, and evaluates its body there.
4. `(+ doubled base)` is another application. `doubled` is found
   immediately in the `let` frame; `base` misses there, misses in the
   call frame, and is found in the global frame: `100`. The
   application yields `110`.
5. That was the last form of the `let` body, which was the last form
   of the procedure body, so `110` is the value of the call. The two
   inner frames are now unreachable and disappear.

Every evaluation in jmacs is this picture, larger. A form is
dispatched by its shape; names are resolved by walking outward through
frames that mirror the program's written structure; new frames appear
at calls and `let`s and vanish when no closure keeps them. The next
chapter, *Functions and Closures*, looks closely at the objects that
do keep them.
