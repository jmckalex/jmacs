## Views

A *buffer* is the thing you edit; a *view* is the surface that shows it.
Most of the time the two coincide so completely that the distinction is
invisible — you open a text file and the text editor draws it, and there
is nothing more to say. But text is only one *kind* of view. jmacs treats
the editing surface as a polymorphic slot: a pane holds a view, and a view
can render a PTY terminal, a PDF, an image, a live web page, a plotting
REPL, a reactive notebook, a directory tree, or an album of audio just as
readily as it renders characters on a grid.

This is the "everything is a view" idea. The pane tree, the tab line, the
buffer list, `C-x b`, `C-x o`, the View List (`C-x C-b`) — all of the
window machinery treats these alternative surfaces exactly as it treats a
text buffer. You split a pane and put a PDF on one side and your notes on
the other; you switch to a running shell by name; you move a browser
between panes. Each kind owns its own on-screen widget (its renderer lives
under `packages/renderer/src/`), but they all sit in the same slot, and
the keys that move *between* views are the same everywhere.

Two ways lead to a non-text view. Some are opened by a *command* — you ask
for a shell, a notebook, a gnuplot session. Others are opened *by file
type* — you visit a file with cmd(find-file) (`C-x C-f`) and the host
inspects its suffix: a `.pdf` lands in the PDF view, a `.png` in the image
view, a `.mp4` in the video view, a `.rxlisp` in the notebook view, and so
on. The sections below cover each kind: how to open it, what it does, and
the keys that work *inside* it.

A note on keys that leave a view. Inside these surfaces, the input often
belongs to the view — you are typing into a terminal, a URL bar, a gnuplot
prompt. So each view forwards the chord keys it does not consume back to
the editor's keymap. `C-x b`, `C-x o`, `M-x` and the prefix chords keep
working no matter which kind of view has focus; the view only swallows the
keys that are meaningfully its own.

### The shell

cmd(shell) (`M-x shell`) opens a shell view: a real terminal connected to
a child process running your default shell (`$SHELL`, falling back to
`/bin/zsh`). It is a genuine PTY — the terminal is xterm.js over a pty
master, so full-screen curses programs (`vi`, `top`, `less`) work, colour
and cursor control sequences are honoured, and the terminal's size is sent
to the pty so programs see the right `$COLUMNS` and `$LINES`. The view's
header carries a small `[pty]` adornment when a true PTY is in use (and
`[pipe]` on the rare fallback).

You type at the terminal and the bytes go straight to the shell; output
streams back into the same grid. Because this is a transcript-and-cursor
terminal rather than a line-by-line panel, the usual terminal keys are
yours to use:

- `C-c` — send `SIGINT` to the running command.
- `C-d` — at an empty line, end the shell session.
- `C-l`, arrow keys, tab completion, history — all handled by the shell
  itself, exactly as in any terminal.

A subtlety worth knowing: when text is selected in the terminal, `C-c`
(Cmd+C) copies that selection rather than interrupting — the terminal's
selection takes precedence, as you would expect from a terminal emulator.

Each call to cmd(shell) creates a *new* buffer with its own long-lived
shell process. To return to an open shell, switch to it by name with
`C-x b` rather than spawning another.

### PDF

Visit a `.pdf` file with cmd(find-file) (`C-x C-f`) and it opens in the PDF
view — a continuous-scroll viewer that renders each page to a canvas with
a selectable text layer over it (the same engine that powers Firefox's
built-in viewer). The chrome is jmacs's own, so it matches the editor.

The toolbar carries the controls:

- **Page navigation** — *previous* and *next* page buttons, and a page
  number field you can type a page into and press Enter to jump.
- **Zoom** — *zoom-out* and *zoom-in* buttons step through the preset
  levels (50%, 75%, 100%, 125%, 150%, 200%, 300%), and a select offers
  those presets plus two fit modes: *fit page* and *fit width*, which
  re-flow as the pane is resized.
- **Find** — a search field highlights matches on the page. With the find
  field focused, `Enter` advances to the next match and `S-Enter` (Shift)
  to the previous; matches cycle within the current page before jumping to
  the next page that contains the needle. `Escape` clears the search and
  returns focus to the document.

