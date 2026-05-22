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

## Task C2 — line operations  *(branch `agent-c2-line-ops`)*

**What was built.** Four whole-line editing commands in a new file
`packages/stdlib/lisp/line-ops.lisp`:

- `move-line-up` / `move-line-down` (`M-Up` / `M-Down`) — swap the
  current line with its neighbour, deleting the line plus one bounding
  newline and re-inserting it on the far side. The cursor keeps its
  column and travels with the line.
- `duplicate-line` (`C-x C-d`) — inserts a copy of the current line
  immediately below; the cursor moves to the copy, keeping its column.
- `join-line` (`C-x C-j`) — pulls the next line onto the current one,
  collapsing the intervening newline and the next line's leading
  whitespace to a single space (Emacs-style); the cursor lands at the
  join, before the space.

`line-ops.lisp` was added to `STDLIB_FILES` (after `yank-pop.lisp`,
before `keymap.lisp`); the four keys were bound in `keymap.lisp`
(`M-up`/`M-down` in `the-keymap`, `C-d`/`C-j` in `c-x-keymap`).

**Decisions / deviations.** None from the spec. All four commands are
pure stdlib Lisp on the existing buffer primitives — no host change
needed. Edge cases handled and tested: `move-line-up` on the first
line and `move-line-down`/`join-line` on the last line are inert.
Small `line-ops`-local helpers (`current-line-text`, `line-column`,
`first-line?`, `last-line?`, `drop-leading-blanks`) keep the commands
readable; `drop-leading-blanks` is a hand-rolled left-trim since the
Lisp has no `string-trim` primitive.

**Tests.** `pnpm test` — all packages green, 0 failures (422 total;
stdlib 140, incl. 15 new covering each command, cursor/column
carry-over, the no-op edge cases, the round-trip, and the key
bindings). `apps/desktop/` untouched, so no smoke test run (per spec).

**Commits.**
- `1624748` feat: add line operations (move, duplicate, join)
- (this log entry)

---

## Task C3 — auto-pairing  *(branch `agent-c3-auto-pair`)*

**What was built.** Automatic insertion of matching brackets and
quotes, in a new file `packages/stdlib/lisp/auto-pair.lisp`. Typing
`(`, `[`, `{`, `"` or `` ` `` inserts the closing partner and leaves
the cursor between the pair. Typing a closing `)`, `]`, `}` — or a
closing `"`/`` ` `` — when that character is already the next one
steps the cursor past it instead of inserting a duplicate. Backspace
between an empty pair removes both characters. A `defcustom`
`*auto-pair*` (`:boolean`, default `#t`) turns the whole behaviour
off, at which point the keys self-insert exactly as before.

- Eight `defcommand`s in `auto-pair.lisp` — one per bracket/quote
  opener (`auto-pair-open-paren` …) and one per non-quote closer —
  each consulting `*auto-pair*` and the character after the cursor.
- The bracket and quote characters are bound to those commands in
  `the-keymap` (using `assoc`); `handle-key` resolves a bound symbol
  before it would otherwise self-insert a printable character, so
  this is what intercepts the typed character — no host change.
- `delete-backward` is redefined in `auto-pair.lisp` (it loads after
  `editing.lisp`) so a backspace between an empty pair deletes both
  characters; every other case falls through to the underlying
  `delete-backward!` primitive.
- `STDLIB_FILES`: one append — `auto-pair.lisp`, loaded after
  `keymap.lisp` (it needs `the-keymap`) and after `custom.lisp` (it
  declares a `defcustom`).

