## Files and buffers

A working session in jmacs is a set of buffers — text held in memory,
each usually attached to a file on disk — and the views that show them.
This chapter covers the everyday traffic between disk and screen:
opening a file and saving it, finding your way around the filesystem
from the minibuffer, moving between the buffers you have open, telling
at a glance which of them have unsaved changes, and recovering work the
editor was holding when something went wrong.

The file commands wrap host primitives: the file dialog and the actual
filesystem reads and writes happen in the Electron main process, reached
over IPC. The Lisp commands documented here *start* that work; the
keymap that binds them lives in `keymap.lisp`. Keys follow the manual's
notation: `C-` is Control or Command, `M-` is Option, `S-` is Shift.

### Opening a file

`C-x C-f` (cmd(find-file)) opens a file. It does not pop a native
dialog; it prompts in the minibuffer for a path, seeded with your home
directory and a trailing slash so you can start completing immediately:

```
Find file: /Users/jane/
```

Type a path and press `Enter` to open it. As in Emacs, a path that
names a file that does not yet exist is not an error — it opens an empty
buffer *visiting* that path, and the file itself is created on the first
save. So `C-x C-f` is how you both open existing files and start new
ones. Opening a file also sets the buffer's major mode from the file's
name, so a `.lisp` file arrives in Lisp mode and a `.md` file in
Markdown mode, with no further action.

If you would rather use the operating system's own open dialog, the
application menu's **File ▸ Open File…** (`Cmd+O`) runs
cmd(open-file-dialog) instead. (The keymap cannot bind `Cmd+O`
directly — the renderer normalises Command to `C-`, and `C-o` is
already cmd(open-line) — so the native dialog is reached through the
menu rather than a chord.)

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
  in unambiguously, so the candidates are *listed* (see the Completions
  panel, below) and the path is left unchanged.
- **No match.** The minibuffer reports `(no matches)` and the path is
  left as you typed it.

By default the prefix match ignores case — typing `rea` and pressing
`Tab` in a directory holding `README.md` completes to `README.md`,
taking the file's real on-disk case rather than yours. Set
cmd(*find-file-case-sensitive*) to `#t` if you would rather have
completion respect case.

#### The Completions panel

When a directory holds more candidates than will fit, jmacs does not
cram them into the one-line minibuffer status. Instead it routes them to
a **Completions** panel — a scrollable, clickable tab in the utility
dock at the foot of the window. The list opens the moment a `Tab` finds
the choice genuinely ambiguous, and shows every matching entry, one per
row, with a folder icon on directories (which carry a trailing slash)
and a file icon on the rest.

The panel is display-only and non-modal: it owns no keys, so the
minibuffer keeps the focus and you keep typing and `Tab`-completing with
the list in view. You can also drive it with the mouse:

- **Single-click** a row to *select* it — its name is filled into the
  minibuffer path, without opening anything. The panel stays put, so you
  can keep narrowing.
- **Double-click** a row to *activate* it — open the file, or descend
  into the directory and list its contents in turn.

The panel is transient by construction. As soon as a `Tab` makes
progress, or the find-file command finishes (whether you open something
or cancel with `C-g`), the panel is cleared away — so a busy directory
leaves no clutter behind once you have made your choice.

### Saving a file

`C-x C-s` (cmd(save-buffer)) writes the current buffer to its file. A
buffer that has never been saved — one you started with cmd(find-file)
on a new path, or a fresh scratch buffer — is written to the path it is
visiting; the file is created at that point.

If the file has *changed on disk* since you opened it — another program
rewrote it while you were editing — jmacs will not silently overwrite
that change. It stops and asks:

> *"name" has changed on disk since you opened it.*

Confirming overwrites the disk version with yours; cancelling writes
nothing and leaves both your edits and the disk file untouched, so you
can re-open the file to load the newer version, compare, and decide.
Cancelling is always safe — it never loses either copy.

### The unsaved-changes indicator

