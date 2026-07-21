## Writing Modes and Hooks

A *mode* is a tagged behavioural configuration for a buffer: a display
name for the modeline, an optional keymap of mode-specific commands, a
comment syntax, a highlighting tag, a menu. A buffer gets exactly one
major mode — chosen from its file name when the buffer first appears —
and any number of minor modes layered on top. A mode is not a class
and there is no mode "framework": it is a plain Lisp map, and
everything the editor does with it is a lookup against agreed keys.
The chapter on <a href="nodes/modes.html" data-godot-doc="modes">Modes</a>
describes living with them; this one is about making them — by its end
you will have built a major mode from nothing and read your way around
the largest real one the editor ships.

> *A mode is data plus conventions. Define a map, register a suffix,
> and the editor's existing machinery does the rest.*

### A Mode Is a Map

The whole defining mechanism is two lines of `modes.lisp`:

```lisp
(defmacro define-mode (name . pairs)
  (list 'define name (cons 'hash-map pairs)))
```

So `(define-mode python-mode :name "Python" …)` is exactly
`(define python-mode (hash-map :name "Python" …))` — an ordinary
`define` over an ordinary map. The syntax is
`(define-mode name :key value …)`; the option values are *evaluated*,
like any arguments — strings and keywords evaluate to themselves, but
a symbol meant literally, a keymap's name, must be quoted
(`:keymap 'python-mode-map`). Like every `define`, the form returns
the name symbol and binds the mode globally, inspectable like any
other value:

```lisp
(get python-mode :name)   ; ⇒ "Python"
```

Because `define-mode` is only sugar, there is no validation and no
closed option set: any key you supply is stored, and a key nothing
reads is silently inert. What makes a map *behave* like a mode is the
small set of keys the editor's machinery looks up.

### The define-mode Options

Every key the shipped machinery reads, and its default when absent:

- `:name` — a string, the mode's *display name*. Shown in the modeline
  (`"Fundamental"` when missing). Required in practice: it is also the
  key under which hooks, menus and snippets attach, so a nameless mode
  cannot be hooked or given a menu.
- `:keymap` — the mode's keymap, consulted ahead of the global keymap
  for buffers in this mode. Preferably a *symbol naming* a keymap
  (`:keymap 'python-mode-map`); a literal map or `nil` (the default —
  no mode bindings) is also accepted. The symbol is resolved at every
  key dispatch, not at definition time. That late resolution is why
  the stdlib can declare `(define latex-mode-map {})` empty and let
  feature files fill it in later: a later `set!` of the variable is
  seen by the mode immediately; a baked-in literal map keeps only the
  snapshot it was defined with.
- `:comment-prefix` — the string cmd(comment-line) (`C-x ;`) inserts
  and strips; `";; "` when absent.
- `:highlight` — a keyword tag naming a host-registered highlighter
  (`:python`, `:jmarkdown`). Absent means plain, uncoloured text —
  see the final section of this chapter.
- `:priority` — a number, meaningful for minor modes: active minor
  modes are consulted in descending priority order, ahead of the major
  mode, in the key-dispatch chain. Default `0`.
- `:on-enable` / `:on-disable` — a single procedure of no arguments,
  run when the mode is enabled or disabled for a buffer: the mode's
  *built-in* hook slot, run before any hooks added with `add-hook`.
- `:indent-tabs?` / `:tab-width` — per-mode pins overriding the
  global `*indent-tabs-mode*` and `*tab-width*`. `makefile-mode` pins
  `:indent-tabs? #t`: a recipe indented with spaces is broken.
- `:fill-column` / `:fill-indent-function` — read by `auto-fill.lisp`,
  the wrap-as-you-type minor mode (`M-x auto-fill-mode`; the manual's
  *Writing* chapter covers using it). `:fill-column` pins a mode-local
  wrap column over the global `*fill-column*`; `:fill-indent-function`
  supplies the procedure that indents the continuation line after an
  automatic break — a procedure, or preferably a *symbol naming* one,
  resolved live like `:keymap`. `jmarkdown-mode` points it at
  `jmarkdown-fill-indent`, which is how a wrapped list item's
  continuation stays aligned under its text. Absent: the global
  column applies, and a broken line's continuation reproduces the
  line's own leading indentation.

