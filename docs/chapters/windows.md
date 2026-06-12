## Windows: panes and tabs

The editor area is not a single text box. It is a tree of rectangles
that you carve up as you work — two files side by side, a browser below
your notes, a terminal tucked into a corner. Each rectangle is a
**pane**, and a pane can stack several documents as **tabs**. This
chapter explains how the two fit together and which keys reshape them.

The notation is the manual's throughout: `C-` is Control or Command,
`M-` is Option, `S-` is Shift. The pane keys all live under the `C-x`
prefix, in deliberate echo of Emacs — if your fingers know
`C-x 2` and `C-x o`, they already know most of this chapter.

### Panes and tabs

A **pane** is a rectangle of the editor area that shows one view at a
time. A **view** is whatever you are looking at — a text file, an image,
a browser, a directory listing, a shell. (Views in their own right are
the subject of the next chapter; here they are simply the things panes
hold.)

A pane begins life holding a single view directly. When you stack more
than one view in the same pane, the pane grows a **tabline**: a strip of
tabs along one edge, one tab per view, with the active view filling the
space below. Only the active tab's view is visible; the others wait in
the strip. A pane with a tabline is no less a pane — it is the same
rectangle, now able to hold a small pile of views and let you flip
between them.

So there are two axes of organisation, and they compose:

- **Splitting** divides the editor area into more panes, each its own
  rectangle on screen at once.
- **Tabs** stack several views inside *one* pane, only one showing at a
  time.

Reach for a split when you want to see two things together; reach for a
tab when you want a second thing in the same place without giving up the
room.

### Splitting a pane

Two commands divide the current pane in two. In each, **focus moves to
the new pane**, which opens showing a *placeholder* chooser — a short
prompt asking what the fresh pane should hold: open a file, clone the
view you split from, start a new file, or run a command. Pressing Enter
takes the default action, which is to clone the originating view; you
can change that default (see *The placeholder* below).

Split the pane top-and-bottom with `C-x 2` (cmd(split-vertical)). The
new pane appears *below* by default; with a `C-u` prefix argument it
appears *above*.

Split the pane side-by-side with `C-x 3` (cmd(split-horizontal)). The
new pane appears to the *right* by default; with a `C-u` prefix it
appears to the *left*.

(The horizontal/vertical naming follows Emacs: `C-x 2` stacks panes
vertically — one on top of another — and `C-x 3` ranges them
horizontally, side by side. The digit, not the word, is the thing to
remember.)

A split is purely structural. The two resulting panes share their
parent's space evenly, divided by a draggable splitter — grab the seam
between two panes and drag to change the ratio. To reset every split in
the window to an even half-and-half, run cmd(balance-panes).

#### The placeholder

When a split creates a fresh pane, the pane does not silently copy your
current document into it. Instead it shows a chooser offering four
actions: **open** a file, **clone** the view you split from, start a
**new** file, or run a **command**. The new pane takes focus, so the
keyboard is ready to answer.

What Enter does in that chooser is governed by the customizable variable
`*placeholder-default-action*` — one of `open`, `clone` (the default),
`new`, `command`, or `none` (Enter does nothing). Set it from your init
or via the customize interface if you would rather a fresh split start
empty, or always offer a file prompt.

### Moving focus between panes

The simplest way around is to cycle. `C-x o` (cmd(other-pane)) moves
focus to the next pane in display order, wrapping around at the end.
Press it repeatedly to visit every pane in turn.

When you know *where* the pane you want is rather than its place in the
cycle, move directionally instead:

- cmd(focus-pane-left) — `C-x C-left`
- cmd(focus-pane-right) — `C-x C-right`
- cmd(focus-pane-up) — `C-x C-up`
- cmd(focus-pane-down) — `C-x C-down`

Each focuses the pane immediately in that direction, if one exists, and
does nothing if the edge is in the way. (The plain `C-x` arrows are
taken — they switch *views*, the subject of the next chapter — so
spatial navigation uses `C-x C-arrow`, with Control held for both keys.)

You can also simply click in a pane to focus it.

### Deleting a pane and closing a tab

