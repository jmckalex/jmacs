## Errors and Error Handling

When a jmacs Lisp program cannot continue — an argument is the wrong
type, a file is missing, a precondition fails — it *signals* an error:
evaluation of the current form stops, and the error travels outward
until something catches it or it reaches the editor's surface. This
chapter covers both ends of that journey: raising an error worth
reading, catching one with `try`, what the mechanism deliberately does
not do, and where an uncaught error actually shows up in the running
editor. The looping constructs error-handling code leans on are the
territory of *Control Flow and Iteration*; macros that wrap bodies in
error handling belong to *Writing Macros*.

> *An error is a value on its way to a handler: a message for the
> human, irritants for the program.*

### Signalling an Error

The <a href="reference/lisp-core/error.html" data-jmacs-doc="error">error</a>
primitive raises an error and never returns:

```lisp
(error message irritant…)
```

`message` must be a string — `(error 42)` is itself an error,
`error: expected a string, got number`. The *irritants* are any number
of additional values attached to the error: typically the offending
value, the name that was not found, the input that failed to parse.
They ride along with the message and are handed to whichever handler
catches the error.

One honest caveat about uncaught errors: what the editor prints is the
*message text alone*. Irritants are not displayed; they exist for
handlers. So when a value matters to the human reading the message,
fold it into the string with `str`; when it matters to a program that
might catch the error, pass it as an irritant. Doing both is fine:

```lisp
(error (str "width out of range: " width) width)
```

### Errors the Interpreter Raises

Your own `error` calls are a minority. Most errors are signalled by the
interpreter itself, and they are caught the same way and carry the same
shape. The common ones, with their exact message texts:

| Situation | Message |
|-----------|---------|
| Referencing an undefined variable | `unbound symbol: foo` |
| `set!` on an undefined variable | `cannot set! an unbound symbol: foo` |
| Calling a value that is not a procedure | `not a procedure: 5` |
| Wrong argument count | `f: expected 2 argument(s), got 1` — or `expected at least N` with a rest parameter |
| `car` or `cdr` of a non-pair | `car: expected a pair, got number` |
| Wrong argument type to a primitive | `sqrt: expected a number, got string` (the same `name: expected a …, got <type>` shape throughout) |
| Division by zero in `/` or `mod` | `division by zero` · `mod: division by zero` |
| Malformed source given to `read-string` | `unclosed '(' opened at 1:1` |

Reader errors are the one place a line and column appear, embedded in
the message text itself. Well-behaved host primitives follow the same
`name: what went wrong` convention — an error message usually names the
function that refused before saying why.

### Catching an Error with try

`try` is the language's one error-handling construct — a special form,
not a function:

```lisp
(try body… (catch name handler…))
```

The last clause must literally be `(catch name handler…)` with a symbol
for `name`. The body forms run in order, like `begin`. If none of them
signals, the value of the whole `try` is the value of the *last body
form* and the handler never runs. If any body form signals, the rest of
the body is skipped, `name` is bound — in a fresh scope visible only to
the handler — and the handler forms run in order; the value of the
whole `try` is then the value of the *last handler form*.

```lisp
(try 1 2 3 (catch e :nope))            ; ⇒ 3
(try (error "x") (catch e 1 2 3))      ; ⇒ 3
```

What the handler's variable holds is a *condition map* with exactly two
keys: `:message`, the message string, and `:irritants`, a proper list
of the irritant values (`nil` when there were none). Read it with
<a href="reference/lisp-core/get.html" data-jmacs-doc="get">get</a>,
like any other map:

```lisp
(try (error "boom" 1 2) (catch e e))
; ⇒ {:message "boom" :irritants (1 2)}

(try (foo-unbound)
  (catch e (get e :message)))
; ⇒ "unbound symbol: foo-unbound"
```

Interpreter-raised errors and explicit `error` calls arrive as the same
two-key map — the handler cannot tell them apart, and there is no way
to catch only *some* errors by kind. A handler that should pass certain
errors along inspects the map and rethrows (an idiom shown below).

