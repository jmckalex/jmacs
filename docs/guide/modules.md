## Modules and Program Structure

A session's worth of definitions can live happily at top level. A
*library* cannot: it accumulates helpers, constants, working state —
names that are nobody's business but its own, sharing one global
namespace with a few hundred commands and primitives. The language's
answer is the *module*: a private namespace with an explicitly
declared interface. This chapter gives the module forms their precise
rules, then the property that makes them more than a tidiness device
— hot reload — and then climbs up a level: how the editor's own Lisp
is arranged on disk, where your code goes, and when a module is the
right shape for it.

> *A module keeps its names to itself; an import is a copy; a reload
> is the same room with new furniture.*

### Why Modules: Private Helpers, Public Names

Here is a small library, worked end to end:

```lisp
(module geometry
  (export area circumference)
  (define pi 3.141592653589793)
  (define (square n) (* n n))
  (define (area r) (* pi (square r)))
  (define (circumference r) (* 2 pi r)))
; ⇒ geometry

(import geometry)    ; ⇒ geometry
(area 2)             ; ⇒ 12.566370614359172
(circumference 1)    ; ⇒ 6.283185307179586
pi                   ; error: unbound symbol: pi
(square 3)           ; error: unbound symbol: square
```

Four names are defined; two escape. `pi` and `square` are
implementation — `area` and `circumference` use them freely, but no
code outside the module can see them, collide with them, or come to
depend on them. The `export` line is the whole interface, readable
at a glance: inside, you name things for your own convenience;
outside, you publish only what you mean to support.

### The Module Forms, Rule by Rule

Three forms carry the system: `module`, `export`, and `import`. Two
of them are special forms; `export` is a declaration recognised only
inside a `module` body.

#### A Fresh Environment under Base

```lisp
(module name body…)
```

`name` must be a symbol. The body forms are evaluated in order, in a
**fresh environment whose parent is the base environment** — the one
holding the core primitives, the prelude (`when`, `unless`, `cadr`,
and friends), and every host primitive. The crucial word is *base*:
the module's environment is **not** a child of the global
environment, so the body sees none of your top-level definitions, no
other module's private names — and none of the macros the standard
library defines at top level, `defcommand` and `define-mode` among
them. A module is built from the language and the editor's
primitives, not from whatever your session happens to contain. The
form returns the name symbol.

The isolation is easy to trip over, so here it is failing:

```lisp
(define limit 10)        ; a top-level binding

(module clamp-lib
  (export clamp)
  (define (clamp n) (min n limit)))
; ⇒ clamp-lib — defining the module succeeds…

(import clamp-lib)
(clamp 3)                ; error: unbound symbol: limit
```

Defining the module succeeds because `clamp`'s body does not run
yet; the error arrives at the first call, when lookup walks `clamp`'s
environment chain — the module's environment, then base — and finds
no `limit` anywhere on it. Had the body referenced `limit` directly,
say `(define ceiling-value limit)`, the same error would have arrived
at module-definition time. Either way the cure is the same: a module
that needs an outside value takes it as an argument, or defines its
own. Two smaller facts: the body is evaluated eagerly — not a tail
position, so a deep recursion at module top level should live inside
a function — and a module *can* use other modules, since an `import`
inside the body copies the other module's exports into this one's
environment. That is how libraries layer.

#### Export Declarations Anywhere in the Body

```lisp
(export name…)
```

Any number of `export` forms may appear anywhere in the body — first
line, last line, scattered next to the definitions they publish. They
are declarations, not code: the module form collects the names and
removes the `export` forms before evaluating anything. Each name must
be a symbol (`module: exported names must be symbols` otherwise).

Exports are not checked against the definitions at module time:
exporting a name the body never defines goes unnoticed until someone
imports the module, then fails as `unbound symbol: <name>`. Outside
a module body, `export` has no meaning at all — a top-level
`(export x)` is an ordinary application of an unbound symbol, and
raises `unbound symbol: export`.

#### Importing Copies the Exported Bindings

```lisp
(import name)
```

