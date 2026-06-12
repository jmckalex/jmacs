## Basic editing

Everything jmacs does to text, it does to a *buffer*. This chapter is
the ground floor: what a buffer is, how the cursor and the selection
work, how you move, insert, and delete, how cut-copy-paste works through
the kill ring, and how to take a change back. None of it is baked into
the host — every command named here is ordinary Lisp in the standard
library (`editing.lisp`, `kill.lisp`, and their neighbours), so every
one is yours to rebind or redefine. Later chapters build on this one;
this is the vocabulary the rest of the editor assumes you already speak.

The notation is the manual's throughout: `C-` is Control or Command,
`M-` is Option, `S-` is Shift.

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
These conventions hold everywhere, from the storage layer up through the
Lisp, so a position you read in one place means the same thing in
another.

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
distinction: in jmacs the region is *sticky* once set. Two commands work
the region's ends: `C-x C-x` (cmd(exchange-point-and-mark)) swaps point
and mark, so you can jump to the other end of a selection and extend
from there; `C-x h` (cmd(mark-whole-buffer)) selects everything.

You can also select without setting the mark first, by holding Shift
while you move — `S-→`, `S-↓`, and the rest. The shifted motion sets the
mark for you and extends as it goes. These are separate commands
(cmd(forward-char-extending), cmd(next-line-extending), and so on) that
the keymap binds to the shifted keys; each is the plain motion with the
selection-extending flag turned on.

### Moving the cursor

Movement comes in arrow-key and Control-key forms; the Control forms
follow Emacs, so the two notations name the same commands.

| Move by | Keys |
|---------|------|
| Character | `←` `→` / `C-b` `C-f` |
| Line | `↑` `↓` / `C-p` `C-n` |
| Word | `M-f` `M-b` |
| Sentence | `M-e` `M-a` |
| To line start / end | `Home` `End` / `C-a` `C-e` / `C-←` `C-→` |
| To buffer start / end | `C-↑` `C-↓` / `M-<` `M->` |
| To first non-blank | `M-m` (cmd(back-to-indentation)) |
| By a screenful | `C-v` `M-v` |
| To a line number | `M-g` (cmd(goto-line)) |

A *word* is a run of word characters, decided by the buffer layer rather
than guessed at; cmd(forward-word) moves to the end of the next one,
cmd(backward-word) to the start of the previous. A sentence ends at `.`,
`!`, or `?` followed by whitespace or the buffer's end.
cmd(back-to-indentation) (`M-m`) is the useful cousin of
cmd(move-beginning-of-line): it lands on the first non-blank character of
the line rather than the true start, which is usually where you want to
be.

`C-l` (cmd(recenter)) scrolls so the cursor's line sits in the middle of
the viewport — a quick way to see context around where you are without
moving point.

### Inserting and deleting

Typing a printable character inserts it at point. `Backspace`
(cmd(delete-backward)) and `Delete` or `C-d` (cmd(delete-forward))
remove the character before or after the cursor — or the region, if one
is active, so you can select and delete in one stroke.

`Enter` (cmd(newline)) inserts a line break and copies the current
line's leading indentation onto the new line, so you stay at the same
indent as you type. `C-o` (cmd(open-line)) opens a blank line *after*
point without moving onto it — handy for making room below. `Tab`
(cmd(insert-tab)) inserts indentation: by default two spaces, but a
literal tab where the major mode or your settings call for one (a
Makefile, for instance, always gets a real tab).

A few commands rearrange rather than add or remove:

| Action | Key | Command |
|--------|-----|---------|
| Transpose the two characters before point | `C-t` | cmd(transpose-chars) |
| Re-wrap the paragraph to the fill column | `M-q` | cmd(fill-paragraph) |
| Comment or uncomment the current line | `C-x ;` | cmd(comment-line) |

cmd(transpose-chars) (`C-t`) swaps the two characters before the cursor
— the standard fix for a transposed pair. cmd(fill-paragraph) (`M-q`)
re-wraps the paragraph around point to the fill column (72), keeping the
paragraph's indentation; it does nothing on a blank line. cmd(comment-line)
(`C-x ;`) toggles: it adds the comment prefix of the buffer's major mode
if the line lacks it, and removes it if present — so the same key
comments and uncomments.

jmacs also carries a small set of whole-line operations:

| Action | Key | Command |
|--------|-----|---------|
| Move the line up / down | `M-↑` / `M-↓` | cmd(move-line-up) / cmd(move-line-down) |
| Duplicate the line below | `C-x C-d` | cmd(duplicate-line) |
| Join the next line onto this one | `C-x C-j` | cmd(join-line) |

cmd(move-line-up) and cmd(move-line-down) swap the current line with the
one above or below, carrying the cursor with it and keeping its column.
cmd(duplicate-line) drops a copy of the line immediately beneath it.
cmd(join-line) pulls the next line up onto the end of this one,
collapsing the newline and the next line's leading whitespace to a
single space.

### Selecting by structure

Two selection commands work by structure rather than by raw motion.
`C-=` (cmd(expand-region)) grows the region outward from point in
syntactic steps — word, then the construct around it, then the next
construct out — so repeated presses select progressively larger,
balanced spans. It is the quickest way to grab "the thing I'm inside,"
whatever size that turns out to be.

`ESC` (cmd(deselect)) clears the selection without the side effects of
`C-g`. For a single cursor it simply drops the region; its real use is
with multiple cursors, where it leaves the cursor set intact but turns
each selection into a bare caret — covered in the Productivity chapter.

### The kill ring — cut, copy, paste

jmacs does not lean on the system clipboard as its primary model.
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
| Yank (paste) the most recent kill | `C-y` | cmd(yank) |
| Cycle to an earlier kill | `M-y` | cmd(yank-pop) |

cmd(kill-region) (`C-w`) and cmd(copy-region) (`M-w`) act on the active
region and do nothing without one. cmd(kill-line) (`C-k`) kills from
point to the end of the line; pressed at a line's end, it kills the
newline instead, so a run of `C-k` pulls lines up one at a time.

To paste, press `C-y` (cmd(yank)): it inserts the most recent kill at
point. If the kill you want is not the latest, follow `C-y` with `M-y`
(cmd(yank-pop)): each `M-y` replaces the just-yanked text with the
*previous* kill in the ring, and repeated presses keep cycling back. This
only works immediately after a yank — once you do anything else, the
yank position is forgotten.

Although the kill ring is jmacs's own model, it is wired to the system
clipboard at both ends. Every kill and copy is mirrored out to the system
clipboard, so what you cut here can be pasted into another application;
and `C-y` first pulls in the system clipboard, so text you copied
elsewhere yanks straight in. The ring is otherwise ordinary Lisp state —
inspect, rebind, or extend `*kill-ring*` like any variable.

### Undo and redo

`C-z` (cmd(undo)) reverses the last change; `C-S-z` (cmd(redo))
reapplies one you have undone. Undo is currently per-edit — one keystroke
is one undoable step — with one deliberate exception: a snippet expansion
is grouped as a single step, so one `C-z` removes its whole body at once.
Command-level grouping for ordinary editing is a planned addition at the
buffer layer.
