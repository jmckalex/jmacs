## Search, marks, and navigation

Finding a string and moving to it are the same act seen from two
angles. This chapter covers the commands that locate text — incremental
search, replacement, and `occur` — and the commands that remember where
you have been and let you move through a buffer by structure rather than
by line: bookmarks, expand-region, and folding.

The interactive parts of search — the find-as-you-type loop, the
per-match prompts — run in the minibuffer, which is host code. The Lisp
commands documented here *start* those loops; the keymap that binds them
lives in `keymap.lisp`. Keys follow the manual's notation: `C-` is
Control or Command, `M-` is Option, `S-` is Shift.

### Incremental search

Incremental search finds text as you type it. Begin a forward search
with `C-s` (cmd(isearch-forward)) or a backward search with `C-r`
(cmd(isearch-backward)). A prompt — `I-search:` or `I-search backward:`
— opens in the minibuffer, and with each character you add the editor
jumps to the first match from the cursor in the search direction and
*highlights* it: the match is shown as a selection, with the mark at its
start and the point at its end. There is no separate "search" mode to
remember; the buffer simply follows your typing.

Three things govern the search:

- **Repeating.** Pressing `C-s` again, with a query already typed, moves
  to the *next* match forward; `C-r` moves to the next match backward.
  Both keys stay live throughout the loop, so a search begun forward can
  reverse mid-stream and reverse again — each press steps one match in
  the chosen direction from the current match. When no further match
  exists, the minibuffer reports `no more matches` and the cursor stays
  put.

- **No match.** While you type, a query with nothing ahead of it shows
  `no match` in the minibuffer and leaves the cursor where it was;
  deleting back to a matching prefix resumes the highlight. Erasing the
  query entirely returns the cursor to where the search began.

- **Ending.** `Enter` ends the search, leaving the cursor at the match
  (the highlight is cleared, but the point remains). `C-g`
  (cmd(keyboard-quit)) cancels and returns the cursor to its original
  position, as though the search had never run.

Search is plain literal substring — what you type is what is matched,
case-sensitively, with no special characters. For pattern matching, use
regexp search instead: `C-M-s` (cmd(isearch-regexp-forward)) and `C-M-r`
(cmd(isearch-regexp-backward)) run the same minibuffer loop, but the
query is a JavaScript regular-expression source rather than a literal
string. An incomplete or invalid expression typed mid-search simply
matches nothing — it raises no error — so you can build a pattern up a
character at a time without the loop breaking.

### Replace

jmacs offers three replacement commands, differing in whether they ask
before each change and in whether the pattern is literal or a regexp.

**Replace every occurrence.** `M-r` (cmd(replace-string)) prompts for a
string to find and a string to replace it with, then replaces every
occurrence in the buffer at once, without asking. It is the blunt
instrument: fast when you are sure.

**Ask at each match.** `M-%` (cmd(query-replace)) is the considered
form. It prompts for a `from` and a `to` string, then walks forward from
the cursor. At each match it jumps to the match, highlights it as a
selection, and waits for a single keystroke telling it what to do:

| Key | Effect |
|-----|--------|
| `y`, `Enter`, `Space` | Replace this match and advance to the next |
| `n` | Skip this match and advance |
| `q`, `Escape` | Quit, leaving the rest untouched |
| `!` | Replace this match and every remaining one, then quit |

Any other key re-asks without changing anything — the match stays
selected. When the pass finishes (or you quit), the minibuffer reports
how many replacements were made. Like incremental search,
`query-replace` matches a literal string, not a pattern.

**Replace by pattern.** `C-M-%` (cmd(replace-regexp)) prompts for a
regexp and a replacement and replaces every match across the buffer in
one pass. The replacement string uses JavaScript's back-reference
syntax, not Emacs's: `$1`, `$2`, … insert the corresponding capture
group, `$&` inserts the whole match, and `$$` inserts a literal dollar
sign.

### Occur

Where search moves you to matches one at a time, `occur` lists them all
at once. `M-s o` (cmd(occur)) prompts for a literal substring and opens
a fresh view named `*Occur: PATTERN*` containing every line of the
current buffer that holds the pattern, each prefixed by its (1-based)
source line number, right-aligned in a column. A header line counts the
matches — `3 matches for "foo":` — and a search that finds nothing
produces a view that says `(no matches)` rather than an empty one.

The matching is plain literal substring, with no regexp. The results
view is an ordinary text view that the command writes into; it is a
snapshot of the matches at the moment you ran the command, not a live
index.

### Bookmarks