`import` takes exactly one symbol, looks the module up in the
registry (`no such module: <name>` if it was never defined), and
**copies each exported binding's current value into the current
environment frame** — at top level, inside another module's body, or
any other scope where the form is evaluated. The copies shadow any
same-named bindings already in that frame. The form returns the
module-name symbol.

And it is all-or-nothing: there is no selective import, no renaming on
import, and no un-import — one form, the whole export list, into the
current frame. The word *copies* is load-bearing; the next section is
about what it costs.

#### Module Names and Return Values

Module names are plain symbols in one flat registry: `geometry`,
`my-snippets`, `reftex-extras`. Defining a module under an existing
name replaces the registry entry — deliberately so; that is the hot
reload mechanism below, but it also means two libraries cannot share
a name, so name modules specifically. Hierarchical names in the
`(lang core)` style are planned but not implemented. Both `module`
and `import` return the name symbol — the same convention as
`define` — which is why the REPL answers a module definition with
`geometry` rather than a value. (One note for embedders: the registry
lives on the interpreter's *root* environment, where the full
interpreter always installs it. A hand-rolled evaluator without one
raises `the module system is not available` on the first `module`
form; in the editor you will never see that error.)

### Imports Are Snapshots

An importer holds *copies* of the exported values, not references to
the module's names. If the module is evaluated again and an exported
name is rebound, every earlier import keeps the old value until it
imports again:

```lisp
(module counter-fmt
  (export label)
  (define (label n) (str "item " n)))
(import counter-fmt)
(label 1)              ; ⇒ "item 1"

;; Re-evaluate the module with a changed export…
(module counter-fmt
  (export label)
  (define (label n) (str "entry " n)))
(label 1)              ; ⇒ "item 1" — the import is a stale snapshot

(import counter-fmt)   ; take a fresh copy
(label 1)              ; ⇒ "entry 1"
```

The rule follows directly from what `import` does: it bound the
*value* of `label` into your frame, and rebinding the name inside
the module's environment cannot reach a copy that already left. That
sounds like a flat "reloads don't propagate" — but it is not, and
the twist is the best part of the module system.

### Hot Reload: the Reused Module Environment

Re-evaluating `(module name …)` for a name that already exists does
**not** build a fresh namespace. It *reuses the module's existing
environment object*, clearing it first, then evaluates the new body
into it. Two consequences fall out. **Removed definitions
disappear**: if the new body no longer defines a helper, surviving
code that calls it raises `unbound symbol: <helper>` — no ghost of
the old load. And **procedures that close over that environment see
the new definitions at once**: a procedure remembers the environment
it was defined in, and the evaluator resolves the names in its body
*late* — at call time, by walking that environment chain (see *The
Evaluation Model*) — and the chain still ends at the very
environment object the reload just refilled.

Put the two together and you get a precise, slightly surprising
rule: **a redefined private helper is picked up immediately, even
through a stale imported wrapper — while a redefined export needs a
re-import.** Watch it happen:

```lisp
(module greeter
  (export greet)
  (define (greet) (-message))
  (define (-message) "hi"))
(import greeter)
(greet)    ; ⇒ "hi"

;; Reload, changing only the private helper.
(module greeter
  (export greet)
  (define (greet) (-message))
  (define (-message) "hello"))
(greet)    ; ⇒ "hello" — no re-import needed
```

Your `greet` is still the old copy — the snapshot rule has not been
repealed. But when it runs, it looks up `-message` through the
module's environment, the reload reused that environment, and the
lookup finds the new helper. The snapshot is the procedure *object*;
everything the procedure *names* is resolved live. The practical
habit: change a helper, just reload the module; change an export's
own definition, reload and re-import.

The editor is built on exactly this property, one level up. Its whole
Lisp world — standard library, your configuration, every command —
lives in one long-running interpreter (in the *server*; the next
section says where), and the stdlib's files are plain top-level
Lisp rather than modules, so re-evaluating a definition rebinds a name
in the global environment. Late name resolution does the rest: keymaps
hold command *symbols* looked up at dispatch time (the same late
resolution *Writing Macros* closes on), so redefine a
command at the REPL (`C-x p`, cmd(toggle-repl)) and the very next
press of its key runs the new definition. The same goes for a module
re-evaluated at the REPL: the reload lands in the running editor, no
restart, no lost session.

