Title: Godot Buffer & Host Primitives
Author: J. McKenzie Alexander
Date: 2026-07-21
---

## Godot Buffer & Host Primitives

This document describes the *host primitives* — procedures implemented
in JavaScript and registered with the Lisp interpreter, so that they
are *called* from Lisp like any other procedure. They are the floor the
standard-library commands (`commands.md`) are built on.

There are two groups, by where they are registered:

- *Buffer primitives* — `packages/stdlib/src/buffer-primitives.js`. The
  bridge from Lisp to an L2 buffer: reading, movement, editing,
  selection, history, modes. These are portable — they depend only on
  an L2 buffer, not on the desktop application.
- *Server primitives* — `apps/desktop/mwb/spine.js`. The desktop app's
  own additions, registered in the Lisp server (the *spine*): the echo
  area, the minibuffer, files, views, search, overlays, processes.

The second group deserves a word of architecture. Godot runs one Lisp
world, in a server process; the editor windows are thin clients. Every
command executes in the server, against the server's buffers. A server
primitive whose effect is something a *window* shows — a scroll, a
dock panel, a sticky note — emits a *directive* to the client, which
performs the visual half. This is the Model B dispatch model; the
playbook is `docs/MODEL-B-DISPATCH.md`.

Conventions (see `index.md`): a name ending in `!` mutates; a name
ending in `?` is a predicate. Offsets are zero-indexed character
positions; ranges are half-open `[start, end)`. Absence is `#f` — this
Lisp's `nil` is truthy, so a primitive that may come back empty-handed
returns `#f`, which a bare `if` tests correctly. (A few entries below
return `nil` on a miss instead, for historical reasons; each says so.)

A note on the *session*. The buffer primitives operate on the current
*view*'s buffer, not a fixed one — so they keep working as the editor
switches views. "The buffer" below always means the current buffer.
Not every view has one: an image, a PDF, a shell are views without
text. Calling a buffer primitive while such a view is current raises
`no-buffer-here` — a clear error at the call site rather than a
mystery three frames later. The two mode *readers* are the deliberate
exception; see the Modes section.

---

## Buffer primitives

Registered by `createBufferPrimitives` in
`packages/stdlib/src/buffer-primitives.js`.

### Reading the buffer

:::function{name="buffer-text" path="reference/buffer-primitives/buffer-text.html"}
#### `buffer-text`
`(buffer-text)`

The buffer's full contents, as a string.
:::

:::function{name="buffer-length" path="reference/buffer-primitives/buffer-length.html"}
#### `buffer-length`
`(buffer-length)`

The buffer's length in characters.
:::

:::function{name="buffer-line-count" path="reference/buffer-primitives/buffer-line-count.html"}
#### `buffer-line-count`
`(buffer-line-count)`

The number of lines in the buffer (always at least 1).
:::

:::function{name="view-name" path="reference/buffer-primitives/view-name.html"}
#### `view-name`
`(view-name)`

The current view's name — the modeline label, a string. Text views
delegate to their buffer's name (also what `mode-for-name` consults
to choose a major mode); non-text views supply their own. Formerly
`buffer-name`. See `set-view-name!` to change it.
:::

:::function{name="point" path="reference/buffer-primitives/point.html"}
#### `point`
`(point)`

The cursor offset.
:::

:::function{name="mark" path="reference/buffer-primitives/mark.html"}
#### `mark`
`(mark)`

The mark (selection anchor) offset, or `#f` when the mark is not set.
The miss is `#f` rather than `nil` because `nil` is truthy and offset
`0` is truthy too, which makes the bare test safe:

```lisp
(let ((m (mark)))
  (when m            ; no mark is #f; offset 0 is truthy
    (goto! m)))
```

This is exactly how cmd(exchange-point-and-mark) is written
(`editing.lisp`).
:::

:::function{name="buffer-substring" path="reference/buffer-primitives/buffer-substring.html"}
#### `buffer-substring`
`(buffer-substring a b)`

The text in the half-open range `[a, b)`. Both arguments must be
integer offsets.
:::

:::function{name="line-start" path="reference/buffer-primitives/line-start.html"}
#### `line-start`
`(line-start)`

The offset of the start of the cursor's line.
:::

:::function{name="line-end" path="reference/buffer-primitives/line-end.html"}
#### `line-end`
`(line-end)`

The offset of the end of the cursor's line — the position of the
newline (or the buffer end), excluding it.
:::

:::function{name="line-indent" path="reference/buffer-primitives/line-indent.html"}
#### `line-indent`
`(line-indent)`

