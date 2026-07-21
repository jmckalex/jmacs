## Customization

Almost everything in this manual so far has changed the editor for the
length of a session: an expression in the REPL, a key rebound, a command
redefined. Those changes are real, but they vanish when you quit. This
chapter is about the other half — making changes *stick*. It covers
where Godot keeps your configuration on disk, the two files you write to
shape the editor at startup, the Customize machinery for settings, and
the face-and-theme system that decides how the editor looks. By the end
you will know which file each kind of change belongs in and how to make a
change persist across restarts.

### Where your configuration lives

Godot keeps everything it owns — your configuration, your saved
settings, your colours, your snippets, and its crash-recovery
snapshots — in a single per-user **config home**:

```
~/.godot
```

The name follows Emacs's `~/.emacs.d`, and the location is the same on
every platform. It is deliberately *not* Electron's per-application data
directory — that is where Chromium parks its caches, cookies, and GPU
blobs, tens of megabytes of opaque machinery, and Godot's half-dozen
small, user-editable files do not belong buried in there. (The first
launch after this arrangement was introduced migrates your config out of
the old location automatically, non-destructively.)

Setting the `GODOT_HOME` environment variable relocates the whole
directory — handy for a throwaway profile, or for keeping a test
configuration isolated from your real one:

```
GODOT_HOME=/tmp/godot-experiment ./node_modules/.bin/electron .
```

You will rarely need to type the path by hand — the editor reads and
writes these files for you — but it is worth knowing where they are,
because they are plain text and plain JSON and you may edit or back
them up directly.

The directory holds a small, legible set of entries:

| Entry | Written by | What it is |
|-------|------------|------------|
| `init.lisp` | you | Your free-form startup configuration. Evaluated at launch. |
| `custom.lisp` | the editor | Your saved Customize settings. Machine-written. |
| `faces.json` | the editor | Your face colours, user-created faces, and highlight rules. |
| `workspaces.json` | the editor | The session manager's store: your named workspaces plus the always-on last-session snapshot (windows, pane splits, geometry). |
| `session.json` | the editor | A legacy seed — the server's first boot imported your open files from it; thereafter it is ignored in favour of `workspaces.json`. |
| `panes.json` | the editor | The drag-splitter sizes (the preview pane's width, the utility dock's height), re-saved after each drag. |
| `projects-index.json` | the editor | The catalogue of known projects — path and display name, most recent first. (A project's own state travels with the project, in a `.godot/` folder inside its root.) |
| `snippets/` | you | Your snippet files, in yasnippet's format — the snippet engine reads this directory. See the Productivity chapter. |
| `recovery/` | the editor | Crash-recovery snapshots of unsaved buffers, one file each. |

The distinction that matters: **`init.lisp` and `snippets/` are yours,
the rest are the editor's.** You write `init.lisp` (and your snippet
files) by hand. The editor writes the others in response to what you do
in the running window — saving a setting, recolouring a face, saving a
workspace — and a hand-edit to one of them is liable to be overwritten
the next time the editor rewrites it.

### init.lisp — your startup configuration

`init.lisp` is the Godot equivalent of Emacs's `.emacs`: a file of
ordinary Lisp, evaluated at startup after the standard library and after
your saved customisations have loaded. Anything you can do at the REPL
you can do here, and it will be done afresh on every launch — set
variables, define commands, bind keys, enable modes.

The timing is worth knowing precisely, because it is what makes the file
powerful. Configuration is evaluated at the *end* of the server's boot,
after the entire standard library — including every language mode and
each mode's `defcustom` declarations — and before the first buffer's
major mode is chosen. So `init.lisp` may reference anything the editor
ships, and a mode-registry override here (say, routing `.md` files to
JMarkdown mode) reshapes even the very first buffer you see.

On first run the editor writes a commented template into the file so you
have a starting point. It currently looks like this:

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

Because `init.lisp` is evaluated *after* `custom.lisp`, a setting you
write here by hand wins over one saved through the Customize machinery —
the file is the last word at startup. This is deliberate: it lets you
keep most settings under Customize while still overriding any of them in
code.

A short worked example, touching the four things an init file most often
does — apply a setting, reroute a file type, define a command, and bind
a key:

