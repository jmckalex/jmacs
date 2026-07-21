Title: Godot Pane & Window Commands
Author: J. McKenzie Alexander
Date: 2026-07-21
---

## Pane and window commands

This document describes every command for managing the editor's visual
layout — the *panes* that divide the editor area, the *tablines* that
stack several views in one pane, and the OS *windows* one level up. The
pane commands are ordinary Lisp commands defined in `panes.lisp`; the
view-switching and window commands are `defcommand`s embedded directly
in the Lisp server (the *spine*), documented here alongside them. Each
wraps a host primitive that mutates the server's pane model.

A *pane* is a leaf of a window's binary split tree; each holds one view.
A *view* is an on-screen surface — a text buffer, an image, a shell, a
PDF, a directory tree, and so on (the non-text kinds are documented in
`views.md`). A pane can carry a *tabline*: a strip of tabs, one per
view, with the active view filling the space below.

One architectural fact explains the rest: all layout state lives in the
central Lisp server. Each window owns its own pane tree and tablines —
the *arrangement* is per-window — while the buffers themselves are
shared across every window. Splitting a pane changes only the window you
are looking at; killing a view removes it everywhere. The narrative tour
is the manual's Windows chapter; `docs/VIEWS.md` and
`docs/MODEL-B-DISPATCH.md` are the playbooks behind it.

Key bindings are given in the manual's notation: `C-` is Control, `M-`
is Command (the Meta of Emacs custom), `A-` is Option, `S-` is Shift.
Arrow keys are spelled out (`C-x C-left`), matching what
cmd(describe-key) echoes. A few commands here are deliberately bound
not on a key but in the **View menu** (a focused browser `<webview>`
swallows `C-x` chords, so the menu is the reliable route), and a few
are unbound entirely — runnable by name with `M-x` or from the REPL.
Each entry says which. See `index.md` for how to read an entry.

---

### Splitting and focus

Defined in `panes.lisp`. Splitting a pane moves focus to the new pane,
which opens showing the *same buffer* as the pane you split — Emacs's
`split-window` semantics. The new pane's point and scroll are seeded
from the original, so the two panes look identical until you move; there
is no prompt to answer. Split first, then put what you want in the new
pane (`C-x C-f`, `C-x b`).

The split commands read the `C-u` prefix. A single `C-u` sets a boolean
"argument present" that the next command consumes; the numeric
multi-press of Emacs (`C-u 3 C-x 2`) is not supported.

:::function{name="split-vertical" path="reference/panes/split-vertical.html"}
#### `split-vertical`
`(split-vertical)`

Split the current pane top-and-bottom; focus moves to the new pane,
which shows the same buffer. With no prefix-arg the new pane appears
*below*; with a `C-u` prefix it appears *above*. Bound to `C-x 2`. See
also cmd(split-horizontal).
:::

:::function{name="split-horizontal" path="reference/panes/split-horizontal.html"}
#### `split-horizontal`
`(split-horizontal)`

Split the current pane side-by-side; focus moves to the new pane, which
shows the same buffer. With no prefix-arg the new pane appears to the
*right*; with a `C-u` prefix it appears to the *left*. Bound to
`C-x 3`. See also cmd(split-vertical).
:::

:::function{name="add-pane" path="reference/panes/add-pane.html"}
#### `add-pane`
`(add-pane)`

Enter the visual add-pane mode. An overlay highlights every splitter and
the four outer borders of the editor area; click one to insert a fresh
pane there. Clicking a splitter inserts a new sibling along that split's
axis (two panes become three, equally sized); clicking a border wraps
the existing layout in a new outer split, with the fresh pane occupying
that side. The new pane shows the focused pane's buffer — exactly as a
split does — and takes focus. Escape, or re-pressing the entry chord,
cancels without inserting. Bound to `C-x +`.
:::

:::function{name="balance-panes" path="reference/panes/balance-panes.html"}
#### `balance-panes`
`(balance-panes)`

Reset every split's ratio to 0.5 so panes share their parent's space
evenly — the keyboard's answer to having dragged the splitters into a
mess. Unbound — run with `M-x` or from the REPL.
:::

:::function{name="other-pane" path="reference/panes/other-pane.html"}
#### `other-pane`
`(other-pane)`

Cycle focus to the next pane in display order, wrapping at the end.
Display order is the split tree's leaf order, which for everyday
layouts reads top-left to bottom-right. A minimap companion pane is
skipped — it never takes focus (see cmd(toggle-minimap)). Bound to
`C-x o`. See also cmd(focus-pane-left).
:::

:::function{name="focus-pane-left" path="reference/panes/focus-pane-left.html"}
#### `focus-pane-left`
`(focus-pane-left)`

