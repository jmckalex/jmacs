# Godot

**A Lisp-extensible text editor — a successor in spirit to Emacs, on a clean foundation.**

Godot is an editor whose behaviour *is* code you can read, redefine, and
reload while it runs. Its keymap, its commands, and its standard library
are written in a custom Lisp dialect that ships with the editor; an
embedded REPL shares the editor's live state. It runs as an Electron
application — a Lisp server driving thin windows — is highlighted by
tree-sitter, and is built on a small, legible layered core.

It is not an Emacs clone and runs no Emacs code. It takes Emacs's
deepest idea — *the editor as a living environment, every behaviour
modifiable from inside* — and rebuilds it without forty years of
incidental complexity.

(The editor was renamed from *jmacs* to **Godot** for the beta; the
repository keeps the old slug.)

![The Godot editor](docs/screenshot.png)

---

## Contents

- [What it is](#what-it-is)
- [Highlights](#highlights)
- [Quick start](#quick-start)
- [Keybindings](#keybindings)
- [The Lisp](#the-lisp)
- [Architecture](#architecture)
- [Project layout](#project-layout)
- [Development](#development)
- [Status and roadmap](#status-and-roadmap)
- [Design principles](#design-principles)
- [How it was built](#how-it-was-built)
- [Beta testing](#beta-testing)
- [License](#license)

---

## What it is

Godot is a working, self-hosting, extensible editor. "Self-hosting"
here means something specific: the editor's commands and key bindings
are not hardcoded in JavaScript — they are Lisp procedures in
`packages/stdlib/lisp/`, loaded at startup and dispatched on every
keystroke. Press `C-x C-r` and the editor re-evaluates its own standard
library without restarting. Type `(define (forward-word) …)` into the
REPL and the editor's behaviour changes under you.

The editor is built for the person who finds the boundary between
"user" and "developer" of their tools artificial — who wants to write a
small function to fix a small annoyance, and have it take effect
immediately. It is deliberately not aimed at a mass audience.

Two extension languages are first-class: the custom **Lisp** (the
primary idiom, what gives the editor its character) and **JavaScript**
(because the runtime is already JavaScript, and the npm ecosystem is
worth reaching). Both bind to the same buffer API.

## Highlights

- **Editing** — a kill ring (cut/copy/paste with `M-y` yank-pop),
  undo/redo, motion by character/word/sentence/paragraph, transpose
  (characters, words, lines), case commands, comment toggling,
  auto-indent, multi-cursor, expand-region, an auto-fill minor mode,
  and yasnippet-style snippets with TAB expansion and mirrored fields.
- **Search & replace** — incremental search forward (`C-s`) and
  backward (`C-r`) with live match highlighting, regexp isearch,
  `occur`, highlight-all-matches drawn as buffer overlays,
  `query-replace`, and whole-buffer `replace-string`.
- **Multiple buffers** — a buffer list (`list-views`, `C-x C-b`), a
  fuzzy-completing switcher (`C-x b`), file open/save through native
  dialogs, project workspaces (`C-x C-p`), an unsaved-changes indicator.
- **Panes, tabs, and windows** — split panes (`C-x 2`, `C-x 3`)
  arranged in a binary tree, tabline strips per leaf, `C-x +`
  *add-pane mode* for visual insertion at any splitter or border, and
  multiple OS windows (`C-x 5 2`) all sharing one Lisp world. Sessions
  restore across launches; arrangements can be saved as named
  workspaces.
- **Multiple view kinds** — beyond text: a browser view for HTTP URLs,
  a PDF view (PDF.js with custom chrome), image, shell (xterm.js over
  a real pty), a gnuplot notebook REPL (`C-c g`), a music jukebox,
  directory tree and Miller-columns views, notebook cells — and
  `define-element-view`, which hosts any custom HTML element as a view
  in a few lines of Lisp.
- **Writing and LaTeX** — an AUCTeX-style authoring stack: one-key
  compile, RefTeX-style label/reference/citation insertion with CSL
  citation pickers, SyncTeX forward/inverse search, inline and display
  math preview, and a live math tooltip while you edit.
- **JMarkdown** — a full major mode for `.jmd` files with live
  watch-preview (a real `jmarkdown watch` server, forward/inverse
  search, save-free refresh) and its own AUCTeX-style authoring layer:
  compile, structure navigation, completing inserts, references.
- **A custom Lisp runtime** — a reader, a tree-walking evaluator,
  lexical scope, closures, proper tail calls, macros, first-class
  modules with hot reload, `try`/`catch`, and self-documentation. The
  in-app function reference documents close to five hundred built-in
  functions and commands.
- **An embedded REPL** — in a tabbed utility dock (`C-x p`), sharing
  the editor's live Lisp world; `(insert! "x")` edits the visible
  document.
- **Syntax highlighting and themes** — tree-sitter grammars for the
  major languages, a tokenizer for the Lisp dialect, run-based
  rendering, seven built-in themes, and live face customisation:
  `C-h F` inspects the face at point, `C-h C-f` creates and assigns
  one.
- **A real editor surface** — virtualised line rendering, a gutter
  with a fold rail, code folding, rainbow indent guides, a minimap
  (`C-x m`), a modeline, matching-bracket outline, bookmarks
  (`C-x r`), and sticky notes (`M-n`).
- **Discoverability** — an in-app manual (`C-h d`): a Texinfo-style
  browsable node tree with a narrative manual, a Lisp programming
  guide, and a full function reference; an `M-x` command palette with
  fuzzy matching; `C-h k` / `C-h f` / `C-h F` / `C-h a` ask the editor
  what a key, command, or face does.
- **Hot reload** — change the editor's own Lisp and reload it live
  (`C-x C-r`).

Over three thousand unit tests across the workspace, plus an Electron
smoke harness that drives the whole stack — rendering, the keymap,
search, the REPL, file I/O — in a real window.

## Quick start

Requirements: **Node 20+** and **pnpm** (via Corepack — `corepack enable pnpm`).

```bash
git clone <repository-url> godot
cd godot
pnpm install
(cd apps/desktop && ./node_modules/.bin/electron .)   # launch the editor
pnpm test                                             # run every package's test suite
```

(A `pnpm dev` script exists but currently trips over pnpm's pre-run
dependency check — an unresolved `citation-js` ignored-build
placeholder. The direct `electron .` invocation sidesteps it.)

On first launch the editor opens to a welcome buffer and a
`scratch.lisp` buffer. Toggle the REPL dock with `C-x p`, click into
it, and evaluate `(+ 1 2 3)`, or `(doc forward-char)`, or
`(insert! "hello")` and watch the buffer above change.

## Keybindings

Bindings are defined in Lisp (`packages/stdlib/lisp/keymap.lisp`) and
can be changed there or from the REPL. `C-` is Ctrl; `M-` is Cmd
(Command is Meta, Emacs-on-Mac style); `A-` is Option — an unbound
`A-` chord falls through to the character Option composes, so curly
quotes and accented letters still type natively; `S-` is Shift. Every
motion below has an `S-` variant that extends the selection.

The tables are a curated sample, not the whole map — the live set is
whatever `keymap.lisp` says it is. `C-h d` opens the manual's key
index, and `C-h k` asks any key directly.

### Movement

| Key | Command |
|-----|---------|
| arrows, `C-f` `C-b` `C-n` `C-p` | by character / line |
| `M-f` `M-b` (also `M-left` `M-right`, `A-left` `A-right`) | by word |
| `M-a` / `M-e` | by sentence |
| `M-S-[` / `M-S-]` (i.e. `M-{` / `M-}`) | by paragraph |
| `C-a` `C-e`, `Home` `End`, `C-left` `C-right` | line start / end |
| `C-up` / `C-down`, `M-<` / `M->` | buffer start / end |
| `C-v` / `M-v` | move a screenful down / up |
| `M-m` | back to indentation |
| `M-g` | go to line |
| `C-l` | recentre the viewport on the cursor |

(`C-x C-left` … `C-x C-down` are pane navigation, not motion — see
[Panes, windows, tools](#panes-windows-tools).)

### Editing

| Key | Command |
|-----|---------|
| `Backspace` / `Delete`, `C-d` | delete around the cursor |
| `M-d` / `M-backspace` | kill word forward / backward |
| `C-w` / `M-w` | kill / copy the region |
| `C-k` / `C-y` / `M-y` | kill to end of line / yank / yank-pop |
| `C-t` / `M-t` / `C-x C-t` | transpose characters / words / lines |
| `M-u` `M-l` `M-c` | upcase / downcase / capitalize the word (`C-x C-u`, `C-x C-l` for the region) |
| `M-q` | fill the paragraph (`C-x f` sets the fill column) |
| `M-up` / `M-down` | move the line up / down |
| `M-[` / `M-]` | outdent / indent the region |
| `C-x ;` | comment / uncomment the line |
| `M-backslash`, `M-space`, `C-x C-o` | delete horizontal space / just one space / delete blank lines |
| `C-S-backspace` | kill the whole line |
| `C-equal` | expand-region — grow the selection by syntax |
| `C-c d` / `C-c D` | multi-cursor: add the next match / select all matches |
| `C-z` / `C-S-z` (also `M-z` / `M-S-z`, `C-x u`, `C-slash`) | undo / redo |
| `C-u` | universal argument for the next command |
| `Enter` | newline, keeping indentation |
| `C-x h` | select the whole buffer |
| `C-g` | cancel a key sequence / clear the selection |

### Search, files, buffers, help

| Key | Command |
|-----|---------|
| `C-s` / `C-r` | incremental search forward / backward |
| `C-M-s` / `C-M-r` | regexp incremental search |
| `M-%` (`M-S-5`) / `M-r` | query-replace / replace every occurrence |
| `M-s o` / `M-s h` / `M-s u` | occur / highlight all matches / unhighlight |
| `C-x C-f` / `C-x C-s` / `C-x C-w` | open file / save buffer / save as |
| `C-x b` / `C-x C-b` | switch view (fuzzy completion) / list views |
| `C-x left` / `C-x right` | previous / next view |
| `C-x k` / `C-x n` | kill the view / open a fresh scratch buffer |
| `C-x C-p` | open a project |
| `M-x` | command palette |
| `C-h d` | open the manual |
| `C-h k` / `C-h f` / `C-h F` / `C-h a` | describe a key / a command / the face at point / apropos |
| `C-x C-r` | reload the standard library (hot reload) |

### Panes, windows, tools

| Key | Command |
|-----|---------|
| `C-x 2` / `C-x 3` | split below / to the right (`C-u` first flips the side) |
| `C-x 0` / `C-x 1` / `C-x o` | close this pane / close the others / focus the other pane |
| `C-x +` | add-pane mode — click a splitter or border to insert a pane there |
| `C-x x` / `C-x X` | send the view to the next pane / swap with it |
| `C-x C-left` … `C-x C-down` | focus the pane in that direction |
| `C-x 5 2` / `C-x 5 0` / `C-x 5 1` | new window / close this window / close the others |
| `C-x r m` / `C-x r b` / `C-x r l` | bookmarks: set / jump / list |
| `M-n` … | sticky notes (add, edit, delete, next/previous, toggle) |
| `C-x m` / `C-x p` | toggle the minimap / the REPL dock |
| `C-x j` / `C-c g` | the jukebox / a gnuplot notebook |

## The Lisp

The editor embeds a custom Lisp dialect: Scheme-dominant in semantics
(lexical scope, applicative order), Clojure-influenced in its data
literals (`[vectors]`, `{:maps 1}`, `:keywords`), with a procedural
macro system. It is a tree-walking interpreter written in vanilla
JavaScript. The full specification is in
[`docs/spec/lisp.md`](docs/spec/lisp.md).

```lisp
;; A module with a private helper and an exported command.
(module greetings
  (export greet)
  (define (-prefix) "hello, ")          ; private
  (define (greet name)                  ; exported
    (str (-prefix) name)))

(import greetings)
(greet "world")                          ; => "hello, world"

;; Redefine a command; the editor changes immediately.
(define (forward-word) (goto! (word-forward-offset)))
```

The language has special forms (`define`, `lambda`, `if`, `let` —
plain and named — `cond`, `quasiquote`, `defmacro`, `module`,
`import`, `try`, …), loop macros (`while`, `dotimes`, `dolist`), and
several hundred primitives — arithmetic, lists, higher-order
functions, strings, vectors, maps, a stable `sort`, buffer and editor
access, and introspection; the in-app function reference (`C-h d`)
documents close to five hundred functions. Tail calls run in constant
stack. Every procedure carries its docstring and source location;
`(doc forward-word)` and `(describe map)` ask the editor about itself.

**The REPL** (`C-x p`) shares the editor's live Lisp world and its
buffers. **Hot reload**: re-evaluating a `module` reuses its
environment, and `reload-stdlib` re-evaluates the whole standard
library — the running editor switches to the new definitions at once,
because the keymap binds command *names* and resolves them late.

> The macro system is procedural (non-hygienic) in this version;
> hygienic `syntax-case` macros are the planned target. See the spec
> for the full list of settled and deferred decisions.

## Architecture

The editor runs as a **Lisp server driving thin windows**. The server
— *the spine*, an Electron `utilityProcess`
(`apps/desktop/mwb/spine.js`) — owns the buffers, the Lisp
interpreter, and the keymap; each window is a thin client over a
`MessageChannelMain` port. Every keystroke is resolved by the server,
and renderer-side effects come back as directives that can target any
subset of windows. That is what makes multi-window coherent: all
windows share one Lisp world.

Beneath that topology, the code is organised in layers with
deliberately narrow interfaces:

| Layer | Package | Responsibility |
|-------|---------|----------------|
| **L0** Host | `apps/desktop` | Electron — window, filesystem, subprocesses, IPC |
| **L1** Storage | `packages/storage` | the text data structure, edit events |
| **L2** Buffer | `packages/buffer` | cursor, selection, editing, markers, overlays, change events |
| **L3** Lisp | `packages/lisp` | the Lisp runtime |
| **L4** Renderer | `packages/renderer` | DOM projection and input |
| — | `apps/desktop/mwb` | the server ("the spine") — the live Lisp world, key dispatch, panes, sessions |
| — | `packages/view` | the View abstraction — a per-tab on-screen surface (wraps an L2 buffer or holds its own state) |
| — | `packages/pane` | the Pane tree — a binary split tree; each leaf holds a view |
| — | `packages/stdlib` | the editor's commands, modes and keymap, in Lisp |

L1 → L2 → L4 is the dataflow path: commands mutate the buffer, the
buffer emits events, and those events drive rendering — the renderer
never mutates the buffer. Views and panes sit alongside the renderer:
views are the addressable on-screen things (text, browser, PDF, image,
shell, gnuplot, …), and panes are the layout tree that holds them.

Start with [`docs/MAP.md`](docs/MAP.md) — the index that names the one
authoritative document for each subsystem. The dispatch model is
[`docs/MODEL-B-DISPATCH.md`](docs/MODEL-B-DISPATCH.md);
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) describes the layers in
prose but predates the server topology, so read it as background. The
L2 API is [`docs/api/layer2.md`](docs/api/layer2.md).

## Project layout

```
godot/
  apps/
    desktop/            L0 — the Electron application
      mwb/              the server ("the spine") and the thin-client plumbing
  packages/
    storage/            L1 — text storage
    buffer/             L2 — the buffer / semantic model
    lisp/               L3 — the Lisp runtime
    renderer/           L4 — the DOM editor surface
    view/               the View abstraction
    pane/               the Pane tree (binary split layout)
    stdlib/             commands, modes and keymap, written in Lisp
  docs/
    MAP.md              START HERE — the index; one authoritative doc per subsystem
    MODEL-B-DISPATCH.md the dispatch model (server + thin clients)
    VIEWS.md            view / pane invariants and bug catalogue
    CUSTOM-VIEWS.md     how to add a new view kind
    GUARDRAILS.md       agent safety and branch discipline
    VISION.md           why the editor exists
    ARCHITECTURE.md     the layer model (background; predates the server)
    spec/               the Lisp and modes specifications
    api/layer2.md       the L2 buffer API and event protocol
    chapters/ reference/ guide/   sources for the three in-app books
  plans/                planning documents, one per feature
  architect-notes.md    the build log
```

It is a pnpm workspace. There is **no bundler**: the renderer loads the
workspace packages as native ES modules through an import map.

## Development

```bash
pnpm test                                  # all package test suites
pnpm --filter @editor/lisp test            # one package
pnpm --filter @editor/desktop smoke        # the Electron smoke harness
SMOKE_ARMS=isearch pnpm --filter @editor/desktop smoke   # just one arm
pnpm --filter @editor/desktop screenshot   # capture a PNG of the editor
```

Tests use the Node built-in test runner (`node --test`) — no test
framework dependency. The pure logic (the Lisp runtime, projection,
key normalisation, fuzzy matching, bracket matching) is unit-tested;
the DOM and the wired-together application are covered by the smoke
harness, which launches a hidden Electron window and exercises
rendering, the keymap, search, the REPL, file I/O and more.
`SMOKE_ARMS=<labels>` runs a subset for rapid iteration.

Conventions: feature work happens on branches and is merged
deliberately; small low-risk fixes may land directly on `main`. Every
commit passes the tests; commit messages follow Conventional Commits.
See [`CLAUDE.md`](CLAUDE.md) for the full working agreements.

## Status and roadmap

**Working today.** The editor opens, edits, searches, replaces, manages
many buffers and views, opens and saves files, highlights syntax, runs
an embedded Lisp REPL against the live server, and hot-reloads its own
standard library. It splits into panes, tabs, and multiple windows,
restores sessions across launches, and opens non-text content in
dedicated view kinds (web pages, PDFs, images, a real shell, a gnuplot
notebook, and more). It is in daily use for real writing — LaTeX,
JMarkdown, and its own source and documentation.

**Known limitations.**

- The Lisp dialect is highlighted by a tokenizer, not a tree-sitter
  grammar (it is a custom, still-evolving dialect).
- Typing is undone keystroke-by-keystroke (multi-edit *commands* do
  undo as one atomic step); there is no typing-run coalescing yet.
- Macros are procedural, not hygienic.
- Builds target macOS, Linux, and Windows, with macOS by far the most
  exercised of the three.
- Very large files are the least-exercised performance path (line
  rendering is virtualised, but other subsystems still walk the whole
  buffer).
- No LSP integration yet.

**Likely next.** Typing-run undo coalescing; hygienic macros; an LSP
client; fuzzy open-by-name across a project (Sublime-style `Cmd-P`).
None of these change the settled core.

## Design principles

Two commitments shape every decision.

**Legibility.** The editor should be comprehensible to the people who
use it — the architecture has a shape you can hold in your head, the
language has rules you can state precisely, the layers have clear
responsibilities, and the system explains itself when asked. When two
designs conflict, the more comprehensible one wins.

**Beautiful by default.** Visual quality is treated as architectural —
present from the first second, owned, not deferred to a theming system.

The fuller statement of intent is in [`docs/VISION.md`](docs/VISION.md).

## How it was built

Godot was built from an empty repository, collaboratively with Claude
Code, in a small number of intensive sessions. The layers, the Lisp
runtime, the standard library and the application were written and
tested incrementally; `architect-notes.md` is the running log of that
work, including the decisions and trade-offs made along the way.

## Beta testing

The editor is in **beta** (v0.1). This section is for people running a
downloaded build and reporting back.

### Install

Beta builds are attached to each [GitHub Release][releases] — download the
artifact for your platform:

- **macOS** — the `.dmg`: open it and drag the app to Applications. Builds
  are signed and notarized; if you run an *older* beta that predates
  notarization and macOS refuses to open it, right-click the app →
  **Open**, or clear the quarantine flag:
  `xattr -dr com.apple.quarantine "/Applications/Godot.app"`.
- **Linux** — the `.AppImage` (`chmod +x`, then run) or the `.deb`.
- **Windows** — the `-setup.exe` (NSIS installer).

[releases]: https://github.com/jmckalex/jmacs/releases

> Per-platform download links are added here once the first release is cut.

### Where your settings and data live

Everything hand-editable lives in **`~/.godot`** (after Emacs's
`~/.emacs.d`; override the location with the `$GODOT_HOME` environment
variable):

| File / folder | What it is |
|----|------|
| `init.lisp`, `custom.lisp` | your Lisp config, loaded at the end of startup — the way to customise the editor |
| `faces.json` | face (syntax colour / typography) overrides |
| `session.json`, `panes.json` | restored windows, buffers, and pane layout |
| `workspaces.json` | named workspace arrangements |
| `projects-index.json` | known projects |
| `recovery/` | crash-recovery snapshots |
| `snippets/` | your snippet definitions |

The OS per-user application directory (`~/Library/Application
Support/Godot/` on macOS) holds only Chromium's caches — plus, if you
ran a pre-beta build, the legacy data that was migrated into `~/.godot`
on first run. Per-file data (sticky notes, bookmarks) lives in a hidden
`.<filename>.godot-metadata` sidecar next to the file.

### Known limitations

The [Status and roadmap](#status-and-roadmap) section lists the standing
limitations. For the beta specifically: Windows shell support is the
least-exercised path.

### Reporting bugs

Please file issues on the [issue tracker][issues] — there's a structured
**Bug report** form. Data-loss bugs are the top priority: if file contents
were lost or corrupted, say so and they jump the queue.

[issues]: https://github.com/jmckalex/jmacs/issues

## License

Godot is free software, licensed under the **GNU General Public License,
version 3 or later** (`GPL-3.0-or-later`). You may use, study, share and
modify it under those terms; works derived from it must remain free
software under the same license. The full text is in
[`LICENSE`](LICENSE).