### What try Does Not Provide

`try` has no `finally` clause — cleanup that must run on both paths has
to be written on both paths (the standard library's
`atomic-change-group` does exactly this, closing its change group in
the normal return and in the handler alike). There are no typed
condition classes: every error is the same two-key map, and dispatching
on kinds means matching on the message string. There is no restart
system — Common-Lisp-style conditions and restarts are the planned
future, and `try`/`catch` will remain the everyday surface even then.
And today the condition map carries no source location: no file, line,
or stack trace. The message text is the whole story, which is one more
reason to write messages that name their function.

### The JavaScript Boundary

`try` catches *Lisp* errors — values of the host class `LispError`,
which is what `error` and every interpreter fault throw. A raw
JavaScript exception thrown inside a host primitive — a `TypeError`
from a bug, a `RangeError` from exhausting the JS stack — is **not**
catchable: it escapes every Lisp `try` on the way out and surfaces at
the host level, where the editor's own boundary reports it.

Practically: when your code calls host primitives, `try` is not an
absolute barrier. A handler around a host call catches the errors the
primitive deliberately signals (well-written primitives wrap their
failures in `LispError`), but a genuine host bug sails past it — and so
does your cleanup code, since the handler never runs. Treat an error
that ignores your `try` as a host-side fault worth reporting, not a
flaw in your handler. Stack overflow from deep non-tail recursion is a
`RangeError`, so it too escapes every `try`.

### Idioms for Everyday Error Handling

#### Falling Back to a Default

The lightest use of `try`: attempt the fragile thing, and produce a
fallback value if it signals. The whole form is an expression, so it
sits anywhere a value is expected.

```lisp
(define (forms-in source)
  "Parse SOURCE, or nil when it is not well-formed Lisp."
  (try (read-string source)
    (catch e nil)))

(forms-in "(+ 1 2)")   ; ⇒ ((+ 1 2))
(forms-in "(+ 1")      ; ⇒ nil
```

#### Rethrowing After Inspection

A handler that only knows how to deal with *some* errors examines the
condition map and re-signals the rest. The faithful rethrow uses
`apply` to spread the irritant list back into the call:

```lisp
(try (risky-step)
  (catch e
    (if (string-prefix? "parse:" (get e :message))
        (recover-from-parse-error)
        (apply error (get e :message) (get e :irritants)))))
```

The shorter `(error (get e :message))` also works when the irritants do
not matter downstream. The rethrown error is a new condition as far as
the next handler can tell — there is no provenance chain.

#### Validating Arguments Early

Check preconditions at the top of a function and signal immediately,
with a message that names the function and an irritant carrying the
offending value. A clear early error beats a confusing later one from
three calls deeper:

```lisp
(define (nth-line n)
  "The text of line N, 1-based."
  (unless (and (number? n) (<= 1 n))
    (error (str "nth-line: expected a positive line number, got " n)
           n))
  …)
```

The pattern is two sentences in one error: the message tells the human
what was expected; the irritant gives a catching program the value
itself, un-stringified.

#### Error Messages Are User Interface

In an editor, an uncaught error message is not a log line — it is what
the person at the keyboard reads when a command refuses. Commands
should therefore signal *human-readable* errors: name the command, say
what was wrong, give the expected range when there is one. Compare
`car: expected a pair, got nil` leaking out of an unguarded helper with
`insert-rule: width must be a number` — the second tells the user what
to fix, the first tells them to go read your source.

### Keeping try Out of the Loop

The body and handler of `try` are evaluated *eagerly* — a `try` form is
not a tail position, because the interpreter must keep the catching
frame alive while the body runs (the full story of tail calls is in
*Functions and Closures*). A tail-recursive loop that carries `try`
inside itself therefore grows the JavaScript stack by one frame per
iteration, and a long run can overflow:

