## How Godot is built

You don't need to read this chapter to use Godot. But if you are the kind
of person the editor is for — someone who finds the line between *using* a
tool and *building* it artificial — then knowing the shape of the thing
makes everything else easier. When the reference points you at a file, or
a command misbehaves, or you want to know *where* your redefinition will
take effect, it helps to have the architecture in your head.

This is the tour, not the blueprint. For the full treatment, start at
`docs/MAP.md` — the router into the engineering docs — and read
`docs/MODEL-B-DISPATCH.md` for the dispatch model and `docs/VISION.md` for
why the editor exists at all. (`docs/ARCHITECTURE.md` describes the layers in
engineering terms but predates the server architecture; treat it as
background, not the current dispatch model.) What follows is the shape you
can hold in one hand.

### One server, many windows; five layers, two languages

Godot runs as a **server plus thin clients**. The server — called the
*spine*, a background process forked at launch — owns the buffers, the
Lisp, and key dispatch. Each editor window is a thin client connected to
it over a private message channel. Data flows one way around a loop: your
keystroke is sent up to the server, the server resolves it to a command,
the command edits the buffer, and the server pushes the change back down
to every window that shows it. The screen never edits state directly — it
only ever *displays* what the server already decided. Hold onto that loop;
the whole editor is a turn of it.

Because there is one server and any number of windows, multi-window
behaviour comes for free: a keystroke in window A can drive windows B and
C (that is how cmd(close-other-windows) and quitting work), and every
window shares the same buffers, the same keymap, and the same Lisp world.
The *Windows* chapter gives the user's-eye account.

Within that topology, the editor is built in layers, each with one job
and a stable seam to the layers it touches. The layers are numbered L0
through L4. L1 through L3 live in the server; L4 lives in each window; L0
spans everything.

**L0 — the host.** Electron. This is the platform Godot runs on: the
operating-system windows, file I/O, subprocesses (the LaTeX compiler, a
shell), and the plumbing between the three kinds of process — the
Electron main process, the renderer process behind each window, and the
spine itself (an Electron `utilityProcess` the main process forks at
launch). It is meant to be thin and to rarely change. You will almost
never think about it.

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
hangs itself. The buffers live in the server, which is why every window
sees the same ones. Nearly every interesting operation passes through L2.
When the reference says a command "edits the buffer," this is the buffer
it means.

**L3 — the Lisp.** A small Lisp interpreter, written from scratch, that is
the editor's nervous system and its primary extension language. The
commands you run, the keymap that dispatches them, and the modes that
shape each buffer are all ordinary Lisp, living in the standard library.
The interpreter runs in the server — there is exactly **one Lisp world**,
shared by every window; a definition you evaluate anywhere is immediately
visible everywhere. The Lisp talks to the buffer through a set of *host
primitives* — thin JavaScript functions exposed into the Lisp world — so
that `(insert! "x")` in Lisp reaches down and edits L2.

**L4 — the renderer.** The on-screen surface, one per window. Because the
buffer lives in another process, each window paints from a local
*replica*: the server sends text deltas and view state over the window's
channel, the client applies them to a mirror that looks exactly like a
buffer to the drawing code, and the view repaints from that. Only the
visible lines exist in the DOM, syntax colouring comes from a real parse
tree, and redraws are batched to one per animation frame. The renderer
reads state; it does not write it. Your keystrokes enter here and your
text appears here, but the deciding happens elsewhere.

That is the skeleton. Two more facts complete the picture.

The first is that Godot speaks **two extension languages**. Lisp is the
primary one — it is what gives the editor its character, and it is where
the standard library and your own customizations live. Lisp commands run
in the server, against the real buffer, and they are what the keymap and
`M-x` dispatch. But you are inside a JavaScript runtime, and JavaScript is
first-class too: it does the heavy lifting (parsing, file formats, the
web-shaped work) and contributes the host primitives, the data sources
behind special views, and *element views* — custom on-screen surfaces,
whose commands are the one JavaScript route into `M-x`. The convention is
*Lisp for the surface, JavaScript for the engine*, and anything JavaScript
defines is overridable from Lisp.

The second is that Godot is *not* Emacs. The Lisp is its own language, not
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
  string the Lisp keymap understands — the window *names* keys; it never
  resolves them. Most of the on-screen *kinds* of
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

And the application that ties them together:

- `apps/desktop/mwb/` — the server–client core; when you ask *where the
  editor actually runs*, this is the directory. `spine.js` is the heart of
  the server: it hosts the buffers and the Lisp interpreter, loads the
  standard library, and receives every keystroke. `server.js` is the
  server's entry point and router, in the same background process: the
  main process hands it one message port per window, and it carries each
  window's intents into the spine and posts the spine's outputs — view
  state and directives — back over the right ports. (Window and server
  talk directly over those ports; the main process is not on the hot
  path.) `protocol.js` defines the messages on that wire, and
  `client-buffer.js` is the renderer-side buffer replica that L4 paints
  from.
- `apps/desktop/src/app.js` — the window chrome: the utility dock, the
  modeline, minibuffer wiring, and `applyDirective`, the switch that
  executes the server's instructions to this window (open this panel,
  show this dialog, close this tab).
- `apps/desktop/src/server-view-client.js` — the client half of the
  dispatch loop: how a key leaves the window (`dispatchKey`) and how
  server-pushed state and directives arrive. When you go looking for *how
  a key reaches Lisp*, start here and follow the wire into `spine.js`.
