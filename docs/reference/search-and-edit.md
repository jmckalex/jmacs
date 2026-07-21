Title: Godot Search & Editing Commands
Author: J. McKenzie Alexander
Date: 2026-06-11
---

## Search and editing commands

This document describes the search, replace, structural-navigation and
whole-line editing commands of the Godot standard library that go beyond
the basics in `commands.md`. Like everything there, these are ordinary
Lisp built on the buffer primitives (`buffer-primitives.md`) and the
core language (`lisp-core.md`); each lives in a feature file under
`packages/stdlib/lisp/`.

The companion file `commands.md` already documents the plain incremental
search (cmd(isearch-forward), cmd(isearch-backward)), the literal
cmd(replace-string), and the basic kill-ring commands (cmd(kill-region),
cmd(copy-region), cmd(kill-line), cmd(yank), …). This file fills in the
regexp search, the interactive replace, the *Occur* listing, match
highlighting, folding, structural selection, the whole-line operations,
and the one kill-ring command — cmd(yank-pop) — that the other file
leaves out. See `index.md` for how to read an entry and what the
conventions mean.

Key bindings are given in the manual's notation: `C-` is Control, `M-`
is Command (the Meta of Emacs custom), `A-` is Option, `S-` is Shift.

---

### Incremental search

Defined in `search.lisp` and `regex-search.lisp`. The plain forms
(cmd(isearch-forward) / cmd(isearch-backward), `C-s` / `C-r`) are in
`commands.md`; these are their regexp counterparts. Plain isearch is a
server-side loop that owns the keyboard while it runs: typing extends
the query (point jumps to the match — its end searching forward, its
start searching backward), `C-s` / `C-r` repeat in either direction and
wrap past the buffer's ends, `backspace` shrinks the query, `C-g`
aborts back to where you started, and `enter` or `escape` exits at the
current match. While the search is live, the current match is
highlighted with the `isearch` face and every other match with
`search-match`. The regexp variants will inherit this same key loop
once ported.

:::function{name="isearch-regexp-forward" path="reference/search-and-edit/isearch-regexp-forward.html"}
#### `isearch-regexp-forward`
`(isearch-regexp-forward)`

Begin an incremental forward regexp search in the current buffer. Bound
to `C-M-s`. Regexp cousin of cmd(isearch-forward). **Status:** the
incremental regexp loop is being rebuilt for server mode; at present
the command resolves, reports `I-search regexp: temporarily unavailable
in server-mode (being rebuilt)` in the echo area, and exits. (The
non-incremental regexp commands below are fully functional.)
:::

:::function{name="isearch-regexp-backward" path="reference/search-and-edit/isearch-regexp-backward.html"}
#### `isearch-regexp-backward`
`(isearch-regexp-backward)`

Begin an incremental backward regexp search in the current buffer. Bound
to `C-M-r`. Regexp cousin of cmd(isearch-backward). **Status:** stubbed,
the same way as cmd(isearch-regexp-forward) — the binding reports and
exits.
:::

### Replace

Defined in `regex-search.lisp`. Two commands: the all-at-once
cmd(replace-regexp) over a regexp, and the match-by-match, interactive
cmd(query-replace). The literal whole-buffer cmd(replace-string)
(`M-r`) is in `commands.md`.

:::function{name="replace-regexp" path="reference/search-and-edit/replace-regexp.html"}
#### `replace-regexp`
`(replace-regexp pattern replacement)`

Replace every regexp match of `pattern` with `replacement` in the
current buffer. Bound to `C-M-%` (normalised `C-M-S-5`). Prompts for the
pattern and the replacement in the minibuffer. `replacement` uses JS
`String.replace` back-references — `$1`, `$2`, … for capture groups,
`$&` for the whole match, `$$` for a literal `$` — not Emacs's `\1`/`\&`.
On completion the echo area reports `replaced N occurrence(s) of
/pattern/`, or `/pattern/ — no match`. An invalid pattern replaces
nothing.
:::

:::function{name="query-replace" path="reference/search-and-edit/query-replace.html"}
#### `query-replace`
`(query-replace from to)`

Walk forward from point, asking what to do at each plain (non-regexp)
match of `from`. Bound to `M-%` (normalised `M-S-5`). Prompts for `from`
and `to`, then for each match jumps to it, selects it, and reads one
key:

- `y`, `enter`, `space` — replace this match and advance;
- `n` — skip it and advance;
- `q`, `escape` — quit, leaving the rest alone;
- `!` — replace this and every remaining match, then finish.

Any other key re-prompts without moving on — the echo area shows
`(use y, n, q, !, RET — got <key>)` ahead of the prompt while the match
stays selected. On finishing it clears the selection. (The replacement
count is printed with `println`, whose output the running editor
currently discards — so no count appears in the echo area.)
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
is shown as `<line-number>: <line-text>`, the line numbers right-aligned
(space-padded to the widest matching line number), under a header giving
the pattern and the match count; with no matches the view says `(no
matches)` rather than being empty. The results are plain text: there is
as yet no way to jump from a result line back to its source line.
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

### Match highlighting

The other two keys on the `M-s` search prefix. Where isearch lights
matches only while the search is live, these paint *persistent*
overlays: every occurrence at once, staying lit while you edit. The
overlays' endpoints are buffer markers, so they ride edits correctly,
and they are shared across every window viewing the buffer.

:::function{name="highlight-matches" path="reference/search-and-edit/highlight-matches.html"}
#### `highlight-matches`
`(highlight-matches)`

Highlight every occurrence of the word at point (or the active region's
text) with `search-match` overlays. Bound to `M-s h`. Any previous
match highlights are cleared first; the echo area reports
`Highlighted N match(es) of "word"`. With neither a word at point nor
an active region, the command only clears the previous highlights.
:::

:::function{name="unhighlight-all" path="reference/search-and-edit/unhighlight-all.html"}
#### `unhighlight-all`
`(unhighlight-all)`

Remove every match-highlight overlay laid down by
cmd(highlight-matches). Bound to `M-s u`. Reports `Highlights cleared`.
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

Toggle the fold at point. Bound to `C-c tab`. If point is on a foldable
header, that fold toggles; otherwise the smallest enclosing fold
toggles. No-op when the current buffer's language has no fold support.
:::

:::function{name="fold-all" path="reference/search-and-edit/fold-all.html"}
#### `fold-all`
`(fold-all)`

Fold every foldable scope in the current buffer. Bound to `C-c C-,`
(normalised `C-c C-comma`).
:::

:::function{name="unfold-all" path="reference/search-and-edit/unfold-all.html"}
#### `unfold-all`
`(unfold-all)`

Unfold every fold in the current buffer. Bound to `C-c C-.` (normalised
`C-c C-period`).
:::

### Structural selection

Defined in `expand-region.lisp`. cmd(expand-region) grows the active
region one structural step per press; cmd(deselect) clears it.

:::function{name="expand-region" path="reference/search-and-edit/expand-region.html"}
#### `expand-region`
`(expand-region)`

Grow the active region one structural step: word → line → paragraph →
whole buffer. Bound to `C-=` (normalised `C-equal`). Repeated presses
keep growing around the *same* anchor (the cursor position where the
chain began); any other command in between resets the chain, so the
next `C-=` starts again at the word step. The continuation is detected
through `*last-command*`, the same trick cmd(yank-pop) uses.
:::

:::function{name="deselect" path="reference/search-and-edit/deselect.html"}
#### `deselect`
`(deselect)`

Clear the selection on every cursor without collapsing the multi-cursor
set. Bound to `escape`. For a single cursor this is the same as
`clear-mark!`, minus cmd(keyboard-quit)'s other jobs — `C-g` also
resets an in-progress key chord, collapses a multi-cursor set to the
primary, and cancels an active snippet. With multiple cursors,
`deselect` drops a word-select (`C-c d` / `C-c D`, see
`productivity.md`) down to bare carets at every match, cursor set
intact. Defined in `editing.lisp`; `snippets-keymap.lisp` wraps it so a
single `escape` first cancels an active snippet.
:::

### Line operations

Defined in `line-ops.lisp` — the whole-line editing family: moving and
copying lines, joining, Sublime-style block indentation, tab/space
indentation conversion, and sorting. All are ordinary Lisp over the
buffer primitives, with no host change. (One further member of the
file, cmd(transpose-lines) on `C-x C-t`, is documented with the basic
editing commands in `commands.md`.) In the three movement and copying
commands the cursor keeps its column and travels with the text.

