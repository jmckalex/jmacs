## Windows: panes and tabs

The editor area is not a single text box. It is a tree of rectangles
that you carve up as you work — two files side by side, a browser below
your notes, a terminal tucked into a corner. Each rectangle is a
**pane**, and a pane can stack several documents as **tabs**. This
chapter explains how the two fit together and which keys reshape them.
It closes with the machinery one level up: real OS windows, and the
workspaces that remember an arrangement between launches.

The notation is the manual's throughout: `C-` is Control, `M-` is
Command, `A-` is Option, `S-` is Shift — the Keys chapter has the full
story. The pane keys all live under the `C-x` prefix, in deliberate
echo of Emacs — if your fingers know `C-x 2` and `C-x o`, they already
know most of this chapter.

### Panes and tabs

A **pane** is a rectangle of the editor area that shows one view at a
time. A **view** is whatever you are looking at — a text file, an image,
a browser, a directory listing, a shell. (Views in their own right are
the subject of the Views chapter; here they are simply the things panes
hold.)

A pane begins life holding a single view directly. A pane can also
carry a **tabline**: a strip of tabs along its top edge, one tab per
view, with the active view filling the space below. Only the active
tab's view is visible; the others wait in the strip. A pane with a
tabline is no less a pane — it is the same rectangle, now able to hold
a small pile of views and let you flip between them. A tabline is
something you (or a project workspace) create deliberately; the
*Tablines* section below covers how.

So there are two axes of organisation, and they compose:

- **Splitting** divides the editor area into more panes, each its own
  rectangle on screen at once.
- **Tabs** stack several views inside *one* pane, only one showing at a
  time.

Reach for a split when you want to see two things together; reach for a
tab when you want a second thing in the same place without giving up the
room.

One pane-like occupant is special: the **minimap** companion
(`C-x m`, cmd(toggle-minimap)) attaches a narrow code-overview pane
beside the editing pane. It occupies a pane slot, but it is not a peer:
it never takes keyboard focus — `C-x o` skips it, clicks on it navigate
the editor instead — and deleting its target pane removes the companion
along with it.

### Splitting a pane

Two commands divide the current pane in two. In each, **focus moves to
the new pane**, which opens showing the *same buffer* as the pane you
split — Emacs's `split-window` semantics. The new pane's point and
scroll are seeded from the original, so immediately after the split the
two panes look identical; they diverge as soon as you move. There is no
prompt and nothing to answer: split first, then put what you want in
the new pane (`C-x C-f`, `C-x b`).

Split the pane top-and-bottom with `C-x 2` (cmd(split-vertical)). The
new pane appears *below* by default; with a `C-u` prefix argument it
appears *above*.

Split the pane side-by-side with `C-x 3` (cmd(split-horizontal)). The
new pane appears to the *right* by default; with a `C-u` prefix it
appears to the *left*.

(The horizontal/vertical naming follows Emacs: `C-x 2` stacks panes
vertically — one on top of another — and `C-x 3` ranges them
horizontally, side by side. The digit, not the word, is the thing to
remember. And a note on `C-u` itself: a single press sets a boolean
"argument present" that the next command reads — the numeric multi-press
of Emacs, `C-u 4`, is not supported.)

A split is purely structural. The two resulting panes share their
parent's space evenly, divided by a draggable splitter — grab the seam
between two panes and drag to change the ratio. To reset every split in
the window to an even half-and-half, run cmd(balance-panes).

### Moving focus between panes

The simplest way around is to cycle. `C-x o` (cmd(other-pane)) moves
focus to the next pane in **display order**, wrapping around at the
end. Display order is the split tree's leaf order — each split
contributes its top or left half before its bottom or right half — which
for everyday layouts reads top-left to bottom-right. Press `C-x o`
repeatedly to visit every pane in turn (skipping a minimap companion,
which cannot take focus).

When you know *where* the pane you want is rather than its place in the
cycle, move directionally instead:

- cmd(focus-pane-left) — `C-x C-left`
- cmd(focus-pane-right) — `C-x C-right`
- cmd(focus-pane-up) — `C-x C-up`
- cmd(focus-pane-down) — `C-x C-down`

Each focuses the pane immediately in that direction, if one exists, and
does nothing if the edge is in the way. (The plain `C-x left` and
`C-x right` are taken — they cycle *views* within the pane,
cmd(previous-view) and cmd(next-view); see the Views chapter — so
spatial navigation uses `C-x C-arrow`, with Control held for both keys.
`C-x up` and `C-x down` are unbound.)

