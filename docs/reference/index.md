Title: Godot Function Reference
Author: J. McKenzie Alexander
Date: 2026-07-21
---

## Godot Function Reference

This is the per-function reference for Godot. It documents, one by one,
the procedures you can call from the editor's Lisp. For the editor as a
whole — how to use it, how to extend it — read the manual
(`docs/MANUAL.jmd`). For the language itself, read `docs/spec/lisp.md`.

The reference is hand-written prose, kept deliberately separate from the
manual so that it can be maintained against the code as the code
changes. When you add or change a procedure, update its entry here in
the same commit.

### The tiers

A procedure callable from Godot Lisp belongs to one of five tiers. They
differ in where they are defined and how stable they are.

| Tier | Defined in | Documented in |
|------|-----------|---------------|
| Core primitives | `packages/lisp/src/primitives.js` (JavaScript) | `lisp-core.md` |
| The prelude | `packages/lisp/src/interpreter.js` (Lisp) | `lisp-core.md` |
| Buffer primitives | `packages/stdlib/src/buffer-primitives.js` (JavaScript) | `buffer-primitives.md` |
| Server primitives | `apps/desktop/mwb/spine.js` (JavaScript) | `buffer-primitives.md`; the pane and view ones in `panes.md` and `views.md` |
| Standard-library commands | `packages/stdlib/lisp/*.lisp` (Lisp) | `commands.md` and the feature files below |

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
- *Server primitives* are the desktop application's own additions,
  registered in the Lisp server (the *spine*): the echo area, the
  minibuffer, files, views, panes, search, overlays, processes — a
  hundred-odd procedures in all. The line between this tier and the
  one above is portability: a buffer primitive needs only an L2
  buffer; a server primitive needs the running application.
- *Standard-library commands* are the editor's actual behaviour,
  written in Lisp on top of the primitives. This is the layer you
  redefine to change the editor.

One wrinkle: a handful of commands live not in
`packages/stdlib/lisp/*.lisp` but in Lisp embedded directly in the
spine — cmd(execute-command), cmd(find-file), cmd(switch-view),
cmd(list-views), cmd(kill-view), cmd(quit-editor), cmd(describe-key),
cmd(describe-command), cmd(scratch-buffer), the view-cycling and
sticky-note commands. They are ordinary `defcommand`s; they are
embedded because their prompts are host-completed or their effects
ride the directive channel. They are documented alongside their
stdlib siblings.

The split matters when something breaks or needs changing: a command
is Lisp you can read and edit — though today an edit to a
standard-library file takes effect on the next app launch (the old
`C-x C-r` hot-reload no longer exists, and the key is unbound) —
while a primitive is JavaScript in a package, changed and tested like
any host code.

### Where the code runs

Godot runs one Lisp world, in a server process; the editor windows
are thin clients. Every procedure in this reference — every tier —
executes in the server, against the server's buffers. When a
procedure's effect is something a *window* shows (a scroll, a dock
panel, a prompt), the server emits a *directive* and the client
performs the visual half. You rarely need to think about this while
scripting, but it explains two things you will notice: prompting
commands suspend and resume via a callback, and a few operations
(sticky notes, for instance) are directive-only and cannot return
values to Lisp. The dispatch model is documented in
`docs/MODEL-B-DISPATCH.md`; `docs/MAP.md` is the index to the
architecture docs generally.

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
operation underneath. Both are documented, in `commands.md` and
`buffer-primitives.md` respectively.

Commands and primitives share *one* namespace. `defcommand` defines an
ordinary procedure and registers its name in the command registry, so
defining a command with the same name as a primitive shadows the
primitive — deliberately, on occasion; by accident, memorably. The
registry is also what `M-x` completes against: a procedure defined
with plain `define` is callable from Lisp but invisible to `M-x`. If
you want it in the palette, declare it with `defcommand`.

### Value conventions

Two conventions hold across every entry, so the entries do not repeat
them:

- *Offsets are zero-indexed character positions*, and ranges are
  half-open — `[start, end)` includes `start` and excludes `end`. A
  buffer of length 10 has valid offsets 0 through 10 (offset 10 is
  the position after the last character, where `point-max` points).