### How the Editor's Own Lisp Is Organised

One fact orients everything else: the editor's single Lisp world runs
in the *server* — the long-lived process behind every window; the
manual's architecture chapter, *How Godot is built*, draws the whole
picture — and each window is a thin client of it. The standard
library, your configuration, the REPL, every command a keystroke
dispatches: all of it evaluates in that one interpreter. Knowing its
load order makes the editor's source legible — and tells you what
your own code can rely on having loaded before it. At startup the
server (`apps/desktop/mwb/spine.js`) assembles its world in this
sequence:

1. **The curated standard library** — the files named, in order, in
   the server's `SPINE_STDLIB` list, the order-sensitive entries
   commented with why they sit where they sit. `commands.lisp` is
   first, because every later file declares its commands with
   `defcommand`; `keymap.lisp` loads
   early — right after the face and theme registries — because the
   server is the sole key resolver and everything about dispatch is
   Lisp. This load is strict: an error in one of these files aborts
   the server's startup rather than being skipped.
2. **Your saved faces** — colour overrides from `faces.json`,
   installed into the face registry.
3. **The language modes** — the files in `languages/`, one
   self-contained major mode each, loaded tolerantly: a broken mode
   file is logged to the server's console and skipped, and the rest
   still load. Two are deliberately passed over — `latex.lisp` and
   `markdown.lisp` — because their richer top-level modes already
   loaded in step 1. The files load in roughly alphabetical order,
   and a later definition silently wins any name collision, which is
   why each mode's wiring lives in that mode's own file.
4. **`custom.lisp`** — your saved customisations, machine-written,
   evaluated only now, after every `defcustom` in the system exists —
   the language modes' included.
5. **`init.lisp`** — your configuration, last, so it has the final
   word. Both configuration files run before the first buffer's major
   mode is chosen, so even a mode registration in `init.lisp`
   reshapes the first thing you see.

The list the live server loads is a *curation*, not the whole of
`packages/stdlib/lisp/`. A handful of renderer-era files —
`files.lisp`, `views.lisp`, `system.lisp` among them — are not in it;
the server instead embeds its own definitions of their essential
commands (`find-file`, `switch-view`, the `M-x` entry point, the REPL
toggle) directly in its source. The full file list lives in the test
suite's loader (`STDLIB_FILES` in `packages/stdlib/src/index.js`,
which loads with per-file failure tolerance) — and its membership
*and order* both differ from the server's, a distinction worth
remembering when a file behaves under test and misbehaves live. The
files worth knowing first:

| File | Role |
|------|------|
| `commands.lisp` | `defcommand`, interactive specs, the command registry — loads first |
| `editing.lisp` | the core movement and editing commands, `atomic-change-group` |
| `custom.lisp` | the customisation registry — `defcustom`, applying and saving values |
| `modes.lisp` | `define-mode`, `register-mode`, hooks, minor modes |
| `faces.lisp` | the face registry and `defface` |
| `themes.lisp` | the built-in colour themes — seven of them — and the built-in faces |
| `keymap.lisp` | the global keymap tree and the key-dispatch loop itself |
| `line-ops.lisp` | whole-line edits — move, duplicate, join, indent |
| `languages/*.lisp` | one self-contained major mode per language |

The full file-by-file map lives in *Lisp Style and Pitfalls*. Notice
what the stdlib does *not* do: it defines no modules. Its files are
top-level Lisp in a deliberate order, encapsulated by convention —
private helpers wear a leading dash (`-split-path`) — because the
editor's commands, modes, and keymaps all want to live in the one
global namespace where the dispatch machinery finds them.

### Your Own Code: init.lisp and custom.lisp

