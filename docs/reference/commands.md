Title: jmacs Command Reference
Author: J. McKenzie Alexander
Date: 2026-05-22
---

# jmacs Command Reference

This document describes every procedure in the jmacs standard library —
`packages/stdlib/lisp/*.lisp`. These are the editor's commands and the
machinery that dispatches them: ordinary Lisp, built on the buffer
primitives (`buffer-primitives.jmd`) and the core language
(`lisp-core.jmd`).

Entries are grouped by task. A *command* — a procedure of no arguments,
runnable by name with `M-x` and usually bound to a key — is the common
case; this file also documents the dispatch, palette and mode
machinery that the commands rely on. See `index.jmd` for how to read an
entry and what the conventions mean.

Key bindings are given in the manual's notation: `C-` is Control or
Command, `M-` is Option, `S-` is Shift.

---

## Cursor movement

Defined in `editing.lisp`. Each is a thin command over a buffer
primitive; the command is the layer the keymap binds and the layer you
redefine.

:::function{name="forward-char" path="reference/commands/forward-char.html"}
### `forward-char`
`(forward-char)`

Move the cursor one character to the right. Bound to `→` and `C-f`.
Cousin of cmd(backward-char).
:::

:::function{name="backward-char" path="reference/commands/backward-char.html"}
### `backward-char`
`(backward-char)`

Move the cursor one character to the left. Bound to `←` and `C-b`.
:::

:::function{name="next-line" path="reference/commands/next-line.html"}
### `next-line`
`(next-line)`

Move the cursor down one line. Bound to `↓` and `C-n`.
:::

:::function{name="previous-line" path="reference/commands/previous-line.html"}
### `previous-line`
`(previous-line)`

Move the cursor up one line. Bound to `↑` and `C-p`.
:::

:::function{name="move-beginning-of-line" path="reference/commands/move-beginning-of-line.html"}
### `move-beginning-of-line`
`(move-beginning-of-line)`

Move the cursor to the start of the current line. Bound to `Home`,
`C-a` and `C-←`.
:::

:::function{name="move-end-of-line" path="reference/commands/move-end-of-line.html"}
### `move-end-of-line`
`(move-end-of-line)`

Move the cursor to the end of the current line. Bound to `End`, `C-e`
and `C-→`.
:::

:::function{name="beginning-of-buffer" path="reference/commands/beginning-of-buffer.html"}
### `beginning-of-buffer`
`(beginning-of-buffer)`

Move the cursor to the start of the buffer. Bound to `C-↑` and `M-<`.
:::

:::function{name="end-of-buffer" path="reference/commands/end-of-buffer.html"}
### `end-of-buffer`
`(end-of-buffer)`

Move the cursor to the end of the buffer. Bound to `C-↓` and `M->`.
:::

:::function{name="forward-word" path="reference/commands/forward-word.html"}
### `forward-word`
`(forward-word)`

Move forward to the end of the next word. Bound to `M-f`. A *word* is a
run of word characters, as decided by the `word-forward-offset`
primitive.
:::

:::function{name="backward-word" path="reference/commands/backward-word.html"}
### `backward-word`
`(backward-word)`

Move backward to the start of the previous word. Bound to `M-b`.
:::

:::function{name="forward-sentence" path="reference/commands/forward-sentence.html"}
### `forward-sentence`
`(forward-sentence)`

Move forward to the end of the sentence. Bound to `M-e`. A sentence
ends at `.`, `!` or `?` followed by whitespace or the buffer's end.
:::

:::function{name="backward-sentence" path="reference/commands/backward-sentence.html"}
### `backward-sentence`
`(backward-sentence)`

Move backward to the start of the sentence. Bound to `M-a`.
:::

:::function{name="back-to-indentation" path="reference/commands/back-to-indentation.html"}
### `back-to-indentation`
`(back-to-indentation)`

Move the cursor to the first non-blank character of the line. Bound to
`M-m`. Computed as the line start plus the length of the line's
leading indentation.
:::

:::function{name="goto-line" path="reference/commands/goto-line.html"}
### `goto-line`
`(goto-line)`

Prompt for a line number and move the cursor to that line. Bound to
`M-g`. The prompt runs in the minibuffer (host code).
:::

