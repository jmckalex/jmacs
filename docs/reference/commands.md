Title: Godot Command Reference
Author: J. McKenzie Alexander
Date: 2026-07-21
---

## Godot Command Reference

This document describes the core of the Godot standard library — the
everyday editing commands and the machinery that dispatches them:
ordinary Lisp, defined in `packages/stdlib/lisp/`, built on the buffer
primitives (`buffer-primitives.md`) and the core language
(`lisp-core.md`).

The standard library has grown well past one file, and so has its
reference. This file covers movement, the mark, editing, indentation and
auto-fill, undo, the kill ring, files, search, the command system,
help, Markdown writing, key dispatch, modes, sticky notes and preview.
Its siblings cover the rest:
`panes.md` (panes, windows and view switching), `views.md` (media and
tool views), `search-and-edit.md` (regexp search, `query-replace`,
occur, folding, the line commands, `yank-pop`, `expand-region`,
`deselect`), `productivity.md` (multi-cursor, snippets, inline
evaluation), `latex.md` (the LaTeX and RefTeX stack) and
`help-and-config.md` (help, bookmarks, customization). See `index.md`
for how to read an entry and what the conventions mean.

Entries are grouped by task. A *command* — a procedure declared with
cmd(defcommand), runnable by name with `M-x` and usually bound to a
key — is the common case. A command may take arguments: an
`(interactive …)` spec declares how they are gathered — from the
region, from a minibuffer prompt — so the same procedure is callable
programmatically and by name (§*The command system*).

One note on attribution. The editor runs a single Lisp world in the
server (the "spine"); most sections here load verbatim from the named
`.lisp` file, but a handful of commands are defined by the server
itself rather than by loading the file of the same territory —
`find-file`, `save-buffer`, `describe-key`, `quit-editor`, the
sticky-note family. Each entry describes the live behaviour, and the
section notes say where the definition actually lives.

Key bindings are given in the manual's notation (the *Keys* chapter):
`C-` is Control, `M-` is Command (Meta, Emacs-on-Mac style), `A-` is
Option, `S-` is Shift; modifiers prefix in the order `C-M-A-S-`. An
`A-` chord the keymap does not bind falls through to inserting the
character Option composes, so accents and typographic characters still
type natively. Where the familiar Emacs chord is not what the keymap
literally binds — the renderer normalises a shifted symbol to its key
name — the entry gives both: `M-<` arrives as `M-S-comma`. The space
bar is written `SPC` (normalised `space`); arrows are shown as glyphs
(normalised `left`, `right`, `up`, `down`).

---

### Cursor movement

Defined in `editing.lisp`. Each is a thin command over a buffer
primitive (`buffer-primitives.md`); the command is the layer the keymap
binds and the layer you redefine.

:::function{name="forward-char" path="reference/commands/forward-char.html"}
#### `forward-char`
`(forward-char)`

Move the cursor one character to the right. Bound to `→` and `C-f`.
Cousin of cmd(backward-char).
:::

:::function{name="backward-char" path="reference/commands/backward-char.html"}
#### `backward-char`
`(backward-char)`

Move the cursor one character to the left. Bound to `←` and `C-b`.
Cousin of cmd(forward-char).
:::

:::function{name="next-line" path="reference/commands/next-line.html"}
#### `next-line`
`(next-line)`

Move the cursor down one line. Bound to `↓` and `C-n`. A run of
consecutive vertical moves keeps the *goal column*: point aims for the
column the run started at, snapping in on shorter lines and returning
to it on longer ones — Emacs's temporary-goal-column rule, implemented
in the L2 buffer (`packages/buffer/src/buffer.js`). Any other command
between the moves resets it. Cousin of cmd(previous-line).
:::

:::function{name="previous-line" path="reference/commands/previous-line.html"}
#### `previous-line`
`(previous-line)`

Move the cursor up one line. Bound to `↑` and `C-p`. Shares the goal
column with cmd(next-line).
:::

:::function{name="move-beginning-of-line" path="reference/commands/move-beginning-of-line.html"}
#### `move-beginning-of-line`
`(move-beginning-of-line)`

Move the cursor to the start of the current line. Bound to `Home`,
`C-a` and `C-←`. Cousin of cmd(move-end-of-line).
:::

:::function{name="move-end-of-line" path="reference/commands/move-end-of-line.html"}
#### `move-end-of-line`
`(move-end-of-line)`

Move the cursor to the end of the current line. Bound to `End`, `C-e`
and `C-→`. Cousin of cmd(move-beginning-of-line).
:::

:::function{name="beginning-of-buffer" path="reference/commands/beginning-of-buffer.html"}
#### `beginning-of-buffer`
`(beginning-of-buffer)`

Move the cursor to the start of the buffer. Bound to `C-↑` and `M-<`
(which arrives as `M-S-comma`). Cousin of cmd(end-of-buffer).
:::

:::function{name="end-of-buffer" path="reference/commands/end-of-buffer.html"}
#### `end-of-buffer`
`(end-of-buffer)`

Move the cursor to the end of the buffer. Bound to `C-↓` and `M->`
(which arrives as `M-S-period`). Cousin of cmd(beginning-of-buffer).
:::

:::function{name="forward-word" path="reference/commands/forward-word.html"}
#### `forward-word`
`(forward-word)`

Move forward to the end of the next word. Bound to `M-f`, with arrow
synonyms `M-→` and `A-→` (the macOS Option-arrow habit works too). A
*word* is a run of word characters, as decided by the
`word-forward-offset` primitive — Unicode-aware: any letter or digit
in any script counts, plus underscore, so motion does not stop dead at
an accented letter ("café", "naïve"). Cousin of cmd(backward-word).
:::

:::function{name="backward-word" path="reference/commands/backward-word.html"}
#### `backward-word`
`(backward-word)`

Move backward to the start of the previous word. Bound to `M-b`, with
arrow synonyms `M-←` and `A-←`. Cousin of cmd(forward-word).
:::

:::function{name="forward-sentence" path="reference/commands/forward-sentence.html"}
#### `forward-sentence`
`(forward-sentence)`

Move forward to the end of the sentence. Bound to `M-e`. A sentence
ends at `.`, `!` or `?` followed by whitespace or the buffer's end.
Cousin of cmd(backward-sentence).
:::

:::function{name="backward-sentence" path="reference/commands/backward-sentence.html"}
#### `backward-sentence`
`(backward-sentence)`

Move backward to the start of the sentence. Bound to `M-a`. Cousin of
cmd(forward-sentence).
:::

:::function{name="forward-paragraph" path="reference/commands/forward-paragraph.html"}
#### `forward-paragraph`
`(forward-paragraph)`

Move forward to the end of the paragraph — the start of the blank line
that ends it, or the end of the buffer. Bound to `M-}` (which arrives
as `M-S-]`). A paragraph is a run of non-blank lines. Extends an
active region. Cousin of cmd(backward-paragraph).
:::

:::function{name="backward-paragraph" path="reference/commands/backward-paragraph.html"}
#### `backward-paragraph`
`(backward-paragraph)`

Move backward to the start of the paragraph — the blank line above it,
or the start of the buffer. Bound to `M-{` (which arrives as `M-S-[`).
Extends an active region. Cousin of cmd(forward-paragraph).
:::

:::function{name="back-to-indentation" path="reference/commands/back-to-indentation.html"}
#### `back-to-indentation`
`(back-to-indentation)`

Move the cursor to the first non-blank character of the line. Bound to
`M-m`. Computed as the line start plus the length of the line's
leading indentation.
:::

:::function{name="goto-line" path="reference/commands/goto-line.html"}
#### `goto-line`
`(goto-line line)`

Move the cursor to `line`. Bound to `M-g`. The argument is gathered by
the command's `(interactive (number "Goto line: "))` spec — a
minibuffer prompt, driven by the Lisp command system (§*The command
system*); called programmatically, pass the line number yourself.
:::

:::function{name="recenter" path="reference/commands/recenter.html"}
#### `recenter`
`(recenter)`

Scroll so the cursor's line is centred in the viewport. Bound to `C-l`.
:::

:::function{name="scroll-up" path="reference/commands/scroll-up.html"}
#### `scroll-up`
`(scroll-up)`

Move the cursor forward by roughly one screenful. Bound to `C-v`.
Implemented as `page-lines` repetitions of `cursor-down!` — the point
moves, and the viewport follows it. Cousin of cmd(scroll-down).
:::

:::function{name="scroll-down" path="reference/commands/scroll-down.html"}
#### `scroll-down`
`(scroll-down)`

Move the cursor backward by roughly one screenful. Bound to `M-v`.
Cousin of cmd(scroll-up).
:::

### Movement that extends the selection

Defined in `editing.lisp`. The character and line commands pass `#t` to
their buffer primitive, which extends the selection as it moves (the
Shift-select forms); the word commands anchor the mark themselves when
no region is active, then move. They exist as separate commands so the
keymap can bind the shifted keys.

:::function{name="forward-char-extending" path="reference/commands/forward-char-extending.html"}
#### `forward-char-extending`
`(forward-char-extending)`

Move one character right, extending the selection. Bound to `S-→` and
`C-S-f`.
:::

:::function{name="backward-char-extending" path="reference/commands/backward-char-extending.html"}
#### `backward-char-extending`
`(backward-char-extending)`

Move one character left, extending the selection. Bound to `S-←` and
`C-S-b`.
:::

