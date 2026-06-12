## How jmacs is built

You don't need to read this chapter to use jmacs. But if you are the kind
of person the editor is for — someone who finds the line between *using* a
tool and *building* it artificial — then knowing the shape of the thing
makes everything else easier. When the reference points you at a file, or
a command misbehaves, or you want to know *where* your redefinition will
take effect, it helps to have the architecture in your head.

This is the tour, not the blueprint. For the full treatment, read
`ARCHITECTURE.md` (the layered design in engineering terms) and
`VISION.md` (why the editor exists at all). What follows is the shape you
can hold in one hand.

### One window, five layers, two languages

jmacs is built in layers, each with one job and a stable seam to the
layers it touches. Data flows one way: your input becomes a command, the
command edits the buffer, and the buffer's change ripples out to the
screen. The screen never edits state directly — it only ever *displays*
what the buffer already decided. Hold onto that loop; the whole editor is
a turn of it.

The layers are numbered L0 through L4.

**L0 — the host.** Electron. This is the platform jmacs runs on: the
operating-system window, file I/O, subprocesses (the LaTeX compiler, a
shell), and the bridge between Electron's two processes. It is meant to be
thin and to rarely change. You will almost never think about it.

**L1 — storage.** The raw text data structure — characters in, characters
out, with efficient insertion, deletion, and undo. L1 has no idea what the
text *means*; it only knows which characters are where. Positions are
plain integer offsets. It is the page, not the writing on it.

**L2 — the buffer.** The conceptual heart of the editor, and the part you
actually extend. A *buffer* wraps the raw text of L1 and adds everything
that makes text *editable text*: the cursor (*point*) and selection
(*mark*); **markers**, which are positions that slide correctly as you
type around them; **text properties** and **overlays**, which attach
meaning (a syntax colour, a link, a fold) to ranges; **modes**, the
per-buffer behaviour configuration; and **hooks**, the places your code
hangs itself. Nearly every interesting operation passes through L2. When
the reference says a command "edits the buffer," this is the buffer it
means.

**L3 — the Lisp.** A small Lisp interpreter, written from scratch, that is
the editor's nervous system and its primary extension language. The
commands you run, the keymap that dispatches them, and the modes that
shape each buffer are all ordinary Lisp, living in the standard library.
The Lisp talks to the buffer through a set of *host primitives* — thin
JavaScript functions exposed into the Lisp world — so that `(insert! "x")`
in Lisp reaches down and edits L2.

**L4 — the renderer.** The on-screen surface. It subscribes to the
buffer's change events and paints them into the window: only the visible
lines exist in the DOM, syntax colouring comes from a real parse tree, and
redraws are batched to one per animation frame. The renderer reads buffer
state; it does not write it. Your keystrokes enter here and your text
appears here, but the deciding happens elsewhere.

That is the spine. Two more facts complete the picture.

The first is that jmacs speaks **two extension languages**. Lisp is the
primary one — it is what gives the editor its character, and it is where
the standard library and your own customizations live. But you are inside
a JavaScript runtime, and JavaScript is first-class too: it does the heavy
lifting (parsing, file formats, the web-shaped work), and anything it
defines is overridable from Lisp. The convention is *Lisp for the surface,
JavaScript for the engine*. A command registered in one is callable from
the other; both bind to the same buffer.

The second is that jmacs is *not* Emacs. The Lisp is its own language, not
Elisp; Emacs extensions do not run here. That is deliberate — the point
was to keep the deepest ideas (the editor as a living, self-describing
environment) and leave forty years of incidental complexity behind.

### Where things live

A map of the source, for when the reference points you at a file. The repo
is a monorepo: each layer is a package under `packages/`, and the Electron
application that assembles them is `apps/desktop/`.

The packages, roughly bottom to top:

- `packages/storage/` — **L1**. The text data structure (`buffer.js`) and
  its persistence to disk.
- `packages/buffer/` — **L2**. The semantic buffer (`buffer.js`): point
  and mark, markers, text properties, overlays, modes, hooks. The API
  everything else is built on.
- `packages/lisp/` — **L3**. The interpreter, in pieces you can read one at
  a time: `reader.js` (text → forms), `eval.js` (the evaluator),
  `environment.js` (scopes), `primitives.js` (the core built-ins),
  `values.js`, and `interpreter.js` (the assembled whole).
- `packages/renderer/` — **L4**. The editor surface. `view.js` does the
  rendering, virtualisation, and input; `highlight.js` and `treesitter.js`
  do syntax colouring; `keymap.js` turns a raw DOM key event into the key
  string the Lisp keymap understands. Most of the on-screen *kinds* of
  view — directory trees, the doc viewer, image and audio views, the
  minibuffer — live here too.