The leading whitespace of the cursor's line, as a string. `newline`
uses this to copy indentation; `back-to-indentation` uses its length.
:::

:::function{name="region-active?" path="reference/buffer-primitives/region-active%3F.html"}
#### `region-active?`
`(region-active?)`

True when a selection exists — when the mark is set and not equal to
the point.
:::

:::function{name="region-text" path="reference/buffer-primitives/region-text.html"}
#### `region-text`
`(region-text)`

The selected text, or an empty string when no region is active.
:::

### Word and sentence boundaries

These compute an offset but do not move the cursor; the commands that
use them pair them with `goto!`.

:::function{name="word-forward-offset" path="reference/buffer-primitives/word-forward-offset.html"}
#### `word-forward-offset`
`(word-forward-offset)`

The offset of the next word boundary at or after the cursor. A *word*
is a run of word characters, and word characters are Unicode-aware:
any letter or digit in any script, plus underscore
(`[\p{L}\p{N}_]`) — so word motion does not stop dead at the accented
letter in "café".
:::

:::function{name="word-backward-offset" path="reference/buffer-primitives/word-backward-offset.html"}
#### `word-backward-offset`
`(word-backward-offset)`

The offset of the previous word boundary at or before the cursor.
:::

:::function{name="sentence-forward-offset" path="reference/buffer-primitives/sentence-forward-offset.html"}
#### `sentence-forward-offset`
`(sentence-forward-offset)`

The offset just past the end of the sentence at or after the cursor. A
sentence ends at `.`, `!` or `?` followed by whitespace or the buffer's
end.
:::

:::function{name="sentence-backward-offset" path="reference/buffer-primitives/sentence-backward-offset.html"}
#### `sentence-backward-offset`
`(sentence-backward-offset)`

The offset of the start of the sentence before the cursor.
:::

### Cursor movement

Each movement primitive takes an optional argument: pass `#t` — the
exact value, nothing else counts — to extend the selection as the
cursor moves, so `#f` and omission are equivalent. Movement also
extends the selection whenever the mark is already set: once a region
is active, the cursor keeps growing it until the mark is cleared. Each
returns `nil`.

:::function{name="cursor-left!" aliases="cursor-right!" path="reference/buffer-primitives/cursor-left!.html"}
#### `cursor-left!` / `cursor-right!`
`(cursor-left! [extend])` / `(cursor-right! [extend])`

Move the cursor one character left or right.
:::

:::function{name="cursor-up!" aliases="cursor-down!" path="reference/buffer-primitives/cursor-up!.html"}
#### `cursor-up!` / `cursor-down!`
`(cursor-up! [extend])` / `(cursor-down! [extend])`

