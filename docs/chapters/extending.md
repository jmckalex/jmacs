## Extending Godot

This is the point of the editor. Everything in the chapters before this
one — the cursor, the kill ring, the modes, the keys — is ordinary Lisp
in the standard library (`packages/stdlib/lisp/*.lisp`), built on a small
floor of buffer primitives. Extending Godot is not a separate activity
bolted onto the side of a finished program; it is the same activity the
editor's own authors are doing, with the same tools, against the same
live object. You change the editor the way you edit a document: type, try
it, keep it.

One structural fact frames everything in this chapter. Godot runs a
*single* Lisp world, in a background server process, and every window is
a client of it. The REPL, inline evaluation, your `init.lisp` — all of it
evaluates in that one world, so a command you define exists at once in
every window, and the state you inspect is the editor's real state, not
one window's copy of it. A handful of commands are implemented on the
window side rather than in the server; a key bound to one of those, in a
context where it is not available, reports `<name> is not available here`
in the echo area instead of running — you will meet this message again
under *Binding a key*. The architecture itself is the *How Godot is
built* chapter; the engineering treatment is `docs/MODEL-B-DISPATCH.md`.

Extension happens in Lisp first — the custom dialect taught from the
ground up in this manual's *Programming in Godot Lisp* part — and in
JavaScript when you want it. This chapter is
the orientation: the REPL you try things in, how a command is defined and
bound, the hooks and helpers a command author reaches for, how a change
you make takes effect *now* without a restart, how
the editor describes itself when you ask, the shape of a mode, and the
JavaScript bridge underneath. The notation is the manual's throughout:
`C-` is Control, `M-` is Command (Meta), `A-` is Option, `S-` is Shift.

### The REPL

Godot has a Lisp read-eval-print loop — a tab in the bottom utility
dock, toggled with `C-x p` (cmd(toggle-repl)). What makes it more than a
calculator is that it runs against the *live* editor: every line you type
is evaluated in the server's one Lisp world, and the buffer primitives
operate on the buffer the active view is displaying, so an expression you
evaluate in the REPL acts on the document in front of you:

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

There is a second way to evaluate, closer to the text, and it works in
*any* buffer that contains Lisp forms — a `.lisp` file, the scratch
buffer, a code block in your notes. `C-RET`
(cmd(eval-expression-at-point)) evaluates the form *enclosing* the cursor
and shows the result in a coloured pill beside its closing bracket —
green for a value, red for an error. `C-x C-e`
(cmd(eval-expression-before-point)) does the same for the form whose
closing bracket sits just before point. This is the
CIDER-style inline-eval loop: you keep your code in a file, evaluate a
definition in place, and watch the editor change under you. (Should you
ever rebind it: the key string the keymap wants for `C-RET` is
`"C-enter"` — key strings are the renderer's normalised names, described
in the next section but one.)

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
docstring. The clause is a list of *sources*; each yields one or more
values, and in order those become the command's arguments. The command
stays an ordinary function, callable both by name and from your own code:

```lisp
(defcommand wrap-region-in-stars (start end)
  "Surround the region with ** … **."
  (interactive region)
  (atomic-change-group
    (goto! end) (insert! "**")
    (goto! start) (insert! "**")))

(defcommand insert-named (name)
  "Insert a string typed in the minibuffer."
  (interactive (string "Insert what? "))
  (insert! name))
```

The sources Godot ships are `point` (the cursor offset), `region` (the
active region's bounds — two values, start and end, which is why
`wrap-region-in-stars` takes two parameters; an error when there is no
region), `region-or-buffer` (the region, or the whole buffer when none),
`(string "prompt")` and `(number "prompt")` (a minibuffer read,
converted). A cancelled prompt simply does not run the command. Synchronous
sources are read at once; a prompt suspends and resumes in a callback, so
a command that asks two questions reads them in order without you writing
the plumbing.

Note the cmd(atomic-change-group) wrapped around the two inserts. Each
buffer edit is its own undo entry unless you say otherwise; a command
whose body edits the buffer more than once should group its edits so the
whole command undoes as one step, the way a user expects a single
command to. It is a macro from the standard library's editing toolkit;
its relatives — `with-marker`, `save-excursion` — are covered in
*Editing Text from Lisp*.

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
in that order — so `"C-d"`, `"S-left"`, `"C-S-z"`. Two spellings are
less guessable and worth knowing before you bind a symbol key: modified
punctuation is written with the key's *code name* — `"C-equal"` for
`C-=`, `"C-slash"` for `C-/` — and a shifted symbol keeps its `S-`:
`M-%` is typed as Shift+5, so its key string is `"M-S-5"`. The complete
naming grammar is in *Keys and commands*.

A nested keymap is a prefix: bind a key to
a sub-map and pressing the prefix then a key from that map is how `C-x
C-f` reaches cmd(find-file). The standard library's prefix maps —
`c-x-keymap`, `c-h-keymap`, `c-c-keymap` — are themselves just variables
you can extend the same way:

```lisp
(set! c-c-keymap (assoc c-c-keymap "-" 'insert-divider))   ; C-c -
```

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

One guard to know, because it is the failure mode every new extender
hits first: dispatch runs only *registered* commands. A key bound to a
name that `defcommand` has never registered — a plain `define`d
procedure, a typo, or one of the window-side commands mentioned in the
introduction — shows `<name> is not available here` in the echo area
rather than erroring. If a binding of yours reports that, the fix is
almost always to declare the procedure with `defcommand` instead of
`define`.

A key bound in a major or minor mode's keymap shadows the global binding,
but only for that mode's buffers — the resolution walks the minor-mode
maps, then the major-mode map, then `the-keymap`, and the first match
wins. That is how a mode adds keys without disturbing anyone else; see
*Modes*.

### Hooks, prefix arguments, and reading keys

Beyond the buffer primitives, three seams in the dispatch machinery
cover most of what a command author eventually wants.

**Running after every keystroke that types.** `*post-self-insert-hook*`
is a list of procedures run after each self-inserting keystroke, each
called with the key string just inserted — Emacs's
`post-self-insert-hook`, the seam an *electric* behaviour hangs from.
Register with `add-post-self-insert-hook` (idempotent by identity),
remove with `remove-post-self-insert-hook`. Two properties matter. The
hook is *global* while modes are per-buffer: register once, at load
time, and have the hook's body check the current buffer's mode — do not
add and remove the hook as a mode toggles, or toggling it in one buffer
clobbers every other. And each hook runs inside a guard, so a buggy hook
cannot wedge typing: self-insert is the one path that must never throw.
The shipped client is cmd(auto-fill-mode), which wraps the line when it
grows past the fill column.

**Reading a key yourself.** `(read-next-key callback)` routes the next
keystroke to CALLBACK instead of the keymap — one key, then dispatch
returns to normal automatically, so there is no reader to clean up. It
is how cmd(describe-key) reads its key sequence, re-arming itself after
each prefix key.

**The prefix argument.** `C-u` (cmd(universal-argument)) sets
`*prefix-arg*`, which the *next* command may consult before the
dispatcher clears it. Commands that care offer a variant: `C-u C-x 2`
splits the pane above instead of below, `C-u C-x 3` to the left instead
of right. At rest `*prefix-arg*` is `nil` and after `C-u` it is `#t` —
test it with `(not (nil? *prefix-arg*))` — and for now it is only that
boolean: numeric repetition (`C-u 4 …`) is not supported yet, so read it
simply as "the user asked for the variant".

### Hot reload

The loop that makes all of this feel live is the one you have already
seen: evaluate the definition, and the editor is running it. Edit a
`defcommand` — in a `.lisp` file, in the scratch buffer, wherever the
form is in front of you — press `C-RET`, and the next keystroke or
`M-x` uses the new version. No restart, no reload step; the program
rewrites itself while it runs, and you stay in the session you were
working in.

It works because of two properties of the language. Definitions are
plain top-level Lisp, so re-evaluating one rebinds the same global name;
and the evaluator resolves names *late* — a keymap holds command symbols
looked up at dispatch time, and a procedure looks up the names in its
body when it runs — so everything that refers to a rebound name uses the
new definition on its next call. Modules have
an analogous story: re-evaluating a `(module name …)` form does not
build a fresh namespace, it reuses the module's existing environment,
clearing it first so removed definitions disappear.
The precise rules are in *Modules and Program Structure*.

One sharp edge to know. An *importer* holds a snapshot of what it
imported, so a redefined *export* is stale in the importer until that
module is imported again — but a redefined *private helper* is seen at
once, because the exported procedures resolve it through the reused module
environment. In practice this means: when you change an exported binding,
re-evaluate the `import` too; when you change a helper a command
calls, the next call already sees it.

The granularity is worth being precise about. What hot-reloads is a
*form you evaluate*; the standard library's files themselves are read
once, at launch, and no command re-reads them from disk while the editor
runs. Editing a stdlib file on disk therefore takes effect at the next
launch — but editing the *definitions* it contains takes effect the
moment you `C-RET` them, which is how the editor's own authors work on
it: evaluate the changed form now, let the file be the record.

Your own configuration closes the loop. Godot writes an
`init.lisp` into its config directory — `~/.godot`, or `$GODOT_HOME` if
you point it elsewhere — on first run, seeded with a commented template.
It is the editor's
equivalent of `.emacs`, evaluated at the end of startup, after the
standard library and your saved customisations, so it can override
anything. It is ordinary Lisp: set variables (declare your own, with a
customize entry, via `defcustom` — see *Customization*), define
commands, bind keys. Anything in this chapter you would do in the REPL,
you can make permanent there.

### The whole loop, once

The sections above are the pieces; here is the assembly, end to end, for
the divider command from earlier. Total elapsed time is a minute or two;
restarts required, none.

