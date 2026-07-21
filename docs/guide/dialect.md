## Godot Lisp for Lisp Programmers

This chapter is for the reader who already has a Lisp — who can write a
`defmacro` in their sleep, or holds opinions about hygiene, or knows
exactly what `(eq "ab" "ab")` returns in their dialect and is about to
be wrong here. Godot Lisp's ancestry is deliberately mixed: the
*semantics* are Scheme's — lexical scope, one namespace, applicative
order, only `#f` false, proper tail calls; the *data notation* is
Clojure's — vectors `[1 2 3]`, maps `{:a 1}`, self-evaluating
`:keywords`; the *job description* is Emacs's — buffers, commands,
keymaps, a kill ring, `*last-command*`; and the *macro system* is
old-school Common Lisp — procedural `defmacro` plus `gensym`
discipline. The design goal underneath all four is legibility: a
language small enough to state completely (seventeen special forms, one
evaluation chapter) hosted in the editor's own JavaScript runtime, so
that numbers, strings, and booleans *are* their JS selves and nothing
is lost at the boundary. This chapter states each load-bearing
difference crisply, with the trap it sets for migrants, and points at
the chapter that owns the full treatment. Read it first; then read the
guide in order and nothing will surprise you twice.

> *Scheme's semantics, Clojure's literals, Emacs's vocation, Common
> Lisp's macros — and every trap below lives on one of the seams.*

### The Differences at a Glance

| Dimension | Godot Lisp | Emacs Lisp | Scheme (R7RS) | Common Lisp |
|---|---|---|---|---|
| Namespaces | One (Lisp-1), commands included | Two — `funcall` | One | Two-plus — `#'`, `funcall` |
| False values | `#f` only — `nil` is *true* | `nil` only | `#f` only | `nil` only |
| `nil` vs `'()` | `nil` *is* `'()`, but is not false | `nil` = `'()` = false | `'()` distinct from `#f`; no `nil` | `nil` = `'()` = false |
| Scoping | Lexical only; no dynamic variables | Dynamic heritage; lexical opt-in; `defvar` is special | Lexical, plus `parameterize` | Lexical, plus special variables |
| Tail calls | Guaranteed (trampoline); `try`/`module` excepted | None | Guaranteed everywhere | Implementation-dependent |
| Macros | `defmacro`, non-hygienic, `gensym` | Same | Hygienic — `syntax-rules` | `defmacro`, non-hygienic |
| Characters | No character type — 1-char strings | Integers (`?a`) | `#\a` char type | `#\a` char type |
| Strings | Immutable; UTF-16 code units | Mutable, carry text properties | Mutable (`string-set!`) | Mutable char vectors |
| Numbers | One type: IEEE double | Fixnums, bignums, floats | Full tower; exact rationals | Full tower, mandated |
| Data literals | `[…]` and `{…}` *evaluate* elements | `[…]` self-quoting constant | `#(…)` constant | `#(…)` constant; no map literal |
| Pair mutation | None — pairs frozen | `setcar`/`setcdr` | `set-car!`/`set-cdr!` | `rplaca`, `nconc` idiomatic |
| Equality | `eq?` is JS `===`; `equal?` deep; `=` numeric | `eq`/`eql`/`equal` | `eq?`/`eqv?`/`equal?` | `eq`/`eql`/`equal`/`equalp` |
| Errors | `try`/`catch`/`finally`; condition map | `condition-case`, `unwind-protect` | `guard`, `dynamic-wind` | Conditions *and restarts* |
| Modules | `module`/`import` — snapshot copies | `provide`/`require` | `define-library` | Packages (symbol namespaces) |
| Commands | `defcommand` + declarative `interactive` | `defun` + `interactive` string | — | — |

The rest of the chapter takes these one at a time.

### Only `#f` Is False

Exactly one value is false: `#f`. Everything else is true — including
`nil`, `0`, `""`, and (for completeness) `NaN`. The test the evaluator
applies is literally *is this value not `#f`* — nothing is coerced,
nothing else is special.

```lisp
(if '() "yes" "no")   ; ⇒ "yes" — the empty list is true
(if 0   "yes" "no")   ; ⇒ "yes"
(not nil)             ; ⇒ #f — nil is not false
(nil? '())            ; ⇒ #t — the right way to test for emptiness
```

Booleans are written `#t` and `#f` (long forms `#true`/`#false`
accepted), and the names `true` and `false` are bound to the same two
values as ordinary variables.

