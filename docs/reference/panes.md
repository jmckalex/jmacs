Title: jmacs Pane & Window Commands
Author: J. McKenzie Alexander
Date: 2026-06-11
---

## Pane and window commands

This document describes every command for managing the editor's visual
layout — the *panes* that divide the editor area, the *views* that fill
them, and the *tablines* that gather several views into one pane. These
are ordinary Lisp commands defined in `panes.lisp`, `views.lisp`,
`tabline.lisp` and `view-menu.lisp`, each wrapping a host primitive that
mutates the pane tree or the view list.

A *pane* is a leaf of the editor's binary split tree; each holds one
view. A *view* is an on-screen surface — a text buffer, an image, a
shell, a PDF, a directory tree, and so on. A *tabline-view* wraps several
views into a single pane as a tab strip. See `plans/PANES.md` and
`docs/VIEWS.md`.

Key bindings are given in the manual's notation: `C-` is Control or
Command, `M-` is Option, `S-` is Shift. Several commands here are bound
not on a key but only in the **View menu** (a focused browser
`<webview>` swallows `C-x` chords, so the menu is the reliable route),
and a few are unbound entirely — runnable by name with `M-x`, from the
REPL, or by explicit composition in `init.lisp`. Each entry says which.
See `index.jmd` for how to read an entry.

---

### Splitting and focus

Defined in `panes.lisp`. Splitting a pane moves focus to the new pane,
which shows a *placeholder* chooser asking what it should hold — open a
file (`o`), clone the previous view (`c`), start a new file (`s`), or run
a command (`r`). Enter performs `*placeholder-default-action*` (clone by
default).

:::function{name="split-vertical" path="reference/panes/split-vertical.html"}
#### `split-vertical`
`(split-vertical)`

Split the current pane top-and-bottom; focus moves to the new pane. With
no prefix-arg the new pane appears *below*; with a `C-u` prefix it
appears *above*. Bound to `C-x 2`. See also cmd(split-horizontal).
:::

:::function{name="split-horizontal" path="reference/panes/split-horizontal.html"}
#### `split-horizontal`
`(split-horizontal)`

Split the current pane side-by-side; focus moves to the new pane. With no
prefix-arg the new pane appears to the *right*; with a `C-u` prefix it
appears to the *left*. Bound to `C-x 3`. See also cmd(split-vertical).
:::

:::function{name="add-pane" path="reference/panes/add-pane.html"}
#### `add-pane`
`(add-pane)`

Enter the visual add-pane macro. An overlay highlights every splitter and
the four outer borders of the editor area; click one to insert a fresh
pane there. Clicking a splitter inserts a new sibling along that split's
axis; clicking a border wraps the existing layout in a new outer split.
The new pane shows a placeholder chooser and takes focus. Escape — or
re-pressing the entry chord — cancels. Bound to `C-x +`.
:::

:::function{name="other-pane" path="reference/panes/other-pane.html"}
#### `other-pane`
`(other-pane)`

Cycle focus to the next pane in display order. Bound to `C-x o`. See also
cmd(focus-pane-left).
:::

:::function{name="focus-pane-left" path="reference/panes/focus-pane-left.html"}
#### `focus-pane-left`
`(focus-pane-left)`

Focus the pane immediately to the left of the current one, if any. Bound
to `C-x C-←`. See also cmd(focus-pane-right), cmd(other-pane).
:::

:::function{name="focus-pane-right" path="reference/panes/focus-pane-right.html"}
#### `focus-pane-right`
`(focus-pane-right)`

Focus the pane immediately to the right of the current one, if any. Bound
to `C-x C-→`. See also cmd(focus-pane-left).
:::

:::function{name="focus-pane-up" path="reference/panes/focus-pane-up.html"}
#### `focus-pane-up`
`(focus-pane-up)`

Focus the pane immediately above the current one, if any. Bound to
`C-x C-↑`. See also cmd(focus-pane-down).
:::

:::function{name="focus-pane-down" path="reference/panes/focus-pane-down.html"}
#### `focus-pane-down`
`(focus-pane-down)`

Focus the pane immediately below the current one, if any. Bound to
`C-x C-↓`. See also cmd(focus-pane-up).
:::

### Closing panes and tabs

Defined in `panes.lisp`. jmacs distinguishes *closing* a pane — which
collapses the pane but keeps its view alive in the global list — from
*killing* a view, which removes the view itself (see cmd(kill-view)).
This is the same split Emacs makes between `C-x 0` (delete-window) and
`C-x k` (kill-buffer).

:::function{name="delete-pane" path="reference/panes/delete-pane.html"}
#### `delete-pane`
`(delete-pane)`