You can also simply click in a pane to focus it.

Whether the focused pane advertises itself with a border is a policy,
not a fact: the customizable variable `*pane-focus-border*` is one of
`auto` (the default — draw the border only when more than one pane can
actually take focus, so a single editing surface stays quiet), `on`
(always draw it), or `off` (never). See the Customization chapter for
how to set it.

### Deleting a pane and closing a tab

There are two distinct operations here, and the difference is worth
keeping straight: **deleting a pane** removes a rectangle from the
layout; **killing a view** removes the document itself. The pane
commands never destroy a view; the tab's × control (by default) and
`C-x k` do.

Delete the current pane with `C-x 0` (cmd(delete-pane)). Its parent
split collapses into the sibling pane, which expands to fill the freed
space. The view that pane was showing is *not* destroyed — it stays
alive in the global view list, reachable again through `C-x b`
(cmd(switch-view)) or the View List (`C-x C-b`). When the current pane
is the only one in the window, there is nothing to collapse into and
the command does nothing. cmd(close-pane) is an alias for the same
thing, named for users who think of it as "close this, but don't throw
it away."

Delete every *other* pane with `C-x 1` (cmd(delete-other-panes)),
leaving the current one to fill the whole editor area. The other panes'
views, again, stay alive in the list.

When the pane you delete with `C-x 0` holds a tabline, the whole strip
goes with the rectangle — but nothing is killed: every tab's buffer
remains in the buffer list, and `C-x b` brings any of them back.
Deleting a pane is layout surgery, nothing more.

To close a single **tab** rather than a whole pane, click the tab's
**× control**. What that does is governed by the customizable variable
`*close-tab-kills-view*`, and the default is the strong sense: the view
is **killed** — its buffer leaves the buffer list, as most editors do.
Set the variable to `#f` if you would rather the × merely *un-curate*:
the tab leaves this pane's strip, but the buffer lives on, reachable
through `C-x C-b` or `C-x b`. A live-process view (a shell, a gnuplot
session) is reaped on close either way — closing its tab ends the
process. Closing the *last* tab in a pane collapses the tabline to a
bare leaf showing `*scratch*` (an existing empty scratch is reused
rather than minting `*scratch*<2>`), with the closed buffer killed or
kept by the same rule. No key is bound to closing a tab — `Cmd+W`
reaches the editor as `M-w`, which is cmd(copy-region) — the × is the
gesture.

To remove the *view itself* from anywhere — to kill the document and
reclaim its resources — use `C-x k` (cmd(kill-view)).

### The add-pane mode

Splitting always divides the *current* pane. When you want to insert a
pane somewhere specific in a more elaborate layout, enter the visual
**add-pane** mode with `C-x +` (cmd(add-pane)).

The command lays an overlay over the editor area that highlights every
splitter seam and the four outer borders. Click one to insert a fresh
pane there:

- **Click a splitter** between two panes to insert a new sibling along
  that split's axis — two panes become three, equally sized.
- **Click an outer border** to wrap the whole existing layout in a new
  outer split, with the fresh pane occupying that side.

The new pane shows the focused pane's buffer, exactly as a split does,
and takes focus so you can put something else there straight away.
Press Escape — or the entry chord `C-x +` again — to cancel without
inserting anything.

### Rearranging panes

Splitting and deleting change *how many* panes there are. A separate
family of commands changes *which view sits in which pane*, leaving the
layout and pane sizes untouched — only the contents trade places. (These
are frame-moves: a pane keeps its rectangle and its size; the view
slides from one frame to another. A browser, PDF, or shell pane survives
the move intact.)

#### Swapping with the next pane

cmd(swap-with-other-pane) exchanges the views shown in the current pane
and the next one in display order. It is bound to `C-x X` — the literal
capital `X`, typed Shift+x, in the `C-x` map. (A shifted printable
normalises to the capital letter itself, not to `S-x`; the `S-` prefix
belongs to named keys like `S-left`.) The two panes keep their
identities and sizes; only their contents swap. The command does
nothing when there is just one pane.

Its companion cmd(send-view-to-other-pane) (`C-x x`) — *move* the
focused view to the next pane instead of swapping — predates the
server architecture and is currently out of order: pressing it does
nothing visible (the failure is logged to the console only). Until it
is re-ported, get the same effect by hand: focus the destination pane
and switch to the buffer there with `C-x b`.

#### Numbered swap and permute

For windows with more than two panes, two commands let you name panes by
number and move views among them. Both number every pane with a badge in
its top-left corner (a clockwise spiral from the top-left pane) and read
the move from the keyboard.

