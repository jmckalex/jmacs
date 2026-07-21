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
command's arguments. Godot ships five sources:

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
sensibly default to the whole buffer. `number`, note, does not
validate: the typed string goes through `string->number`, which
returns `#f` for anything non-numeric, and the command runs with that
value — check it in the body when it matters.

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
The standard library's cautionary tale is the primitive `view-list`,
which returns the open view handles as data — the LaTeX compile loop
walks it to decide whether a built PDF is already on screen. A command
that *opens* a clickable View List panel must therefore not take that
name, or every piece of Lisp that enumerates views would open a GUI
panel instead of getting its data. The panel command
(`packages/stdlib/lisp/view-menu.lisp` — a file currently parked
outside the server's load list; the live buffer list is `C-x C-b`,
cmd(list-views)) is accordingly `view-list!`:

```lisp
(view-list)     ; ⇒ the list of open view handles — a primitive
(view-list!)    ; the panel-opening command — named for its side effect
```

The convention follows the namespace, not just taste: a command that
opens or mutates UI takes the `!` suffix, leaving the bare name free
for the data-returning primitive. Name your own commands the same way
— and remember that unit tests stub primitives, so a shadowing
mistake can pass a green suite and only bite in the running editor.

### M-x and the Help Keys

`M-x` — physically Command-x — runs cmd(execute-command): a minibuffer
prompt over every name in the `*commands*` registry. Matching happens
when you press Enter: an exact name runs directly; otherwise the
*shortest* registered name containing what you typed runs, so `sort-l`
reaches `sort-lines` without ceremony. The candidate pool is the
server's registry plus the renderer-owned element-view commands each
window announces, so `M-x` reaches every command in the editor.
(The prompt does not filter as you type — resolution is entirely at
submit.) Registration is all it takes: the moment a `defcommand` form
is evaluated, in the REPL or from `init.lisp`, the name is reachable.

Docstrings pay off in the help keys, all on the `C-h` prefix:

| Key | Command | What it does |
|-----|---------|--------------|
| `C-h k` | cmd(describe-key) | read a complete key sequence, following prefix maps through the buffer's keymap chain — `C-h k C-x C-f` describes find-file — and open the command's docstring in the utility dock's Help tab |
| `C-h f` | cmd(describe-command) | prompt for a command by name (matched like `M-x`: exact, else shortest containing); its full docstring opens in the Help tab |
| `C-h F` | cmd(describe-face-at-point) | describe the syntax-highlighting face under the cursor — face name, CSS class, the active theme's resolved colour |
| `C-h C-f` | cmd(highlight-construct-at-point) | name (or create) a face and assign the construct under the cursor to it, applied live |
| `C-h .` | cmd(describe-symbol-at-point) | describe the symbol under the cursor |
| `C-h a` | cmd(apropos-doc) | list every command whose name or docstring contains the typed text, in the dock's Apropos tab |
| `C-h d` | cmd(open-manual) | this manual |

### Keymaps Are Plain Maps

There is no `define-key`, no `global-set-key`, no keymap object: a
*keymap* is an ordinary hash-map from key strings to bindings. A
binding is either a **command symbol** — quoted, because it is the
*name* that is stored — or a nested keymap. The `C-h` help map above
is (`packages/stdlib/lisp/keymap.lisp`):

```lisp
(define c-h-keymap
  {"d" 'open-manual
   "k" 'describe-key
   "f" 'describe-command
   "F" 'describe-face-at-point
   "C-f" 'highlight-construct-at-point
   "a" 'apropos-doc
   "." 'describe-symbol-at-point})
```

Storing the symbol matters. The dispatcher resolves it afresh on
every keystroke — look the name up, call what it currently names — so
redefining a command takes effect on the next key press, and a key
can be bound before its command is defined. The dispatcher is
graceful about the gap: a key whose binding names no *registered*
command reports `NAME is not available here` in the echo area rather
than erroring — the same message you see when a binding names a
command that only exists in some other context. This is the
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

### The Universal Argument

One piece of dispatcher state travels *between* a key and the command
it runs: the prefix argument. `C-u` runs cmd(universal-argument),
which sets the global `*prefix-arg*` to `#t` and echoes `C-u-`; the
next command may consult the variable to alter its behaviour. The pane
splitters are the standing example — `C-x 2` splits below and `C-x 3`
to the right, while `C-u C-x 2` splits above and `C-u C-x 3` to the
left. In `panes.lisp` the consultation is one `let`:

```lisp
(let ((side (if (nil? *prefix-arg*) 'after 'before)))
  …)
```

Note the `nil?` test: the variable's resting value is `nil`, which is
*truthy* in this Lisp, so a bare `(if *prefix-arg* …)` would read
"argument present" always — absence here is spelled `nil`, not `#f`,
and must be tested by name. The dispatcher clears `*prefix-arg*` as
soon as the next command has run (any command except
`universal-argument` itself, which exists to set it), and `C-g`
discards a pending one. Only the single boolean press is implemented —
there is no numeric `C-u 4` multiplier yet.

### The Dispatcher Remembers: *last-command* and *this-command*

