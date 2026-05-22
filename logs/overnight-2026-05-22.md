# Build log — overnight run, night of 2026-05-22

A record of the parallel-build night specified in
`plans/OVERNIGHT-2026-05-22.md`, for retrospective inspection.

Each task appends its own section below — task id, branch, what was
built, decisions and deviations, test results. Entries are appended in
completion order; earlier entries are never rewritten.

---

## 23:00 — orchestration begins

The run is orchestrated **serially** (one agent at a time, each merged
before the next) — see the Execution note in the plan. Without the
worktree retool, concurrent agents cannot safely share one working
copy; serial dispatch is conflict-free by construction.

Priority order: Track A (differentiators) → Track C (editing depth) →
T0 + Track B (languages) → Track D (polish). The run proceeds as far as
the night allows; `main` is left in a clean, tested state throughout.

---

## A1 — image buffers  (branch `agent-a1-image-buffers`)

**What was built.** Opening an image file (`.png`, `.jpg`/`.jpeg`,
`.gif`, `.svg`, `.webp`) now shows the image instead of its bytes,
reusing the buffer-kind / view-kind mechanism the customisation buffer
established.

- New file `packages/renderer/src/image-view.js`: the image view,
  modelled on `customize.js`. Fit-to-window by default, a toolbar
  button toggles to actual (100%) size. Exports two pure helpers —
  `isImageName` and `mimeTypeForImage` — both unit-tested
  (`packages/renderer/test/image-view.test.js`, 6 tests).
- `packages/renderer/src/index.js`: exports the three new symbols.
- `apps/desktop/src/files.js`: the `file:open` IPC handler detects an
  image suffix and returns the file as a `data:` URL in `imageSrc`
  (the renderer is sandboxed, so the host does the read).
- `apps/desktop/src/app.js`: creates the `imageView`, generalises
  `mountView` to three kinds (text / customize / image), handles the
  `image` kind in `switchToBuffer`, and routes a returned `imageSrc`
  into a new `{kind:'image', name, filePath, src}` buffer in
  `openFileInteractive`.
- `apps/desktop/styles.css`: image-view styles (toolbar, checkerboard
  stage, fit vs actual sizing).
- `apps/desktop/scripts/smoke.js`: a new image-buffer check — stubs
  the open dialog to choose a scratch PNG, drives the real file-open
  path, and confirms the image view shows, carries a data URL, starts
  fit-to-window, and toggles to actual size and back.

**Key decisions / deviations.**

