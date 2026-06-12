# The Editor Lisp — Specification (v0)

This document describes the editor's Lisp dialect as it is *actually
implemented* in `packages/lisp`. Where the design plan
(`plans/LISP-SPEC.md`) calls for something not yet built, the section
says so plainly and marks it **Planned**.

The dialect is Scheme-dominant in semantics, Clojure-influenced in its
data literals, with Common Lisp's condition system as the eventual
error-handling foundation. It is implemented as a tree-walking
interpreter in vanilla JavaScript.

---

## 1. Introduction and design principles

The Lisp is the editor's primary extension language: commands, modes
and the standard library are written in it. Its guiding principle is
the project's: **legibility**. The language has rules you can state
precisely and a small irreducible core.

- Semantics follow **Scheme**: lexical scope, applicative order, a
  single namespace for procedures and values.
- Data literals follow **Clojure**: vectors `[…]`, maps `{…}`,
  keywords `:like-this`.
- Error handling will grow toward **Common Lisp** conditions; today it
  offers `try`/`catch` (§7).

Dynamically typed. Immutable by default — `Pair`s, vectors and symbols
are frozen; the only mutation is `set!` on bindings and host buffer
primitives, both syntactically visible.

## 2. Lexical structure

The reader (`reader.js`) accepts:

- **Numbers** — integers and floats, optional sign and exponent:
  `42`, `-3.5`, `+7`, `1e3`.
- **Strings** — `"…"` with escapes `\n \t \r \0 \\ \"`.
- **Booleans** — `#t` and `#f` (also `#true`, `#false`).
- **Symbols** — any token that is not a number, e.g. `foo-bar`,
  `string->symbol`, `+`. Interned: equal symbols are identical.
- **Keywords** — `:name`, self-evaluating, interned.
- **Lists** — `(a b c)`, and dotted pairs `(a . b)`, `(a b . c)`.
- **Vectors** — `[1 2 3]`.
- **Maps** — `{:a 1 :b 2}` (an even number of forms).
- **Quote family** — `'x` `` `x `` `,x` `,@x` read as `(quote x)`,
  `(quasiquote x)`, `(unquote x)`, `(unquote-splicing x)`.
- **Comments** — `;` to end of line.

Every list form carries a source position (line, column) for error
messages and self-documentation. **Planned:** positions on atoms; set
literals `#{…}`.

## 3. Evaluation model

Scoping is **lexical**, full stop. An environment is a frame of
bindings plus a link to its enclosing frame; lookup walks outward.

Evaluation is **applicative order**, arguments left to right.

Evaluating a form:

- A **symbol** is a variable reference.
- A **list** is a special form, a macro use, or a procedure
  application — decided by its head.
- A **vector** or **map** evaluates its elements (so `[1 (+ 1 1)]` is
  `[1 2]`). Use `quote` to keep them literal.
- Everything else — numbers, strings, booleans, keywords, `nil`,
  procedures — is self-evaluating.

**Truthiness** is Scheme's: only `#f` is false. `nil` (the empty list),
`0` and `""` are all true.

A procedure application evaluates the head to a procedure, evaluates
the arguments, and applies. Closures capture their defining
environment. Rest parameters: `(lambda (a b . rest) …)`.

**Tail calls are optimised.** The evaluator is a trampoline
(`eval.js`): a call in tail position runs in constant JavaScript
stack, so tail-recursive loops — including named `let` and the prelude
loop macros — iterate indefinitely. Deep **non-tail** recursion
(building a result inside an argument, e.g. `(cons x (f …))`) can
still exhaust the stack.

## 4. Special forms

The irreducible core. Each is special because it does not evaluate all
its arguments, or it controls the environment.