```lisp
;; Open .md files in JMarkdown mode rather than plain Markdown.
(register-mode ".md" jmarkdown-mode)

;; A wider fill column. No saving needed — init.lisp IS the persistence.
(custom-apply! '*fill-column* 80)

;; A new command. Use defcommand, not define, so M-x can find it.
(defcommand insert-divider ()
  "Insert a horizontal rule."
  (insert! "---"))

;; Bind it to C-x -. Keymaps are ordinary variables holding maps;
;; see the Extending chapter for the full keymap model.
(set! c-x-keymap (assoc c-x-keymap "-" 'insert-divider))
```

A broken `init.lisp` will not stop the editor from launching. Your
configuration is evaluated while the server boots, before any window is
connected, so the complaint cannot appear in the REPL: the error is
caught and written to the server's log — visible in the terminal you
launched from — and the rest of startup proceeds. A typo in your
configuration leaves you with a working editor and a logged complaint
rather than a dead window. The same is true of `custom.lisp`.

### custom.lisp — saved settings

`custom.lisp` is the machine-written companion to `init.lisp`. When you
save a setting through the Customize machinery (below), the editor
records it here as a small Lisp form, and reconstitutes it on the next
launch. The file's own header says as much: Godot writes this file, a
hand-edit will be overwritten the next time a setting is saved, and
free-form configuration belongs in `init.lisp` instead.

Each saved setting is one line — a `custom-set-saved!` form pairing a
setting's name with its persisted value. You do not write these by hand;
you let Customize write them. If you want a setting changed *in code*,
put it in `init.lisp` instead, where it will not be clobbered.

### The Customize machinery

Settings in Godot are declared, not hard-coded. A *setting* is an
ordinary variable that has been registered with a type, a default, a
documentation string, and a group — the registration is what makes it
discoverable and editable from the Customize buffer. The declaration form
is `defcustom`; here is the real declaration of the colour theme
(docstring abridged):

```lisp
(defcustom *theme* 'dark :choice
  :group 'appearance
  :options (registered-themes)
  :on-change (lambda (name value) (apply-theme!))
  :doc "The colour theme. Applied on Apply or Save in the
   customisation buffer, and re-applied on startup. …")
```

That single form does two things: it defines `*theme*` as a normal
variable you can read like any other, and it records it in the
customisation registry so the Customize buffer knows its type
(`:choice`), its default (`'dark`), the values it may take, what it is
for, and what to *do* when it changes — the `:on-change` hook here is
why picking a theme repaints the editor at once. Note that `:options`
is computed, not a literal list: any theme you register yourself appears
in the picker automatically.

Settings are grouped, and groups nest. The root group is `godot`, and
beneath it sit the feature groups — `appearance`, `faces`, `editing`,
`views`, `panes`, `snippets`, `minimap`, `latex`, `jmarkdown`, `reftex`,
`browser`, `jukebox`, `directory-tree`, and `sticky-notes` — so the
Customize buffer can present a navigable tree. Roughly fifty settings
ship across those groups: the editing basics (`*tab-width*`,
`*indent-tabs-mode*`, `*fill-column*`, `*auto-pair*`), appearance
(`*theme*`, `*line-height*`), the crash-recovery autosave pair
(`*autosave-recovery*`, `*autosave-recovery-interval*` — both read live,
so toggling autosave or retuning its debounce takes effect at once,
without a restart), and then whole families per feature: about a dozen
LaTeX settings (`*latex-command*`, `*latex-indent-level*`, …), the
JMarkdown family (`*jmarkdown-compile-format*`, …), the RefTeX family
(`*reftex-cite-style*`, …), snippets, the minimap, and more. The group
tree in the Customize buffer is the map; wander it once.

Open the Customize buffer with `M-x customize` (cmd(customize)). It
reads the registry and renders every setting as an editable widget — a
checkbox for a `:boolean`, a dropdown for a `:choice`, a native colour
picker for a `:colour`, a multi-line area for a `:text`, and a plain
field for strings and numbers — alongside its documentation and its
current *state*. A setting's state tells you where its value came from:
**standard** when it still holds its default, **set** when you have
changed it this session but not saved it, and **saved** when its value
has been persisted to `custom.lisp`. (While an edit sits in a widget,
unapplied, the badge reads **edited**.)

