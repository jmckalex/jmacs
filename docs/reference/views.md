Title: jmacs View & Tool Commands
Author: J. McKenzie Alexander
Date: 2026-06-11
---

# View and tool commands

jmacs is more than a text editor: a buffer can be shown through a
*non-text view* — a shell transcript, a gnuplot notebook REPL, a
reactive Lisp notebook, a jukebox, a directory browser, a web page.
The views themselves live in Layer 4
(`packages/renderer/src/*-view.js`); the entries below are the thin
Lisp surface that opens and drives them, plus the host primitives they
hand off to.

A *command* — a procedure of no arguments, runnable by name with `M-x`
and usually bound to a key — is the common case. A few openers here are
ordinary `define`s that take a path argument (`directory-tree`,
`directory-columns`); these are not `M-x` commands but procedures you
call from the REPL. One entry (`open-url!`) is a host *primitive* — a
procedure implemented in the Electron host, not in Lisp — likewise
called from the REPL. Each entry says which it is. See `commands.md`
for the conventions and `index.jmd` for how to read an entry.

Key bindings are given in the manual's notation: `C-` is Control or
Command, `M-` is Option, `S-` is Shift.

---

## Shell

Defined in `shell.lisp`. The view lives in
`packages/renderer/src/shell-view.js`.

:::function{name="shell" path="reference/views/shell.html"}
### `shell`
`(shell)`

Open a fresh shell buffer running the user's default shell (`$SHELL`,
falling back to `/bin/zsh`) — a child process shown through the L4
shell view as a transcript above an input line. Type a command and
press Enter to run it; output streams into the transcript. `C-c` sends
`SIGINT` to a running command; `C-d` at an empty input line ends the
session and dismisses the buffer. Each call creates a new buffer with
its own long-lived shell process — switch back to an open one by name
with `C-x b`. Line-oriented commands work; curses applications
(`vi`, `top`, `less`) misbehave because there is no PTY. Run with
`M-x shell`. Hands off to the `open-shell-buffer!` host primitive.
:::

## Gnuplot

Defined in `gnuplot.lisp`. The view lives in
`packages/renderer/src/gnuplot-view.js`.

:::function{name="gnuplot" path="reference/views/gnuplot.html"}
### `gnuplot`
`(gnuplot)`

Open a fresh gnuplot buffer — a long-lived `gnuplot` child process
shown through the L4 gnuplot view as a notebook REPL. Type a gnuplot
command at the input line and press Enter; the plot (an inline SVG), or
text / error output, appears as a cell above. Use Up and Down to recall
previous commands; press `C-c` to interrupt a long-running plot. Each
call creates a new buffer with its own gnuplot process — switch back to
an open one by name with `C-x b`. gnuplot must be installed
(`brew install gnuplot`); when it is not, the view degrades to an
install-instructions card. Bound to `C-c g`; also `M-x gnuplot`. Hands
off to the `open-gnuplot-buffer!` host primitive.
:::

## Notebook

The reactive engine is in `notebook.lisp`; the user-facing commands are
in `notebook-commands.lisp`. A notebook is a sheet of named
`(cell NAME EXPR)` cells where editing one recomputes everything
downstream (spreadsheet / Observable style). The view is the
`<notebook-view>` custom element.

:::function{name="notebook" path="reference/views/notebook.html"}
### `notebook`
`(notebook)`

Open a new reactive Lisp notebook — a sheet of named
`(cell NAME EXPR)` cells where editing one recomputes everything
downstream. Bound to `C-c n`; also `M-x notebook`. Hands off to the
`open-notebook-buffer!` host primitive.
:::

:::function{name="next-notebook" path="reference/views/next-notebook.html"}
### `next-notebook`
`(next-notebook)`

Switch to the next open notebook. Bound to `C-c C-n`; also
`M-x next-notebook`.
:::

:::function{name="previous-notebook" path="reference/views/previous-notebook.html"}
### `previous-notebook`
`(previous-notebook)`

Switch to the previous open notebook. Bound to `C-c C-p`; also
`M-x previous-notebook`.
:::

:::function{name="rename-notebook" path="reference/views/rename-notebook.html"}
### `rename-notebook`
`(rename-notebook)`

Rename the current notebook — its display name, not a file on disk.
Prompts for the new name in the minibuffer. Run with `M-x
rename-notebook` (no default key binding). The notebook id is captured
before the prompt moves focus, so the rename lands on the right
notebook.
:::

## Jukebox

Defined in `jukebox.lisp`. The view lives in
`packages/renderer/src/jukebox-view.js` — cover art, an `<audio>`
element, and a track list.

:::function{name="jukebox" path="reference/views/jukebox.html"}
### `jukebox`
`(jukebox [path])`