:::function{name="recenter" path="reference/commands/recenter.html"}
### `recenter`
`(recenter)`

Scroll so the cursor's line is centred in the viewport. Bound to `C-l`.
:::

:::function{name="scroll-up" path="reference/commands/scroll-up.html"}
### `scroll-up`
`(scroll-up)`

Move the cursor forward by roughly one screenful. Bound to `C-v`.
Implemented as `page-lines` repetitions of `cursor-down!`.
:::

:::function{name="scroll-down" path="reference/commands/scroll-down.html"}
### `scroll-down`
`(scroll-down)`

Move the cursor backward by roughly one screenful. Bound to `M-v`.
:::

## Movement that extends the selection

Defined in `editing.lisp`. These pass `#t` to their buffer primitive,
which extends the selection as it moves (the Shift-select forms). They
exist as separate commands so the keymap can bind the shifted keys.

:::function{name="forward-char-extending" path="reference/commands/forward-char-extending.html"}
### `forward-char-extending`
`(forward-char-extending)`

Move one character right, extending the selection. Bound to `S-→` and
`C-S-f`.
:::

:::function{name="backward-char-extending" path="reference/commands/backward-char-extending.html"}
### `backward-char-extending`
`(backward-char-extending)`

Move one character left, extending the selection. Bound to `S-←` and
`C-S-b`.
:::

:::function{name="next-line-extending" path="reference/commands/next-line-extending.html"}
### `next-line-extending`
`(next-line-extending)`

Move down one line, extending the selection. Bound to `S-↓` and
`C-S-n`.
:::

:::function{name="previous-line-extending" path="reference/commands/previous-line-extending.html"}
### `previous-line-extending`
`(previous-line-extending)`

Move up one line, extending the selection. Bound to `S-↑` and `C-S-p`.
:::

:::function{name="beginning-of-line-extending" path="reference/commands/beginning-of-line-extending.html"}
### `beginning-of-line-extending`
`(beginning-of-line-extending)`

Move to the line start, extending the selection. Bound to `S-Home` and
`C-S-a`.
:::

:::function{name="end-of-line-extending" path="reference/commands/end-of-line-extending.html"}
### `end-of-line-extending`
`(end-of-line-extending)`

Move to the line end, extending the selection. Bound to `S-End` and
`C-S-e`.
:::

## The mark and the region

The *mark* is the selection anchor; the *region* is the text between
mark and point. Once the mark is set, ordinary movement extends the
region until it is cleared. See the manual §4.2.

:::function{name="set-mark-command" path="reference/commands/set-mark-command.html"}
### `set-mark-command`
`(set-mark-command)`

Set the mark at the cursor, starting a region. Bound to `C-SPC`. While
the mark is set, cursor movement extends the region; `C-g` clears it.
Defined in `editing.lisp`.
:::

:::function{name="mark-whole-buffer" path="reference/commands/mark-whole-buffer.html"}
### `mark-whole-buffer`
`(mark-whole-buffer)`

Select the entire buffer — move point to the end and set the mark at
the start. Bound to `C-x h`. Defined in `editing.lisp`.
:::

:::function{name="exchange-point-and-mark" path="reference/commands/exchange-point-and-mark.html"}
### `exchange-point-and-mark`
`(exchange-point-and-mark)`

Move point to the mark and the mark to where point was. Bound to
`C-x C-x`. Does nothing if the mark is not set. Defined in
`editing.lisp`.
:::

:::function{name="keyboard-quit" path="reference/commands/keyboard-quit.html"}
### `keyboard-quit`
`(keyboard-quit)`

Abort a partial key sequence and clear the selection. Bound to `C-g`.
Resets the active prefix keymap and clears the mark. Defined in
`keymap.lisp`.
:::

## Editing text

Defined in `editing.lisp`.

:::function{name="delete-backward" path="reference/commands/delete-backward.html"}
### `delete-backward`
`(delete-backward)`

Delete the character before the cursor, or the selection if one is
active. Bound to `Backspace`.
:::

:::function{name="delete-forward" path="reference/commands/delete-forward.html"}
### `delete-forward`
`(delete-forward)`

Delete the character after the cursor, or the selection if one is
active. Bound to `Delete` and `C-d`.
:::

