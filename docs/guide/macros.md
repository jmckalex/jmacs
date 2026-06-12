## Writing Macros

Every special form you have met so far — `if`, `let`, `cond` — earns its
keep the same way: it controls *whether* and *when* its parts are
evaluated, something no function can do. This chapter is about writing
your own. We build up from the idea, through the tools (`defmacro`,
quasiquote, `gensym`), to a ladder of worked examples ending at a real
macro from the editor's standard library — with the two classic traps,
variable capture and multiple evaluation, treated on the way, because
every macro writer falls into both exactly once.

> *A macro does not compute a value; it computes the code that will.*

### A Procedure over Source Forms

A *macro* is a procedure from source forms to a source form. When the
evaluator sees a call whose head names a macro, it does not evaluate the
arguments. Instead it hands the argument forms — the unevaluated lists
and symbols, code as data — to the macro's *transformer*, and the form
the transformer returns (the *expansion*) is evaluated in the original
call's place, in the caller's environment.

To see why that matters, try to write `if` as a function:

```lisp
(define (my-if test then else) (if test then else))

(my-if #t (println "yes") (println "no"))
; prints yes, then no
; ⇒ nil
```

Both branches print: a function's arguments are evaluated before the
function runs, so by the time `my-if` chooses, both `println` calls have
happened, and all it can choose between is their values. No cleverness
inside the body can undo that — the damage is done at the call site. If
the branches deleted text instead of printing, `my-if` would do both.
This is equally why `when` and `unless` cannot be functions: `(unless
(saved?) (save!))` must not evaluate `(save!)` until it has looked at
the test. The only way to receive code *unevaluated* — and decide its
fate — is to be a special form or a macro. The special forms are a
closed set of seventeen, built into the evaluator; macros are how you
extend that set yourself — `when` and `unless` are in fact prelude
macros, and we read their source below.

### Defining a Macro with defmacro

```lisp
(defmacro name params body…)
```

`defmacro` builds a transformer — an ordinary procedure with parameter
list `params` and body `body…` — and binds `name` to it, marked as a
macro. It returns the name symbol, like `define`. The parameter list has
the same shapes as `lambda`'s: fixed parameters, a dotted rest parameter
`(test . body)`, or a bare symbol that receives the whole argument list
— a rest parameter is the usual way to accept a body of many forms.

When a call `(name arg…)` is evaluated, the parameters bind the
**unevaluated** argument forms, the transformer body runs, and the form
it returns is then evaluated in the caller's environment — in tail
position, so macros compose with the tail-call behaviour described in
*Functions and Closures*.

Macros live in the same single namespace as everything else. A later
`(define name …)` replaces the macro with an ordinary binding; a local
`let` binding of the same name shadows it, and a call in that scope
applies the shadowing value as a procedure instead. Only the special
forms outrank macros — `(defmacro if …)` will bind the name, but
`(if …)` still dispatches to the built-in special form. Two small facts
worth knowing: a macro's name evaluated as a variable yields the macro
object itself (it prints as `#<macro name>`; applying it as a procedure
is an error), and macros cannot carry docstrings — `doc` on a macro
returns `nil`, so a leading string in a `defmacro` body is convention
for the human reader, nothing more.

### Expansion Happens Every Time

There is no compile phase and no expansion cache: a macro call expands
at **every** evaluation of the call site. A macro used inside a function
re-expands on every call; a hot recursive loop pays the transformer's
cost each iteration — keep transformers cheap, and the heavy lifting in
the expansion or in a function it calls. The flip side is a live-editing
virtue: redefine a macro and every subsequent evaluation of its call
sites picks up the new definition immediately.

### Asking for an Expansion

Two primitives let you look at what a macro call will become without
running it. `(macroexpand-1 form)` performs **one** expansion step: if
`form` is a list whose head names a macro in the global environment,
the transformer is applied to the unevaluated argument forms and the
resulting form is returned — as data, not evaluated. Anything else — a
call to a function, a special form, an atom — comes back unchanged.
`(macroexpand form)` repeats that step until the head is no longer a
macro. Both are ordinary functions, so quote the form you hand them.
At the REPL (`C-x p`, the cmd(toggle-repl) command):

```
λ (macroexpand-1 '(when done (println "x")))
(if done (begin (println "x")))
λ (macroexpand-1 '(+ 1 2))
(+ 1 2)
```

Expansion chases only the *head* of the form. A macro whose expansion
is itself a macro call gets expanded again by `macroexpand` — but a
macro use nested in argument position stays folded:

```
λ (defmacro report (x) (list 'unless '*quiet* (list 'println x)))
report
λ (macroexpand-1 '(report "saved"))
(unless *quiet* (println "saved"))
λ (macroexpand '(report "saved"))
(if *quiet* nil (begin (println "saved")))
λ (macroexpand '(when a (unless b (f))))
(if a (begin (unless b (f))))
```