Outside the find and page fields, chord keys forward to the editor's
keymap as usual, so `C-x b` and friends work while a PDF is in front of
you. If you compile LaTeX, the PDF view is also the SyncTeX target: a
click in the PDF can jump to the matching source line (see the LaTeX
chapter).

### Image

Visit an image — `.png`, `.jpg`/`.jpeg`, `.gif`, `.svg`, `.webp` — with
cmd(find-file) and it opens in the image view. The image is read as a data
URL and shown on a stage with a small toolbar above it.

The view has two zoom modes and one control that toggles between them:

- **Fit to window** (the default) — the image is scaled to fit the pane.
- **Actual size (100%)** — the image is shown at its native resolution.

The toolbar button reads *Actual size (100%)* while you are fitted and
*Fit to window* while you are at 100%; clicking it flips the mode. The
toolbar's info line shows the file's particulars. Every other key forwards
to the editor's keymap.

The image view is also where the jukebox sends album art: `M-RET` on a
track opens the cover image as its own image buffer (see *Jukebox and
audio*, below).

### Web / browser

The browser view wraps a real Chromium web view in a thin chrome of *back*,
*forward*, *reload* and *stop* buttons plus a URL bar. It is opened by the
host primitive `open-url!` — call it from the REPL, e.g.
`(open-url! "https://example.com")`, and the page loads in the active pane.
`open-url!` is navigation-aware: if the active pane already shows a
browser, it navigates *that* browser in place rather than spawning a
duplicate; otherwise it opens a fresh one.

Inside the view:

- **URL bar** — type a URL (or a bare host; it is normalised to a full
  URL) and press `Enter` to navigate.
- **Back / Forward** — walk the page history; the buttons enable and
  disable as history allows.
- **Reload** / **Stop** — reload the current page, or stop a load in
  progress.

Each browser view owns its own web-view guest, so two browsers can sit in
two panes without fighting over one shared page, and a browser carried
between panes keeps the page you are actually on. A focused web page
naturally captures most keys (it is a live page); the editor's chord keys
still reach the keymap through the surrounding chrome.

### Gnuplot

cmd(gnuplot) (`M-x gnuplot`, or `C-c g`) opens a gnuplot view: a long-lived
`gnuplot` child process presented as a notebook-style REPL. You type a
gnuplot command at the bottom input line and press `Enter`; the result
appears as a cell above — a rendered plot as inline SVG, text output, or
an error. Successive commands stack as a transcript of cells, so a session
reads as the sequence of plots you built.

The input line's keys:

- `Enter` — run the command on the input line; its result becomes a new
  cell.
- `Up` / `Down` — recall previous commands from this session's history.
- `C-c` — interrupt a running plot (sends `SIGINT`), the gnuplot analogue
  of the shell's interrupt. (Mid-chord — e.g. while composing `C-x C-c` —
  this `C-c` is *not* swallowed, so prefix sequences still work.)

Other chord keys forward to the editor's keymap.

gnuplot must be installed (`brew install gnuplot`). When it is not, the
view degrades gracefully to a card with install instructions rather than
failing. As with the shell, each call to cmd(gnuplot) creates a fresh
buffer with its own process; return to an open one by name with `C-x b`.

### The reactive notebook

cmd(notebook) (`M-x notebook`, or `C-c n`) opens a reactive Lisp notebook
— a sheet of named cells where editing one recomputes everything
downstream, in the spirit of a spreadsheet or an Observable notebook.
A notebook on disk is a `.rxlisp` file; visiting one with cmd(find-file)
opens it in this same view.

The canonical content is a sequence of `(cell NAME EXPR)` forms. The view
renders one editable cell per form — a name field and a multi-line
expression editor — with a result panel beside each. Cells refer to one
another *by bare name*: a cell named `area` can be written
`(* pi radius radius)` and the engine resolves `radius` to the value of
the cell of that name. (Writing `(ref 'radius)` explicitly also works; the
bare-name form is sugar over it.)

The defining behaviour is reactivity, and it is automatic:

- **There is no run key and no input line.** Editing *any* cell
  re-serializes the sheet and recomputes. You change a number and every
  cell that depends on it updates.