Open a jukebox for a directory full of audio files, shown through the
L4 jukebox view. With no argument, opens the directory picker; with a
path argument, opens that directory directly. In the view, `SPC`
plays / pauses, `RET` plays the focused track, `n` / `p` step,
`s` shuffles, `R` randomises, `g` refreshes, `q` quits, and `M-RET`
opens the album-art file as an image buffer. Bound to `C-x j`; also
`M-x jukebox`. With no argument it hands off to the `prompt-directory!`
host primitive; with a path, to `open-jukebox-buffer!`.

This is an ordinary `define` taking an optional `path` argument, so it
can also be called with a directory from the REPL —
`(jukebox "~/Music/album")`.
:::

:::function{name="jukebox-on-directory-chosen" path="reference/views/jukebox-on-directory-chosen.html"}
### `jukebox-on-directory-chosen`
`(jukebox-on-directory-chosen path)`

Called by the host when the user picks a directory from the
directory-picker dialog. Bridges the dialog's callback into the
`open-jukebox-buffer!` primitive. Not a command — a host callback.
:::

:::function{name="*jukebox-track-format*" path="reference/views/jukebox-track-format.html"}
### `*jukebox-track-format*`

The template string `format-track` uses to render each row in a
jukebox buffer; default `"\"{title}\", {artist}, {album}"`. A
`defcustom` in the `jukebox` group — set it (or customise it) to change
how tracks are listed. Supported `{placeholders}`: `{title}`,
`{artist}`, `{album}`, `{track}`, `{year}`, `{genre}`, and
`{filename}` (the bare filename, no extension). Missing fields render
as the empty string; a file with no usable metadata falls back to its
bare filename. Changing it calls `refresh-jukebox-labels!`.
:::

:::function{name="format-track" path="reference/views/format-track.html"}
### `format-track`
`(format-track path)`

The display string for the jukebox row at `path`. Reads the file's
embedded tag metadata (`audio-metadata`) and substitutes it into the
`*jukebox-track-format*` template; falls back to the bare filename
(without extension) when the metadata is missing or unusable. The
helper the view calls per row.
:::

## Directory browsers

Two directory views, each an ordinary `define` that takes a `path`
argument — so they are **invoked from the REPL** (e.g.
`(directory-tree "~/Source")`), not run with `M-x`, and have no default
key binding. The views live in
`packages/renderer/src/directory-tree-view.js` and
`directory-columns-view.js`.

:::function{name="directory-tree" path="reference/views/directory-tree.html"}
### `directory-tree`
`(directory-tree path)`

Open a directory tree-view rooted at `path`, shown through the L4
directory-tree view. Click a folder row to expand / collapse, click a
file to open it (it routes through the host's open-file-path, landing
in whichever view its suffix maps to — text editor, image, audio,
video), arrow up / down to navigate, Enter to activate the selected
row, `q` to dismiss the buffer. A REPL-invoked `define`, not an `M-x`
command. Hands off to the `open-directory-tree!` host primitive.
:::

:::function{name="directory-columns" path="reference/views/directory-columns.html"}
### `directory-columns`
`(directory-columns path)`

Open a Finder-style column browser rooted at `path`, shown through the
L4 directory-columns view. Each column is one directory's listing.
Click a folder to drill in (spawns a column to its right); click a file
to preview it in the trailing column; double-click a file to open it as
its own buffer in whichever view its suffix maps to; `q` dismisses the
buffer. A REPL-invoked `define`, not an `M-x` command. Hands off to the
`open-directory-columns!` host primitive.
:::

## Web

:::function{name="open-url!" path="reference/views/open-url.html"}
### `open-url!`
`(open-url! url)`

Open `url` in a browser-kind view (an Electron `<webview>`). A **host
primitive**, not a Lisp command — implemented in `apps/desktop/src/app.js`
and **invoked from the REPL**, e.g. `(open-url! "https://example.com")`.
If the active pane already shows a browser, it navigates that view in
place rather than spawning a duplicate; otherwise it creates a fresh
browser view in the active pane and switches to it. Returns `nil`; an
empty URL is a no-op. The page title overwrites the view's name once
the webview reports it.
:::

## Files

Defined in `files.lisp`. The native open-file dialog is reached through
this command (the editor's `find-file` / `C-x C-f` is documented in
`commands.md`).

:::function{name="open-file-dialog" path="reference/views/open-file-dialog.html"}
### `open-file-dialog`
`(open-file-dialog)`

Open the native OS file-open dialog. Invoked by *File ▸ Open File…*
(`Cmd+O`); also `M-x open-file-dialog`. It has no Lisp key binding —
the renderer normalises `Cmd` to `C-`, and `C-o` is already
`open-line`, so the dialog is reached through the application menu (or
the REPL) rather than the keymap. Hands off to the `open-file!` host
primitive.
:::