`report` expands to an `unless`, itself a macro, so `macroexpand` takes
the second step where `macroexpand-1` stops; in the last line the inner
`(unless …)` sits inside the `begin`, not in head position, so it
survives unexpanded. (A macro that expands to itself would never
finish; `macroexpand` gives up after a thousand steps with
`macroexpand: expansion did not terminate`.) These two are the macro
writer's first debugging tool: when an expansion misbehaves, read the
code it actually built before reasoning about what that code does. And
since the expansion is plain data, `eval` (this chapter's final
section) will run it —
the inspect-then-run loop the worked examples below lean on.

### Quasiquote in Macro Templates

You met quasiquote in *The Evaluation Model* as a way to build data with
holes in it. For the macro writer it is the essential tool: an expansion
is mostly fixed scaffolding with a few caller-supplied forms let in.
Backquote `` ` `` quotes a template; comma `,` unquotes one hole,
evaluating the expression inside it; comma-at `,@` splices a list of
forms into place:

```lisp
(define n 3)
`(a b ,n)             ; ⇒ (a b 3)
`(1 ,@(list 2 3) 4)   ; ⇒ (1 2 3 4)
```

Splicing is what handles a macro's rest parameter — a body arrives as a
*list* of forms, and `,@` lays them out flat where the template wants
them. And since splicing an empty list inserts nothing, `,@` of an `if`
is the standard idiom for conditionally including a form:

```lisp
(define body '((step!) (record!)))
`(begin ,@body)   ; ⇒ (begin (step!) (record!))

(define trace #t)
`(begin ,@(if trace '((println "go")) '()) ,@body)
; ⇒ (begin (println "go") (step!) (record!))
```

Nesting, in one careful paragraph: quasiquote tracks depth, so a
quasiquote inside a quasiquote preserves its own unquotes as data —
`` `(a `(b ,(+ 1 2))) `` yields `(a (quasiquote (b (unquote (+ 1 2)))))`
— while a doubled comma `,,x` escapes both levels and evaluates `x`,
R7RS-style. The one departure from the standard: `,@` under a nested
quasiquote takes no part in the depth count, so keep splices out of
nested templates. None of this arises until you write macros that write
macros; everyday templates are one level deep.

### A Ladder of Worked Macros

Four macros, easiest first; three are from the editor's own source.

#### How the Prelude Defines unless

The real definition, from the prelude in
`packages/lisp/src/interpreter.js`:

```lisp
(defmacro unless (test . body)
  (list 'if test 'nil (cons 'begin body)))
```

Read it line by line. The parameter list `(test . body)` binds `test` to
the first argument form and `body` to the *list* of the rest — for
`(unless done (println "still working"))`, `test` is the symbol `done`
and `body` the one-element list `((println "still working"))`. The
transformer builds a four-element list: the symbol `if`, the test
untouched, the quoted symbol `nil` — which, when the expansion runs,
evaluates to `nil` through the global constant of that name — and the
body with `begin` consed on. The expansion, evaluated in place of the
call, is `(if done nil (begin (println "still working")))`. No
quasiquote here — at this size `list` and `cons` are perfectly readable;
both styles are legitimate. The macros
<a href="reference/lisp-core/when.html" data-jmacs-doc="when">when</a> and
<a href="reference/lisp-core/unless.html" data-jmacs-doc="unless">unless</a>
are described as control flow in *Control Flow and Iteration*; here you
see they are two lines each.

#### How the Prelude Defines dotimes

*Control Flow and Iteration* presented `dotimes` as a counting loop;
here is what it actually is — the real definition, verbatim from the
same prelude:

```lisp
;; (dotimes var count body...) — evaluate body with var bound to
;; 0, 1, ... count-1. count is evaluated once, before the loop.
(defmacro dotimes (var count . body)
  (let ((loop (gensym "dotimes"))
        (n (gensym "count")))
    `(let ((,n ,count))
       (letrec ((,loop (lambda (,var)
                         (when (< ,var ,n)
                           ,@body
                           (,loop (+ ,var 1))))))
         (,loop 0)))))
```

Ask for an expansion and read them together:

```
λ (macroexpand-1 '(dotimes i 3 (println i)))
(let ((count__2 3)) (letrec ((dotimes__1 (lambda (i) (when (< i count__2) (println i) (dotimes__1 (+ i 1)))))) (dotimes__1 0)))
```

The template wraps the body in a `letrec`-bound loop procedure whose
self-call is the last thing it does — a tail call, so the loop runs in
constant stack at any count (*Functions and Closures*). The caller's
variable drops into the lambda's parameter list through `,var` — the
one binding the caller is *supposed* to see, under the caller's own
chosen name. Everything else the macro introduces hides behind
<a href="reference/lisp-core/gensym.html" data-jmacs-doc="gensym">gensym</a>:
the loop's name, so a body that happens to mention a variable called
`loop` or `dotimes` cannot collide with it, and the count, bound once
*outside* the loop so the `count` expression is evaluated a single time
however many iterations run. Hold onto those two moves — gensym for
introduced names, bind-once for caller forms — because they are the two
disciplines the rest of this chapter teaches, already at work in a
dozen lines of prelude.

The classic exercise is still worth doing: a counting loop of your own,
on different machinery —

```lisp
(defmacro my-dotimes (var count . body)
  `(for-each (lambda (,var) ,@body) (range ,count)))

(my-dotimes i 3 (println i))
; prints 0, 1, 2 on separate lines
; ⇒ nil
```

The call expands to `(for-each (lambda (i) (println i)) (range 3))`:
the body splices in through `,@body`, and the count form lands inside
`(range …)`, evaluated once when the expansion runs. Everything the
macro uses —
<a href="reference/lisp-core/for-each.html" data-jmacs-doc="for-each">for-each</a>,
<a href="reference/lisp-core/range.html" data-jmacs-doc="range">range</a>,
`lambda` — already exists; the macro contributes only syntax, and it
behaves like the real one apart from building the whole index list up
front. What makes it easy: the only binding this expansion introduces
is `var`, and the caller chose that name, so there is nothing to
gensym. Macros that invent bindings of their own are the next rung.

#### swap! and the Capture Problem

A macro to exchange the values of two variables. It must be a macro — a
function receives values and could never assign the caller's variables.
The obvious version:

```lisp
(defmacro swap! (a b)
  `(let ((tmp ,a))
     (set! ,a ,b)
     (set! ,b tmp)))
```

And it works — after `(define x 1)` and `(define y 2)`, `(swap! x y)`
leaves `x` at 2 and `y` at 1. Until a caller's variable is named `tmp`:

```lisp
(define tmp 1)
(define y 2)
(swap! tmp y)
tmp   ; ⇒ 1   — unchanged
y     ; ⇒ 2   — unchanged; nothing swapped at all
```

Trace the expansion: `(let ((tmp tmp)) (set! tmp y) (set! y tmp))`. The
`let` binds an inner `tmp` to the outer `tmp`'s value; `(set! tmp y)`
assigns to the *nearest* binding — the inner one, not the caller's — and
`(set! y tmp)` reads that same inner binding, now holding `y`'s own
value, and hands it straight back. Neither variable moves. This is
*variable capture*, and the macros of this Lisp are *non-hygienic*:
nothing automatically keeps the names a macro introduces apart from the
names at the call site. That is your job, and the tool is
<a href="reference/lisp-core/gensym.html" data-jmacs-doc="gensym">gensym</a>.
`(gensym "tmp")` returns a fresh **uninterned** symbol — it prints like
`tmp__41`, but it is a different symbol from any the reader will ever
produce, even one spelled identically, so it cannot collide. The correct
`swap!`, with its transformer factored out for inspection:

```lisp
(define (swap-expansion a b)
  (let ((tmp (gensym "tmp")))
    `(let ((,tmp ,a))
       (set! ,a ,b)
       (set! ,b ,tmp))))

(defmacro swap! (a b)
  (swap-expansion a b))

(swap-expansion 'tmp 'y)
; ⇒ (let ((tmp__41 tmp)) (set! tmp y) (set! y tmp__41))
```

Notice the two levels at work: the outer `let` runs at expansion time,
binding the macro-writer's `tmp` to a fresh symbol; the inner,
quasiquoted `let` is part of the expansion and runs later, in the
caller's world, under that uncollidable name. And because the
transformer is a plain function, it shows you any expansion on demand.
The discipline, stated plainly: **every binding a macro introduces uses
a gensym, and every form the caller passes in is evaluated exactly once,
in the order the caller wrote them.**

#### The Capstone: atomic-change-group

The real thing, verbatim from `packages/stdlib/lisp/editing.lisp` — the
macro that makes a multi-edit command undo as a single step:

```lisp
(define (call-with-atomic-undo thunk)
  "Run THUNK with every buffer edit it makes grouped into a single undo
   step. The group is closed on every exit — normal return, a Lisp
   error, even a raw JS exception from a host primitive — and any error
   propagates untouched."
  (begin-change-group!)
  (try (thunk)
       (finally (end-change-group!))))

(defmacro atomic-change-group (first . rest)
  "Evaluate the body with every buffer edit grouped into a single undo
   step (Emacs's atomic-change-group). Use around any command body that
   edits the buffer more than once."
  (list 'call-with-atomic-undo
        (cons 'lambda (cons (list) (cons first rest)))))
```

The macro itself is two lines of list-building: `(atomic-change-group
body…)` expands to `(call-with-atomic-undo (lambda () body…))`. That
wrapping is the whole reason a macro is needed — the body must run
*between* `begin-change-group!` and `end-change-group!`, and only by
packaging it unevaluated into a thunk can a function be handed the body
without running it first. The parameter list `(first . rest)` quietly
enforces at least one body form. Everything else lives in the ordinary
function — and the function is three forms: open the group, run the
thunk, and let `try`'s `finally` clause close the group. That one
clause carries the whole guarantee. The cleanup runs on *every* exit —
normal return, a Lisp error propagating (untouched: no handler runs, so
nothing needs re-signalling), even a raw JS exception from a host
fault, the one path no `catch` can see (*Errors and Error Handling*
has the full map). A command that fails halfway, in Lisp or in the
host, still leaves the undo stack well-formed.
(The primitives pair re-entrantly — nested groups fold into the
outermost — and `undo!` is a no-op while a group is open.)

This is the mature shape for non-trivial macros: a **thin macro over a
function that does the work** — syntax in the macro, logic in a function
you can test, trace, and redefine live. When to reach for
`atomic-change-group` in your own editing commands is covered in
*Editing Text from Lisp*.

### The Multiple-Evaluation Trap

Capture is the first classic macro bug; here is the second. A template
that pastes a caller's form in two places runs it twice:

```lisp
(defmacro double-bad (x)
  `(+ ,x ,x))

(define calls 0)
(define (tick!) (set! calls (inc calls)) calls)

(double-bad (tick!))   ; ⇒ 3   — (+ 1 2): tick! ran twice
calls                  ; ⇒ 2
```

The expansion is `(+ (tick!) (tick!))` — correct-looking arithmetic, the
wrong number of side effects. The cure is the *once-only* pattern: bind
the user's form to a gensym-named variable, then use the variable as
often as you like:

```lisp
(defmacro double (x)
  (let ((v (gensym "v")))
    `(let ((,v ,x)) (+ ,v ,v))))

(set! calls 0)
(double (tick!))   ; ⇒ 2   — (+ 1 1): tick! ran once
calls              ; ⇒ 1
```

This is the second half of the `swap!` discipline — each caller form
evaluated exactly once. Audit every template for a `,x` used twice.

### When a Function Is the Right Tool

If a function works, write a function. `double` above should be one —
nothing about doubling needs unevaluated arguments. Functions are
values: you can pass them to `map`, store them in a keymap, `apply`
them; a macro is none of those things, only syntax. Reach for a macro
exclusively when the job is one of three: introducing *bindings* (as
`dotimes` does), controlling the *order or fact* of evaluation (as
`unless` and `atomic-change-group` do), or giving a settled idiom a
syntax of its own — and even then, keep the macro thin over a function.
One honest sentence about the future: hygienic, `syntax-case`-style
macros are the stated design target for this Lisp, and gensym-disciplined
macros will survive that transition.

### eval and read-string: Programs at Runtime

Macros run on code before it runs; two primitives let you go further and
treat code as data at runtime. `(eval form)` evaluates `form` — a form
*value*, a list or symbol or literal, not a string — and returns its
value. It evaluates **always in the global environment**, no matter
where the call appears:

```lisp
(define x 10)
(let ((x 99))
  (eval 'x))   ; ⇒ 10 — the global x, not the let's
```

That pin is a feature in the editor's own plumbing — a keymap binds
command *names*, and evaluating the symbol at keypress time finds the
current global definition, so redefining a command retargets its key
instantly — but it means `eval` is no substitute for a macro or a
closure when lexical context matters.

`(read-string s)` is the reader exposed to Lisp: it parses the source
text `s` and returns the list of **all** forms read, unevaluated —
`(read-string "(+ 1 2)")` is `((+ 1 2))`, a one-element list holding the
form. The two compose into string evaluation:

```lisp
(eval (car (read-string "(+ 1 2)")))   ; ⇒ 3
```

An editor-flavoured ending — a command that prompts for an expression in
the minibuffer and shows its value in the echo area:

```lisp
(defcommand eval-minibuffer-expression (text)
  "Read a Lisp expression in the minibuffer and show its value."
  (interactive (string "Eval: "))
  (show-status! (str (eval (car (read-string text))))))
```

The string came from the user at runtime; `read-string` turns it into a
form, `eval` runs it against the live editor. (`interactive` itself is
the territory of *Commands, Keymaps, and the Minibuffer*.) The loop from
text to code to value is open to you — the same loop the editor itself
turns.