| Form | Meaning |
|------|---------|
| `(quote x)` | `x`, unevaluated. |
| `(quasiquote t)` | `t` with `unquote`/`unquote-splicing` filled in. |
| `(if test then else?)` | Conditional; missing `else` yields `nil`. |
| `(define name value)` | Bind a value in the current environment. |
| `(define (name . params) doc? body…)` | Define a procedure. A leading string literal is its docstring. |
| `(lambda params body…)` | An anonymous procedure. |
| `(let ((n v)…) body…)` | Bindings evaluated in the outer scope. |
| `(let name ((n v)…) body…)` | Named let: `name` is bound, over the body only, to a procedure of the variables; calling it loops, tail-call optimised. Inits evaluate in the outer scope. |
| `(let* …)` | Each binding sees the previous ones. |
| `(letrec …)` | All names visible to all bindings (mutual recursion). |
| `(set! name value)` | Assign to the nearest existing binding. |
| `(begin body…)` | Evaluate in sequence; yield the last. |
| `(cond (test body…)… (else body…))` | First true clause wins. |
| `(and …)` `(or …)` | Short-circuiting logic. |
| `(try body… (catch name handler…)? (finally cleanup…)?)` | Error handling and unwind protection (§7); at least one clause. |
| `(defmacro name params body…)` | Define a macro (§5). |
| `(module name body…)` | Define a module (§6). |
| `(import name)` | Bring a module's exports into scope (§6). |

Special-form names are resolved before macros and bindings; they are
not shadowable in v0.

## 5. Macros

A macro is a procedure from source forms to a source form, run during
evaluation. `defmacro` defines one; its parameters bind to the
*unevaluated* argument forms, and its result is evaluated in place.

```lisp
(defmacro unless (test . body)
  (list 'if test 'nil (cons 'begin body)))
```

Macros are **procedural and non-hygienic** in v0. A macro that
introduces a binding can capture a caller's identifier of the same
name. The classic hazard:

```lisp
(defmacro swap! (a b)                 ; uses an internal `tmp`
  `(let ((tmp ,a)) (set! ,a ,b) (set! ,b tmp)))
(swap! tmp y)                         ; the caller's own `tmp` is captured
```

Until hygiene lands, macro authors must use `gensym` for introduced
names.

**Planned:** `syntax-case`-style hygienic macros, the design plan's
stated target. Procedural `defmacro` was chosen for v0 deliberately: it
yields a working macro system immediately, and because no macro-heavy
standard library exists yet, the upgrade is cheap. Careful macros
(`gensym` for temporaries) will survive the transition unchanged.

## 6. Modules

First-class modules give code a private namespace and an explicit
interface.

```lisp
(module geometry
  (export area)
  (define pi 3.14159)               ; private to the module
  (define (area r) (* pi r r)))     ; exported

