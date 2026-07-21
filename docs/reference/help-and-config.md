Title: Godot Help, Bookmarks & Customization
Author: J. McKenzie Alexander
Date: 2026-07-21
---

## Help, bookmarks, and customization

This document describes the commands that let you find your way back to a
place (bookmarks), change how the editor looks and behaves
(customization and faces), ask the editor about itself (help and
self-documentation), and the surfaces that hold a session together (the
REPL panel and crash recovery). It closes with the user-facing
*settings* — `defcustom` variables you can change live or persist across
restarts.

These are ordinary Lisp in the standard library
(`packages/stdlib/lisp/bookmarks.lisp`, `custom.lisp`, `faces.lisp`,
`face-info.lisp`, `docs.lisp`, `system.lisp`, `themes.lisp`,
`files.lisp`, `indent.lisp`, `auto-pair.lisp`, `sticky-notes.lisp`),
built on the host primitives. `help.lisp`'s own commands —
cmd(describe-key) (`C-h k`) and cmd(describe-command) (`C-h f`) — are
documented in `commands.md`.

Entries follow the convention of `commands.md`: a *command* is a
procedure runnable by name with `M-x` and usually bound to a key; a
*setting* is a `defcustom` variable. See `index.md` for how to read an
entry. Key bindings are given in the manual's notation: `C-` is
Control, `M-` is Command (the Cmd key), `A-` is Option, `S-` is Shift.
(Every chord in this file is a `C-x` or `C-h` chord; an `A-` chord
left unbound falls back to inserting the character Option composed.)

---

### Bookmarks

Defined in `bookmarks.lisp`. A bookmark is a named, persistent position
in a buffer: an invisible, edit-tracking buffer marker named and
persisted by the host. Bookmarks ride edits and survive across sessions.
They are bound under the `C-x r` prefix (Emacs's register/bookmark
family). Every text buffer carries the `bookmark-minor-mode` minor mode
by default — it has no keymap of its own (the keys are global) and just
marks the buffer as bookmark-capable in the modeline.

:::function{name="bookmark-set" path="reference/help-and-config/bookmark-set.html"}
#### `bookmark-set`
`(bookmark-set name)`

Set (or move) a named bookmark at point — re-using a `name` moves it.
Prompts for the name in the minibuffer. Bound to `C-x r m`.
:::

:::function{name="bookmark-jump" path="reference/help-and-config/bookmark-jump.html"}
#### `bookmark-jump`
`(bookmark-jump name)`

Jump to a named bookmark. Prompts for the name in the minibuffer. Bound
to `C-x r b`.
:::

:::function{name="bookmark-delete" path="reference/help-and-config/bookmark-delete.html"}
#### `bookmark-delete`
`(bookmark-delete name)`

Delete a named bookmark. Prompts for the name in the minibuffer. No
default key — `C-x r d` is Emacs's delete-rectangle — so delete a
bookmark via `M-x bookmark-delete` or the bookmark list.
:::

:::function{name="list-bookmarks" path="reference/help-and-config/list-bookmarks.html"}
#### `list-bookmarks`
`(list-bookmarks)`

Toggle the bookmark outline for the current buffer: open it beside the
document, or close it if it is already open. Bookmarks list in
document order, as a hierarchical outline. Bound to `C-x r l`.

Inside the outline: arrows or `n` / `p` select, `Enter` jumps to the
mark, `Tab` / `Shift-Tab` indent / outdent the selected entry together
with its whole subtree, `Space` toggles the selected parent's
disclosure (folding its subtree), `r` renames inline, `d` deletes, `g`
refreshes (re-deriving each bookmark's line and column after source
edits), and `q` closes the outline. Right-click offers a rename/delete
menu. Chords (`C-x …`, `M-x`) pass through to the editor.
:::

### Customization

Defined in `custom.lisp` (the registry) and `themes.lisp` (the theme
setting). `defcustom` declares a user-customisable setting — a variable
with a type, a group, a default and a docstring — recorded in a registry
the customisation view reads and writes. A setting holds its default and
its current (session) value; its *state* is derived by comparing the
two, and a *saved* value persists across restarts. See the *Settings*
section below for the individual variables, and the Customization
chapter of the manual for the machinery as a workflow.