:::function{name="transpose-chars" path="reference/commands/transpose-chars.html"}
### `transpose-chars`
`(transpose-chars)`

Swap the two characters before the cursor. Bound to `C-t`. Does nothing
when the cursor is within the first two characters of the buffer.
:::

:::function{name="newline" path="reference/commands/newline.html"}
### `newline`
`(newline)`

Insert a line break, copying the current line's leading indentation
onto the new line. Bound to `Enter` and `C-j`.
:::

:::function{name="open-line" path="reference/commands/open-line.html"}
### `open-line`
`(open-line)`

Insert a newline after the cursor, leaving the cursor before it — opens
a blank line below without descending onto it. Bound to `C-o`.
:::

:::function{name="insert-tab" path="reference/commands/insert-tab.html"}
### `insert-tab`
`(insert-tab)`

Insert two spaces at the cursor. Bound to `Tab`. jmacs indents with
spaces.
:::

:::function{name="fill-paragraph" path="reference/commands/fill-paragraph.html"}
### `fill-paragraph`
`(fill-paragraph)`

Re-wrap the paragraph around the cursor to the fill column (72), keeping
the paragraph's indentation. Bound to `M-q`. The paragraph is the run
of non-blank lines around the cursor; does nothing on a blank line.
:::

:::function{name="comment-line" path="reference/commands/comment-line.html"}
### `comment-line`
`(comment-line)`

Comment or uncomment the current line. Bound to `C-x ;`. Uses the
comment prefix of the buffer's major mode (`comment-prefix`); toggles —
adds the prefix if absent, removes it if present.
:::

:::function{name="replace-string" path="reference/commands/replace-string.html"}
### `replace-string`
`(replace-string)`

Prompt for a string and a replacement, then replace every occurrence.
Bound to `M-r`. The prompt runs in the minibuffer (host code).
:::

## Undo

Defined in `editing.lisp`. Undo is currently per-edit — one keystroke is
one undoable step.

:::function{name="undo" path="reference/commands/undo.html"}
### `undo`
`(undo)`

Undo the last change. Bound to `C-z`.
:::

:::function{name="redo" path="reference/commands/redo.html"}
### `redo`
`(redo)`

Redo the last undone change. Bound to `C-S-z`.
:::

## The kill ring

Defined in `kill.lisp`. Killed text — cut or copied — is pushed onto the
*kill ring*, a list of recent kills held in the variable `*kill-ring*`,
and yanked back from it. See the manual §4.5.

:::function{name="*kill-ring*" path="reference/commands/*kill-ring*.html"}
### `*kill-ring*`

The kill ring itself: a list of killed strings, most recent first.
Ordinary Lisp state — inspect or rebind it like any variable.
:::

:::function{name="kill-ring-add!" path="reference/commands/kill-ring-add!.html"}
### `kill-ring-add!`
`(kill-ring-add! text)`

Push `text` onto the kill ring. The mutating primitive the kill
commands are built on.
:::

:::function{name="kill-ring-top" path="reference/commands/kill-ring-top.html"}
### `kill-ring-top`
`(kill-ring-top)`

The most recent kill, or an empty string when the ring is empty.
:::

:::function{name="copy-region" path="reference/commands/copy-region.html"}
### `copy-region`
`(copy-region)`

Copy the selected text to the kill ring and clear the mark. Bound to
`M-w`. Does nothing when no region is active.
:::

:::function{name="kill-region" path="reference/commands/kill-region.html"}
### `kill-region`
`(kill-region)`

Cut the selected text to the kill ring. Bound to `C-w`. Does nothing
when no region is active.
:::

:::function{name="kill-line" path="reference/commands/kill-line.html"}
### `kill-line`
`(kill-line)`

Kill from the cursor to the end of the line; at a line's end, kill the
newline instead. Bound to `C-k`.
:::

:::function{name="kill-word" path="reference/commands/kill-word.html"}
### `kill-word`
`(kill-word)`

Kill forward to the end of the next word. Bound to `M-d`.
:::

:::function{name="kill-sentence" path="reference/commands/kill-sentence.html"}
### `kill-sentence`
`(kill-sentence)`

Kill forward to the end of the sentence. Bound to `M-k`.
:::

:::function{name="backward-kill-word" path="reference/commands/backward-kill-word.html"}
### `backward-kill-word`
`(backward-kill-word)`

