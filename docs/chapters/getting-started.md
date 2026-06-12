## Getting started

This chapter introduces jmacs: what it is, the idea it is built around,
the shape of the system you will be working inside, and how to get it
running. By the end of it you will have launched the editor, found your
way to the REPL at the foot of the window, and changed the running
editor with two short expressions. Everything after this chapter builds
on that first session.

### What jmacs is

jmacs is a Lisp-extensible editor — a successor in spirit to Emacs,
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

This is the property that gives jmacs its character. The application —
the Electron window, the file dialogs, the text data structure beneath
it all — is *plumbing*. It is deliberately legible, and you can read it,
but it is not where the editor *is*. The editor is in the Lisp, and the
Lisp is yours to change.

jmacs is built for the person who finds the line between "user" and
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
for. Both bind to the same buffer interface. The chapter on extending
the editor returns to this; for now, the Lisp is where we begin.

### The shape of the system

You do not need the full architecture to use jmacs, but a sketch of its
shape makes the rest of this manual legible. The fuller account is in
`docs/ARCHITECTURE.md`; what follows is the short version.

jmacs is built in five layers, each with a single responsibility and a
narrow interface to the layers it touches.

| Layer | Package | Responsibility |
|-------|---------|----------------|
| L0 host | `apps/desktop/` | The Electron application — windows, file I/O, IPC. |
| L1 storage | `packages/storage/` | The text data structure. No semantic awareness. |
| L2 buffer | `packages/buffer/` | Text plus a cursor, a selection, editing, modes, change events. |
| L3 lisp | `packages/lisp/` | The custom Lisp — reader, evaluator, macros, modules. |
| L4 renderer | `packages/renderer/` | Projects buffer state into the DOM. Never mutates it. |

Two further pieces sit across these layers:

- `packages/stdlib/` — the Lisp **standard library**. The editor's
  commands, its keymap, and its modes are defined here, in Lisp, on top
  of the L2 buffer. This is the layer you redefine to change the editor.
- `apps/desktop/` — besides being the host, this is where the layers
  are wired together into a running application.

The crucial distinction for a newcomer is between the **host** and the
**standard library**. The host is the JavaScript machinery: the window,
the filesystem, the text data structure, the Lisp interpreter itself.
The standard library is the Lisp running on top of it — and that Lisp is
the editor's *behaviour*. When this manual says "redefine a command," it
means edit the standard library; when it says "a primitive," it usually
means a piece of the host the standard library is built on.

Dataflow runs in one direction. A keystroke becomes a command; the
command edits the L2 buffer; the buffer emits a change event; the
renderer redraws from that event. The renderer never writes to the
buffer directly. Holding that single arrow in your head explains most of
what the editor does.

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

jmacs is a pnpm workspace. There is no bundler and no compilation step —
the renderer loads the workspace packages as native ES modules. Two
things have to happen once: the dependencies must be installed, and then
the editor is launched directly through Electron.

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
a window reload (`Cmd+R`, the application-level reload — distinct from the
editor's own `C-r`) reliably picks up edits to renderer-side code, Lisp,
and styles — you rarely need to relaunch.

To run the test suites while you are exploring the source, `pnpm test`
at the root runs every package; `pnpm --filter @editor/<pkg> test` runs
one.

### The first session

On first launch the editor opens to a **welcome buffer** — a short
orientation document — alongside a scratch buffer for trying things out.
The window is a single pane showing that buffer, with a modeline across
its foot naming the buffer and its major mode, and, beneath everything,
the **REPL**.

Spend a moment getting your bearings. The text area is the buffer; click
into it and the cursor — the *point* — appears between two characters.
Typing inserts; the arrow keys move. None of this needs the REPL. But
the REPL is what makes jmacs jmacs, so go there next.

#### The REPL at the bottom

The panel at the foot of the window is a Lisp **read-eval-print loop**,
and it is not a sandbox. It shares the editor's interpreter and its live
state. An expression you evaluate there runs against the *running*
editor — the same buffers, the same definitions, the same everything you
are looking at. The REPL is how you try things, inspect the editor, and
reshape it.

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
forward-char)`, which prints a command's documentation; bind a key,
redefine a command, define a new one — and watch the running editor
change. The command palette, reached with `M-x` (cmd(execute-command)),
will run any command by name with completion, and is the quickest way to
discover what is there. The chapters that follow take each of these in
turn. The thing to carry forward from this first session is the reflex:
when you wonder how the editor behaves, or wish it behaved differently,
the answer is a short expression away in the REPL.

> A note on focus, for this version: editor keybindings fire only when
> the text surface itself has focus — not while the REPL input is
> focused. After evaluating in the REPL, click back into the text to
> restore key handling.
