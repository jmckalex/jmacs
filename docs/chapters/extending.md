## Extending jmacs

This is the point of the editor. Everything in the chapters before this
one — the cursor, the kill ring, the modes, the keys — is ordinary Lisp
in the standard library (`packages/stdlib/lisp/*.lisp`), built on a small
floor of buffer primitives. Extending jmacs is not a separate activity
bolted onto the side of a finished program; it is the same activity the
editor's own authors are doing, with the same tools, against the same
live object. You change the editor the way you edit a document: type, try
it, keep it.

Extension happens in Lisp first — the custom dialect taught from the
ground up in this manual's *Programming in jmacs Lisp* part — and in
JavaScript when you want it. This chapter is
the orientation: the REPL you try things in, how a command is defined and
bound, how a change you make takes effect *now* without a restart, how
the editor describes itself when you ask, the shape of a mode, and the
JavaScript bridge underneath. The notation is the manual's throughout:
`C-` is Control, `M-` is Command (Meta), `A-` is Option, `S-` is Shift.

### The REPL

jmacs has a Lisp read-eval-print loop, toggled with `C-x p`
(cmd(toggle-repl)). What makes it more than a calculator is that it runs
against the *live* editor. The buffer primitives operate on the buffer
the current view is displaying, so an expression you evaluate in the REPL
acts on the document in front of you:

```lisp
(insert! "hello")     ; types into the visible buffer at point
(point)               ; ⇒ the cursor's offset
(view-name)           ; ⇒ the current view's name
```

The REPL is where you reach for a primitive to see what it does, sketch a
command before you commit it to a file, or inspect the editor's state —
`*kill-ring*`, `the-keymap`, `*commands*` are all just variables you can
print. It is the shortest loop the editor offers: think, type, read the
result.

There is a second way to evaluate, closer to the text. With a `.lisp`
buffer open, `C-RET` (cmd(eval-expression-at-point)) evaluates the form
*enclosing* the cursor and shows the result in a coloured pill beside its
closing bracket — green for a value, red for an error. `C-x C-e`
(cmd(eval-expression-before-point)) does the same for the form whose
closing bracket sits just before point. The running record of those
evaluations is the `*Eval log*` buffer (cmd(show-eval-log)). This is the
CIDER-style inline-eval loop: you keep your code in a file, evaluate a
definition in place, and watch the editor change under you.

### Defining a command

A *command* is a procedure declared with `defcommand`. Declaring it with
`defcommand` rather than a plain `define` does one extra thing: it
records the procedure in a registry, so `M-x` offers it by name whether
or not it is ever bound to a key. Build the body from the buffer
primitives, and give it a docstring — the docstring is not a comment, the
editor keeps it and shows it back to you later.

```lisp
(defcommand insert-divider ()
  "Insert a horizontal rule on its own line."
  (insert! "\n---\n"))
```

That is a complete command. Run it with `M-x insert-divider` (the `M-x`
prompt is cmd(execute-command)), or bind it to a key (next section).

A command usually takes no arguments and acts on point. When it needs
input — a region to work on, a string typed in the minibuffer, a number —
it declares an `(interactive …)` clause as the first form after the
docstring. The clause is a list of *sources*; each yields a value, and in
order they become the command's arguments. The command stays an ordinary
function, callable both by name and from your own code:

```lisp
(defcommand wrap-region-in-stars (start end)
  "Surround the region with ** … **."
  (interactive region)
  (goto! end) (insert! "**")
  (goto! start) (insert! "**"))

(defcommand insert-named (name)
  "Insert a string typed in the minibuffer."
  (interactive (string "Insert what? "))
  (insert! name))
```