:::function{name="move-line-up" path="reference/search-and-edit/move-line-up.html"}
#### `move-line-up`
`(move-line-up)`

Move the current line up one, swapping it with the line above. Bound to
`M-up`. No-op on the first line. The cursor keeps its column and travels
with the line.
:::

:::function{name="move-line-down" path="reference/search-and-edit/move-line-down.html"}
#### `move-line-down`
`(move-line-down)`

Move the current line down one, swapping it with the line below. Bound
to `M-down`. No-op on the last line.
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

:::function{name="indent-region" path="reference/search-and-edit/indent-region.html"}
#### `indent-region`
`(indent-region)`

Indent every line the region touches (or just the cursor's line) by one
level — Sublime-style block indentation. Bound to `M-]`. A level is a
literal tab where the mode pins tabs (Makefiles), otherwise
`*tab-width*` spaces (default 4; see `indent.lisp`). Blank lines are
left alone. The selection survives the shift, so repeated presses keep
indenting the same block; a region ending at column 0 does not pull in
that line.
:::

:::function{name="outdent-region" path="reference/search-and-edit/outdent-region.html"}
#### `outdent-region`
`(outdent-region)`

Outdent every line the region touches (or the cursor's line) by one
level — a leading tab, or up to `*tab-width*` leading spaces. Bound to
`M-[`. The selection survives, so repeated presses keep outdenting.
:::

:::function{name="tabify-region" aliases="untabify-region" path="reference/search-and-edit/tabify-region.html"}
#### `tabify-region` / `untabify-region`
`(tabify-region)` / `(untabify-region)`

Convert the *leading* indentation of the lines the region touches (or
the cursor's line) between tabs and spaces, honouring the effective tab
width: `tabify-region` packs every `*tab-width*` columns of indent into
one tab (a remainder stays as spaces); `untabify-region` expands each
leading tab to spaces. Only the leading run is touched — interior
alignment (tables, trailing comments) is left exactly as it is. The
selection survives. Unbound; reach them via `M-x`.
:::

:::function{name="tabify-buffer" aliases="untabify-buffer" path="reference/search-and-edit/tabify-buffer.html"}
#### `tabify-buffer` / `untabify-buffer`
`(tabify-buffer)` / `(untabify-buffer)`

The whole-buffer forms of cmd(tabify-region) / cmd(untabify-region):
convert every line's leading indentation in one atomic change, keeping
point on its character. Use `tabify-buffer` to retab a spaces-indented
file after turning `*indent-tabs-mode*` on. Unbound; reach them via
`M-x`.
:::

:::function{name="sort-lines" path="reference/search-and-edit/sort-lines.html"}
#### `sort-lines`
`(sort-lines start end)`

Sort the lines in `[start, end)` into ascending order — a plain
lexicographic string sort by character code (case-sensitive, and
number-naive: `line10` sorts before `line9`). The
`(interactive region)` clause supplies the active region's bounds, and
without a region the command errors with `this command needs an active
region`. The range is snapped *outward* to whole lines — `start` back
to its line's start, `end` forward to its line's end — except that an
`end` at column 0 does not pull in that line (the cmd(indent-region)
rule). An already-sorted block is left unedited, so no empty step lands
on the undo stack; either way the cursor lands at the start of the
block. Unbound; reach it via `M-x`.
:::

### The kill ring

Defined in `yank-pop.lisp`. The kill ring itself and its core commands
(cmd(kill-region), cmd(copy-region), cmd(kill-line),
cmd(kill-whole-line), cmd(kill-word), cmd(kill-sentence),
cmd(backward-kill-word), cmd(zap-to-char), cmd(yank)) are in
`commands.md`; this is the one command that lives elsewhere.

Two behaviours of the ring bear directly on what `yank-pop` cycles
through. First, consecutive kill commands *accumulate* into one
kill-ring entry (forward kills append, backward kills prepend; any
other command in between starts a fresh entry) — so after `C-k C-k`,
`C-y` reinserts both lines as one block and a following `M-y` swaps
them out as a unit, not one line at a time. Second,
cmd(yank) first syncs in the system clipboard: text copied in another
application is pushed onto the ring before the yank, and so becomes the
entry a following `yank-pop` steps back *from*. Both are detailed under
the kill commands in `commands.md`.

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