- The image source is delivered as a `data:` URL via the existing
  `file:open` handler, *not* the `app://` scheme. The plan offered
  either; the data-URL route needed **no change to `preload.mjs`**
  (not in this task's allowed shared-file list) — the existing
  `host.openFile` passes the handler's result through unchanged. The
  `app://` scheme only serves files inside the repo, whereas opened
  images are typically outside it, so the data URL is also the more
  general choice.
- The host-side suffix→MIME helper in `files.js` (`imageMimeType`) is
  an un-exported internal twin of the renderer's exported, unit-tested
  `mimeTypeForImage`. `files.js` cannot import `@editor/renderer` (the
  main process has no import map, and the package is not a desktop
  dependency), and `node --test` cannot import `files.js` at all (its
  top-level named `electron` imports fail outside the Electron
  runtime). The duplicated logic is trivial and is covered end-to-end
  by the smoke check; flagged here for the integration pass.
- `updateModeline` needed no change — it already treats any buffer
  with a `kind` generically (name shown, no point/mode).

**Tests.** `pnpm test` — all packages pass, 0 failures (renderer now
383 incl. 6 new image-view tests; desktop 11; full suite green).
`pnpm --filter @editor/desktop smoke` — PASS, including the new
`image: {"shown":true,"hasDataUrl":true,"startsFit":true,
"toActual":true,"backToFit":true}` check.

**Commits.**
- `6012e62` feat: add image-view component for the image buffer kind
- `93f3667` feat: open image files as image buffers
- `dfec1a8` test: add an image-buffer smoke check
- (this log entry)

---

## A2 — live Markdown preview  (branch `agent-a2-markdown-preview`)

**What was built.** A toggleable preview pane, to the right of the
editor, that renders the current `markdown-mode` buffer to HTML and
refreshes as the buffer is edited.

- New file `packages/renderer/src/markdown-preview.js`: the preview-pane
  component, modelled on `repl.js` — a plain DOM component decoupled
  from the Lisp runtime. It is handed Markdown source and a `render`
  function; `update` debounces refreshes (~250ms, `PREVIEW_DEBOUNCE_MS`)
  and `refreshNow` renders immediately. A render-token guard stops a
  slow render from overwriting a newer one; an optional `typeset` hook
  covers MathJax. Eight unit tests
  (`packages/renderer/test/markdown-preview.test.js`).
- `packages/renderer/src/index.js`: exports `createMarkdownPreview` and
  `PREVIEW_DEBOUNCE_MS`.
- `apps/desktop/index.html`: a `.workspace` row wraps the editor host
  and the new `#markdown-preview-host` pane.
- `apps/desktop/styles.css`: the `.workspace` flex row, the
  `.markdown-preview-host` pane (42% width, white preview body) and
  `body.markdown-preview-hidden` show/hide — modelled on `repl-hidden`.
- `apps/desktop/src/app.js`: creates the pane (reusing `renderNoteHtml`,
  the sticky-note JMarkdown bridge, as its renderer), adds the
  `markdown-preview!` primitive, refreshes the pane on every buffer
  edit (via `watchCurrentBuffer`) and re-points it on a buffer switch.
- `packages/stdlib/lisp/markdown.lisp`: the `markdown-preview`
  `defcommand`, bound to `C-c v` in `markdown-c-c-map`.

**Decisions / deviations.**
- The pane starts hidden and only opens on a `markdown-mode` buffer;
  invoking `markdown-preview` on any other buffer reports a REPL note
  and does nothing (the preview is meaningless off Markdown). Switching
  away from a Markdown buffer auto-closes the pane.
- MathJax typesetting of the pane was done — the "nice-to-have" — since
  the app already loads MathJax and the sticky-note `typesetMath`
  helper was a ready template; it is a no-op if MathJax is absent.
- No deviation from the keybinding allocation: `C-c v` was free in
  `markdown-c-c-map`.

**Tests.** `pnpm test` — all packages pass, 0 failures (renderer 89
incl. 8 new markdown-preview tests; stdlib 118 incl. 2 new
markdown-preview tests; full suite green).
`pnpm --filter @editor/desktop smoke` — PASS, including the new
`preview: {"shown":true,"rendered":true,"refreshed":true,
"hidden":true}` check (opens the pane with `C-c v`, confirms the
heading reaches the rendered HTML, an edit refreshes it, `C-c v`
hides it).

**Commits.**
- `db5ed66` feat: add the Markdown preview pane component
- `a1bb5cb` feat: add live Markdown preview pane
- (this log entry)

---

## Task A3 — clickable colour swatches

**Branch**: `agent-a3-colour-swatches` (off `main`, not merged).

**What was built.** Beside every colour literal in code — `#rgb`,
`#rrggbb`, `#rrggbbaa` (and `#rgba`), `rgb(...)`, `rgba(...)` — the
editor view now renders a small inline clickable swatch. Clicking a
swatch opens a modal colour chooser; on OK the chosen colour is
written back into the buffer, replacing the literal's text.

- `colour-literals.js` — the pure, DOM-free detector. `findColourLiterals`
  reports each literal's exact `{start, end, text, css}` span;
  `normaliseToHex` resolves a literal to the `#rrggbb(aa)` form.
- `colour-picker.js` — `openColourPicker`, a real in-app modal
  (backdrop + panel + OK/Cancel) wrapping a native `<input type=color>`,
  with a live preview and an editable hex field. Escape/Enter and a
  backdrop click are handled; the modal grabs the keyboard in the
  capture phase so editor keys do not fire underneath it.
- `colour-swatches.js` — `createColourSwatches` (per-line `decorateLine`,
  walks the line's text nodes and inserts a swatch after each literal,
  surviving the highlighter's token-span split) and the pure
  `replaceLiteralInBuffer` helper.
- `view.js` — the view builds the decorator over its own active buffer
  and runs it per rendered line; `colourSwatches: false` disables it.
- `styles.css` — inline swatch (checkerboard for alpha) + modal styles.

**Decisions / deviations.**
- No app.js change. The brief said "the view already has buffer
  access; use it" — the decorator reads the view's `activeBuffer`
  through a closure, so a `setBuffer` swap needs no rewiring and no
  shared-registry wiring is required at integration.
- The buffer edit uses only the buffer's public command surface
  (`moveTo` + `moveTo {extend}` + `insert`); the L2 buffer exposes no
  `replace(start,end,text)`. On OK the swatch re-checks the captured
  span still holds the literal before editing, so a stale span never
  corrupts unrelated text.
- Fixed one pre-existing latent bug while adding the per-line offset
  loop in `renderLines`: `first` can exceed `lineCount` after
  switching to a shorter buffer, so the offset sum is clamped.

**Tests.** `pnpm test` — all packages green, 0 failures (renderer 121,
incl. 24 new: 21 for the colour-literal detector + `normaliseToHex`,
and decorate/replace tests for the swatch module against a faithful
minimal DOM). `pnpm --filter @editor/desktop smoke` — PASS, including
the new `swatches: {"count":2,...,"edited":"a #00ccff b rgb(0,0,0)",
"modalClosed":true}` check (two swatches appear, clicking one opens
the modal, OK replaces `#ff8800` with the chosen `#00ccff`).

**Commits.**
- `81a3dcb` feat: add pure colour-literal detector for swatches
- `7911c32` feat: add colour-picker modal and swatch decorator
- `9b96dcc` feat: wire colour swatches into the editor view
- `82fb7ca` test: add a smoke check for colour swatches
- (this log entry)

---

## Task C1 — yank-pop / kill-ring browsing

**Branch**: `agent-c1-yank-pop` (off `main`, not merged).

**What was built.** After a `yank` (C-y), pressing `M-y` replaces the
just-yanked text with the *previous* kill from the ring; repeated `M-y`
keeps cycling back and wraps around — Emacs's `yank-pop`. It is valid
only immediately after a `yank` or another `yank-pop`; run after any
other command it is inert and reports "previous command was not a yank".

- `commands.lisp` (shared, permitted): `run-command` now records
  `*this-command*` and shifts the prior name into `*last-command*`, so a
  command can tell what ran immediately before it. This is the
  adjacency check `yank-pop` needs and a small reusable mechanism.
- `kill.lisp` (shared, permitted): `yank` records its insertion —
  offset, length, kill-ring index — via the new `record-yank!`. Added
  `kill-ring-ref` (indexed, wrapping) and `kill-ring-length` helpers.
- New file `yank-pop.lisp`: the `yank-pop` `defcommand` plus the
  `after-yank?` predicate; deletes the recorded yank region and inserts
  the next kill, re-recording the new state for further cycling.
- `keymap.lisp` (shared, permitted): bound `M-y` to `yank-pop` (`M-y`
  was unbound).
- `index.js` (shared, permitted): one `STDLIB_FILES` entry —
  `yank-pop.lisp`, loaded after `kill.lisp`, before `keymap.lisp`.

**Decisions / deviations.** None from the spec. `yank-pop` lives in its
own new file as instructed; the yank *state* (and the `yank` change to
record it) stays in `kill.lisp` so all kill-ring/yank state is in one
place. No host primitive was needed — pure Lisp throughout. The
`*last-command*` tracking was added to `commands.lisp` rather than
inventing a yank-only flag, since it is the correct general mechanism
and other commands (e.g. a future `append-next-kill`) can reuse it.

**Tests.** `pnpm test` — all packages green, 0 failures (stdlib 125,
incl. 7 new: M-y binding, swap-in-previous-kill, cycle-and-wrap,
cursor-after-text, inert-without-yank, intervening-command-invalidates,
and `*last-command*` tracking). `apps/desktop/` untouched, so no smoke
test run (per spec).

**Commits.**
- `9830419` feat: add yank-pop (M-y) for kill-ring browsing
- `a051701` test: cover yank-pop kill-ring browsing
- (this log entry)

---