Move the cursor one line up or down. Across an unbroken run of
vertical moves the cursor remembers its *goal column* — the column it
started from — so stepping through a short line and back into a long
one recovers the original column (Emacs's temporary-goal-column rule).
Any other operation forgets the goal.
:::

:::function{name="cursor-line-start!" aliases="cursor-line-end!" path="reference/buffer-primitives/cursor-line-start!.html"}
#### `cursor-line-start!` / `cursor-line-end!`
`(cursor-line-start! [extend])` / `(cursor-line-end! [extend])`

Move the cursor to the start or end of the current line.
:::

:::function{name="cursor-buffer-start!" aliases="cursor-buffer-end!" path="reference/buffer-primitives/cursor-buffer-start!.html"}
#### `cursor-buffer-start!` / `cursor-buffer-end!`
`(cursor-buffer-start! [extend])` / `(cursor-buffer-end! [extend])`

Move the cursor to the start or end of the buffer.
:::

:::function{name="goto!" path="reference/buffer-primitives/goto!.html"}
#### `goto!`
`(goto! n)`

Move the cursor to offset `n` (clamped to the buffer). Like the cursor
commands, a jump extends an active region when the mark is set.
:::

### Selection

:::function{name="set-mark!" path="reference/buffer-primitives/set-mark!.html"}
#### `set-mark!`
`(set-mark! [offset])`

Set the mark at `offset`, or at the cursor when called with no
argument. Setting the mark starts a region.
:::

:::function{name="clear-mark!" path="reference/buffer-primitives/clear-mark!.html"}
#### `clear-mark!`
`(clear-mark!)`

Clear the mark, ending any region.
:::

### Multiple cursors

A buffer holds one *primary* cursor and any number of additional ones;
each cursor carries its own point and mark. The editing primitives
below (`insert!`, `delete-backward!`, `delete-forward!`) act at every
cursor. The interactive layer over these — `C-c d` and friends — is
documented with the productivity commands (`productivity.md`); the
snippet engine also uses them to implement mirrored fields.

:::function{name="add-selection!" path="reference/buffer-primitives/add-selection!.html"}
#### `add-selection!`
`(add-selection! point [mark])`

Add a cursor at `point`. With `mark` (an offset), the new cursor
carries a selection from `mark` to `point`; with `mark` omitted or
`nil`, it is a bare cursor.
:::

:::function{name="collapse-to-primary!" path="reference/buffer-primitives/collapse-to-primary!.html"}
#### `collapse-to-primary!`
`(collapse-to-primary!)`

Drop every cursor except the primary one.
:::

:::function{name="cursor-count" path="reference/buffer-primitives/cursor-count.html"}
#### `cursor-count`
`(cursor-count)`

How many cursors the buffer currently has (at least 1).
:::

:::function{name="selections" path="reference/buffer-primitives/selections.html"}
#### `selections`
`(selections)`

Every cursor as a list of `(point . mark)` pairs, in cursor order; a
cursor with no selection has `nil` for its mark. Walkable with
`car`/`cdr`.
:::

### Editing

The three basic editing primitives are multi-cursor aware: with
several cursors, each acts at *every* cursor, replacing that cursor's
selection if it has one. Afterwards marks are cleared and any cursors
left overlapping merge.

:::function{name="insert!" path="reference/buffer-primitives/insert!.html"}
#### `insert!`
`(insert! s)`

Insert the string `s` at the cursor, replacing any active selection.
With multiple cursors, `s` is inserted at every cursor and each cursor
ends up just after the text it inserted.
:::

:::function{name="delete-backward!" path="reference/buffer-primitives/delete-backward!.html"}
#### `delete-backward!`
`(delete-backward!)`

Delete the character before the cursor, or the active selection.
Deletion steps by whole characters, so a surrogate pair — an emoji —
is deleted as a unit, never split into a lone half.
:::

:::function{name="delete-forward!" path="reference/buffer-primitives/delete-forward!.html"}
#### `delete-forward!`
`(delete-forward!)`

Delete the character after the cursor, or the active selection. Whole
characters, as with `delete-backward!`.
:::

:::function{name="delete-region!" path="reference/buffer-primitives/delete-region!.html"}
#### `delete-region!`
`(delete-region! a b)`

Delete the text in the range between offsets `a` and `b`. The arguments
may be in either order.
:::

:::function{name="set-buffer-text!" path="reference/buffer-primitives/set-buffer-text!.html"}
#### `set-buffer-text!`
`(set-buffer-text! s)`

Replace the buffer's entire contents with the string `s` — one edit,
one undo step.
:::

:::function{name="set-view-name!" path="reference/buffer-primitives/set-view-name!.html"}
#### `set-view-name!`
`(set-view-name! name)`

Rename the current view. For a text view the rename is mirrored to the
underlying buffer's name (text views derive their display name from
the buffer); a non-text view's own name is updated. Formerly
`set-buffer-name!`.
:::

:::function{name="fill-paragraph!" path="reference/buffer-primitives/fill-paragraph!.html"}
#### `fill-paragraph!`
`(fill-paragraph!)`

Re-wrap the paragraph around the cursor — the run of non-blank lines —
keeping its indentation. Does nothing on a blank line. The whole
re-wrap is grouped into a single undo step. The primitive behind the
generic cmd(fill-paragraph) command (`M-q`).

The fill column here is a hardcoded 72: this primitive does *not* read
the `*fill-column*` customize variable, which governs
cmd(auto-fill-mode)'s wrap-as-you-type (and is set interactively with
cmd(set-fill-column), `C-x f`). Note also that LaTeX and JMarkdown
buffers shadow `M-q` with their own mode-aware fills, which do not go
through this primitive either.
:::

### Markers

An L2 marker surfaced as an opaque Lisp handle: an edit-tracking
position in a specific buffer. Text inserted or deleted before a
marker shifts it — undo and redo included — and a deletion spanning it
collapses it to the edit point. The handle remembers its buffer:
`marker-position` reads correctly from anywhere, but `set-marker!`
works only while the marker's buffer is current. A live marker costs
the buffer incremental work per edit, so each must be released; Lisp
code normally reaches these through the `editing.lisp` macros
`with-marker` and `save-excursion` (`commands.md`), which release on
every exit. Apart from `release-marker!` itself, every operation on a
released marker raises.

The macros are almost always what you want. To edit elsewhere and
return, `save-excursion` restores point via a marker, so the body's
own edits cannot leave it pointing at the wrong place:

```lisp
;; Append a line without disturbing the cursor:
(save-excursion
  (cursor-buffer-end!)
  (insert! "\n;; the end"))

;; Hold a specific position across edits:
(with-marker (m (line-start))
  (insert! ">> ")                ; shifts everything after point
  (marker-position m))           ; still the line's start; m released on exit
```

:::function{name="make-marker" path="reference/buffer-primitives/make-marker.html"}
#### `make-marker`
`(make-marker [offset])`

Create a marker in the current buffer at `offset` (default: the
cursor) and return its handle, which prints as
`#<marker 5 in notes.md>`.
:::

:::function{name="marker-position" path="reference/buffer-primitives/marker-position.html"}
#### `marker-position`
`(marker-position m)`

The marker's current offset — correct under intervening edits, and
readable even when the marker's buffer is not current.
:::

:::function{name="set-marker!" path="reference/buffer-primitives/set-marker!.html"}
#### `set-marker!`
`(set-marker! m offset)`

Move the marker to `offset`, from which it resumes tracking. Raises
unless the marker's buffer is current.
:::

:::function{name="marker-buffer-current?" path="reference/buffer-primitives/marker-buffer-current%3F.html"}
#### `marker-buffer-current?`
`(marker-buffer-current? m)`

Whether the marker's buffer is the current buffer — that is, whether
`set-marker!` would be allowed.
:::

:::function{name="release-marker!" path="reference/buffer-primitives/release-marker!.html"}
#### `release-marker!`
`(release-marker! m)`

Detach the marker, so it stops costing the buffer work. Safe to call
twice; every other operation on a released marker raises.
:::

### History

:::function{name="undo!" path="reference/buffer-primitives/undo!.html"}
#### `undo!`
`(undo!)`

Undo the last change.
:::

:::function{name="redo!" path="reference/buffer-primitives/redo!.html"}
#### `redo!`
`(redo!)`

Redo the last undone change.
:::

:::function{name="begin-change-group!" aliases="end-change-group!" path="reference/buffer-primitives/begin-change-group!.html"}
#### `begin-change-group!` / `end-change-group!`
`(begin-change-group!)` / `(end-change-group!)`

Atomic undo grouping: every edit between the pair lands on the undo
stack as *one* step. Lisp code should reach these through the
`atomic-change-group` macro (`editing.lisp`, documented in
`commands.md`), which closes the group even when the body raises —
an unbalanced `begin-change-group!` swallows undo history until
something closes it. `fill-paragraph!` uses the same seam internally.
:::

### Modes

L2 stores a buffer's modes opaquely — it never interprets them; the
standard library (`modes.lisp`) gives them meaning. See
`docs/spec/modes.md`.

The two *readers* below are the exception to the `no-buffer-here` rule:
the keymap chain calls them on every keystroke, including in non-text
views, so they tolerate a buffer-less view and return `nil` rather
than raising. The two *mutators* still raise — they only make sense in
a buffer.

:::function{name="buffer-major-mode" path="reference/buffer-primitives/buffer-major-mode.html"}
#### `buffer-major-mode`
`(buffer-major-mode)`

The current buffer's major mode, or `nil`.
:::

:::function{name="set-major-mode!" path="reference/buffer-primitives/set-major-mode!.html"}
#### `set-major-mode!`
`(set-major-mode! mode)`

Set the current buffer's major mode to `mode`.
:::

:::function{name="buffer-minor-modes" path="reference/buffer-primitives/buffer-minor-modes.html"}
#### `buffer-minor-modes`
`(buffer-minor-modes)`

The current buffer's minor modes — the value last stored, or `nil`.
:::

:::function{name="set-minor-modes!" path="reference/buffer-primitives/set-minor-modes!.html"}
#### `set-minor-modes!`
`(set-minor-modes! modes)`

Set the current buffer's minor modes to `modes` (a list).
:::

---

## Server primitives

Registered in `apps/desktop/mwb/spine.js` — the Lisp server every
window connects to. These reach the desktop app's own machinery: the
echo area, the minibuffer, the filesystem, the view registry, the
utility dock. Return values vary and are given per entry; where a
visual effect is involved, the primitive emits a directive to the
window that ran the command (see `docs/MODEL-B-DISPATCH.md`).

A historical note, since older docs and dreams may reference it: the
renderer-registered `start-…!` family (`start-search!`,
`start-command-palette!`, `start-buffer-switcher!`, and friends) is
gone, along with the renderer's own Lisp interpreter. Interactive
loops now run in the server — incremental search is pure Lisp in
`search.lisp`, reading keys with `read-next-key`; prompting commands
like cmd(find-file) and cmd(execute-command) use the minibuffer
round-trip below. The commands are documented in `commands.md` and
`search-and-edit.md`.