**Coming from Emacs Lisp or Common Lisp, watch out:** this is the
single most consequential difference in the language, and it inverts a
reflex. `(when (cdr xs) …)` does not test for a non-empty tail — the
empty list *passes*. Every list test must be explicit: `nil?` for
emptiness, `pair?` for non-emptiness. Schemers can relax — this is your
rule — but note the predicate is `nil?`, not `null?`, which does not
exist here. Truthiness is covered in depth in *Lisp Data Types*.

### Absence Is `#f`, Emptiness Is `nil`

Because `nil` is true, `nil` cannot signal failure — so the library
does not use it for that. The convention is worth learning before any
other idiom: **a lookup that finds nothing returns `#f`; a function
that returns the empty thing returns `nil`.** `get` with no fallback,
`member`, `doc`, `string->number` on garbage — all answer `#f`, which
makes them safe as a bare `if` test. `first` and `rest` of an empty
list answer `nil`, because the first of nothing is nothing.

```lisp
(get {:a 1} :b)             ; ⇒ #f — a miss
(member 5 '(1 2 3))         ; ⇒ #f — a miss
(member 2 '(1 2 3))         ; ⇒ (2 3) — the tail from the match
(first '())                 ; ⇒ nil — emptiness, not failure
(string->number "seven")    ; ⇒ #f
```

**Coming from Emacs Lisp or Common Lisp, watch out:** in your dialect
`(cdr (assq …))` conflates "not found" with "found nil" and it rarely
matters, because both are false. Here the two are *different values
with different truthiness*, and the corner case bites in reverse:
`(nil? #f)` is `#f`, so testing a possible miss with `nil?` silently
never fires. Test misses bare (or with `not`); test emptiness with
`nil?`. The two conventions and their one leak — host primitives that
return "nothing" hand back a truthy `nil` — are laid out in *Lisp Data
Types* and recapped in *Lisp Style and Pitfalls*.

### One Namespace — with an Editor-Shaped Trap

Godot Lisp is a Lisp-1. Variables, procedures, macros, and editor
commands are one kind of binding, looked up one way; `(f x)` resolves
`f` exactly as `x` is resolved. There is no `funcall`, no `#'`, no
function cell — a procedure sits in a variable and you call it.

```lisp
(define ops (list + *))       ; procedures are ordinary values
((first ops) 2 3)             ; ⇒ 5 — call whatever the head yields
(let ((f string-upcase))
  (f "quiet"))                ; ⇒ "QUIET" — no funcall anywhere
```

The editor adds one twist the standards do not have. Global bindings
live in a two-frame chain: the host *primitives* sit in a base frame,
and every top-level `define` — including every `defcommand` — binds
in the *global* frame, a child of it. A definition named after a
primitive therefore shadows the primitive, silently, for every Lisp
caller in the system.

**Coming from anywhere, watch out:** name a panel-opening command
`view-list` and every piece of code that called the `view-list`
primitive for *data* now opens a panel instead. This is why the stdlib
names side-effecting openers with a `!` — `view-list` returns the
handles, `view-list!` shows the panel. Before claiming a name, ask
`(describe name)`; a `:kind` of `:primitive` means pick another. The
full story is in *Functions and Closures* and *Commands, Keymaps, and
the Minibuffer*; the trap has its own entry in *Lisp Style and
Pitfalls*.

### Lexical Scope, Full Stop

Scoping is lexical and *only* lexical — the environment implementation
describes itself as "lexical, full stop", and means it. There is no
`defvar`, no special variables, no `fluid-let`, no `parameterize`, no
dynamic binding construct of any kind. The earmuffed globals you will
see everywhere — `*fill-column*`, `*kill-ring*`, `*last-command*` —
borrow Common Lisp's *naming convention* without its semantics: they
are ordinary top-level lexical bindings, read directly and mutated
with `set!`. (`defcustom` registers metadata for the customize UI and
then `define`s a plain global; *Customization from Lisp* has the
details.)

**Coming from Emacs Lisp or Common Lisp, watch out:** the
let-to-rebind reflex does nothing here. A `let` of an earmuffed name
creates a *new lexical binding* that callees never see:

```lisp
(define *width* 70)
(define (report-width) *width*)

(let ((*width* 40))     ; a fresh local binding, invisible to callees
  (report-width))       ; ⇒ 70 — not 40
```

The idiom in its place is save, `set!`, and restore under `finally`,
which also survives errors:

```lisp
(define saved *width*)
(set! *width* 40)
(try (report-width)                    ; ⇒ 40
     (finally (set! *width* saved)))
```

Note also the `define`/`set!` split, which is Scheme's, not Emacs's:
`define` always creates a binding in the *current* frame (shadowing
any outer one), while `set!` assigns the *nearest existing* binding
and errors on unbound names — there is no `setq`-style
define-by-assignment. *The Evaluation Model* owns this territory.

### Equality Is JavaScript's

`eq?` is JS `===`. That makes it identity on pairs, vectors, maps, and
procedures — but *value* equality on numbers, strings, and booleans,
and name equality on symbols and keywords (which are interned).
`equal?` recurses structurally into pairs, vectors, and maps. `=` is
for numbers only, is variadic, chains, and errors on anything else.
There is no `eqv?` tier — JS `===` collapses it into `eq?`.

```lisp
(eq? "ab" (string-append "a" "b"))   ; ⇒ #t — strings compare by value
(eq? 1 1.0)                          ; ⇒ #t — one numeric type anyway
(eq? '(1 2) '(1 2))                  ; ⇒ #f — fresh pairs, identity
(equal? '(1 2) '(1 2))               ; ⇒ #t
```

**Coming from Scheme, watch out:** `(eq? "ab" "ab")` is `#t` here —
*stronger* than the unspecified answer you are used to, and code
ported from Scheme that carefully threads `equal?` for strings will
work unchanged, but code that *relies* on `eq?` distinguishing string
copies will not. **Coming from Emacs Lisp:** the same surprise in the
other direction — `eq` on equal strings is `nil` in Emacs and `#t`
here.

One genuine sharp edge survives the simplification: map keys are
matched by identity (JS `Map` semantics), so a list or vector used as
a key matches only the stored object, never a reconstruction — and
`equal?` on maps inherits the same rule for keys. Key maps with
keywords, symbols, strings, or numbers. *Lisp Data Types* covers the
whole equality story, this trap included.

### Strings Without Characters

There is no character type. None. Emacs's `?a`, Scheme's and CL's
`#\a` — the reader rejects both (`#` introduces only `#t` and `#f`).
The unit of string work is the one-character *string*, and the
character-classifying primitives take exactly that (`char-word?`
expects a length-1 string). Strings themselves are immutable JS
strings: no `aset`, no `string-set!`, no text properties riding along
— buffer text gets its properties from overlays and markers instead
(*Editing Text from Lisp*).

```lisp
(substring "abc" 0 1)      ; ⇒ "a" — the character, as a string
(substring "godot" -3)     ; ⇒ "dot" — slice semantics, negatives OK
(string-length "🙂")       ; ⇒ 2 — UTF-16 code units, honestly
```

Indexing and length count UTF-16 code units — JS semantics showing
through — so an astral-plane character counts as two. Escapes are
exactly `\n` `\t` `\r` `\0` `\\` `\"`; there is no `\u` notation
(a backslash before any other character yields that character), and a
raw newline inside the quotes is legal, so multi-line strings need no
special syntax. The full catalogue is in *Lisp Data Types*.

### One Kind of Number

Every number is an IEEE-754 double — the host's number. `1` and `1.0`
are the same value; integers are exact to 2^53; there are no bignums,
no rationals, no radix literals (`0x10` reads as a *symbol*), and
`NaN`/`Infinity` arise but cannot be written.

```lisp
(/ 7 2)          ; ⇒ 3.5 — real division, always
(quotient 7 2)   ; ⇒ 3 — truncating integer division
(+ 0.1 0.2)      ; ⇒ 0.30000000000000004 — doubles, honestly
```

**Coming from Emacs Lisp, watch out:** `(/ 7 2)` is `3` at home and
`3.5` here — integer division must be asked for by name (`quotient`).
**Coming from Scheme or Common Lisp:** there is no exactness, no
`7/2`, and no tower; numeric code that leans on exact rationals needs
rethinking, not porting. `/` and `mod` check for zero divisors and
raise; `quotient` and `remainder` let the host arithmetic show through
(`(quotient 1 0)` is `Infinity`). Details in *Lisp Data Types*.

### Literals That Evaluate: Vectors, Maps, Keywords

The Clojure-flavoured literals come with Clojure-flavoured evaluation:
an *unquoted* vector or map literal evaluates its elements — for maps,
both keys and values — and yields a fresh (frozen) aggregate. Quote
the whole literal to keep the elements as data. Quasiquote —
distinctively — descends into vector and map templates, so `,` and
(in vectors) `,@` work inside the brackets:

```lisp
(define x 1)
[x (+ x 1)]        ; ⇒ [1 2] — elements evaluated
'[x (+ x 1)]       ; ⇒ [x (+ x 1)] — quoted: data
`[0 ,@(list 1 2)]  ; ⇒ [0 1 2] — splicing inside a vector template
{:n (+ 1 1)}       ; ⇒ {:n 2} — keys and values both evaluate
```

**Coming from Emacs Lisp, watch out:** `[a b c]` at home is a
self-quoting constant of three *symbols*; here it is three variable
references, and unbound ones error. The same goes for Scheme's and
CL's `#(…)` reflexes — the notation differs *and* the evaluation rule
differs.

Keywords `:like-this` are a distinct interned type, self-evaluating,
used as map keys and option markers. They are *not* callable —
`(:title m)` is `not a procedure`, unlike Clojure — and the accessor
spelling is `(get m :title)`. *Lisp Data Types* covers all three
types; *The Evaluation Model* states the evaluation rules.

### Immutable by Default

Pairs are frozen at construction: there is no `set-car!`/`setcar`, no
`nconc`, no destructive list surgery of any kind — every list
operation builds new structure. Vectors are frozen too; no vector
mutation exists. Maps are copy-on-write by convention: `assoc` and
`dissoc` return new maps and no mutating map primitive is provided.
`sort` is non-destructive, stable, and returns the same type it was
given.

```lisp
(define m {:a 1})
(assoc m :b 2)   ; ⇒ {:a 1 :b 2} — a copy
m                ; ⇒ {:a 1} — the original survives
```

**Coming from Common Lisp especially, watch out:** the destructive
idioms (`nconc`, in-place `sort`, `rplacd` tricks) have no equivalents
— and their absence is load-bearing, because shared structure is
everywhere and nothing defends against mutation except its
impossibility. Mutation survives in exactly two visible places:
`set!` on bindings, and the `!`-suffixed host primitives that edit the
buffer, the display, and the world (`insert!`, `goto!`,
`set-marker!`). A keymap "edit" is therefore
`(set! map (assoc map key cmd))` — forget the `set!` and the new
binding evaporates. *Lisp Data Types* closes with the full
immutability map.

### Macros: `defmacro`, Not Hygiene

Macros are procedural and non-hygienic — a deliberate v0 choice, with
`syntax-case`-style hygiene the stated eventual target. `defmacro`
binds a transformer from unevaluated forms to a form, which is
evaluated in the caller's place (in tail position). There is no
expansion cache: a macro re-expands at every evaluation of its call
site, which costs a little and buys live redefinition.
`macroexpand-1` and `macroexpand` return expansions as data (the
latter caps at a thousand steps, so a self-expanding macro cannot hang
the editor).

```lisp
(macroexpand-1 '(when ok (go!)))   ; ⇒ (if ok (begin (go!)))
```

Since there is no hygiene, the discipline is Common Lisp's: every
binding a macro introduces is a `gensym` — genuinely uninterned, never
`eq?` to any read symbol — and every caller form is evaluated exactly
once, in written order. Macros live in the single namespace and can be
shadowed like any binding; only the seventeen special forms outrank
them and cannot be shadowed.

**Coming from Scheme, watch out:** this is the largest divergence from
the Scheme parentage. There is no `syntax-rules`, no referential
transparency for free — a template that mentions `list` will pick up
whatever `list` means *at the call site*. Write macros as thin
wrappers over functions, gensym everything you introduce, and read
*Writing Macros*, which builds the whole discipline from the prelude's
own source.

### Tail Calls: Guaranteed, with Named Exceptions

The evaluator is a trampoline: code in tail position becomes a bounced
thunk, so tail recursion runs in constant JS stack — Scheme's
guarantee, essentially, and the loop macros (`while`, `dotimes`,
`dolist`) and named `let` are built on it.

```lisp
(define (count-down n)
  (if (= n 0) 'done (count-down (- n 1))))
(count-down 1000000)   ; ⇒ done — constant stack

(let loop ((n 5) (acc 1))
  (if (= n 0) acc (loop (- n 1) (* acc n))))   ; ⇒ 120
```