1. **Sketch it.** `C-x n` (cmd(scratch-buffer)) opens a fresh Lisp
   scratch buffer. Type the definition and evaluate it with `C-RET`:

   ```lisp
   (defcommand insert-divider ()
     "Insert a horizontal rule on its own line."
     (insert! "\n---\n"))
   ```

   The green pill beside the closing bracket confirms the world took it.

2. **Try it.** Switch to a document and run `M-x insert-divider`. It is
   already there — `defcommand` registered it the moment it was
   evaluated.

3. **Bind it.** Back in the scratch buffer, give it a key and `C-RET`
   again:

   ```lisp
   (set! c-c-keymap (assoc c-c-keymap "-" 'insert-divider))
   ```

   `C-c -` now runs it, in every window.

4. **Keep it.** Copy both forms into `~/.godot/init.lisp`. The next
   launch has the command and its binding from the first keystroke; the
   scratch buffer was just the workshop.

### The editor explains itself

"The editor explains itself" is a design principle, not a feature, and it
rests on something concrete: every procedure defined with `define` (and so
every `defcommand`) keeps its docstring and the source location it was
defined at. Three primitives surface that, callable anywhere — the REPL,
a command, your own code:

```lisp
(doc insert-divider)            ; ⇒ the docstring, or #f
(where-defined insert-divider)  ; ⇒ "line:col" where it was defined, or #f
(describe insert-divider)       ; ⇒ a map: :kind, :name, :params, :doc, :defined-at
```

Note the miss value: `#f`, not `nil`. This Lisp's convention is that
*absence* is `#f` and *emptiness* is `nil` — and since `nil` is truthy
here, the distinction is behavioural: `(if (doc f) …)` does the right
thing on a missing docstring, while testing with `nil?` would not. (See
*Lisp Data Types* for the full story.)

The same self-knowledge is available interactively, under the `C-h`
(help) prefix:

| Key | Command | What it does |
|-----|---------|-------------------|
| `C-h d` | cmd(open-manual) | Open this manual at its top node, in a doc view — browse from the sidebar and the Next/Prev/Up links. |
| `C-h k` | cmd(describe-key) | Read a *complete* key sequence, following prefixes — `C-h k C-x C-f` describes cmd(find-file), not "`C-x` is a prefix" — and show the bound command's documentation. An unbound sequence reports `… is unbound`. |
| `C-h f` | cmd(describe-command) | Prompt for a command by name and show its documentation. The name resolves the way `M-x` resolves it: an exact match, else the shortest registered name containing what you typed. |
| `C-h .` | cmd(describe-symbol-at-point) | Documentation for the Lisp symbol under the cursor: the pre-built reference page when one exists, else the live docstring rendered as a page. |
| `C-h a` | cmd(apropos-doc) | Prompt for a pattern; list every command whose name or docstring contains it, case-insensitively. |
| `C-h F` | cmd(describe-face-at-point) | Describe the syntax-highlighting face under the cursor — covered in *Customization*. |
| `C-h C-f` | cmd(highlight-construct-at-point) | The sibling for *making* a face rather than reading one: name or create a face, assign the construct under the cursor to it, apply it live — also *Customization*. |

Where the answers land: `C-h k` and `C-h f` open the command's full
docstring in the **Help** tab of the same bottom dock that hosts the
REPL, with a one-line summary in the echo area; `C-h a` fills the dock's
**Apropos** tab, one `name — first docstring line` per match, shortest
name first. `C-h .` and `C-h d` open a *doc view* — a page of the built
manual, navigable like any other view. There is also `M-x open-doc`
(cmd(open-doc)) to prompt for a documentation page by name.

The docstring you write is what these commands show, so a command you
wrote five minutes ago is as self-describing as one that shipped with
the editor. The hand-written reference is the companion to this built-in
self-description, not a replacement for it: the editor knows what each
procedure *is*; the reference is where the prose lives — commands and
keymaps in `docs/reference/commands.md`, the buffer and host primitives
in `docs/reference/buffer-primitives.md`, the language core in
`docs/reference/lisp-core.md`.

### Writing a mode

A mode is a tagged bundle of behaviour a buffer adopts — a major mode
chosen from the buffer's filename, optional minor modes layered on top.
You make one with cmd(define-mode), which takes a name and keyword pairs
and binds the mode as a map:

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
mode is defined, exactly as `the-keymap` is. cmd(register-mode) then
associates a filename suffix with a major mode:

```lisp
(register-mode ".txt" text-mode)
```

Minor modes are turned on and off with cmd(enable-minor-mode) and
cmd(disable-minor-mode), and a mode can run code on activation through
the `:on-enable` / `:on-disable` keywords or the additive `add-hook`
mechanism. That is the shape; the full model — how the keymap chain
composes, where per-buffer state lives, what a mode is and is not in this
version — is in `docs/spec/modes.md`, and the everyday view of using modes
is the *Modes* chapter. Each procedure named here has an entry in the
command reference.

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