### The echo area

:::function{name="show-status!" path="reference/buffer-primitives/show-status!.html"}
#### `show-status!`
`(show-status! text)`

Show `text` in the echo area. Returns `nil`. The staple of command
feedback — grep the stdlib and you will find it everywhere.
:::

:::function{name="clear-status!" path="reference/buffer-primitives/clear-status!.html"}
#### `clear-status!`
`(clear-status!)`

Clear the echo area.
:::

:::function{name="show-status-rich!" path="reference/buffer-primitives/show-status-rich!.html"}
#### `show-status-rich!`
`(show-status-rich! segments)`

Show a *styled* echo message. `segments` is a list of
`(text color bold)` triples; each becomes a coloured (and optionally
bold) span. A later plain `show-status!` reverts to unstyled text.
Used by cmd(quit-editor)'s per-buffer save prompts.
:::

### The minibuffer and pickers

Two prompt channels share one suspend/resume shape: a command opens a
prompt, suspends, and resumes in a callback when the user submits or
cancels. Lisp code normally reaches them through the wrappers in
`commands.lisp` — `minibuffer-read`, `picker-read`, or simply an
`(interactive (string …))` declaration — rather than calling these
directly (`commands.md`).

:::function{name="open-minibuffer!" path="reference/buffer-primitives/open-minibuffer!.html"}
#### `open-minibuffer!`
`(open-minibuffer! prompt [seed])`

Open a minibuffer prompt. `seed`, when given, pre-fills the input —
cmd(find-file) seeds its starting directory this way. The user's
input resolves via `minibuffer-delivered`; use `minibuffer-read` to
supply the callback.
:::

:::function{name="open-completing-minibuffer!" path="reference/buffer-primitives/open-completing-minibuffer!.html"}
#### `open-completing-minibuffer!`
`(open-completing-minibuffer! prompt [seed])`

The completion-backed prompt: the same round-trip as
`open-minibuffer!`, with a TAB-completion panel rendered client-side.
The LaTeX and JMarkdown smart-insertion commands prompt through this.
:::

:::function{name="open-picker!" path="reference/buffer-primitives/open-picker!.html"}
#### `open-picker!`
`(open-picker! title rows [options])`

Open an interactive list — the generic picker: type to narrow, arrows
to navigate, enter to choose. `rows` is an opaque host row array from
a *row-provider* primitive; Lisp passes it through verbatim, never
inspecting it. The choice resolves via `picker-delivered`; use
`picker-read` to supply the callback. The buffer list (`C-x C-b`),
completions, `*Recover*`, and the RefTeX select and cite pickers are
all this one mechanism with different providers.
:::

:::function{name="buffer-list-rows" path="reference/buffer-primitives/buffer-list-rows.html"}
#### `buffer-list-rows`
`(buffer-list-rows)`

The open buffers as picker rows for the active window — each row's
label is the buffer name and its value the buffer id, with a
line-count and modified flag as metadata. The row-provider behind
cmd(list-views); feed it to `open-picker!`.
:::

### Files

The server is a Node process, so file I/O is direct and synchronous —
no dialog, no IPC détour.

:::function{name="open-file-path!" path="reference/buffer-primitives/open-file-path!.html"}
#### `open-file-path!`
`(open-file-path! path)`

Visit `path`: read the file, *add* it as a buffer, and switch the
active window to it. Adds rather than replaces — Emacs `find-file`
semantics; the previous buffer stays open. The primitive under
cmd(find-file) (`C-x C-f`), whose prompt supplies the path. Returns
`nil`; a read failure is surfaced in the echo area.
:::

:::function{name="open-file-in-split!" path="reference/buffer-primitives/open-file-in-split!.html"}
#### `open-file-in-split!`
`(open-file-in-split! path [orientation [side]])`

Split the focused pane and open `path` — a media file, e.g. a built
PDF — in the new leaf. `orientation` is `'horizontal` (default) or
`'vertical`; `side` is `'after` (default) or `'before`. The LaTeX
compile loop uses this to put source and PDF side by side
(`latex.md`). A non-media path is a no-op.
:::

:::function{name="save-buffer!" path="reference/buffer-primitives/save-buffer!.html"}
#### `save-buffer!`
`(save-buffer!)`

Write the current buffer to its file path — an atomic write (temp file
plus rename) — and clear the modified flag. Returns a status string
the wrapping cmd(save-buffer) command (`C-x C-s`) branches on:
`"ok"`, `"no-path"` (a path-less buffer; the command falls back to
cmd(write-file)), or `"error"`.
:::

