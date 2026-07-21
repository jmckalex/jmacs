## Lisp Style and Pitfalls

This closing chapter is the guide's appendix of habits: the naming
conventions the standard library actually follows, the traps that catch
correct-looking code, what performance costs in this interpreter, and a
debugging workflow that uses the editor itself as the debugger. The
gallery below deliberately *recaps* hazards taught in earlier chapters
— a few sentences each, pointing at the chapter that owns the full
story. Read it once now, and again the first time something truthy
surprises you.

### What a Name Promises

Godot Lisp has one namespace and no access control, so names carry the
contract. Four conventions do the work:

| Shape | Promise | Real examples |
|-------|---------|---------------|
| trailing `?` | a *predicate* — returns `#t` or `#f`, no side effects | `nil?`, `even?`, `region-active?`, `view-modified?` |
| trailing `!` | a *side effect* — mutates the buffer, the display, or the world | `insert!`, `goto!`, `set-mark!`, `kill-view!` |
| `*earmuffs*` | global, user-visible *state or setting* | `*theme*`, `*tab-width*`, `*kill-ring*` |
| leading `-` | a file-private *helper* — internal, free to change | `-split-path`, `-keyboard-quit-base` |

The earmuff row splits in two, and the split decides how you write.
`*kill-ring*` is plain *state* — read it and `set!` it freely.
`*theme*` and `*tab-width*` are `defcustom`'d *settings*, and their
proper write path is `custom-apply!`, not `set!`: a bare `set!`
changes the variable but leaves the customize registry stale and
skips the `:on-change` hook — the desync *Customization from Lisp*
spells out.

The `!` rule has a corollary worth stating on its own: **opening a
panel is a side effect**. The instructive case is the view list:
`(view-list)` is the host primitive that returns the data — the list of
open view handles — while the panel that shows the open buffers is a
separate *command* (cmd(list-views), `C-x C-b`). Give an opener you
write the `!` even though Emacs would not: the `!` keeps the data name
free, and the next pitfall shows exactly what goes wrong when an
opener claims the bare name. The leading `-`, by
contrast, is convention rather than mechanism — nothing stops another
file from calling `-split-path`. For enforced privacy, put helpers in a
`(module …)` and export only the public names; see *Modules and
Program Structure*.

### A Gallery of Pitfalls

Each entry looks right, is wrong, and has a one-line fix. The
cross-referenced chapter has the full explanation.

#### Nil Is True

Only `#f` is false; `nil`, `0`, and `""` are all true — so a `nil`
*passes* a bare `if` test. The library keeps that from biting by
following one convention: **absence is `#f`, emptiness is `nil`**. A
lookup that found *nothing there* answers `#f`, safe as a bare test —
`get` with no fallback, `member`, `string->number`, `doc`,
`where-defined`, `find-view`, `mark` when unset, the
`find-string-forward`/`find-regexp-*` search primitives:

```lisp
(define prefs {:colour "mauve"})
(get prefs :verbose)                          ; ⇒ #f — the key is missing
(if (get prefs :verbose) "verbose" "quiet")   ; ⇒ "quiet" — #f is false
```

What stays `nil` is *emptiness* — a collection that genuinely is empty,
where the empty thing is the honest answer: `(first '())`, `(rest '())`,
and `(last '())` are `nil`, as is an else-less `if` or a fall-through
`cond`. Those are truthy, so guard them with `nil?`, never with bare
truth:

```lisp
(when (first items) (process (first items)))   ; runs on '() too — nil is truthy
(unless (nil? items) (process (first items)))  ; right — test the emptiness
```

