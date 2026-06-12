Title: jmacs Productivity Commands
Author: J. McKenzie Alexander
Date: 2026-06-11
---

## Productivity commands

This document describes jmacs's productivity features — the editing
amplifiers that go beyond ordinary text manipulation: multiple cursors,
snippet expansion, sticky notes, and inline evaluation. Each is ordinary
Lisp in the standard library
(`packages/stdlib/lisp/multi-cursor.lisp`, `snippets.lisp`,
`sticky-notes.lisp`, `inline-eval.lisp`), built on the buffer and host
primitives.

Entries follow the convention of `commands.md`: a *command* is a
procedure runnable by name with `M-x` and usually bound to a key. See
`index.jmd` for how to read an entry. Key bindings are given in the
manual's notation: `C-` is Control or Command, `M-` is Option, `S-` is
Shift.

---

### Multiple cursors

Defined in `multi-cursor.lisp`. Sublime/VSCode-style multiple cursors,
built on the buffer-layer primitives `add-selection!`,
`collapse-to-primary!`, `cursor-count` and `selections`. Each new cursor
is created with both ends set, so its match is selected. `keyboard-quit`
(`C-g`) is extended to collapse the cursor set back to the primary.

:::function{name="add-cursor-next" path="reference/productivity/add-cursor-next.html"}
#### `add-cursor-next`
`(add-cursor-next)`

