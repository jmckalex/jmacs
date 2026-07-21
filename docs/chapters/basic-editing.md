## Basic editing

Everything Godot does to text, it does to a *buffer*. This chapter is
the ground floor: what a buffer is, how the cursor and the selection
work, how you move, insert, and delete, how cut-copy-paste works through
the kill ring, and how to take a change back. None of it is baked into
the host — every command named here is ordinary Lisp in the standard
library (`editing.lisp`, `kill.lisp`, and their neighbours), so every
one is yours to rebind or redefine. Later chapters build on this one;
this is the vocabulary the rest of the editor assumes you already speak.

The key notation is the manual's throughout: `C-` is Control, `M-` is
Command (the Meta of Emacs custom), `A-` is Option, and `S-` is Shift —
so `M-f` is Command-F, and `A-]` is Option-]. The Keys and commands
chapter is the authority on how keys are named and dispatched; this
chapter just uses them.

One prefix key is worth meeting early: `C-u` (cmd(universal-argument))
sets a flag — the variable `*prefix-arg*` — that the *next* command may
consult to vary its behaviour. `C-u C-x 2`, for instance, splits the
pane above instead of below (see the Windows chapter). No command in
this chapter consults it, and numeric arguments (`C-u 4 …`) are not
supported yet — a single `C-u` is a plain "argument present" flag.

### The buffer

A *buffer* is a piece of text together with the state an editor needs to
work on it: a cursor, a selection, an undo history, and a mode. The text
you see on screen is one buffer; the editor holds a list of them with
one *current*. (Switching between buffers, and the views and panes that
display them, are the subjects of later chapters.)

Positions in a buffer are *character offsets*, zero-indexed: offset `0`
is before the first character, and a buffer of *n* characters has
offsets `0` through *n*. A range is half-open — `[start, end)` includes
`start` and excludes `end`. Lines and columns are zero-indexed too.
These conventions hold from the storage layer up through the Lisp, so a
position you read in one place means the same thing in another. The one
user-facing exception: the `M-g` goto-line prompt counts lines from 1,
matching the line number the modeline shows.

### Point and mark

The *point* is the cursor — a position *between* two characters, not on
one. Everything you insert appears at point, and most commands act
relative to it.

The *mark* is a second, optional position: the anchor of a selection.
Set the mark at point with `C-SPC` (cmd(set-mark-command)). Once the
mark is set, the *region* is the text between mark and point, shown
highlighted. While the mark is set, ordinary cursor movement *extends*
the region — point moves, the mark stays where you dropped it. The
region stays active until you clear it with `C-g` (cmd(keyboard-quit))
or make an edit.

This is a deliberate simplification of Emacs's transient-mark
distinction: in Godot the region is *sticky* once set. Two commands work
the region's ends: `C-x C-x` (cmd(exchange-point-and-mark)) swaps point
and mark, so you can jump to the other end of a selection and extend
from there; `C-x h` (cmd(mark-whole-buffer)) selects everything.

You can also select without setting the mark first, by holding Shift
while you move. The shifted motion sets the mark for you and extends as
it goes:

| Extend by | Keys |
|-----------|------|
| Character | `S-←` `S-→` / `C-S-b` `C-S-f` |
| Line | `S-↑` `S-↓` / `C-S-p` `C-S-n` / `M-S-↑` `M-S-↓` / `A-S-↑` `A-S-↓` |
| Word | `M-S-←` `M-S-→` / `A-S-←` `A-S-→` |
| To line start / end | `S-Home` `S-End` / `C-S-a` `C-S-e` |

These are separate commands (cmd(forward-char-extending),
cmd(next-line-extending), cmd(forward-word-extending), and so on) that
the keymap binds to the shifted keys; each is the plain motion with the
selection-extending flag turned on. The word-wise pair anchors the mark
on its first press and then keeps growing (or shrinking) the selection
word by word.

### Moving the cursor

Movement comes in arrow-key and Emacs (`C-`/`M-`) forms; the two
notations name the same commands, so use whichever your fingers know.

| Move by | Keys |
|---------|------|
| Character | `←` `→` / `C-b` `C-f` |
| Line | `↑` `↓` / `C-p` `C-n` |
| Word | `M-b` `M-f` / `M-←` `M-→` / `A-←` `A-→` |
| Sentence | `M-a` `M-e` |
| Paragraph | `M-{` `M-}` (cmd(backward-paragraph) / cmd(forward-paragraph)) |
| To line start / end | `Home` `End` / `C-a` `C-e` / `C-←` `C-→` |
| To buffer start / end | `C-↑` `C-↓` / `M-<` `M->` |
| To first non-blank | `M-m` (cmd(back-to-indentation)) |
| By a screenful | `C-v` `M-v` |
| To a line number | `M-g` (cmd(goto-line); the prompt counts from 1) |