Your code lives in two files in the editor's configuration home:
`~/.godot` (after Emacs's `~/.emacs.d`), overridable with the
`GODOT_HOME` environment variable — handy for a throwaway profile.
The directory is deliberately separate from Electron's opaque
application-support area, and on its very first run the editor
migrates any config it finds at the old location. Beside your two
Lisp files it holds the editor's other per-user state: `faces.json`,
`panes.json`, `session.json`, `workspaces.json`,
`projects-index.json`, and the `recovery/` and `snippets/`
directories.

**`init.lisp` is yours.** On first run the editor writes a commented
template:

```lisp
;;; init.lisp — your Godot configuration.
;;;
;;; This file is evaluated at startup, after the standard library and
;;; your saved customisations (custom.lisp). It is the Godot equivalent
;;; of .emacs: ordinary Lisp, so anything goes — set variables, define
;;; commands, bind keys, or choose which major mode opens a file type.
;;;
;;; Examples:
;;;   (custom-apply! '*markdown-interpreter* "pandoc -f markdown -t html")
;;;   (register-mode ".md" jmarkdown-mode)   ; open .md files in JMarkdown mode
;;;   (define (insert-divider) (insert! "---"))
```

What belongs there: keybindings, settings, small commands — anything
you would type in the REPL and want to keep.

```lisp
(set! the-keymap (assoc the-keymap "C-S-d" 'duplicate-line))

(custom-apply! '*theme* 'midnight)

(defcommand insert-divider ()
  "Insert a horizontal rule on its own line."
  (insert! "\n---\n"))
```

It loads after the whole standard library, so everything is available
to it. It is evaluated once, at server startup — an edit to it (or to
a stdlib file) takes effect on the next launch, so quit (`C-x C-c`)
and reopen. To try a form *now*, evaluate it at the REPL first — the
REPL is the same interpreter `init.lisp` loads into — and copy it in
once it behaves. A broken `init.lisp` never blocks startup: the error
is logged to the server's console and the file is skipped from the
failing form on, so keep independent settings as separate top-level
forms rather than one big `begin`.

**`custom.lisp` is the editor's.** It is machine-written by the
customize system — a sequence of `custom-set-saved!` forms with a
header warning that hand edits will be overwritten — and it loads
*before* `init.lisp`, precisely so that a hand-written setting in
`init.lisp` wins over a saved one. Don't edit `~/.godot/custom.lisp`
casually: route free-form configuration to `init.lisp`, and saved
settings through the cmd(customize) buffer. The machinery behind it —
`defcustom`, applying and saving values — is the subject of
*Customization from Lisp*. (Disambiguation: the *stdlib* also
contains a `custom.lisp`, which defines that machinery; the one in
your config home holds your saved values.)

### Modules or Plain Top-Level Definitions

When does your own code deserve a module? A rule of thumb in three
parts:

- **Configuration is top-level.** Keybindings, customs, a
  `defcommand` or three in `init.lisp` — wrapping these in a module
  would be ceremony, and worse: a module body cannot see
  `defcommand`, `define-mode`, or `defcustom` at all, since those
  are macros the stdlib defines in the *global* environment and a
  module's environment hangs under base. Commands, modes, and
  settings are declared at top level by construction.
- **A cohesive library with private state is a module.** Several
  functions sharing helpers and internal constants — a date
  formatter, a project-notes engine — earn the private namespace.
  Define the engine as a module; then, at top level, import it and
  wrap its entry points in thin `defcommand`s. The module owns the
  logic; the top level owns the editor-facing surface.
- **Keep the interface small.** Export the two or three names callers
  need, not the helpers — `import` is all-or-nothing, every exported
  name is a promise, and imports being snapshots makes wide
  interfaces expensive to evolve.
  Inside the module, the leading-dash convention still applies:
  `-helper` signals "private even among friends", and it costs
  nothing since the module hides it anyway.

Structure, in this Lisp, is mostly about names: who can see one,
when it is resolved, and what happens when it changes out from under
its callers. Modules answer the first; late lookup answers the other
two. The next chapters put the names to work on the editor itself,
beginning with *Editing Text from Lisp*.