Delete the current pane — collapse its parent split into its sibling. A
no-op when the current pane is the only one in the window. The view stays
alive in the global list. Bound to `C-x 0`. See also cmd(close-pane),
cmd(delete-other-panes).
:::

:::function{name="close-pane" path="reference/panes/close-pane.html"}
#### `close-pane`
`(close-pane)`

Close the current pane, collapsing its parent split into its sibling
while keeping every view alive in the global list — the view is reachable
afterwards via cmd(switch-view) or the view-list. Same effect as
cmd(delete-pane), under the lighter everyday name; to remove the view
itself use cmd(kill-view). Unbound — run with `M-x` or from the REPL.
:::

:::function{name="delete-other-panes" path="reference/panes/delete-other-panes.html"}
#### `delete-other-panes`
`(delete-other-panes)`

Make the current pane fill the editor area, disposing every other pane.
Bound to `C-x 1`. See also cmd(delete-pane).
:::

:::function{name="close-tab" path="reference/panes/close-tab.html"}
#### `close-tab`
`(close-tab)`

Close the active tab in the focused tabline-view. The view leaves the
strip but stays alive in the global list (reachable via
cmd(switch-view)). When it was the last tab, the pane collapses into its
sibling (cmd(close-pane)); at the sole root pane there is nothing to
collapse into, so the last tab stays put. To remove the view itself use
cmd(kill-view). Bound to `Cmd+W` — wired in the host (`apps/desktop/src/app.js`),
not in the keymap, via a capture-phase listener so it claims `Cmd+W`
ahead of a focused editor's `C-w` (cmd(kill-region)). Real `Ctrl+W` still
runs cmd(kill-region).
:::

:::function{name="balance-panes" path="reference/panes/balance-panes.html"}
#### `balance-panes`
`(balance-panes)`

Reset every split's ratio to 0.5 so panes share their parent's space
evenly. Unbound — run with `M-x` or from the REPL.
:::

### Rearranging

Defined in `panes.lisp`. These move views between panes, or trade which
view each pane shows, without changing the panes' geometry. The "other
pane" is the next leaf in display order; the single-target commands are a
no-op when only one pane exists.

:::function{name="send-view-to-other-pane" path="reference/panes/send-view-to-other-pane.html"}
#### `send-view-to-other-pane`
`(send-view-to-other-pane)`

Send the focused view to the next pane in display order. Both panes are
promoted to tabline-views (idempotent) and the focused tab moves across,
becoming the active tab at the destination. If the source pane had only
this tab, its strip is left empty and cmd(close-pane) will collapse it.
A no-op when there is only one pane. Bound to `C-x x`. See also
cmd(swap-with-other-pane), cmd(send-tab-to-other-pane).
:::

:::function{name="send-tab-to-other-pane" path="reference/panes/send-tab-to-other-pane.html"}
#### `send-tab-to-other-pane`
`(send-tab-to-other-pane)`

Send the focused tab to the next pane's tabline — an alias for
cmd(send-view-to-other-pane). Unbound — run with `M-x` or from the REPL.
:::

:::function{name="swap-with-other-pane" path="reference/panes/swap-with-other-pane.html"}
#### `swap-with-other-pane`
`(swap-with-other-pane)`

Swap the views shown in the current pane and the next pane in display
order. Both panes keep their identity; only their views exchange. A no-op
when there is only one pane. Bound to `C-x X`. See also cmd(swap-views),
cmd(send-view-to-other-pane).
:::

:::function{name="swap-views" path="reference/panes/swap-views.html"}
#### `swap-views`
`(swap-views)`

Swap which view two panes show. Numbers every pane with a badge in its
top-left corner; type the two pane numbers, then Enter to swap. Space
confirms an ambiguous number, Delete undoes, Escape cancels. The panes
keep their sizes — only their contents trade places. A no-op with fewer
than two panes. Bound only in the **View menu** (no key); usable when a
browser pane is focused, since the menu releases the webview's key grab.
See also cmd(permute-views), cmd(swap-with-other-pane).
:::

:::function{name="permute-views" path="reference/panes/permute-views.html"}
#### `permute-views`
`(permute-views)`

Rearrange which view every pane shows. Numbers every pane, then reads a
destination for pane 1, pane 2, … in turn (the last is filled in
automatically). Enter applies the whole rearrangement at once; Delete
steps back; Escape cancels. Panes keep their sizes; contents move. A
no-op with fewer than two panes. Bound only in the **View menu** (no
key). See also cmd(swap-views).
:::

### Tablines

Defined in `tabline.lisp`. A *tabline-view* wraps several leaf views into
one pane as a tab strip plus a content area. Promotion and demotion are
deliberate user actions; the editor does not do them silently. None of
these carries a key binding — run them with `M-x`, from the REPL, or by
composition in `init.lisp`.

