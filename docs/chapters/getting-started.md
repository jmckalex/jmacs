## Getting started

This chapter introduces Godot: what it is, the idea it is built around,
the shape of the system you will be working inside, and how to get it
running. By the end of it you will have launched the editor, found your
way to the REPL at the foot of the window, and changed the running
editor with two short expressions. Everything after this chapter builds
on that first session.

### What Godot is

Godot is a Lisp-extensible editor — a successor in spirit to Emacs,
rebuilt on a clean foundation. It runs as an Electron application, but
that is the least interesting thing about it. The interesting thing is
its organising idea:

> *The editor's behaviour is written in its own Lisp, and you can change
> it from inside the editor while it runs.*

The commands you invoke, the keys they are bound to, the modes that
specialise a buffer for a particular kind of file — none of these are
baked into the application. They are ordinary Lisp definitions in a
*standard library* that ships with the editor, loaded at startup and
consulted on every keystroke. Redefine one and the change takes effect
immediately: there is no restart, no rebuild, no compilation step at
all. Type a new definition into the REPL and the editor's behaviour
shifts under you, mid-session.

This is the property that gives Godot its character. The application —
the Electron window, the file dialogs, the text data structure beneath
it all — is *plumbing*. It is deliberately legible, and you can read it,
but it is not where the editor *is*. The editor is in the Lisp, and the
Lisp is yours to change.

Godot is built for the person who finds the line between "user" and
"developer" of their tools artificial — who, on hitting a small
annoyance, would rather write a small function to fix it and have that
fix live at once. It is not an Emacs clone and runs no Emacs code. It
takes Emacs's deepest idea — the editor as a living environment, every
behaviour modifiable from inside — and rebuilds it without forty years
of accumulated incidental complexity.

Two extension languages are first-class. The custom **Lisp** is the
primary idiom — the one that gives the editor its feel, and the one this
manual leans on. **JavaScript** is first-class too, because the runtime
is already JavaScript and the surrounding ecosystem is worth reaching
for. Both bind to the same buffer interface. The *Extending Godot*
chapter returns to this; for now, the Lisp is where we begin.

### The shape of the system

You do not need the full architecture to use Godot, but a sketch of its
shape makes the rest of this manual legible. The *Architecture* chapter
is the fuller account; what follows is the short version.

The first fact, and the most consequential one: Godot runs as **one
server plus thin windows**. At launch the application forks a background
process — the *spine* — which owns the buffers, the Lisp interpreter,
and key dispatch. Each editor window is a thin client connected to the
spine over a private channel: it sends every keystroke up, and it
repaints from the text changes and view state the spine pushes back
down. Because there is exactly one Lisp world, in the server, a
definition you evaluate anywhere — any window, or the REPL — is
immediately live everywhere at once.

Within that topology, Godot is built in five layers, each with a single
responsibility and a narrow interface to the layers it touches. L1–L3
run inside the server; L4 runs in each window; L0 spans everything.

| Layer | Package | Responsibility |
|-------|---------|----------------|
| L0 host | `apps/desktop/` | The Electron application — windows, file I/O, the server process and the channels to it. |
| L1 storage | `packages/storage/` | The text data structure. No semantic awareness. |
| L2 buffer | `packages/buffer/` | Text plus a cursor, a selection, editing, modes, change events. |
| L3 lisp | `packages/lisp/` | The custom Lisp — reader, evaluator, macros, modules. |
| L4 renderer | `packages/renderer/` | Projects buffer state into the DOM. Never mutates it. |

Several further pieces sit across these layers:

- `packages/stdlib/` — the Lisp **standard library**. The editor's
  commands, its keymap, and its modes are defined here, in Lisp, on top
  of the L2 buffer. This is the layer you redefine to change the editor.
- `packages/view/` and `packages/pane/` — the **view** (a single per-tab
  on-screen surface) and the **pane tree** (the binary split tree that
  carves up the window). You will meet both nouns in a moment.
- `apps/desktop/` — besides being the host, this is where the layers are
  wired together into a running application: the server core lives in
  `apps/desktop/mwb/`, the window chrome in `apps/desktop/src/`.

The crucial distinction for a newcomer is between the **host** and the
**standard library**. The host is the JavaScript machinery: the window,
the filesystem, the text data structure, the Lisp interpreter itself.
The standard library is the Lisp running on top of it — and that Lisp is
the editor's *behaviour*. When this manual says "redefine a command," it
means edit the standard library; when it says "a primitive," it usually
means a piece of the host the standard library is built on.

Dataflow runs one way around a loop. A keystroke is sent up to the
server; the server resolves it to a command; the command edits the L2
buffer; the server pushes the change back down to every window showing
that buffer; each window repaints from what it received. The renderer
never writes to the buffer directly — it only ever displays what the
server already decided. Holding that single loop in your head explains
most of what the editor does; the *Architecture* chapter walks a
keystroke around it step by step.

Three nouns recur throughout this manual, so meet them here at a glance:

- A **buffer** is a piece of text together with the state an editor
  needs to work on it — a cursor, a selection, an undo history, and a
  mode. The text you are editing lives in a buffer; the editor holds a
  list of them, with one *current*.
- A **view** is an on-screen surface that shows a buffer (or, for the
  non-text view kinds, its own content — a web page, a PDF, an image, a
  shell). A view is what you look at; a buffer is what it looks at.
- A **pane** is a region of the window that holds a view. Panes form a
  binary split tree, so you can divide the window into several views at
  once, each with its own tabline.

