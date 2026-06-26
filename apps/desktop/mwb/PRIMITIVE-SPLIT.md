# The Model-B primitive split

> Status: living document, written as the server-side stdlib port grows.
> Companion to `architect-notes.md` (the rolling Model-B log) and
> `plans/MULTI-WINDOW-MODEL-B.md` §5 (the model-vs-render change surface).

## Why this document exists

The command spine (`spine.js`) loads `commands.lisp` + `editing.lisp`
verbatim and runs them against a real L2 buffer through the real
`createBufferPrimitives`. Completing Model B means loading the **rest of
the stdlib server-side**. But most stdlib files are written against *host
primitives*, and those primitives fall into two very different worlds:

- **Model-side** primitives touch only buffer/interpreter state. The
  server *is* the authority for that state, so it can provide these
  directly — and it must, because the buffer lives in the server.
- **Render-side** primitives touch the screen: pixel measurement, DOM,
  the pane tree, view rendering, the system clipboard, MathJax, etc. The
  server (an Electron `utilityProcess` = a headless Node child) has no
  business doing these. Each one becomes either (a) a **down-channel
  view-update message** the client executes, or (b) a **stub/no-op** for
  now (the command resolves and its model effect, if any, runs; its
  visual effect is deferred).

Once a primitive is categorised, porting the stdlib file that uses it is
mechanical: provide the model-side ones, route or stub the render-side
ones, then load the file verbatim. **This table is the deliverable** —
it turns the remaining port from research into bookkeeping.

## The three categories

| Category | Meaning | Where it lives under Model B |
|---|---|---|
| **model** | Pure buffer/interpreter state. | Server provides it directly (already does, via `createBufferPrimitives`, or a small server-side helper). |
| **render-message** | A visual effect the client owns. | Server turns the call into a `VIEW`/scroll/`SNAPSHOT` message; client executes the pixels/DOM. |
| **stub** | Visual/system effect not yet wired. | Server no-ops it (or returns a harmless default). The command still loads + dispatches; the effect is deferred. Documented so it's a known gap, not a silent break. |

A useful litmus test: **could two windows showing the same buffer
legitimately disagree about the answer?** If yes (scroll position, pixel
height, which pane is focused, this window's minibuffer) it is per-client
→ render-side. If no (the buffer text, the kill ring, a major mode, a
customize value) it is shared → model-side.

## The split, by primitive family

### Buffer / editing — **model** (already provided)

The whole `createBufferPrimitives` surface is model-side and the spine
already supplies it: `point`, `mark`, `insert!`, `delete-backward!`,
`delete-forward!`, `delete-region!`, `buffer-text`, `buffer-substring`,
`buffer-length`, `buffer-line-count`, `goto!`, `cursor-*!`, `set-mark!`,
`clear-mark!`, `region-active?`, `region-text`, `line-start`, `line-end`,
`line-indent`, `word-forward-offset`/`word-backward-offset`,
`sentence-*-offset`, `fill-paragraph!`, `begin/end-change-group!`,
`make-marker`/`marker-position`/`set-marker!`/`release-marker!`,
`buffer-major-mode`/`set-major-mode!`, `buffer-minor-modes`/
`set-minor-modes!`, `view-name`/`set-view-name!`, `undo!`/`redo!`,
multi-cursor (`add-selection!`, `selections`, `collapse-to-primary!`,
`cursor-count`).

These are the bedrock: every model-heavy stdlib file is written against
them and "just works" server-side. (Markers/multi-cursor *render*
client-side, but the primitives themselves are model state.)

### Echo area / minibuffer — **render-message** (already wired)

| Primitive | Category | Server behaviour |
|---|---|---|
| `show-status!` / `clear-status!` | render-message | sets the echo string, broadcasts a `VIEW` |
| `open-minibuffer!` | render-message | sends a `VIEW` with `minibuffer.active`; the client shows the prompt and replies with minibuffer intents |
| `recenter!` | render-message | server picks the line (it knows point), sends a `scroll` request; client does the pixels (§5d, the *easy* direction) |

### Customisation — **model** (load) + **stub** (interactive openers)

| Primitive | Category | Note |
|---|---|---|
| `defcustom`, `custom-register!`, `custom-value`, `custom-apply!`, `custom-default`, `custom-state`, … | model | pure registry state in `custom.lisp`; loads + runs server-side unchanged |
| `write-custom-file!` | stub | persistence; only called by `save-customizations` (an interactive action), never at load |
| `open-customize!` / `open-customize-group!` / `open-customize-variable!` | stub | open a render-side customize view; the `customize` command resolves but the panel is deferred |

`*tab-width*` / `*indent-tabs-mode*` and the `-tab-width-effective` /
`-indent-tabs-effective` helpers (`indent.lisp`) are **model** — they read
the buffer's major mode + the custom registry. `line-ops.lisp` indent /
outdent depend on them and so are fully model-side.

### Modes — **model** (load) + **stub** (host sync)

| Primitive | Category | Note |
|---|---|---|
| `define-mode`, `register-mode`, `mode-for-name`, `switch-major-mode`, `enable-minor-mode`/`disable-minor-mode`, `minor-modes`, `add-hook`/`remove-hook`, `major-mode-name`, `resolve-keymap`, `major-mode-keymap` | model | `modes.lisp` is almost pure Lisp over buffer primitives — loads + runs server-side |
| `register-mode-menu!` / `mode-menu-sections` | model | pure registry; the *rendering* of the menu is render-side, but the registry is shared state |

The major-mode **keymap chain** must move into the spine's `handleKey`:
before the global table, consult the active buffer's major-mode keymap
and the active minor-mode keymaps (and `*key-reader*` for
`read-next-key`). This is what makes a mode's bindings (`C-c b` in
Markdown) dispatch server-side. Implemented in `spine.js`
(`resolveModeBinding`).