- `packages/view/` — the **View** abstraction: a single per-tab on-screen
  surface. A view is what one tab shows.
- `packages/pane/` — the **Pane** tree: a binary split tree whose leaves
  hold views. This is the machinery behind splitting and rearranging the
  window. (See the *Views* and *Windows* chapters for the user's-eye
  account.)
- `packages/stdlib/` — the standard library, in two halves. The Lisp half,
  `packages/stdlib/lisp/*.lisp`, *is* the editor's commands, keymap, and
  modes — `editing.lisp`, `keymap.lisp`, `files.lisp`, `search.lisp`, and
  dozens more. The JavaScript half, `packages/stdlib/src/`, holds the host
  primitives that bridge Lisp to the buffer (`buffer-primitives.js`) and
  to panes and views.
- `packages/lsp/` — Language Server Protocol integration (a later layer).

And the application that ties them together:

- `apps/desktop/src/app.js` — the renderer entry point: it boots the Lisp,
  installs the buffer primitives, maintains the buffer list and modeline,
  and wires keystrokes into the command machinery. When you go looking for
  *how a key reaches Lisp*, this is the file.
- `apps/desktop/src/main.js` — the Electron main process: windows, the
  native menu, file dialogs, subprocesses.
- `apps/desktop/src/serve.js`, `preload.mjs` — the plumbing between
  Electron's two processes and the `app://` asset server.

A rule of thumb that the layering makes reliable: **commands and modes are
in Lisp** (`packages/stdlib/lisp/`), **the buffer's behaviour is in L2**
(`packages/buffer/`), and **how things look is in the renderer**
(`packages/renderer/`). When you want to change *what a command does*, you
are looking for a `.lisp` file; when you want to change *how text is
stored or what it means*, you are below the Lisp; when you want to change
*how it is drawn*, you are above it.

### The life of a keystroke

The cleanest way to see the layers cooperate is to follow a single key
from your fingers to the screen. Suppose you press `C-f` to move forward
one character.

1. **The host catches the event.** The renderer's window receives a raw
   DOM `keydown`. A normaliser (`keyEventToString` in the renderer's
   `keymap.js`) folds the browser's event — its key, its modifiers — into
   a stable little string: `"C-f"`. This is the form the Lisp keymap is
   written in, so the messy browser details stop here.

2. **The host hands the key to Lisp.** `app.js` calls
   `(handle-key "C-f")` — a single call across the JavaScript→Lisp seam.
   From here on, dispatch is *the editor's own code*, in Lisp, that you can
   read and redefine.

3. **`handle-key` resolves the key.** Defined in
   `packages/stdlib/lisp/keymap.lisp`, it looks the key up in the active
   keymaps. The result is one of a few things: a *nested keymap* (the key
   was a prefix like `C-x`, so jmacs waits for the next key and echoes the
   running chord), a *command name* (a bound symbol), a pending
   *key-reader* (some command asked to read the next key itself), or
   nothing. For `C-f`, the lookup yields the symbol `forward-char`.

4. **The command runs.** `handle-key` clears the chord state and calls the
   command — here cmd(forward-char). The command is ordinary Lisp; it
   reaches the buffer through a host primitive, asking L2 to advance point
   by one character. (Many commands do real work — cmd(kill-line),
   cmd(save-buffer) — but the path is the same: a bound symbol, then a call
   into the buffer.)

5. **The buffer changes and announces it.** L2 moves point (or edits text,
   for an inserting command) and emits a change event. Crucially, the
   command did *not* touch the screen.

6. **The renderer redraws.** L4, subscribed to that event, marks itself
   dirty and, on the next animation frame, repaints the affected lines —
   the cursor now one character along. The loop is closed.

If a key is *unbound* and is an ordinary character — you typed `x` with no
modifier and no chord in progress — step 3 falls through to the last case
and the key *self-inserts*: `handle-key` simply asks the buffer to insert
the character, and steps 5 and 6 follow exactly as before. Typing is just
the dispatch loop's default.

This is why customization in jmacs feels direct. Re-bind a key and you are
editing the table consulted in step 3. Redefine a command and you are
replacing the procedure called in step 4. Add a hook and you attach
yourself to step 5. There is no compile step and no restart: the dispatch
path runs the same Lisp you can edit live, and the next keystroke takes
your new version. The chapters on **keys**, **extending**, and
**customization** put each of these knobs in your hands; this chapter only
shows you where they sit in the machine.
