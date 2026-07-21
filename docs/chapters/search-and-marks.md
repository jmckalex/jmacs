## Search, marks, and navigation

Finding a string and moving to it are the same act seen from two
angles. This chapter covers the commands that locate text — incremental
search, replacement, `occur`, and match highlighting — the mark and the
region, moving through a buffer by structure rather than by line, and
the commands that remember where you have been: bookmarks,
expand-region, and folding.

Incremental search runs as a Lisp loop in the server: a small state
machine reads each keystroke, finds the match, and moves the cursor,
while your window's only jobs are to paint the highlights and the echo
area. The keymap that binds all of these commands lives in
`keymap.lisp`. Keys follow the manual's notation: `C-` is Control,
`M-` is Command (the Mac's Meta), `A-` is Option, `S-` is Shift — see
the *Keys and commands* chapter.

### Incremental search

Incremental search finds text as you type it. Begin a forward search
with `C-s` (cmd(isearch-forward)) or a backward search with `C-r`
(cmd(isearch-backward)). A prompt — `I-search: ` or
`I-search backward: ` — opens in the minibuffer, and with each
character you add the editor jumps to the first match from where you
started, in the search direction, and *highlights* it: the current
match is lit with the bright `isearch` face, and — a beat later —
every other match in view is lit with the dimmer `search-match` face,
so you can see the field of candidates at a glance. No selection is
made and the mark is untouched; the highlighting is overlay paint, and
it vanishes when the search ends.

Where the cursor lands is deliberate and asymmetric: a forward search
puts the point at the *end* of the match, a backward search at its
*start* — in each case, the far side in the direction you are
travelling. That is where the cursor stays when you exit.

Four things govern the search:

- **Repeating.** Pressing `C-s` again, with a query already typed,
  moves to the *next* match forward; `C-r` moves to the next match
  backward. Both keys stay live throughout the loop, so a search begun
  forward can reverse mid-stream and reverse again. Repeats *wrap*: a
  forward search past the last match continues from the top of the
  buffer, a backward search past the first continues from the bottom.
  If the query matches nowhere at all, the cursor simply stays put.

- **No match.** While you type, a query with nothing ahead of it leaves
  the cursor where it was and the highlight disappears — that vanishing
  is the signal; no message is printed. `Backspace` shrinks the query
  and re-searches from where the search began; deleting back to a
  matching prefix resumes the highlight, and erasing the query entirely
  returns the cursor to the starting point. `Space` adds a literal
  space to the query.

- **Ending.** `Enter` or `Escape` ends the search, leaving the cursor
  at the match (the highlight is cleared, but the point remains). In
  fact *any* key that is not part of the search ends it the same way —
  the terminating keystroke is consumed, not executed, so a stray
  `C-a` exits at the match rather than jumping to the line start.

- **Aborting.** `C-g` (cmd(keyboard-quit)) cancels and returns the
  cursor to its original position, as though the search had never run.

Search is plain literal substring — what you type is what is matched,
case-sensitively, with no special characters. The regexp variants,
`C-M-s` (cmd(isearch-regexp-forward)) and `C-M-r`
(cmd(isearch-regexp-backward)), are currently being rebuilt for the
server architecture: pressing them announces
`I-search regexp: temporarily unavailable in server-mode (being
rebuilt)` and does nothing further. For pattern matching in the
meantime, use cmd(replace-regexp) (below).

### Replace

Godot offers three replacement commands, differing in whether they ask
before each change and in whether the pattern is literal or a regexp.

**Replace every occurrence.** `M-r` (cmd(replace-string)) prompts
`Replace: ` for a string to find and `Replace with: ` for its
replacement, then replaces every occurrence in the buffer at once,
without asking, and reports the tally in the echo area — `replaced 12
occurrence(s) of "foo"`, or `"foo" not found`. It is the blunt
instrument: fast when you are sure.

**Ask at each match.** `M-%` (cmd(query-replace)) is the considered
form. The `%` arrives shifted, so the physical chord is
`Cmd+Shift+5`. It prompts `Query replace: ` for a `from` string and
`Query replace with: ` for a `to` string, then walks forward from the
cursor. At each match it jumps there, highlights the match as a
selection (mark at its start, point at its end), shows
`Query replacing from with to: (y/n/q/! RET)`, and waits for a single
keystroke telling it what to do:

| Key | Effect |
|-----|--------|
| `y`, `Enter`, `Space` | Replace this match and advance to the next |
| `n` | Skip this match and advance |
| `q`, `Escape` | Quit, leaving the rest untouched |
| `!` | Replace this match and every remaining one, then quit |

Any other key re-asks, prefixing the prompt with a gentle hint —
`(use y, n, q, !, RET — got C-t)` — and the match stays selected while
you collect yourself. When the pass finishes (or you quit), the prompt
clears and the selection drops. Like incremental search,
`query-replace` matches a literal string, not a pattern.

**Replace by pattern.** `C-M-%` (cmd(replace-regexp)) — physically
`Cmd+Ctrl+Shift+5` — prompts `Regexp: ` and `Replace with: `, then
replaces every match across the buffer in one pass. The replacement
string uses JavaScript's back-reference syntax, not Emacs's: `$1`,
`$2`, … insert the corresponding capture group, `$&` inserts the whole
match, and `$$` inserts a literal dollar sign.

### Occur

Where search moves you to matches one at a time, `occur` lists them
all at once. `M-s o` (cmd(occur)) prompts `Occur: ` for a literal
substring and opens a fresh view named `*Occur: PATTERN*` containing
every line of the current buffer that holds the pattern, each prefixed
by its 1-based source line number, right-aligned in a column. A header
line counts the matches, and a search that finds nothing produces a
view that says so rather than an empty one. Searching a Lisp buffer
for `mark`, say:

```
3 matches for "mark":

 12: (define (set-mark-command)
 40:   ;; the mark rides edits
118: (clear-mark!)
```

The matching is plain literal substring, with no regexp. The results
view is an ordinary text view that the command writes into; it is a
snapshot of the matches at the moment you ran the command, not a live
index.

### Highlighting matches

The other two members of the `M-s` search prefix paint matches without
moving you anywhere. `M-s h` (cmd(highlight-matches)) highlights every
occurrence of the word at point — or, with an active region, of the
region's text — using the same `search-match` face as isearch's lazy
highlight, and reports `Highlighted 7 match(es) of "foo"`. The
highlights are overlays: their endpoints are buffer markers, so they
ride edits correctly, and they are shared state — every window showing
the buffer sees them. Running `M-s h` again on a different word
replaces the set. `M-s u` (cmd(unhighlight-all)) clears them
(`Highlights cleared`).

### The mark and the region

The *mark* is the editor's second position: together with the point it
delimits the *region*, the stretch of text that region commands — kill,
copy, case-change, and the rest (see *Basic editing*) — act on.

`C-SPC` (cmd(set-mark-command)) sets the mark at the point and echoes
`Mark set`. From then on, moving the cursor extends the region — it is
shown as a selection — until `C-g` (cmd(keyboard-quit)) or `Escape`
(cmd(deselect)) clears it. The mark commands:

| Action | Key | Command |
|--------|-----|---------|
| Set the mark; start a region | `C-SPC` | cmd(set-mark-command) |
| Swap point and mark | `C-x C-x` | cmd(exchange-point-and-mark) |
| Select the whole buffer | `C-x h` | cmd(mark-whole-buffer) |
| Mark the next word | `M-@` | cmd(mark-word) |
| Mark the paragraph | `M-h` | cmd(mark-paragraph) |

`C-x C-x` (cmd(exchange-point-and-mark)) puts the point where the mark
was and the mark where the point was — the quick way to revisit the
other end of the region, or to check where a region begins. `M-@`
(cmd(mark-word); physically `Cmd+Shift+2`) sets the mark at the end of
the next word, and pressing it again extends the region a word at a
time. `M-h` (cmd(mark-paragraph)) selects the paragraph around the
cursor, point at its start and mark at its end. (Selections can also
be made without the mark ceremony — `S-`arrows and friends — see
*Basic editing*.)

### Moving by structure

Three families of motion belong to this chapter's "navigation" remit;
the character/word/line motions live in *Basic editing*.

| Action | Key | Command |
|--------|-----|---------|
| Go to a line by number | `M-g` | cmd(goto-line) |
| Start / end of the buffer | `M-<` / `M->` | cmd(beginning-of-buffer) / cmd(end-of-buffer) |
| Back / forward a paragraph | `M-{` / `M-}` | cmd(backward-paragraph) / cmd(forward-paragraph) |

`M-g` (cmd(goto-line)) prompts `Goto line: ` for a number and jumps
there. `M-<` and `M->` (the symbols arrive shifted, so physically
`Cmd+Shift+comma` / `Cmd+Shift+period`) jump to the very start and end
of the buffer; `C-↑` and `C-↓` are synonyms. `M-{` and `M-}` step by
paragraphs — maximal runs of non-blank lines — extending an active
region as they go.

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
| Toggle the bookmark outline | `C-x r l` | cmd(list-bookmarks) |
| Delete a bookmark | — | cmd(bookmark-delete) |

`C-x r m` prompts `Set bookmark: ` for a name and sets a bookmark at
the cursor; reusing a name *moves* that bookmark rather than creating a
second one. `C-x r b` prompts `Jump to bookmark: ` and jumps. There is
deliberately no key for deletion — `C-x r d` is `delete-rectangle` in
Emacs, and is left free — so delete a bookmark with
`M-x bookmark-delete` (which prompts `Delete bookmark: `) or from the
bookmark outline.

**The bookmark outline.** `C-x r l` (cmd(list-bookmarks)) *toggles* an
outline of the current buffer's bookmarks beside the document — it
opens the outline, or closes it if it is already open. Bookmarks list
in *document order* — the order they appear in the text, not the order
you set them. Within the outline you navigate with the arrow keys or
`n`/`p`, press `Enter` to jump to the bookmark under the cursor, and
edit the list in place: `r` renames, `d` deletes, `Tab` / `S-Tab`
indent and outdent an entry (with its whole subtree) to build a
hierarchy, `Space` folds a subtree, `g` refreshes the outline after
source edits, and `q` closes it. Right-clicking a row offers the same
rename and delete as a context menu.

**Persistence.** Bookmarks belong to the buffer's file, and are written
to a sidecar named `.NAME.godot-metadata` alongside it — the same
metadata sidecar that holds the file's other per-document state, so
reopening the file restores its bookmarks where the text has carried
them. Each bookmark is saved with a short slice of the text on either
side of it, and if the file was edited while Godot was not watching —
closed in between, or changed by another tool — the saved position is
*relocated* on load: an unchanged offset is trusted, an exact context
match that merely shifted is found next, and failing that a fuzzy
best-match near the old position wins. Bookmarks survive external
edits, in other words, not just your own.

Bookmark support is provided by `bookmark-minor-mode`, a minor mode
enabled by default in every text buffer. It carries no keymap of its
own — the keys above are global under `C-x r` — and serves only to mark
a buffer as bookmark-capable.

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

A word, for this command, is a run of letters and digits (in any
script) or underscores — the editor-wide word definition, the same one
word motion (`M-f`/`M-b`) uses; a paragraph is a maximal run of
non-blank lines, or — if the cursor is on a blank line — just that
line.

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
once, and `C-c C-.` (cmd(unfold-all)) opens them all again. The mouse
works too: the gutter shows a chevron (`▾` / `▸`) beside each foldable
header — click it to toggle that fold — and a folded header carries a
`…` glyph where its body was.

Folding depends on the buffer's language knowing what counts as a
foldable scope. In a buffer whose major mode supplies no fold support,
these commands are no-ops — they neither fold anything nor report an
error.

### Command index

| Command | Key | Effect |
|---------|-----|--------|
| cmd(isearch-forward) / cmd(isearch-backward) | `C-s` / `C-r` | Incremental search, forward / backward |
| cmd(replace-string) | `M-r` | Replace every occurrence, no questions |
| cmd(query-replace) | `M-%` | Replace with a per-match y/n/q/! prompt |
| cmd(replace-regexp) | `C-M-%` | Replace every regexp match in one pass |
| cmd(occur) | `M-s o` | List every matching line in a fresh view |
| cmd(highlight-matches) / cmd(unhighlight-all) | `M-s h` / `M-s u` | Paint / clear overlays on every match of the word at point |
| cmd(set-mark-command) | `C-SPC` | Set the mark; start a region |
| cmd(exchange-point-and-mark) | `C-x C-x` | Swap the region's two ends |
| cmd(mark-whole-buffer) | `C-x h` | Select everything |
| cmd(mark-word) / cmd(mark-paragraph) | `M-@` / `M-h` | Mark the next word / the paragraph |
| cmd(goto-line) | `M-g` | Jump to a line by number |
| cmd(beginning-of-buffer) / cmd(end-of-buffer) | `M-<` / `M->` | Jump to the buffer's ends |
| cmd(backward-paragraph) / cmd(forward-paragraph) | `M-{` / `M-}` | Move by paragraphs |
| cmd(bookmark-set) / cmd(bookmark-jump) | `C-x r m` / `C-x r b` | Set / jump to a named bookmark |
| cmd(list-bookmarks) | `C-x r l` | Toggle the bookmark outline |
| cmd(expand-region) | `C-=` | Grow the selection one structural step |
| cmd(toggle-fold-at-point) | `C-c Tab` | Fold / unfold the region at the cursor |
| cmd(fold-all) / cmd(unfold-all) | `C-c C-,` / `C-c C-.` | Collapse / open every fold |