- *Absence is `#f`; emptiness is `nil`.* This Lisp's `nil` is truthy —
  only `#f` is false — so a procedure that looked something up and
  found *nothing there* returns `#f`, which a bare `if` tests
  correctly: `doc`, `where-defined`, `find-view`, `mark` when unset,
  the search primitives. A procedure that returns *the empty thing*
  keeps `nil`: the rest of an empty list is nothing, not a miss. A
  few entries return `nil` on a miss for historical reasons; each
  says so, with the safe test to use instead. The full statement of
  the convention is in `docs/spec/lisp.md` §10.

### How to read an entry

Each entry gives the procedure's call form, then describes it:

> ### `procedure-name`
> `(procedure-name arg1 arg2)`
>
> What it does. What it returns. Key binding, if it has one. Notes,
> caveats, and related procedures.

An argument shown in brackets — `(make-marker [offset])` — is optional.
A trailing `…` — `(str x …)` — means the procedure is variadic.

A command that needs arguments declares how it gathers them with an
`(interactive …)` clause: `(interactive (string "Replace: "))` reads a
string in the minibuffer, `(number …)` a number, and the descriptors
`point`, `region` and `region-or-buffer` supply positions without
prompting. A cancelled prompt means the command simply does not run.
The dispatch machinery — `defcommand`, `run-command`, the interactive
argument gatherer — is documented in `commands.md`.

Where a command is bound to a key, the entry names the binding using
the key-string notation from the manual's "Keys and commands" chapter:
`C-` is Control, `M-` is Command (the Meta of Emacs custom), `A-` is
Option/Alt, `S-` is Shift, and stacked modifiers are written in that
fixed order — `C-M-A-S-`. An `A-` chord the keymap does not bind falls
through to the character Option composes, so accents and curly quotes
keep working.

### Self-documentation

This written reference is the companion to the editor's *built-in*
self-documentation. Every procedure defined with `define` (or
`defcommand`) carries its docstring and source location, reachable at
runtime:

- `(doc proc)` — the docstring, or `#f`.
- `(where-defined proc)` — the `"line:col"` it was defined at, or `#f`.
- `(describe proc)` — a map with `:kind`, `:name`, `:params`, `:doc`
  and `:defined-at` (a primitive or macro reports `:kind` and `:name`
  only).

And interactively, on the `C-h` help prefix: cmd(describe-key)
(`C-h k`) describes the command bound to a key,
cmd(describe-command) (`C-h f`) describes a command by name,
cmd(apropos-doc) (`C-h a`) searches every docstring,
cmd(describe-symbol-at-point) (`C-h .`) describes the symbol under the
cursor, cmd(open-manual) (`C-h d`) opens the in-app manual, and
cmd(describe-face-at-point) (`C-h F`) and
cmd(highlight-construct-at-point) (`C-h C-f`) inspect and style the
faces at point. The help surface is documented in
`help-and-config.md`.

When this reference and a docstring disagree, the docstring is what
the running editor will tell you — and one of the two needs fixing.

### The documents

- `commands.md` — the standard-library commands, grouped by task:
  movement, editing, the kill ring, files, and the dispatch machinery
  itself.
- `buffer-primitives.md` — the buffer primitives, and the server
  primitives the desktop app registers in the spine.
- `lisp-core.md` — the core primitives and the prelude: the language,
  independent of the editor.
- `panes.md` — the layout commands: panes, windows, and tablines.
- `views.md` — the non-text views and tools: shells, notebooks, the
  directory browser, and their commands.
- `productivity.md` — the editing amplifiers: multiple cursors,
  snippets, sticky notes, inline evaluation.
- `search-and-edit.md` — search, replace, structural navigation, and
  whole-line editing beyond the basics.
- `latex.md` — the LaTeX authoring commands and the RefTeX layer for
  labels, references and citations.
- `help-and-config.md` — help, bookmarks, faces, customization, the
  REPL panel, and crash recovery.