:::function{name="customize" path="reference/help-and-config/customize.html"}
#### `customize`
`(customize)`

Open the customisation buffer for all settings. The buffer lets you
browse settings by group, edit values with widgets, and Apply or Save
the changes (Save persists to the custom file).
:::

:::function{name="customize-group" path="reference/help-and-config/customize-group.html"}
#### `customize-group`
`(customize-group group)`

Open the customisation buffer scoped to `group` (a symbol — `'latex`,
`'appearance`, …). A plain procedure, not an `M-x` command: call it
from the REPL or `init.lisp`, e.g. `(customize-group 'editing)`.
Defined in `custom.lisp`.
:::

:::function{name="customize-variable" path="reference/help-and-config/customize-variable.html"}
#### `customize-variable`
`(customize-variable name)`

Open the customisation buffer scoped to the single setting `name` (a
symbol, e.g. `'*theme*`). Like cmd(customize-group), a plain procedure
for the REPL or `init.lisp` rather than an `M-x` command. Defined in
`custom.lisp`.
:::

:::function{name="customize-faces" path="reference/help-and-config/customize-faces.html"}
#### `customize-faces`
`(customize-faces)`

Open the customisation buffer scoped to the Faces group — one row per
registered syntax-highlighting face, with widgets for foreground,
background, weight, slant, underline and strike-through. Defined in
`custom.lisp` (not `faces.lisp`, so that `M-x customize-faces`
resolves server-side; the Faces model it shows is still rendered where
the face registry lives).
:::

### Faces and themes

Defined in `faces.lisp` and `face-info.lisp`. A *face* is a tagged
attribute set — foreground colour, background colour, weight, slant,
underline, strike-through. Syntax-highlight tokens (tree-sitter capture
names like `@keyword`) become CSS classes (`tok-keyword`) painted by
face attributes. A face resolves through three layers under the active
theme: the built-in default, the user's per-theme override, and the
user's global override (more-specific wins, with fall-through for
attributes left un-overridden). Your overrides — and any face you
create with `create-face!` or cmd(highlight-construct-at-point) —
persist to `faces.json` in the config home (`~/.godot`), so they
survive restarts. See the Customization chapter's *Faces and theming*
section and the `*theme*` setting below.

:::function{name="describe-face-at-point" aliases="describe-syntax-at-point" path="reference/help-and-config/describe-face-at-point.html"}
#### `describe-face-at-point` / `describe-syntax-at-point`
`(describe-face-at-point)`

Open a `*Face at point*` doc buffer describing the tree-sitter capture
under the cursor: the face name, its CSS class, the active theme's
resolved colour, the captured range, and the text it covers. When no
capture covers point but tree-sitter has parsed the construct, it falls
back to the raw node type and parent chain so you know what query rule
you'd write to face it. The diagnostic tool when customising the colour
theme. Bound to `C-h F`; aliased as `describe-syntax-at-point`.
:::

:::function{name="highlight-construct-at-point" path="reference/help-and-config/highlight-construct-at-point.html"}
#### `highlight-construct-at-point`
`(highlight-construct-at-point)`

Face the construct under the cursor in one step: name (or create and
colour) a face, assign the construct's tree-sitter node type to it, pick
a scope — this major mode (the default) or everywhere for the language —
and apply it live. The *action* companion to cmd(describe-face-at-point).
The rule layers on top of the built-in grammar query and never edits the
language's `.js` file; it persists across restarts. Bound to `C-h C-f`.
:::

### Help and self-documentation