Kill backward to the start of the previous word. Bound to `M-Backspace`.
:::

:::function{name="yank" path="reference/commands/yank.html"}
### `yank`
`(yank)`

Insert the most recent kill at the cursor. Bound to `C-y`.
:::

## Files

Defined in `files.lisp`. These wrap host primitives; the file dialog
and the filesystem work happen in the Electron main process, reached
over IPC.

:::function{name="find-file" path="reference/commands/find-file.html"}
### `find-file`
`(find-file)`

Open a file, replacing the current buffer's contents. Bound to
`C-x C-f`.
:::

:::function{name="save-buffer" path="reference/commands/save-buffer.html"}
### `save-buffer`
`(save-buffer)`

Save the current buffer to its file. Bound to `C-x C-s`.
:::

## Buffers

Defined in `buffers.lisp`. The editor holds a list of buffers with one
current; these commands change which is current and re-point the view.

:::function{name="next-buffer" path="reference/commands/next-buffer.html"}
### `next-buffer`
`(next-buffer)`

Switch to the next buffer in the list. Bound to `C-x →`.
:::

:::function{name="previous-buffer" path="reference/commands/previous-buffer.html"}
### `previous-buffer`
`(previous-buffer)`

Switch to the previous buffer in the list. Bound to `C-x ←`.
:::

:::function{name="new-buffer" path="reference/commands/new-buffer.html"}
### `new-buffer`
`(new-buffer)`

Create a fresh empty buffer and switch to it. Bound to `C-x n`.
:::

:::function{name="switch-buffer" path="reference/commands/switch-buffer.html"}
### `switch-buffer`
`(switch-buffer)`

Switch to a buffer chosen by name, with completion. Bound to `C-x b`.
The chooser runs in the minibuffer (host code).
:::

## Search and replace

Defined in `search.lisp`. The interactive search loop runs in the
minibuffer (host code); these commands start it.

:::function{name="isearch-forward" path="reference/commands/isearch-forward.html"}
### `isearch-forward`
`(isearch-forward)`

Begin an incremental forward search in the current buffer. Bound to
`C-s`.
:::

:::function{name="isearch-backward" path="reference/commands/isearch-backward.html"}
### `isearch-backward`
`(isearch-backward)`

Begin an incremental backward search in the current buffer. Bound to
`C-r`.
:::

## The command palette

Defined in `palette.lisp`. The palette — `M-x` — offers every command
reachable from the keymap. It is loaded after `keymap.lisp` so it can
read `the-keymap`.

:::function{name="execute-command" path="reference/commands/execute-command.html"}
### `execute-command`
`(execute-command)`

Prompt for a command by name and run it — the `M-x` command. Bound to
`M-x`. The interactive matching loop runs in the minibuffer.
:::

:::function{name="command-names" path="reference/commands/command-names.html"}
### `command-names`
`(command-names)`

A list of every command name reachable from the keymap, as strings.
This is the set the palette offers.
:::

:::function{name="-keymap-commands" path="reference/commands/-keymap-commands.html"}
### `-keymap-commands`
`(-keymap-commands keymap)`

Collect command names from `keymap` and any nested keymaps, recursively.
An internal helper for `command-names` (the leading `-` marks it
internal).
:::

## Help — the editor describes itself

Defined in `help.lisp`. Every command keeps its docstring; these
commands surface it. Their output goes to the REPL.

:::function{name="describe-key" path="reference/commands/describe-key.html"}
### `describe-key`
`(describe-key)`

Describe the command bound to the next key pressed. Bound to `C-h k`.
Reads one keystroke, then reports whether the key is unbound, is a
prefix, or runs a command — and for a command, prints its docstring.
:::

:::function{name="describe-command" path="reference/commands/describe-command.html"}
### `describe-command`
`(describe-command)`

Prompt for a command by name and show its documentation. Bound to
`C-h f`. The prompt runs in the minibuffer (host code).
:::

:::function{name="describe-named-command" path="reference/commands/describe-named-command.html"}
### `describe-named-command`
`(describe-named-command name)`

Print the documentation of the command called `name` (a string).
Resolves the name to a symbol, evaluates it, and prints its docstring —
or `(no documentation)` if it has none. The non-interactive core that
`describe-command` is built around.
:::