A minor mode is the same kind of map — typically just `:name`, perhaps
`:keymap` and `:priority` — never registered against a suffix, only
toggled per buffer with `enable-minor-mode` and `disable-minor-mode`,
both idempotent. The tiny `math-preview.lisp` — a few dozen lines —
is the canonical minimal example; `auto-fill.lisp` is the next size
up — real machinery behind a mode map holding nothing but
`:name "Fill"`, whose membership in the buffer is the feature's only
on/off switch.

### Claiming a File Extension

A mode becomes a *major* mode by registration:

```lisp
(register-mode ".py" python-mode)
```

The registry is a plain list of `(suffix . mode)` pairs. When a text
buffer first appears with no mode, the host runs `choose-major-mode!`
(via the server's `-spine-choose-major-mode` wrapper in
`apps/desktop/mwb/spine.js`), which asks `mode-for-name` for the mode
whose suffix matches the buffer's name, and installs it with
`switch-major-mode` — running the old mode's disable hooks and the new
mode's enable hooks. A name matching nothing falls back to
`fundamental-mode`. Three rules govern the lookup:

- *Matching is by suffix*, with `string-suffix?` — so a "suffix" need
  not be an extension: `(register-mode "Makefile" makefile-mode)`
  catches any buffer whose name ends in `Makefile`.
- *A mode may claim several suffixes* by registering more than once:
  `latex-mode` holds both `.tex` and `.latex`.
- *On conflict, the most recent registration wins.* New entries go on
  the front of the list and lookup scans front-first. The `:priority`
  key plays no part here — it orders minor-mode keymaps, not mode
  selection. Last-wins is what lets your `init.lisp` (loaded after
  the whole stdlib) re-claim an extension: register your own mode for
  `.md` and the shipped `markdown-mode` stops being found.

Selection runs only when a buffer has no mode yet, and is never
forced: `(switch-major-mode latex-mode)` in the REPL puts the current
buffer in LaTeX mode regardless of its name.

Choosing the major mode has a second half: minor modes can ride along
automatically. `(register-default-text-minor-mode mode)` puts a minor
mode on the `*default-text-minor-modes*` list, and
`choose-major-mode!` finishes by enabling every listed mode in the
buffer — so a registered mode is on in *every* text buffer from the
moment its major mode is chosen, and again after a session-restore
re-mount (`enable-minor-mode`'s idempotence makes the repeat
harmless). The stdlib's bookmarks feature registers
`bookmark-minor-mode` this way (`bookmarks.lisp`); your `init.lisp`
can do the same for a minor mode you want everywhere. Non-text views
never reach this path.

### The Display Name Is the Mode's Key

Several registries attach things to a mode not by its variable name but
by its `:name` string. Keyed off the display name are:

- **hooks** — `add-hook` stores its functions under the display name;
- **structured menus** — `register-mode-menu!` registrations;
- **snippets** — a mode's snippet files live in a directory derived
  from the display name (`"Journal"` → `snippets/journal-mode/`);
- **per-mode face and highlight overrides** — the customisations
  described in *Customization from Lisp*.

The design buys two freedoms: things can attach to a mode *before it
exists* (your `init.lisp` can hook `"Python"` before the language
files load), and they *survive the mode being redefined* (a
hot-reloaded mode map is a brand-new map; its name string is not).
The price is the converse: rename the display name and everything
attached to the old string silently detaches — hooks stop firing, the
structured menu vanishes, the snippet directory no longer matches.
Treat `:name` as a published identifier; the convention — a short,
capitalised, human-readable word like `"Python"` or `"Journal"` —
reflects its double life as label and key.

### Hooks: Running Code When a Mode Turns On

Beyond the single `:on-enable` slot, *hooks* are the additive,
Emacs-style way to run your own code when a mode is enabled or
disabled:

```lisp
(add-hook mode thunk)                 ; run THUNK on enable
(add-hook mode thunk :on-disable)     ; …on disable instead
(remove-hook mode thunk [:on-disable])   ; the inverse
```

`mode` is a mode object or its display-name string; `thunk` is a
procedure of zero arguments; both calls are for effect. Hooks run
when the mode is *enabled for a buffer*: for a major mode, when a
buffer adopts it — on its first appearance, after a session restore,
or on an explicit `switch-major-mode` — and for a minor mode, on the
`enable-minor-mode` that actually turns it on. (`enable-minor-mode`
is guarded: re-enabling a mode already active in the buffer is a
complete no-op, so the hooks do *not* run a second time.) The buffer
being set up is current while the hook runs, so buffer primitives in
the thunk act on it. Disable hooks run on the way out: when a buffer
switches major mode, or via `disable-minor-mode`. The run order is
fixed: the mode's built-in `:on-enable` (or `:on-disable`) procedure
first, then the `add-hook` functions in registration order.

Hooks are *additive* — each `add-hook` appends, nothing replaces — so
the stdlib and your `init.lisp` can hook the same mode without
clobbering each other. As it happens, the shipped stdlib registers no
hooks at all: built-in setup goes in a mode's own `:on-enable` slot;
`add-hook` is left entirely to you. Two `init.lisp` examples:

```lisp
;; Typeset math inline automatically in every Markdown buffer.
(add-hook markdown-mode
          (lambda () (enable-minor-mode math-preview-mode)))

;; By display name — works even before latex.lisp has loaded.
(add-hook "LaTeX"
          (lambda () (show-status! "C-c C-c compiles, C-c C-v views.")))
```

Under the bonnet the registry is `*mode-hooks*`, a plain map keyed
`"<Name>/enable"` and `"<Name>/disable"`, and `run-mode-hook` is the
runner that `switch-major-mode` and `enable-minor-mode` call. When a
hook mysteriously fires — or fails to — inspect the registry
directly: `(get *mode-hooks* "Journal/enable")` lists exactly the
procedures that will run, in order.

#### Hooks and Re-evaluation

`add-hook` is idempotent against the *same procedure object*: re-adding
a thunk it already holds (compared with `eq?`) is a no-op. But
re-evaluating an `(add-hook … (lambda () …))` form builds a *fresh*
procedure each time, which `eq?` cannot recognise — so re-evaluating
the form by hand (`C-enter` on it, say) does stack a duplicate hook.
The honest rules of thumb:

- Restarts are clean. Your `init.lisp` is evaluated exactly once per
  launch, so hooks registered there land exactly once; duplicates
  arise only from re-evaluating forms by hand in a running session.
- Prefer thunks that are harmless to run twice. `enable-minor-mode` is
  itself idempotent, which makes the math-preview hook above safe even
  if it is ever duplicated. (This matters doubly because `remove-hook`
  also matches by `eq?` — once the lambda that registered a duplicate
  is gone, you cannot name it to remove it short of a restart.)

### Building a Mode from Scratch

Suppose you keep a diary in `.journal` files and want a *Journal*
mode: two commands under `C-c`, a menu, a greeting when a journal
opens. What follows is complete — paste it into `init.lisp`, restart
the editor (`init.lisp` is evaluated at every launch), and open a
`.journal` file; in a running session you can instead evaluate the
forms in place with `C-enter`. The commands are ordinary
`defcommand`s, built on the buffer primitives — *Commands, Keymaps,
and the Minibuffer* covers the form. (`snippet-date-string` is a host
primitive formatting the current `"date"`, `"datetime"` or `"year"`.)

```lisp
(defcommand journal-insert-timestamp ()
  "Insert the current date and time at point."
  (insert! (snippet-date-string "datetime")))

(defcommand journal-new-entry ()
  "Start a dated entry at the end of the journal."
  (goto! (buffer-length))
  (insert! (str "\n## " (snippet-date-string "date") "\n\n")))
```