The sources jmacs ships are `point` (the cursor offset), `region` (the
active region's bounds, an error when there is none),
`region-or-buffer` (the region, or the whole buffer when none),
`(string "prompt")` and `(number "prompt")` (a minibuffer read,
converted). A cancelled prompt simply does not run the command. Synchronous
sources are read at once; a prompt suspends and resumes in a callback, so
a command that asks two questions reads them in order without you writing
the plumbing.

### Binding a key

Keymaps are plain Lisp maps from a key string to either a command *name*
(a symbol) or a nested keymap. The global keymap is the variable
`the-keymap`; binding a key is putting an entry in a map:

```lisp
(set! the-keymap (assoc the-keymap "C-d" 'delete-forward))
```

A key string is exactly what the renderer reports: a single character for
printable keys (`"a"`, `" "`), a name for the rest (`"left"`,
`"backspace"`), with modifier prefixes `"C-"`, `"M-"`, `"A-"`, `"S-"`,
in that order — so `"C-d"`, `"S-left"`, `"C-S-z"`. A nested keymap is a prefix: bind a key to
a sub-map and pressing the prefix then a key from that map is how `C-x
C-f` reaches cmd(find-file). The standard library's prefix maps —
`c-x-keymap`, `c-h-keymap`, `c-c-keymap` — are themselves just variables
you can extend.

The crucial property is that commands are bound *by name* and resolved
*late*. Every time a key is pressed the symbol is looked up afresh, then
the procedure it names is called. Two consequences fall out of this, and
both matter:

- Redefining a command takes effect immediately. The keymap holds the
  symbol `'delete-forward`, not the procedure; rebuild the procedure and
  the next keystroke uses the new one.
- A feature file can bind a key to a command that does not exist yet. The
  symbol resolves only when the key is pressed, so load order between the
  keymap and the command's definition does not matter.

A key bound in a major or minor mode's keymap shadows the global binding,
but only for that mode's buffers — the resolution walks the minor-mode
maps, then the major-mode map, then `the-keymap`, and the first match
wins. That is how a mode adds keys without disturbing anyone else; see
*Modes*.

### Hot reload

`C-x C-r` (cmd(reload-stdlib)) re-evaluates the whole standard library.
Because commands resolve by name, the running editor switches to the new
definitions at once — no restart. Edit a command in its file, press `C-x
C-r`, and the next keystroke uses the new version. This is the core of the
editor's extensibility loop: the program rewrites itself while it runs,
and you stay in the session you were working in.

It works because of two properties of the language. The standard
library's files are plain top-level Lisp, so re-evaluating them rebinds
the same global names; and the evaluator resolves names *late* — a
keymap holds command symbols looked up at dispatch time, and a procedure
looks up the names in its body when it runs — so everything that refers
to a rebound name uses the new definition on its next call. Modules have
an analogous story: re-evaluating a `(module name …)` form does not
build a fresh namespace, it reuses the module's existing environment,
clearing it first so removed definitions disappear — hot reload in
miniature, applied by hand where `C-x C-r` applies to the whole library.
The precise rules are in *Modules and Program Structure*.

One sharp edge to know. An *importer* holds a snapshot of what it
imported, so a redefined *export* is stale in the importer until that
module is imported again — but a redefined *private helper* is seen at
once, because the exported procedures resolve it through the reused module
environment. In practice this means: when you change an exported binding,
re-import (or just `C-x C-r` the lot); when you change a helper a command
calls, the next call already sees it.

Your own configuration participates in the same loop. jmacs writes an
`init.lisp` into your config directory on first run — the editor's
equivalent of `.emacs`, evaluated at startup after the standard library
and your saved customisations. It is ordinary Lisp: set variables, define
commands, bind keys. Anything in this chapter you would do in the REPL,
you can make permanent there.

### The editor explains itself

"The editor explains itself" is a design principle, not a feature, and it
rests on something concrete: every procedure defined with `define` (and so
every `defcommand`) keeps its docstring and the source location it was
defined at. Three primitives surface that, callable anywhere — the REPL,
a command, your own code:

```lisp
(doc insert-divider)            ; ⇒ the docstring, or nil
(where-defined insert-divider)  ; ⇒ "line:col" where it was defined
(describe insert-divider)       ; ⇒ a map: name, params, docstring, location
```

Five commands present the same self-knowledge interactively, all under
the `C-h` (help) prefix:

| Key | Command | What it tells you |
|-----|---------|-------------------|
| `C-h k` | cmd(describe-key) | Press a key; jmacs reports the command it runs and that command's documentation. |
| `C-h f` | cmd(describe-command) | Prompts for a command by name and shows its documentation. |
| `C-h .` | cmd(describe-symbol-at-point) | Opens the documentation for the Lisp symbol under the cursor. |
| `C-h a` | cmd(apropos-doc) | Fuzzy-search the documentation by keyword and open a matching page. |
| `C-h F` | cmd(describe-face-at-point) | Describes the syntax-highlighting face under the cursor — covered in *Customization*. |

`C-h k` and `C-h f` route through a built doc page when one exists and
fall back to the procedure's own docstring otherwise, so a command you
wrote five minutes ago is as self-describing as one that shipped with the
editor — the docstring you gave it is what `C-h f` shows. The
hand-written reference under `docs/reference/` is the companion to this
built-in self-description, not a replacement for it: the editor knows what
each procedure *is*; the reference is where the prose lives.

(There is a sibling to `C-h F` for *making* a face rather than reading
one: `C-h C-f` (cmd(highlight-construct-at-point)) names or creates a
face, assigns the construct under the cursor to it, and applies it live.
That, too, belongs to *Customization*.)

### Writing a mode

A mode is a tagged bundle of behaviour a buffer adopts — a major mode
chosen from the buffer's filename, optional minor modes layered on top.
You make one with `define-mode`, which takes a name and keyword pairs and
binds the mode as a map:

```lisp
(define-mode text-mode
  :name "Text"
  :comment-prefix nil
  :highlight nil)
```

The keywords a mode understands are the data the editor reads from it:
`:name` (the modeline label), `:comment-prefix` (what cmd(comment-line)
adds and strips), `:highlight` (the highlighter to use), `:keymap`, and a
few more. A mode with a `:keymap` names it *by symbol* — `:keymap
'text-mode-map` — so the keymap variable stays live-editable after the
mode is defined, exactly as `the-keymap` is. `register-mode` then
associates a filename suffix with a major mode:

```lisp
(register-mode ".txt" text-mode)
```

Minor modes are turned on and off with `enable-minor-mode` and
`disable-minor-mode`, and a mode can run code on activation through the
`:on-enable` / `:on-disable` keywords or the additive `add-hook`
mechanism. That is the shape; the full model — how the keymap chain
composes, where per-buffer state lives, what a mode is and is not in this
version — is in `docs/spec/modes.md`, and the everyday view of using modes
is the *Modes* chapter. The reference documents each procedure.

### JavaScript as a second extension language

Lisp is the primary extension language — it is what gives the editor its
character — but JavaScript is first-class too, for the simple reason that
the runtime *is* JavaScript. The two are not walled off: the host exposes
the L2 buffer to both, and the heavy lifting (rendering, the buffer, the
host primitives) is JavaScript that the Lisp drives.

Today the interop runs host-to-Lisp. `createInterpreter({ primitives })`
registers JavaScript functions as Lisp primitives; each receives an array
of already-evaluated arguments. This is how the buffer operations reach
the Lisp at all — `insert!`, `point`, `delete-forward!` and the rest are
JavaScript functions wearing Lisp names. Values cross the boundary
cleanly: Lisp numbers, strings and booleans *are* their JavaScript
equivalents, Lisp lists convert to and from JS arrays, vectors are arrays,
maps are JS `Map`s. Symbols and keywords stay opaque to JavaScript unless
you convert them.

The other direction — calling JavaScript *from* Lisp (`(js/call
"Math.floor" 3.7)`, importing JS modules) and a documented
`editor.lisp.eval(…)` entry from JavaScript — is specified but not yet
built; see `docs/spec/lisp.md` §9. The intent is settled: when you want
the expressiveness of Lisp you reach for Lisp, and when a piece of work is
genuinely JavaScript-shaped you reach for JavaScript, against the same
buffer.

### Faces and the look of things

Changing what the editor *does* is this chapter; changing how it *looks* —
the theme, the syntax-highlighting faces, the colour a particular
construct is drawn in — is the same kind of work pointed at a different
target. The `C-h F` and `C-h C-f` commands above are its entry points, and
the whole of it — defining a face, assigning a construct to it, themes and
custom settings — is the subject of *Customization*. The principle is the
one this chapter has been making throughout: it is your editor, it is
live, and it explains itself.