## Editor commands

Defined in `system.lisp`.

:::function{name="reload-stdlib" path="reference/commands/reload-stdlib.html"}
### `reload-stdlib`
`(reload-stdlib)`

Re-evaluate the standard library, picking up any edits to it. Bound to
`C-x C-r`. Because commands are bound by name and resolved late, the
running editor switches to the new definitions at once — hot reload.
:::

:::function{name="quit-editor" path="reference/commands/quit-editor.html"}
### `quit-editor`
`(quit-editor)`

Quit the editor. Bound to `C-x C-c`.
:::

## Markdown writing commands

Defined in `markdown.lisp`, loaded after `modes.lisp` and `keymap.lisp`.
They emit *JMarkdown* syntax and are bound under the `C-c` prefix of
`markdown-mode` (§*The markdown-mode keymap* below), so they are active
only in a Markdown buffer.

:::function{name="surround" path="reference/commands/surround.html"}
### `surround`
`(surround opener closer)`

Wrap the selection in `opener` and `closer`; with no selection, insert
the pair and place the cursor between them. The helper the inline
formatting commands are built on.
:::

:::function{name="insert-at-line-start" path="reference/commands/insert-at-line-start.html"}
### `insert-at-line-start`
`(insert-at-line-start text)`

Insert `text` at the start of the current line, leaving the cursor in
its original position relative to the text. The helper the block
commands are built on.
:::

:::function{name="markdown-bold" path="reference/commands/markdown-bold.html"}
### `markdown-bold`
`(markdown-bold)`

Make the selection strong — JMarkdown `*…*`. Bound to `C-c b`.
:::

:::function{name="markdown-italic" path="reference/commands/markdown-italic.html"}
### `markdown-italic`
`(markdown-italic)`

Make the selection emphasised — JMarkdown `/…/`. Bound to `C-c i`.
:::

:::function{name="markdown-code" path="reference/commands/markdown-code.html"}
### `markdown-code`
`(markdown-code)`

Make the selection inline code — `` `…` ``. Bound to `C-c c`.
:::

:::function{name="markdown-highlight" path="reference/commands/markdown-highlight.html"}
### `markdown-highlight`
`(markdown-highlight)`

Highlight the selection — JMarkdown `==…==`. Bound to `C-c h`.
:::

:::function{name="markdown-insert-link" path="reference/commands/markdown-insert-link.html"}
### `markdown-insert-link`
`(markdown-insert-link)`

Insert a link, wrapping the selection as the link text and leaving the
cursor in the URL slot. Bound to `C-c l`.
:::

:::function{name="markdown-insert-cite" path="reference/commands/markdown-insert-cite.html"}
### `markdown-insert-cite`
`(markdown-insert-cite)`

Insert a JMarkdown `\cite{}` citation, cursor inside the braces. Bound
to `C-c k`.
:::

:::function{name="markdown-insert-footnote" path="reference/commands/markdown-insert-footnote.html"}
### `markdown-insert-footnote`
`(markdown-insert-footnote)`

Insert a JMarkdown footnote `[^: ]`, cursor in the body. Bound to
`C-c f`.
:::

:::function{name="markdown-heading-1" aliases="markdown-heading-6" path="reference/commands/markdown-heading-1.html"}
### `markdown-heading-1` … `markdown-heading-6`
`(markdown-heading-1)` … `(markdown-heading-6)`

Make the current line a heading of the given level — prepend `#`,
`##`, … `######`. Bound to `C-c 1` through `C-c 6`.
:::

:::function{name="markdown-blockquote" path="reference/commands/markdown-blockquote.html"}
### `markdown-blockquote`
`(markdown-blockquote)`

Make the current line a blockquote — prepend `> `. Bound to `C-c q`.
:::

:::function{name="markdown-list-item" path="reference/commands/markdown-list-item.html"}
### `markdown-list-item`
`(markdown-list-item)`

Make the current line a list item — prepend `- `. Bound to `C-c -`.
:::

## The math minor mode

Defined in `markdown.lisp`. An AUCTeX-style minor mode: with it on, a
backtick followed by a key inserts a LaTeX math symbol.