Next the keymap: a `C-c` sub-map, in the stdlib's house style — a
plain map from key strings to quoted command symbols, where a nested
map makes its key a prefix:

```lisp
(define journal-c-c-map
  {"t" 'journal-insert-timestamp
   "n" 'journal-new-entry})

(define journal-mode-map {"C-c" journal-c-c-map})
```

Mid-chord lookup falls through the whole keymap chain, so `C-c` keys
the mode does not bind still reach the global `C-c` map. Now the mode
itself, and its claim on the extension:

```lisp
(define-mode journal-mode
  :name "Journal"
  :keymap 'journal-mode-map
  :comment-prefix "> ")

(register-mode ".journal" journal-mode)
```

Note the quoted `:keymap 'journal-mode-map`, so a later `set!` of the
map is picked up live. A journal has no comments, but
`:comment-prefix "> "` quietly repurposes cmd(comment-line) as a
quote-toggle for the current line. With no `:highlight`, the text
stays plain.

Finally a structured menu — one section is enough — and the greeting,
as an enable hook:

```lisp
(register-mode-menu! "Journal"
  (list
    (cons "Entries"
          (list (cons "New Entry" 'journal-new-entry)
                (cons "Insert Timestamp" 'journal-insert-timestamp)))))

(add-hook journal-mode
          (lambda () (show-status! "Journal — C-c n starts a new entry.")))
```

Both attach by the display name `"Journal"` — the menu call takes the
string explicitly; `add-hook` extracts it from the mode object. Open
`diary.journal` and the pieces converge: the modeline reads
**Journal**, the echo area greets you, a **Journal** menu appears in
the menu bar, `C-c n` starts an entry, `C-c t` stamps the time. (A
flat menu of the keymap's commands appears even without
`register-mode-menu!`; the registration upgrades it to sections.)

### Anatomy of a Real Mode

When you outgrow the toy, read
`packages/stdlib/lisp/languages/jmarkdown.lisp` — nearly nine hundred
lines, shipped with the editor, exercising nearly every surface in
this chapter. It opens like journal-mode, with the declare-then-fill
pattern, plus one option the toy did not need:

```lisp
(define jmarkdown-mode-map {})

(define-mode jmarkdown-mode
  :name "JMarkdown"
  :highlight :jmarkdown
  :keymap 'jmarkdown-mode-map
  ;; …
  :fill-indent-function 'jmarkdown-fill-indent)

(register-mode ".jmd" jmarkdown-mode)
```

The fourth option is the auto-fill continuation indenter from *The
define-mode Options* — stored as a symbol, the file's comment notes,
"so it resolves live and load order doesn't matter": the procedure it
names is defined hundreds of lines below. The map is declared empty
so the mode can be defined at the top of the file and filled in near
the bottom, once the commands exist to bind. The fill-in shows a
large `C-c` sub-map (two dozen entries; trimmed here) and mode-local
overrides of *global* bindings — `M-q`, and TAB:

```lisp
(define jmarkdown-c-c-map
  {"b" 'markdown-bold
   "i" 'markdown-italic
   "e" 'jmarkdown-intense
   "d" 'jmarkdown-insert-directive
   "@" 'jmarkdown-insert-environment
   ;; …
   "C-p" 'toggle-jmarkdown-math-preview})

;; M-q overrides keymap.lisp's global generic fill with the
;; JMarkdown-aware one (the latex-mode-map does the same).
(set! jmarkdown-mode-map
      {"C-c" jmarkdown-c-c-map
       "M-q" 'jmarkdown-fill-paragraph
       ;; TAB / S-TAB indent / dedent the selection (snippets still win).
       "tab" 'jmarkdown-tab
       "S-tab" 'jmarkdown-backtab})
```

Half the bindings borrow from *another file*: the formatting family
around cmd(markdown-bold) lives in `markdown.lisp`, and borrowing it
is just writing the names — keymaps bind symbols, resolved at
dispatch.

