# HANDOVER

A snapshot for resuming work on **jmacs** in a fresh session. Read
`CLAUDE.md` first — it carries the standing working agreements (branching,
commits, testing discipline, territory). This file is the where-things-stand
notes that don't belong in the code or in `CLAUDE.md`.

## The project in brief

jmacs is a Lisp-extensible editor with an Electron presentation layer — a
successor in spirit to Emacs, on a clean foundation. Vanilla ES2022 modules,
a pnpm workspace, no bundler, no TypeScript. Tests use the Node built-in test
runner. The architect is Jason; he works in vanilla JavaScript.

The five layers (see `docs/ARCHITECTURE.md`):

- **L0 host** — `apps/desktop/` — the Electron app.
- **L1 storage** — `packages/storage/` — the text store.
- **L2 buffer** — `packages/buffer/` — text + point/mark + edits.
- **L3 lisp** — `packages/lisp/` — the custom Lisp (reader, evaluator, macros).
- **L4 renderer** — `packages/renderer/` — projects buffer state into the DOM.
- **stdlib** — `packages/stdlib/` — the Lisp standard library; the editor's
  behaviour lives here, not in host code.

The editor's keymap, commands and modes are all defined in Lisp
(`packages/stdlib/lisp/`). Host code is plumbing.

## Status: green

- **313 unit tests pass** — storage 47, lisp 68, buffer 35, renderer 75,
  stdlib 88.
- The **end-to-end smoke test passes**.
- All work is committed to `main`, which is the only branch. The commits are
  **local — not pushed** to any remote.
- `git status` shows `.claude/settings.json` modified. That is pre-existing
  and not ours — **leave it alone**, never stage it.

## Run & test

```
pnpm test                            # all unit tests (from the repo root)
pnpm --filter @editor/desktop smoke   # end-to-end smoke test
pnpm --filter @editor/desktop dev     # launch the editor
pnpm --filter @editor/desktop screenshot [out.png]   # capture a PNG
```

Run the smoke test **on its own** — it is flaky when it competes with
`pnpm test` for resources. The pre-commit hook runs the unit suite and
refuses commits to `main`.

## What this session built

Most recent first; all merged to `main`:

- **Double-click fix** — double-click word selection was unreliable and slow.
  Two causes, both fixed: `caretRangeFromPoint` hit-testing was slow through
  the splash SVG (now uses pure monospace-grid geometry); and `click`/
  `dblclick` never fired because a render between mousedown and mouseup
  detaches the line element (double-click is now read from the mousedown's
  `event.detail` click count).
- **Replaced Electron's default menu** (`apps/desktop/src/menu.js`) — the
  default menu bound ⌘R to a full page reload, which would discard the
  session. The new menu omits Reload.
- **Startup splash** (`apps/desktop/src/splash.js`) — the editor's own
  `handle-key` Lisp, syntax-highlighted and tilted into the distance, drawn
  into the view's background layer behind the welcome text. Fades out on the
  first edit or buffer switch.
- **Background & overlay layers** — the editor view gained `backgroundLayer`
  (behind the text) and `overlayLayer` (in front), exposed on the EditorView
  object. They are empty hooks for the host to fill.
- **Tree-sitter for HTML and Python** — grammars vendored as WASM in
  `packages/renderer/vendor/`; `treesitter.js` generalised to load any
  grammar. JavaScript already used tree-sitter.
- **HTML / LaTeX / Python / Makefile modes** — line-based tokenizers in
  `highlight.js`, major modes in `modes.lisp`, suffix registry entries.
- **Mariana theme** — the editor adopts Sublime Text's default dark scheme;
  the JS tree-sitter query gained function/type captures.
- **`C-x C-c` quit**, **Emacs-style mark/region** (`C-SPC`; movement extends
  the region while the mark is set), **double-click word selection**.

Earlier in the session (now part of the baseline): the mode system (major/
minor modes, hooks, suffix registry — `docs/spec/modes.md`), markdown mode +
a toggleable math-symbol minor mode, view virtualisation, mouse support,
GPL-3.0 licensing, JetBrains Mono with ligatures.

## Architecture map — where things live

- `apps/desktop/src/app.js` — the renderer entry. Large: buffer primitives,
  the buffer list, the modeline, highlighter loading, the splash, the
  `WELCOME` text, the `M-x`/search/file command wiring.
- `apps/desktop/src/main.js` — Electron main process: window, `app://`
  protocol, file IPC, quit IPC, menu install.
