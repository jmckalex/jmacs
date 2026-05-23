Title: jmacs Buffer & Host Primitives
Author: J. McKenzie Alexander
Date: 2026-05-22
---

# jmacs Buffer & Host Primitives

This document describes the *host primitives* — procedures implemented
in JavaScript and registered with the Lisp interpreter, so that they
are *called* from Lisp like any other procedure. They are the floor the
standard-library commands (`commands.jmd`) are built on.

There are two groups, by where they are registered:

- *Buffer primitives* — `packages/stdlib/src/buffer-primitives.js`. The
  bridge from Lisp to an L2 buffer: reading, movement, editing,
  selection, history, modes. These are portable — they depend only on
  an L2 buffer, not on the desktop application.
- *Host application primitives* — `apps/desktop/src/app.js`. The desktop
  app's own additions: file dialogs, the minibuffer prompts, the buffer
  list, quitting. These exist only in the running Electron app.

Conventions (see `index.jmd`): a name ending in `!` mutates; a name
ending in `?` is a predicate. Offsets are zero-indexed character
positions; ranges are half-open `[start, end)`.

A note on the *session*. The buffer primitives operate on a session's
*current* buffer, not a fixed one — so they keep working as the editor
switches buffers. "The buffer" below always means the current buffer.

---

# Buffer primitives

Registered by `createBufferPrimitives` in
`packages/stdlib/src/buffer-primitives.js`.

## Reading the buffer

### `buffer-text`
`(buffer-text)`

The buffer's full contents, as a string.

### `buffer-length`
`(buffer-length)`

The buffer's length in characters.

### `buffer-line-count`
`(buffer-line-count)`

The number of lines in the buffer (always at least 1).

### `buffer-name`
`(buffer-name)`

The buffer's name — a string, used by the modeline and by
`mode-for-name` to choose a major mode.

### `point`
`(point)`

The cursor offset.

### `mark`
`(mark)`

The mark (selection anchor) offset, or `nil` when the mark is not set.

### `buffer-substring`
`(buffer-substring a b)`

The text in the half-open range `[a, b)`. Both arguments must be
integer offsets.

### `line-start`
`(line-start)`

The offset of the start of the cursor's line.

### `line-end`
`(line-end)`

The offset of the end of the cursor's line — the position of the
newline (or the buffer end), excluding it.

### `line-indent`
`(line-indent)`

The leading whitespace of the cursor's line, as a string. `newline`
uses this to copy indentation; `back-to-indentation` uses its length.

### `region-active?`
`(region-active?)`

True when a selection exists — when the mark is set and not equal to
the point.

### `region-text`
`(region-text)`

The selected text, or an empty string when no region is active.

## Word and sentence boundaries

These compute an offset but do not move the cursor; the commands that
use them pair them with `goto!`.

### `word-forward-offset`
`(word-forward-offset)`

The offset of the next word boundary at or after the cursor. A *word*
is a run of word characters (`\w`).

### `word-backward-offset`
`(word-backward-offset)`

The offset of the previous word boundary at or before the cursor.

### `sentence-forward-offset`
`(sentence-forward-offset)`

The offset just past the end of the sentence at or after the cursor. A
sentence ends at `.`, `!` or `?` followed by whitespace or the buffer's
end.

### `sentence-backward-offset`
`(sentence-backward-offset)`

The offset of the start of the sentence before the cursor.

## Cursor movement

Each movement primitive takes an optional argument: pass `#t` to extend
the selection as the cursor moves. Movement also extends the selection
whenever the mark is already set — so once a region is active, the
cursor keeps growing it until the mark is cleared. Each returns `nil`.

### `cursor-left!` / `cursor-right!`
`(cursor-left! [extend])` / `(cursor-right! [extend])`

Move the cursor one character left or right.

### `cursor-up!` / `cursor-down!`
`(cursor-up! [extend])` / `(cursor-down! [extend])`

Move the cursor one line up or down.

### `cursor-line-start!` / `cursor-line-end!`
`(cursor-line-start! [extend])` / `(cursor-line-end! [extend])`

Move the cursor to the start or end of the current line.

### `cursor-buffer-start!` / `cursor-buffer-end!`
`(cursor-buffer-start! [extend])` / `(cursor-buffer-end! [extend])`

Move the cursor to the start or end of the buffer.

### `goto!`
`(goto! n)`

Move the cursor to offset `n` (clamped to the buffer). Like the cursor
commands, a jump extends an active region when the mark is set.

## Selection

### `set-mark!`
`(set-mark! [offset])`

Set the mark at `offset`, or at the cursor when called with no
argument. Setting the mark starts a region.

### `clear-mark!`
`(clear-mark!)`

Clear the mark, ending any region.

## Editing

### `insert!`
`(insert! s)`

Insert the string `s` at the cursor, replacing any active selection.

### `delete-backward!`
`(delete-backward!)`

Delete the character before the cursor, or the active selection.

### `delete-forward!`
`(delete-forward!)`

Delete the character after the cursor, or the active selection.

### `delete-region!`
`(delete-region! a b)`

Delete the text in the range between offsets `a` and `b`. The arguments
may be in either order.

### `fill-paragraph!`
`(fill-paragraph!)`

Re-wrap the paragraph around the cursor to a 72-column fill, keeping its
indentation. Does nothing on a blank line. The primitive behind the
`fill-paragraph` command.