:::function{name="write-file!" path="reference/buffer-primitives/write-file!.html"}
#### `write-file!`
`(write-file! path)`

Write the current buffer to `path` and rebind the buffer's file path
to it, so subsequent saves land there. Returns `"ok"` or `"error"`.
Behind cmd(write-file) (`C-x C-w`).
:::

:::function{name="file-exists%3F" path="reference/buffer-primitives/file-exists%3F.html"}
#### `file-exists?`
`(file-exists? path)`

`#t` when `path` names an existing file or directory, else `#f`.
:::

:::function{name="read-file-text!" path="reference/buffer-primitives/read-file-text!.html"}
#### `read-file-text!`
`(read-file-text! path)`

The file's contents as a string, or `nil` on any error. Caution: this
is one of the entries whose miss is `nil`, and `nil` is truthy — test
the result with `string?`, not a bare `if`.
:::

:::function{name="list-directory-paths" path="reference/buffer-primitives/list-directory-paths.html"}
#### `list-directory-paths`
`(list-directory-paths dir)`

The entries of `dir` as a list of `(name . kind)` pairs, `kind` being
`:file` or `:directory`; `nil` when the directory cannot be listed
(same caution as `read-file-text!`).
:::

:::function{name="home-directory" path="reference/buffer-primitives/home-directory.html"}
#### `home-directory`
`(home-directory)`

The user's home directory, no trailing slash — the fallback start for
the cmd(find-file) prompt when the current buffer has no file.
:::

### The viewport

:::function{name="recenter!" path="reference/buffer-primitives/recenter!.html"}
#### `recenter!`
`(recenter!)`

Scroll so the cursor's line is centred in the viewport. The server
decides the target line (it knows point); the client executes the
pixels. Wrapped by cmd(recenter) (`C-l`).
:::

:::function{name="page-lines" path="reference/buffer-primitives/page-lines.html"}
#### `page-lines`
`(page-lines)`

The screenful step: the number of text lines visible in the focused
pane *minus two* context lines, minimum 1 — the overlap keeps the line
at the screen edge on screen so the eye keeps its place. Before the
client's first viewport report the value is 1. cmd(scroll-up) (`C-v`)
and cmd(scroll-down) (`M-v`) move point by this many lines.
:::

### Search and replace

Plain incremental search (`C-s` / `C-r`) is pure Lisp in `search.lisp`,
built on the match primitives below; `query-replace` and
`replace-regexp` walk the buffer the same way (`regex-search.lisp`).
The commands are documented in `search-and-edit.md`. A match is a
`(start . end)` pair; a miss — including an invalid or empty pattern —
is `#f`, so a bare `if` works.

:::function{name="find-string-forward" aliases="find-string-backward" path="reference/buffer-primitives/find-string-forward.html"}
#### `find-string-forward` / `find-string-backward`
`(find-string-forward needle from)` / `(find-string-backward needle from)`

The first literal match of `needle` at or after offset `from` —
backward, the last match whose start is at or before `from` — as
`(start . end)`, or `#f`.
:::

:::function{name="find-regexp-forward" aliases="find-regexp-backward" path="reference/buffer-primitives/find-regexp-forward.html"}
#### `find-regexp-forward` / `find-regexp-backward`
`(find-regexp-forward source from)` / `(find-regexp-backward source from)`

Like the string pair, with `source` a regular-expression string.
`(start . end)`, or `#f`.
:::

:::function{name="point-max" path="reference/buffer-primitives/point-max.html"}
#### `point-max`
`(point-max)`

The largest valid point — the buffer length. Isearch's backward wrap
searches from here.
:::

:::function{name="goto-line!" path="reference/buffer-primitives/goto-line!.html"}
#### `goto-line!`
`(goto-line! n)`

Move point to the start of line `n` (1-based, clamped to the buffer).
Behind cmd(goto-line) (`M-g`), which prompts for the number.
:::

:::function{name="replace-all!" path="reference/buffer-primitives/replace-all!.html"}
#### `replace-all!`
`(replace-all! from to)`

Replace every literal occurrence of `from` with `to`, echoing the
count (or "not found"). Behind cmd(replace-string) (`M-r`).
:::

:::function{name="replace-regexp-all!" path="reference/buffer-primitives/replace-regexp-all!.html"}
#### `replace-regexp-all!`
`(replace-regexp-all! source replacement)`

Replace every match of the regexp `source`. `replacement` honours
`$N`, `$&` and `$$`. Returns the match count, or `-1` for an invalid
pattern.
:::

:::function{name="replace-range!" path="reference/buffer-primitives/replace-range!.html"}
#### `replace-range!`
`(replace-range! start end text)`