Defined in `docs.lisp` (and `help.lisp` — see `commands.md` for its
cmd(describe-key) and cmd(describe-command)). Every command keeps its
docstring; these commands surface it. When a command also has a built
documentation page (in the manual's manifest), the help commands open
that page in a doc buffer; otherwise they render the live docstring or
print it to the REPL.

:::function{name="open-manual" path="reference/help-and-config/open-manual.html"}
#### `open-manual`
`(open-manual)`

Open the manual at its top — the table-of-contents root — in the
doc-view, with the three books (the manual, the command reference, the
Lisp guide) in the sidebar and Next/Prev/Up navigation between nodes.
Unlike cmd(open-doc), which prompts for a particular page, this opens
the manual's Top node so you can browse. Bound to `C-h d`. Defined in
`docs.lisp`.
:::

:::function{name="describe-symbol-at-point" path="reference/help-and-config/describe-symbol-at-point.html"}
#### `describe-symbol-at-point`
`(describe-symbol-at-point)`

Open the documentation for the Lisp symbol under the cursor. Routes
through cmd(open-doc), so the static manifest is tried first and the
live docstring is rendered as a fallback. Prints `no symbol at point`
when the cursor is not on a symbol. Bound to `C-h .`. Defined in
`docs.lisp`.
:::

:::function{name="apropos-doc" path="reference/help-and-config/apropos-doc.html"}
#### `apropos-doc`
`(apropos-doc)`

Fuzzy-search the documentation manifest in the minibuffer and open the
matching doc page in the doc-view. Bound to `C-h a`. Defined in
`docs.lisp`.
:::

:::function{name="open-doc" path="reference/help-and-config/open-doc.html"}
#### `open-doc`
`(open-doc name)`

Open the documentation page for the function called `name`. The pre-built
reference is consulted first; for user-defined procedures not in the
manifest, the docstring is rendered as Markdown and shown in a doc
buffer. Falls back to a REPL message when `name` names nothing
documented. Prompts for the name in the minibuffer when called
interactively. Defined in `docs.lisp`.
:::

### Session and the REPL

Defined in `system.lisp`. The REPL panel is the editor's evaluation and
message surface; crash recovery brings back unsaved work after a crash.

:::function{name="toggle-repl" path="reference/help-and-config/toggle-repl.html"}
#### `toggle-repl`
`(toggle-repl)`

Show or hide the REPL panel. Bound to `C-x p`.
:::

:::function{name="recover-session" path="reference/help-and-config/recover-session.html"}
#### `recover-session`
`(recover-session)`

Open the `*Recover*` view: scan for crash-recovery snapshots left by a
previous run and offer to recover or discard each. Runs automatically at
startup when snapshots are present; this is the manual entry point. See
the `*autosave-recovery*` setting below.
:::

### Settings

These are `defcustom` variables, not procedures — user-facing settings
you can change live, persist, or edit through `M-x customize`. Each
entry's signature line shows the default value, and each entry names
its group (`godot` is the root group; `appearance`, `editing` and
`sticky-notes` nest under it). The programmatic round-trip:

```lisp
(custom-apply! '*theme* 'nova)           ; this session only
(custom-apply-and-save! '*theme* 'nova)  ; and across restarts
```

`custom-apply!` updates the live variable and runs the setting's
`:on-change` hook, so the change takes effect immediately; the setting's
*state* then shows as changed-but-unsaved until you save it.

:::function{name="*find-file-case-sensitive*" path="reference/help-and-config/find-file-case-sensitive.html"}
#### `*find-file-case-sensitive*`
`(default #f)`

When `#t`, `find-file`'s TAB completion matches filenames with case taken
into account; when `#f` (the default), the prefix matches regardless of
case. Completion always uses the filename's on-disk case — typing `rea`
and TABbing into a directory with `README.md` produces `README.md`.
Group: `godot`. Defined in `files.lisp`.
:::

:::function{name="*auto-pair*" path="reference/help-and-config/auto-pair.html"}
#### `*auto-pair*`
`(default #t)`

Insert the matching bracket or quote when an opener is typed. With it
on, typing `(`, `[`, `{`, `"` or `` ` `` inserts the closing partner
too, leaving the cursor between the pair; typing a closer when the next
character already is that closer steps past it instead of duplicating;
Backspace between an empty pair deletes both characters. With it off,
the keys self-insert plainly. Group: `godot`. Defined in
`auto-pair.lisp`.
:::

:::function{name="*theme*" path="reference/help-and-config/theme.html"}
#### `*theme*`
`(default 'dark)`

The colour theme. Applied on Apply or Save in the customisation buffer,
and re-applied on startup; a `:choice` setting whose `:on-change` hook
re-applies the theme live. The options are every registered theme
(`registered-themes`), so a theme you define yourself appears too. The
shipped seven: `dark` (Mariana), `bright` (dark chrome with a punchier
syntax palette), `solarized-light`, `solarized-dark`, `midnight` (a
near-black dark), `emacs` (classic wheat-on-darkslategray) and `nova`
(a blue-grey dark). A value of `light` saved before Solarized Light
was renamed migrates to `solarized-light` on startup. For per-theme
face tweaks on top of a theme, see cmd(customize-faces) and
cmd(describe-face-at-point). Group: `appearance`. Defined in
`themes.lisp`.
:::

:::function{name="*line-height*" path="reference/help-and-config/line-height.html"}
#### `*line-height*`
`(default 1.35)`

The editor's line spacing, as a multiple of the font size (the
surface's CSS line-height). 1.0 is tight; the default 1.35 is
comfortable for code. Applied to the editor via the `--line-height`
CSS variable — live on Apply, re-applied on startup, and clamped to a
sane range. Group: `appearance`. Defined in `themes.lisp`.
:::

:::function{name="*autosave-recovery*" path="reference/help-and-config/autosave-recovery.html"}
#### `*autosave-recovery*`
`(default #t)`

Whether to write crash-recovery snapshots of unsaved buffers (debounced
after edits, and on window blur). Turn it off to disable autosave
entirely — note that a crash will then lose unsaved work. Existing
snapshots are cleared on a clean quit regardless. Read live by the host
on each autosave, so toggling takes effect without a restart. Group:
`editing`. Defined in `system.lisp`.
:::

:::function{name="*autosave-recovery-interval*" path="reference/help-and-config/autosave-recovery-interval.html"}
#### `*autosave-recovery-interval*`
`(default 1000)`

Milliseconds to wait after an edit before writing a crash-recovery
snapshot — the autosave debounce. Lower values snapshot more eagerly;
higher values write less often. Read live by the host, so retuning takes
effect without a restart. Group: `editing`. Defined in `system.lisp`.
:::

:::function{name="*tab-width*" path="reference/help-and-config/tab-width.html"}
#### `*tab-width*`
`(default 4)`

How many columns wide a tab character appears, and how many spaces
`insert-tab` produces when `*indent-tabs-mode*` is off. Applies to the
editor view and the directory-columns preview pane via the
`--tab-width` CSS variable, which the host synchronises after stdlib
load and on every change of this setting. Group: `editing`. Defined in
`indent.lisp`.
:::

:::function{name="*indent-tabs-mode*" path="reference/help-and-config/indent-tabs-mode.html"}
#### `*indent-tabs-mode*`
`(default #t)`

When `#t` (the default), the Tab key inserts a literal tab character;
when `#f`, it inserts `*tab-width*` spaces. A major mode can pin a
mode-local value via the `:indent-tabs?` key on its mode map, which
wins over this global setting (Makefile-mode pins it on; a mode that
needs spaces can pin it off). Group: `editing`. Defined in
`indent.lisp`.
:::

:::function{name="*markdown-interpreter*" path="reference/help-and-config/markdown-interpreter.html"}
#### `*markdown-interpreter*`
`(default "marked")`

The Markdown renderer used for both sticky notes and the live docstring
path in the documentation viewer. `"marked"` selects the bundled
marked.js library — a known-working CommonMark+GFM renderer that requires
no external programs. Any other string is treated as a shell command that
reads Markdown on stdin and prints HTML on stdout (useful for a richer
dialect such as JMarkdown or pandoc):

```lisp
(custom-apply! '*markdown-interpreter* "pandoc -f markdown -t html")
```

Group: `sticky-notes`. Defined in `sticky-notes.lisp`.
:::