Two scoped entry points save you the navigation when you know what you
are after: `(customize-group 'latex)` opens the buffer at one group, and
`(customize-variable '*fill-column*)` opens it at a single setting.
Both are Lisp procedures — call them from the REPL or bind them.
`M-x customize-faces` (cmd(customize-faces)) is the third scoped entry,
covered under faces below.

From Lisp, the same machinery is a handful of procedures:

- `(custom-value '*name*)` — the current value of a setting.
- `(custom-default '*name*)` — its declared default.
- `(custom-state '*name*)` — `'standard`, `'set`, or `'saved`.
- `(custom-apply! '*name* value)` — change a setting for this session
  only (updates the registry, the variable, and runs any `:on-change`
  hook).
- `(custom-apply-and-save! '*name* value)` — change it *and* persist it
  to `custom.lisp`.
- `(custom-reset! '*name*)` — return it to its default for the session.

So a setting can be changed three ways, with increasing permanence:
`set!` the variable directly (crude — see below), `custom-apply!` it
(clean, this session), or `custom-apply-and-save!` it (clean, and it
survives a restart). Saving is what writes the line to `custom.lisp`;
applying without saving does not.

The `set!` route deserves its warning spelled out. The Customize
registry keeps its own copy of each setting's value — `custom-value`
reads the registry, not the variable — so a bare `set!` leaves the two
out of sync: the `:on-change` hook does not run, the Customize buffer
goes on showing the old value, and the setting's state is a lie until
the next `custom-apply!`. Use `set!` on plain variables; use the
`custom-` procedures on settings.

### Faces and theming

A **face** is a named bundle of text-display attributes — a foreground
colour, an optional background, a weight, a slant, underline,
strike-through, and (where a face sets them) a font size and family.
Syntax highlighting works by mapping each kind of token the parser
recognises (a keyword, a string, a comment) to a face, and painting the
token with that face's attributes. Godot ships fifteen built-in token
faces — `comment`, `string`, `number`, `keyword`, `constant`,
`function`, `variable`, `property`, `type`, `tag`, `operator`, `paren`,
`heading`, `code`, and `link` — and the theme decides their colours.

Two other kinds of face are worth knowing about. The **`default`
face** is the root of the system and owns the editor's base
*typography*: its `:size` and `:family` set the font for the whole
editing surface, and every other face inherits them unless it overrides.
This makes the editor's font a live face attribute — change `default`'s
size in `M-x customize-faces` and the editor re-renders on the spot, no
restart. (Its colours stay theme-owned; the base face deliberately does
not set them.) And beyond the token faces there are **feature faces**
— `search-match` and `isearch` (the search highlights), the snippet
field faces, and so on — which are real registered faces you can
recolour the same way.

A face is declared with `defface`, which records a documentation string
and per-theme defaults. Here is the real declaration of `keyword`:

```lisp
(defface 'keyword
  :doc "Language keywords (if, return, def, let, lambda, …)."
  :default-solarized-light (face :foreground "#687800")
  :default-dark            (face :foreground "#c594c5")
  :default-bright          (face :foreground "#d56bff")
  :default-midnight        (face :foreground "#ff7b72")
  :default-solarized-dark  (face :foreground "#859900")
  :default-emacs           (face :foreground "#ffffff")
  :default-nova            (face :foreground "#60aeeb"))
```

A face does *not* need a block for every theme: a theme with no
`:default-<theme>` block for a given face falls back to that face's
`:default-dark`. This is why user-created faces and user themes stay
small — you declare only where you diverge from the dark defaults.

Faces may inherit from one another with `(defface 'child from 'parent
…)`, so a child face starts from its parent's resolved attributes and
overrides only what it names.

#### Themes