Focus the pane immediately to the left of the current one; does nothing
when the window's edge is in the way. Bound to `C-x C-left`. See also
cmd(focus-pane-right), cmd(other-pane).
:::

:::function{name="focus-pane-right" path="reference/panes/focus-pane-right.html"}
#### `focus-pane-right`
`(focus-pane-right)`

Focus the pane immediately to the right of the current one, if any.
Bound to `C-x C-right`. See also cmd(focus-pane-left).
:::

:::function{name="focus-pane-up" path="reference/panes/focus-pane-up.html"}
#### `focus-pane-up`
`(focus-pane-up)`

Focus the pane immediately above the current one, if any. Bound to
`C-x C-up`. See also cmd(focus-pane-down).
:::

:::function{name="focus-pane-down" path="reference/panes/focus-pane-down.html"}
#### `focus-pane-down`
`(focus-pane-down)`

Focus the pane immediately below the current one, if any. Bound to
`C-x C-down`. See also cmd(focus-pane-up).
:::

:::function{name="*pane-focus-border*" path="reference/panes/pane-focus-border.html"}
#### `*pane-focus-border*`

Whether the active pane draws a focus border. A `defcustom` in the
`panes` group, one of three symbols:

- `'auto` — draw it only when more than one pane is focusable, so a
  single editing surface (an unsplit window, or a project whose only
  peers are passive sidebars) shows none. The default.
- `'on` — always draw it.
- `'off` — never draw it.

A change reaches open windows on the next chrome push rather than
instantly. The policy itself is the `pane-focus-border-setting`
procedure in `panes.lisp`; redefine that to override it entirely.
:::

### Closing panes and tabs

Defined in `panes.lisp`, with the tab-close semantics owned by the
server. Godot distinguishes three strengths of "get rid of this":

- **Deleting a pane** (`C-x 0`) is layout surgery — the rectangle
  collapses into its sibling and every view stays alive in the buffer
  list. The same split Emacs makes with `delete-window`.
- **Killing a view** (`C-x k`, cmd(kill-view)) removes the view itself,
  from every window. Emacs's `kill-buffer`.