Optional fields *inside* a data record (a `describe` map's `:doc`, a
view record's `:file`) report `nil` as well; the `#f` rule governs a
function's *return-value* miss, not what a record happens to hold. One
trap when you do test for an absence: `(nil? #f)` is `#f`, so reaching
for `nil?` to catch a `#f` miss silently never fires — test it bare, or
with `not`. Truthiness is laid out in full in *Lisp Data Types*.

#### Truthy Ghosts from the Host

Host primitives are JavaScript, but a JS `undefined` or `null` never
reaches your code raw: the boundary coerces both to `nil` on the way
out, so a primitive that "returns nothing" returns `nil`. This is the
one place the *absence is `#f`* convention does not reach — a raw host
primitive that has not adopted it hands a miss back as `nil`, and `nil`
is *truthy*, so a failure or nothing-to-report value sails through a
bare `if`:

```lisp
(define text (read-file-text! "/no/such/file"))
(when text (insert! text))            ; wrong — failure is nil, truthy
(when (string? text) (insert! text))  ; right — guard with the type
```

The guard idiom: test for the type you intend to use, not for bare
truth. (The blessed lookups of the previous entry — `get`, the search
primitives, and friends — *do* follow the convention and answer `#f`;
it is the unconverted host edge that still leaks a truthy `nil`.)

#### Identity, Equality, and Map Keys

`eq?` is JavaScript `===`: value equality for numbers, strings, and
booleans, but object identity for pairs, vectors, and maps — so
`(eq? '(1 2) '(1 2))` ⇒ `#f` where `equal?`, which recurses
structurally, gives `#t`. Map *lookup* is identity-flavoured either
way: keywords, symbols, strings, and numbers match by value, but a list
or vector key never matches a reconstruction of itself:

```lisp
(define m {(list 1 2) "found"})
(get m (list 1 2))    ; ⇒ #f — a fresh list is a new object, so a miss
```

Key your maps with keywords, symbols, strings, or numbers. The same
caveat covers `equal?` on two maps — keys compare by identity — and
`gensym` symbols, uninterned and never `eq?` to a read symbol of the
same name. See *Lisp Data Types*.

#### Macro Capture and Double Evaluation

Macros are non-hygienic: a name the expansion introduces captures the
caller's same-named variable, and an argument form pasted in twice runs
twice.

```lisp
(defmacro or2 (a b)
  `(let ((v ,a)) (if v v ,b)))

