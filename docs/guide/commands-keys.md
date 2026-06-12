## Commands, Keymaps, and the Minibuffer

A function you define in the REPL is yours alone: you can call it, but
the editor does not know it exists. This chapter is about crossing
that line — how a procedure becomes a *command* the editor can offer
in `M-x`, run from a key, and list in a menu, and how a command asks
for input through the minibuffer. The mechanics are small and uniform:
a command is a registered function, a keymap is a hash-map, a prompt
is a callback. *Editing Text from Lisp* supplies the bodies; this
chapter supplies the wiring; *Writing Modes and Hooks* scopes that
wiring to one kind of buffer.

Key strings here are written in their Lisp-facing form: `C-` is
Control, `M-` is Command (Meta, the Emacs-on-Mac convention), `A-` is
Option, `S-` is Shift — the full grammar has its own section below.

### What Makes a Function a Command

A *command* is a procedure declared with `defcommand` (a macro in
`packages/stdlib/lisp/commands.lisp`):

```lisp
(defcommand name (params…) "docstring"? (interactive source…)? body…)
```

Both the docstring and the `(interactive …)` clause are optional; when
both appear, the docstring comes first. The form expands to an
ordinary `define` — docstring and body intact — plus one extra call,
`(register-command! 'name 'spec)`, which records the name and its
interactive spec in the registry `*commands*`. That registry is the
whole difference between a command and a plain function: `M-x` offers
every registered name whether or not it is bound to a key, and the
spec tells the dispatcher how to gather the command's arguments.

A real one, from `packages/stdlib/lisp/bookmarks.lisp`:

```lisp
(defcommand bookmark-set (name)
  "Set (or move) a named bookmark at point. Re-using a name moves it.
   Bound to C-x r m."
  (interactive (string "Set bookmark: "))
  (bookmark-set! name))
```

Because the expansion is a `define`, a command remains an ordinary
function: `(bookmark-set "intro")` from the REPL works exactly as
pressing `C-x r m` and typing `intro`. The spec only matters when the
*dispatcher* invokes the command — no spec means a zero-argument
call; with a spec the arguments are gathered, then applied. Either
way the dispatcher discards the return value: a command runs for its
effects. Called programmatically, it returns its last body form like
any procedure.

### The Five Interactive Sources

The `(interactive …)` clause is a list of *source descriptors*. Each
yields one or more values; concatenated in order, they become the
command's arguments. jmacs ships five sources:

| Source | Binds | Notes |
|--------|-------|-------|
| `point` | one value: the cursor's offset | read at dispatch time |
| `region` | two values: the region's `start` and `end`, in order | an error when no region is active |
| `region-or-buffer` | two values: the region's bounds, or `0` and the buffer length when none | never errors |
| `(string "Prompt: ")` | one value: the string typed in the minibuffer | cancelling skips the command |
| `(number "Prompt: ")` | one value: the minibuffer string through `string->number` | cancelling skips the command |

`region` computes its bounds from `(mark)` and `(point)`, smaller
first, so the command need not care which end the cursor is at. Run a
`region`-sourced command with no active region and the gatherer
raises an error — `this command needs an active region` — before the
body ever runs; it surfaces in the REPL like any other Lisp error.
`region-or-buffer` is the forgiving variant for commands that
sensibly default to the whole buffer.

The prompt sources are asynchronous: the minibuffer opens, the editor
keeps running, and the gathering *resumes in a callback* when you
press Enter. A cancelled prompt (`C-g`) never resumes, so the command
body never runs — no error, no partial work. Sources compose: a
command declared `(interactive region (string "Label: "))` takes three
parameters — the region's bounds arrive at once, then the minibuffer
opens for the label, and only then does the body run.

### Command Names and the Shadowing Rule

Commands and primitives share one namespace, and `defcommand` binds
its name in an environment the host primitives sit *beneath* — a
command silently shadows a same-named primitive for every Lisp caller.
The standard library's cautionary tale is
`packages/stdlib/lisp/view-menu.lisp`: the bare name `view-list`
belongs to the primitive that returns the open view handles, so the
command that opens the clickable *View List* is `view-list!` — were
it `view-list`, every piece of Lisp that enumerates views would open
a GUI panel instead of getting its data:

```lisp
(view-list)     ; ⇒ the list of open view handles — a primitive
(view-list!)    ; opens the *View List* panel — a command
```

The convention follows the namespace, not just taste: a command that
opens or mutates UI takes the `!` suffix, leaving the bare name free
for the data-returning primitive. Name your own commands the same way
— and remember that unit tests stub primitives, so a shadowing
mistake can pass a green suite and only bite in the running editor.

### M-x and the Help Keys

`M-x` — physically Command-x — runs cmd(execute-command): a
minibuffer prompt that fuzzy-filters every name in the `*commands*`
registry. The first match is shown bracketed; Enter runs it through
the dispatcher, so interactive specs work exactly as they do from a
key. Registration is all it takes — the moment a `defcommand` form is
evaluated, in the REPL or from `init.lisp`, the name is offered.

Docstrings pay off in the help keys, all on the `C-h` prefix:

| Key | Command | What it does |
|-----|---------|--------------|
| `C-h k` | cmd(describe-key) | press a key; reports the command it runs in the global map, opening its doc page or printing its docstring |
| `C-h f` | cmd(describe-command) | prompt for a command by name; show its documentation |
| `C-h .` | cmd(describe-symbol-at-point) | describe the symbol under the cursor |
| `C-h a` | cmd(apropos-doc) | search the documentation |
| `C-h d` | `open-manual` | this manual |

### Keymaps Are Plain Maps

There is no `define-key`, no `global-set-key`, no keymap object: a
*keymap* is an ordinary hash-map from key strings to bindings. A
binding is either a **command symbol** — quoted, because it is the
*name* that is stored — or a nested keymap. The `C-h` help map above
is, trimmed (`packages/stdlib/lisp/keymap.lisp`):

```lisp
(define c-h-keymap
  {"d" 'open-manual
   "k" 'describe-key
   "f" 'describe-command
   "a" 'apropos-doc
   "." 'describe-symbol-at-point})
```

Storing the symbol matters. The dispatcher resolves it afresh on
every keystroke — look the name up, call what it currently names — so
redefining a command takes effect on the next key press, and a key
can be bound before its command is defined. This is the same
late-binding bargain that makes hot-reloading a module painless, as
*Modules and Program Structure* explains.

The global root is the variable `the-keymap`. Hash-maps are immutable
values, so "adding a binding" means building a map with one more entry
and storing it back — the `(set! … (assoc …))` idiom. In `init.lisp`:

```lisp
;; C-S-d duplicates the line, globally.
(set! the-keymap (assoc the-keymap "C-S-d" 'duplicate-line))
```

The same idiom extends any prefix map — the LaTeX feature files grow
their shared map with forms like
`(set! latex-c-c-map (assoc latex-c-c-map "(" 'reftex-label))`.

### Prefix Maps and Dispatch Order

A nested keymap is a *prefix key*: press the prefix, and the next
keystroke is looked up in the sub-map. `the-keymap` binds `"C-x"` to
`c-x-keymap`, whose `"C-f"` entry is `'find-file` — that is the whole
story of `C-x C-f`. Mid-chord, the keys typed so far echo with a
trailing dash (`C-x-`); `C-g` (cmd(keyboard-quit)) abandons the
sequence, and an unbound continuation quietly resets it.

Each buffer resolves keys through a *chain* of keymaps, highest
precedence first: the active minor modes' maps (ordered by
`:priority`, highest first), then the major mode's map, then
`the-keymap`. The first map that binds the key wins, so a mode shadows
a global key only for its own buffers. The conventional mode prefix is
`C-c`: the global `c-c-keymap` holds editor-wide commands, and a mode
hangs its own `C-c` sub-map in its keymap. From
`packages/stdlib/lisp/languages/jmarkdown.lisp` (trimmed):

