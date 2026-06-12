Title: jmacs Search & Editing Commands
Author: J. McKenzie Alexander
Date: 2026-06-11
---

## Search and editing commands

This document describes the search, replace, structural-navigation and
whole-line editing commands of the jmacs standard library that go beyond
the basics in `commands.md`. Like everything there, these are ordinary
Lisp built on the buffer primitives (`buffer-primitives.jmd`) and the
core language (`lisp-core.jmd`); each lives in a feature file under
`packages/stdlib/lisp/`.

The companion file `commands.md` already documents the plain incremental
search (cmd(isearch-forward), cmd(isearch-backward)), the literal
cmd(replace-string), and the basic kill-ring commands (cmd(kill-region),
cmd(copy-region), cmd(kill-line), cmd(yank), …). This file fills in the
regexp search, the interactive replace, the *Occur* listing, folding,
structural selection, the whole-line operations, and the one kill-ring
command — cmd(yank-pop) — that the other file leaves out. See `index.jmd`
for how to read an entry and what the conventions mean.

Key bindings are given in the manual's notation: `C-` is Control or
Command, `M-` is Option, `S-` is Shift.

---

### Incremental search

Defined in `search.lisp` and `regex-search.lisp`. The plain forms
(cmd(isearch-forward) / cmd(isearch-backward)) are in `commands.md`;
these are their regexp counterparts. As with plain isearch, the
interactive search loop runs in the minibuffer (host code); the command
only starts it.

:::function{name="isearch-regexp-forward" path="reference/search-and-edit/isearch-regexp-forward.html"}
#### `isearch-regexp-forward`
`(isearch-regexp-forward)`

Begin an incremental forward regexp search in the current buffer. Bound
to `C-M-s`. The query is a JS `RegExp` source; an invalid regexp typed
mid-search simply yields no match (no error). Regexp cousin of
cmd(isearch-forward).
:::

:::function{name="isearch-regexp-backward" path="reference/search-and-edit/isearch-regexp-backward.html"}
#### `isearch-regexp-backward`
`(isearch-regexp-backward)`

Begin an incremental backward regexp search in the current buffer. Bound
to `C-M-r`. Regexp cousin of cmd(isearch-backward).
:::

### Replace

Defined in `regex-search.lisp`. Two non-interactive forms here —
cmd(replace-regexp) over a regexp, and the interactive, match-by-match
cmd(query-replace). The literal whole-buffer cmd(replace-string) is in
`commands.md`.

:::function{name="replace-regexp" path="reference/search-and-edit/replace-regexp.html"}
#### `replace-regexp`
`(replace-regexp pattern replacement)`

Replace every regexp match of `pattern` with `replacement` in the
current buffer. Bound to `C-M-%` (normalised `C-M-S-5`). Prompts for the
pattern and the replacement in the minibuffer. `replacement` uses JS
`String.replace` back-references — `$1`, `$2`, … for capture groups,
`$&` for the whole match, `$$` for a literal `$` — not Emacs's `\1`/`\&`.
:::

:::function{name="query-replace" path="reference/search-and-edit/query-replace.html"}
#### `query-replace`
`(query-replace from to)`

Walk forward from point, asking what to do at each plain (non-regexp)
match of `from`. Bound to `M-%` (normalised `M-S-5`). Prompts for `from`
and `to`, then for each match jumps to it, highlights it, and reads one
key:

- `y`, `RET`, `SPC` — replace this match and advance;
- `n` — skip it and advance;
- `q`, `ESC` — quit, leaving the rest alone;
- `!` — replace this and every remaining match, then finish.

On finishing it clears the selection and reports the replacement count.
:::

### Occur

Defined in `occur.lisp`. The command builds its results buffer in pure
Lisp on top of `buffer-text`, `new-view!` and `insert!`.

:::function{name="occur" path="reference/search-and-edit/occur.html"}
#### `occur`
`(occur pattern)`

List every line of the current view's buffer containing `pattern` — a
literal substring, no regex — in a fresh `*Occur: PATTERN*` view. Bound
to `M-s o`. Prompts for the pattern in the minibuffer. Each result line
is shown as `<line-number>: <line-text>`, under a header giving the
pattern and the match count; with no matches the view says `(no
matches)` rather than being empty.
:::

:::function{name="occur-matching-lines" path="reference/search-and-edit/occur-matching-lines.html"}
#### `occur-matching-lines`
`(occur-matching-lines pattern text)`

A list of `(line-number . line-text)` pairs for every line of `text`
that contains `pattern` as a substring; line numbers are 1-based. The
pure matcher cmd(occur) is built on — separated from the command body so
it can be unit-tested without touching the host's view list.
:::

:::function{name="occur-result-text" path="reference/search-and-edit/occur-result-text.html"}
#### `occur-result-text`
`(occur-result-text pattern text)`