:::function{name="math-insert-symbol" path="reference/commands/math-insert-symbol.html"}
### `math-insert-symbol`
`(math-insert-symbol)`

Read a key and insert the LaTeX math symbol it names; an unmapped key
is inserted as itself (so `` ` `` then `` ` `` gives a literal
backtick). Bound to `` ` `` in `math-mode-map`. Looks the key up in
`*math-symbols*`.
:::

:::function{name="toggle-math-mode" path="reference/commands/toggle-math-mode.html"}
### `toggle-math-mode`
`(toggle-math-mode)`

Toggle the math symbol-insertion minor mode in the current buffer.
Bound to `C-c m` in `markdown-mode`.
:::

:::function{name="*math-symbols*" path="reference/commands/*math-symbols*.html"}
### `*math-symbols*`

The map from a key to a LaTeX symbol string used by `math-insert-symbol`
— `"a"` → `"\alpha"`, `"8"` → `"\infty"`, and so on. Edit it to change
or extend the symbol set.
:::

## Key dispatch

Defined in `keymap.lisp`. A *keymap* maps a key string to either a
command name (a symbol) or a nested keymap (a prefix). The renderer
reports each keystroke as a normalised string; `handle-key` dispatches
it. See the manual §5 and `docs/spec/modes.md` §6.

:::function{name="the-keymap" path="reference/commands/the-keymap.html"}
### `the-keymap`

The root keymap — the global key bindings. A buffer's mode keymaps are
consulted ahead of it (`keymap-chain`).
:::

:::function{name="c-x-keymap" aliases="c-h-keymap" path="reference/commands/c-x-keymap.html"}
### `c-x-keymap`, `c-h-keymap`

The nested keymaps reached through the `C-x` and `C-h` prefixes. Bound
into `the-keymap` under `"C-x"` and `"C-h"`.
:::

:::function{name="active-keymap" path="reference/commands/active-keymap.html"}
### `active-keymap`

While a key sequence is in progress, holds the prefix keymap the next
keystroke is looked up in; `nil` at rest, meaning the next key is
resolved through the buffer's mode chain.
:::

:::function{name="*key-reader*" path="reference/commands/*key-reader*.html"}
### `*key-reader*`

A procedure set to receive the *next* keystroke instead of the keymap,
or `nil`. This is how a command such as `describe-key` reads a key.
:::

:::function{name="reset-keymap!" path="reference/commands/reset-keymap!.html"}
### `reset-keymap!`
`(reset-keymap!)`

Return dispatch to rest — set `active-keymap` to `nil` so the next key
resolves through the modes.
:::

:::function{name="keymap-chain" path="reference/commands/keymap-chain.html"}
### `keymap-chain`
`(keymap-chain)`

The keymaps to resolve a key through, highest precedence first: the
minor-mode keymaps, then the major-mode keymap, then `the-keymap`.
:::

:::function{name="lookup-in-chain" path="reference/commands/lookup-in-chain.html"}
### `lookup-in-chain`
`(lookup-in-chain key maps)`

The first binding for `key` among the list `maps`, skipping `nil` maps.
Returns `nil` if none binds it.
:::

:::function{name="lookup-key" path="reference/commands/lookup-key.html"}
### `lookup-key`
`(lookup-key key)`

Resolve `key` to a binding — through the active prefix map when
mid-sequence, otherwise through the buffer's mode chain
(`keymap-chain`).
:::

:::function{name="self-insert-key?" path="reference/commands/self-insert-key%3F.html"}
### `self-insert-key?`
`(self-insert-key? key)`

True when `key` is a single character — text to be inserted rather than
a command.
:::

:::function{name="read-next-key" path="reference/commands/read-next-key.html"}
### `read-next-key`
`(read-next-key callback)`

Route the next keystroke to `callback` rather than the keymap, by
setting `*key-reader*`. The mechanism behind `describe-key` and
`math-insert-symbol`.
:::

:::function{name="handle-key" path="reference/commands/handle-key.html"}
### `handle-key`
`(handle-key key)`

Dispatch `key` — the entry point the host calls on every keystroke. If a
key-reader is pending, it receives the key; otherwise `key` runs a
command, begins a key sequence, or self-inserts. Returns `#t` when the
key was handled.
:::

## Modes

