## Files and buffers

A working session in Godot is a set of buffers — text held in memory,
each usually attached to a file on disk — and the views that show them.
This chapter covers the everyday traffic between disk and screen:
opening a file and saving it, finding your way around the filesystem
from the minibuffer, moving between the buffers you have open, telling
at a glance which of them have unsaved changes, and recovering work the
editor was holding when something went wrong.

One fact frames everything else here. Buffers do not live in a window;
they live in the **Lisp server** — the single Node process every editor
window connects to. A window is a *client*: it shows some of the
server's buffers and edits them, but the buffers themselves are shared.
Two windows can show the same buffer, each with its own cursor; a
buffer outlives the window that opened it; closing a window (`C-x 5 0`)
never loses work. Only quitting the editor tears the buffers down —
which is why quit, and only quit, runs the unsaved-changes
interrogation described at the end of this chapter. The server also
owns the filesystem: the reads and writes behind cmd(find-file) and
cmd(save-buffer) are done directly by the server process, not routed
through a window.

A note on vocabulary. A *buffer* is the text; a *view* is a buffer
being shown in a pane. The command names in this area say "view" —
cmd(switch-view), cmd(kill-view), cmd(list-views) — because they act on
what is on screen, but for an ordinary text file the two move together,
and the prose below says "buffer" except where the difference matters.
Keys follow the manual's notation: `C-` is Control, `M-` is Command
(the Mac's Meta), `A-` is Option, `S-` is Shift — see the *Keys and
commands* chapter.

### Opening a file

`C-x C-f` (cmd(find-file)) opens a file. It does not pop a native
dialog; it prompts in the minibuffer for a path, seeded with the
directory of the file you are already visiting — falling back to your
home directory in a buffer with no file — with a trailing slash so you
can start completing immediately:

```
Find file: /Users/jane/project/
```

Type a path and press `Enter` to open it. A leading `~` expands to your
home directory. Opening a file sets the buffer's major mode from the
file's name — a `.lisp` file arrives in Lisp mode, a `.md` file in
Markdown mode — with no further action (see *Modes*). If some buffer is
already visiting the path, `C-x C-f` switches to that buffer, unsaved
edits and all, rather than reading a second copy from disk.

The path does not have to name a text file:

- A **directory** opens as a directory tree view rooted there (see the
  *Views* chapter).
- An **image, PDF, audio, or video** file opens in the matching media
  view.

A path that names nothing is an error: the echo area reports
`find-file: cannot open <path>` and no buffer is created. To start a
*new* file, write the content first and name it on the way out: open a
scratch buffer (`C-x n`), type, and save — a buffer with no file falls
back to the `Write file: ` prompt, which creates the file (see *Saving
a file* below).

#### TAB completion

The find-file prompt completes paths against the live filesystem.
Pressing `Tab` looks at what you have typed so far, splits it at the
last `/` into a directory and a partial name, lists that directory, and
acts on what it finds:

- **One match.** The name is filled in for you. If it is a directory, a
  trailing `/` is added so the next `Tab` descends straight into it.
- **Several matches with a common prefix.** The path is extended by as
  much as every candidate shares — the longest common prefix — and you
  carry on typing or completing from there.
- **Several matches with nothing more in common.** No more can be filled
  in unambiguously, so the path is left unchanged and the candidates are
  *listed* (see the Completions panel, below).
- **No match.** Nothing changes: the path stays exactly as you typed it,
  and the candidate list empties.

The prefix match ignores case — typing `rea` and pressing `Tab` in a
directory holding `README.md` completes to `README.md`, taking the
file's real on-disk case rather than yours.

#### The Completions panel

Godot does not cram candidate lists into the one-line minibuffer
status. Whenever a `Tab` finds matching entries, they are routed to a
**Completions** panel — a scrollable, clickable tab in the utility dock
at the foot of the window, headed by a count (`12 completions`). Each
matching entry gets a row, with a folder icon on directories (which
carry a trailing slash) and a file icon on the rest. Every subsequent
`Tab` refreshes the list in place.

The panel is display-only and non-modal: it owns no keys, so the
minibuffer keeps the focus and you keep typing and `Tab`-completing with
the list in view. You can also drive it with the mouse:

- **Single-click** a row to *select* it — its name is filled into the
  minibuffer path, without opening anything. The panel stays put, so you
  can keep narrowing.
- **Double-click** a row to *activate* it — open the file, or descend
  into the directory and list its contents in turn.

The panel is transient by construction: when the find-file command
finishes — whether you open something or cancel with `C-g` — it is
cleared away, so a busy directory leaves no clutter behind once you
have made your choice.

### Saving a file

`C-x C-s` (cmd(save-buffer)) writes the current buffer to its file and
echoes `Saved`. The write is atomic — the text goes to a temporary file
which is then renamed over the target — so a crash mid-save can never
leave a half-written file behind. What happens depends on the buffer:

- **The buffer is visiting a file.** The text is written there, the
  dirty flag clears, and the echo area shows `Saved`.
- **The buffer has no file** — a scratch buffer, or one recovered
  without a path. cmd(save-buffer) falls back to cmd(write-file): the
  minibuffer prompts `Write file: ` for a path, and the file is created
  there. This is how a new file is born.
- **The write fails** — permissions, a vanished directory. The failure
  is reported in the echo area and the buffer stays dirty; nothing is
  lost but nothing was written.

#### Save as

`C-x C-w` (cmd(write-file)) is save-as: it prompts `Write file: ` for a
path, writes the buffer's text there (atomically, as above), and
*rebinds* the buffer to the new path — from then on `C-x C-s` saves to
the new file, the modeline shows the new name, and the echo area
confirms with `Wrote <name>`. The prompt accepts the same `~` expansion
as find-file. The original file, if there was one, is left as it was
last saved.

### The unsaved-changes indicator

A buffer is *dirty* when its text differs from the last text saved to
(or loaded from) disk. Godot shows this as a single glyph at the front
of the modeline: `●` when dirty, `–` when clean. The same modeline text
is mirrored into the operating system's window title, so the flag is
visible even from the dock or a window switcher, and the buffer list
(below) carries the same `●`/`–` per row.

The flag appears as soon as an edit moves the text away from the saved
version, and clears the instant the buffer matches its baseline again —
so saving removes it, and so does undoing back to the saved state. Two
edge cases behave the way you would hope: a fresh scratch buffer counts
as clean until you actually edit it (its seed content is its baseline),
and a buffer recovered after a crash counts as dirty relative to what
is on disk — precisely the edits that need saving.

### Working with several buffers

The server holds a list of buffers; each window shows one (or several,
via panes and tabs — see *Windows: panes and tabs*). Several commands
move between them:

| Action | Key | Command |
|--------|-----|---------|
| Switch to a buffer by name | `C-x b` | cmd(switch-view) |
| Next / previous buffer | `C-x →` / `C-x ←` | cmd(next-view) / cmd(previous-view) |
| New scratch buffer | `C-x n` | cmd(scratch-buffer) |
| List all buffers | `C-x C-b` | cmd(list-views) |
| Kill the current buffer | `C-x k` | cmd(kill-view) |

`C-x b` (cmd(switch-view)) prompts `Switch to buffer: ` in the
minibuffer. You need not type the whole name: on `Enter` an exact name
wins, and otherwise the shortest buffer name *containing* what you
typed is chosen — `boo` finds `bookmarks.lisp`. If nothing matches, the
echo area reports `No buffer named "…"` and nothing is created or
switched. (This prompt does not `Tab`-complete.)

`C-x →` and `C-x ←` step through the window's open buffers in order
without a prompt, which is the quickest way to cycle when you have only
a handful open.

`C-x n` (cmd(scratch-buffer)) opens a fresh scratch buffer — seeded
with the same Lisp playground text as the startup scratch, and named
uniquely: `scratch.lisp`, then `scratch-2.lisp`, and so on. It reads as
clean until you edit it.

`C-x k` (cmd(kill-view)) kills the current buffer: it is removed from
the server, and every pane in every window that was showing it switches
to another buffer. Killing does **not** ask about unsaved changes — the
edits go with the buffer — so glance at the modeline flag first. The
last remaining buffer refuses to die (`kill-view: refusing to kill the
only buffer`); an editor always shows something. Closing a *tab* in a
pane's tabline (the ✕ — see *Windows: panes and tabs*) kills the buffer
too by default; set `*close-tab-kills-view*` to `#f` if you would
rather a closed tab merely leave that pane's strip while the buffer
lives on in the buffer list.

### The buffer list

`C-x C-b` (cmd(list-views)) opens the **buffer list** — a picker
overlay titled `Buffer list`, with one row per open buffer showing its
name, its line count, and the `●`/`–` dirty flag, with the current
buffer preselected. It is the standard picker used throughout the
editor: type to narrow the list, move with the arrow keys, press
`Enter` (or click a row) to switch to that buffer, `Escape` to cancel
and stay put. The picker is a transient overlay — it holds no state and
leaves nothing behind.

### Sessions and workspaces

The server remembers which files you had open: relaunching Godot
restores the previous session's files. Beyond that automatic memory,
quitting offers to save a **named workspace**:

```
Remember this workspace as (empty = don’t):
```

Type a name and the whole *arrangement* — windows, panes, open files,
cursors, window geometry — is saved under that name and offered in the
launch chooser next time; press `Enter` on an empty prompt to skip
(the last arrangement is still auto-remembered); `C-g` cancels the
quit itself. A workspace is an arrangement, not the text: the documents
themselves live in their files. Workspaces are stored in
`~/.godot/workspaces.json` — see the *Customization* chapter for the
config home.

### Crash recovery

Godot autosaves your unsaved work so a crash cannot take it. Every few
seconds, the server writes a *recovery snapshot* of each dirty buffer's
full text to a private recovery directory. A snapshot records enough to
identify the buffer later: its path, its name, when it was snapshotted,
and a hash of its contents. Clean buffers are never snapshotted — the
work is on disk, so there is nothing to protect.

#### Recovering after a crash

When Godot starts, the server scans the recovery directory for
snapshots that hold work the disk does not: a snapshot newer than its
file's last save, or a snapshot whose file no longer exists (including
buffers that never had one). Each such snapshot is loaded straight back
as a buffer — marked dirty (`●`), keeping its original file path — and
the snapshots are consumed so they cannot pile up. There is no dialog
to click through: the recovered buffers simply appear in the buffer
list (`C-x C-b`), where the dirty flag tells you what needs attention.
Recovering does not save anything for you — the recovered text is
yours to inspect and then save (`C-x C-s` writes it back to where it
came from) or kill.