A buffer is *dirty* when its text differs from what is on disk. jmacs
shows this with a filled circle (`●`) in front of the buffer's name in
the modeline, and the same mark in the operating system's window title.
The mark appears as soon as you make an edit that moves the text away
from the saved version, and clears the instant the buffer matches disk
again — so saving removes it, and so does undoing back to the saved
state. A buffer with no saved baseline at all (a new or scratch buffer,
or one recovered from a crash) counts as dirty whenever it has content,
until its first save.

### Working with several buffers

The editor holds a list of buffers, with one current, each shown in a
view. Several commands move between them.

| Action | Key | Command |
|--------|-----|---------|
| Switch to a buffer by name | `C-x b` | cmd(switch-view) |
| Next / previous view | `C-x →` / `C-x ←` | cmd(next-view) / cmd(previous-view) |
| New empty buffer | `C-x n` | cmd(new-view) |
| List all buffers | `C-x C-b` | cmd(buffer-menu) |

`C-x b` (cmd(switch-view)) prompts `Buffer:` in the minibuffer and
completes the name *fuzzily* — you need only type enough of the name,
not a leading prefix, for the editor to find it, and the closest matches
are shown in brackets as you type. Pressing `Enter` switches to the best
match; an exact name always wins over a fuzzy one. If what you type
matches no open buffer, `Enter` creates a fresh buffer under that name —
the status line shows `[new view: …]` to tell you that is what will
happen — so the same command both switches and creates.

`C-x →` and `C-x ←` step through the open views in order without a
prompt, which is the quickest way to cycle when you have only a handful
open.

### The buffer list

`C-x C-b` (cmd(buffer-menu)) opens the **View List** — a clickable
table of every open view, with a column for the name and one for the
kind (a text buffer, a browser, a PDF, a shell, and so on). It is a
live table: it refreshes itself as views open, close, and switch under
you. Click a row to switch to that view; click the trailing ✕ on a row
to close it. The list is itself a view, so it sits in the tabline like
any other and you leave it the way you leave any view. (cmd(buffer-menu)
is an alias kept for Emacs muscle memory; the same list is reachable as
cmd(view-list!).)

### Crash recovery

jmacs autosaves your unsaved work so a crash cannot take it. While a
buffer is dirty, the editor writes a *recovery snapshot* of its full
text to a private location — debounced a short moment after each edit,
and again when the window loses focus. The snapshot records enough to
identify the buffer next time: its path, its name, when it was saved,
and a hash of its contents. Saving a buffer drops its snapshot (the work
is on disk now, so there is nothing to recover), and a clean,
deliberate quit clears every snapshot. A snapshot is left behind *only*
when the editor stops without a clean quit — which is exactly the case
recovery is for.

Two settings govern this. cmd(*autosave-recovery*) is on by default;
turn it off to disable autosave entirely (with the understanding that a
crash will then lose unsaved work). cmd(*autosave-recovery-interval*)
is the debounce delay in milliseconds — lower to snapshot more eagerly,
higher to write less often.

#### Recovering after a crash

When jmacs starts and finds recovery snapshots from a run that did not
quit cleanly, it opens a **\*Recover\*** view automatically. (You can
also open it by hand at any time with cmd(recover-session), which
re-scans for snapshots.) The view is a table of the recoverable
buffers; for each, you choose:

- **Recover** — open the snapshot's text as a live buffer, *marked
  unsaved*, keeping its original file path so a `C-x C-s` writes it back
  to where it came from. The recovered buffer opens in the background so
  the list stays put for your next choice. (If the file is already open
  from a restored session, recovering pours the snapshot's text into
  that existing buffer rather than making a duplicate.)
- **Discard** — delete the snapshot. Use this for work you do not want
  back.

Recovering does not save anything for you: the recovered text is in a
dirty buffer, and it is yours to inspect and then save (or not). The
view stays open as you work through the list, showing an empty state
once you have dealt with every entry, and you close it like any other
view when you are done.

#### Quitting with unsaved changes

`C-x C-c` (cmd(quit-editor)) quits the editor. If any buffer is dirty,
jmacs asks before exiting — *"Discard unsaved changes in N buffer(s)?"*
— so a stray quit cannot drop work without a deliberate confirmation.
Confirming the quit is treated as a clean exit, so the recovery
snapshots are cleared as part of leaving; cancelling returns you to the
editor with everything intact.