Swap the text in `[start, end)` for `text` — one match replaced as one
edit; `query-replace`'s per-match step.
:::

### Overlays

Face-tagged ranges over the buffer, distinct from the text itself.
An overlay's endpoints are L2 markers, so it rides edits; the server
broadcasts the overlay set to every window viewing the buffer, whose
renderer draws it. This is what makes cmd(highlight-matches) (`M-s h`)
and isearch's match highlighting work over the wire.

:::function{name="add-overlay!" path="reference/buffer-primitives/add-overlay!.html"}
#### `add-overlay!`
`(add-overlay! start end face [kind])`

Add an overlay over `[start, end)` drawn with `face` (a face name
string), tagged with `kind` for group removal (default `"overlay"`).
Returns the overlay's id string.
:::

:::function{name="clear-overlays!" path="reference/buffer-primitives/clear-overlays!.html"}
#### `clear-overlays!`
`(clear-overlays! [kind])`

Remove the current buffer's overlays — all of them, or only those of
one `kind`.
:::

:::function{name="overlay-count" path="reference/buffer-primitives/overlay-count.html"}
#### `overlay-count`
`(overlay-count)`

The number of live overlays on the current buffer.
:::

### The clipboard

:::function{name="clipboard-text" aliases="clipboard-set-text!" path="reference/buffer-primitives/clipboard-text.html"}
#### `clipboard-text` / `clipboard-set-text!`
`(clipboard-text)` / `(clipboard-set-text! s)`

Read and write the kill ring's clipboard mirror. The mirror is
server-local — the server is a headless Node child with no OS
clipboard — so kill and yank round-trip fully *within* the editor,
but true cross-application paste through this primitive is deferred.
The kill-ring commands are in `commands.md`.
:::

### Buffers and views

Under Model B a *view* maps onto a server buffer: buffers are shared
server state, and each window tracks which of them it has open (its
*open set*). Non-text views — PDFs, images, shells — are
*data-sources* alongside the buffers. The pane and window commands
over this surface are documented in `panes.md`; the tool views in
`views.md`.

:::function{name="new-view!" path="reference/buffer-primitives/new-view!.html"}
#### `new-view!`
`(new-view! [name])`

Mint a fresh empty buffer named `name` (default `"scratch"`) and
switch the active window to it; subsequent `insert!` calls land there.
Returns the new view. cmd(occur) builds its results buffer exactly
this way: `(new-view! name)` then `(insert! …)`.
:::

:::function{name="new-scratch-view!" path="reference/buffer-primitives/new-scratch-view!.html"}
#### `new-scratch-view!`
`(new-scratch-view!)`

Mint a uniquely-named Lisp scratch buffer (`scratch.lisp`,
`scratch-2.lisp`, …) seeded like the first-run scratch, and switch to
it. Returns the new view. Behind cmd(scratch-buffer) (`C-x n`).
:::

:::function{name="next-view!" aliases="previous-view!" path="reference/buffer-primitives/next-view!.html"}
#### `next-view!` / `previous-view!`
`(next-view!)` / `(previous-view!)`

Step the active window's open set forward or backward from its current
buffer and switch. A no-op with fewer than two open views. Wrapped by
cmd(next-view) (`C-x C-right`) and cmd(previous-view)
(`C-x C-left`).
:::

:::function{name="find-view" path="reference/buffer-primitives/find-view.html"}
#### `find-view`
`(find-view name)`

The active window's view of the buffer named `name`, or `#f` — so
`(if (find-view n) …)` works.
:::

:::function{name="switch-to-view!" path="reference/buffer-primitives/switch-to-view!.html"}
#### `switch-to-view!`
`(switch-to-view! name-or-view)`

Switch the active window to a buffer, by name or by a view handle.
Returns the resulting view, or `nil` on a miss (another truthy-`nil`
miss; test with `find-view` first if you need to branch).
:::

:::function{name="switch-to-buffer-id!" path="reference/buffer-primitives/switch-to-buffer-id!.html"}
#### `switch-to-buffer-id!`
`(switch-to-buffer-id! id)`

Switch the active window to the buffer with `id` — the on-choose
action of the `C-x C-b` picker, whose rows carry buffer ids. Returns
`#t` on success, `#f` when no such id exists.
:::

:::function{name="kill-current-buffer!" path="reference/buffer-primitives/kill-current-buffer!.html"}
#### `kill-current-buffer!`
`(kill-current-buffer!)`

Remove the active window's current buffer from the registry and switch
that window to another; the registry refuses to drop the last buffer.
Behind cmd(kill-view) (`C-x k`).
:::