### Kill ring / yank — **model** + **stub** (system clipboard)

| Primitive | Category | Note |
|---|---|---|
| the `*kill-ring*` list, `kill-ring-add!`, `yank`, `yank-pop`, `kill-line`, `kill-word`, `copy-region`, `kill-region`, … | model | `kill.lisp`/`yank-pop.lisp` are ordinary Lisp over buffer primitives + the ring (shared interpreter state) |
| `clipboard-set-text!` / `clipboard-text` | stub (server-local) | the *interprogram* cut/paste edge. The server keeps an in-memory clipboard so the ring works fully + round-trips; true OS-clipboard sync is a render/main-process concern, deferred. (A future wiring: a `clipboard` render-message both ways.) |

**Subtlety — `*last-command*`.** `yank-pop` is valid only immediately
after `yank`/`yank-pop`, which it tests via `*last-command*` (set by
`run-command` in `commands.lisp`). For that to be true server-side, *all*
command dispatch must go through `run-command`. The spine's `handleKey`
already routes bound keys through `run-command`; the one gap was bare
self-insert (it called `buffer.insert` directly, never touching
`*last-command*`). Fixed: self-insert now clears `*last-command*` so a
yank-pop after typing is correctly rejected. (This is exactly the kind of
shared-history-state subtlety Model B forces you to get right, and it's
cheap once spotted.)

### Search / isearch — **stub** (the loop is host-owned)

| Primitive | Category | Note |
|---|---|---|
| `start-search!` / `start-search-backward!` | stub | `search.lisp`'s two commands just *begin* an incremental search; the actual isearch loop (per-keystroke match + highlight + minibuffer) lives in the host (renderer). Server-side this is a **render-message**-shaped feature — the right port is a server-driven search state machine + a client highlight overlay — but that's a whole slice of its own. For now the commands resolve and the loop is stubbed (documented gap). |
| `regex-search.lisp` | deferred | same shape, plus a regex overlay; not ported. |

This is the honest "render-side dependencies too entangled to port
cleanly now" case the brief allows: search's value is the *interactive
loop*, which is render-side, so loading `search.lisp` only gives you two
commands that point at an unbuilt loop. Documented, deferred.

### View / pane addressing — split: BUFFER LIST built, pane geometry deferred

This family has two halves, and Model B splits them cleanly:

- **The buffer list — the server owns it, BUILT.** "Which buffers exist,
  what is each window viewing, switch/kill a buffer" is *model* state: the
  buffers live in the server (`buffer-registry.js`), and each client tracks
  which one it views (the server's `clientBuffers` map). This is now
  implemented (architect-notes 2026-06-22, multi-buffer slice):
  `switch-to-buffer` (C-x b, a host-completed name read), `list-buffers`
  (C-x C-b → a `BUFFER_LIST` down-message), `kill-buffer` (C-x k), and
  find-file ADD a buffer. Two windows can view different buffers
  independently; two windows on one buffer still lockstep. The litmus test
  resolves to *model*: "which buffer is this window on" is per-client, but
  "which buffers exist + their text/overlays" is shared model state the
  server is authoritative for. `view-primitives.js`'s logical surface
  (`view-list`, `switch-to-view!`, `new-view!`, `kill-view!`, `find-view`)
  maps onto this registry; the spine exposes the same operations under the
  buffer names (`switchClientToBuffer`, `bufferListRecords`,
  `killActiveBuffer`).

- **The pane GEOMETRY — per-client render state, DEFERRED.**
  `pane-primitives.js` (splits, the pane tree, `swap-panes!`,
  `toggle-minimap!`) and the on-screen tabline are about *how a window
  arranges its views in pixels* — inherently per-client render state. These
  stay a negotiated conversation between the server (logical view list) and
  each client (its own pane geometry), and are **not** ported. The files
  that need them beyond the buffer list (`panes.lisp`, `tabline.lisp`,
  `minimap.lisp`, `directory-tree.lisp`, …) are out of scope; stubbed where
  a loaded file references one incidentally.

### Live preview / MathJax / element views — **render-message**, deferred

`markdown-preview!`, `math-preview!`, the math-preview replaced-range
rendering, `open-element-view!`, the Atari/bib-search element views — all
pure render-side (iframes, MathJax, custom elements). The *commands* that
trigger them (`markdown-preview`, `toggle-math-preview`) load and resolve
when their primitive is stubbed; the visual effect is a render-message to
build later. For the Markdown port, `markdown-preview!` / `math-preview!`
are **stubs**; everything else in `markdown.lisp` (the formatting,
heading, list, surround commands + the math-symbol minor mode) is
**model**.

### Regexp / string search + replace (regex-search.lisp) — **model** + **stub**

| Primitive | Category | Note |
|---|---|---|
| `find-regexp-forward` / `find-regexp-backward` / `find-string-forward` | model | first match `(start . end)` over the active buffer's text; a miss / invalid pattern is `#f` (absence convention). Mirror app.js's pure helpers byte-for-byte so a match resolves the SAME in both worlds. |
| `replace-regexp-all!` | model | rewrites every match; `$N`/`$&`/`$$` back-refs (the `expandReplacement` helper). |
| `replace-range!` | model | swap one match in a single edit (query-replace's per-match replace). |
| `start-regexp-search!` / `start-regexp-search-backward!` | stub | begin an incremental regexp search; the per-keystroke loop is render-side, like plain isearch. The starters surface a status, then no-op. |

`replace-regexp` and `query-replace` are thus FULLY model-side;
query-replace's y/n/q/! per-match loop runs through the spine's
`read-next-key` reader (the same suspend/resume the math-symbol `` ` ``
uses).

### View list (view-primitives.js) — **model** (a "view" = a registry buffer)

| Primitive | Category | Note |
|---|---|---|
| `new-view!` | model | mint a fresh empty registry buffer + switch the active client's focused leaf onto it. `occur` writes its results into the buffer this returns. |
| `find-view` / `switch-to-view!` | model | by-name buffer lookup / switch (a miss is `#f`). |

A "view" maps onto a registry buffer (PRIMITIVE-SPLIT.md "View / pane
addressing"): which buffer a window shows is per-client, but the buffer
set is shared model state, so these are model.

### Faces (faces.lisp) — **model** registry, **stub** rendering

| Primitive | Category | Note |
|---|---|---|
| `defface` / `face` | model (registry) | the face REGISTRY is shared model state (two windows agree on what a face is). The spine has a minimal `defface`/`face` shim in the prelude so feature files (`snippets.lisp`, …) register their faces at load; the `(from 'parent)` inheritance form is unused by loaded files. |
| `apply-face-styles!`, the `<style id="face-overrides">` write | stub | the actual painting (CSS overrides) is render-side, deferred. |

### Minibuffer TAB completion (files.lisp / latex-insert / reftex-refs) — **stub** (base) + **model** (commands)

| Primitive | Category | Note |
|---|---|---|
| `minibuffer-tab-complete` (base) | stub (pass-through) | the base TAB handler `latex-insert.lisp` / `reftex-refs.lisp` CAPTURE at load to wrap. TAB completion (the completions tab + live candidate list) is render-side, so the model-side base returns its input unchanged. The wrapping files still load + add candidate sources at command time; only the interactive completion UI is deferred. |
| `open-completing-minibuffer!` | render-message (prompt) | a completion-backed prompt. The suspend/resume IS the ordinary minibuffer round-trip — the spine routes it through the SAME prompt channel as `open-minibuffer!`. The candidate list / completions tab is the deferred render half. So a LaTeX smart-insert command resolves server-side (prompts, then runs its model effect on submit). |

### Snippets (snippets.lisp) — **model** engine, **stub** dir-store I/O

| Primitive | Category | Note |
|---|---|---|
| the whole expansion / field-nav engine (`-expand-record!`, `-select-field!`, `snippet-next/prev-field`, `snippet-commit`, mirrors-as-multicursors) | model | runs over `insert!`/`goto!`/`set-mark!`/`add-selection!`/`collapse-to-primary!` — all provided. A mirrored `$N` installs a real multi-cursor set (Policy A). The built-in starter set (`*snippet-builtins*`, pure Lisp) loads with NO directory I/O, so `snippet-insert`/`snippet-expand` work out of the box. |
| `snippet-date-string` | model | deterministic from the clock; mirrors app.js so a `` `date` `` snippet expands identically. |
| `snippet-user-directory` / `list-directory-paths` / `read-file-text!` | stub / model | the directory-store reads. No user snippet dir server-side yet → `snippet-user-directory` is `""` and `list-directory-paths` is nil (the built-ins cover the model proof). `read-file-text!` does a real disk read (the server is a Node child) for the day a snippet dir is wired. |

### the-keymap (keymap.lisp) — **model** shim + **handle-key** consults it

`keymap.lisp` is render-heavy and not loaded, but `auto-pair.lisp` binds
the bracket/quote characters into `the-keymap`. The spine provides a
model-side `the-keymap` (`{}`) in the prelude, AND `handle-key` consults
it for a single printable BEFORE self-insert (exactly as production
resolves `the-keymap` first). So a typed `(` runs `auto-pair-open-paren`
server-side **end-to-end** — pair insertion, step-over, backspace-deletes-
both. The spine's motion/editing chords stay in the JS `KEYMAP`; only the
per-character auto-pair bindings land in `the-keymap`.

### Bookmarks / sticky notes — **deferred** (render-coupled engines)

`bookmark-set!`/`bookmark-jump!`/`open-bookmark-view!` (the `bookmarks.js`
engine + the outline view) and the `note-*!` family (the sticky-note
overlay + JMarkdown-render + metadata sidecar) are render/host-side
engines. The Lisp commands are thin shells over them; loading the files
server-side would only resolve commands against unbuilt engines. These are
slices of their own (a server-side bookmark marker store, a sticky-note
overlay protocol), **not table-rows** — deferred.

### Citations (cite.lisp) — **model** (the citation bridge IS the model)

| Primitive | Category | Note |
|---|---|---|
| `citation-parse` / `citation-parse-lenient` / `citation-format` / `citation-format-bibliography` / `citation-keys` / `citation-entries` / `citation-format-entries` / `citation-format-keys` / `citation-register-style!` | model | The citation host bridge (`citation-bridge.js`). Backed by the renderer's OWN `citation.js` + its vendored Citation.js bundle (`packages/renderer/vendor/citation-js.esm.js`) — pure ESM, no DOM/Electron, so the headless server imports the SAME module the renderer uses (a fixed relative path into `packages/renderer/src`, NOT a `/tmp` resolution). The bodies mirror app.js's (same `apa`/`text`/`en-US` defaults, same absence convention), so a bib parses + formats to the SAME CSL string in both worlds. Two windows on one document agree on how a bibliography formats → shared model state. `cite.lisp` (`load-bibliography` / `format-bibliography` / `format-citation` + `*citation-style*` / `*citation-bib-path*`) loads verbatim on top of it. |

### RefTeX (reftex.lisp + reftex-refs/reftex-cite) — **model** (BUILT)

The full RefTeX R1–R3 chain now loads + runs server-side. The label/section/
cite DB is Lisp over the **pure** primitives `latex-scan` / `path-resolve` /
`path-dirname` / `path-basename` (`createLatexPrimitives`, spread once like
`createBufferPrimitives`) + the impure reads `read-file-text!` / `file-exists?`
(real `statSync`) / `list-directory-paths` (real `readdirSync`, upgraded from
the NIL stub) + the view verbs `current-view` / `view-list` / `view-file-path`
/ `view-buffer` / `view-directory` / `switch-to-view!`. `view-file-path` /
`view-directory` map a view back to its registry entry by buffer identity
(`entryForView`), so the entry's `filePath` drives `reftex-master` /
bib-path resolution.

`reftex.lisp` redefines `latex-master-file` — `latex-compile.lisp` is NOT
loaded (it pulls in `run-process!` / `pdf-reload!` / `open-file-in-split!` /
the utility dock — render/process-side), so reftex's `latex-master-file`
(which calls `reftex-master`) is the sole definition.

**The cite/ref pickers ride the generic PICKER channel (G0b).** The three
bespoke openers — `open-reftex-select!` (label picker), `open-reftex-cite-
format!` (cite format menu), `open-reftex-cite-select!` (cite entry picker)
— are defined server-side as `picker-read` calls over JS row-providers
(`reftex-select-rows` / `reftex-cite-format-rows` / `reftex-cite-index-rows`,
which marshal the Lisp candidate accessors into the picker's `{label, value,
group, detail}` wire shape). A choice resumes the matching reftex callback
(`reftex-select-on-select` / `reftex-cite-format-chosen` / `reftex-cite-
insert`); a nil cancel resumes its `-on-cancel`. The command bodies
(`reftex-reference` / `reftex-citation`) are unchanged. Proven end-to-end
in `reftex-flow.test.js` (a real `.tex` + `.bib` in a temp dir): C-c [ →
format PICKER → cite PICKER → `\cite{key}`; C-c ) → label PICKER →
`\eqref`/`\ref`; C-c ( → minibuffer → `\label{...}`.

**Deferred** (bespoke-panel affordances, not the daily path): SPC-peek in
the label picker and `m` multi-key marking in the cite picker — the generic
picker is choose-or-cancel, so the single-choice path (the common case) is
fully wired; multi-mark + peek + the bottom-dock LIVE preview panel are
render-side follow-ups. Also deferred: `latex-compile.lisp`'s compile/view
loop (`run-process!` / SyncTeX / the PDF view) — a process/render slice of
its own, and `latex-synctex.lisp` / `latex-menu.lisp` which sit on top of it.

## What this means for the remaining port

With the table above, each not-yet-ported stdlib file resolves to a
recipe:

1. List the host primitives it calls (`grep` for non-`define`d symbols).
2. Look each up here (or extend the table with a new family).
3. Provide the **model** ones (usually already there), route the
   **render-message** ones to a `VIEW`/scroll/`SNAPSHOT`, **stub** the
   rest.
4. Load the file verbatim; add a headless test that drives one of its
   commands through the spine and asserts the buffer/mirror result.

The remaining genuinely-hard work is concentrated in the
**render-message** families that need a real protocol both ways — the
isearch loop, the pane/view negotiation, MathJax/preview, the
measurement conversation's *hard* direction (§5d). Those are slices, not
table rows. Everything model-side is now mechanical.

## Ported so far

See `architect-notes.md` for the running record. Loaded server-side
verbatim on top of `commands.lisp` + `editing.lisp`: `custom.lisp`,
`indent.lisp`, `modes.lisp`, `math-preview.lisp`, `kill.lisp`,
`yank-pop.lisp`, `line-ops.lisp`, `occur.lisp`, `expand-region.lisp`,
`multi-cursor.lisp`, `search.lisp` (commands only; loop stubbed),
`regex-search.lisp` (replace-regexp + query-replace model-side; the
isearch-regexp starters stubbed), `markdown.lisp` (a real major mode
through the server), `latex.lisp` + `latex-insert.lisp` +
`latex-math.lisp` + `latex-nav.lisp` + `latex-fill.lisp` (the model-side
AUCTeX commands; completion-driven inserts round-trip through the
completing-minibuffer), `makefile.lisp`, `panes.lisp` (G0a),
`auto-pair.lisp` (auto-pairs end-to-end on a keystroke via `the-keymap`),
`snippets-parser.lisp` (pure), `snippets.lisp` (the full engine —
expansion, field nav, mirrors-as-multicursors), `cite.lisp` (citation
parse/format over the `citation-bridge.js` host bridge), `reftex.lisp` +
`reftex-refs.lisp` + `reftex-cite.lisp` (the RefTeX R1–R3 chain — multi-file
DB, label/section/cite scan, `reftex-citation`/`reftex-reference`/
`reftex-label` through the generic PICKER channel). Each driven headlessly
through the spine (one `node --test` per file/chain).

**G3 batch (2026-06-22):** ~26 of ~70 STDLIB_FILES now load server-side.
The model-side editing / mode / snippet / latex surface is broadly
server-ready. What remains is concentrated in render-message slices
(isearch loop, preview/MathJax, pane geometry, completion UI) + a few
render-coupled feature engines (bookmarks, sticky notes, jukebox, shell,
notebook — all `open-*-view!`) and the reftex chain (needs the citation
bridge + cite.lisp).

**Multi-buffer (2026-06-22):** the server now holds MANY buffers
(`buffer-registry.js`), each with its own text / per-client views /
overlays. find-file adds a buffer; `switch-to-buffer` (C-x b),
`list-buffers` (C-x C-b), and `kill-buffer` (C-x k) work through the
server. Two windows can view different buffers, or one buffer in lockstep.
Deltas / overlays / multi-cursor resyncs are scoped to the edited buffer
(no longer broadcast). Proven headlessly through the real view.js
(`MWB_MULTIBUFFER_SELFTEST`, 1- and 2-window).
