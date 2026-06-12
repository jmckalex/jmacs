## Customization

Almost everything in this manual so far has changed the editor for the
length of a session: an expression in the REPL, a key rebound, a command
redefined. Those changes are real, but they vanish when you quit. This
chapter is about the other half — making changes *stick*. It covers
where jmacs keeps your configuration on disk, the two files you write to
shape the editor at startup, the Customize machinery for settings, and
the face-and-theme system that decides how the editor looks. By the end
you will know which file each kind of change belongs in and how to make a
change persist across restarts.

### Where your configuration lives

jmacs keeps everything it owns — your configuration, your saved
settings, your colours, and its crash-recovery snapshots — in a single
per-user **data directory**. The exact location follows each platform's
convention:

| Platform | Data directory |
|----------|----------------|
| macOS | `~/Library/Application Support/<App>/` |
| Linux | `~/.config/<App>/` |
| Windows | `%APPDATA%\<App>\` |

`<App>` is the application's name; the host resolves the directory at
startup (through Electron's per-user data path) and exposes it to the
Lisp side. You will rarely need to type the path by hand — the editor
reads and writes these files for you — but it is worth knowing where they
are, because they are plain text and plain JSON and you may edit or back
them up directly.

The directory holds a small, legible set of files:

| File | Written by | What it is |
|------|------------|------------|
| `init.lisp` | you | Your free-form startup configuration. Evaluated at launch. |
| `custom.lisp` | the editor | Your saved Customize settings. Machine-written. |
| `faces.json` | the editor | Your face colours, user-created faces, and highlight rules. |
| `session.json` | the editor | The open views, restored on the next launch. |
| `panes.json` | the editor | The pane-split layout, kept beside the session. |
| `recovery/` | the editor | Crash-recovery snapshots of unsaved buffers, one file each. |

The distinction that matters: **`init.lisp` is yours, the rest are the
editor's.** You write `init.lisp` by hand. The editor writes the others
in response to what you do in the running window — saving a setting,
recolouring a face, opening and closing views — and a hand-edit to one of
them is liable to be overwritten the next time the editor rewrites it.

### init.lisp — your startup configuration

`init.lisp` is the jmacs equivalent of Emacs's `.emacs`: a file of
ordinary Lisp, evaluated at startup after the standard library and after
your saved customisations have loaded. Anything you can do at the REPL
you can do here, and it will be done afresh on every launch — set
variables, define commands, bind keys, enable modes.

On first run the editor writes a commented template into the file so you
have a starting point. It looks like this:

```lisp
;;; init.lisp — your jmacs configuration.
;;;
;;; This file is evaluated at startup, after the standard library and
;;; your saved customisations. It is the jmacs equivalent of .emacs:
;;; ordinary Lisp, so anything goes — set variables, define commands,
;;; bind keys.
;;;
;;; Examples:
;;;   (custom-apply! '*markdown-interpreter* "pandoc -f markdown -t html")
;;;   (define (insert-divider) (insert! "\n---\n"))
```

Because `init.lisp` is evaluated *after* `custom.lisp`, a setting you
write here by hand wins over one saved through the Customize machinery —
the file is the last word at startup. This is deliberate: it lets you
keep most settings under Customize while still overriding any of them in
code.

A broken `init.lisp` will not stop the editor from launching. If
evaluating it raises an error, the error is reported in the REPL and the
rest of startup proceeds, so a typo in your configuration leaves you with
a working editor and a visible complaint rather than a dead window. The
same is true of `custom.lisp`.

### custom.lisp — saved settings

`custom.lisp` is the machine-written companion to `init.lisp`. When you
save a setting through the Customize machinery (below), the editor
records it here as a small Lisp form, and reconstitutes it on the next
launch. Its header says as much:

```lisp
;;; custom.lisp — your saved customisations.
;;;
;;; jmacs writes this file; edits made by hand will be overwritten the
;;; next time a setting is saved. For free-form configuration, use
;;; init.lisp instead.
```

Each saved setting is one line — a `custom-set-saved!` form pairing a
setting's name with its persisted value. You do not write these by hand;
you let Customize write them. If you want a setting changed *in code*,
put it in `init.lisp` instead, where it will not be clobbered.

### The Customize machinery

Settings in jmacs are declared, not hard-coded. A *setting* is an
ordinary variable that has been registered with a type, a default, a
documentation string, and a group — the registration is what makes it
discoverable and editable from the Customize buffer. The declaration form
is `defcustom`:

```lisp
(defcustom *theme* 'dark :choice
  :group 'appearance
  :options '(dark bright light midnight)
  :doc "The colour theme.")
```

That single form does two things: it defines `*theme*` as a normal
variable you can read and `set!` like any other, and it records it in the
customisation registry so the Customize buffer knows its type
(`:choice`), its default (`'dark`), the values it may take, and what it
is for. Settings are grouped, and groups nest: the root group is `jmacs`,
with `appearance` and `faces` beneath it, and a setting names its group
so the Customize buffer can present a navigable tree.

Open the Customize buffer with `M-x customize` (cmd(customize)). It reads
the registry and renders every setting as an editable widget — a checkbox
for a `:boolean`, a dropdown for a `:choice`, a field for a string or a
number — alongside its documentation and its current *state*. A
setting's state tells you where its value came from: **standard** when it
still holds its default, **set** when you have changed it this session
but not saved it, and **saved** when its value has been persisted to
`custom.lisp`.

From Lisp, the same machinery is a handful of procedures:

- `(custom-value '*name*)` — the current value of a setting.
- `(custom-apply! '*name* value)` — change a setting for this session
  only (updates the variable and runs any on-change hook).
- `(custom-apply-and-save! '*name* value)` — change it *and* persist it
  to `custom.lisp`.
- `(custom-reset! '*name*)` — return it to its default for the session.

So a setting can be changed three ways, with increasing permanence:
`set!` the variable directly (crude, bypasses the on-change hook),
`custom-apply!` it (clean, this session), or `custom-apply-and-save!` it
(clean, and it survives a restart). Saving is what writes the line to
`custom.lisp`; applying without saving does not.

A handful of settings ship as `defcustom`s you can reach this way. The
colour theme, `*theme*`, is one (covered below). Two more govern
crash-recovery autosave: `*autosave-recovery*` (a boolean — write
snapshots of unsaved buffers, on by default) and
`*autosave-recovery-interval*` (a number of milliseconds — the autosave
debounce). Both are read live by the host, so toggling autosave or
retuning its interval from the Customize buffer takes effect at once,
without a restart.

### Faces and theming

A **face** is a named bundle of text-display attributes — a foreground
colour, an optional background, a weight, a slant, underline, and
strike-through. Syntax highlighting works by mapping each kind of token
the parser recognises (a keyword, a string, a comment) to a face, and
painting the token with that face's attributes. jmacs ships fourteen
built-in token faces — `comment`, `string`, `number`, `keyword`,
`constant`, `function`, `variable`, `type`, `tag`, `operator`, `paren`,
`heading`, `code`, and `link` — and the theme decides their colours.

A face is declared with `defface`, which records a documentation string
and a per-theme default for each shipped theme:

```lisp
(defface 'keyword
  :doc "Language keywords (if, return, def, let, lambda, …)."
  :default-light    (face :foreground "#859900")
  :default-dark     (face :foreground "#c594c5")
  :default-bright   (face :foreground "#d56bff")
  :default-midnight (face :foreground "#ff7b72"))
```

Faces may inherit from one another with `(defface 'child from 'parent
…)`, so a child face starts from its parent's resolved attributes and
overrides only what it names.

#### Themes

A **theme** is two things together: a set of chrome colours (the
window's background, foreground, accent, the selection tint, the
terminal's ANSI palette — applied as CSS variables) and the per-theme
face defaults registered by every `defface`. Four themes ship:

| Theme | Character |
|-------|-----------|
| `dark` | Mariana — the calm default dark scheme; the editor opens in this. |
| `bright` | The same dark background as `dark`, but a saturated, luminous syntax palette. |
| `light` | Solarized Light — easy on the eyes in daylight. |
| `midnight` | A second dark theme — higher-contrast, near-black background. |

Note that `bright` is a *dark-background* theme despite the name: it
shares `dark`'s background and only its token colours are brighter. The
active theme is held in the `*theme*` setting, so the cleanest way to
switch is through Customize — set `*theme*` and Apply, or evaluate
`(custom-apply! '*theme* 'midnight)` at the REPL to see it change at
once. Switching the theme rewrites the chrome variables and regenerates
the token colours, reapplying any face overrides you have made under the
new theme.

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
`describe-syntax-at-point`, for people who think of it that way.)

`C-h C-f` (cmd(highlight-construct-at-point)) is the *action* that page
points you to. With the cursor on a construct, it walks you through, in
the minibuffer:

1. **name a face** — an existing one (`keyword`, `function`, `variable`,
   …) or a brand-new name;
2. if the name is new, **pick its foreground colour** — a face is created
   on the spot;
3. **choose a scope** — this major mode only (the default) or everywhere
   for the language.

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

Override attributes can be scoped three ways, most-specific winning.
With no extra argument the override is **global** (every theme); with
`:theme 'dark` it applies under that theme only; with `:mode "LaTeX"` it
applies to that major mode only. Any attribute you do not override falls
through to the built-in default, so an override is always a small,
surgical change rather than a full redefinition. `reset-face` drops an
override, and `reset-all-faces` wipes every one back to the shipped
defaults.

### Persisting changes — what sticks, and where

Pulling the pieces together, here is which change goes where, and which
ones survive a restart on their own:

| Change | How it persists |
|--------|-----------------|
| A setting (`*theme*`, autosave, …) | Save it in Customize, or `custom-apply-and-save!` it → `custom.lisp`. |
| A face recolour or a new face | Live as you make it; written automatically → `faces.json`. |
| A construct → face highlight rule | Live as you make it; written automatically → `faces.json`. |
| Anything else (new commands, key bindings, variables) | Put it in `init.lisp`. |

The asymmetry is worth holding onto. **Face and highlight changes
persist themselves** — recolour a face through Customize or `C-h C-f` and
it is already in `faces.json`; you do nothing further. **Settings persist
only when you save them** — apply one without saving and it lasts the
session, no longer. **Everything else you want kept goes in `init.lisp`**
by hand, because the editor never writes that file after creating it.

When you change the standard library and reload it with `C-x C-r`
(cmd(reload-stdlib)), all of this is re-established: your saved settings,
your face overrides, your highlight rules, and your `init.lisp` are
reapplied on top of the freshly-loaded library, so a reload leaves your
configuration intact rather than resetting the editor to its shipped
state.