- `apps/desktop/src/main.js` — the Electron main process: windows, the
  native menu, file dialogs, subprocesses — and, first among its jobs,
  forking the spine at launch and building the bridge that connects each
  new window to it.
- `apps/desktop/src/serve.js`, `preload.mjs` — the `app://` asset server
  and the preload plumbing between Electron's processes.

A rule of thumb that the layering makes reliable: **commands and modes are
in Lisp** (`packages/stdlib/lisp/`), **the buffer's behaviour is in L2**
(`packages/buffer/`), and **how things look is in the renderer**
(`packages/renderer/`). When you want to change *what a command does*, you
are looking for a `.lisp` file; when you want to change *how text is
stored or what it means*, you are below the Lisp; when you want to change
*how it is drawn*, you are above it.

### The life of a keystroke

The cleanest way to see the pieces cooperate is to follow a single key
from your fingers to the screen. Suppose you press `C-f` to move forward
one character. The journey crosses process boundaries twice — up into the
server, and back down — and both crossings are worth seeing.

1. **The window catches the event.** The renderer receives a raw DOM
   `keydown`. A normaliser (`keyEventToString` in the renderer's
   `keymap.js`) folds the browser's event — its key, its modifiers — into
   a stable little string: `"C-f"`. This is the form the Lisp keymap is
   written in, so the messy browser details stop here. Nothing is
   *resolved* in the window; it only names the key.

2. **The client sends the key to the server.** The window's client
   (`server-view-client.js`) posts the key string over its channel as a
   key intent; the router (`server.js`) carries it into the spine, and
   the spine calls `(handle-key "C-f")` — the JavaScript→Lisp seam. From
   here on, dispatch is *the editor's own code*, in Lisp, that you can
   read and redefine.

3. **`handle-key` resolves the key.** Defined in
   `packages/stdlib/lisp/keymap.lisp`. First, one check before any
   lookup: if a *key-reader* is pending (some command asked to read the
   next key itself — cmd(describe-key) does this), the key goes straight
   to it and dispatch is done. Otherwise the key is looked up in the
   active keymaps, and the result is one of three things: a *nested
   keymap* (the key was a prefix like `C-x`, so Godot waits for the next
   key and echoes the running chord), a *command name* (a bound symbol),
   or nothing. For `C-f`, the lookup yields the symbol `forward-char`.
   One wrinkle you may meet: if a key is bound to a name that no command
   is registered under, Godot shows *"⟨name⟩ is not available here"* in
   the echo area rather than erroring — the binding exists, its command
   does not.

4. **The command runs.** `handle-key` clears the chord state and calls the
   command — here cmd(forward-char). The command is ordinary Lisp, running
   in the server against the real buffer; it reaches L2 through a host
   primitive, asking it to advance point by one character. (Many commands
   do real work — cmd(kill-line), cmd(save-buffer) — but the path is the
   same: a bound symbol, then a call into the buffer.) Crucially, the
   command did *not* touch the screen.

5. **The server pushes the change back down.** The buffer's change is
   sent, as a delta plus updated view state, to *every window showing
   that buffer* — this is the second crossing. Commands whose effect is
   chrome rather than text (open a help panel, quit, close another
   window) instead send a *directive* down the same channel, addressed to
   whichever windows the command chose. One keystroke, any number of
   windows.

6. **Each window repaints.** The client applies the delta to its local
   replica, and the view, on the next animation frame, repaints the
   affected lines — the cursor now one character along. The loop is
   closed.

If a key is *unbound* and is an ordinary character — you typed `x` with no
modifier and no chord in progress — step 3 falls through to the last case
and the key *self-inserts*: `handle-key` simply asks the buffer to insert
the character, and steps 5 and 6 follow exactly as before. Typing is just
the dispatch loop's default. One extra seam fires here:
`*post-self-insert-hook*` runs after each self-inserting keystroke, with
the inserted key as its argument. It is the attachment point for
"electric" behaviours — cmd(auto-fill-mode) uses it to wrap the line when
it grows past the fill column.

This is why customization in Godot feels direct. Re-bind a key and you are
editing the table consulted in step 3. Redefine a command and you are
replacing the procedure called in step 4. Add a hook and you attach
yourself to step 5 (or, for typing, to the self-insert hook). And because
there is one Lisp world, in the server, your redefinition takes effect in
every window at once. Two routes, with different timing: a definition you
evaluate in the *running* editor — from the REPL, or with `C-x C-e`
(cmd(eval-expression-before-point)) on a form in a buffer — is live on the
very next keystroke, no compile step, no restart; an edit to a
standard-library `.lisp` file on disk is read at the next launch. The
recommended home for your own code is `~/.godot/init.lisp`
(with saved customizations in `custom.lisp` beside it), which the server
evaluates at the end of every startup — the *Customization* chapter covers
that file; the chapters on **keys** and **extending** put the other knobs
in your hands. This chapter only shows you where they sit in the machine.

### Where to look next

The documentation drills downward: an index, then a playbook, then a
spec, then the code.

- **Using the machinery** — the *Keys* chapter for bindings and chords,
  the *Windows* and *Views* chapters for panes and surfaces, the
  *Extending* and *Customization* chapters for making it yours.
- **The dispatch model in engineering detail** —
  `docs/MODEL-B-DISPATCH.md`, the playbook for how a keystroke becomes a
  command and how commands reach windows they don't share a process with.
- **The Lisp dialect, authoritatively** — `docs/spec/lisp.md` (and the
  Lisp guide, its readable companion).
- **The index over all of it** — `docs/MAP.md`, which routes any
  subsystem question to the one document that owns the answer.