Add a cursor at the next match of the word at point (or the active
region's text). Bound to `C-c d`. On the first press with no region, the
current word becomes selected as the primary cursor; the next press adds
a cursor at the next match, and repeated presses keep adding cursors.
Each press searches from just past the last-added cursor's range, so a
sequence of presses walks the matches in order.
:::

:::function{name="select-all-matches" path="reference/productivity/select-all-matches.html"}
#### `select-all-matches`
`(select-all-matches)`

Add a cursor at every occurrence of the current selection (or the word
at point), each one selecting the match. Bound to `C-c D`. With no
region active, the first instance becomes the primary cursor's region,
then a cursor is added for every other match in document order.
:::

### Snippets

Defined in `snippets.lisp` (the engine) and `snippets-parser.lisp` (the
file-format reader); the key bindings live in `snippets-keymap.lisp`.
A snippet is a yasnippet-style template with tab stops (`$N`,
`${N:default}`, `$0`) and mirrors. Snippets are discovered per major
mode from a built-in starter set plus the user's
`<user-data>/snippets/<mode>/` directories, with `.yas-parents` parent
fallthrough. While a snippet is active, `TAB` walks the fields and `ESC`
or `C-g` cancels.

:::function{name="snippet-tab" path="reference/productivity/snippet-tab.html"}
#### `snippet-tab`
`(snippet-tab)`

The snippet-aware `TAB` key. Bound to `Tab`. When a snippet is active,
advance to its next field; otherwise, if the word before point is a
known trigger and `*snippet-expand-key*` is `"tab"`, expand it; otherwise
fall through to cmd(insert-tab). Defined in `snippets-keymap.lisp`.
:::

:::function{name="snippet-shift-tab" path="reference/productivity/snippet-shift-tab.html"}
#### `snippet-shift-tab`
`(snippet-shift-tab)`

Step to the previous snippet field when a snippet is active. Bound to
`S-Tab`. A no-op otherwise. Defined in `snippets-keymap.lisp`; delegates
to cmd(snippet-prev-field).
:::

:::function{name="snippet-expand" path="reference/productivity/snippet-expand.html"}
#### `snippet-expand`
`(snippet-expand)`

Expand the snippet whose trigger is the word before point, as a live
template. Reachable through cmd(snippet-tab) (the `TAB` key) and via
`M-x`. Removes the trigger word and inserts the snippet's parsed body,
moving to the first field. Returns `#t` when a snippet was expanded, `#f`
otherwise.
:::

:::function{name="snippet-insert" path="reference/productivity/snippet-insert.html"}
#### `snippet-insert`
`(snippet-insert key)`

Pick a snippet by name from the current mode's set and insert it at
point, expanding it as a live template. `key` is read from the
minibuffer, with completion against cmd(snippet-keys-for-mode). Run by
name with `M-x` (no default key binding).
:::

:::function{name="snippet-list" path="reference/productivity/snippet-list.html"}
#### `snippet-list`
`(snippet-list)`

Show the snippet triggers available in the current buffer's mode, in the
status line. Run by name with `M-x` (no default key binding).
:::

:::function{name="snippet-reload" path="reference/productivity/snippet-reload.html"}
#### `snippet-reload`
`(snippet-reload)`

Rescan the snippet directories, discarding the cached store. Run by name
with `M-x` (no default key binding). Use after adding or editing snippet
files.
:::

:::function{name="snippet-next-field" path="reference/productivity/snippet-next-field.html"}
#### `snippet-next-field`
`(snippet-next-field)`

Advance to the next snippet field, selecting its text. On the last
field, jump to the exit (`$0`) and commit the snippet. Reached through
cmd(snippet-tab) (`TAB`) while a snippet is active; also runnable with
`M-x`.
:::

:::function{name="snippet-prev-field" path="reference/productivity/snippet-prev-field.html"}
#### `snippet-prev-field`
`(snippet-prev-field)`

Move to the previous snippet field. Reached through cmd(snippet-shift-tab)
(`S-Tab`) while a snippet is active; also runnable with `M-x`. Stops at
the first field; does not wrap or commit.
:::

:::function{name="snippet-cancel" path="reference/productivity/snippet-cancel.html"}
#### `snippet-cancel`
`(snippet-cancel)`

Cancel the active snippet. Reached through the snippet-aware wrappers on
`ESC` (cmd(deselect)) and `C-g` (cmd(keyboard-quit)) — a single press
while a snippet is active cancels it first. The inserted text stays;
field navigation stops and point is left at the exit. The whole
expansion is one undo step, so a single undo removes the inserted body.
:::

### Sticky notes

Defined in `sticky-notes.lisp`. A *sticky note* is a resizable rectangle
overlaid on the buffer, holding JMarkdown source whose rendered HTML is
shown in the note. Notes are anchored into the document and scroll with
it; they persist to a companion `<file>.jmacs-metadata` file. The notes
themselves are managed by host primitives (`note-create!`,
`note-edit!`, `note-delete!`, `note-at-point`, `note-next!`,
`note-prev!`, `notes-toggle!`); these commands are the keyboard surface,
bound under the `M-n` prefix.

:::function{name="add-sticky-note" path="reference/productivity/add-sticky-note.html"}
#### `add-sticky-note`
`(add-sticky-note)`

Create a sticky note at the cursor and open it for editing. Bound to
`M-n n`.
:::

:::function{name="edit-sticky-note" path="reference/productivity/edit-sticky-note.html"}
#### `edit-sticky-note`
`(edit-sticky-note)`

Edit the sticky note nearest the cursor. Bound to `M-n e`. Reports to the
REPL when there is no note near the cursor.
:::

:::function{name="delete-sticky-note" path="reference/productivity/delete-sticky-note.html"}
#### `delete-sticky-note`
`(delete-sticky-note)`

Delete the sticky note nearest the cursor. Bound to `M-n d`. Reports to
the REPL when there is no note near the cursor.
:::

:::function{name="next-sticky-note" aliases="previous-sticky-note" path="reference/productivity/next-sticky-note.html"}
#### `next-sticky-note` / `previous-sticky-note`
`(next-sticky-note)` / `(previous-sticky-note)`

Move the cursor to the next / previous sticky note in the buffer. Bound
to `M-n f` / `M-n b`.
:::

:::function{name="toggle-sticky-notes" path="reference/productivity/toggle-sticky-notes.html"}
#### `toggle-sticky-notes`
`(toggle-sticky-notes)`

Show or hide every sticky note in the buffer. Bound to `M-n t`.
:::

### Inline evaluation

Defined in `inline-eval.lisp`. CIDER-style inline evaluation: a command
evaluates a single Lisp form in the current buffer and shows the result
as a coloured pill next to the form — green for a value, red for an
error (errors also surface in the REPL with the full stack trace). The
host primitives `form-bounds-at-point!`, `form-bounds-before-point!` and
`eval-region!` do the heavy lifting.

:::function{name="eval-expression-before-point" path="reference/productivity/eval-expression-before-point.html"}
#### `eval-expression-before-point`
`(eval-expression-before-point)`

Evaluate the Lisp form immediately before point — the form whose closing
bracket sits just before the cursor — and show the result beside it.
Bound to `C-x C-e`. Reports `eval: no form before point` when there is no
form before the cursor.
:::

:::function{name="eval-expression-at-point" path="reference/productivity/eval-expression-at-point.html"}
#### `eval-expression-at-point`
`(eval-expression-at-point)`

Evaluate the Lisp form enclosing point and show the result beside its
closing bracket. Bound to `C-RET`. Reports `eval: no form at point` when
the cursor is not within a form.
:::

:::function{name="show-eval-log" path="reference/productivity/show-eval-log.html"}
#### `show-eval-log`
`(show-eval-log)`

Open the `*Eval log*` buffer — a record of recent inline evaluations,
one entry per call to `eval-region!`. Run by name with `M-x` (no default
key binding).
:::