:::function{name="next-line-extending" path="reference/commands/next-line-extending.html"}
#### `next-line-extending`
`(next-line-extending)`

Move down one line, extending the selection. Bound to `S-↓` and
`C-S-n`, with the shifted-arrow synonyms `M-S-↓` and `A-S-↓`.
:::

:::function{name="previous-line-extending" path="reference/commands/previous-line-extending.html"}
#### `previous-line-extending`
`(previous-line-extending)`

Move up one line, extending the selection. Bound to `S-↑` and `C-S-p`,
with the shifted-arrow synonyms `M-S-↑` and `A-S-↑`.
:::

:::function{name="forward-word-extending" path="reference/commands/forward-word-extending.html"}
#### `forward-word-extending`
`(forward-word-extending)`

Extend the selection to the end of the next word. Bound to `M-S-→` and
`A-S-→`. Anchors the mark at point when no region is active, then
moves — so repeated presses grow the selection word by word. Cousin of
cmd(backward-word-extending).
:::

:::function{name="backward-word-extending" path="reference/commands/backward-word-extending.html"}
#### `backward-word-extending`
`(backward-word-extending)`

Extend the selection to the start of the previous word. Bound to
`M-S-←` and `A-S-←`. Cousin of cmd(forward-word-extending).
:::

:::function{name="beginning-of-line-extending" path="reference/commands/beginning-of-line-extending.html"}
#### `beginning-of-line-extending`
`(beginning-of-line-extending)`

Move to the line start, extending the selection. Bound to `S-Home` and
`C-S-a`.
:::

:::function{name="end-of-line-extending" path="reference/commands/end-of-line-extending.html"}
#### `end-of-line-extending`
`(end-of-line-extending)`

Move to the line end, extending the selection. Bound to `S-End` and
`C-S-e`.
:::

### The mark and the region

The *mark* is the selection anchor; the *region* is the text between
mark and point. Once the mark is set, ordinary movement extends the
region until it is cleared. See the manual's *Search and marks*
chapter.

:::function{name="set-mark-command" path="reference/commands/set-mark-command.html"}
#### `set-mark-command`
`(set-mark-command)`

Set the mark at the cursor, starting a region. Bound to `C-SPC`
(normalised `C-space`). Echoes `Mark set`. While the mark is set,
cursor movement extends the region; `C-g` clears it. Defined in
`editing.lisp`; the server redefines it with the echo.
:::

:::function{name="mark-whole-buffer" path="reference/commands/mark-whole-buffer.html"}
#### `mark-whole-buffer`
`(mark-whole-buffer)`

Select the entire buffer — move point to the end and set the mark at
the start. Bound to `C-x h`. Defined in `editing.lisp`.
:::

:::function{name="mark-word" path="reference/commands/mark-word.html"}
#### `mark-word`
`(mark-word)`

Set the mark at the end of the next word, selecting it; with a forward
region already active, extend the region by another word — repeated
presses grab word after word. Bound to `M-@` (which arrives as
`M-S-2`). Defined in `editing.lisp`.
:::

:::function{name="mark-paragraph" path="reference/commands/mark-paragraph.html"}
#### `mark-paragraph`
`(mark-paragraph)`

Select the paragraph around the cursor: point at its start, mark at its
end. Bound to `M-h` — shadowing the app menu's Hide accelerator, as an
Emacs meaning outranks a macOS one throughout the keymap (the menu item
itself still works). Defined in `editing.lisp`.
:::

:::function{name="exchange-point-and-mark" path="reference/commands/exchange-point-and-mark.html"}
#### `exchange-point-and-mark`
`(exchange-point-and-mark)`

Move point to the mark and the mark to where point was. Bound to
`C-x C-x`. Does nothing if the mark is not set. Defined in
`editing.lisp`.
:::

:::function{name="keyboard-quit" path="reference/commands/keyboard-quit.html"}
#### `keyboard-quit`
`(keyboard-quit)`

Abort a partial key sequence and clear the selection. Bound to `C-g`.
Resets the active prefix-map stack and the chord echo
(cmd(reset-keymap!)), clears any pending prefix argument, and clears
the mark. The base command is defined in `keymap.lisp`;
`multi-cursor.lisp` wraps it, so the live definition also collapses a
multi-cursor set back to the primary cursor. To clear selections
*without* collapsing the cursor set, use cmd(deselect) (`Esc`;
documented in `search-and-edit.md`).
:::

### Editing text

Defined in `editing.lisp`.

:::function{name="delete-backward" path="reference/commands/delete-backward.html"}
#### `delete-backward`
`(delete-backward)`

Delete the character before the cursor, or the selection if one is
active. Bound to `Backspace`.
:::

:::function{name="delete-forward" path="reference/commands/delete-forward.html"}
#### `delete-forward`
`(delete-forward)`

Delete the character after the cursor, or the selection if one is
active. Bound to `Delete` and `C-d`.
:::

:::function{name="transpose-chars" path="reference/commands/transpose-chars.html"}
#### `transpose-chars`
`(transpose-chars)`

Interchange the characters around the cursor, moving forward — the
character before point is dragged past the one after it, so repeated
presses drag it rightward. At the end of a line (or the buffer) the two
characters before the cursor are exchanged instead and the cursor stays
put. Bound to `C-t`. Does nothing at the start of the buffer. Character
boundaries are measured with the cursor-motion primitives, not offset
arithmetic, so a surrogate pair (an emoji) transposes as a unit.
:::

:::function{name="transpose-words" path="reference/commands/transpose-words.html"}
#### `transpose-words`
`(transpose-words)`

Interchange the word at or after the cursor with the word before it,
leaving the cursor after both — repeated presses drag a word rightward.
Punctuation and whitespace between the words stay put. Bound to `M-t`.
Does nothing without two words to transpose.
:::

:::function{name="transpose-lines" path="reference/commands/transpose-lines.html"}
#### `transpose-lines`
`(transpose-lines)`

Exchange the current line with the one above, leaving the cursor after
both — repeated presses drag a line downward. Bound to `C-x C-t`. Does
nothing on the first line. Defined in `line-ops.lisp`, whose other
commands — cmd(move-line-up) / cmd(move-line-down) (`M-↑` / `M-↓`),
cmd(duplicate-line), cmd(join-line), cmd(sort-lines) — are documented
in `search-and-edit.md`.
:::

:::function{name="insert-single-open-quote" path="reference/commands/insert-single-open-quote.html"}
#### `insert-single-open-quote`
`(insert-single-open-quote)`