(import geometry)
(area 2)                             ; => 12.56636
```

A module's body is evaluated in a fresh environment — a child of the
base environment, so it sees the primitives and the prelude, but **not**
the global environment or other modules. `(export …)` forms, which may
appear anywhere in the body, name the bindings the module offers.
`(import name)` copies a module's exported bindings into the current
environment; it works at the top level or inside another module's body.

Module names are plain symbols in v0; hierarchical names like
`(lang core)` are **Planned**.

### Hot reload

Re-evaluating `(module name …)` reuses the module's existing
environment rather than creating a new one (clearing it first, so
removed definitions disappear). Because the evaluator resolves names
late, every procedure that closes over that environment — the module's
own procedures, and anything still calling into them — picks up the new
definitions at once.

An importer holds a *snapshot* of what it imported, so a redefined
*export* is stale until the module is imported again. A redefined
*private helper*, by contrast, is seen immediately: the exported
procedures resolve it through the reused module environment.

The editor uses this. `reload-stdlib` (bound to `C-x C-r`) re-evaluates
the standard library, and the running editor switches to the new
command definitions without a restart.

## 7. Errors and conditions

An error is signalled with `(error message irritant…)` and is a
`LispError` at the host level.

`(try body… (catch name handler…)? (finally cleanup…)?)` — clauses in
that order, each optional, at least one present — evaluates the body;
if a `LispError` is raised and a `catch` clause is present, `name` is
bound to a **condition** — a map with `:message` (string), `:irritants`
(list) and, when known, `:line`/`:column` — and the handler runs.
The `finally` cleanup forms run on *every* exit — normal completion, a
caught error (after the handler), an error propagating out, even a raw
JS exception from a host primitive — their values are discarded, and an
error raised inside them replaces the propagating one (JS semantics).

```lisp
(try (error "no such buffer" 'scratch)
     (catch e (get e :message)))      ; => "no such buffer"

(try (rename-buffer!)
     (finally (end-change-group!)))   ; cleanup runs even on error
```

**Planned:** the full Common Lisp condition/restart system as the
underlying machinery, with `try`/`catch` remaining the everyday
surface. Result-typed low-level APIs are also planned.

## 8. Concurrency model

**Planned — not implemented.** The intended model is coroutines and
CSP-style channels, presented cleanly to the user and implemented on
JavaScript's async/await. The editor does not need user-level
concurrency to be useful, so this is deferred; the runtime is
synchronous in v0.

## 9. JavaScript interop

Today, interop runs host-to-Lisp: `createInterpreter({ primitives })`
registers JavaScript functions as Lisp primitives. The editor uses this
to expose buffer operations (§11). Each primitive receives an array of
evaluated arguments.

Value conversion at the boundary: Lisp numbers, strings and booleans
*are* the JavaScript equivalents; Lisp lists ↔ JS arrays via
`listToArray`/`arrayToList`; vectors are JS arrays; maps are JS `Map`s.
Symbols and keywords are opaque to JavaScript unless converted.

**Planned:** the Lisp-to-JavaScript direction — `(js/call "Math.floor"
3.7)` and importing JavaScript modules — and a documented
`editor.lisp.eval(...)` entry from JavaScript.

## 10. Standard library overview

~80 primitives ship in `primitives.js`, grouped: arithmetic; numeric
comparison; type predicates; equality (`eq?`, `equal?`); pairs and
lists; higher-order (`map`, `filter`, `reduce`, `apply`, `range`,
`sort`); strings; vectors; maps; output (`print`, `display`,
`newline`); `error`; introspection (`type-of`, `doc`, `where-defined`,
`describe`); and macro expansion (`macroexpand-1`, `macroexpand`).

A small **prelude** (`when`, `unless`, the loop macros `while` /
`dotimes` / `dolist`, `caar`/`cadr`/…, `second`, `third`, `any?`,
`every?`) is written in Lisp and dogfoods the macro system.

Naming conventions:

- Predicates end in `?` — `nil?`, `even?`, `string?`.
- Destructive operations end in `!` — `set!`, `insert!`.
- Module-internal helpers lead with `-` (convention; not enforced).

## 11. Self-documentation

Per the project's "the editor explains itself" principle, every
procedure defined with `define` keeps its docstring and source
location:

- `(doc proc)` — the docstring, or `nil`.
- `(where-defined proc)` — the `"line:col"` it was defined at.
- `(describe proc)` — a map of name, parameters, docstring, location.

## 12. Host integration

The interpreter exposes the editor's L2 buffer through host primitives
registered by the desktop app. They share the buffer the editor view
displays, so evaluating them in the REPL edits the visible document:

| Primitive | Effect |
|-----------|--------|
| `(buffer-text)` | The buffer's contents. |
| `(buffer-length)` | Character count. |
| `(buffer-line-count)` | Line count. |
| `(buffer-name)` | The buffer's name. |
| `(point)` | The cursor offset. |
| `(buffer-substring a b)` | Text in `[a, b)`. |
| `(goto! n)` | Move the cursor to offset `n`. |
| `(insert! s)` | Insert `s` at the cursor. |
| `(delete-backward! n?)` / `(delete-forward! n?)` | Delete around the cursor. |

This set is a v0 floor. As the standard library grows, the editor's
commands — and its keymap — will be defined in Lisp on top of it.

**Markers.** `(make-marker offset?)` creates an edit-tracking position
in the current buffer (default: point) and returns an opaque handle
that carries its buffer. `(marker-position m)` reads its current
offset — correct under intervening edits, and readable even when the
marker's buffer is not current. `(set-marker! m offset)` moves it, but
only while its buffer is current; `(marker-buffer-current? m)` tests
that. Markers cost incremental work per edit, so they must be released:
`(release-marker! m)` detaches one (safe to call twice; every other
operation on a released marker raises). Lisp code normally reaches
markers through the editing.lisp macros `with-marker` — which releases
on every exit — and `save-excursion`, which restores point through a
marker. Overlays are deferred.

---

## Deferred — a single list

For quick reference, what this spec marks **Planned / not yet built**:

1. Hygienic (`syntax-case`) macros — §5.
2. Conditions and restarts — §7.
3. The concurrency model — §8.
4. Lisp-to-JavaScript interop (`js/call`, JS module import) — §9.
5. Source positions on atoms; set literals — §2.
6. Hierarchical module names — §6.

None of these change the language's settled core; each is an additive
layer. The core — scoping, evaluation, the special forms — is fixed.
