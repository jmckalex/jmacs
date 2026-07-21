Title: Godot View & Tool Commands
Author: J. McKenzie Alexander
Date: 2026-07-21
---

## View and tool commands

Godot is more than a text editor: a pane can show a *non-text view* — a
real terminal, a gnuplot notebook REPL, a cell notebook, a web page, a
jukebox, a directory browser, a PDF. The views themselves live in Layer
4 (`packages/renderer/src/*-view.js`); the entries below are the
commands that open and drive them. Every opener here is a `defcommand`,
runnable with `M-x` and prompting in the minibuffer where it needs an
argument; the spine primitive each wraps is named in passing for
readers chasing the implementation. See `commands.md` for the command
conventions and `index.md` for how to read an entry.

A non-text view occupies a pane slot like any other view: it can sit in
a tabline, be switched to by name with `C-x b`, moved with the
rearranging commands, and killed with `C-x k` — see `panes.md`. Killing
a live-process view (a shell or gnuplot session), or closing its tab,
ends its child process.

Key bindings are given in the manual's notation: `C-` is Control, `M-`
is Command (the Meta of Emacs custom), `A-` is Option, `S-` is Shift.

---

### Shell

Defined in `shell.lisp`. The view lives in
`packages/renderer/src/shell-view.js`.

:::function{name="shell" path="reference/views/shell.html"}
#### `shell`
`(shell)`

Open a fresh shell buffer running the user's default shell (`$SHELL`,
falling back to `/bin/zsh`) under a **real pty**, shown through a full
xterm.js terminal grid. This is a proper terminal, not a transcript:
curses applications (`vi`, `htop`, `less`, `top`), 256-colour output,
full-screen TUIs, and resize reflow all work, and shell prompt layers
(ZLE, RPROMPT, completion menus) render with full fidelity. Scrollback
runs to 10,000 lines.

While the terminal has focus its keys are its own: Control chords go to
the shell process — `C-c` raises `SIGINT` in the foreground process
group, `C-d` at an empty prompt ends the session. When the session
ends, the buffer is not dismissed: the view prints a dim `[exited]`
marker and the terminal's output stays readable until you kill the
buffer. `Cmd+C` copies the terminal's own selection to the clipboard
when there is one. To run editor commands, use the application menus
(their dispatch refocuses the editor) or click another pane.