A **theme** is two things together: a set of chrome colours (the
window's background, foreground, accent, the selection tint, the
terminal's ANSI palette — applied as CSS variables) and the per-theme
face defaults registered by every `defface`. Seven themes ship:

| Theme | Character |
|-------|-----------|
| `dark` | Mariana — the calm default dark scheme; the editor opens in this. |
| `bright` | Dark chrome with a punchier syntax palette — the same background as `dark`, but the token colours are saturated and luminous. |
| `midnight` | A second dark theme — higher-contrast, near-black background. |
| `solarized-light` | Ethan Schoonover's daylight scheme: a warm paper base under low-contrast, equiluminant accents. |
| `solarized-dark` | The night half of the pair — the same accents on Solarized's dark ground. |
| `emacs` | A deep teal-slate ground under wheat body text — a richer, darker take on Emacs's classic wheat-on-darkslategray. |
| `nova` | The "Dark" theme from Panic's Nova editor: near-black charcoal under cool blue keywords, mint functions, salmon strings. |

Note that `bright` is a *dark-background* theme despite the name: it
shares `dark`'s background and only its token colours are brighter. And
if you are looking for a theme called `light` — it was renamed
`solarized-light` when its dark twin arrived; a `*theme*` value saved
under the old name is migrated automatically on the next launch.

The active theme is held in the `*theme*` setting, so the cleanest way
to switch is through Customize — set `*theme*` and Apply, or evaluate
`(custom-apply! '*theme* 'nova)` at the REPL to see it change at once.
Switching the theme rewrites the chrome variables and regenerates the
token colours, reapplying any face overrides you have made under the new
theme.

Adding a theme of your own is two local edits: a `define-theme` form for
its chrome variables, and a `:default-<theme>` block on each face you
want to colour (every face you skip falls back to its dark default).
Because `*theme*`'s options are computed from `registered-themes`, your
theme appears in the Customize picker automatically — put the
`define-theme` in `init.lisp` and it is there on every launch.

#### Inspecting and creating faces

Two help commands turn the face system into something you can poke at
directly from the buffer, without knowing the face names in advance.

`C-h F` (cmd(describe-face-at-point)) is the diagnostic: put the cursor
on a highlighted construct and press it, and the editor opens a *Face at
point* page naming the face that produced the colour there, its CSS
class, the active theme's resolved colour for it, the construct's range,
and the text it covers. When the parser recognised the construct but no
highlighting rule fires on it, the page falls back to showing the raw
node type and its ancestor chain — the information you would need to
write a rule for it. (The command is also aliased
cmd(describe-syntax-at-point), for people who think of it that way.)

`C-h C-f` (cmd(highlight-construct-at-point)) is the *action* that page
points you to. With the cursor on a construct, it walks you through, in
the minibuffer:

1. **name a face** — an existing one (`keyword`, `function`, `variable`,
   …) or a brand-new name;
2. if the name is new, **pick its foreground colour** — a face is created
   on the spot;
3. **choose a scope** — answer `m` (or just press Enter) for *this major
   mode only*, or `l` for *everywhere for the language*.

The rule it builds maps the construct's node type to your face and
applies it immediately — no file editing, no restart — and it is
remembered across launches. It layers over the built-in grammar query
rather than touching any language file. Between the two commands you can
go from "what is that colour?" to "recolour it, here, for good" in a few
keystrokes.

To recolour an *existing* face rather than reassign a construct, open the
Customize buffer scoped to faces with `M-x customize-faces`
(cmd(customize-faces)), which renders a row of widgets for every face.
From Lisp the same is done with `set-face-attribute`:

```lisp
(set-face-attribute 'keyword :foreground "#ff5370")
```

Override attributes can be scoped three ways, most-specific winning:
per-mode beats per-theme beats global, and anything you have not
overridden falls through to the built-in default. With no extra argument
the override is **global** (every theme); with `:theme 'dark` it applies
under that theme only; with `:mode "LaTeX"` it applies in that major
mode only. An override is always a small, surgical change rather than a
full redefinition.

Dropping overrides is scoped the same way, with one asymmetry to note:
`reset-face` takes the global and `:theme` scopes only —

```lisp
(reset-face 'keyword)                 ; drop the global override
(reset-face 'keyword :theme 'dark)    ; drop the dark-theme override
(reset-face-in-mode! 'keyword "LaTeX") ; drop the per-mode override
```

— and `reset-all-faces` wipes every override in all three buckets back
to the shipped defaults.

#### Faces and highlight rules from Lisp

Everything the interactive flows do is ordinary Lisp underneath, and the
programmatic surface is worth knowing for `init.lisp` use or batch
recolouring. Three graded moves, in increasing ambition:

**Recolour an existing face.** `set-face-attribute` (above) changes one
attribute; `set-face!` replaces a face's whole override map at once,
with the same `:theme` keyword; `set-face-in-mode!` does the same for
the per-mode bucket:

```lisp
(set-face! 'comment (face :foreground "#8a9a5b" :slant :italic))
(set-face-in-mode! 'string "LaTeX" (face :foreground "#2aa198"))
```

**Reassign a construct to a face.** The highlight-rule store maps a
tree-sitter node type (or query fragment) to a face, layered on top of
the language's built-in query. This is exactly what `C-h C-f` writes —
the *Face at point* page even prints the equivalent form:

```lisp
(add-highlight-rule! 'mode "LaTeX" "command_name" 'keyword)
```

The scope is `'mode` with the major mode's display name (`"LaTeX"`,
`"Python"`) or `'language` with the language tag (`"latex"`,
`"python"`). `remove-highlight-rule!` drops one rule;
`clear-highlight-rules!` drops them all. Every change re-pushes the rule
set to the highlighter (live) and persists to `faces.json`.

