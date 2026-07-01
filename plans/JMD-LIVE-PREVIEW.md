# JMarkdown live preview — update on a typing pause, not just on save

**Status:** design (branch `jmd-live-preview`), 2026-07-01. No code yet — this
is the plan to review before implementing.

## Goal

The JMarkdown preview pane (`C-c v`) should refresh **after a short pause in
typing**, not only when the user explicitly saves. Today the preview reflects
the last *saved* state of the file; the ask is a debounced, save-free live
update.

## How the preview works today

The preview is rendered by the **real external `jmarkdown watch <file> --port N`
server** — the same pipeline the book build uses — embedded in an iframe and
live-reloaded (morphdom DOM-diffing) whenever the *file on disk* changes.

- `apps/desktop/src/jmarkdown-watch.js` (main process) spawns/reaps one
  `jmarkdown watch` child per window, keyed by `webContents.id`; args from
  `jmarkdown-watch-args.js` (`['watch', filePath, '--port', String(port)]`).
- The renderer toggles the pane and calls IPC `jmarkdown:watch:start {path}`
  with the buffer's **saved** path (`app.js` → `toggleMarkdownPreview`; the
  spine's `markdown-preview!` sends the saved path, `''` when unsaved).
- The trigger for a refresh is purely the **file changing on disk**. The
  renderer's edit handler explicitly does nothing for the preview
  (`app.js:517` — "the preview updates on save, not per keystroke").
- **Forward/inverse search is purely line-based** (`preview-window.js`): the
  iframe's `sync.js` posts `{type:'source-line-click', line}` (inverse, ⌘-click)
  and receives `{type:'scroll-to-line', line}` (forward, cursor). **No path is
  exchanged** — the editor side always acts on the *active buffer* by line
  number. This is the key enabler below.

So the only thing coupling the preview to "save" is that a save is the only
thing that currently changes the watched file's bytes.

## The decision: what does the server watch?

