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

**Not yet:** tail-call optimisation. Deep non-tail recursion can
exhaust the JavaScript stack. Editor command code is not deeply
recursive, so this is acceptable for v0; a trampoline can be added
without language-visible change.

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
| `(let* …)` | Each binding sees the previous ones. |
| `(letrec …)` | All names visible to all bindings (mutual recursion). |
| `(set! name value)` | Assign to the nearest existing binding. |
| `(begin body…)` | Evaluate in sequence; yield the last. |
| `(cond (test body…)… (else body…))` | First true clause wins. |
| `(and …)` `(or …)` | Short-circuiting logic. |
| `(try body… (catch name handler…))` | Error handling (§7). |
| `(defmacro name params body…)` | Define a macro (§5). |

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

**Planned — not implemented.** v0 uses a single global environment.

The intended design (from the plan): first-class modules with explicit
imports and exports, no implicit globals across boundaries:

```lisp
(module editing
  (export forward-word backward-word)
  (import (lang core) (lang buffer))
  …)
```

Hot reload — re-evaluating a module updates definitions in the running
editor — is a module-system concern and is likewise planned.

## 7. Errors and conditions

An error is signalled with `(error message irritant…)` and is a
`LispError` at the host level.

`(try body… (catch name handler…))` evaluates the body; if a
`LispError` is raised, `name` is bound to a **condition** — a map with
`:message` (string) and `:irritants` (list) — and the handler runs.

```lisp
(try (error "no such buffer" 'scratch)
     (catch e (get e :message)))      ; => "no such buffer"
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

~75 primitives ship in `primitives.js`, grouped: arithmetic; numeric
comparison; type predicates; equality (`eq?`, `equal?`); pairs and
lists; higher-order (`map`, `filter`, `reduce`, `apply`, `range`);
strings; vectors; maps; output (`print`, `display`, `newline`);
`error`; and introspection (`type-of`, `doc`, `where-defined`,
`describe`).

A small **prelude** (`when`, `unless`, `caar`/`cadr`/…, `second`,
`third`) is written in Lisp and dogfoods the macro system.

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

---

## Deferred — a single list

For quick reference, what this spec marks **Planned / not yet built**:

1. Hygienic (`syntax-case`) macros — §5.
2. Tail-call optimisation — §3.
3. The module system and hot reload — §6.
4. Conditions and restarts — §7.
5. The concurrency model — §8.
6. Lisp-to-JavaScript interop (`js/call`, JS module import) — §9.
7. Source positions on atoms; set literals — §2.

None of these change the language's settled core; each is an additive
layer. The core — scoping, evaluation, the special forms — is fixed.