**Create a new face.** `create-face!` mints a user face with a
foreground colour, optional `:parent` (inheritance) and `:doc`, applies
it immediately, and persists it so it is re-registered on every launch:

```lisp
(create-face! 'shouting "#ff2200" :doc "For text that must be seen.")
(add-highlight-rule! 'mode "Python" "decorator" 'shouting)
```

The same colour seeds the new face's default in every theme; recolour it
per theme afterwards through `M-x customize-faces` or
`set-face-attribute` if you want it theme-aware.

### Persisting changes — what sticks, and where

Pulling the pieces together, here is which change goes where, and which
ones survive a restart on their own:

| Change | How it persists |
|--------|-----------------|
| A setting (`*theme*`, `*fill-column*`, …) | Save it in Customize, or `custom-apply-and-save!` it → `custom.lisp`. |
| A face recolour or a new face | Live as you make it; written automatically → `faces.json`. |
| A construct → face highlight rule | Live as you make it; written automatically → `faces.json`. |
| A window/pane arrangement worth keeping | Save it as a named workspace — the session manager writes `workspaces.json` (and snapshots your last session there regardless). |
| A snippet | A file you write under `~/.godot/snippets/` — see the Productivity chapter. |
| Anything else (new commands, key bindings, variables, themes) | Put it in `init.lisp`. |

The asymmetry is worth holding onto. **Face and highlight changes
persist themselves** — recolour a face through Customize or `C-h C-f` and
it is already in `faces.json`; you do nothing further. **Settings persist
only when you save them** — apply one without saving and it lasts the
session, no longer. **Everything else you want kept goes in `init.lisp`**
by hand, because the editor never writes that file after creating it.

`faces.json` is machine-written but legible: three override buckets
(`global`, `themes`, `perMode`), your user-created faces, and your
highlight rules, as plain JSON. Hand-editing it works — the shape is
documented at the top of `apps/desktop/src/face-overrides.js` — but
remember the editor rewrites the file on the next face change, so
`init.lisp` (via the procedures above) is the better home for anything
you want to keep in code.

### Where to look

The code map for this chapter, for when the manual is not enough:

- `packages/stdlib/lisp/custom.lisp` — the settings registry:
  `defgroup`, `defcustom`, `custom-apply!` and friends, the Customize
  buffer's data model.
- `packages/stdlib/lisp/faces.lisp` — `defface`, the override buckets
  and resolution order, `create-face!`, `set-face-attribute`,
  `reset-face` and friends.
- `packages/stdlib/lisp/themes.lisp` — the seven `define-theme` forms,
  the token-face `defface`s, the `*theme*` setting.
- `packages/stdlib/lisp/highlight-rules.lisp` —
  `add-highlight-rule!` and the rule store.
- `packages/stdlib/lisp/face-info.lisp` — the `C-h F` / `C-h C-f`
  flows.
- `apps/desktop/src/config-home.js` — the `~/.godot` resolution,
  `GODOT_HOME`, the first-run migration.
- `apps/desktop/src/face-overrides.js` — `faces.json`'s on-disk shape.
- `apps/desktop/mwb/spine.js` — where `custom.lisp` and `init.lisp` are
  evaluated at boot, and the first-run `init.lisp` template.