## History

### `undo!`
`(undo!)`

Undo the last change.

### `redo!`
`(redo!)`

Redo the last undone change.

## Modes

L2 stores a buffer's modes opaquely — it never interprets them; the
standard library (`modes.lisp`) gives them meaning. See
`docs/spec/modes.md`.

### `buffer-major-mode`
`(buffer-major-mode)`

The current buffer's major mode, or `nil`.

### `set-major-mode!`
`(set-major-mode! mode)`

Set the current buffer's major mode to `mode`.

### `buffer-minor-modes`
`(buffer-minor-modes)`

The current buffer's minor modes — the value last stored, or `nil`.

### `set-minor-modes!`
`(set-minor-modes! modes)`

Set the current buffer's minor modes to `modes` (a list).

---

# Host application primitives

Registered in `apps/desktop/src/app.js`. These reach the desktop app's
own machinery — file dialogs, the minibuffer, the buffer list. Each
returns `nil`; the interactive ones (`start-…!`) hand control to a
minibuffer loop and return at once. They are the primitives the
file, search, buffer and system commands wrap.

## Files

### `open-file!`
`(open-file!)`

Open a file interactively, replacing the current buffer. Wrapped by
`find-file`.

### `save-buffer!`
`(save-buffer!)`

Save the current buffer to its file interactively. Wrapped by
`save-buffer`.

## The minibuffer commands

Each of these starts an interactive loop in the minibuffer and returns
immediately.

### `start-search!` / `start-search-backward!`
`(start-search!)` / `(start-search-backward!)`

Begin an incremental search, forward or backward. Wrapped by
`isearch-forward` / `isearch-backward`.

### `start-command-palette!`
`(start-command-palette!)`

Open the command palette — prompt for a command by name. Wrapped by
`execute-command` (`M-x`).

### `start-buffer-switcher!`
`(start-buffer-switcher!)`

Prompt for a buffer by name, with completion. Wrapped by
`switch-buffer`.

### `start-describe-command!`
`(start-describe-command!)`

Prompt for a command name and show its documentation. Wrapped by
`describe-command`.

### `start-goto-line!`
`(start-goto-line!)`

Prompt for a line number and move there. Wrapped by `goto-line`.

### `start-replace!`
`(start-replace!)`

Prompt for a target and a replacement and replace every occurrence.
Wrapped by `replace-string`.

## The viewport

### `recenter!`
`(recenter!)`

Scroll so the cursor's line is centred in the viewport. Wrapped by
`recenter`.

### `page-lines`
`(page-lines)`

The number of lines in one screenful — used by `scroll-up` and
`scroll-down` to decide how far to move.

## The buffer list

### `next-buffer!` / `previous-buffer!`
`(next-buffer!)` / `(previous-buffer!)`

Switch to the next or previous buffer in the list, wrapping around.
Wrapped by `next-buffer` / `previous-buffer`.

### `new-buffer!`
`(new-buffer! [name])`

Create a fresh empty buffer and switch to it. With no argument the
buffer is named `untitled-N`. Wrapped by `new-buffer`.

### `buffer-count`
`(buffer-count)`

The number of open buffers.

## The application

### `reload-stdlib!`
`(reload-stdlib!)`

Re-fetch and re-evaluate the standard library. Wrapped by
`reload-stdlib` (`C-x C-r`).

### `quit-editor!`
`(quit-editor!)`

Quit the editor. If buffers have unsaved changes, asks for confirmation
first. Wrapped by `quit-editor` (`C-x C-c`).

## Sticky notes

Registered in `apps/desktop/src/app.js`, delegating to the sticky-notes
module (`apps/desktop/src/sticky-notes.js`). A note is identified by an
opaque id string. `sticky-notes.lisp` wraps these as the `M-n` commands
(see `commands.jmd`); they are equally callable directly. Unlike the
primitives above, several of these return a value rather than `nil`.

### `note-create!`
`(note-create! [offset])`

Create a note anchored at `offset` (default: the cursor). Returns the
new note's id.

### `note-delete!`
`(note-delete! id)`

Delete the note with `id`.

### `note-edit!`
`(note-edit! id)`

Open the note's in-place editor — a textarea of its JMarkdown source.

### `note-set-source!`
`(note-set-source! id source)`

Set the note's JMarkdown source and re-render it.

### `note-source`
`(note-source id)`

The note's JMarkdown source, or `nil` when there is no such note.

### `note-move!`
`(note-move! id line x)`

Re-anchor the note to `line` and set its left edge to `x` pixels.

### `note-resize!`
`(note-resize! id width height)`

Resize the note to `width` × `height` pixels.

### `note-ids`
`(note-ids)`

The ids of the current buffer's notes, as a list.

### `note-count`
`(note-count)`

How many notes the current buffer has.

### `note-at-point`
`(note-at-point)`

The id of the note whose anchor is nearest the cursor, or `nil` when
the buffer has no notes.

### `note-goto!`
`(note-goto! id)`

Move the cursor to the note's anchor and scroll the note into view.

### `note-next!` / `note-prev!`
`(note-next!)` / `(note-prev!)`

Move the cursor to the next / previous note in the buffer, by anchor
order.

### `notes-toggle!`
`(notes-toggle!)`

Show or hide every note in the current buffer.