The full text written into the `*Occur*` view when searching `text` for
`pattern`: the header line, then one `<lineno>: <line>` row per match
(or `(no matches)`). The pure formatter behind cmd(occur).
:::

:::function{name="occur-buffer-name" path="reference/search-and-edit/occur-buffer-name.html"}
#### `occur-buffer-name`
`(occur-buffer-name pattern)`

The name to give the results view for `pattern` — `*Occur: PATTERN*`.
:::

### Folding

Defined in `folding.lisp`. Folding is a *view* concern: the renderer
tracks which lines are collapsed per buffer and decides what to draw.
These commands only orchestrate, calling host primitives the editor view
exposes; they are no-ops when the buffer's language has no fold support.
Bound under the `C-c` prefix.

:::function{name="toggle-fold-at-point" path="reference/search-and-edit/toggle-fold-at-point.html"}
#### `toggle-fold-at-point`
`(toggle-fold-at-point)`

Toggle the fold at point. Bound to `C-c TAB`. If point is on a foldable
header, that fold toggles; otherwise the smallest enclosing fold
toggles. No-op when the current buffer's language has no fold support.
:::

:::function{name="fold-all" path="reference/search-and-edit/fold-all.html"}
#### `fold-all`
`(fold-all)`

Fold every foldable scope in the current buffer. Bound to `C-c C-,`.
:::

:::function{name="unfold-all" path="reference/search-and-edit/unfold-all.html"}
#### `unfold-all`
`(unfold-all)`

Unfold every fold in the current buffer. Bound to `C-c C-.`.
:::

### Structural selection

Defined in `expand-region.lisp`. cmd(expand-region) grows the active
region one structural step per press; cmd(deselect) clears it.

:::function{name="expand-region" path="reference/search-and-edit/expand-region.html"}
#### `expand-region`
`(expand-region)`

Grow the active region one structural step: word → line → paragraph →
whole buffer. Bound to `C-=`. Repeated presses keep growing around the
*same* anchor (the cursor position where the chain began); any other
command in between resets the chain, so the next `C-=` starts again at
the word step. The continuation is detected through `*last-command*`,
the same trick cmd(yank-pop) uses.
:::

:::function{name="deselect" path="reference/search-and-edit/deselect.html"}
#### `deselect`
`(deselect)`

Clear the selection on every cursor without collapsing the multi-cursor
set. Bound to `escape`. For a single cursor this is the same as
`clear-mark!` (without `C-g`'s side-effect of resetting an in-progress
key chord); with multiple cursors it drops a word-select (`C-c d` /
`C-c D`) down to bare carets at every match. Defined in `editing.lisp`;
`snippets-keymap.lisp` wraps it so a single `escape` first cancels an
active snippet.
:::

### Line operations

Defined in `line-ops.lisp`. Four commands that act on whole lines rather
than characters; all are ordinary Lisp over the buffer primitives, with
no host change. The cursor keeps its column and travels with the text.

:::function{name="move-line-up" path="reference/search-and-edit/move-line-up.html"}
#### `move-line-up`
`(move-line-up)`

Move the current line up one, swapping it with the line above. Bound to
`M-↑`. No-op on the first line. The cursor keeps its column and travels
with the line.
:::

:::function{name="move-line-down" path="reference/search-and-edit/move-line-down.html"}
#### `move-line-down`
`(move-line-down)`

Move the current line down one, swapping it with the line below. Bound
to `M-↓`. No-op on the last line.
:::

:::function{name="duplicate-line" path="reference/search-and-edit/duplicate-line.html"}
#### `duplicate-line`
`(duplicate-line)`

Insert a copy of the current line immediately below it. Bound to
`C-x C-d`. The cursor moves to the copy, keeping its column.
:::

:::function{name="join-line" path="reference/search-and-edit/join-line.html"}
#### `join-line`
`(join-line)`

Join the next line onto the end of the current one. Bound to `C-x C-j`.
The intervening newline and the next line's leading whitespace collapse
to a single space (Emacs-style); the cursor lands at the join. No-op on
the last line.
:::

### The kill ring

Defined in `yank-pop.lisp`. The kill ring itself and its core commands
(cmd(kill-region), cmd(copy-region), cmd(kill-line), cmd(kill-word),
cmd(kill-sentence), cmd(backward-kill-word), cmd(yank)) are in
`commands.md`; this is the one command that lives elsewhere.

:::function{name="yank-pop" path="reference/search-and-edit/yank-pop.html"}
#### `yank-pop`
`(yank-pop)`

Replace the text of the last cmd(yank) with the previous kill in the
ring; repeated invocations cycle back through it. Bound to `M-y`. Valid
only immediately after a `yank` or `yank-pop` — it relies on the yank
state recorded in `kill.lisp` (`*yank-start*`, `*yank-length*`,
`*yank-index*`) and on the command history (`*last-command*`). After any
other command it does nothing but report; it also reports when the kill
ring is empty.
:::