:::function{name="view-list" path="reference/buffer-primitives/view-list.html"}
#### `view-list`
`(view-list)`

The active window's open views, as a list. Text views are real view
objects; a non-text data-source (image, audio, PDF) appears as a
lightweight wrapper carrying its file path, so `view-file-path` works
on both. The LaTeX compile loop walks this to decide whether a built
PDF is already on screen.
:::

:::function{name="view-file-path" aliases="view-buffer view-directory" path="reference/buffer-primitives/view-file-path.html"}
#### `view-file-path` / `view-buffer` / `view-directory`
`(view-file-path v)` / `(view-buffer v)` / `(view-directory v)`

Map a view (an element of `view-list`) to its absolute file path, its
underlying buffer object, or its file's directory — each `nil` when
the view has no backing file (a scratch). RefTeX's multi-file document
model is built on these.
:::

:::function{name="dirty-buffer-ids" aliases="dirty-pathless-count buffer-name-by-id save-buffer-by-id!" path="reference/buffer-primitives/dirty-buffer-ids.html"}
#### `dirty-buffer-ids` and the save-walk helpers
`(dirty-buffer-ids)` / `(dirty-pathless-count)` / `(buffer-name-by-id id)` / `(save-buffer-by-id! id)`

The quartet feeding cmd(quit-editor)'s cross-window save walk
(`C-x C-c`): the ids of modified buffers that have a file path (in a
list), the count of modified path-less buffers (which the walk cannot
save), a buffer id's display name (or `nil`), and an in-place save of
one buffer by id without switching any window. The server sees every
window's buffers, which is why the walk lives server-side.
:::

### The utility dock

The tabbed panel along the bottom of a window — REPL, compile output,
help. The dock is per-window renderer UI, so each of these rides a
directive to the window that ran the command. The LaTeX compile loop
writes its `*TeX output*` and `*TeX errors*` tabs through them
(`latex.md`).

:::function{name="utility-panel-open!" path="reference/buffer-primitives/utility-panel-open!.html"}
#### `utility-panel-open!`
`(utility-panel-open! factory [id [title]])`

Open (or create) a dock tab. `factory` names the tab type; `id`
identifies the tab for later writes (default: the factory name);
`title` is its label (default: the id). Returns the id.
:::

:::function{name="utility-panel-set!" aliases="utility-panel-append! utility-panel-activate!" path="reference/buffer-primitives/utility-panel-set!.html"}
#### `utility-panel-set!` / `utility-panel-append!` / `utility-panel-activate!`
`(utility-panel-set! id text)` / `(utility-panel-append! id text)` / `(utility-panel-activate! id)`

Replace a tab's content, append to it, and bring it to the front.
:::

### Processes

:::function{name="run-process!" path="reference/buffer-primitives/run-process!.html"}
#### `run-process!`
`(run-process! program args cwd on-exit)`

Spawn `program` (a string) with `args` (a list of strings) in `cwd` (a
directory string, or `nil` for the server's own). No shell is involved
— the argv goes straight to exec, so shell metacharacters are inert.
Returns a run-id string immediately; when the process exits, `on-exit`
(a procedure) is applied once to a map `{:stdout :stderr :code}` —
`:code` is `nil` when the process died to a signal or failed to spawn,
with the error text in `:stderr`. The whole LaTeX and JMarkdown
compile machinery rides this one async seam (`latex.md`).
:::

### The application

Two entries from this document's earlier life deserve an honest
correction rather than silent deletion:

- *There is no reload primitive.* `reload-stdlib!` is gone, and no
  replacement exists in the server: editing a standard-library `.lisp`
  file takes effect on the next app launch. (`C-x C-r` is deliberately
  unbound for the same reason.)
- *Quitting is a command, not a primitive.* cmd(quit-editor)
  (`C-x C-c`) runs the cross-window unsaved-buffers walk server-side —
  see the save-walk helpers above — and is documented in `commands.md`.

### Sticky notes

The `note-…` primitive family this section once documented
(`note-create!`, `note-ids`, `note-goto!`, and eleven relatives) no
longer exists in the live Lisp world. Sticky notes are a render-side
overlay — the renderer owns the note ids and geometry — so each of the
six `M-n` commands (cmd(add-sticky-note), cmd(edit-sticky-note),
cmd(delete-sticky-note), cmd(next-sticky-note),
cmd(previous-sticky-note), cmd(toggle-sticky-notes)) emits a single
directive and the renderer performs the whole operation. Scripting
notes from Lisp beyond invoking those six commands is currently not
possible. The commands are documented with the productivity features
(`productivity.md`).
