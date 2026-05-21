# Sub-Plan: Lisp Specification

## Purpose

The Lisp specification documents the language you're building from scratch. This is the one design artifact that requires your judgement and can't be delegated. Decisions here compound — getting them wrong is expensive to undo.

The spec doesn't need to be complete before implementation starts. It needs the **core semantic decisions** settled and clearly documented. Standard library and syntactic sugar can evolve.

## Process

Spend a few focused sessions (a handful of hours total, not weeks) drafting the spec. The spec is for *you*; it can be informal where formality isn't earning its keep.

A useful exercise: write a one-page example of "what idiomatic code in this Lisp looks like" before formalising the spec. Show a buffer manipulation, a mode definition, a macro definition, a module declaration, an error handler. If you can write that page and feel good about it, the design is probably right.

## Decisions That Must Be Made

These compound — make them consciously.

### Scoping
**Lexical, full stop.** No dynamic scoping by default. If you want parameterize-style dynamic binding, provide it as an explicit construct (Racket's `parameterize` is the model). Every Lisp designed after 1985 agrees on this; the only reason this is even worth noting is that Elisp got it wrong and it took decades to partially fix.

### Evaluation order
**Applicative order, left-to-right argument evaluation.** Standard, predictable, what every Lisp programmer expects.

### Mutability defaults
**Immutable by default, mutation explicit.** Persistent data structures for lists, vectors, maps. A `set!` or `mut!` construct that's clearly visible at call sites. Clojure's design is the model.

### Module system
**First-class modules with explicit imports and exports.** Each file declares its module identity and what it exports; importers list what they want. No globals across module boundaries.

Minimum viable module declaration:
```
(module foo
  (export bar baz quux)
  (import (lang core) (lang buffer))

  (define (bar ...) ...)
  ...)
```

### Macro system
**Hygienic by default, syntax-case style.** The case for syntax-case over syntax-rules: full power, hygiene by default, escape hatches when needed. This is the right answer for a Lisp meant to be deeply extended. The Dybvig papers are the canonical reference.

The simpler `syntax-rules` style is tempting because it's safer to teach, but you're not building a teaching language. You're building an extension language for power users.

### Type system
**Dynamically typed.** Optional type annotations later as a documentation/runtime-check mechanism, never as full gradual typing. Plain dynamic typing is what every successful Lisp has shipped.

### Concurrency primitives
**Design for coroutines + channels (CSP-style), implement on top of JavaScript's async/await.** Users see a clean model; the runtime handles host plumbing.

Can be deferred past week three if needed — the editor doesn't need user-level concurrency to be useful — but the runtime needs to be non-blocking from the start, which is a separable concern.

### Error handling
**Layered: result types at the low level, try/catch as the everyday surface, conditions/restarts as the underlying machinery available when you need it.** Common Lisp's condition system is more powerful than try/catch, but users who don't know to reach for it should be able to ignore it.

### Reader syntax
S-expressions with literal extensions:
- Numbers (integers, floats)
- Strings with standard escapes
- Symbols and keywords (keywords prefixed with `:`, self-evaluating)
- Quote, quasiquote, unquote, unquote-splicing
- Vector literals: `[1 2 3]`
- Map literals: `{:a 1 :b 2}` (Clojure-style)
- Set literals: `#{1 2 3}` (optional)

Avoid the temptation to invent novel syntax. Every novel choice costs you readers' familiarity.

### JavaScript interop
Since the editor exposes both Lisp and JavaScript as extension languages, the Lisp spec needs to address calling JavaScript from Lisp and vice versa.

Value conversion rules: Lisp numbers ↔ JS numbers; Lisp strings ↔ JS strings; Lisp lists ↔ JS arrays; Lisp maps ↔ JS objects (or Maps); Lisp booleans ↔ JS booleans. Lisp symbols become opaque from JS unless explicitly converted. Functions in either direction are callable but not introspectable across the boundary.

Concretely: `(js/call "Math.floor" 3.7)` from Lisp calls a JavaScript function. `(import :js other-module)` imports a JavaScript module's exports. From JS, `editor.lisp.eval('(...)')` evaluates Lisp code.

The detailed interop API can be designed alongside the implementation, but the principle is settled: clean conversion for data, opaque for functions/closures.

### Naming conventions
- Predicates: `foo?` (Clojure/Scheme style), not `foop`
- Destructive operations: `foo!` suffix
- Module-internal helpers: lead with `-`, e.g., `-helper`
- Constants: just lowercase, no special syntax

## Self-Documentation Principle

Emacs's killer feature is that you can ask the editor about itself. Build this in from the start:

- Every function carries source location, arglist, and docstring as introspectable metadata
- A primitive `describe-function` returns this metadata
- The reader preserves source positions on every form for error reporting
- A primitive `where-defined` works for any symbol

These aren't separate features added later. They're built into how `define` works.

## What Goes In The Spec Document

Structure for `docs/spec/lisp.md`:

1. **Introduction and design principles** — what this language is for
2. **Lexical structure** — characters, tokens, reader syntax
3. **Evaluation model** — environments, scoping, evaluation order
4. **Special forms** — the irreducible core (define, lambda, if, set!, quote, quasiquote, let, letrec, begin)
5. **Macros** — how syntax-case works, hygiene rules
6. **Modules** — declaration, import, export, resolution, hot reload semantics
7. **Errors and conditions** — how errors are signalled, caught, restarted
8. **Concurrency model** — coroutines, channels, host integration (can be stubbed initially)
9. **JavaScript interop** — value conversion, calling conventions
10. **Standard library overview** — what's in core, what's in extensions, naming conventions
11. **Host integration** — how Lisp talks to the editor (the L2 API surface as seen from Lisp)

Initial draft can be short — a few pages covering each section. The goal of the first draft is to have *every* section addressed even if briefly, so the shape is visible.

## When You're Done (For Now)

The spec is "done enough" to start implementation when:

- An example program of ~50 lines, exercising functions, modules, macros, and error handling, can be written and you're confident about exactly how each piece evaluates
- The special forms list is fixed and you can explain why each one is special rather than a macro or library function
- The macro system rules are clear enough to correctly hand-expand a non-trivial macro
- The module system rules are clear enough to describe what happens when two modules import each other

It's *not* done when the standard library is fully specified, when every edge case is resolved, or when the optimisation strategy is settled. Those follow.

## Mistakes to Watch For

- **Trying to be Scheme, Common Lisp, AND Clojure simultaneously.** Pick a primary influence and let it dominate. Recommended: Scheme/Racket for semantics, Clojure for data structures and idiom, Common Lisp for condition system. But Scheme dominates.

- **Over-designing the type system.** Defer almost entirely. Dynamic typing is fine.

- **Inventing novel syntax.** Resist.

- **Coupling spec to implementation.** The spec describes the language. Implementation hints can go in comments.

- **Premature stdlib expansion.** Lock down core (special forms, fundamental modules); let everything else grow over time.

## The Self-Test

Before declaring the spec ready for implementation, write a short program that does:

1. Defines a module
2. Imports something from another module
3. Defines a macro using syntax-case
4. Defines a function that takes a buffer and returns a count of lines
5. Defines a command that uses the function
6. Handles an error if the buffer doesn't exist

If you can write that program and you're satisfied with how it reads, the spec is ready.
