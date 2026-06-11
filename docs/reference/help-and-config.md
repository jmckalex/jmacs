Title: jmacs Help, Bookmarks & Customization
Author: J. McKenzie Alexander
Date: 2026-06-11
---

# Help, bookmarks, and customization

This document describes the commands that let you find your way back to a
place (bookmarks), change how the editor looks and behaves
(customization and faces), ask the editor about itself (help and
self-documentation), and the surfaces that hold a session together (the
REPL panel and crash recovery). It closes with the user-facing
*settings* — `defcustom` variables you can change live or persist across
restarts.

These are ordinary Lisp in the standard library
(`packages/stdlib/lisp/bookmarks.lisp`, `custom.lisp`, `faces.lisp`,
`face-info.lisp`, `docs.lisp`, `help.lisp`, `system.lisp`, `themes.lisp`,
`files.lisp`, `sticky-notes.lisp`), built on the host primitives.

Entries follow the convention of `commands.md`: a *command* is a
procedure runnable by name with `M-x` and usually bound to a key; a
*setting* is a `defcustom` variable. See `index.jmd` for how to read an
entry. Key bindings are given in the manual's notation: `C-` is Control
or Command, `M-` is Option, `S-` is Shift.

---

## Bookmarks

Defined in `bookmarks.lisp`. A bookmark is a named, persistent position
in a buffer: an invisible, edit-tracking buffer marker named and
persisted by the host. Bookmarks ride edits and survive across sessions.
They are bound under the `C-x r` prefix (Emacs's register/bookmark
family). Every text buffer carries the `bookmark-minor-mode` minor mode
by default — it has no keymap of its own (the keys are global) and just
marks the buffer as bookmark-capable in the modeline.

:::function{name="bookmark-set" path="reference/help-and-config/bookmark-set.html"}
### `bookmark-set`
`(bookmark-set name)`

Set (or move) a named bookmark at point — re-using a `name` moves it.
Prompts for the name in the minibuffer. Bound to `C-x r m`.
:::

:::function{name="bookmark-jump" path="reference/help-and-config/bookmark-jump.html"}
### `bookmark-jump`
`(bookmark-jump name)`

Jump to a named bookmark. Prompts for the name in the minibuffer. Bound
to `C-x r b`.
:::

:::function{name="bookmark-delete" path="reference/help-and-config/bookmark-delete.html"}
### `bookmark-delete`
`(bookmark-delete name)`

Delete a named bookmark. Prompts for the name in the minibuffer. No
default key — `C-x r d` is Emacs's delete-rectangle — so delete a
bookmark via `M-x bookmark-delete` or the bookmark list.
:::

:::function{name="list-bookmarks" path="reference/help-and-config/list-bookmarks.html"}
### `list-bookmarks`
`(list-bookmarks)`

Open the bookmark outline for the current buffer. Bound to `C-x r l`.
Bookmarks list in document order. Navigate with arrows or `n` / `p`,
`Enter` to jump, `Tab` / `Shift-Tab` to indent / outdent, `Space` to
fold, `r` to rename, `d` to delete, `q` to close.
:::

## Customization

Defined in `custom.lisp` (the registry) and `themes.lisp` (the theme
setting). `defcustom` declares a user-customisable setting — a variable
with a type, a group, a default and a docstring — recorded in a registry
the customisation view reads and writes. A setting holds its default and
its current (session) value; its *state* is derived by comparing the
two, and a *saved* value persists across restarts. See the *Settings*
section below for the individual variables.

:::function{name="customize" path="reference/help-and-config/customize.html"}
### `customize`
`(customize)`

Open the customisation buffer for all settings. The buffer lets you
browse settings by group, edit values with widgets, and Apply or Save
the changes (Save persists to the custom file).
:::

:::function{name="customize-faces" path="reference/help-and-config/customize-faces.html"}
### `customize-faces`
`(customize-faces)`

Open the customisation buffer scoped to the Faces group — one row per
registered syntax-highlighting face, with widgets for foreground,
background, weight, slant, underline and strike-through. Defined in
`faces.lisp`.
:::

## Faces and themes

Defined in `faces.lisp` and `face-info.lisp`. A *face* is a tagged
attribute set — foreground colour, background colour, weight, slant,
underline, strike-through. Syntax-highlight tokens (tree-sitter capture
names like `@keyword`) become CSS classes (`tok-keyword`) painted by
face attributes. A face resolves through three layers under the active
theme: the built-in default, the user's per-theme override, and the
user's global override (more-specific wins, with fall-through for
attributes left un-overridden). See `docs/MANUAL.jmd` and the
`*theme*` setting below.

:::function{name="describe-face-at-point" aliases="describe-syntax-at-point" path="reference/help-and-config/describe-face-at-point.html"}
### `describe-face-at-point` / `describe-syntax-at-point`
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
### `highlight-construct-at-point`
`(highlight-construct-at-point)`