Snapshots taken since the last save are only removed by that startup
scan, so declining to save at quit does not delete them: work you
discarded on the way out can greet you as a recovered buffer on the
next launch. Kill the recovered buffer if you truly meant to discard
it.

#### Quitting with unsaved changes

`C-x C-c` (cmd(quit-editor)) quits the editor. Because quitting tears
down the shared server, this is the one moment every window's buffers
are checked. If any file-backed buffer is dirty, the quit walks them
one at a time, asking in the echo area:

```
Save "name"? (y / n / ! all / q stop / C-g cancel)
```

- `y` — save this buffer and move to the next
- `n` — skip this buffer (leave it unsaved)
- `!` — save this buffer and every remaining one
- `q` — stop asking; skip the rest
- `C-g` or `Escape` — cancel the quit entirely (`Quit canceled`)

If any buffer remains unsaved after the walk — skipped, or with no
file to save to — one final net asks
`N buffer(s) unsaved — quit anyway? (y / n)`. Then comes the workspace
prompt (above), and the editor exits. Quitting from the application
menu (or `Cmd+Q`) runs the same shutdown, workspace prompt included,
but without the per-buffer save walk — prefer `C-x C-c` when you have
unsaved work in play.

### Command index

| Command | Key | Effect |
|---------|-----|--------|
| cmd(find-file) | `C-x C-f` | Visit a file (or directory, or media file) by path |
| cmd(save-buffer) | `C-x C-s` | Save the buffer to its file; prompt for one if it has none |
| cmd(write-file) | `C-x C-w` | Save-as: write to a new path and rebind the buffer to it |
| cmd(switch-view) | `C-x b` | Switch to a buffer by (partial) name |
| cmd(next-view) / cmd(previous-view) | `C-x →` / `C-x ←` | Cycle through the window's buffers |
| cmd(scratch-buffer) | `C-x n` | Open a fresh, seeded scratch buffer |
| cmd(list-views) | `C-x C-b` | Pick from the buffer list |
| cmd(kill-view) | `C-x k` | Kill the current buffer everywhere, without asking |
| cmd(quit-editor) | `C-x C-c` | Quit, walking every unsaved buffer first |