```lisp
;; Wrong: the recursive call sits inside the try, so every
;; iteration adds a stack frame.
(define (drain items)
  (try
    (when (pair? items)
      (consume (car items))
      (drain (cdr items)))
    (catch e (show-status! (get e :message)))))
```

Move the `try` outside the loop and the recursion is a genuine tail
call again — one handler wraps the whole run:

```lisp
(define (drain items)
  (when (pair? items)
    (consume (car items))
    (drain (cdr items))))

(try (drain all-items)
  (catch e (show-status! (get e :message))))
```

When each item must survive its neighbours' failures, keep a small
`try` around the *work*, with the recursive call after it, outside:

```lisp
(define (drain items)
  (when (pair? items)
    (try (consume (car items))
      (catch e (println "skipped:" (get e :message))))
    (drain (cdr items))))     ; tail call — the try is already done
```

The `try` completes before the tail call happens, so the stack stays
flat no matter how long the list is.

### Where Errors Appear in the Running Editor

An error nobody catches does not crash jmacs; the host catches it at
the boundary and reports it. Where you see it depends on how the code
was running:

- **The REPL** (`C-x p`, cmd(toggle-repl)) prints the message in its
  error styling in place of a result. The REPL is also the editor's
  error log of record — most of the paths below write here.
- **Inline evaluation** — `C-RET` (cmd(eval-expression-at-point)) and
  `C-x C-e` (cmd(eval-expression-before-point)) — shows a red pill
  beside the form reading `! ` plus the message, truncated to a line;
  the full text also lands in the REPL and in the `*Eval log*` buffer
  — see cmd(show-eval-log) — where successes are marked `⇒` and
  failures `!`.
- **A command run from a key, `M-x`, or a menu**: the error is caught
  at the host boundary (a keystroke is consumed, not replayed) and the
  message is appended to the REPL. If the dock is closed, nothing
  visible happens at all — so when a key seems to silently do nothing,
  open the REPL; the explanation is usually sitting there.
- **Startup and reload**: a standard-library or `init.lisp` file that
  fails to load is reported by name in the REPL and the rest still
  load — a broken file degrades the editor, it does not brick it.
- **JavaScript faults** that escape to the window are caught by the
  renderer's error boundary, which notes them in the REPL, flashes a
  one-line minibuffer message, and snapshots unsaved work for recovery.

One forward reference: a multi-edit command wrapped in
`atomic-change-group` closes its undo group even when the body
signals, so a failed command never leaves the undo stack half-grouped
— the full story is in *Editing Text from Lisp*.

### A Worked Example: Refusing Bad Input Gracefully

A small command, end to end: it prompts for a number, validates it,
and signals errors a person can act on. (The `defcommand` and
`interactive` machinery is covered in *Commands, Keymaps, and the
Minibuffer*; here it is the thinnest possible wrapper.)

```lisp
(defcommand insert-rule (width)
  "Insert a horizontal rule of WIDTH dashes on its own line."
  (interactive (number "Rule width: "))
  (unless (number? width)
    (error "insert-rule: width must be a number" width))
  (unless (<= 1 width 400)
    (error (str "insert-rule: width out of range (1–400): " width)
           width))
  (insert! (str "\n" (string-repeat "-" width) "\n")))
```

The first check is not paranoia: the `(number "…")` interactive source
converts the minibuffer string with `string->number`, which yields `#f`
for input like `"abc"` — the command really can receive a non-number,
and says so in its own name. The second check folds the offending value
into the message (for the human) and attaches it as an irritant (for
any caller). Run interactively with a bad width, nothing is inserted
and `insert-rule: width must be a number` lands in the REPL; run with
`80`, it inserts the rule. And because a command is an ordinary
function, a program can call it and field the failure itself:

```lisp
(insert-rule 10)                       ; inserts a 10-dash rule
(try (insert-rule -3)
  (catch e (get e :irritants)))        ; ⇒ (-3)
```

Validate early, name yourself in the message, carry the value as an
irritant, and let `try` sit outside your loops: that is the whole
discipline.
