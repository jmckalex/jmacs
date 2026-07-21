## Views

A *buffer* is the thing you edit; a *view* is the surface that shows it.
Most of the time the two coincide so completely that the distinction is
invisible — you open a text file and the text editor draws it, and there
is nothing more to say. But text is only one *kind* of view. Godot treats
the editing surface as a polymorphic slot: a pane holds a view, and a view
can render a PTY terminal, a PDF, an image, a live web page, a plotting
REPL, a notebook, a directory tree, or an album of audio just as
readily as it renders characters on a grid.

This is the "everything is a view" idea. The pane tree, the tabline, the
buffer list, `C-x b`, `C-x o`, the View List (`C-x C-b`) — all of the
window machinery treats these alternative surfaces exactly as it treats a
text buffer. You split a pane and put a PDF on one side and your notes on
the other; you switch to a running shell by name; you move a browser
between panes. Each kind owns its own on-screen widget (its renderer lives
under `packages/renderer/src/`), but they all sit in the same slot, and
the keys that move *between* views are the same everywhere. (The panes
and tabs those views sit in are the Windows chapter's subject.)

Two ways lead to a non-text view. Some are opened by a *command* — you ask
for a shell, a notebook, a gnuplot session. Others are opened *by file
type* — you visit a file with cmd(find-file) (`C-x C-f`) and the host
inspects its suffix:

| Suffixes | View |
|----------|------|
| `.png` `.jpg` `.jpeg` `.gif` `.svg` `.webp` | image |
| `.mp3` `.flac` `.wav` `.ogg` `.oga` `.m4a` `.aac` `.opus` | audio |
| `.mp4` `.m4v` `.webm` `.mov` `.mkv` | video |
| `.pdf` | PDF |

Everything else opens as text. The sections below cover each kind: how
to open it, what it does, and the keys that work *inside* it.

A note on keys that leave a view. Inside these surfaces, the input often
belongs to the view — you are typing into a terminal, a URL bar, a gnuplot
prompt. Most views forward the chord keys they do not consume back to the
editor's keymap, so `C-x b`, `C-x o`, `M-x` and the prefix chords keep
working while a PDF, an image, or a gnuplot input has focus. Two views
are hungrier: the shell's terminal claims the Control keys as terminal
bytes, and a focused browser *page* swallows every keystroke. Each
section below says which keys the view keeps.

### The shell

cmd(shell) (`M-x shell`) opens a shell view: a real terminal connected to
a child process running your default shell (`$SHELL`, falling back to
`/bin/zsh`). It is a genuine PTY — the terminal is xterm.js over a pty
master, so full-screen curses programs (`vi`, `top`, `less`) work, colour
and cursor control sequences are honoured, and the terminal's size is sent
to the pty so programs see the right `$COLUMNS` and `$LINES`. The view's
header carries a small `[pty]` adornment when a true PTY is in use. (The
pty comes from a tiny `python3` helper script — Python's standard `pty`
module, no native addons; on the rare system without `python3` on the
path, the session falls back to a plain pipe, the header reads `[pipe]`,
and curses programs won't work.)

You type at the terminal and the bytes go straight to the shell; output
streams back into the same grid. Because this is a transcript-and-cursor
terminal rather than a line-by-line panel, the usual terminal keys are
yours to use:

- `C-c` — send `SIGINT` to the running command. This is the plain
  Ctrl+C, and it always interrupts, selection or no selection.
- `C-d` — at an empty line, end the shell session.
- `C-l`, arrow keys, tab completion, history — all handled by the shell
  itself, exactly as in any terminal.

Copying is on the *Command* key, as everywhere on the platform: with
text selected in the terminal, Cmd+C copies the selection to the system
clipboard; with no selection it falls through. Copy and interrupt are
different chords — there is no conflict between them.

The terminal owns the Control keys — `C-x` here is a terminal byte, not
an editor prefix — but Command chords bubble past it to the editor, so
`M-x` still works. To leave a focused shell by keyboard, go through an
`M-` route or click another pane.

Each call to cmd(shell) creates a *new* buffer with its own long-lived
shell process. To return to an open shell, switch to it by name with
`C-x b` rather than spawning another. To dispose of one, kill it with
`C-x k` or close its tab — a live-process view is reaped on tab close
either way, ending the process.

### PDF

Visit a `.pdf` file with cmd(find-file) (`C-x C-f`) and it opens in the PDF
view — a continuous-scroll viewer that renders each page to a canvas with
a selectable text layer over it (the same engine that powers Firefox's
built-in viewer). The chrome is Godot's own, so it matches the editor.

The toolbar carries the controls:

- **Page navigation** — *previous* and *next* page buttons, and a page
  number field you can type a page into and press `enter` to jump.
- **Zoom** — *zoom-out* and *zoom-in* buttons step through the preset
  levels (50%, 75%, 100%, 125%, 150%, 200%, 300%), and a select offers
  those presets plus two fit modes: *fit page* and *fit width*, which
  re-flow as the pane is resized. A trackpad **pinch** zooms
  continuously, off the preset ladder.
- **Find** — a search field highlights matches on the page. With the find
  field focused, `enter` advances to the next match and `S-enter` to the
  previous; matches cycle within the current page before jumping to
  the next page that contains the needle. `escape` clears the search and
  returns focus to the document.

The view remembers where you are: each PDF tab keeps its own page, zoom,
and scroll position, so a PDF waiting in a background tab — or carried to
another pane — comes back exactly as you left it. Whether a PDF view is
restored at all when a workspace reopens is governed by the customizable
`*pdf-restore-default*` (default `#t`; LaTeX compile output has its own
switch, `*latex-pdf-restore*`).

Outside the find and page fields, chord keys forward to the editor's
keymap as usual, so `C-x b` and friends work while a PDF is in front of
you. If you compile LaTeX, the PDF view is also the SyncTeX target: an
**Option-click** in the PDF jumps to the matching source line (see the
LaTeX chapter).

### Image

Visit an image — `.png`, `.jpg`/`.jpeg`, `.gif`, `.svg`, `.webp` — with
cmd(find-file) and it opens in the image view. The image is read as a data
URL and shown on a stage with a small toolbar above it.

The view has two zoom modes and one control that toggles between them:

- **Fit to window** (the default) — the image is scaled to fit the pane.
- **Actual size (100%)** — the image is shown at its native resolution.

The toolbar button reads *Actual size (100%)* while you are fitted and
*Fit to window* while you are at 100%; clicking it flips the mode. A
trackpad **pinch** zooms continuously, anchored at the cursor — after a
pinch the view is at whatever scale you left it, and the button reads
*Fit to window* to take you back. The toolbar's info line shows the
file's particulars. Every other key forwards to the editor's keymap.

The image view is also where the jukebox sends album art: `M-enter` on a
track opens the cover image as its own image buffer (see *Jukebox and
audio*, below).

### Web / browser

The browser view wraps a real Chromium web view in a thin chrome of *back*,
*forward*, *reload* and *stop* buttons plus a URL bar. Open one with
cmd(browser-view) (`M-x browser-view`): it prompts for a URL in the
minibuffer, and an empty answer opens the home page (`about:blank`) so
you can type the address into the view's own URL bar instead. Each call
opens a *new* browser view (`*Browser*`, `*Browser*<2>`, …); close one
with `C-x k` or its tab's ×, which tears the web view down.

Inside the view:

- **URL bar** — type a URL (or a bare host; it is normalised to a full
  URL) and press `enter` to navigate.
- **Back / Forward** — walk the page history; the buttons enable and
  disable as history allows.
- **Reload** / **Stop** — reload the current page, or stop a load in
  progress.

Each browser view owns its own web-view guest, so two browsers can sit in
two panes without fighting over one shared page, and a browser carried
between panes keeps the page you are actually on. Know where the keys
go, though: while the *chrome* — the URL bar, the toolbar — has focus,
unconsumed chords forward to the editor's keymap as usual; but once the
*page itself* has focus, it swallows every keystroke. That is why the
pane-rearranging commands live on the View menu (see the Windows
chapter) — the menu works even when a page holds the keyboard. The
mouse always works.

### Gnuplot

cmd(gnuplot) (`M-x gnuplot`, or `C-c g`) opens a gnuplot view: a long-lived
`gnuplot` child process presented as a notebook-style REPL. You type a
gnuplot command at the bottom input line and press `enter`; the result
appears as a cell above — a rendered plot as inline SVG, text output, or
an error. Successive commands stack as a transcript of cells, so a session
reads as the sequence of plots you built.

The input line's keys:

- `enter` — run the command on the input line; its result becomes a new
  cell.
- `up` / `down` — recall previous commands from this session's history.
- `C-c` — interrupt a running plot (sends `SIGINT`), the gnuplot analogue
  of the shell's interrupt. (Mid-chord — e.g. while composing `C-x C-c` —
  this `C-c` is *not* swallowed, so prefix sequences still work.)

Other chord keys forward to the editor's keymap.

gnuplot must be installed (`brew install gnuplot`). When it is not, the
view degrades gracefully to a card with install instructions rather than
failing. As with the shell, each call to cmd(gnuplot) creates a fresh
buffer with its own process; return to an open one by name with `C-x b`.

### The notebook

cmd(notebook-cells) (`M-x notebook-cells`) opens a cell notebook: a
column of JavaScript cells, each with a small header (a *Run* button)
and an output region below it. Structurally it is one editor, not many —
every cell lives in a single unified buffer shown through the ordinary
text editor, so you get one syntax parse, full highlighting, and all the
normal editing keys across the whole sheet; the per-cell chrome is drawn
by the same widget layer that renders math previews. A fresh notebook
opens with a small worked example so the moving parts are visible.

Running:

- `S-enter` — run the current cell (also `C-enter` or `M-enter`).
- The **Run all** toolbar button runs every cell, top to bottom.
- **+ Cell** appends a new cell.

Cells share state, Jupyter-style: a cell's top-level `const` and
`function` declarations persist into a per-notebook scope, so later
cells can use what earlier cells defined. Evaluation happens in the
server's Node session — the renderer's content-security policy forbids
`eval`, so cell code runs in the editor's own server process and the
result comes back as a rendered value, console output and errors
included.

The toolbar's **Open** and **Save** buttons read and write a notebook
file: on disk a notebook is plain text, cells separated by `// @cell
[name]` fence lines. A notebook saves its *arrangement* — cell sources
and names; results are runtime-only and are recomputed by running.

v1 is JavaScript code cells; command chords (`M-x`, `C-x …`) bubble to
the editor as usual while a cell has focus.

### Directory browsers

Godot ships two directory browsers. Both are ordinary commands that
prompt for the directory in the minibuffer, and in both, activating a
*file* routes it through the host's open path, so it lands in whichever
view its suffix maps to — text, image, audio, video, PDF (see the table
in the introduction).

**Tree.** cmd(directory-tree) (`M-x directory-tree`, prompt
"Directory tree: ") opens a tree view rooted at the chosen directory.
Folders expand and collapse in place; files open on activation. Its
keys:

- `up` / `down` — move the selection up and down the flattened row list.
- `enter` — activate the selected row: expand or collapse a folder, or
  open a file.
- `space` — toggle the selected folder open or closed; on a file, acts
  like `enter`.
- `q` — dismiss the buffer.

Clicking a folder row expands or collapses it; clicking a file opens it.
Where an activated file opens is a policy: the customizable
`*directory-tree-open-target*` is one of `editing-pane` (the main
editing area — the default), `other-pane` (the next pane after the
tree), or `this-pane` (the tree's own pane, promoted to a tabline).

**Columns.** cmd(directory-columns) (`M-x directory-columns`, prompt
"Directory columns: ") opens a Finder-style column browser rooted at the
chosen directory. Each column is one directory's listing. Clicking a
subfolder spawns a new column to its right, so the path you have
drilled into reads left-to-right across the columns. Clicking a *file*
previews it in the trailing column; *double-clicking* a file opens it as
its own buffer in the appropriate view. `q` dismisses the buffer.

### Jukebox and audio

cmd(jukebox) (`M-x jukebox`, or `C-x j`) opens a jukebox view over a
directory of audio files: cover art, an `<audio>` player, and a numbered
track list. It prompts for the directory in the minibuffer
("Jukebox directory: ").

The track list shows one row per audio file. By default a row reads
`"Title", Artist, Album`, pulled from the file's embedded tags; the format
is a template you can customise through the `*jukebox-track-format*`
setting, with `{title}`, `{artist}`, `{album}`, `{track}`, `{year}`,
`{genre}` and `{filename}` placeholders (see the Customization chapter
for how to set it). A file with no usable tags falls back to its bare
filename.

Cover art favours the track: art embedded in the file itself (an MP3's
ID3v2 picture, an MP4's cover atom) is shown in preference to any
sidecar image in the directory, so each track in a mixed-album
directory can carry its own cover; a directory sidecar is the fallback.

The jukebox keys:

- `space` — play / pause.
- `enter` — play the focused track.
- `n` / `p` — step to the next / previous track.
- `s` — toggle shuffle.
- `R` — randomise the play order.
- `g` — refresh the listing.
- `q` — quit the jukebox buffer.
- `M-enter` — open the album-art file as an image buffer.

A toolbar mirrors the main controls (Shuffle, Randomise, Refresh, Quit).
Playback runs through a shared audio controller, so a track keeps playing
when you switch buffers.

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

### Element views

"Everything is a view" has an extension point. `define-element-view`
registers any custom HTML element — any embeddable web component — as a
full Godot view, in a handful of lines of Lisp:

```lisp
(define-element-view atari
  :title    "Atari 2600"
  :module   "apps/desktop/vendor/stella/stella-element.js"
  :tag      "stella-emulator"
  :attrs    '((controls))
  :keyboard 'grab)
```

The kind names both the view and a command that opens it, so this
definition puts `M-x atari` on the command table; the view gets a pane
slot, a tab, and everything else a view gets. The spec is a plist:
`:title` labels the tab, `:module` is the script that defines the
element, `:tag` is the element to create, `:attrs` its attributes, and
`:keyboard` says who owns the keys — `'grab` (the element owns the
keyboard while focused; the default, and right for an emulator),
`'share` (the element gets keys but `C-`/`M-`/`A-` chords pass through
to the editor), or `'off` (everything bubbles to the editor).

Two element views ship as worked examples: `M-x atari` (a Stella Atari
2600 emulator) and `M-x bib-search` (a bibliography search panel). The
notebook of *The notebook* above is itself an element view — proof the
extension point carries real weight.

### Other views

Several more surfaces you meet elsewhere in this manual are views in
exactly the same sense — they sit in panes, take a tab, and answer to
`C-x b` and `C-x o`:

- **The View List** (`C-x C-b`, cmd(list-views)) — the buffer menu; see
  the Files and Buffers chapter.
- **The bookmark list** (`C-x r l`) — see the Search, marks, and
  navigation chapter.
- **The customize interface** — see the Customization chapter.
- **Manual and reference pages** (`C-h d`, cmd(open-manual)) — the
  in-app documentation renders as doc views.
- **The minimap** (`C-x m`) — the code-overview companion pane; see the
  Windows chapter.
- **The REPL and utility dock** (`C-x p`) — see the Extending chapter.