Every dispatch records the command's name: `run-command` shifts the
previous name into `*last-command*` and stores the current one in
`*this-command*` before the body runs. A command consults
`*last-command*` to behave differently when it *directly follows* a
particular command, and two everyday behaviours ride on it:
cmd(yank-pop) (`M-y`) does nothing but report unless the previous
command was a `yank` or another `yank-pop`, and the kill commands grow
one kill-ring entry when they run consecutively — `C-k C-k C-y`
reinserts both lines (see the kill-ring section of *Editing Text from
Lisp*). Typing counts too: a self-inserting keystroke stamps
`*last-command*` with `self-insert`, which is precisely what breaks a
kill run or a yank-pop chain when you type between them.

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
| `Option`+`]` | `"A-]"` | bound by default: cmd(insert-single-close-quote) |
| `Shift`+`←` | `"S-left"` | named keys are lowercase |
| `Ctrl`+`=` | `"C-equal"` | punctuation by code name |
| `Cmd`+`Shift`+`5` (`M-%`) | `"M-S-5"` | shifted symbol = `S-` + unshifted key |
| `Cmd`+`]` | `"M-]"` | brackets read as their characters |
| `Ctrl`+`Cmd`+`Shift`+`q` | `"C-M-S-q"` | the full prefix order |

One deliberate asymmetry: an **unbound `A-` chord falls through to
inserting the character Option composed**. The dispatcher tries the
`A-…` string first — a binding always wins — and only then lets the
composed character through, so `A-8` types a bullet (•) and accented
letters still arrive natively. Binding an `A-` key costs you that one
composition: the Option brackets, for instance, are bound to the
editor's typographic-quote layout (see Basic editing), so they no
longer compose macOS's defaults. The rest of Option typing is
untouched.

Self-insert has one hook. After the dispatcher inserts the character
it runs `*post-self-insert-hook*`, calling each registered procedure
with the key string — the seam auto-fill-mode wraps lines from. Each
hook call is wrapped in a `try`/`catch`, because self-insert is the
one path that must never throw: a buggy hook cannot wedge typing.
*Writing Modes and Hooks* covers registering one.

### Reading Input Mid-Command

There are no blocking reads in this Lisp. Every way a command takes
input mid-flight parks a callback and returns; the callback fires
when the input arrives.

The smallest is `(read-next-key callback)` — route the *next*
keystroke to `callback` instead of the keymap. One keystroke only:
the reader is cleared before the callback runs, so a command that
needs a conversation re-arms it inside each continuation. That is how
cmd(describe-key) walks a whole key sequence, and how
cmd(query-replace) (`M-%`) runs its per-match question
(`packages/stdlib/lisp/regex-search.lisp`, trimmed):

```lisp
(define (query-replace-step from to pos count)
  "Find the next match of FROM at or after POS. When found, highlight
   it and ask the user what to do; when not, finish."
  (let ((match (find-string-forward from pos)))
    (if (not match)
        (query-replace-finish from count)
        (begin
          …                              ; select the match on screen
          (show-status! (query-replace-prompt-text from to))
          (read-next-key
            (lambda (key)
              (query-replace-handle-key key from to match count)))))))

;; and in query-replace-handle-key, the y branch:
((or (eq? key "y") (eq? key "enter") (eq? key "space"))
 (replace-range! (car match) (cdr match) to)
 (query-replace-step from to
                     (+ (car match) (string-length to))
                     (+ count 1)))
```

The whole state machine is those two functions calling each other,
its state threaded as arguments — no globals beyond the reader
`read-next-key` itself parks.

For a line of text, `(minibuffer-read prompt callback)` opens the
minibuffer; the callback receives the entered string, or `nil` when
the prompt is cancelled. It is precisely what an
`(interactive (string …))` source compiles to — reach for the spec
first, and for `minibuffer-read` when a command must prompt mid-body.
Under the hood the callback parks in the global `*minibuffer-reader*`,
and the host resumes it on submit.

The completing variant is the host primitive
`(open-completing-minibuffer! prompt seed)`: the minibuffer opens
pre-filled with `seed`. What TAB then does is currently a host affair:
the server answers with case-insensitive *path* completion — but only
for the path prompts (`Find file: `, `Open project: `, the directory
and jukebox prompts), which also list their candidates in the utility
dock's Completions panel. Other prompts do not complete yet; the
Lisp-side hook for the general case, `minibuffer-tab-complete`,
survives as a pass-through the TAB path does not yet call (the ledger
of such splits is `apps/desktop/mwb/PRIMITIVE-SPLIT.md`). Delivery,
by contrast, is uniform: whatever prompt is open, Enter resolves it
through the same `*minibuffer-reader*` continuation `minibuffer-read`
uses — unless the server special-cases the prompt string, which is
how cmd(find-file) works: its body just opens the completing prompt,
and the server recognises `Find file: ` on submit and performs the
visit itself.

The third channel reads a *choice* rather than a key or a line.
`(picker-read title rows callback)` opens an interactive list — the
surface you know from `C-x C-b` — over `rows`, an opaque row array
built by a host *row-provider*; the callback receives the chosen
row's value, or `nil` on cancel. cmd(list-views) is the whole pattern:

```lisp
(defcommand list-views ()
  "Pick a view to switch to (C-x C-b)."
  (picker-read "Buffer list"
               (buffer-list-rows)
               (lambda (id)
                 (cond
                   ((nil? id) nil)            ;; cancelled — stay put
                   (else (switch-to-buffer-id! id))))))
```

The RefTeX label and citation pickers and the crash-recovery
*Recover* dialog are the same call with different row-providers —
rows in, one choice out.

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
`languages/jmarkdown.lisp` — two of the nine sections of its *final*
registration, trimmed:

```lisp
(register-mode-menu! "JMarkdown"
  (list
    (cons "Format"
          (list (cons "Bold" 'markdown-bold)
                (cons "Italic" 'markdown-italic)))
    (cons "Navigate"
          (list (cons "Next Heading" 'jmarkdown-next-section)
                (cons "Outline / TOC" 'jmarkdown-toc)))))
```

Final, because that file demonstrates the replacement rule on itself:
it registers a basic menu early on and, once the authoring-layer
commands exist further down, registers the full nine-section version —
the later call for `"JMarkdown"` simply wins.

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