- **Closing a tab** (the tab's **× control**) sits between the two, and
  which way it leans is governed by `*close-tab-kills-view*` — by
  default it kills.

:::function{name="delete-pane" path="reference/panes/delete-pane.html"}
#### `delete-pane`
`(delete-pane)`

Delete the current pane — collapse its parent split into its sibling. A
no-op when the current pane is the only one in the window. The view
stays alive in the buffer list; when the pane holds a tabline, the
whole strip goes with the rectangle but nothing is killed — every tab's
buffer remains reachable via `C-x b`. Bound to `C-x 0`. See also
cmd(close-pane), cmd(delete-other-panes).
:::

:::function{name="close-pane" path="reference/panes/close-pane.html"}
#### `close-pane`
`(close-pane)`

Close the current pane, collapsing its parent split into its sibling
while keeping every view alive — the view is reachable afterwards via
cmd(switch-view) or cmd(list-views). Same effect as cmd(delete-pane),
under the lighter everyday name; to remove the view itself use
cmd(kill-view). Unbound — run with `M-x` or from the REPL.
:::

:::function{name="delete-other-panes" path="reference/panes/delete-other-panes.html"}
#### `delete-other-panes`
`(delete-other-panes)`

Make the current pane fill the editor area, disposing every other pane
in this window. The disposed panes' views stay alive in the buffer
list. Bound to `C-x 1`. See also cmd(delete-pane).
:::

:::function{name="close-tab" path="reference/panes/close-tab.html"}
#### `close-tab`

Close a tab in the focused tabline — the operation behind the tab's
**× control**, which is the way to invoke it (no key is bound; `Cmd+W`
reaches the editor as `M-w`, cmd(copy-region)). What closing does is
governed by `*close-tab-kills-view*`; by default the view is **killed**
— its buffer leaves the buffer list, as most editors do. Closing the
*last* tab collapses the tabline to a bare leaf showing `*scratch*` (an
existing empty scratch is reused rather than minting `*scratch*<2>`),
with the closed buffer killed or kept by the same rule. A live-process
view (a shell or gnuplot session) is reaped on close either way.

The `M-x close-tab` command in `panes.lisp` predates the
server-owned tabline and is currently out of order — it signals an
error rather than closing anything. Use the × control.
:::

:::function{name="close-tab-kills-view" path="reference/panes/close-tab-kills-view.html"}
#### `*close-tab-kills-view*`

Whether closing a tab (its × control) kills the underlying view. A
boolean `defcustom` in the `panes` group, default `#t`: the buffer is
removed from the buffer list, as most editors do. Set it to `#f` to
restore the older *un-curate* behaviour — the tab leaves this pane's
strip, but the buffer lives on, reachable through `C-x C-b` or
`C-x b`. A live-process view (shell / gnuplot) is reaped on close
either way.
:::

### Rearranging

These change *which view sits in which pane*, leaving the layout and
pane sizes untouched — frame-moves: a pane keeps its rectangle, the
contents trade places, and a browser, PDF, or shell pane survives the
move intact. The "other pane" is the next leaf in display order; each
command is a no-op with fewer than two panes.

:::function{name="swap-with-other-pane" path="reference/panes/swap-with-other-pane.html"}
#### `swap-with-other-pane`
`(swap-with-other-pane)`

Swap the views shown in the current pane and the next pane in display
order. Both panes keep their identity and size; only their views
exchange. A no-op when there is only one pane. Bound to `C-x X` — the
literal capital X, typed Shift+x, in the `C-x` map. See also
cmd(swap-views), cmd(send-view-to-other-pane).
:::

:::function{name="send-view-to-other-pane" path="reference/panes/send-view-to-other-pane.html"}
#### `send-view-to-other-pane`
`(send-view-to-other-pane)`

*Move* the focused view to the next pane in display order, rather than
swapping. Bound to `C-x x` — but the command predates the server
architecture and is **currently out of order**: pressing it does
nothing visible (the failure is logged to the console only). Until it
is re-ported, get the same effect by hand — focus the destination pane
and switch to the buffer there with `C-x b`. See also
cmd(swap-with-other-pane).
:::

:::function{name="send-tab-to-other-pane" path="reference/panes/send-tab-to-other-pane.html"}
#### `send-tab-to-other-pane`
`(send-tab-to-other-pane)`

Alias for cmd(send-view-to-other-pane), and out of order for the same
reason. Unbound.
:::

:::function{name="swap-views" path="reference/panes/swap-views.html"}
#### `swap-views`
`(swap-views)`

Swap which view two panes show. Numbers every pane with a badge in its
top-left corner (a clockwise spiral from the top-left pane); type the
two pane numbers, then press Enter to swap. Space confirms an ambiguous
number, Delete undoes, Escape cancels. The panes keep their sizes —
only their contents trade places. A no-op with fewer than two panes.
Bound only in the **View menu** ("Swap Views…", no key); the menu
dispatch focuses the editor first, so it works even when a browser pane
holds the keyboard. See also cmd(permute-views),
cmd(swap-with-other-pane).
:::

:::function{name="permute-views" path="reference/panes/permute-views.html"}
#### `permute-views`
`(permute-views)`

Rearrange which view every pane shows. Numbers every pane, then reads a
destination for pane 1, pane 2, … in turn (the last is filled in
automatically) — so three or more panes' contents rotate in a single
gesture. Enter applies the whole rearrangement at once; Delete steps
back; Escape cancels. Panes keep their sizes; contents move. A no-op
with fewer than two panes. Bound only in the **View menu**
("Permute Views…", no key). See also cmd(swap-views).
:::

### Tablines

A pane does not grow a tabline just because a second buffer comes along
— you create one deliberately, and the server owns it. Once a pane has
a tabline, every buffer you open or switch to in that pane (`C-x C-f`,
`C-x b`, a pick from the buffer list) joins the strip as a tab and
becomes the active one. Click a tab to activate it; drag a tab to
reorder the strip (the active tab stays active wherever it lands);
click its × control to close it, with the semantics described under
cmd(close-tab). Opening a project (`C-x C-p`) builds a tabline over the
project's files for you.

:::function{name="toggle-tabline" path="reference/panes/toggle-tabline.html"}
#### `toggle-tabline`
`(toggle-tabline)`

Flip the focused pane between a plain single view and a tabline.
Toggled on, the strip starts with the pane's current view as its only
tab; from then on, buffers opened or switched to in this pane join the
strip. Toggled off, the strip disappears and the pane keeps showing its
active view — the other tabs leave the strip with their buffers
untouched in the buffer list. Each pane's tabline is independent of the
others, and per-window. Unbound — run with `M-x`.
:::

### Views

The view-switching commands are `defcommand`s embedded in the spine
(`views.lisp` is not loaded server-side). Each window holds its own
*open-set* of views with one current; these commands change which view
the focused pane shows. The buffers behind them are shared across every
window.

:::function{name="scratch-buffer" path="reference/panes/scratch-buffer.html"}
#### `scratch-buffer`
`(scratch-buffer)`

Open a fresh Lisp scratch buffer, seeded like the first-run
`scratch.lisp` and uniquely named. It joins the focused pane as a new
tab when the pane has a tabline. Bound to `C-x n`. See also
cmd(kill-view).
:::

:::function{name="next-view" path="reference/panes/next-view.html"}
#### `next-view`
`(next-view)`

Switch the focused pane to the next view in this window's open-set.
Bound to `C-x right`. See also cmd(previous-view).
:::

:::function{name="previous-view" path="reference/panes/previous-view.html"}
#### `previous-view`
`(previous-view)`

Switch the focused pane to the previous view in this window's open-set.
Bound to `C-x left`. See also cmd(next-view).
:::

:::function{name="switch-view" path="reference/panes/switch-view.html"}
#### `switch-view`
`(switch-view)`

Switch the current window to a view chosen by name. Type at the
"Switch to buffer: " prompt in the minibuffer; on submit the name is
resolved leniently — an exact match first, else the shortest buffer
name containing what you typed — so a fragment is enough. A miss
reports `No buffer named "…"` and stays put. Bound to `C-x b`. See
also cmd(list-views).
:::

:::function{name="kill-view" path="reference/panes/kill-view.html"}
#### `kill-view`
`(kill-view)`

Kill the current view — remove it from the shared buffer pool. Every
pane in every window showing it is re-pointed to another buffer, and a
tabline curating it drops the tab. Killing a live-process view (a shell
or gnuplot session) ends its child process; killing a media view (an
image, PDF, audio or video buffer) removes the data source. The server
refuses to kill the last remaining text buffer — the echo area reports
`kill-view: refusing to kill the only buffer` — so the pool is never
empty. Bound to `C-x k`. To merely close a pane while keeping the view
alive, use cmd(close-pane).
:::

:::function{name="list-views" path="reference/panes/list-views.html"}
#### `list-views`
`(list-views)`

Open the buffer list in the picker — an overlay panel listing every
open view (text buffers and non-text views alike). Type to narrow,
arrows to navigate, Enter to switch to the chosen view; Escape cancels
and the window stays put. Bound to `C-x C-b`. See also
cmd(switch-view).
:::

### Windows

The `C-x 5` prefix — Emacs's frame prefix — manages the OS windows
themselves. All windows are thin clients of the same central server:
they share one set of buffers, one Lisp world, one kill ring. Each
window has its own pane tree and tablines, so the *arrangement* is
per-window while the *content* is shared. The manual's Windows chapter
covers the workspace machinery that remembers an arrangement between
launches.

:::function{name="new-window" path="reference/panes/new-window.html"}
#### `new-window`
`(new-window)`

Open another editor window onto the shared server. The new window gets
its own pane tree; the buffers it shows are the same ones every other
window sees. Bound to `C-x 5 2`.
:::

:::function{name="close-window" path="reference/panes/close-window.html"}
#### `close-window`
`(close-window)`

Close *this* window. The buffers live in the shared server and outlive
the window, so closing loses nothing — they remain reachable from any
surviving window. (Only quitting the app, `C-x C-c`, runs the
unsaved-changes confirmation.) Bound to `C-x 5 0`.
:::

:::function{name="close-other-windows" path="reference/panes/close-other-windows.html"}
#### `close-other-windows`
`(close-other-windows)`

Close every window *except* this one — the multi-window payoff: one
keystroke shuts the others. Each target window closes itself; the
server keeps every buffer. A no-op when this is the only window. Bound
to `C-x 5 1`.
:::

### The minimap companion

Defined in `minimap.lisp`. The minimap occupies a pane slot but is not
a peer: it never takes keyboard focus — `C-x o` skips it, and clicks on
it navigate the editor instead — and deleting its target pane removes
the companion along with it.

:::function{name="toggle-minimap" path="reference/panes/toggle-minimap.html"}
#### `toggle-minimap`
`(toggle-minimap)`

Toggle a minimap pane beside the focused editor pane — a zoomed-out
rendering of the text that reflects the scroll position and can be
clicked or dragged to navigate. If the pane already has a minimap,
remove it; otherwise attach one on `*minimap-side*`,
`*minimap-width-fraction*` wide. The minimap mirrors the pane's active
text content and follows tab switches; a non-text view shows a
not-supported message. Bound to `C-x m`.
:::

:::function{name="minimap-side" path="reference/panes/minimap-side.html"}
#### `*minimap-side*`

Which side of the editor pane the minimap attaches to: `'left` or
`'right` (the default). A `defcustom` in the `minimap` group.
:::

:::function{name="minimap-width-fraction" path="reference/panes/minimap-width-fraction.html"}
#### `*minimap-width-fraction*`

The minimap pane's share of the split, as a fraction of the editor
pane's width. Clamped to `[0.05, 0.45]` by the host. Default `0.16`. A
`defcustom` in the `minimap` group.
:::
