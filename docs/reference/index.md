Title: jmacs Function Reference
Author: J. McKenzie Alexander
Date: 2026-05-22
---

## jmacs Function Reference

This is the per-function reference for jmacs. It documents, one by one,
the procedures you can call from the editor's Lisp. For the editor as a
whole — how to use it, how to extend it — read `docs/MANUAL.jmd`. For
the language itself, read `docs/spec/lisp.md`.

The reference is hand-written prose, kept deliberately separate from the
manual so that it can be maintained against the code as the code
changes. When you add or change a procedure, update its entry here in
the same commit.

### The tiers

A procedure callable from jmacs Lisp belongs to one of four tiers. They
differ in where they are defined and how stable they are.

| Tier | Defined in | Documented in |
|------|-----------|---------------|
| Core primitives | `packages/lisp/src/primitives.js` (JavaScript) | `lisp-core.jmd` |
| The prelude | `packages/lisp/src/interpreter.js` (Lisp) | `lisp-core.jmd` |
| Buffer primitives | `packages/stdlib/src/buffer-primitives.js` (JavaScript) | `buffer-primitives.jmd` |
| Standard-library commands | `packages/stdlib/lisp/*.lisp` (Lisp) | `commands.jmd` |

- *Core primitives* are the language's foundation — arithmetic, lists,
  strings, maps, higher-order procedures. They have no knowledge of the
  editor and would be present in any program written in this Lisp.
- *The prelude* is a small amount of Lisp layered on the primitives at
  startup — a few control-flow macros and list accessors. It dogfoods
  the macro system.
- *Buffer primitives* are the bridge from Lisp to the L2 buffer:
  movement, editing, selection, history. They are the floor the
  standard library is built on. They are JavaScript, but they are
  *called* as ordinary Lisp procedures.
- *Standard-library commands* are the editor's actual behaviour,
  written in Lisp on top of the buffer primitives. This is the layer
  you redefine to change the editor.

The split matters when something breaks or needs changing: a command is
Lisp you can edit and hot-reload (`C-x C-r`); a primitive is JavaScript
in a package, changed and tested like any host code.

### Naming conventions

The names follow the conventions set out in `docs/spec/lisp.md` §10:

- *Predicates end in `?`* — `nil?`, `even?`, `string?`,
  `region-active?`. They return a boolean.
- *Destructive operations end in `!`* — `set!`, `insert!`,
  `goto!`. They mutate something: a binding, or the buffer. The buffer
  primitives are systematically `!`-suffixed; the Lisp commands that
  wrap them mostly are not, because a *command* is a unit of editing
  intent rather than a raw mutation.
- *Module-internal helpers lead with `-`* — `-keymap-commands`. A
  convention, not enforced.
- *Conversions are written `from->to`* — `string->symbol`,
  `number->string`, `vector->list`.

A note on the editing layer: many commands have a near-namesake buffer
primitive — the command `forward-char` calls the primitive
`cursor-right!`, `undo` calls `undo!`. The command is the layer the
keymap binds and the layer you redefine; the primitive is the host
operation underneath. Both are documented, in `commands.jmd` and
`buffer-primitives.jmd` respectively.

### How to read an entry

Each entry gives the procedure's call form, then describes it:

> ### `procedure-name`
> `(procedure-name arg1 arg2)`
>
> What it does. What it returns. Key binding, if it has one. Notes,
> caveats, and related procedures.

An argument shown in brackets — `(delete-backward [n])` — is optional.
A trailing `…` — `(str x …)` — means the procedure is variadic.

Where a command is bound to a key, the entry names the binding using
the key-string notation from the manual (§5): `C-` is Control or
Command, `M-` is Option, `S-` is Shift.

### Self-documentation

This written reference is the companion to the editor's *built-in*
self-documentation. Every procedure defined with `define` carries its
docstring and source location, reachable at runtime:

- `(doc proc)` — the docstring, or `nil`.
- `(where-defined proc)` — the `"line:col"` it was defined at.
- `(describe proc)` — a map of name, parameters, docstring and location.

And interactively: `C-h k` describes the command bound to a key, `C-h
f` describes a command by name. When this reference and a docstring
disagree, the docstring is what the running editor will tell you — and
one of the two needs fixing.

### The documents

- `commands.jmd` — the standard-library commands, grouped by task.
- `buffer-primitives.jmd` — the host buffer primitives.
- `lisp-core.jmd` — the core primitives and the prelude.