cmd(swap-views) numbers the panes, then asks you to type two pane
numbers and press Enter; the two panes' views trade places. cmd(permute-views)
reads a destination for pane 1, pane 2, and so on in turn — the last is
filled in automatically — and applies the whole rearrangement at once,
so you can rotate three or more panes' contents around in a single
gesture. In both, Space confirms an ambiguous number, Delete steps back,
and Escape cancels. Each is a no-op with fewer than two panes.

These two commands are **not bound to keys by default**. They live on
the **View menu** ("Swap Views…", "Permute Views…"), and you would
usually reach them there — deliberately, because a focused browser pane
(an Electron `<webview>`) swallows every keystroke, and the menu's
dispatch focuses the editor first, releasing that key grab so the digit
capture can run. Bind them yourself if you prefer keys; the menu path is
the one that works from anywhere.

### Tablines

When a pane carries a **tabline** you see a strip of tabs along its top
edge, one per view, with the active view's content below. Each pane
carries its own tabline, independent of the others.

A pane does not grow a tabline just because a second buffer comes along
— you create one deliberately. cmd(toggle-tabline) (on `M-x`; unbound
by default) flips the focused pane between a plain single view and a
tabline. Toggled on, the strip starts with the pane's current view as
its only tab; from then on, every buffer you open or switch to in that
pane — `C-x C-f`, `C-x b`, a pick from the View List — joins the strip
as a tab and becomes the active one. Toggled off, the strip disappears
and the pane keeps showing its active view; the other tabs leave the
strip with their buffers untouched in the buffer list. Opening a
project (`C-x C-p`, cmd(find-project)) builds a tabline over the
project's files for you.

Click a tab to make it active; click its **× control** to close it —
with the kill-by-default semantics described in *Deleting a pane and
closing a tab* above.

**Reorder tabs by dragging.** Pick up a tab and drop it elsewhere in the
strip to change the order; the active tab stays active wherever it
lands.

### Real windows: the `C-x 5` family

Everything so far happens inside one OS window. The `C-x 5` prefix —
Emacs's frame prefix — manages the windows themselves:

- `C-x 5 2` (cmd(new-window)) — open another editor window.
- `C-x 5 0` (cmd(close-window)) — close *this* window.
- `C-x 5 1` (cmd(close-other-windows)) — close every window but this
  one.

All windows are thin clients of the same central server: they share one
set of buffers, one Lisp world, one kill ring. Each window has its own
pane tree and its own tablines — the *arrangement* is per-window; the
*content* is shared. Closing a window therefore loses nothing: its
buffers live in the server and remain reachable from any surviving
window. Only quitting the app (`C-x C-c`) runs the unsaved-changes
confirmation.

### Workspaces remember the arrangement

A layout you have carved — windows, panes, splits, tablines, geometry —
is worth keeping. When you quit with `C-x C-c`, the editor offers to
remember the current **workspace**: type a name at the
"Remember this workspace as" prompt to save it (leave it empty to
decline), and it appears in the launch picker next time. A workspace
records the *arrangement*, not live state: files reopen from disk, a
shell or gnuplot pane reopens with a fresh process in the same place,
and a browser pane reopens at its last URL.

### Key summary

| Key | Command | Action |
|-----|---------|--------|
| `C-x 2` | cmd(split-vertical) | Split top-and-bottom (`C-u`: new pane above) |
| `C-x 3` | cmd(split-horizontal) | Split side-by-side (`C-u`: new pane left) |
| `C-x 0` | cmd(delete-pane) | Delete this pane; sibling expands |
| `C-x 1` | cmd(delete-other-panes) | This pane fills the window |
| `C-x o` | cmd(other-pane) | Focus the next pane in display order |
| `C-x C-left` etc. | cmd(focus-pane-left) … | Focus the pane in that direction |
| `C-x +` | cmd(add-pane) | Visual insert-a-pane mode |
| `C-x X` | cmd(swap-with-other-pane) | Swap contents with the next pane |
| `C-x k` | cmd(kill-view) | Kill the view itself |
| `C-x m` | cmd(toggle-minimap) | Toggle the minimap companion |
| `C-x 5 2` | cmd(new-window) | Open another OS window |
| `C-x 5 0` | cmd(close-window) | Close this window |
| `C-x 5 1` | cmd(close-other-windows) | Close every other window |
| — | cmd(balance-panes) | Reset every split to half-and-half |
| — | cmd(toggle-tabline) | Give the focused pane a tabline, or take it away |