A *bookmark* is a named position in a buffer that survives both editing
and the end of a session. Underneath, each bookmark is a buffer marker —
an invisible, edit-tracking position (see `packages/buffer`) — so the
bookmark rides changes to the text: insert a paragraph above it and it
moves down with the line it named, rather than pointing at the wrong
place. The bookmark commands live under the `C-x r` prefix, echoing
Emacs's register-and-bookmark family.

| Action | Key | Command |
|--------|-----|---------|
| Set (or move) a bookmark | `C-x r m` | cmd(bookmark-set) |
| Jump to a bookmark | `C-x r b` | cmd(bookmark-jump) |
| List the buffer's bookmarks | `C-x r l` | cmd(list-bookmarks) |
| Delete a bookmark | — | cmd(bookmark-delete) |

`C-x r m` prompts for a name and sets a bookmark at the cursor; reusing
a name *moves* that bookmark rather than creating a second one. `C-x r b`
prompts for a name and jumps to it. There is deliberately no key for
deletion — `C-x r d` is `delete-rectangle` in Emacs, and is left free —
so delete a bookmark with `M-x bookmark-delete` or from the bookmark
list.

**The bookmark list.** `C-x r l` (cmd(list-bookmarks)) opens an outline
of the current buffer's bookmarks in *document order* — the order they
appear in the text, not the order you set them. Within the outline you
navigate with the arrow keys or `n`/`p`, press `Enter` to jump to the
bookmark under the cursor, and edit the list in place: `r` renames, `d`
deletes, `Tab` / `S-Tab` indent and outdent an entry to build a
hierarchy, `Space` folds a subtree, and `q` closes the outline.

**Persistence.** Bookmarks belong to the buffer's file, and are written
to a sidecar named `.NAME.godot-metadata` alongside it — the same
metadata sidecar that holds the file's other per-document state. Each
record stores the marker's position by name, so reopening the file
restores its bookmarks where the text has carried them.

Bookmark support is provided by `bookmark-minor-mode`, a minor mode
enabled by default in every text buffer. It carries no keymap of its own
— the keys above are global under `C-x r` — and serves only to mark a
buffer as bookmark-capable and to show "Bookmark" in the modeline.

### Expand-region

`expand-region`, bound to `C-=` (cmd(expand-region)), grows the
selection by one *syntactic* step each time you press it. Starting from
no selection, successive presses select progressively larger structures
around the cursor:

```
no region → the word → the line → the paragraph → the whole buffer
```

The growth is anchored. The first press in a chain remembers the cursor
position, and every later press grows around that *same* original point
rather than drifting as the selection's edges move outward — so the
sequence is stable no matter how far it has grown. Each press jumps to
the next step whose bounds are genuinely larger than the current
selection; a step that would not grow the region (for instance, the word
step when the cursor sits between two non-word characters) is skipped.
Once the selection reaches the whole buffer, further presses do nothing.

A press only counts as *continuing* the chain when the immediately
preceding command was also `expand-region`. Run any other command
between presses and the chain resets: the next `C-=` starts over at the
word step, around wherever the cursor now sits. There is no contracting
counterpart — to shrink, cancel the selection with `C-g` and grow again.

A word, for this command, is a run of letters, digits, and underscores; a
paragraph is a maximal run of non-blank lines, or — if the cursor is on a
blank line — just that line.

### Folding

Folding hides the body of a structural region, collapsing it to its
header line so a long buffer can be read at the level of its outline.
Folding is a property of the *view*, not the text: the renderer tracks
which lines are collapsed per buffer and decides what to draw, and the
buffer's contents are untouched. The Lisp commands orchestrate; the work
is done by the editor view. The bindings sit under the `C-c` prefix.

| Action | Key | Command |
|--------|-----|---------|
| Toggle the fold at point | `C-c Tab` | cmd(toggle-fold-at-point) |
| Fold everything | `C-c C-,` | cmd(fold-all) |
| Unfold everything | `C-c C-.` | cmd(unfold-all) |

`C-c Tab` (cmd(toggle-fold-at-point)) toggles one fold: if the cursor is
on a line that is itself a foldable header, that region folds or
unfolds; otherwise the smallest fold *enclosing* the cursor toggles.
`C-c C-,` (cmd(fold-all)) collapses every foldable scope in the buffer at
once, and `C-c C-.` (cmd(unfold-all)) opens them all again.

Folding depends on the buffer's language knowing what counts as a
foldable scope. In a buffer whose major mode supplies no fold support,
these commands are no-ops — they neither fold anything nor report an
error.