Tail positions: `if` branches, `cond` clause bodies, the last form of
`and`/`or`, the last form of `begin` and every `let`-family and
`lambda` body, and a macro's expansion. *Not* tail positions: any part
of a `try` (body, handler, and `finally` alike — they must stay inside
the host's `try` frame), `module` bodies, argument positions, and
anything routed through `apply`, `map`, `filter`, `reduce`, or
`for-each`. Non-tail recursion still consumes JS stack, and a blown
stack is a raw JS error no Lisp `try` can catch.

**Coming from Emacs Lisp, watch out** in the pleasant direction:
recursion is a real tool here, not a `max-lisp-eval-depth` incident
waiting to happen. Schemers should note the `try`/`module` carve-outs;
Common Lispers can simply stop consulting their implementation's
manual. (The same trampoline counts bounces and checks for `C-g`
every few thousand steps — a long-running loop is interruptible,
not a hang.) *Functions and Closures* maps the positions precisely.

### Errors: `try`, a Condition Map, and No Restarts

Signalling is `(error msg irritant…)`; handling is the `try` special
form, whose optional `catch` and `finally` clauses replace
`condition-case`, `unwind-protect`, `guard`, and `handler-case` all at
once:

```lisp
(try (error "boom" 1 2)
  (catch e
    (get e :message)))    ; ⇒ "boom" — e also carries :irritants,
                          ;   and :line/:column when known
```

The catch variable binds a *condition* — a plain map, not a typed
object; there is no handler dispatch by condition class, and no
rethrow primitive (re-signal with `error`). `finally` runs on every
exit. Only Lisp errors are catchable: a raw JS exception from a host
primitive sails through every `catch` — though `finally` cleanup still
runs — which is the safety net that makes
`(try … (finally (end-change-group!)))` trustworthy.

**Coming from Common Lisp, watch out:** there are no restarts and no
resumption — an error unwinds, full stop (the CL condition system is
the acknowledged eventual target). And one editor-specific caution for
everyone: the interrupt raised by `C-g` (and by the step budget) is
deliberately an error subtype so that cleanup runs — which means an
over-broad `catch` can swallow the user's quit. Keep catch clauses
narrow. *Errors and Error Handling* has the complete map, raw-JS
escape hatch included.

### Modules Are Real, and Imports Are Snapshots

Unlike Emacs Lisp's flat obarray with courtesy prefixes, Godot Lisp
has an actual module system, as special forms: `(module name body…)`
evaluates its body in a fresh environment, `(export sym…)` declares
the public names (anywhere in the body), and `(import name)` copies
the exported bindings into the current scope.

```lisp
(module greetings
  (export greet)
  (define (greet name) (str "hello, " name)))

(import greetings)   ; ⇒ greetings
(greet "ada")        ; ⇒ "hello, ada"
```

Two behaviours to internalise. First, a module's environment is a
child of the *base* frame — it sees primitives and prelude but *not*
your top-level definitions or other modules; everything else arrives
by `import`. (Common Lispers: this is stricter than a package that
`:use`s `CL` and inherits half the world.) Second, `import` copies
*current values* — a snapshot. Re-evaluating a module updates every
closure inside it at once (the environment is reused — this is what
makes redefining a command in the REPL take effect immediately), but
importers keep their stale copies until they import again. Module names are flat symbols;
there is no renaming, no phasing, and — Schemers — nothing like
`define-library`'s import surgery. *Modules and Program Structure*
develops all of it.

### The Editor Surface: `defcommand` and `interactive`

Emacs Lisp is the direct ancestor here, and an Emacs hand will feel at
home within minutes — but the mechanism is cleaner. `defcommand` is a
stdlib *macro*, not a special form: it expands to a plain `define`
plus a registration into the command table that `M-x` searches. The
`(interactive …)` clause is a declarative *list* of typed sources —
`point`, `region`, `region-or-buffer`, `(string PROMPT)`,
`(number PROMPT)` — not a code-letter string to memorise:

```elisp
;; Emacs Lisp
(defun insert-shout (text)
  (interactive "sShout what? ")
  (insert (upcase text) "!"))
```

```lisp
;; Godot Lisp
(defcommand insert-shout (text)
  "Prompt for text and insert it, loudly."
  (interactive (string "Shout what? "))
  (insert! (string-append (string-upcase text) "!")))
```

Prompting is asynchronous — a minibuffer source suspends the gather
and a cancelled prompt means the command body never runs. Dispatch
resolves the command's *name* at keypress time, so redefining a
command retargets every binding instantly; `*last-command*` and
`*this-command*` work exactly as an Emacs hand expects (it is how
`yank-pop` knows it follows `yank`). A command remains an ordinary
function you can call programmatically — and, being a binding in the
one namespace, it can shadow a primitive, which is the trap described
above. *Commands, Keymaps, and the Minibuffer* is the full treatment.

### Smaller Surface Differences

One line each, for completeness:

- The only `#` syntax is `#t`/`#f`/`#true`/`#false` — no `#\a`,
  `#(…)`, `#x10`, `#|…|#`, or `#;`. Comments are `;` to end of line,
  and that is all.
- `()` reads as `nil` and self-evaluates — no "empty application"
  error.
- Dotted pairs read and print — `(cons 1 2)` ⇒ `(1 . 2)` — but the
  dot is recognised only inside parentheses.
- `car`/`cdr` insist on a pair and raise; the total `first`/`rest`
  return `nil` for anything else. `append`'s last argument becomes
  the tail unchanged: `(append '(1) 2)` ⇒ `(1 . 2)`.
- `define`, `defmacro`, `defcommand`, `module`, and `import` all
  return the *name symbol* — which is why the REPL answers a
  definition with its name. `set!` returns the value.
- A leading docstring in a `define` body is kept — `(doc f)` and
  `(describe f)` hand it back, with the definition's `line:col`.
  `defmacro` bodies keep no docstring.
- `string->number` has JS `Number()` semantics: trims whitespace,
  accepts hex, maps `""` to `0`, and answers `#f` only on a genuine
  non-number.
- `string-index-of` answers `-1` on a miss — which is truthy.
- `string-prefix?` and `string-suffix?` take the affix *first*.
- In `cond`, a one-element clause `(x)` yields `x`'s value directly,
  computed once — the classic test-is-the-result clause; a bare
  `(else)` clause tail-evaluates the *symbol* `else` — unbound unless
  you went out of your way.
- The loop macros take flat arguments — `(dotimes i 10 body…)`,
  `(dolist x xs body…)` — not Emacs's parenthesized `(var list
  [result])` spec; all of `while`, `dotimes`, and `dolist` return
  `nil`, and `dolist` is lists-only.
- `eval` always evaluates in the *global* environment, ignoring local
  scope by design — see *Lisp Style and Pitfalls* before reaching for
  it.
- Host interop runs one way in v0: JavaScript registers primitives
  for Lisp; a primitive returning JS `null`/`undefined` yields `nil`,
  so raw JS nothings never reach your code.

### Writing Idiomatic Godot Lisp

The migration checklist, in the order the habits pay off. Each item is
developed fully in *Lisp Style and Pitfalls* and the chapter named.

- **Let names carry the contract.** Trailing `?` for predicates,
  trailing `!` for anything that mutates the buffer, the display, or
  the world — *including opening a panel* — `*earmuffs*` for
  user-visible global state (remembering they are plain lexical
  globals), and a leading `-` for file-private helpers.
- **Check before you claim a name.** `(describe name)` first; if
  `:kind` is `:primitive`, take the `!` variant or another name
  entirely. One namespace means collisions are silent.
- **`defcommand` for the user, `define` for the program.** A command
  is for `M-x` and key bindings; keep the logic in ordinary functions
  the command calls, so it can be tested from the REPL.
- **Wrap multi-edit commands in `atomic-change-group`.** Two `insert!`
  calls are two undo steps unless you say otherwise; the group closes
  on every exit, host faults included (*Editing Text from Lisp*).
- **Prefer `save-excursion` and `with-marker` to raw markers.** A bare
  `(make-marker)` is a debt every subsequent edit pays interest on;
  the wrappers release on every exit path.
- **Test emptiness with `nil?`, misses bare.** And remember `nil?`
  cannot see a `#f`.
- **`gensym` every binding a macro introduces**, and evaluate each
  caller form exactly once (*Writing Macros*).
- **Save/`set!`/restore under `finally`** where you would have
  dynamically bound a special variable at home.
- **Reach for bulk primitives in hot paths** — `string-join`,
  `buffer-substring`, `replace-all!` — and let the host iterate; the
  interpreter is a policy engine, not a compute engine.

None of this is enforced. The language has one namespace, no access
control, and macros that will cheerfully capture your variables — it
trusts you exactly as far as your conventions deserve. The standard
library in `packages/stdlib/lisp/` follows every rule above and is the
reference implementation of the style; when this chapter and your
instincts disagree, evaluate something and let the editor referee.