Defined in `modes.lisp`. A mode is a Lisp map carrying a display name,
an optional keymap, a comment prefix and a highlighter hint. See
`docs/spec/modes.md`.

:::function{name="define-mode" path="reference/commands/define-mode.html"}
### `define-mode`
`(define-mode name pair…)` — *macro*

Define a mode. Sugar for `define` over a map literal:
`(define-mode lisp-mode :name "Lisp" :highlight :lisp …)` binds
`lisp-mode` to `{:name "Lisp" :highlight :lisp …}`.
:::

:::function{name="lisp-mode-map" aliases="markdown-mode-map" path="reference/commands/lisp-mode-map.html"}
### `lisp-mode-map`, `markdown-mode-map`

Mode keymaps, declared empty in `modes.lisp` and filled in by feature
files (`markdown.lisp` fills `markdown-mode-map`). A mode names its
keymap by symbol, so later edits to the map are seen live.
:::

:::function{name="register-mode" path="reference/commands/register-mode.html"}
### `register-mode`
`(register-mode suffix mode)`

Associate a filename `suffix` with a major `mode`. Adds an entry to
`*mode-registry*`.
:::

:::function{name="*mode-registry*" path="reference/commands/*mode-registry*.html"}
### `*mode-registry*`

The list of `(suffix . mode)` pairs that maps filenames to major modes.
:::

:::function{name="registry-lookup" path="reference/commands/registry-lookup.html"}
### `registry-lookup`
`(registry-lookup entries name)`

Find the mode for `name` among the registry `entries`, or
`fundamental-mode` if none matches. Internal helper for `mode-for-name`.
:::

:::function{name="mode-for-name" path="reference/commands/mode-for-name.html"}
### `mode-for-name`
`(mode-for-name name)`

The major mode registered for a buffer `name`, by filename suffix.
:::

:::function{name="run-mode-hook" path="reference/commands/run-mode-hook.html"}
### `run-mode-hook`
`(run-mode-hook mode key)`

Run `mode`'s hook stored under `key` — `:on-enable` or `:on-disable` — a
procedure, if it has one. Safe on a `nil` mode.
:::

:::function{name="switch-major-mode" path="reference/commands/switch-major-mode.html"}
### `switch-major-mode`
`(switch-major-mode mode)`

Make `mode` the current buffer's major mode, running the old mode's
`:on-disable` hook and the new mode's `:on-enable` hook.
:::

:::function{name="choose-major-mode!" path="reference/commands/choose-major-mode!.html"}
### `choose-major-mode!`
`(choose-major-mode!)`

Set the current buffer's major mode from its name (`mode-for-name`). The
host calls this when a buffer is created, opened, or renamed.
:::

:::function{name="major-mode-name" path="reference/commands/major-mode-name.html"}
### `major-mode-name`
`(major-mode-name)`

The display name of the current buffer's major mode — `"Fundamental"`
when there is none. Used by the modeline.
:::

:::function{name="resolve-keymap" path="reference/commands/resolve-keymap.html"}
### `resolve-keymap`
`(resolve-keymap k)`

Resolve a mode's `:keymap` — a symbol naming a keymap, or a keymap
itself. Resolving by name keeps the keymap live-editable.
:::

:::function{name="major-mode-keymap" path="reference/commands/major-mode-keymap.html"}
### `major-mode-keymap`
`(major-mode-keymap)`

The current buffer's major-mode keymap, or `nil`.
:::

:::function{name="comment-prefix" path="reference/commands/comment-prefix.html"}
### `comment-prefix`
`(comment-prefix)`

The comment prefix of the current buffer's major mode — `";; "` when
there is none. Used by `comment-line`.
:::

:::function{name="minor-modes" path="reference/commands/minor-modes.html"}
### `minor-modes`
`(minor-modes)`

The current buffer's active minor modes, as a list (empty when none).
:::

:::function{name="mode-priority" path="reference/commands/mode-priority.html"}
### `mode-priority`
`(mode-priority mode)`

A mode's `:priority` — default `0`. Higher-priority minor modes are
consulted first in the keymap chain.
:::

:::function{name="insert-by-priority" path="reference/commands/insert-by-priority.html"}
### `insert-by-priority`
`(insert-by-priority mode modes)`