A *word* is a run of word characters — letters and digits in any script,
plus underscore, so accented and non-Latin text moves naturally;
cmd(forward-word) moves to the end of the next one, cmd(backward-word)
to the start of the previous. A sentence ends at `.`, `!`, or `?`
followed by whitespace or the buffer's end. A *paragraph* is a run of
non-blank lines: cmd(forward-paragraph) (`M-}`) lands on the blank line
that ends it, cmd(backward-paragraph) (`M-{`) on the one above it.
cmd(back-to-indentation) (`M-m`) is the useful cousin of
cmd(move-beginning-of-line): it lands on the first non-blank character of
the line rather than the true start, which is usually where you want to
be.

Vertical motion aims at a *goal column*: an unbroken run of `C-n` /
`C-p` (or `↑` / `↓`) keeps heading for the column it started at, so
moving through a short line and on into a longer one restores your
original column rather than sticking where the short line cut it off
(Emacs's temporary-goal-column). Any other command clears the memory.

`C-v` and `M-v` move *point* forward and back by roughly a screenful,
the viewport following — the deliberate Emacs model, rather than
scrolling the view under a stationary cursor. `C-l` (cmd(recenter))
scrolls so the cursor's line sits in the middle of the viewport — a
quick way to see context around where you are without moving point.

Two frequent movers belong to their own chapter: incremental search
(`C-s` / `C-r`) is often the fastest way to get somewhere in a buffer,
and the replace commands (`M-r`, `M-%`) the fastest way to change what
you find — see the Search, marks, and navigation chapter.

### Inserting and deleting

Typing a printable character inserts it at point. `Backspace`
(cmd(delete-backward)) and `Delete` or `C-d` (cmd(delete-forward))
remove the character before or after the cursor — or the region, if one
is active, so you can select and delete in one stroke.

`Enter` (cmd(newline)) — `C-j` is a synonym — inserts a line break and
copies the current line's leading indentation onto the new line, so you
stay at the same indent as you type. `C-o` (cmd(open-line)) opens a
blank line *after* point without moving onto it — handy for making room
below.

`Tab` (cmd(insert-tab)) inserts indentation: a literal tab by default —
`*indent-tabs-mode*` ships on — or, with tabs turned off, `*tab-width*`
spaces (default 4). A major mode can pin either setting for its own
buffers via the `:indent-tabs?` and `:tab-width` keys on its mode map;
Makefile-mode pins tabs on, since a Makefile indented with spaces is
broken, not a style choice. (See the Modes chapter for mode-local
settings and the Customization chapter for changing the defaults.)

Typographic quotes live on the Option brackets, laid out so the
*bracket* picks the side and *Shift* picks double: `A-[` `A-]` insert
`‘` `’` (cmd(insert-single-open-quote) / cmd(insert-single-close-quote)),
and `A-S-[` `A-S-]` insert `“` `”` (cmd(insert-double-open-quote) /
cmd(insert-double-close-quote)). This replaces the macOS Option-compose
defaults, which put the double quotes on the unshifted chords.

A few commands rearrange rather than add or remove:

| Action | Key | Command |
|--------|-----|---------|
| Transpose the characters around point | `C-t` | cmd(transpose-chars) |
| Transpose the words around point | `M-t` | cmd(transpose-words) |
| Transpose this line with the one above | `C-x C-t` | cmd(transpose-lines) |
| Indent the region's lines one level | `M-]` | cmd(indent-region) |
| Outdent the region's lines one level | `M-[` | cmd(outdent-region) |
| Re-wrap the paragraph | `M-q` | cmd(fill-paragraph) |
| Comment or uncomment the current line | `C-x ;` | cmd(comment-line) |

The transpose family follows Emacs's drag model: the thing before point
is pulled forward past the thing after it, and point ends up after both,
so *repeated presses keep dragging it along*. At the end of a line,
cmd(transpose-chars) swaps the two characters before point instead —
the standard fix for a transposed pair either way — and
cmd(transpose-words) leaves the punctuation between the two words in
place.

`M-]` and `M-[` are Sublime-style block indentation: every line the
region touches (or just the cursor's line) shifts by one level — a
literal tab where the mode pins tabs, otherwise `*tab-width*` spaces.
Blank lines are never indented, and the selection survives, so
repeated presses keep shifting the same block.

cmd(fill-paragraph) (`M-q`) re-wraps the paragraph around point to a
fixed column of 72, keeping the paragraph's indentation; on a blank line
it does nothing. Note the *fixed* 72: generic `M-q` does not read
`*fill-column*` — that customizable column (`C-x f`,
cmd(set-fill-column)) is what *auto-fill-mode*, the wrap-as-you-type
minor mode, wraps at, and the LaTeX and JMarkdown modes shadow `M-q`
with structure-aware fills of their own. See the Writing prose and
Markdown chapter.

cmd(comment-line) (`C-x ;`) toggles: it adds the comment prefix of the
buffer's major mode (the `:comment-prefix` key on its mode map) if the
line lacks it, and removes it if present — so the same key comments and
uncomments.

### Changing case

| Action | Key | Command |
|--------|-----|---------|
| Uppercase to the end of the word | `M-u` | cmd(upcase-word) |
| Lowercase to the end of the word | `M-l` | cmd(downcase-word) |
| Capitalize to the end of the word | `M-c` | cmd(capitalize-word) |
| Uppercase the region | `C-x C-u` | cmd(upcase-region) |
| Lowercase the region | `C-x C-l` | cmd(downcase-region) |

The word commands convert from point to the end of the word and leave
the cursor there, so a run of `M-u` marches down the line word by word.
With an active region they convert the region instead (Emacs's *dwim*
behaviour), which usually saves reaching for the region commands at all.

### Tidying whitespace

| Action | Key | Command |
|--------|-----|---------|
| Delete the spaces and tabs around point | `M-\` | cmd(delete-horizontal-space) |
| Collapse them to a single space | `M-SPC` | cmd(just-one-space) |
| Join this line onto the previous one | `M-^` | cmd(delete-indentation) |
| Collapse surrounding blank lines to one | `C-x C-o` | cmd(delete-blank-lines) |

cmd(just-one-space) inserts a space even when there is none — it
*normalises* to exactly one. macOS claims `Cmd+Space` for Spotlight
before any app sees it, so the command is *also* bound to Hyper+Space
(`C-M-A-S-space`): a Karabiner rule shipped in
`tools/karabiner/godot-cmd-space.json` rewrites `Cmd+Space` to that
chord while the editor is frontmost, giving the real `M-SPC` key here
without losing Spotlight anywhere else (and a Karabiner *hyper* key —
fn, say — reaches it directly).

cmd(delete-indentation) (`M-^`) joins the *current* line onto the end
of the previous one — the upward twin of cmd(join-line).
cmd(delete-blank-lines) (`C-x C-o`) adapts to where it is: on a blank
line it collapses the whole run of blank lines around it to one; on the
sole blank line it deletes it; on a non-blank line it deletes the blank
lines that follow.

Godot also carries a small set of whole-line operations:

| Action | Key | Command |
|--------|-----|---------|
| Move the line up / down | `M-↑` / `M-↓` | cmd(move-line-up) / cmd(move-line-down) |
| Duplicate the line below | `C-x C-d` | cmd(duplicate-line) |
| Join the next line onto this one | `C-x C-j` | cmd(join-line) |

The movers swap the current line with its neighbour, carrying the
cursor along and keeping its column. cmd(duplicate-line) drops a copy
of the line immediately beneath and moves the cursor onto it.
cmd(join-line) pulls the next line up onto the end of this one,
collapsing the newline and the next line's leading whitespace to a
single space.

A few more line operations are unbound, reached through `M-x`.
cmd(sort-lines) sorts the lines the region touches into ascending order
(a region ending at column 0 does not pull in that final line).
cmd(tabify-region) and cmd(untabify-region) re-express the *leading*
indentation of the region's lines as tabs or as spaces, honouring the
effective tab width — interior alignment (tables, trailing comments) is
left exactly as it is; cmd(tabify-buffer) and cmd(untabify-buffer) do
the same to the whole buffer. `tabify-buffer` is the tool for retabbing
a spaces-indented file after turning `*indent-tabs-mode*` on.

### Selecting by structure

Two selection commands work by structure rather than by raw motion.
`C-=` (cmd(expand-region)) grows the region outward from point in four
fixed steps: the current word, then the current line, then the
paragraph, then the whole buffer. The chain remembers where it started —
each press grows around the original cursor position — and any other
command in between resets it, so the next `C-=` starts again at the
word. It is the quickest way to grab "the thing I'm inside" at
whichever of those sizes you need.

`ESC` (cmd(deselect)) clears the selection without the side effects of
`C-g`. For a single cursor it simply drops the region; its real use is
with multiple cursors, where it leaves the cursor set intact but turns
each selection into a bare caret — covered in the Productivity chapter.

Two more structural selectors: `M-@` (cmd(mark-word)) marks from point
to the end of the next word, and each further press extends the region
by another word; `M-h` (cmd(mark-paragraph)) selects the paragraph
around point.

### The kill ring — cut, copy, paste

Godot does not lean on the system clipboard as its primary model.
*Killed* text — cut or copied — goes onto the *kill ring*, a list of
recent kills held in the variable `*kill-ring*`, and is *yanked* (the
Emacs word for pasted) back from there. The ring remembers more than the
last thing you cut, which is what makes paste-and-cycle possible.

| Action | Key | Command |
|--------|-----|---------|
| Kill (cut) the region | `C-w` | cmd(kill-region) |
| Copy the region | `M-w` | cmd(copy-region) |
| Kill to end of line | `C-k` | cmd(kill-line) |
| Kill the next word | `M-d` | cmd(kill-word) |
| Kill the previous word | `M-Backspace` | cmd(backward-kill-word) |
| Kill the sentence | `M-k` | cmd(kill-sentence) |
| Kill the whole line, newline included | `C-S-Backspace` | cmd(kill-whole-line) |
| Kill through the next occurrence of a character | `M-x zap-to-char` | cmd(zap-to-char) |
| Yank (paste) the most recent kill | `C-y` | cmd(yank) |
| Cycle to an earlier kill | `M-y` | cmd(yank-pop) |

cmd(kill-region) (`C-w`) and cmd(copy-region) (`M-w`) act on the active
region and do nothing without one; a copy also deactivates the region
once it has copied. cmd(kill-line) (`C-k`) kills from point to the end
of the line; pressed at a line's end, it kills the newline instead, so
a run of `C-k` pulls lines up one at a time. cmd(zap-to-char) reads one
character and kills from point through its next occurrence.

Consecutive kills *accumulate*: a second kill with no other command in
between grows the same kill-ring entry rather than starting a new one
(backward kills prepend), so `C-k C-k C-k … C-y` reinserts everything
you just killed as one block. Any other command — even a cursor motion
— starts the next kill fresh. A copy never joins the accumulation:
`M-w` always pushes its own entry, and a kill right after it starts a
new one.

To paste, press `C-y` (cmd(yank)): it inserts the most recent kill at
point — or, with a region active, *replaces* the selection with it. If
the kill you want is not the latest, follow `C-y` with `M-y`
(cmd(yank-pop)): each `M-y` replaces the just-yanked text with the
*previous* kill in the ring, and repeated presses keep cycling back. This
only works immediately after a yank — once you do anything else, the
yank position is forgotten.

The ring is built to mirror the system clipboard at both ends — every
kill and copy is pushed out through a clipboard hook, and `C-y` first
pulls the clipboard in — but under the server architecture the
clipboard primitives are currently a server-local stub: everything
round-trips perfectly *inside* the editor, and nothing yet reaches the
OS clipboard. Cross-application cut and paste arrives when the
clipboard bridge lands. The ring itself is ordinary Lisp state —
inspect, rebind, or extend `*kill-ring*` like any variable.

### Undo and redo

`C-z` (cmd(undo)) reverses the last change, and `C-S-z` (cmd(redo))
reapplies one you have undone — each buffer keeps its own history. The
synonyms cover every habit: `C-x u`, `C-/`, and `C-_` (the Emacs
spellings) and `M-z` (the macOS Cmd+Z) all undo; `C-?` and `M-S-z`
redo.

One keystroke of typing is one undoable step. A command that makes
several edits under the hood groups them into a *single* step — the
transpose family, the case conversions, cmd(just-one-space),
cmd(fill-paragraph), the line movers, cmd(indent-region),
cmd(sort-lines) — so one `C-z` takes the whole command back rather
than peeling it apart edit by edit. The grouping is
a public mechanism, not host magic: wrap `atomic-change-group` around
any multi-edit command body of your own and it undoes as one step. See
the Extending Godot chapter.