```lisp
(define jmarkdown-c-c-map
  {"b" 'markdown-bold
   "i" 'markdown-italic
   "d" 'jmarkdown-insert-directive
   "@" 'jmarkdown-insert-environment
   "C-p" 'toggle-jmarkdown-math-preview})

;; M-q overrides the global generic fill with the JMarkdown-aware one.
(set! jmarkdown-mode-map
      {"C-c" jmarkdown-c-c-map
       "M-q" 'jmarkdown-fill-paragraph})
```

Prefix lookup falls through the chain too. Mid-chord, the dispatcher
collects *every* map bound to the prefix key across the chain, in
chain order, and resolves the next key against the stack. So in a
JMarkdown buffer `C-c d` runs `jmarkdown-insert-directive` (the mode's
map binds `d`), while in a Markdown buffer — whose `C-c` map has no
`d` — the same chord falls through to the global `c-c-keymap` and
runs cmd(add-cursor-next). A mode prefix shadows only the keys it
actually binds.

### The Grammar of Key Strings

The renderer normalises every keystroke to a string
(`keyEventToString` in `packages/renderer/src/keymap.js`); keymaps
match those strings and nothing else. The rules:

- A **bare printable key is the character as typed**: `"a"`, `"A"`,
  `"("`, `" "`. An unbound single character self-inserts — that is
  typing.
- Everything else is **modifier prefixes, in the fixed order `C-`,
  `M-`, `A-`, `S-`**, then a base name.
- **Named keys are lowercase**: `left`, `right`, `up`, `down`,
  `backspace`, `delete`, `enter`, `tab`, `home`, `end`, `escape`,
  `space` — so `"S-left"`, `"C-enter"`, never `"Enter"`. (A bare
  space arrives as `" "`; the name `space` appears only with
  modifiers, as in `"C-space"`.)
- For a modified key the base comes from the **physical key**
  (`event.code`), independent of layout or of Option composing a
  character: letters lowercase, digits as digits, punctuation by its
  lowercased code name — `C-=` is `"C-equal"`, `C-,` is `"C-comma"` —
  and shifted symbols arrive as `S-` plus the unshifted key, so `M-<`
  is `"M-S-comma"` and `M-%` is `"M-S-5"`. The bracket keys are the
  one punctuation exception, reading as their characters: `"M-["` and
  `"M-]"`, not `"M-bracketleft"`.
- A **chord** is a sequence of these strings, one map level per key —
  prose writes `C-x C-s`; the data is a `"C-s"` entry in `"C-x"`'s map.

| You press | The key string | Notes |
|-----------|----------------|-------|
| `x` | `"x"` | self-inserts when unbound |
| `Cmd`+`x` | `"M-x"` | Command is Meta; `Ctrl`+`z` is `"C-z"` |
| `Option`+`]` | `"A-]"` | Option chords are user territory |
| `Shift`+`←` | `"S-left"` | named keys are lowercase |
| `Ctrl`+`=` | `"C-equal"` | punctuation by code name |
| `Cmd`+`Shift`+`5` (`M-%`) | `"M-S-5"` | shifted symbol = `S-` + unshifted key |
| `Cmd`+`]` | `"M-]"` | brackets read as their characters |
| `Ctrl`+`Cmd`+`Shift`+`q` | `"C-M-S-q"` | the full prefix order |

One deliberate asymmetry: an **unbound `A-` chord falls through to
inserting the character Option composed**. The dispatcher tries the
`A-…` string first — a binding always wins — and only then lets the
composed character through, so `A-]` types a curly quote and accented
letters still arrive natively. Binding an `A-` key costs you that one
composition; the rest of Option typing is untouched.

### Reading Input Mid-Command

There are no blocking reads in this Lisp. Every way a command takes
input mid-flight parks a callback and returns; the callback fires
when the input arrives.

The smallest is `(read-next-key callback)` — route the *next*
keystroke to `callback` instead of the keymap. It is how the
command cmd(describe-key) reads its key, and how cmd(kill-view)
asks its are-you-sure question (`packages/stdlib/lisp/views.lisp`):