For the first session, the simple picture is enough: one window, one
pane, one view onto one buffer of text, with the REPL beneath it. The
chapters on buffers, views, and panes take these apart properly.

### Running the editor

Godot is developed macOS-first, and this manual's key notation reflects
the Mac keyboard: `C-` is Control, `M-` is Command (the Meta of Emacs
custom), `A-` is Option. The *Keys and commands* chapter defines the
notation properly; this chapter uses only a handful of keys.

Godot is a pnpm workspace. There is no bundler and no compilation step —
the renderer loads the workspace packages as native ES modules. You need
Node and pnpm; then two things have to happen once: the dependencies
must be installed, and the editor is launched directly through Electron.

From the repository root, install the dependencies:

```
pnpm install
```

Then launch the editor. Run it directly through the bundled Electron
binary, from inside the desktop application package:

```
cd apps/desktop && ./node_modules/.bin/electron .
```

That direct invocation is the supported way to start the editor. The
`app://` assets it serves are sent uncached, so once the window is open
the View menu's **Reload** (`Ctrl+Cmd+R` — a native menu accelerator,
not an editor binding; plain `Cmd+R` reaches the editor's keymap as
`M-r`, cmd(replace-string)) reliably picks up edits to renderer-side
code, Lisp, and styles. You rarely need to relaunch — only edits to the
Electron main process need a full quit and restart.

To run the test suites while you are exploring the source, `pnpm test`
at the root runs every package; `pnpm --filter @editor/<pkg> test` runs
one.

### The first session

What greets you depends on whether Godot has seen you before. On a
genuinely first launch there is no saved session to restore, so the
editor seeds its one buffer with a file it can be sure exists: its own
renderer source — the editor showing you what it is made of. On later
launches Godot picks up where you left off: the window opens on a
**workspace chooser** offering your last workspace, any workspaces you
have saved by name, and a fresh start, and rebuilds the layout you
choose.

Either way the window has the same anatomy: a pane showing a buffer,
with a tabline across its top and a **modeline** across its foot naming
the buffer and its major mode, and, beneath everything, a tabbed
**utility dock** whose resident tab is the **REPL**. Tool tabs — Help,
Completions, compile output — join the dock as you work. `C-x p`
(cmd(toggle-repl)) hides and shows the whole dock; remember that one,
because at some point you will close the dock and want it back.

Spend a moment getting your bearings. The text area is the buffer; click
into it and the cursor — the *point* — appears between two characters.
Typing inserts; the arrow keys move. Then try the handful of keys every
session uses:

- `C-x C-f` (cmd(find-file)) prompts for a path in the minibuffer, with
  `TAB` completion — the candidates open in a Completions tab in the
  dock.
- `C-x C-s` (cmd(save-buffer)) saves the buffer to its file.
- `C-x b` (cmd(switch-view)) switches to another open buffer by name.
- `C-x C-c` (cmd(quit-editor)) quits, walking you through any unsaved
  buffers first.

None of this needs the REPL. But the REPL is what makes Godot Godot, so
go there next.

#### The REPL at the bottom

The dock's resident tab is a Lisp **read-eval-print loop**, and it is
not a sandbox. What you type there is evaluated in the server's Lisp
world — the same interpreter that runs the editor's own commands, with
the same buffers, the same definitions, the same everything you are
looking at. An expression you evaluate there runs against the *running*
editor. The REPL is how you try things, inspect the editor, and reshape
it.

Click into the REPL and evaluate a plain arithmetic expression to see
the loop work:

```lisp
(+ 1 2 3)
```

The REPL prints `6`. This is the language doing ordinary work: `+` is a
procedure, the three numbers are its arguments, and the result comes
back beneath your input. Try a few more — `(* 6 7)`, `(str "hello, "
"world")` — to get a feel for the reader and the printer.

Now reach into the editor itself. The buffer primitives that the
standard library is built on are available at the REPL too, and they
operate on the buffer the current view is displaying. Evaluate:

```lisp
(insert! "hi")
```

and the characters `hi` appear in the buffer above, at the cursor, as
though you had typed them. That is the whole idea in one expression: the
REPL is not talking *about* the editor, it is talking *to* it. The same
`insert!` that this expression calls is what the keys you press call when
you type — there is no privileged path that the keyboard takes and the
REPL does not.

From here the editor is open to you. Ask it about itself with `(doc
forward-char)` — `doc` returns a procedure's documentation string (or
`#f` when it has none), and the REPL prints what came back. Bind a key,
redefine a command, define a new one — and watch the running editor
change. `M-x` (cmd(execute-command)) runs any command by name: type
enough of the name and press Return — the *Keys and commands* chapter
explains exactly how the name is matched. The chapters that follow take
each of these in turn. The thing to carry forward from this first
session is the reflex: when you wonder how the editor behaves, or wish
it behaved differently, the answer is a short expression away in the
REPL.

When an experiment earns a permanent home, it goes in your
configuration. Godot keeps its hand-editable config in `~/.godot`:
`init.lisp` (seeded with a commented template on first run) is free-form
Lisp evaluated at the end of every startup, and `custom.lisp` holds what
the Customize interface saves on your behalf. The *Customization*
chapter covers both.

> A note on focus: the REPL input and the minibuffer are native inputs
> and keep their own keys — while one of them is focused, editor
> bindings do not fire. Click back into the text after evaluating and
> key handling resumes. (Everywhere else the editor is forgiving:
> command chords reach it even when focus has drifted — the *Keys and
> commands* chapter has the details.)