:::function{name="promote-to-tabline" path="reference/panes/promote-to-tabline.html"}
#### `promote-to-tabline`
`(promote-to-tabline)`

Wrap the current pane's view in a fresh tabline-view, with the existing
view as the sole tab. A no-op when the pane already holds a tabline (the
existing tabline is returned). After promotion, opening more files in the
pane appends them as tabs; cmd(next-view) / cmd(previous-view) switch
between them. Unbound. See also cmd(demote-tabline).
:::

:::function{name="demote-tabline" path="reference/panes/demote-tabline.html"}
#### `demote-tabline`
`(demote-tabline)`

Replace the current pane's tabline-view with its active child's view; the
pane goes back to being a plain leaf. The other tabs are dropped from the
pane, but their views remain in the global list (cmd(switch-view) can
reach them). A no-op when the current pane doesn't hold a tabline.
Unbound. See also cmd(promote-to-tabline).
:::

:::function{name="tabline-edge-top" path="reference/panes/tabline-edge-top.html"}
#### `tabline-edge-top`
`(tabline-edge-top)`

Render the current pane's tab strip on the top edge of the pane (the
default). A no-op when the current pane doesn't hold a tabline. Unbound.
See also cmd(tabline-edge-bottom), cmd(tabline-edge-left),
cmd(tabline-edge-right).
:::

:::function{name="tabline-edge-bottom" path="reference/panes/tabline-edge-bottom.html"}
#### `tabline-edge-bottom`
`(tabline-edge-bottom)`

Render the current pane's tab strip on the bottom edge of the pane. A
no-op when the current pane doesn't hold a tabline. Unbound. See also
cmd(tabline-edge-top).
:::

:::function{name="tabline-edge-left" path="reference/panes/tabline-edge-left.html"}
#### `tabline-edge-left`
`(tabline-edge-left)`

Render the current pane's tab strip on the left edge of the pane. The
vertical-strip layout stacks tabs column-wise with normal-orientation
labels (no rotated text). A no-op when the current pane doesn't hold a
tabline. Unbound. See also cmd(tabline-edge-right), cmd(tabline-edge-top).
:::

:::function{name="tabline-edge-right" path="reference/panes/tabline-edge-right.html"}
#### `tabline-edge-right`
`(tabline-edge-right)`

Render the current pane's tab strip on the right edge of the pane,
stacked column-wise with normal-orientation labels. A no-op when the
current pane doesn't hold a tabline. Unbound. See also
cmd(tabline-edge-left).
:::

### Views

Defined in `views.lisp`. The editor holds a list of views with one
current; these commands change which view is current and re-mount the
matching renderer surface.

:::function{name="new-view" path="reference/panes/new-view.html"}
#### `new-view`
`(new-view)`

Create a fresh empty text view and switch to it. Bound to `C-x n`. See
also cmd(kill-view).
:::

:::function{name="next-view" path="reference/panes/next-view.html"}
#### `next-view`
`(next-view)`

Switch to the next view in the list. Bound to `C-x →`. See also
cmd(previous-view).
:::

:::function{name="previous-view" path="reference/panes/previous-view.html"}
#### `previous-view`
`(previous-view)`

Switch to the previous view in the list. Bound to `C-x ←`. See also
cmd(next-view).
:::

:::function{name="switch-view" path="reference/panes/switch-view.html"}
#### `switch-view`
`(switch-view)`

Switch to a view chosen by name, with completion. Bound to `C-x b`. The
chooser runs in the minibuffer. See also cmd(view-list!).
:::

:::function{name="kill-view" path="reference/panes/kill-view.html"}
#### `kill-view`
`(kill-view)`

Remove the current view from the list and switch to the next one. Killing
the last view creates a fresh empty `*scratch*` text view, so the list is
never empty. Bound to `C-x k`. To merely close a pane while keeping the
view alive, use cmd(close-pane).
:::

:::function{name="view-list!" path="reference/panes/view-list!.html"}
#### `view-list!`
`(view-list!)`

Open the *View List* — a clickable table of every open view. Click a row
to switch to that view; the row's ✕ kills it. The list refreshes live as
views open and close. Also reachable as cmd(buffer-menu) / `C-x C-b`. The
`!` marks the side effect and keeps the name clear of the `(view-list)`
host primitive, which returns the array of view handles. Itself unbound;
the keymap points `C-x C-b` at cmd(buffer-menu).
:::

:::function{name="buffer-menu" path="reference/panes/buffer-menu.html"}
#### `buffer-menu`
`(buffer-menu)`

Alias for cmd(view-list!), kept for Emacs muscle memory. Bound to
`C-x C-b`.
:::