Face the construct under the cursor in one step: name (or create and
colour) a face, assign the construct's tree-sitter node type to it, pick
a scope — this major mode (the default) or everywhere for the language —
and apply it live. The *action* companion to `describe-face-at-point`.
The rule layers on top of the built-in grammar query and never edits the
language's `.js` file; it persists across restarts. Bound to `C-h C-f`.
:::

## Help and self-documentation

Defined in `help.lisp` and `docs.lisp`. Every command keeps its
docstring; these commands surface it. When a command also has a built
documentation page (in the manual's manifest), the help commands open
that page in a doc buffer; otherwise they render the live docstring or
print it to the REPL.

:::function{name="describe-symbol-at-point" path="reference/help-and-config/describe-symbol-at-point.html"}
### `describe-symbol-at-point`
`(describe-symbol-at-point)`

Open the documentation for the Lisp symbol under the cursor. Routes
through `open-doc`, so the static manifest is tried first and the live
docstring is rendered as a fallback. Prints `no symbol at point` when the
cursor is not on a symbol. Bound to `C-h .`. Defined in `docs.lisp`.
:::

:::function{name="apropos-doc" path="reference/help-and-config/apropos-doc.html"}
### `apropos-doc`
`(apropos-doc)`

Fuzzy-search the documentation manifest in the minibuffer and open the
matching doc page in the doc-view. Bound to `C-h a`. Defined in
`docs.lisp`.
:::

:::function{name="open-doc" path="reference/help-and-config/open-doc.html"}
### `open-doc`
`(open-doc name)`

Open the documentation page for the function called `name`. The pre-built
reference is consulted first; for user-defined procedures not in the
manifest, the docstring is rendered as Markdown and shown in a doc
buffer. Falls back to a REPL message when `name` names nothing
documented. Prompts for the name in the minibuffer when called
interactively. Defined in `docs.lisp`.
:::

(See also `describe-key` (`C-h k`) and `describe-command` (`C-h f`) in
`commands.md`.)

## Session and the REPL

Defined in `system.lisp`. The REPL panel is the editor's evaluation and
message surface; crash recovery brings back unsaved work after a crash.

:::function{name="toggle-repl" path="reference/help-and-config/toggle-repl.html"}
### `toggle-repl`
`(toggle-repl)`

Show or hide the REPL panel. Bound to `C-x p`.
:::

:::function{name="recover-session" path="reference/help-and-config/recover-session.html"}
### `recover-session`
`(recover-session)`

Open the `*Recover*` view: scan for crash-recovery snapshots left by a
previous run and offer to recover or discard each. Runs automatically at
startup when snapshots are present; this is the manual entry point. See
the `*autosave-recovery*` setting below.
:::

## Settings

These are `defcustom` variables, not procedures — user-facing settings
you can change live (`(custom-apply! 'name value)`), persist
(`(custom-apply-and-save! 'name value)`), or edit through `M-x
customize`. Each entry's signature line shows the default value.

:::function{name="*autosave-recovery*" path="reference/help-and-config/autosave-recovery.html"}
### `*autosave-recovery*`
`(default #t)`

Whether to write crash-recovery snapshots of unsaved buffers (debounced
after edits, and on window blur). Turn it off to disable autosave
entirely — note that a crash will then lose unsaved work. Existing
snapshots are cleared on a clean quit regardless. Read live by the host
on each autosave, so toggling takes effect without a restart. Group:
`editing`. Defined in `system.lisp`.
:::

:::function{name="*autosave-recovery-interval*" path="reference/help-and-config/autosave-recovery-interval.html"}
### `*autosave-recovery-interval*`
`(default 1000)`

Milliseconds to wait after an edit before writing a crash-recovery
snapshot — the autosave debounce. Lower values snapshot more eagerly;
higher values write less often. Read live by the host, so retuning takes
effect without a restart. Group: `editing`. Defined in `system.lisp`.
:::

:::function{name="*find-file-case-sensitive*" path="reference/help-and-config/find-file-case-sensitive.html"}
### `*find-file-case-sensitive*`
`(default #f)`

When `#t`, `find-file`'s TAB completion matches filenames with case taken
into account; when `#f` (the default), the prefix matches regardless of
case. Completion always uses the filename's on-disk case — typing `rea`
and TABbing into a directory with `README.md` produces `README.md`.
Group: `jmacs`. Defined in `files.lisp`.
:::

:::function{name="*theme*" path="reference/help-and-config/theme.html"}
### `*theme*`
`(default 'dark)`

The colour theme. Applied on Apply or Save in the customisation buffer,
and re-applied on startup. One of four shipped themes: `dark` (Mariana),
`bright` (dark chrome with a punchier syntax palette), `light` (Solarized
Light) and `midnight` (a near-black dark). A `:choice` setting; its
`:on-change` hook re-applies the theme live. Group: `appearance`.
Defined in `themes.lisp`.
:::

:::function{name="*markdown-interpreter*" path="reference/help-and-config/markdown-interpreter.html"}
### `*markdown-interpreter*`
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