Insert `mode` into the list `modes`, keeping descending `:priority`
order. Internal helper for `enable-minor-mode`.
:::

:::function{name="without-item" path="reference/commands/without-item.html"}
### `without-item`
`(without-item item lst)`

`lst` with the first `item` removed, compared by identity. Internal
helper for `disable-minor-mode`.
:::

:::function{name="enable-minor-mode" path="reference/commands/enable-minor-mode.html"}
### `enable-minor-mode`
`(enable-minor-mode mode)`

Activate a minor `mode` in the current buffer, in priority order, and
run its `:on-enable` hook. Idempotent — does nothing if already active.
:::

:::function{name="disable-minor-mode" path="reference/commands/disable-minor-mode.html"}
### `disable-minor-mode`
`(disable-minor-mode mode)`

Deactivate a minor `mode` in the current buffer and run its
`:on-disable` hook.
:::

:::function{name="minor-mode-keymaps" path="reference/commands/minor-mode-keymaps.html"}
### `minor-mode-keymaps`
`(minor-mode-keymaps)`

The keymaps of the active minor modes, highest priority first. Part of
the `keymap-chain`.
:::

:::function{name="join-minor-names" path="reference/commands/join-minor-names.html"}
### `join-minor-names`
`(join-minor-names modes)`

Each mode's name in `modes`, two-space-prefixed and concatenated.
Internal helper for `minor-mode-line`.
:::

:::function{name="minor-mode-line" path="reference/commands/minor-mode-line.html"}
### `minor-mode-line`
`(minor-mode-line)`

The active minor mode names, formatted for the modeline.
:::

## Sticky notes

Defined in `sticky-notes.lisp`. A *sticky note* is a resizable
rectangle overlaid on the buffer, holding JMarkdown source whose
rendered HTML is shown in the note. Notes are anchored into the
document and scroll with it; they persist to a companion
`<file>.jmacs-metadata` file. The notes themselves are managed by host
primitives (`note-create!`, … — see `buffer-primitives.jmd`); these
commands are the keyboard surface, bound under the `M-n` prefix.

:::function{name="sticky-note-keymap" path="reference/commands/sticky-note-keymap.html"}
### `sticky-note-keymap`

The `M-n` prefix map (defined in `keymap.lisp`): `n` add, `e` edit,
`d` delete, `f` / `b` next / previous, `t` toggle. Bound into
`the-keymap` under `"M-n"`.
:::

:::function{name="*jmarkdown-command*" path="reference/commands/*jmarkdown-command*.html"}
### `*jmarkdown-command*`

An optional override for the shell command that renders a note's
JMarkdown source to HTML — jmacs runs the command, feeds the note's
source on stdin, and shows whatever HTML it prints. `nil` (the default)
uses the editor's built-in default, `multimarkdown -s`. Set it to
choose another processor:

```lisp
(set! *jmarkdown-command* "pandoc -f markdown -t html")
```
:::

:::function{name="add-sticky-note" path="reference/commands/add-sticky-note.html"}
### `add-sticky-note`
`(add-sticky-note)`

Create a sticky note at the cursor and open it for editing. Bound to
`M-n n`.
:::

:::function{name="edit-sticky-note" path="reference/commands/edit-sticky-note.html"}
### `edit-sticky-note`
`(edit-sticky-note)`

Edit the sticky note nearest the cursor. Bound to `M-n e`. Reports to
the REPL when there is no note near the cursor.
:::

:::function{name="delete-sticky-note" path="reference/commands/delete-sticky-note.html"}
### `delete-sticky-note`
`(delete-sticky-note)`

Delete the sticky note nearest the cursor. Bound to `M-n d`.
:::

:::function{name="next-sticky-note" aliases="previous-sticky-note" path="reference/commands/next-sticky-note.html"}
### `next-sticky-note` / `previous-sticky-note`
`(next-sticky-note)` / `(previous-sticky-note)`

Move the cursor to the next / previous sticky note in the buffer, by
anchor order. Bound to `M-n f` / `M-n b`.
:::

:::function{name="toggle-sticky-notes" path="reference/commands/toggle-sticky-notes.html"}
### `toggle-sticky-notes`
`(toggle-sticky-notes)`

Show or hide every sticky note in the buffer. Bound to `M-n t`.
:::