- **Dependencies are discovered, not declared.** The engine notes which
  cells each cell reads as it runs, builds the dependency graph, and
  recomputes in topological order, so an upstream change always reaches
  downstream cells in the right sequence.
- **Cycles are reported.** A cell that depends on itself, directly or
  through a chain, is flagged as an error naming the cycle, rather than
  looping.
- **A cell can show a graphic.** If a cell's value is an inline-SVG string
  (`<svg …>…</svg>`), the view draws it instead of printing text — that is
  how a notebook cell renders a plot or a diagram.

Several notebooks can be open at once. cmd(next-notebook) (`C-c C-n`) and
cmd(previous-notebook) (`C-c C-p`) cycle among them, and
cmd(rename-notebook) changes a notebook's display name (its label, not the
file on disk). As with every view kind, the prefix chords and `M-x` keep
working while a cell editor has focus.

### Directory browsers

jmacs ships two directory browsers, each opened with a path argument from
the REPL (they take the directory to root at, so they are commands you call
rather than bare `M-x` entries). In both, activating a *file* routes it
through the host's open path, so it lands in whichever view its suffix maps
to — text, image, audio, video, PDF.

**Tree.** `(directory-tree "<path>")` opens a tree view rooted at a
directory. Folders expand and collapse in place; files open on activation.
Its keys:

- `↑` / `↓` — move the selection up and down the flattened row list.
- `Enter` — activate the selected row: expand or collapse a folder, or
  open a file.
- `Space` — toggle the selected folder open or closed; on a file, acts
  like `Enter`.
- `q` — dismiss the buffer.

Clicking a folder row expands or collapses it; clicking a file opens it.

**Columns.** `(directory-columns "<path>")` opens a Finder-style column
browser rooted at a directory. Each column is one directory's listing.
Clicking a subfolder spawns a new column to its right, so the path you have
drilled into reads left-to-right across the columns. Clicking a *file*
previews it in the trailing column; *double-clicking* a file opens it as
its own buffer in the appropriate view. `q` dismisses the buffer.

### Jukebox and audio

cmd(jukebox) (`M-x jukebox`, or `C-x j`) opens a jukebox view over a
directory of audio files: cover art, an `<audio>` player, and a numbered
track list. Called with no argument it pops a directory picker; called with
a path — `(jukebox "~/Music/album")` — it opens that directory directly.

The track list shows one row per audio file. By default a row reads
`"Title", Artist, Album`, pulled from the file's embedded tags; the format
is a template you can customise through the `*jukebox-track-format*`
setting, with `{title}`, `{artist}`, `{album}`, `{track}`, `{year}`,
`{genre}` and `{filename}` placeholders. A file with no usable tags falls
back to its bare filename.

The jukebox keys:

- `SPC` — play / pause.
- `RET` — play the focused track.
- `n` / `p` — step to the next / previous track.
- `s` — toggle shuffle.
- `R` — randomise the play order.
- `g` — refresh the listing.
- `q` — quit the jukebox buffer.
- `M-RET` — open the album-art file as an image buffer.

A toolbar mirrors the main controls (Shuffle, Randomise, Refresh, Quit).
Playback runs through a shared audio controller, so a track keeps playing
when you switch buffers and the Lisp `audio-playing?` predicate can see it.

**Single audio files.** Visiting a single audio file — `.mp3`, `.flac`,
`.wav`, `.ogg`/`.oga`, `.m4a`, `.aac`, `.opus` — with cmd(find-file) opens
the audio view rather than the jukebox: cover art, the song's metadata, and
a standard `<audio>` player with its native transport controls. The
metadata fields are editable, and a `+` button adds a new tag row.
Switching away pauses the element; switching back resumes from where you
left off, so several audio files can sit open alongside the jukebox without
their playheads colliding.

### Video

Visiting a video file — `.mp4`, `.m4v`, `.webm`, `.mov`, `.mkv` — with
cmd(find-file) opens the video view: a `<video>` element with its native
controls (play/pause, scrubber, volume, fullscreen). The view always
mounts, but playback depends on what Chromium can decode — most containers
play, but Chromium does not natively decode Matroska (`.mkv`), so such a
file mounts with the element's native error UI and an explanatory headline
rather than silently failing.