**Decisions / deviations.** None from the spec. Auto-pairing is a
mode-keymap-friendly *global* binding: a major or minor mode that
binds one of these characters (math mode's `` ` ``, for instance)
still shadows the global binding through the existing keymap chain —
the math-mode tests continue to pass. The `delete-backward`
redefinition is local to this file (its loading order makes it the
live binding); no other file is touched besides `STDLIB_FILES`.

**Tests.** `pnpm test` — all packages green, 0 failures (440 total;
stdlib 158, incl. 18 new covering: the `defcustom` registration,
each opener inserting its partner, each closer stepping past an
existing match, a self-insert when no match is ahead, the
backspace-collapses-empty-pair and backspace-doesn't-collapse-text
cases, the off-mode preserving plain self-insert and ordinary
backspace, the keymap bindings, and a wrap-text-as-you-type
end-to-end). `apps/desktop/` untouched, so no smoke test run (per
spec).

**Commits.**
- `a2ae191` feat: add auto-pairing for brackets and quotes
- (this log entry)

---

## Task C4 — `occur`  *(branch `agent-c4-occur`)*

**What was built.** A new `defcommand` `occur` (in a new file
`packages/stdlib/lisp/occur.lisp`) that prompts for a literal
substring via its interactive spec — `(interactive (string "Occur: "))`
— and lists every matching line of the current buffer in a freshly
created `*Occur: PATTERN*` buffer. Each result line is the source
line number (1-based, right-padded to the widest match's width) and
the matching line text. With zero matches the results buffer says
`(no matches)` and a `0 matches for "PATTERN":` header rather than
being empty. Matching is plain literal substring, no regex.

- The matching and formatting are pure Lisp helpers
  (`occur-matching-lines`, `occur-result-text`, `occur-buffer-name`),
  separated from the command body so they can be unit-tested without
  touching the host's buffer list.
- The command body captures the source's `(buffer-text)` *first*,
  then calls `new-buffer!` with the chosen name, then `insert!`s the
  result — the buffer-switch happens between the read and the write.
- A new `M-s` prefix keymap (`m-s-keymap`) was added to
  `keymap.lisp`, with `M-s o` bound to `occur`; no other entry was
  changed there.
- `STDLIB_FILES`: one append — `occur.lisp`, loaded after
  `line-ops.lisp` (it only needs `commands.lisp` and the base list
  primitives, which load earlier).

**Decisions / deviations.** None from the spec. The results buffer
is named `*Occur: <pattern>*` (the spec's second option) rather than
the bare `*Occur*` — it conveys what was searched for and reduces
the duplicate-buffer problem when the user runs `occur` more than
once with different patterns. (Same pattern twice will still create
a second results buffer; v1 acceptably, since `new-buffer!` does not
look up by name.)

**Tests.** `pnpm test` — all packages green, 0 failures (462 total;
stdlib 169, incl. 11 new covering: the pure
`occur-matching-lines`/`occur-result-text`/`occur-buffer-name`
helpers, the singular-vs-plural "match"/"matches" header, the
empty-result case, the `(command-registered?)` and `M-s o` binding,
the prefix-keymap behaviour mid-sequence, the end-to-end "creates a
new buffer and inserts the right text" flow, the no-matches
end-to-end case, and the cancelled-prompt case. `apps/desktop/`
untouched, so no smoke test run (per spec).

**Commits.**
- `b311f0e` feat: add occur command bound to M-s o
- (this log entry)

---

## Task C5 — `expand-region`  *(branch `agent-c5-expand-region`)*

**What was built.** A new `defcommand` `expand-region` (in a new file
`packages/stdlib/lisp/expand-region.lisp`) that grows the active
region one structural step on every press: word → line → paragraph →
whole buffer. Repeated presses keep growing; any other command in
between resets the chain so the next press starts again at the word
step around the current cursor position.

- The structural bounds are computed by pure Lisp helpers — `expand-
  region-word-bounds`, `-line-bounds`, `-paragraph-bounds`,
  `-buffer-bounds` — each taking only `(text, pos)` and returning a
  `(start . end)` pair (or nil for word, when the cursor sits between
  two non-word chars and there is no adjacent word). The dispatch
  picks the next step whose bounds are strictly larger than the
  current selection, so a paragraph that happens to coincide with the
  line is skipped rather than wasting a press.
- The chain is detected via `(eq? *last-command* 'expand-region)` —
  the same `*last-command*` mechanism `yank-pop` uses (C1). The first
  press in a chain records the original point as
  `*expand-region-anchor*`; every subsequent press in the chain
  computes its bounds around that same anchor, so growth is stable as
  the region's edges move.
- `keymap.lisp` (shared, permitted): bound `C-equal` — the host's
  normalisation of the spec's `C-=` keystroke (`event.code` is
  `"Equal"`, no fallback in `NAMED_CODES`, so it surfaces as
  `"C-equal"`, matching the existing `M-S-comma` / `M-S-period`
  convention for shifted punctuation). Comment in the keymap notes
  the spec name vs the bound key string.
- `STDLIB_FILES` (shared, permitted): one append —
  `expand-region.lisp`, loaded after `occur.lisp`. It uses
  `drop-leading-blanks` from `line-ops.lisp` (which loads earlier),
  so no helper was duplicated.

**Decisions / deviations.**

- **Key string `"C-equal"` for `C-=`.** The spec table writes the
  binding as `C-=`, but the renderer normalises Ctrl+= to
  `"C-equal"` (matching the established `M-S-comma` / `M-S-period`
  pattern for shifted punctuation). Bound to `"C-equal"`; the spec
  name is preserved in a comment. Not a deviation in intent, just in
  spelling — the assigned keystroke is what fires the command.
- **"Word" definition.** A word char is `[A-Za-z0-9_]`, derived in
  Lisp via `string-contains?` membership in a literal alphabet string
  (the Lisp has no char primitives). When the cursor sits *between* a
  word char and a non-word char, the adjacent word wins; between two
  non-word chars, the word step is skipped and the press takes the
  line directly. This matches the common Emacs-style behaviour.
- **Anchor across the chain.** Growth is computed around the original
  anchor, not around the current point or selection edges. After the
  first press point has moved to the word's end (because `set-mark!`
  + `goto!` places point at one extreme and mark at the other); a
  paragraph-step that read point would drift onto a different line in
  a multi-line region. The explicit anchor variable keeps the chain
  stable.
- **Selection construction.** Each step applies its bounds via
  `(clear-mark!) (goto! end) (set-mark! start)` — same pattern
  `mark-whole-buffer` uses, just with the explicit clear-mark up
  front so a `goto!` against an existing mark cannot accidentally
  extend through it.
- **Falling off the top.** Once at the whole-buffer step, further
  presses are no-ops (the selection stays as the whole buffer); the
  chain is still considered alive, so the next non-expand-region
  command followed by `C-=` will restart at the word step around the
  then-current cursor.

**Tests.** `pnpm test` — all packages green, 0 failures (475 total;
stdlib 182, incl. 13 new):

- the `command-registered?` and `C-equal` keymap binding;
- the three pure bound helpers — word at an interior offset, word
  preferring the just-prior word at an interword offset, word
  returning nil between non-word chars;
- line bounds (start-to-end of the cursor's line);
- paragraph bounds across blank-line boundaries (both halves of a
  two-paragraph buffer);
- the first press grabbing the current word;
- the four-step growth (word, line, paragraph, buffer) over a
  multi-paragraph buffer;
- the "skip a step that adds nothing" case on a one-line buffer;
- an intervening `right` command breaking the chain and restarting
  the growth around the new cursor position;
- the inter-word fall-through to the line;
- the empty-buffer no-op (selection stays null);
- anchor stability — second press still uses the original anchor
  even though point moved to the word end after the first press.

`apps/desktop/` untouched, so no smoke test run (per spec).

**Commits.**
- `ec75592` feat: add expand-region (C-=) — grow the selection structurally
- `39c4495` test: cover expand-region bounds, growth steps and chain reset
- (this log entry)

---

## T0 — language plug-in point — `agent-0-language-registry`

**Built.** A drop-in mechanism for adding a tree-sitter language to
the editor. Before this commit, adding a language touched four shared
files — `treesitter.js`, `app.js`, `highlight.js`, `STDLIB_FILES`.
After it, none of them. A language is three files dropped in:

- `packages/renderer/vendor/tree-sitter-<tag>.wasm` (the grammar);
- `packages/renderer/src/languages/<tag>.js` — calls `registerLanguage`
  with grammar filename, highlight query and file suffixes;
- `packages/stdlib/lisp/languages/<tag>.lisp` — `define-mode` +
  `register-mode` for the filename suffix.

The pieces.

- `packages/renderer/src/language-registry.js` — a small data registry.
  Exports `registerLanguage(spec)`, `registeredLanguages()`,
  `languageForFilename(name)`, `loadLanguageHighlighters(create,
  onError)`, `clearLanguages()`. Each language is a `{tag, grammar,
  query, suffixes}` record.
- `packages/renderer/src/languages/` — three migrated tree-sitter
  registrations (JavaScript, HTML, Python). The directory is the
  drop-in surface. A `README.md` is the "how to add a language" for
  the Track B agents.
- `packages/renderer/src/treesitter.js` — drops the three per-language
  exports (`createJavaScriptHighlighter`, `createHtmlHighlighter`,
  `createPythonHighlighter`) and exports a generic
  `createTreeSitterHighlighter(grammar, query)`. The file knows
  nothing about individual languages now.
- `packages/renderer/src/highlight.js` — `languageForName` consults
  the registry for tags it does not itself claim (the hand-tokenized
  Lisp / Markdown / LaTeX / Makefile still live there as built-ins,
  since they have no published tree-sitter grammar).
- `packages/stdlib/src/index.js` — `loadStdlib` takes an `options`
  arg with `listLanguageFiles`; after `STDLIB_FILES` finishes, every
  `.lisp` in `lisp/languages/` is loaded. Ordered core stays.
- `packages/stdlib/lisp/languages/` — `javascript.lisp`, `html.lisp`,
  `python.lisp` (mode + `register-mode`). The README mirrors the JS
  one for symmetry. The JS/HTML/Python `define-mode`s left
  `modes.lisp`; LaTeX/Makefile stay there (no tree-sitter).
- `apps/desktop/src/app.js` — the per-language entries in the
  highlighter-init loop are gone. Two discovery sweeps replace them:
  `discoverRendererLanguages()` (dynamic-imports every `.js` in
  `packages/renderer/src/languages/`) and
  `listStdlibLanguageFiles()` (fed to `loadStdlib`). Both use the
  new `app://` directory-listing endpoint.
- `apps/desktop/src/serve.js` — a `?list` query on a URL ending in
  `/` returns a JSON array of the directory's filenames. One-time
  facility, not per-language.

**Decisions / deviations.**

- *Directory listing on `app://`.* The renderer has no bundler and
  no `import.meta.glob`, so discovery needs a runtime list. The
  cleanest option was extending `serve.js` with a `?list` endpoint
  rather than baking in a manifest file. A manifest would re-introduce
  a shared edit; the endpoint is permanent and language-agnostic.
- *Three discovery routes.* For the desktop app, `app://?list` +
  dynamic import. For the stdlib test, `readdir` on disk. For the
  renderer unit test, static imports of the three language modules.
  All three converge on the same registry singleton.
- *Migrated languages kept their line-tokenizer fallback.*
  `tokenizeJavaScript`, `tokenizeHtml`, `tokenizePython` stay in
  `highlight.js`. The tree-sitter highlighter overrides them when
  the grammar loads (the normal case); the tokenizer is the fallback.
  A *new* language need not provide one — without it the buffer is
  shown plain when the grammar is missing. Acceptable for v0.
- *Default `loadStdlib` behaviour unchanged.* `listLanguageFiles` is
  optional. Callers that don't pass it (no current caller) load only
  the ordered core, exactly as before.
- *No new keybinding.* T0 binds nothing; the plan's allocation table
  has no row for it.

**Tests.** `pnpm test` — 472 tests, 0 failures.

| Package | Tests | New |
|---------|-------|-----|
| `apps/desktop` | 11 | 0 |
| `packages/storage` | 47 | 0 |
| `packages/lisp` | 68 | 0 |
| `packages/buffer` | 35 | 0 |
| `packages/renderer` | 129 | +8 (language registry) |
| `packages/stdlib` | 182 | 0 |

The eight new `language-registry.test.js` tests cover: spec storage
and read-back; suffix lookup (positive and non-string); validation
errors (missing tag / grammar / query / suffixes); replacement on
re-register; `clearLanguages` empties; the `create` factory is called
once per language; per-language failures are reported and do not
break the rest.

**Smoke.** `pnpm --filter @editor/desktop smoke` — PASS. The
`treesitter:` line reports `{"langs":"html,javascript,python",
"keywords":1,"numbers":1,"pyFunctions":2,"htmlTags":2}` — all three
migrated languages loaded via discovery and highlighted their sample
buffers exactly as before. (Order changed from `javascript,html,
python` to alphabetic by directory listing; the smoke uses
`.includes` so this is fine.)

**Acceptance check.** No edit to `packages/renderer/src/treesitter.js`,
`apps/desktop/src/app.js`, `packages/renderer/src/highlight.js`, or
`packages/stdlib/src/index.js` is needed to add a new language. The
three migrated languages still highlight; all 472 unit tests and the
smoke test pass. Removing one of `javascript.js` / `html.js` /
`python.js` from the languages directory (plus its `.lisp`) removes
the language entirely.

**Commits.**
- `1d95f35` feat(renderer): add a language registry for tree-sitter
  languages
- `c5f10a3` feat(stdlib): auto-load lisp/languages/ after the ordered
  core
- `5d05410` feat(desktop): discover languages at startup, drop
  hard-coded list
- (this log entry)

---