- `apps/desktop/src/{menu,splash,files,serve}.js`, `preload.mjs` — host
  pieces. `preload.mjs` exposes the `window.host` bridge.
- `apps/desktop/scripts/smoke.js` — the end-to-end smoke test. `screenshot.js`
  — a screenshot tool.
- `apps/desktop/styles.css` — all CSS (Mariana palette, layers, splash).
- `packages/renderer/src/view.js` — the editor view: rendering,
  virtualisation, mouse, keys, the layer stack.
- `packages/renderer/src/treesitter.js` — tree-sitter highlighters (JS, HTML,
  Python). `highlight.js` — line tokenizers (Lisp, markdown, HTML, LaTeX,
  Python, Makefile) + `languageForName`.
- `packages/renderer/src/{keymap,minibuffer,runs,brackets,fuzzy,commands}.js`.
- `packages/renderer/vendor/` — tree-sitter WASM (runtime + 3 grammars).
- `packages/stdlib/lisp/*.lisp` — `keymap.lisp` (bindings + `handle-key`
  dispatch), `editing.lisp`, `modes.lisp`, `markdown.lisp`, `palette.lisp`,
  `system.lisp`.
- `packages/stdlib/src/buffer-primitives.js` — the JS↔Lisp buffer bridge.
- `packages/buffer/src/buffer.js` — L2 buffer: point, mark, `moveTo`, edits.

## Known limitations & gotchas

- **The view recreates `.editor-line` DOM nodes on every render.** A browser
  event that depends on DOM identity across a render — `click`, `dblclick` —
  will not survive a render between mousedown and mouseup. Double-click was
  reworked around this; any future DOM-event-based feature must account for it.
- **Key strings**: `C-` is Control *or* Command, `M-` is Option (Alt). So
  `M-x` is **Option+X**. Modified keys resolve through `event.code`, so they
  survive macOS Option-compose (Option+X yields `≈` in `event.key`).
- **Editor keybindings only fire when the `.editor` surface has focus** — not
  when the REPL or minibuffer input is focused. Flagged but not fixed; see
  next steps.
- **LaTeX and Makefile use line-based tokenizers** — multi-line constructs
  highlight only their first line. LaTeX genuinely cannot have a tree-sitter
  grammar (TeX is Turing-complete at read time — confirmed by the architect).
- The four new modes (HTML/LaTeX/Python/Makefile) carry **no mode-specific
  keymaps** (unlike `markdown-mode`'s `C-c` map). HTML has no line comment, so
  its `comment-prefix` falls back to `;; `.
- **Mark model**: once the mark is set (`C-SPC` or a shift-select), the region
  is "sticky" — movement keeps extending it until `C-g`. Slightly less nuanced
  than Emacs's transient-mark distinction; intentional for v1.
- The `backgroundLayer`/`overlayLayer` are empty containers — there is **no
  Lisp API** to populate them yet.
- Seeding multi-line text through the REPL `<input>` strips newlines — a test-
  harness gotcha (it bit screenshot scripts), not an editor bug.
- The dev environment's TLS proxy can fail certificate validation on external
  `https`; do **not** work around it by disabling TLS verification.

## Open threads / suggested next steps

- **Document-level key handling** — make editor commands (`M-x` etc.) work
  whenever a text input is not focused, not only when `.editor` is. The plan:
  move the keydown listener to `document` and bail when `event.target` is an
  `<input>`/`<textarea>`. Offered to Jason; awaiting a go-ahead.
- **A Lisp API for the background/overlay layers** — so modes/commands can put
  images or annotations into them. The layers exist; nothing fills them.
- **Mode-specific keymaps** for the new languages.
- **Mode system Phase 4** (`docs/spec/modes.md`) — mode-driven highlighting,
  mode-local variables, content-based detection.
- **LSP integration** — `packages/lsp/` is the planned territory (week 4+).
- Whole-file tokenizers for LaTeX/Makefile, if multi-line highlighting matters.
- The commits are local; **push to a remote** when Jason wants them published.

## Working style (see CLAUDE.md for the full text)

- **Never commit to `main` directly.** Branch (`agent-N-description`), commit
  with Conventional Commits, `merge --ff-only` back, delete the branch. Every
  commit must pass tests.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- Stay within package territory; if a task needs another package, write to
  `architect-notes.md` rather than reaching across.
- When something needs Jason's judgement, stop cleanly and write to
  `architect-notes.md` — don't guess.