Insert a left single curly quote `‘`. Bound to `A-[`. The quote family
puts the *side* on the bracket and *double* on Shift — the editor's own
layout, replacing the macOS Option-compose defaults (which put the
double quotes on the unshifted chords). Because these are bound chords,
they are claimed by the keymap before the unbound-`A-` compose
fallthrough. Electric behaviours (auto-fill's post-self-insert hook)
run as for a typed character.
:::

:::function{name="insert-single-close-quote" path="reference/commands/insert-single-close-quote.html"}
#### `insert-single-close-quote`
`(insert-single-close-quote)`

Insert a right single curly quote `’`. Bound to `A-]`.
:::

:::function{name="insert-double-open-quote" path="reference/commands/insert-double-open-quote.html"}
#### `insert-double-open-quote`
`(insert-double-open-quote)`

Insert a left double curly quote `“`. Bound to `A-S-[`.
:::

:::function{name="insert-double-close-quote" path="reference/commands/insert-double-close-quote.html"}
#### `insert-double-close-quote`
`(insert-double-close-quote)`

Insert a right double curly quote `”`. Bound to `A-S-]`.
:::

:::function{name="upcase-word" path="reference/commands/upcase-word.html"}
#### `upcase-word`
`(upcase-word)`

Uppercase from the cursor to the end of the word and move there — or,
with an active region, uppercase the region (dwim). Bound to `M-u`.
Cousin of cmd(downcase-word).
:::

:::function{name="downcase-word" path="reference/commands/downcase-word.html"}
#### `downcase-word`
`(downcase-word)`

Lowercase from the cursor to the end of the word and move there — or,
with an active region, lowercase the region (dwim). Bound to `M-l`.
Cousin of cmd(upcase-word).
:::

:::function{name="capitalize-word" path="reference/commands/capitalize-word.html"}
#### `capitalize-word`
`(capitalize-word)`

Capitalize from the cursor to the end of the word (first letter up, the
rest down) and move there — or, with an active region, capitalize every
word in it (dwim). Bound to `M-c`.
:::

:::function{name="upcase-region" path="reference/commands/upcase-region.html"}
#### `upcase-region`
`(upcase-region start end)`

Uppercase the region from `start` to `end`. Bound to `C-x C-u`. The
arguments are supplied by the command's `(interactive region)` spec —
the active region's bounds; run by key or `M-x`, it errors without an
active region. Cousin of cmd(downcase-region).
:::

:::function{name="downcase-region" path="reference/commands/downcase-region.html"}
#### `downcase-region`
`(downcase-region start end)`

Lowercase the region from `start` to `end`. Bound to `C-x C-l`. The
arguments come from the active region, as for cmd(upcase-region).
:::

:::function{name="delete-horizontal-space" path="reference/commands/delete-horizontal-space.html"}
#### `delete-horizontal-space`
`(delete-horizontal-space)`

Delete all spaces and tabs around the cursor, bounded by the current
line. Bound to `M-\` (normalised `M-backslash`).
:::

:::function{name="just-one-space" path="reference/commands/just-one-space.html"}
#### `just-one-space`
`(just-one-space)`

Replace the spaces and tabs around the cursor with a single space,
inserting one when there is none. Bound to `M-SPC` and to Hyper+Space
(`C-M-A-S-space`). macOS claims `Cmd+Space` for Spotlight before apps
see it; the Karabiner rule in `tools/karabiner/godot-cmd-space.json`
rewrites `Cmd+Space` to Hyper+Space while the editor is frontmost, so
the natural key works here and Spotlight survives everywhere else.
:::

:::function{name="delete-indentation" path="reference/commands/delete-indentation.html"}
#### `delete-indentation`
`(delete-indentation)`

Join the current line onto the end of the previous one, collapsing the
newline and surrounding whitespace to a single space — the upward twin
of cmd(join-line) (`C-x C-j`; documented in `search-and-edit.md`).
Bound to `M-^` (which arrives as `M-S-6`).
:::

:::function{name="delete-blank-lines" path="reference/commands/delete-blank-lines.html"}
#### `delete-blank-lines`
`(delete-blank-lines)`

On a blank line, delete all surrounding blank lines, leaving one; on an
isolated blank line, delete it; on a non-blank line, delete the blank
lines that follow. Bound to `C-x C-o`.
:::

:::function{name="newline" path="reference/commands/newline.html"}
#### `newline`
`(newline)`

Insert a line break, copying the current line's leading indentation
onto the new line. Bound to `Enter` and `C-j`.
:::

:::function{name="open-line" path="reference/commands/open-line.html"}
#### `open-line`
`(open-line)`

Insert a newline after the cursor, leaving the cursor before it — opens
a blank line below without descending onto it. Bound to `C-o`.
:::

:::function{name="insert-tab" path="reference/commands/insert-tab.html"}
#### `insert-tab`
`(insert-tab)`

Insert a tab at the cursor: a literal `\t` when `*indent-tabs-mode*`
is on (the default), else `*tab-width*` spaces. Bound to `Tab`. A major
mode can pin either behaviour via its `:indent-tabs?` / `:tab-width`
keys — Makefile-mode pins tabs on, since `make` treats leading spaces
as a hard error. See §*Indentation* for the settings and the
block-indent commands.
:::

:::function{name="fill-paragraph" path="reference/commands/fill-paragraph.html"}
#### `fill-paragraph`
`(fill-paragraph)`

Re-wrap the paragraph around the cursor to a fill column of 72, keeping
the paragraph's indentation. Bound to `M-q`. The paragraph is the run
of non-blank lines around the cursor; does nothing on a blank line.
Two caveats: the 72 is the host primitive's own — this command does
*not* read `*fill-column*`, which governs cmd(auto-fill-mode)
(§*Auto-fill*); and `latex-mode` and `jmarkdown-mode` shadow `M-q`
with mode-local fills that understand their own syntax (see `latex.md`
and the manual's *JMarkdown* chapter).
:::

:::function{name="comment-line" path="reference/commands/comment-line.html"}
#### `comment-line`
`(comment-line)`

Comment or uncomment the current line. Bound to `C-x ;`. Uses the
comment prefix of the buffer's major mode (cmd(comment-prefix));
toggles — adds the prefix if absent, removes it if present.
:::

:::function{name="replace-string" path="reference/commands/replace-string.html"}
#### `replace-string`
`(replace-string from to)`

Replace every occurrence of `from` with `to`, throughout the buffer,
without asking. Bound to `M-r`. The arguments are gathered by the
command's `(interactive (string "Replace: ") (string "Replace with: "))`
spec — two minibuffer prompts in sequence. For the interactive,
per-match version, see cmd(query-replace) (`M-%`) in
`search-and-edit.md`.
:::

### Indentation

The settings are defined in `indent.lisp`, the block commands in
`line-ops.lisp`. Two customisable variables govern the `Tab` key and
the indent commands; a major mode can pin both.

:::function{name="*tab-width*" path="reference/commands/*tab-width*.html"}
#### `*tab-width*`

How many columns wide a tab character displays (the editor's
`tab-size`, synchronised to the `--tab-width` CSS variable), and how
many spaces cmd(insert-tab) produces when `*indent-tabs-mode*` is off.
A defcustom; default `4`. A mode's `:tab-width` key wins over it in
that mode's buffers.
:::

:::function{name="*indent-tabs-mode*" path="reference/commands/*indent-tabs-mode*.html"}
#### `*indent-tabs-mode*`

When `#t` (the default), the `Tab` key inserts a literal tab; when
`#f`, it inserts `*tab-width*` spaces. A defcustom. A mode's
`:indent-tabs?` key wins over it — Makefile-mode pins it on; a mode
that needs spaces can pin it off.
:::

:::function{name="indent-region" path="reference/commands/indent-region.html"}
#### `indent-region`
`(indent-region)`

Indent the lines the region touches (or the current line) by one
level — a tab where tabs are in force, else `*tab-width*` spaces.
Bound to `M-]`. Blank lines are left alone; the selection survives,
shifted to keep its place in the text. A region ending at column 0
does not touch that line (Sublime's rule). Cousin of
cmd(outdent-region).
:::

:::function{name="outdent-region" path="reference/commands/outdent-region.html"}
#### `outdent-region`
`(outdent-region)`

Outdent the lines the region touches (or the current line) by one
level — a leading tab, or up to `*tab-width*` spaces. Bound to `M-[`.
The selection survives. Cousin of cmd(indent-region).
:::

:::function{name="tabify-region" aliases="untabify-region" path="reference/commands/tabify-region.html"}
#### `tabify-region` / `untabify-region`
`(tabify-region)` / `(untabify-region)`

Re-express the *leading* indentation of the lines the region (or the
cursor's line) touches: `tabify-region` packs every `*tab-width*`
columns into one tab, any remainder staying as spaces;
`untabify-region` expands each leading tab to spaces. Interior
alignment — tables, trailing comments — is left exactly as it is. The
selection survives. Unbound; reach them via `M-x`.
:::

:::function{name="tabify-buffer" aliases="untabify-buffer" path="reference/commands/tabify-buffer.html"}
#### `tabify-buffer` / `untabify-buffer`
`(tabify-buffer)` / `(untabify-buffer)`

The whole-buffer variants of cmd(tabify-region) /
cmd(untabify-region), as one atomic change with point kept on its
character. Use `tabify-buffer` to retab a spaces-indented file after
turning `*indent-tabs-mode*` on. Unbound; reach them via `M-x`.
:::

### Auto-fill

Defined in `auto-fill.lisp`. A wrap-as-you-type minor mode: with it on,
typing a character that pushes the line past the fill column breaks the
line at the last word boundary at or before the column and indents the
continuation. It rides the `*post-self-insert-hook*` seam (§*Key
dispatch*). Off by default.

:::function{name="auto-fill-mode" path="reference/commands/auto-fill-mode.html"}
#### `auto-fill-mode`
`(auto-fill-mode)`

Toggle automatic line wrapping in the current buffer, echoing the new
state. Run with `M-x`. The continuation line's indent is chosen by the
major mode: a mode with a `:fill-indent-function` key indents per its
own syntax (jmarkdown-mode does); otherwise the broken line's leading
indentation is reproduced — the prose fill-prefix default. To turn it
on for a whole mode, hook the mode from `init.lisp`:

```lisp
(add-hook markdown-mode
          (lambda () (enable-minor-mode auto-fill-minor-mode)))
```

Note the split: the mode *value* is `auto-fill-minor-mode`; the toggle
*command* is `auto-fill-mode`. Commands and variables share one
namespace, so the two must differ.
:::

:::function{name="set-fill-column" path="reference/commands/set-fill-column.html"}
#### `set-fill-column`
`(set-fill-column column)`

Set the fill column auto-fill wraps at. Bound to `C-x f`; the argument
comes from a minibuffer prompt. Applies the value through the customize
machinery (`custom-apply!`), so it persists like any customisation. A
mode's own `:fill-column` still wins in its buffers.
:::

:::function{name="*fill-column*" path="reference/commands/*fill-column*.html"}
#### `*fill-column*`

The column cmd(auto-fill-mode) wraps lines at. A defcustom; default
`70` (Emacs's default). A major mode may pin a mode-local value via a
`:fill-column` key on its mode map. NB: the generic cmd(fill-paragraph)
(`M-q`) is a separate code path and does not read this variable.
:::

### Undo

Defined in `editing.lisp`, thin commands over the history primitives
`undo!` / `redo!`. One buffer mutation is one undo step — except where
a command wraps several mutations in cmd(atomic-change-group), which
then undo (and redo) as a single step; nearly every shipped multi-edit
command does.

:::function{name="undo" path="reference/commands/undo.html"}
#### `undo`
`(undo)`

Undo the last change. Bound to `C-z`, `M-z` (Cmd+Z), `C-x u`, `C-/`
(normalised `C-slash`) and `C-_` (normalised `C-S-minus`). Cousin of
cmd(redo).
:::

:::function{name="redo" path="reference/commands/redo.html"}
#### `redo`
`(redo)`

Redo the last undone change. Bound to `C-S-z`, `M-S-z` (Cmd+Shift+Z)
and `C-S-/` (normalised `C-S-slash`). Cousin of cmd(undo).
:::

### Atomic undo

Defined in `editing.lisp`. The undo-grouping macro every multi-edit
command wraps its mutations in.

:::function{name="atomic-change-group" path="reference/commands/atomic-change-group.html"}
#### `atomic-change-group`
`(atomic-change-group body…)` — *macro*

Evaluate the body with every buffer edit it makes — however many,
through whatever functions — grouped into a single undo step, and
return the body's value. The group closes on every exit: normal
return, a Lisp error, even a raw JS exception from a host primitive
(it is built on `try`/`finally`). Nested groups fold into the
outermost one; `undo!` and `redo!` are no-ops while a group is open.
The rule of thumb: any command making more than one buffer mutation
wraps them.

```lisp
(atomic-change-group
  (delete-region! start end)
  (insert! replacement))     ; one undo step, not two
```
:::

### Markers and excursions

Defined in `editing.lisp`, over the marker primitives
(`buffer-primitives.md`). A marker is an edit-tracking position that
must be released when done with; these two macros own that lifecycle,
releasing on every exit — normal return and error alike — so the
marker cannot leak.

:::function{name="with-marker" path="reference/commands/with-marker.html"}
#### `with-marker`
`(with-marker (m [offset]) body…)` — *macro*

Evaluate `body` with `m` bound to a fresh marker in the current buffer
at `offset` (the cursor when omitted), releasing it on every exit.
Returns the body's value. The body releasing the marker itself is
harmless.

```lisp
(with-marker (m)                    ; a marker at point
  (insert-at-line-start "> ")
  (goto! (marker-position m)))      ; back on the same character
```
:::

:::function{name="save-excursion" path="reference/commands/save-excursion.html"}
#### `save-excursion`
`(save-excursion body…)` — *macro*

Evaluate `body`, then restore the cursor to where it was — on normal
return and on error alike. The saved place is a marker, not a plain
integer, so edits the body makes before the cursor do not shift the
restore target. Point only: the mark is deliberately left alone.
Returns the body's value.

```lisp
(save-excursion
  (goto! (buffer-length))
  (insert! "\n;; appended"))        ; …and point never seems to move
```
:::

### The kill ring

Defined in `kill.lisp`. Killed text — cut or copied — is pushed onto
the *kill ring*, a list of recent kills held in the variable
`*kill-ring*`, and yanked back from it. See the manual's *Basic
editing* chapter.

Two behaviours run through the whole family. First, *accumulation*:
consecutive kill commands grow one kill-ring entry rather than each
pushing their own — forward kills append, backward kills prepend — so
`C-k C-k … C-y` reinserts everything as one block. "Consecutive" is
judged by `*last-command*` (§*The command system*); any other command
in between starts the next kill fresh. Every kill command below
participates; a *copy* does not. Second, the *system clipboard*: every
kill and copy is mirrored to the clipboard, and cmd(yank) pulls fresh
clipboard text onto the ring first — so the kill ring and Cmd+C/Cmd+V
in other applications interoperate in both directions.

:::function{name="*kill-ring*" path="reference/commands/*kill-ring*.html"}
#### `*kill-ring*`

The kill ring itself: a list of killed strings, most recent first.
Ordinary Lisp state — inspect or rebind it like any variable.
:::

:::function{name="kill-ring-add!" path="reference/commands/kill-ring-add!.html"}
#### `kill-ring-add!`
`(kill-ring-add! text)`

Push `text` onto the kill ring as a fresh entry *and* mirror it to the
system clipboard (Emacs's interprogram-cut). Every cut and copy funnels
through here, so this one hook covers the whole family. The kill
commands themselves go through the accumulation layer —
cmd(kill-add-forward!) / cmd(kill-add-backward!) — which call this only
when starting a fresh entry.
:::

:::function{name="kill-add-forward!" aliases="kill-add-backward!" path="reference/commands/kill-add-forward!.html"}
#### `kill-add-forward!` / `kill-add-backward!`
`(kill-add-forward! text)` / `(kill-add-backward! text)`

Record `text` killed forward / backward: when the previous command was
also a kill, the text is appended (forward) or prepended (backward) to
the ring's top entry, mirroring the clipboard; otherwise it is pushed
as a fresh entry via cmd(kill-ring-add!). The accumulation layer the
kill commands are built on.
:::

:::function{name="kill-ring-top" path="reference/commands/kill-ring-top.html"}
#### `kill-ring-top`
`(kill-ring-top)`

The most recent kill, or an empty string when the ring is empty.
:::

:::function{name="kill-ring-length" path="reference/commands/kill-ring-length.html"}
#### `kill-ring-length`
`(kill-ring-length)`

The number of entries in the kill ring.
:::

:::function{name="kill-ring-ref" path="reference/commands/kill-ring-ref.html"}
#### `kill-ring-ref`
`(kill-ring-ref index)`

The kill at `index` — 0 is the most recent — or an empty string when
the ring is empty. The index wraps around the ring; this is the
accessor cmd(yank-pop) cycles with.
:::

:::function{name="copy-region" path="reference/commands/copy-region.html"}
#### `copy-region`
`(copy-region)`

Copy the selected text to the kill ring (and the clipboard) and clear
the mark. Bound to `M-w`. Does nothing when no region is active. A copy
always pushes a fresh entry — it does not join a kill run.
:::

:::function{name="kill-region" path="reference/commands/kill-region.html"}
#### `kill-region`
`(kill-region)`

Cut the selected text to the kill ring. Bound to `C-w`. Does nothing
when no region is active. Accumulates as a forward kill.
:::

:::function{name="kill-line" path="reference/commands/kill-line.html"}
#### `kill-line`
`(kill-line)`

Kill from the cursor to the end of the line; at a line's end, kill the
newline instead. Bound to `C-k`. Accumulates as a forward kill.
:::

:::function{name="kill-word" path="reference/commands/kill-word.html"}
#### `kill-word`
`(kill-word)`

Kill forward to the end of the next word. Bound to `M-d`. Accumulates
as a forward kill. Cousin of cmd(backward-kill-word).
:::

:::function{name="kill-sentence" path="reference/commands/kill-sentence.html"}
#### `kill-sentence`
`(kill-sentence)`

Kill forward to the end of the sentence. Bound to `M-k`. Accumulates
as a forward kill.
:::

:::function{name="backward-kill-word" path="reference/commands/backward-kill-word.html"}
#### `backward-kill-word`
`(backward-kill-word)`

Kill backward to the start of the previous word. Bound to
`M-Backspace`. As a backward kill, consecutive kills *prepend* to the
accumulated entry. Cousin of cmd(kill-word).
:::

:::function{name="kill-whole-line" path="reference/commands/kill-whole-line.html"}
#### `kill-whole-line`
`(kill-whole-line)`

Kill the entire current line, its newline included. Bound to
`C-S-Backspace`. Repeated presses accumulate the lines into one
kill-ring entry.
:::

:::function{name="zap-to-char" path="reference/commands/zap-to-char.html"}
#### `zap-to-char`
`(zap-to-char)`

Read one character from the keyboard, then kill from the cursor through
its next occurrence. Unbound (Emacs's `M-z` is undo here); reach it via
`M-x`. Accumulates as a forward kill.
:::

:::function{name="yank" path="reference/commands/yank.html"}
#### `yank`
`(yank)`

Insert the most recent kill at the cursor. Bound to `C-y`. First syncs
the system clipboard onto the ring (Emacs's interprogram-paste — text
copied in another application yanks here, and a fresh ring is not
empty), then inserts the ring's top and records the insertion so a
following cmd(yank-pop) (`M-y`; documented in `search-and-edit.md`)
can cycle back through earlier kills. Over an active selection the
text replaces it.
:::

### Files

Defined in `files.lisp`; in the running editor the server embeds
equivalent definitions and fulfils the prompts itself — the entries
describe the live behaviour. The disk I/O happens host-side (the
server and the Electron main process), never in the renderer.

:::function{name="find-file" path="reference/commands/find-file.html"}
#### `find-file`
`(find-file)`

Visit a file. Bound to `C-x C-f`. Prompts for a path in the
minibuffer, seeded with the visited file's directory (the home
directory in a pathless buffer) so `Tab` lists somewhere sensible at
once. `Tab` completes against the filesystem, case-insensitively: a
unique match completes — directories gain a trailing `/` so the next
`Tab` descends — while several matches extend to their longest common
prefix or list the candidates in the utility dock's *Completions*
panel, where double-clicking a directory descends and double-clicking
a file opens it. On submit the file opens as its own buffer: a file
already open switches to its existing buffer (shared across windows,
unsaved edits intact); a directory opens as a directory-tree view; a
media file — image, audio, video, PDF — opens the matching media view;
an unreadable path reports `find-file: cannot open …` in the echo
area.
:::

:::function{name="save-buffer" path="reference/commands/save-buffer.html"}
#### `save-buffer`
`(save-buffer)`

Save the current buffer to its file — an atomic write (temp file,
fsync, rename), so a crash mid-save cannot truncate it. Bound to
`C-x C-s`. Echoes `Saved`. A buffer with no file path falls back to
cmd(write-file), prompting for one — exactly Emacs's behaviour on a
fresh buffer. A failed write is reported, not swallowed.
:::

:::function{name="write-file" path="reference/commands/write-file.html"}
#### `write-file`
`(write-file)`

Write the current buffer to a path typed in the minibuffer and rebind
the buffer to that path (save-as). Bound to `C-x C-w`. The modified
indicator clears on every window showing the buffer.
:::

### Buffers and views

The buffer-cycling commands that used to live here are *view* commands
now, documented in `panes.md` alongside the pane tree: cmd(next-view)
(`C-x →`), cmd(previous-view) (`C-x ←`), cmd(switch-view) (`C-x b`, a
minibuffer prompt completed against the open buffers), cmd(list-views)
(`C-x C-b`, an interactive picker), cmd(kill-view) (`C-x k`, with an
unsaved-changes confirm) and cmd(scratch-buffer) (`C-x n`, a fresh
seeded Lisp scratch; the empty cmd(new-view) is `M-x`-only). One list
of buffers is shared by every window; a *view* is one window's sight
of one.

### Search and replace

Defined in `search.lisp`. Incremental search is a server-side Lisp
loop: the starter command owns the keyboard via cmd(read-next-key),
echoes its prompt in the echo area, re-searches as the query changes,
and drives the host's match-highlight primitives — the current match
lit immediately, the rest debounced and windowed to the viewport. Only
the echo-area display itself is host chrome. For the regexp variants
(`C-M-s` / `C-M-r`), cmd(query-replace) (`M-%`) and the occur family
(`M-s o`), see `search-and-edit.md`.

:::function{name="isearch-forward" path="reference/commands/isearch-forward.html"}
#### `isearch-forward`
`(isearch-forward)`

Begin an incremental forward search in the current buffer. Bound to
`C-s`. Within the search: printable characters extend the query,
re-searching from the origin; `C-s` / `C-r` repeat forward / backward,
wrapping past the buffer's ends; `Backspace` shrinks the query;
`Enter` / `Esc` exit at the current match; `C-g` aborts, restoring the
origin point. A forward search lands point at the match's end. Cousin
of cmd(isearch-backward).
:::

:::function{name="isearch-backward" path="reference/commands/isearch-backward.html"}
#### `isearch-backward`
`(isearch-backward)`

Begin an incremental backward search in the current buffer. Bound to
`C-r`. Same keys within the search; a backward search lands point at
the match's start. Cousin of cmd(isearch-forward).
:::

### The command system

Defined in `commands.lisp`, loaded first in the standard library. A
*command* is a procedure declared with cmd(defcommand): unlike a plain
`define`d procedure it is recorded in a registry — so `M-x` offers it
whether or not a key binds it — and it may carry an `(interactive …)`
spec declaring how its arguments are gathered, so the same procedure is
callable programmatically and by name. Commands and plain definitions
share one namespace: a command shadows a same-named procedure.

:::function{name="defcommand" path="reference/commands/defcommand.html"}
#### `defcommand`
`(defcommand name (params…) "doc"? (interactive source…)? body…)` — *macro*

Define a procedure and register it as a command. The optional
`(interactive …)` clause is the first body form after the docstring;
its *sources*, one per parameter group, declare how the arguments are
read when the command runs by name or key:

- `point` — the cursor's offset.
- `region` — the active region's `start` and `end` (two arguments);
  errors when no region is active.
- `region-or-buffer` — the region's bounds, or the whole buffer's when
  no region is active.
- `(string "Prompt: ")` — a string read from a minibuffer prompt.
- `(number "Prompt: ")` — a number read from a minibuffer prompt.

Synchronous sources are read at once; prompt sources suspend the
command and resume it when the minibuffer delivers. A cancelled prompt
means the command simply does not run.
:::

:::function{name="register-command!" path="reference/commands/register-command!.html"}
#### `register-command!`
`(register-command! name spec)`

Record command `name` (a symbol) and its interactive `spec` (or `nil`)
in the registry. Returns `name`. cmd(defcommand) expands to a `define`
plus this call; call it directly only when building commands by hand.
:::

:::function{name="command-registered?" path="reference/commands/command-registered%3F.html"}
#### `command-registered?`
`(command-registered? name)`

True when `name` names a registered command. cmd(handle-key) consults
it before dispatching a binding, so a key bound to a name with no
definition degrades to a status message instead of an error.
:::

:::function{name="registered-command-names" path="reference/commands/registered-command-names.html"}
#### `registered-command-names`
`(registered-command-names)`

The names of every registered command, as strings — the set `M-x` and
cmd(describe-command) complete against.
:::

:::function{name="run-command" path="reference/commands/run-command.html"}
#### `run-command`
`(run-command name)`

Invoke command `name`. A command with no interactive spec is called
with no arguments; one with a spec has its arguments gathered — from
the region, the minibuffer, … — and applied. Records the command in
`*this-command*`, shifting the previous one into `*last-command*`.
Every dispatch path funnels through here: the keymap, `M-x`, the
application menus.
:::

:::function{name="*last-command*" aliases="*this-command*" path="reference/commands/*last-command*.html"}
#### `*last-command*`, `*this-command*`

The command history, one step deep: `*this-command*` is the command
running now, `*last-command*` the one that ran just before it. A
command consults `*last-command*` to behave differently when it
immediately follows a particular command — this is how kill
accumulation joins consecutive kills, and how cmd(yank-pop) knows it
follows a cmd(yank). Typing sets `*last-command*` to `self-insert`,
which is what breaks such runs.
:::

:::function{name="minibuffer-read" path="reference/commands/minibuffer-read.html"}
#### `minibuffer-read`
`(minibuffer-read prompt callback)`

Prompt in the minibuffer; `callback` receives the entered string, or
`nil` when the prompt is cancelled. The continuation-style primitive
the `(string …)` and `(number …)` interactive sources are built on —
use it directly for a prompt outside an interactive spec.
:::

### The command palette

`M-x`, the run-anything prompt. In the running editor the command is
defined by the server (`palette.lisp`'s keymap-walking enumeration
helpers are not loaded there); completion is host-fulfilled, against
cmd(registered-command-names) plus the renderer-owned element-view
command names.

:::function{name="execute-command" path="reference/commands/execute-command.html"}
#### `execute-command`
`(execute-command)`

Prompt for a command by name and run it — the `M-x` command. Bound to
`M-x`. The host completes the prompt and resolves the submitted text
leniently: the exact name if one matches, else the shortest registered
name *containing* the text — so a distinctive fragment is enough. The
resolved command runs through cmd(run-command), so its interactive
spec still gathers arguments.
:::

### Help — the editor describes itself

Every command keeps its docstring; these commands surface it. The
server owns the keymap and the docstrings, so the help commands run
there and show their answers in the echo area and the utility dock's
reusable *Help* tab (rendered as Markdown, read-only). The rest of the
help family — cmd(apropos-doc) (`C-h a`), the face inspectors, the
in-editor manual (`C-h d`) — is documented in `help-and-config.md`.

:::function{name="describe-key" path="reference/commands/describe-key.html"}
#### `describe-key`
`(describe-key)`

Describe the command bound to a key sequence. Bound to `C-h k`. Reads
a *complete* sequence, following prefix maps and echoing the keys so
far with a trailing dash — so `C-h k C-x C-f` describes `find-file`,
not "`C-x` is a prefix". An unbound sequence reports itself in the
echo area; a bound command's full docstring opens in the Help tab.
Mid-sequence `C-g` / `Esc` abort; at the first key they are real keys
to describe — `C-h k C-g` describes cmd(keyboard-quit), as in Emacs.
:::

:::function{name="describe-command" path="reference/commands/describe-command.html"}
#### `describe-command`
`(describe-command typed)`

Describe a command by name. Bound to `C-h f`; the argument comes from
a minibuffer prompt. The typed text resolves exactly like `M-x`'s
submit — the exact name, else the shortest registered name containing
it — and the resolved command's full docstring opens in the Help tab,
with the resolved name echoed so the lenient match is never a
surprise. No match reports `No command matching: …`.
:::

### Editor commands

Defined in `system.lisp` — a file the running server does not load;
see each entry for what that means in practice.

:::function{name="reload-stdlib" path="reference/commands/reload-stdlib.html"}
#### `reload-stdlib`
`(reload-stdlib)`

Re-evaluate the standard library in place — hot reload. *Currently not
available in the running editor*, and deliberately unbound:
`system.lisp` is not loaded by the server, so the command never
registers there (the old `C-x C-r` binding was removed rather than
left reporting `reload-stdlib is not available here`). Redefinition
still works live at a finer grain: evaluate any `defcommand` in the
REPL or a scratch buffer and the keymap picks it up at once, since
commands are bound by name and resolved late.
:::

:::function{name="quit-editor" path="reference/commands/quit-editor.html"}
#### `quit-editor`
`(quit-editor)`

Quit the editor. Bound to `C-x C-c`. Defined by the server (it alone
sees every window's buffers): first it walks each unsaved, path-backed
buffer across *all* windows with a per-buffer prompt — `y` save, `n`
skip, `!` save the rest, `q` stop asking, `C-g` / `Esc` cancel the
quit — then, if any buffers remain unsaved (skipped, or pathless ones
the walk cannot save), asks one final confirm before discarding them.
The shutdown itself — the workspace prompt, the metadata flush — is
handed to the originating window.
:::

### Markdown writing commands

Defined in `markdown.lisp`, loaded after `modes.lisp` and
`keymap.lisp`. They emit *JMarkdown* syntax and are bound in
`markdown-c-c-map` — the `C-c` prefix of `markdown-mode-map`
(§*Modes*) — so they are active only in a Markdown buffer. The same
commands are offered from the *Markdown* application menu, registered
via `register-mode-menu!` at the end of the file. For the richer `.jmd`
authoring stack (compile, navigation, references), see the manual's
*JMarkdown* chapter.

:::function{name="surround" path="reference/commands/surround.html"}
#### `surround`
`(surround opener closer)`

Wrap the selection in `opener` and `closer`; with no selection, insert
the pair and place the cursor between them. The helper the inline
formatting commands are built on.
:::

:::function{name="insert-at-line-start" path="reference/commands/insert-at-line-start.html"}
#### `insert-at-line-start`
`(insert-at-line-start text)`

Insert `text` at the start of the current line, leaving the cursor in
its original position relative to the text. The helper the block
commands are built on.
:::

:::function{name="markdown-bold" path="reference/commands/markdown-bold.html"}
#### `markdown-bold`
`(markdown-bold)`

Make the selection strong — JMarkdown `*…*`. Bound to `C-c b`.
:::

:::function{name="markdown-italic" path="reference/commands/markdown-italic.html"}
#### `markdown-italic`
`(markdown-italic)`

Make the selection emphasised — JMarkdown `/…/`. Bound to `C-c i`.
:::

:::function{name="markdown-code" path="reference/commands/markdown-code.html"}
#### `markdown-code`
`(markdown-code)`

Make the selection inline code — `` `…` ``. Bound to `C-c c`.
:::

:::function{name="markdown-highlight" path="reference/commands/markdown-highlight.html"}
#### `markdown-highlight`
`(markdown-highlight)`

Highlight the selection — JMarkdown `==…==`. Bound to `C-c h`.
:::

:::function{name="markdown-insert-link" path="reference/commands/markdown-insert-link.html"}
#### `markdown-insert-link`
`(markdown-insert-link)`

Insert a link, wrapping the selection as the link text and leaving the
cursor in the URL slot. Bound to `C-c l`.
:::

:::function{name="markdown-insert-cite" path="reference/commands/markdown-insert-cite.html"}
#### `markdown-insert-cite`
`(markdown-insert-cite)`

Insert a JMarkdown `\cite{}` citation, cursor inside the braces. Bound
to `C-c k`.
:::

:::function{name="markdown-insert-footnote" path="reference/commands/markdown-insert-footnote.html"}
#### `markdown-insert-footnote`
`(markdown-insert-footnote)`

Insert a JMarkdown footnote `[^: ]`, cursor in the *label* slot —
between the `^` and the `:` — ready to name the note before writing
its body after the colon. Bound to `C-c f`.
:::

:::function{name="markdown-heading-1" aliases="markdown-heading-6" path="reference/commands/markdown-heading-1.html"}
#### `markdown-heading-1` … `markdown-heading-6`
`(markdown-heading-1)` … `(markdown-heading-6)`

Make the current line a heading of the given level — prepend `#`,
`##`, … `######`. Bound to `C-c 1` through `C-c 6`.
:::

:::function{name="markdown-blockquote" path="reference/commands/markdown-blockquote.html"}
#### `markdown-blockquote`
`(markdown-blockquote)`

Make the current line a blockquote — prepend `> `. Bound to `C-c q`.
:::

:::function{name="markdown-list-item" path="reference/commands/markdown-list-item.html"}
#### `markdown-list-item`
`(markdown-list-item)`

Make the current line a list item — prepend `- `. Bound to `C-c -`.
:::

### The math minor mode

Defined in `markdown.lisp`. An AUCTeX-style minor mode: with it on, a
backtick followed by a key inserts a LaTeX math symbol.

:::function{name="math-insert-symbol" path="reference/commands/math-insert-symbol.html"}
#### `math-insert-symbol`
`(math-insert-symbol)`

Read a key and insert the LaTeX math symbol it names; an unmapped key
is inserted as itself (so `` ` `` then `` ` `` gives a literal
backtick). Bound to `` ` `` in `math-mode-map`. Looks the key up in
`*math-symbols*`.
:::

:::function{name="toggle-math-mode" path="reference/commands/toggle-math-mode.html"}
#### `toggle-math-mode`
`(toggle-math-mode)`

Toggle the math symbol-insertion minor mode in the current buffer.
Bound to `C-c m` in `markdown-mode`.
:::

:::function{name="*math-symbols*" path="reference/commands/*math-symbols*.html"}
#### `*math-symbols*`

The map from a key to a LaTeX symbol string used by `math-insert-symbol`
— `"a"` → `"\alpha"`, `"8"` → `"\infty"`, and so on. Edit it to change
or extend the symbol set.
:::

### Key dispatch

Defined in `keymap.lisp`. A *keymap* maps a key string to either a
command name (a symbol) or a nested keymap (a prefix). The renderer
reports each keystroke as a normalised string; `handle-key` — which
runs in the server, the sole resolver — dispatches it. See the
manual's *Keys* chapter and `docs/spec/modes.md` §6.

:::function{name="the-keymap" path="reference/commands/the-keymap.html"}
#### `the-keymap`

The root keymap — the global key bindings. A buffer's mode keymaps are
consulted ahead of it (cmd(keymap-chain)).
:::

:::function{name="c-x-keymap" aliases="c-h-keymap" path="reference/commands/c-x-keymap.html"}
#### `c-x-keymap`, `c-h-keymap`

The nested keymaps reached through the `C-x` and `C-h` prefixes, bound
into `the-keymap` under `"C-x"` and `"C-h"`. `c-x-keymap` itself nests
two more: `bookmark-keymap` under `C-x r` (`m` set, `b` jump, `l`
list; documented in `help-and-config.md`) and the window map under
`C-x 5` (`2` new-window, `0` close-window, `1` close-other-windows).
The other global prefixes: `c-c-keymap` under `C-c` — folding
(`C-c Tab`, `C-c C-,`, `C-c C-.`; see `search-and-edit.md`),
multi-cursor (`C-c d` / `C-c D`; see `productivity.md`) and gnuplot
(`C-c g`) — `m-s-keymap` under `M-s` — occur and match highlighting
(`M-s o` / `M-s h` / `M-s u`; see `search-and-edit.md`) — and
cmd(sticky-note-keymap) under `M-n` (§*Sticky notes*). A mode's own
`C-c` map shadows the global one only for the keys it actually binds;
mid-chord lookup falls through the stack (see cmd(active-keymap)).
:::

:::function{name="active-keymap" path="reference/commands/active-keymap.html"}
#### `active-keymap`

While a key sequence is in progress, holds the *list* (a stack) of
prefix keymaps the next keystroke is looked up in — every map along
the mode chain that bound the chord-leading key to a prefix. Mid-chord
lookup walks the stack in chain order, so a mode-local prefix does not
shadow the global one for keys it does not itself bind: `C-c d` in
markdown-mode (whose `C-c` map has no `d`) falls through to the global
`c-c-keymap` and runs `add-cursor-next`. `nil` at rest, meaning the
next key is resolved through the buffer's mode chain afresh.
:::

:::function{name="*chord-prefix*" path="reference/commands/*chord-prefix*.html"}
#### `*chord-prefix*`

The keys typed in the current sequence, joined with spaces. Empty at
rest; mid-sequence the echo area shows it with a trailing dash — the
visual signal that more keys are coming. Cleared when a command runs,
when `C-g` aborts, and when a mid-sequence key is unbound.
:::

:::function{name="*prefix-arg*" path="reference/commands/*prefix-arg*.html"}
#### `*prefix-arg*`

The pending universal argument, consumed by the next command: `nil`
when no `C-u` has been pressed, `#t` after one. A command that cares
consults it — `C-u C-x 2` splits the pane above instead of below,
`C-u C-x 3` to the left instead of right. cmd(handle-key) clears it
after the next command runs (so that command sees the value).
:::

:::function{name="universal-argument" path="reference/commands/universal-argument.html"}
#### `universal-argument`
`(universal-argument)`

Set the pending prefix argument, so the next command sees a non-nil
`*prefix-arg*`, and echo `C-u-`. Bound to `C-u`. A single press yields
the boolean argument; numeric multi-press is not supported yet.
:::

:::function{name="*key-reader*" path="reference/commands/*key-reader*.html"}
#### `*key-reader*`

A procedure set to receive the *next* keystroke instead of the keymap,
or `nil`. This is how a command such as cmd(describe-key) reads a key.
One-shot: cmd(handle-key) clears it before invoking the reader, so a
loop (isearch, query-replace, the quit walk) re-arms it each step.
:::

:::function{name="read-next-key" path="reference/commands/read-next-key.html"}
#### `read-next-key`
`(read-next-key callback)`

Route the next keystroke to `callback` rather than the keymap, by
setting `*key-reader*`. The mechanism behind cmd(describe-key),
cmd(zap-to-char), cmd(math-insert-symbol), and the incremental-search
and query-replace loops.
:::

:::function{name="reset-keymap!" path="reference/commands/reset-keymap!.html"}
#### `reset-keymap!`
`(reset-keymap!)`

Return dispatch to rest — set `active-keymap` to `nil` so the next key
resolves through the modes, and clear the chord-prefix echo
(`*chord-prefix*` plus the echo area).
:::

:::function{name="keymap-chain" path="reference/commands/keymap-chain.html"}
#### `keymap-chain`
`(keymap-chain)`

The keymaps to resolve a key through, highest precedence first: the
minor-mode keymaps, then the major-mode keymap, then `the-keymap`.
:::

:::function{name="lookup-in-chain" path="reference/commands/lookup-in-chain.html"}
#### `lookup-in-chain`
`(lookup-in-chain key maps)`

The first binding for `key` among the list `maps`, skipping `nil` maps.
Returns `nil` if none binds it.
:::

:::function{name="lookup-key" path="reference/commands/lookup-key.html"}
#### `lookup-key`
`(lookup-key key)`

Resolve `key` to a binding — through the active prefix-map *stack*
when mid-sequence (the first map in the stack that binds the key
wins), otherwise through the buffer's mode chain (cmd(keymap-chain)).
:::

:::function{name="self-insert-key?" path="reference/commands/self-insert-key%3F.html"}
#### `self-insert-key?`
`(self-insert-key? key)`

True when `key` is a single character — text to be inserted rather than
a command.
:::

:::function{name="chord-in-progress?" path="reference/commands/chord-in-progress%3F.html"}
#### `chord-in-progress?`
`(chord-in-progress?)`

True when a multi-key sequence is mid-flight or a key-reader is
pending — i.e. the next keystroke, even a plain character, should be
routed to the keymap rather than typed. A non-text input view (the
gnuplot prompt, say) consults this so the continuation of `C-x 3`
completes even though `3` carries no modifier.
:::

:::function{name="handle-key" path="reference/commands/handle-key.html"}
#### `handle-key`
`(handle-key key)`

Dispatch `key` — the entry point the host calls on every keystroke.
Returns `#t` when the key was handled. In order: a pending key-reader
receives the key; a prefix binding pushes onto the prefix-map stack
and echoes the running chord with a trailing dash; a command binding
resets the chord state, then runs the command — guarded by
cmd(command-registered?), so a binding whose command is missing
degrades to `NAME is not available here` — and clears the prefix
argument afterwards (unless the command *was*
cmd(universal-argument)); an unbound mid-sequence key resets quietly;
and at rest a single character self-inserts, setting `*last-command*`
to `self-insert` and then running the post-self-insert hook — the
electric seam.
:::

:::function{name="*post-self-insert-hook*" path="reference/commands/*post-self-insert-hook*.html"}
#### `*post-self-insert-hook*`

Procedures run *after* a self-inserting keystroke has been inserted,
each called with the inserted key string — Emacs's
`post-self-insert-hook`, the seam an "electric" behaviour hooks into.
Its first client is cmd(auto-fill-mode); the typographic quote
commands run it too, so an inserted quote behaves like a typed one.
Empty by default, so a self-insert costs nothing extra until something
registers. The hook is *global* while modes are per-buffer, so a
client registers once at load and guards its body on the buffer's own
mode membership.
:::

:::function{name="add-post-self-insert-hook" aliases="remove-post-self-insert-hook" path="reference/commands/add-post-self-insert-hook.html"}
#### `add-post-self-insert-hook` / `remove-post-self-insert-hook`
`(add-post-self-insert-hook fn)` / `(remove-post-self-insert-hook fn)`

Register / remove `fn` — a one-argument procedure, called with the
inserted key string — on the post-self-insert hook. Adding is
idempotent by identity.
:::

:::function{name="run-post-self-insert-hook" path="reference/commands/run-post-self-insert-hook.html"}
#### `run-post-self-insert-hook`
`(run-post-self-insert-hook key)`

Run every post-self-insert hook with `key`. Each call is wrapped so a
buggy hook can neither wedge typing nor crash the server — self-insert
is the one path that must never throw.
:::

### Modes

Defined in `modes.lisp`. A mode is a Lisp map. The common keys: a
display name (`:name`), an optional keymap (`:keymap` — usually a
symbol naming one, so edits are seen live), a comment prefix
(`:comment-prefix`) and a highlighter tag (`:highlight`). The rest:
`:priority` (minor-mode stacking order), `:indent-tabs?` and
`:tab-width` (§*Indentation*), `:fill-column` and
`:fill-indent-function` (§*Auto-fill*), and `:on-enable` /
`:on-disable` (single built-in hook procedures — see cmd(add-hook) for
the additive kind). See `docs/spec/modes.md`.

:::function{name="define-mode" path="reference/commands/define-mode.html"}
#### `define-mode`
`(define-mode name pair…)` — *macro*

Define a mode. Sugar for `define` over a map literal:
`(define-mode lisp-mode :name "Lisp" :highlight :lisp …)` binds
`lisp-mode` to `{:name "Lisp" :highlight :lisp …}`.
:::

:::function{name="lisp-mode-map" aliases="markdown-mode-map" path="reference/commands/lisp-mode-map.html"}
#### `lisp-mode-map`, `markdown-mode-map`, `latex-mode-map`, `makefile-mode-map`

Mode keymaps, declared empty in `modes.lisp` and filled in by feature
files (`markdown.lisp` fills `markdown-mode-map`, `latex.lisp` fills
`latex-mode-map`, `makefile.lisp` fills `makefile-mode-map`). A mode
names its keymap by symbol, so later edits to the map are seen live.
The tree-sitter languages under `languages/` declare their own maps in
their own drop-in files.
:::

:::function{name="register-mode" path="reference/commands/register-mode.html"}
#### `register-mode`
`(register-mode suffix mode)`

Associate a filename `suffix` with a major `mode`. Adds an entry to
`*mode-registry*`. Later registrations win, which is how `init.lisp`
can re-route a suffix — `(register-mode ".md" jmarkdown-mode)`.
:::

:::function{name="*mode-registry*" path="reference/commands/*mode-registry*.html"}
#### `*mode-registry*`

The list of `(suffix . mode)` pairs that maps filenames to major modes.
:::

:::function{name="registry-lookup" path="reference/commands/registry-lookup.html"}
#### `registry-lookup`
`(registry-lookup entries name)`

Find the mode for `name` among the registry `entries`, or
`fundamental-mode` if none matches. Internal helper for `mode-for-name`.
:::

:::function{name="mode-for-name" path="reference/commands/mode-for-name.html"}
#### `mode-for-name`
`(mode-for-name name)`

The major mode registered for a buffer `name`, by filename suffix.
:::

:::function{name="add-hook" aliases="remove-hook" path="reference/commands/add-hook.html"}
#### `add-hook` / `remove-hook`
`(add-hook mode thunk [:on-disable])` / `(remove-hook mode thunk [:on-disable])`

Register / remove `thunk` (a zero-argument procedure) to run when
`mode` is enabled — or disabled, with `:on-disable` as the optional
third argument. Emacs-style additive hooks: any number of independent
functions may hook the same mode, so the stdlib and your `init.lisp`
never clobber each other (unlike the mode's single built-in
`:on-enable` slot). `mode` is a mode object or its display name; hooks
are keyed by the name, so they survive a mode being redefined and may
be registered before the mode even loads. Hooks run in the order
added; re-adding the same procedure object is a no-op.
:::

:::function{name="run-mode-hook" path="reference/commands/run-mode-hook.html"}
#### `run-mode-hook`
`(run-mode-hook mode key)`

Run `mode`'s hooks for `key` — `:on-enable` or `:on-disable`: first
the mode's built-in single-slot procedure (from cmd(define-mode)),
then every function registered with cmd(add-hook), in registration
order. Safe on a `nil` mode.
:::

:::function{name="switch-major-mode" path="reference/commands/switch-major-mode.html"}
#### `switch-major-mode`
`(switch-major-mode mode)`

Make `mode` the current buffer's major mode, running the old mode's
`:on-disable` hooks and the new mode's `:on-enable` hooks.
:::

:::function{name="choose-major-mode!" path="reference/commands/choose-major-mode!.html"}
#### `choose-major-mode!`
`(choose-major-mode!)`

Set the current buffer's major mode from its name (cmd(mode-for-name)),
then activate the registered default text minor modes
(cmd(activate-default-minor-modes!)). The host calls this when a
buffer is created, opened, or renamed — and on every session-restore
re-mount.
:::

:::function{name="major-mode-name" path="reference/commands/major-mode-name.html"}
#### `major-mode-name`
`(major-mode-name)`

The display name of the current buffer's major mode — `"Fundamental"`
when there is none. Used by the modeline.
:::

:::function{name="resolve-keymap" path="reference/commands/resolve-keymap.html"}
#### `resolve-keymap`
`(resolve-keymap k)`

Resolve a mode's `:keymap` — a symbol naming a keymap, or a keymap
itself. Resolving by name keeps the keymap live-editable.
:::

:::function{name="major-mode-keymap" path="reference/commands/major-mode-keymap.html"}
#### `major-mode-keymap`
`(major-mode-keymap)`

The current buffer's major-mode keymap, or `nil`.
:::

:::function{name="major-mode-highlight" path="reference/commands/major-mode-highlight.html"}
#### `major-mode-highlight`
`(major-mode-highlight)`

The current buffer's major-mode `:highlight` tag, as a grammar-tag
string (`"jmarkdown"`, say) — `nil` when the mode declares none. The
source of truth for syntax highlighting: it follows the *major mode*,
not the filename, so a suffix re-registered to another mode (`.md` →
`jmarkdown-mode`) is highlighted by that mode.
:::

:::function{name="comment-prefix" path="reference/commands/comment-prefix.html"}
#### `comment-prefix`
`(comment-prefix)`

The comment prefix of the current buffer's major mode — `";; "` when
there is none. Used by cmd(comment-line).
:::

:::function{name="minor-modes" path="reference/commands/minor-modes.html"}
#### `minor-modes`
`(minor-modes)`

The current buffer's active minor modes, as a list (empty when none).
:::

:::function{name="mode-priority" path="reference/commands/mode-priority.html"}
#### `mode-priority`
`(mode-priority mode)`

A mode's `:priority` — default `0`. Higher-priority minor modes are
consulted first in the keymap chain.
:::

:::function{name="insert-by-priority" path="reference/commands/insert-by-priority.html"}
#### `insert-by-priority`
`(insert-by-priority mode modes)`

Insert `mode` into the list `modes`, keeping descending `:priority`
order. Internal helper for `enable-minor-mode`.
:::

:::function{name="without-item" path="reference/commands/without-item.html"}
#### `without-item`
`(without-item item lst)`

`lst` with the first `item` removed, compared by identity. Internal
helper for `disable-minor-mode`.
:::

:::function{name="enable-minor-mode" path="reference/commands/enable-minor-mode.html"}
#### `enable-minor-mode`
`(enable-minor-mode mode)`

Activate a minor `mode` in the current buffer, in priority order, and
run its `:on-enable` hooks. Idempotent — does nothing if already
active.
:::

:::function{name="disable-minor-mode" path="reference/commands/disable-minor-mode.html"}
#### `disable-minor-mode`
`(disable-minor-mode mode)`

Deactivate a minor `mode` in the current buffer and run its
`:on-disable` hooks.
:::

:::function{name="register-default-text-minor-mode" aliases="activate-default-minor-modes!" path="reference/commands/register-default-text-minor-mode.html"}
#### `register-default-text-minor-mode` / `activate-default-minor-modes!`
`(register-default-text-minor-mode mode)` / `(activate-default-minor-modes!)`

The default-on machinery: a feature registers its minor mode at load
time (bookmark-minor-mode does), and every text buffer gets the
registered modes enabled when it first receives its major mode — via
cmd(choose-major-mode!) — and again on session-restore re-mounts.
Activation is idempotent; non-text views never reach it.
:::

:::function{name="minor-mode-keymaps" path="reference/commands/minor-mode-keymaps.html"}
#### `minor-mode-keymaps`
`(minor-mode-keymaps)`

The keymaps of the active minor modes, highest priority first. Part of
the cmd(keymap-chain).
:::

:::function{name="join-minor-names" path="reference/commands/join-minor-names.html"}
#### `join-minor-names`
`(join-minor-names modes)`

Each mode's name in `modes`, two-space-prefixed and concatenated.
Internal helper for `minor-mode-line`.
:::

:::function{name="minor-mode-line" path="reference/commands/minor-mode-line.html"}
#### `minor-mode-line`
`(minor-mode-line)`

The active minor mode names, formatted for the modeline.
:::

### Sticky notes

A *sticky note* is a resizable rectangle overlaid on the buffer,
holding JMarkdown source whose rendered HTML is shown in the note.
Notes are anchored into the document and scroll with it; they persist
to the file's hidden `.<file>.godot-metadata` sidecar (a legacy
`<file>.jmacs-metadata` companion is still read as a fallback and
migrated on the next write). The source file is `sticky-notes.lisp`,
but in the running editor the commands are server-defined *directive
emitters*: each sends one directive to the focused window, whose
renderer owns the notes — their ids, offsets, editing and drawing —
and performs the whole operation. The commands are bound under the
`M-n` prefix, and the family also appears in `productivity.md`.

:::function{name="sticky-note-keymap" path="reference/commands/sticky-note-keymap.html"}
#### `sticky-note-keymap`

The `M-n` prefix map (defined in `keymap.lisp`): `n` add, `e` edit,
`d` delete, `f` / `b` next / previous, `t` toggle. Bound into
`the-keymap` under `"M-n"`.
:::

:::function{name="*markdown-interpreter*" path="reference/commands/markdown-interpreter.html"}
#### `*markdown-interpreter*`

The Markdown renderer for sticky notes and for live docstrings in the
documentation viewer. A defcustom; the default `"marked"` names the
bundled CommonMark+GFM library (`marked.js`), which requires no
external programs. Any other string is treated as a shell command that
reads Markdown on stdin and prints HTML on stdout — useful for a
richer dialect (JMarkdown, pandoc). Change it through the customize UI
or:

```lisp
(custom-apply! '*markdown-interpreter* "pandoc -f markdown -t html")
```

(A plain `set!` works for the session but bypasses persistence.) The
full entry lives in `help-and-config.md` with the rest of the
customization system.
:::

:::function{name="add-sticky-note" path="reference/commands/add-sticky-note.html"}
#### `add-sticky-note`
`(add-sticky-note)`

Create a sticky note at the cursor and open it for editing. Bound to
`M-n n`.
:::

:::function{name="edit-sticky-note" path="reference/commands/edit-sticky-note.html"}
#### `edit-sticky-note`
`(edit-sticky-note)`

Edit the sticky note nearest the cursor. Bound to `M-n e`.
:::

:::function{name="delete-sticky-note" path="reference/commands/delete-sticky-note.html"}
#### `delete-sticky-note`
`(delete-sticky-note)`

Delete the sticky note nearest the cursor. Bound to `M-n d`.
:::

:::function{name="next-sticky-note" aliases="previous-sticky-note" path="reference/commands/next-sticky-note.html"}
#### `next-sticky-note` / `previous-sticky-note`
`(next-sticky-note)` / `(previous-sticky-note)`

Move the cursor to the next / previous sticky note in the buffer, by
anchor order. Bound to `M-n f` / `M-n b`.
:::

:::function{name="toggle-sticky-notes" path="reference/commands/toggle-sticky-notes.html"}
#### `toggle-sticky-notes`
`(toggle-sticky-notes)`

Show or hide every sticky note in the buffer. Bound to `M-n t`.
:::

### Preview

Live preview of Markdown and of typeset mathematics. Each renders the
buffer through the same pipeline used elsewhere and refreshes as you
edit. The commands are defined in `markdown.lisp` (the general
math-preview engine in `math-preview.lisp`).

:::function{name="markdown-preview" path="reference/commands/markdown-preview.html"}
#### `markdown-preview`
`(markdown-preview)`

Toggle the live Markdown preview pane. It renders the current
`markdown-mode` buffer to HTML through the JMarkdown pipeline and
refreshes on a typing pause *without saving* — the buffer is mirrored
to a hidden shadow file the preview server watches (see
`*markdown-preview-debounce-ms*`). Bound to `C-c v` in Markdown mode.
:::

:::function{name="markdown-preview-sync" path="reference/commands/markdown-preview-sync.html"}
#### `markdown-preview-sync`
`(markdown-preview-sync)`

Scroll the live preview to the cursor's location and flash the spot —
an explicit forward search, independent of
`*markdown-preview-follow-cursor*` (which scrolls silently, no flash).
Bound to `C-c C-v` in Markdown mode.
:::

:::function{name="*markdown-preview-css*" path="reference/commands/*markdown-preview-css*.html"}
#### `*markdown-preview-css*`

A list of stylesheet file paths the preview iframe links — your book's
CSS, say. Absolute and `~` paths are served as-is; a relative path
resolves against the previewed file's directory. The preview renders
into an isolated iframe, so its CSS neither affects nor is affected by
the editor chrome. Set it in `init.lisp`:

```lisp
(set! *markdown-preview-css* (list "~/book/style.css"))
```
:::

:::function{name="*markdown-preview-default-style*" path="reference/commands/*markdown-preview-default-style*.html"}
#### `*markdown-preview-default-style*`

Whether the preview iframe links the built-in stylesheet. A defcustom;
default `#t`. Turn it off to let your own `*markdown-preview-css*`
fully own the look.
:::

:::function{name="*markdown-preview-follow-cursor*" path="reference/commands/*markdown-preview-follow-cursor*.html"}
#### `*markdown-preview-follow-cursor*`

Whether the open preview scrolls to follow the editor cursor as you
move (forward search). A defcustom; default `#t`. Off keeps the
preview still; Command-click inverse search — jumping the source to a
clicked spot in the preview — works either way.
:::

:::function{name="*markdown-preview-debounce-ms*" path="reference/commands/*markdown-preview-debounce-ms*.html"}
#### `*markdown-preview-debounce-ms*`

Milliseconds to wait after the last edit before refreshing the open
preview (the save-free update). A defcustom; default `400`. Lower
feels more live but rebuilds more often; higher is calmer.
:::

:::function{name="toggle-math-preview" path="reference/commands/toggle-math-preview.html"}
#### `toggle-math-preview`
`(toggle-math-preview)`

Toggle live inline MathJax typesetting for the current buffer. Works in
any major mode that has a math provider (LaTeX, Markdown, …): math
segments render typeset in place of their source and flip back to
source for editing when point enters them. Run with `M-x`. See also
cmd(toggle-markdown-math-preview).
:::

:::function{name="toggle-markdown-math-preview" path="reference/commands/toggle-markdown-math-preview.html"}
#### `toggle-markdown-math-preview`
`(toggle-markdown-math-preview)`

Toggle live inline MathJax typesetting for the current Markdown buffer
— a Markdown-mode convenience wrapper over cmd(toggle-math-preview).
The buffer is scanned with the common math config: `$…$`, `$$…$$`,
`\(…\)`, `\[…\]` — but not `\begin…\end` environments, which are not
display math in prose. Bound to `C-c C-p` in Markdown mode.
:::

:::function{name="*markdown-math-preview-default*" path="reference/commands/*markdown-math-preview-default*.html"}
#### `*markdown-math-preview-default*`

When `#t`, Markdown buffers typeset math inline automatically. A
defcustom; default `#f` — opt in per buffer with
cmd(toggle-markdown-math-preview), or set this in your init or
customisation to default it on.
:::