Each call creates a new buffer with its own long-lived shell process —
switch back to an open one by name with `C-x b`. Kill it with `C-x k`
(or its tab's ×), which also reaps the pty. Run with `M-x shell`.
Implementation: the `open-shell-buffer!` spine primitive; the pty lives
in the main process (`apps/desktop/src/shell.js`).
:::

### Gnuplot

Defined in `gnuplot.lisp`. The view lives in
`packages/renderer/src/gnuplot-view.js`.

:::function{name="gnuplot" path="reference/views/gnuplot.html"}
#### `gnuplot`
`(gnuplot)`

Open a fresh gnuplot buffer — a long-lived `gnuplot` child process
shown through the L4 gnuplot view as a notebook REPL. Type a gnuplot
command at the input line and press Enter; the plot (an inline SVG), or
text / error output, appears as a cell above. Use Up and Down to recall
previous commands; press `C-c` to interrupt a long-running plot. Each
call creates a new buffer with its own gnuplot process — switch back to
an open one by name with `C-x b`; kill it with `C-x k`, which also
ends the process. gnuplot must be installed (`brew install gnuplot`);
when it is not, the view degrades to an install-instructions card.
Bound to `C-c g`; also `M-x gnuplot`. Implementation: the
`open-gnuplot-buffer!` spine primitive.
:::

### Notebook

The notebook is `M-x notebook-cells`: a sheet of JavaScript code cells
where **all cells live in one real editor** over a single unified
buffer — one parse, full highlighting, ordinary editing; the cells
*are* the editor. Per-cell chrome (a header with a Run button, an
output region) rides the editor's widget layer. The view is the
`<notebook-cells-view>` custom element, hosted through the element-view
mechanism (see *Element views* below).

:::function{name="notebook-cells" path="reference/views/notebook-cells.html"}
#### `notebook-cells`
`(notebook-cells)`

Open a cell notebook. Each cell is JavaScript; press `S-enter` (or
`C-enter` / `M-enter`) inside a cell to run it, or click its header's
Run button. Cells share state Jupyter-style: a cell's top-level
`const` / `function` declarations persist to later cells in the same
notebook, via a persistent per-notebook scope. Evaluation happens in
the server's Node session, so cells can use the full Node runtime. The
toolbar offers **Run all** (every cell, top to bottom), **+ Cell**
(append a cell), and **Open** / **Save**: a notebook serialises to
plain text with `// @cell` fences; cell *outputs* are runtime-only and
are not saved. Editing keys are the editor's own; command chords
(`M-x`, `C-x …`) reach the global keymap. Run with
`M-x notebook-cells`.
:::

### Jukebox

The command is a spine `defcommand`; the view lives in
`packages/renderer/src/jukebox-view.js` — cover art, an `<audio>`
element, and a track list.

:::function{name="jukebox" path="reference/views/jukebox.html"}
#### `jukebox`
`(jukebox)`

Open a jukebox for a directory full of audio files. Type the directory
at the "Jukebox directory: " prompt in the minibuffer — TAB completes
against the filesystem — and the server scans it and opens the jukebox
view. In the view, `space` plays / pauses, `enter` plays the focused
track, `n` / `p` step to the next / previous track, `s` toggles
shuffle, `R` randomises the order, `g` re-scans the directory, and `q`
dismisses the buffer. Bare keys the view does not claim, and all
modifier chords, fall through to the global keymap, so `C-x b` and
friends keep working from a jukebox. Bound to `C-x j`; also
`M-x jukebox`.
:::

:::function{name="*jukebox-track-format*" path="reference/views/jukebox-track-format.html"}
#### `*jukebox-track-format*`

The template used to render each row in a jukebox buffer; default
`"\"{title}\", {artist}, {album}"`. A `defcustom` in the `jukebox`
group — set it (or customise it) to change how tracks are listed.
Supported `{placeholders}`: `{title}`, `{artist}`, `{album}`,
`{track}`, `{year}`, `{genre}`, and `{filename}` (the bare filename,
no extension). Missing fields render as the empty string; a file with
no usable metadata falls back to its bare filename. Rows are formatted
on the server; changing the variable relabels every open jukebox
live.
:::

### Directory browsers

Two directory views, each opened by an `M-x` command that reads the
root directory in the minibuffer with TAB filesystem completion. The
views live in `packages/renderer/src/directory-tree-view.js` and
`directory-columns-view.js`. (Visiting a directory path with
cmd(find-file) also opens the tree view over it.)

:::function{name="directory-tree" path="reference/views/directory-tree.html"}
#### `directory-tree`
`(directory-tree)`

Open a directory tree-view rooted at a directory chosen at the
"Directory tree: " prompt. A single click selects a row — and on a
folder, expands or collapses it; a file opens on **double-click** (or
Enter on the selected row), landing where `*directory-tree-open-target*`
says. Arrow keys step the selection, Space toggles the selected folder,
`q` dismisses the buffer; chord keys route through the global keymap.
Run with `M-x directory-tree`. See also cmd(directory-columns).
:::

:::function{name="*directory-tree-open-target*" path="reference/views/directory-tree-open-target.html"}
#### `*directory-tree-open-target*`

Where a file opens when activated in a directory tree-view. A
`defcustom` in the `directory-tree` group, one of three symbols:

- `'editing-pane` — the main editing area: a tabline or text pane that
  is not the tree or another sidebar. The default.
- `'other-pane` — the next editing pane after the tree.
- `'this-pane` — the tree's own pane, promoted to a tabline.

A project opened with `C-x C-p` wires its tree to the project's editing
tabline directly, which takes precedence over this setting.
:::

:::function{name="directory-columns" path="reference/views/directory-columns.html"}
#### `directory-columns`
`(directory-columns)`

Open a Finder-style column browser rooted at a directory chosen at the
"Directory columns: " prompt. Each column is one directory's listing.
Click a folder to drill in (spawns a column to its right); click a file
to preview it in the trailing column; **double-click** a file to open
it as its own buffer in whichever view its suffix maps to. `q`
dismisses the buffer. Run with `M-x directory-columns`. See also
cmd(directory-tree).
:::

### Web

Defined in `browser.lisp`; the `<browser-view>` element (a thin chrome
around Electron's `<webview>`) lives in
`packages/renderer/src/browser-view.js`.

:::function{name="browser-view" path="reference/views/browser-view.html"}
#### `browser-view`
`(browser-view url)`

Open a web browser view at a URL chosen at the "Browse URL: " prompt.
An address without a scheme gets `https://` prepended, so `example.com`
works without ceremony; leave the prompt empty to open a blank page and
type the address into the view's own URL bar instead. The page shows in
the focused pane wrapped in a toolbar — back, forward, reload / stop,
and an editable URL bar — and navigates like any browser. Each call
mints a fresh page (its history and scroll are its own); the page title
becomes the view's name. Close it with `C-x k` or the tab's ×, which
tears the webview down.

One caveat: a focused `<webview>` swallows every keystroke, including
`C-x` chords. The pane commands are on the **View menu** for exactly
this reason — the menu dispatch refocuses the editor first. Run with
`M-x browser-view`. Implementation: the `open-browser-view!` spine
primitive.
:::

### Media views

Media files are not opened by a command but by suffix: visit one with
cmd(find-file) (`C-x C-f`) or from a directory browser, and the server
routes it to the matching view instead of the text editor. The suffix map: `.png .jpg .jpeg .gif .svg .webp` →
image; `.mp3 .flac .wav .ogg .oga .m4a .aac .opus` → audio;
`.mp4 .m4v .webm .mov .mkv` → video; `.pdf` → PDF. Each is an ordinary
view — it takes a pane slot, joins tablines, and dies to `C-x k`. In
all four, modifier chords forward to the global keymap.

- **Image** (`image-view.js`) — the picture on a stage, with a toolbar
  toggling between *fit* (auto-resizes with the pane) and an explicit
  zoom factor; pinch-zoom adjusts the factor continuously, and an info
  line reports name, dimensions and zoom.
- **Audio** (`audio-view.js`) — an HTML5 player with the file's tag
  metadata beside it. The standard fields (artist, album, track, year,
  genre) are *editable*: change one and press Enter to write it back to
  the file's tags (Escape reverts). Album art shows when the file
  carries it. `space` toggles play / pause; `q` dismisses the buffer.
- **Video** (`video-view.js`) — an HTML5 player, centred with the
  aspect ratio preserved. `space` toggles play / pause; `q` dismisses
  the buffer. Chromium cannot decode `.mkv` natively; the view mounts
  but shows a no-playable-source message.
- **PDF** (`pdf-view.js`) — a PDF.js render with the editor's own
  chrome: page navigation, zoom controls (presets plus *fit* and
  *width* modes, and pinch-zoom), and a find input that highlights
  matches in the text layer. Page and zoom survive tab switches and
  relaunches. In a LaTeX project, Option-click on a page runs inverse
  SyncTeX and jumps the editor to the source line (see `latex.md`).

:::function{name="*pdf-restore-default*" path="reference/views/pdf-restore-default.html"}
#### `*pdf-restore-default*`

Whether a freshly-opened PDF view persists across a relaunch. A boolean
`defcustom` in the `views` group, default `#t`: every PDF is restored
on startup. Set `#f` to keep generic / texdoc PDFs transient —
something you opened to read once, gone on relaunch. A LaTeX project's
own output PDF persists regardless, via `*latex-pdf-restore*` (see
`latex.md`).
:::

### Element views

The generic mechanism behind several of the views above: an
*element view* hosts an arbitrary HTML custom element as a full
citizen of the pane system, described by a small spec (tag, module,
attributes, fit, keyboard policy). Each registered spec's name is an
`M-x` command that opens it. The built-ins: `notebook-cells`
(documented above), `atari` (a Stella-based Atari 2600 emulator), and
`bib-search` (a bibliography search panel that inserts `\cite{…}` into
the active document — see `latex.md`). The registry lives in
`apps/desktop/src/element-spec.js`; the design is in
`plans/ELEMENT-VIEWS.md`.