There are two distinct operations here, and the difference is worth
keeping straight: **closing a pane** removes a rectangle from the
layout; **killing a view** removes the document itself. The editor keeps
them separate so that rearranging your windows never throws work away.

Delete the current pane with `C-x 0` (cmd(delete-pane)). Its parent
split collapses into the sibling pane, which expands to fill the freed
space. The view that pane was showing is *not* destroyed — it stays
alive in the global view list, reachable again through `C-x b`
(switch-view) or the buffer menu. When the current pane is the only one
in the window, there is nothing to collapse into and the command does
nothing. cmd(close-pane) is an alias for the same thing, named for users
who think of it as "close this, but don't throw it away."

Delete every *other* pane with `C-x 1` (cmd(delete-other-panes)),
leaving the current one to fill the whole editor area. The other panes'
views, again, stay alive in the list.

To close a single tab rather than a whole pane, use cmd(close-tab),
bound to **Cmd+W**. It removes the active tab from the focused pane's
tabline; the view leaves the strip but stays alive in the global list.
When that was the *last* tab in the pane, the pane collapses into its
sibling, exactly as `close-pane` would — and at the sole root pane, with
nowhere to collapse, the last tab simply stays put.

To remove the *view itself* — to kill the document and reclaim its
resources — use `C-x k` (kill-view) instead. The pane commands above are
the lighter touch; `C-x k` is the one that throws something away.

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

The new pane shows the same placeholder chooser as a split, and takes
focus so you can answer it straight away. Press Escape — or the entry
chord `C-x +` again — to cancel without inserting anything.

### Rearranging panes

Splitting and deleting change *how many* panes there are. A separate
family of commands changes *which view sits in which pane*, leaving the
layout and pane sizes untouched — only the contents trade places. (These
are frame-moves: a pane keeps its rectangle and its size; the view
slides from one frame to another. A browser, PDF, or shell pane survives
the move intact.)

#### Sending and swapping with the next pane

cmd(send-view-to-other-pane) sends the focused view to the next pane in
display order, as a tab; it is bound to `C-x x`. Both panes become
tablines as needed, and the view lands as the active tab in the
destination. cmd(send-tab-to-other-pane) is an alias for the same
action. If the source pane had only that one view, its strip empties and
the pane will collapse.

cmd(swap-with-other-pane) exchanges the views shown in the current pane
and the next one, bound to `C-x X` (that is `C-x S-x`). The two panes
keep their identities and sizes; only their contents swap. Both commands
do nothing when there is just one pane.

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
(an Electron `<webview>`) swallows `C-x` chords, and the menu's dispatch
focuses the editor first, releasing that key grab so the digit capture
can run. Bind them yourself if you prefer keys; the menu path is the one
that works from anywhere.

### Tablines

When a pane holds more than one view, it shows a **tabline**: a strip of
tabs, one per view, with the active view's content below. Click a tab to
make it active; click its close control to close it (the same lighter
"close, don't kill" sense as `Cmd+W`). Each pane carries its own
tabline, independent of the others.

**Reorder tabs by dragging.** Pick up a tab and drop it elsewhere in the
strip to change the order.

You can choose which edge of the pane the strip sits on. By default it
runs along the **top**; the commands cmd(tabline-edge-top),
cmd(tabline-edge-bottom), cmd(tabline-edge-left), and
cmd(tabline-edge-right) move it to any edge of the focused pane. The
left and right layouts stack the tabs column-wise, with labels kept
upright (no sideways text). These commands act only on a pane that holds
a tabline, and do nothing otherwise; none is bound to a key by default.

A pane gains its tabline as soon as a second view joins it — for
instance when cmd(send-view-to-other-pane) delivers one. You can also
request it explicitly: cmd(promote-to-tabline) wraps the current pane's
single view in a tabline (with that view as the sole tab), and
cmd(demote-tabline) reverses the operation, replacing the tabline with
its active child's view and returning the pane to a plain leaf. Demoting
drops the other tabs *from the pane* — their views remain in the global
list and `C-x b` brings them back. Both are unbound by default; promotion
and demotion are deliberate acts, not something the editor does behind
your back.