(let ((v 7))
  (or2 #f v))               ; ⇒ #f — the expansion's v shadows yours
```

The discipline is `gensym` for every introduced binding — in the
transformer, `(let ((v (gensym))) …)` and splice `,v` — which also
fixes double evaluation, because each argument form is bound exactly
once. Remember too that a macro re-expands at *every* evaluation of its
use site; there is no expansion cache. *Writing Macros* develops all of
this properly.

#### Recursion That Is Not Really Tail

Tail calls run in constant stack, but only from genuine tail positions.
The classic miss puts the recursive call in argument position:

```lisp
(define (join-lines lines)
  (if (nil? lines)
      ""
      (str (car lines) "\n" (join-lines (cdr lines)))))
;; the call sits inside str's arguments — the JS stack grows per line
```

Not tail positions: any argument position, every part of a `try`
(body, handler, and `finally` cleanup alike), the `module` body, and
anything routed through `apply`, `map`, `filter`,
`reduce`, or `for-each`. The fix is the accumulator recipe — carry the
partial result as a parameter so the recursive call is the whole answer
— or a bulk primitive, here `(string-join lines "\n")`. A blown stack
is a JS `RangeError`, which no Lisp `try` can catch. The full map of
tail positions is in *Functions and Closures*.

#### Shadowing a Primitive by Accident

Commands and primitives share one namespace, and a `defcommand` binds
closer to the lookup than the primitives do — so a command named after
a primitive silently shadows it for every Lisp caller. The cautionary
tale is the view list again: name the panel-opening command `view-list`
instead of `view-list!`, and every caller that enumerated views with
`(view-list)` now opens a GUI panel instead of getting data. Before
claiming a name, ask whether it is taken:

```lisp
(describe view-list)   ; ⇒ {:kind :primitive :name view-list}
```

A `:kind` of `:primitive` means pick another name — usually the same
name with `!` if yours has the side effect. See *Commands, Keymaps,
and the Minibuffer*.

#### eval Ignores Local Scope

The `eval` primitive always evaluates in the *global* environment, no
matter where the call appears:

```lisp
(let ((x 5))
  (eval 'x))      ; error: unbound symbol: x
```

This is a feature in its proper home — it is why a keymap can hold the
*symbol* `'find-file` and always dispatch to the latest definition —
but it makes `eval` the wrong tool for touching locals. Pass values
rather than symbols, or splice the value into a quasiquoted form; the
environment structure is explained in *The Evaluation Model*.

#### A Renamed Mode Detaches Its Hooks

Hooks, structured menus, per-mode face overrides, and snippet
directories are all keyed by the mode's *display name* — the `:name`
string — not by the variable that holds the mode:

```lisp
(add-hook "Markdown"
          (lambda () (enable-minor-mode math-preview-mode)))
;; change the mode's :name to "MD" and this hook never fires again
```

Treat the display name as a stable identifier; if you must rename one,
move everything keyed to it — hooks, the `register-mode-menu!` entry,
the `snippets/<name>/` directory — in the same edit. See *Writing
Modes and Hooks*.

#### A Fresh Map Wipes the Other Files' Bindings

A mode's keymap is one shared variable, and more than one file adds
bindings to it — the stdlib fills `latex-mode-map` from several
feature files, and your `init.lisp` may add more. Extending it with a
wholesale replace looks right:

```lisp
(set! latex-mode-map {"C-c" my-c-c-map})   ; wipes every other binding
```

— and silently drops everything anyone else had put on the map,
keeping only yours. The house rule, stated in `jmarkdown.lisp`'s own
comments: bindings are added by `assoc`, never a wholesale `{…}`
replace —

```lisp
(set! latex-mode-map (assoc latex-mode-map "C-c" my-c-c-map))
```

A wholesale `set!` is right exactly once: in the file that declared
the map empty, filling it in before anyone else could touch it. See
*Writing Modes and Hooks*.

#### The Stale Import

`(import name)` copies each exported binding's *current value* into the
importing scope. Re-evaluate the module with a rebound export, and the
importer keeps the old procedure object until it imports again:

```lisp
(import text-utils)     ; copies the exports, by value, now
;; …edit and re-evaluate (module text-utils …)…
(import text-utils)     ; ⇒ text-utils — fresh snapshot
```

Inside the module, helpers resolve late and reloading is seamless; only
the importer's copies go stale. The reload semantics are spelled out in
*Modules and Program Structure*.

#### Many Edits, One Undo Step

A command that edits the buffer more than once records one undo step
per edit, so undo (`C-z`) leaves the buffer half-transformed:

```lisp
(let ((text (current-line-text)))
  (delete-region! (line-start) (line-end))
  (insert! (string-upcase text)))     ; two edits — two undo steps
```

Wrap the edits in `atomic-change-group`, which lands them on the undo
stack as a single step and closes the group on every exit, even a raw
host fault —
the stdlib does this everywhere it edits twice (`move-line-up`,
`surround`, `indent-region`). See *Editing Text from Lisp*.

#### Smaller Surprises

Sharp edges that fit in one line each:

- `string-prefix?` and `string-suffix?` take the *affix first*:
  `(string-prefix? "pre" s)`.
- `reduce` is `(reduce f init seq)` — the initial value is required.
- `string-index-of` returns `-1` when nothing is found — truthy.
- `define`, `defmacro`, `module`, and `import` return the *name
  symbol* — as does `defcommand`, whose expansion ends in a
  `register-command!` that hands the name back; `set!` returns the
  value.
- Maps are immutable values: `(assoc m k v)` returns a copy, so a
  keymap edit is `(set! m (assoc m k v))` — without the `set!` the
  binding is silently dropped.
- A bare `(make-marker)` is a debt: a live marker taxes every later
  edit until `release-marker!`, and a *released* one raises on use —
  prefer `with-marker` or `save-excursion`, which release on every
  exit. See *Editing Text from Lisp*.

### Performance in a Tree-Walking Interpreter

The interpreter walks the syntax tree directly; there is no compiler
and no bytecode. For what Lisp does here — command bodies, mode policy,
keymap dispatch — that is comfortably fast. Three honest notes for when
work grows. Macros expand at every evaluation of their use site, so a
macro in a hot loop pays its transformer's cost each iteration — keep
transformers cheap. Prefer the primitives' bulk operations to
character-at-a-time Lisp loops: `string-join` joins a list in one host
call, `buffer-substring` hands you a region as one string, and
`replace-all!` sweeps a buffer in one edit — the host iterates in
JavaScript, your loop iterates in the interpreter. And do not optimise
prematurely: the editor's hot paths — rendering, search, syntax
highlighting — are JavaScript already. Lisp is the policy layer, and a
policy decision per keystroke costs nothing you can feel.

### A Debugging Workflow

The editor is its own debugger; the loop is short. Start in the REPL —
`C-x p` (cmd(toggle-repl)) — which shares the live editor's buffers: a
probe like `(point)` or `(view-list)` reports on the document in front
of you. For code in a file, evaluate in place: pressing `C-enter`
runs cmd(eval-expression-at-point), evaluating the form enclosing point
and showing the result as a green pill — red for an error — beside the
closing bracket; `C-x C-e` (cmd(eval-expression-before-point)) takes
the form just before point.

When a name is unfamiliar, ask before guessing: `(doc f)` returns the
docstring, `(where-defined f)` the definition's `"line:col"`, and
`(describe f)` a map with kind, name, parameters, and location. When
you don't *have* a name, `C-h a` (cmd(apropos-doc)) searches every
docstring for a word, and `C-h .` (cmd(describe-symbol-at-point))
describes the symbol under the cursor without leaving the buffer. For
keys, `C-h k` (cmd(describe-key)) reads the next chord and reports what
it runs; `C-h f` (cmd(describe-command)) looks a command up by name.

Print-debugging works, with one thing to know: every output primitive —
`print`, `println`, `display`, `write` — writes to the interpreter's
single output sink, which the desktop app points at the REPL tab of the
utility dock. Printed output lands there no matter where the code ran;
the inline pill shows only the form's *value*, so open the dock to see
your traces. To inspect a failure rather than read it in red, wrap the
suspect call:

```lisp
(try (some-suspect-call)
  (catch e
    (println (get e :message))
    (println (get e :irritants))))
```

The condition map always carries those two keys, plus `:line` and
`:column` — the failing form's position in its source — when the
evaluator could locate it; *Errors and Error Handling* reads the map
in full. If nothing is caught
at all, suspect a raw JavaScript exception from a host primitive —
those escape every Lisp handler (though a `finally` clause's cleanup
still runs), as *Errors and Error Handling*
explains. Finally, redefinition is live: because keymaps bind command
symbols resolved at dispatch time, re-evaluating a `defcommand`
(`C-enter` on it) changes what its key does from the very next
keystroke — no reload step. Edits to `init.lisp` itself land at the
next launch; it is evaluated once, at startup.

### Where the Standard Library Keeps Things

The best style guide is the standard library itself — a hundred-odd
Lisp files in `packages/stdlib/lisp/`: the core files at the top
level, the per-language modes under `languages/`. Read whichever file
already does something like what you want:

| File | What it shows you |
|------|-------------------|
| `commands.lisp` | `defcommand`, interactive sources, the command registry |
| `keymap.lisp` | the global keymaps, the dispatch chain, `read-next-key` |
| `modes.lisp` | `define-mode`, `register-mode`, hooks, minor modes |
| `editing.lisp` | movement and editing commands; `atomic-change-group`, `with-marker`, and `save-excursion` live here |
| `line-ops.lisp` | whole-line edits on raw primitives — `move-line-up`, `indent-region` |
| `kill.lisp` | a stateful feature in pure Lisp; the `*last-command*` idiom |
| `files.lisp` | `find-file` and the TAB-completion policy hook |
| `views.lisp`, `panes.lisp` | view switching and the pane-tree commands |
| `occur.lisp` | the exemplary file shape — pure helpers, one thin command |
| `custom.lisp` | `defcustom`, `defgroup`, the customize machinery |
| `faces.lisp`, `themes.lisp` | `defface`, the shipped themes, the `*theme*` setting |
| `languages/*.lisp` | the drop-in language modes — `languages/README.md` documents the template (`python.lisp` is a minimal instance), `jmarkdown.lisp` the rich worked example |

How the files *load* is a small pitfall gallery of its own, worth
knowing before you add one. There are two load lists, not one:
`STDLIB_FILES` in `packages/stdlib/src/index.js` (the package's own
loader, which the test suites run) and `SPINE_STDLIB` in
`apps/desktop/mwb/spine.js` — the list the running editor's server
actually loads — and their orders differ. A new stdlib file must be
added to *both*; added to only one, it works under test and silently
never loads in the app, or the reverse. Two corollaries of the load
order. The `languages/` directory is globbed *after* the listed core
files, in roughly alphabetical order — so wiring that must see a
language mode belongs in that mode's own file, not in an
earlier-loaded neighbour. And because `define` rebinds freely in the
one namespace, a name collision between two files resolves silently
as later-load-wins — grep the stdlib for a name before claiming it
(or `describe` it in the REPL).

The prelude — `when`, `unless`, the loop macros `while`, `dotimes`,
and `dolist`, the predicates `any?` and `every?`, `cadr` and friends —
is the only Lisp the interpreter itself ships, defined inline in
`packages/lisp/src/interpreter.js`. Everything else is ordinary library
code, written to be read.

### When in Doubt, Ask the Editor

The contract this guide has been describing is small: seventeen special
forms, a hundred-odd core primitives, a handful of stated rules — only
`#f` is false, one namespace, names promise what they do — and a
standard library that is itself the reference implementation of good
style. When you are unsure about a name, `describe` it; unsure about an
idiom, read the stdlib file that uses it; unsure what an expression
does, the REPL is one keystroke away, talking to the same live editor
you are. That loop — describe it, read it, try it — is the whole
method.