`jmarkdown watch` is file-driven and external (we don't modify it here), so a
save-free update means getting the *current buffer text* to something the server
watches, without an explicit `C-x C-s`. Three ways:

### Option A — debounced auto-save to the real file
On a typing pause, write the buffer to its real path (the same bytes `C-x C-s`
writes). The server picks it up.
- **Pros:** minimal; forward/inverse search and relative resources (CSS, bib,
  images, `[[includes]]`) are unaffected because nothing about the file moves.
- **Cons:** silently *persists* the user's file behind their back — changes
  mtime, clears the dirty flag (so "unsaved changes" no longer means what it
  did), and fires every on-save side effect (atomic write, `.godot-metadata`
  sidecar, recovery-snapshot churn) every few seconds. It conflates preview with
  persistence and fights the app's deliberate data-safety model. Surprising.

### Option B — debounced write to a same-directory shadow file (recommended)
On preview start, seed a sidecar copy `<dir>/.<base>.godot-preview<ext>` with the
buffer's current text and spawn `jmarkdown watch <shadow> --port N`. On each
typing-pause debounce, rewrite the shadow with the live buffer text. The real
file is never touched until the user actually saves.
- **Pros:** preview reflects the live (even unsaved) buffer with **zero change
  to save semantics** — the user's file and dirty state are untouched. Because
  the shadow sits in the **same directory**, all relative resources resolve
  exactly as for the real file. Because it is a **line-identical copy** and the
  sync protocol is line-based, forward/inverse search keep working unchanged.
- **Cons:** a shadow-file lifecycle to own (create / seed / rewrite / delete on
  stop, window close, quit, and crash-leftover sweep); a transient dotfile
  sidecar in the project dir (git-ignorable); and `jmarkdown watch` may emit its
  own `.<base>.godot-preview.html` output next to the shadow (needs a cleanup
  sweep). All manageable.

### Option C — push content to the server (future, needs a jmarkdown change)
If `jmarkdown watch` grew a content-push endpoint (stdin / HTTP POST /
websocket) or a `--resource-base <dir>` flag, we could push buffer text with no
shadow file (or keep the shadow in `os.tmpdir()` while resolving resources
against the real dir). Cleanest, but it's a change to the external `jmarkdown`
tool (Jason's own), so out of scope for this branch. Worth noting as the
eventual endgame — if it lands, B collapses to "push the text."

**Recommendation: Option B.** It's the one that delivers a true live preview
without redefining what "saved" means, and the line-based sync makes it safe.
The main cost is shadow-file housekeeping, which is bounded and testable.

## Detailed design (Option B)

### Shadow path
Derive deterministically from the real path so any process can recompute it:
`join(dirname(real), '.' + basename(real, ext) + '.godot-preview' + ext)`.
Same directory ⇒ relative `CSS:`/`Bibliography:`/image/`[[include]]` paths in the
metadata header resolve identically. Dotfile ⇒ hidden from casual listings and
easy to `.gitignore` (`.**.godot-preview.*`). One shadow per window (mirrors the
one-watcher-per-window model).

### Lifecycle (main process — `jmarkdown-watch.js`)
1. **start(previewMode, path, initialText):** when previewing *content* (not the
   raw file), compute the shadow path, write `initialText` to it, and spawn
   `jmarkdown watch <shadow>`. Track `{ child, port, shadowPath }` in `watchers`.
2. **sync(text):** rewrite the shadow **in place** (truncate + write, not
   atomic-rename — an inode swap can slip past a naive watcher; verify jmarkdown
   catches in-place writes). Coalesce here too as a backstop.
3. **stop / window-closed / quit:** after reaping the child, `unlink` the shadow
   (and any sibling `.<...>.godot-preview.html` the server produced). Best-effort.
4. **crash-leftover sweep:** on start, unlink a stale shadow for that path first.

### Debounce (renderer — `app.js`)
The renderer already gets every edit (`onChange`, ~`app.js:505`) and knows the
preview pane is open, and holds `currentTextBuffer.text`. So:
- On an edit, **if the preview is open for the active buffer**, (re)arm a timer
  for `*markdown-preview-debounce-ms*` (a `defcustom`, default ~400ms, live-
  tunable). On fire, IPC `jmarkdown:watch:sync { content: currentTextBuffer.text }`.
- **Flush immediately** on explicit save (so `C-x C-s` stays instant) and on
  buffer switch / preview (re)open (seed the shadow at once).
- Only arm while the preview is open **and** the active buffer is the previewed
  one; disarm on preview close / buffer switch away.

### IPC surface
Add `jmarkdown:watch:sync` (renderer→main, fire-and-forget) carrying the full
buffer text. Full text per debounce is fine — it's infrequent (pause-gated) and
the write is cheap; diffing would be premature. `start` gains the seed text and a
"content vs file" flag.

### What stays untouched
Forward/inverse search (line-based, path-free), the pop-out window
(`preview-window.js` still just loads the port), resource resolution (same dir),
and — crucially — the user's real file and its saved/dirty state.

## Risks & mitigations
- **Sidecar visible in dir / git:** dotfile naming + a `.gitignore` entry;
  aggressive unlink on every teardown path; startup sweep of stale shadows.
- **Server output file (`.html`) next to the shadow:** include it in the unlink
  sweep; confirm what `jmarkdown watch` actually writes.
- **Watcher misses in-place writes:** write in place; if jmarkdown only reacts to
  rename, switch to write-temp-then-rename *within the same dir*.
- **Relative resources:** guaranteed by same-dir placement; add a test doc with a
  `CSS:` + image + `[[include]]` to the live check.
- **Large documents:** debounce is pause-gated; full-text write is O(size) and
  rare. Revisit only if a pathological file shows lag.
- **Rapid buffer switches:** reuse the existing one-watcher-per-window reaping;
  the shadow is re-seeded on switch.
- **Unsaved / never-saved buffer:** today preview needs a saved path; with a
  shadow we *could* preview an unsaved buffer by seeding the shadow in a chosen
  dir — but relative resources have no home then. Keep "needs a directory"
  (i.e. a saved path) for v1; note as a possible follow-up.

## Staged implementation plan (small, tested commits)
1. **Shadow lifecycle in main** (`jmarkdown-watch.js`): path derivation, seed on
   start, `sync` handler, unlink on teardown + startup sweep. Unit-test the pure
   pieces (path derivation, arg building) like `jmarkdown-watch-args.test.js`;
   the spawn/watch I/O is live-verified.
2. **`*markdown-preview-debounce-ms*` defcustom** + renderer debounce in
   `app.js` onChange, gated on preview-open + active buffer; flush on save; seed
   on open/switch. Wire the new IPC in `preload.mjs`.
3. **Cleanup + gitignore + a demo doc** with relative resources; live-verify the
   full loop (type → pause → preview updates; save still instant; forward/inverse
   search intact; no stray files after close).

## Open questions for the architect
1. **A vs B** — confirm the shadow-file approach (no auto-persist) over debounced
   auto-save. (Recommendation: B.)
2. **Debounce default** — 400ms ok? (Live-tunable via the defcustom regardless.)
3. **Does `jmarkdown watch` support a `--resource-base`/`--root` flag** (or
   content push)? If so, Option C lets us drop the sidecar (tmp-dir shadow) — a
   nicer endgame worth a small jmarkdown change.
4. **Unsaved buffers** — keep requiring a saved path for v1 (so resources have a
   directory), or seed a shadow somewhere for never-saved drafts?