That wholesale `set!` is safe exactly once — in the file that owns
the map, filling in the empty map it declared. Further down, the same
file demonstrates the idiom every *later* extension must use. Its
authoring layer ("AUCTeX for JMarkdown": compile on `C-c C-c`,
completing environment and directive pickers, heading navigation on
`C-c C-n` and `C-c C-u`, a `C-c C-f` font sub-map and `C-c C-t`
toggle sub-map, the RefTeX chords `C-c (`, `C-c )`, `C-c [`, and
`M-enter` to continue a list) adds its bindings by extending the
existing maps with `assoc`, never by replacing them:

```lisp
(set! jmarkdown-c-c-map
  (let* ((m jmarkdown-c-c-map)
         (m (assoc m "C-c" 'jmarkdown-compile))       ; compile (format prompt)
         (m (assoc m "C-f" jmarkdown-font-map))       ; font sub-map
         ;; …fifteen more…
         (m (assoc m "/"   'jmarkdown-index)))        ; RefTeX: index
    m))
```

The distinction is worth internalising: maps are immutable values and
a mode-map variable is shared, so a second wholesale `{…}` replace
silently wipes every binding any other file — or your `init.lisp` —
had added, keeping only its own. The file's own comment states the
house rule: "Bindings are added by `assoc` … never a wholesale `{…}`
replace, so nothing already on the map is dropped." Replace only the
map you just declared; extend everything else.

The showpiece, bound to `C-c @`, wraps the region in an
`@begin()`/`@end()` pair and leaves a cursor inside *both* pairs of
parentheses: type the environment's name once and it appears in both
places, live; `C-g` collapses back to one cursor. Its essence:

```lisp
(defcommand jmarkdown-insert-environment ()
  "Insert an @begin()/@end() environment around the selection…"
  (let ((text (if (region-active?) (region-text) "")))
    (atomic-change-group
      (unless (equal? text "") (delete-backward!))
      (let ((p (point)))
        (insert! (str "@begin()\n" text "\n@end()"))
        (goto! (+ p 7))
        (add-selection! (+ p 15 (string-length text)))))))
```

One insertion, one arithmetic placement of the primary cursor, one
`add-selection!` for the mirror — the multi-cursor machinery does the
rest, and the `atomic-change-group` wrapper (see *Editing Text from
Lisp*) makes the delete-and-insert one undo step. The menu is
journal-mode's call shape at scale — and a lesson in itself, because
the file registers it *twice*: a five-section core (Format / Insert /
Blocks / Headings / Preview & Math) mid-file, then, once the
authoring commands exist, a nine-section replacement that the file
actually closes with (Compile & View / Format / Insert / Insert Block
/ References / Navigate / Headings / Advanced / Preview & Math):

```lisp
(register-mode-menu! "JMarkdown"
  (list
    (cons "Compile & View"
          (list (cons "Compile" 'jmarkdown-compile)
                (cons "Compile to HTML" 'jmarkdown-compile-html)))  ; …
    ;; … Format / Insert / … / Preview & Math …
    ))
```

A later `register-mode-menu!` for the same display name wins
outright — the menu registry is last-write-wins, so unlike a keymap
there is no `assoc`-style incremental extension: an extension
re-registers the *whole* menu, sections it keeps included.

Also worth studying there: `jmarkdown-fill-paragraph`, a pure,
unit-tested fill *planner* plus a thin command applying the plan — the
stdlib's cleanest pattern for non-trivial editing commands.

### Where Syntax Highlighting Comes From

Honestly: not from Lisp. Syntax highlighting is done by tree-sitter
grammars and queries registered host-side, in JavaScript, under
`packages/renderer/src/languages/`. A mode's `:highlight` keyword is a
*tag* selecting one of those registered languages — so as a Lisp mode
author you point at a tag that already exists (`:python`, `:latex`,
`:jmarkdown`), or omit the key and accept plain text; creating a new
grammar or query is JavaScript territory, outside this guide's scope.
What *is* yours from Lisp is the colouring policy on top: which faces
the captured constructs wear, per theme and per mode — the subject of
*Customization from Lisp*, where this chapter's thread continues.