```lisp
(if (view-modified?)
    (begin
      (show-status! "Buffer has unsaved changes — kill anyway? (y/n)")
      (read-next-key
        (lambda (key)
          (clear-status!)
          (if (equal? key "y")
              (kill-view!)
              (show-status! "Kill cancelled")))))
    (kill-view!))
```

The bare `kill-view!` primitive stays unconditional — the *command*
owns the confirmation policy, the shadowing rule's division of labour
in action.

For a line of text, `(minibuffer-read prompt callback)` opens the
minibuffer; the callback receives the entered string, or `nil` when
the prompt is cancelled. It is precisely what an
`(interactive (string …))` source compiles to — reach for the spec
first, and for `minibuffer-read` when a command must prompt mid-body.

The completing variant is the host primitive
`(open-completing-minibuffer! prompt seed)`: the minibuffer opens
pre-filled with `seed`, and while it is open, TAB calls the global
Lisp function `(minibuffer-tab-complete current)` — current text in,
replacement text out — which may also list candidates in the utility
dock's Completions panel. Redefine that one function and you have
changed the completion policy. The result is delivered through the
same continuation hook `minibuffer-read` uses, so a command installs
its handler by assigning `*minibuffer-reader*`. cmd(find-file) in
`packages/stdlib/lisp/files.lisp` is the model — three lines: compute
a seed, call `open-completing-minibuffer!`, and
`(set! *minibuffer-reader* -find-file-deliver)`.

### Registering a Structured Menu

Every mode gets a flat menu for free: the host calls
`mode-menu-entries`, which walks the active minor- and major-mode
keymaps (not the global map) and lists each bound command with its
key sequence and docstring. A mode may additionally register a
*structured* menu — named sections of friendly labels — with
`(register-mode-menu! mode-name sections)`. `mode-name` is the mode's
**display name** (the string `major-mode-name` returns —
`"JMarkdown"`, not `jmarkdown-mode`; menus, hooks and snippets all
key off that string); `sections` is a list of sections, each
`(section-label (friendly-label . command-symbol) …)`; a later call
for the same name replaces the registration. From
`languages/jmarkdown.lisp` (two of its five sections):

```lisp
(register-mode-menu! "JMarkdown"
  (list
    (cons "Format"
          (list (cons "Bold" 'markdown-bold)
                (cons "Italic" 'markdown-italic)))
    (cons "Blocks"
          (list (cons "Directive (:::)" 'jmarkdown-insert-directive)
                (cons "Environment (@begin)" 'jmarkdown-insert-environment)))))
```

The sections name only command symbols; keys and docstrings are
resolved from the flat entries, so the menu never goes stale.

### From Function to Finished Command

The whole journey, suitable for `init.lisp`. Start from a plain
function over the buffer primitives of *Editing Text from Lisp*:

```lisp
(define (wrap-range start end opener closer)
  "Insert OPENER before START and CLOSER after END, as one undo step."
  (atomic-change-group
    (goto! end)
    (insert! closer)
    (goto! start)
    (insert! opener)
    (goto! (+ end (string-length opener) (string-length closer)))))
```

Make it a command — a registered name and a declared argument source:

```lisp
(defcommand curly-quote-region (start end)
  "Wrap the region in typographic quotes."
  (interactive region)
  (wrap-range start end "“" "”"))
```

It is already in `M-x`. Give it a key — one entry in the global map:

```lisp
(set! the-keymap (assoc the-keymap "C-S-q" 'curly-quote-region))
```

And put it on a mode's menu. The registry behind `register-mode-menu!`
is itself a map, `*mode-menu-sections*`, so extending JMarkdown's menu
is reading the current sections, appending one, and re-registering:

```lisp
(register-mode-menu! "JMarkdown"
  (append (get *mode-menu-sections* "JMarkdown" (list))
          (list (cons "Typography"
                      (list (cons "Curly-quote Region"
                                  'curly-quote-region))))))
```

Evaluate the four forms and the function has become part of the
editor: `M-x curly-quote-region`, `C-S-q`, and a menu entry, all
naming the same ordinary procedure. Redefine it and all three follow,
because each of them stored only the name.
