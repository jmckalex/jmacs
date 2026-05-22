# Overnight parallel build — night of 2026-05-22

A massively-parallel build night: ~18 sub-agents, each a self-contained
slice. The goal is to convert the first impression from "a nice toy
app" to "this might be something" — by adding **breadth** (languages),
**depth** (editing niceties a real editor has), and the
**differentiators** (things a terminal editor structurally cannot do,
which jmacs can because it is a browser).

## How tonight works

**Dispatch order.**

1. Spawn **T0** and all of **Track A**, **Track C**, **Track D** at
   once — they do not depend on each other.
2. When **T0** is merged to `main`, spawn **Track B** (the language
   agents branch from the T0-updated `main`).
3. Run the **integration pass** last, once the feature agents are done.

**Conflict strategy — and why this scaffolding is temporary.** We are
not yet on git worktrees, so several agents would otherwise collide in
the hot shared files (`app.js`, `keymap.lisp`, `STDLIB_FILES`,
`treesitter.js`, `highlight.js`, `smoke.js`). Tonight's defences:

- T0 makes the language track genuinely conflict-free (a drop-in
  registration mechanism).
- Every other agent keeps its new code in **its own new files**, and
  touches shared files only as its spec permits.
- Every keybinding is **pre-assigned** (table below).
- Agents do **not** merge to `main` — a single integration pass does.

Retooling the dev environment for **worktrees** (planned for tomorrow)
will give each agent a genuinely isolated working copy and make most of
this scaffolding unnecessary. Tonight it is needed; treat it as a
stopgap.

## Rules for every agent

- Work on a branch named exactly as the task spec gives
  (`agent-<id>-<slug>`). **Never commit to `main`.**
- **Territory.** You own the *new files* your spec lists. You may touch
  the *shared files* your spec explicitly names, and no others. If you
  need a change outside your territory, **stop** and write to
  `architect-notes.md` — do not reach into another agent's area.
- **Keys.** Use only the keybinding(s) pre-assigned to your task. If an
  assigned key is already bound, **stop and note it** — do not pick
  another.
- **Tests.** Every new public function gets a test. `pnpm test` must be
  green before every commit. If you changed anything under
  `apps/desktop/`, run the smoke test too.
- **Commits.** Small, conventional-commit messages, imperative mood.
  End each with the `Co-Authored-By: Claude Opus 4.7 (1M context)`
  trailer. **Never** `git add -A` — stage named files only. **Never**
  stage `.claude/settings.json`; never commit rendered artifacts
  (`docs/**/*.html`).
- **Do not merge to `main`.** Leave your branch committed and green.
  Append an `architect-notes.md` entry: what you built, exactly what
  shared-registry wiring the integration pass must apply, and anything
  you stopped on.
- **Stop and write a note** (don't guess) when: the spec is ambiguous
  on something that changes the implementation; you hit a design fork;
  an asset (a tree-sitter grammar) cannot be obtained; the same fix has
  failed three times; or the task is pulling you outside its scope.

## Keybinding allocations

| Task | Command | Key |
|------|---------|-----|
| C1 | `yank-pop` | `M-y` |
| C2 | `move-line-up` / `move-line-down` | `M-Up` / `M-Down` |
| C2 | `duplicate-line` | `C-x C-d` |
| C2 | `join-line` | `C-x C-j` |
| C4 | `occur` | `M-s o` |
| C5 | `expand-region` | `C-=` |
| A2 | `markdown-preview` (in `markdown-mode-map`) | `C-c v` |

Tasks not listed bind no keys (reached by `M-x`, the mouse, or a file
suffix). Every command is a `defcommand`; every setting a `defcustom`.

---

## T0 — the language plug-in point  *(serial prep; gates Track B)*

**Branch** `agent-0-language-registry`. **Depends on** nothing; must
merge before Track B.

Adding a tree-sitter language today means editing `treesitter.js`,
`app.js`, `highlight.js` and `index.js` — four shared files, a conflict
magnet. Build a registration mechanism so a language is a **drop-in**.

- A `packages/stdlib/lisp/languages/` directory, auto-loaded by
  `loadStdlib` *after* the ordered core list (languages are mutually
  independent — load order among them does not matter). `STDLIB_FILES`
  keeps its ordered core; the languages directory is globbed onto the
  end.
- A JS-side language registry so a grammar + highlighter + file-suffix
  is contributed by a manifest or self-registration — no edit to
  `treesitter.js` / `app.js` / `highlight.js` per language.
- Migrate the three existing tree-sitter languages (JavaScript, HTML,
  Python) onto the mechanism, as the proof.
- A short `packages/stdlib/lisp/languages/README` (or a header comment)
  — "how to add a language" — for the Track B agents to follow.

**Acceptance:** a new language can be added by dropping in a grammar
asset, a highlighter registration, and a `languages/<name>.lisp` mode
file — with **no** edit to `treesitter.js`, `app.js`, `highlight.js`,
or `index.js`. All existing tests and the smoke test still pass.

---

## Track A — Differentiators *(start immediately; the "wow")*

### A1 — image buffers
**Branch** `agent-a1-image-buffers`.
Open an image file (`.png`, `.jpg`, `.gif`, `.svg`, `.webp`) and *see
it*. Reuse the buffer-kind / view-kind mechanism (a customisation
buffer is the precedent): a new `image` buffer kind with a small view
that displays the image, fit-to-window with a zoom-to-actual-size
toggle. **New files:** `packages/renderer/src/image-view.js` (model on
`customize.js`). **Shared files you may touch:** `apps/desktop/src/
app.js` (register the `image` kind; route image suffixes when opening a
file), `apps/desktop/src/files.js` (read an image as a data URL),
`apps/desktop/styles.css`, `packages/renderer/src/index.js`.
**Accept:** opening an image shows it; a smoke check.

### A2 — live Markdown preview
**Branch** `agent-a2-markdown-preview`.
A toggleable preview **pane** (model the show/hide on the REPL panel,
`#repl-host`) that renders the current `markdown-mode` buffer to HTML
via the existing JMarkdown pipeline (`host.renderJMarkdown`), refreshing
on edit (debounced). Bound to `C-c v` in `markdown-mode-map` and a
`markdown-preview` `defcommand`. **New files:** a preview-pane component
in `packages/renderer/src/`. **Shared files:** `app.js`, `index.html`,
`styles.css`, `markdown.lisp` (the keybinding). **Accept:** editing a
`.md` buffer updates the preview; a smoke check.

### A3 — clickable colour swatches
**Branch** `agent-a3-colour-swatches`.
Beside every colour literal in code (`#rgb`, `#rrggbb`, `#rrggbbaa`,
`rgb(...)`, `rgba(...)`), render an inline **swatch**. Clicking the
swatch opens a **modal colour chooser**; on OK, the chosen colour is
written back into the buffer, *replacing the literal's text*. (This is
the explicitly-requested behaviour — helpful, cool, and definitely not
Emacs.) **New files:** a swatch/decorator module and a colour-picker
modal in `packages/renderer/src/`. **Shared files:** `view.js` (to
decorate colour literals in rendered lines), `styles.css`,
`index.js`. Detecting the literals is a pure, unit-tested function.
**Accept:** swatches appear; clicking one and confirming edits the
buffer text; pure-function tests + a smoke check.

---

## Track B — Language breadth *(spawn after T0 merges)*

Each: **one agent, one language.** Follow T0's "how to add a language"
note and the migrated JavaScript/HTML/Python languages as the template.
Vendor the tree-sitter grammar (`.wasm`) and its highlight query,
register the highlighter, add `languages/<name>.lisp` (the mode and the
file-suffix → language mapping). If the grammar cannot be obtained,
**stop and note it** — do not improvise a hand-written tokenizer.
**Accept per language:** the suffix opens in the new mode and
highlights; a tests/smoke check.

| Task | Language | Branch | Suffixes |
|------|----------|--------|----------|
| B1 | JSON | `agent-b1-lang-json` | `.json` |
| B2 | CSS | `agent-b2-lang-css` | `.css` |
| B3 | TypeScript | `agent-b3-lang-typescript` | `.ts` |
| B4 | Rust | `agent-b4-lang-rust` | `.rs` |
| B5 | Go | `agent-b5-lang-go` | `.go` |
| B6 | Bash | `agent-b6-lang-bash` | `.sh`, `.bash` |

---

## Track C — Editing depth *(start immediately; Emacs parity)*

Each is a `defcommand`, mostly stdlib Lisp; put the command(s) in a new
`packages/stdlib/lisp/<feature>.lisp`. **Shared files you may touch:**
`keymap.lisp` (your pre-assigned key only), `STDLIB_FILES` (one
append), and `apps/desktop/src/app.js` only if you genuinely need a new
primitive (prefer doing it in Lisp). **Accept per task:** stdlib unit
tests; a smoke check if the app changed.

- **C1 — `yank-pop` / kill-ring browsing** (`agent-c1-yank-pop`). After
  a `yank`, `M-y` replaces it with the previous kill, cycling. The
  kill-ring already exists in `kill.lisp`.
- **C2 — line operations** (`agent-c2-line-ops`). `move-line-up` /
  `move-line-down` (`M-Up` / `M-Down`), `duplicate-line` (`C-x C-d`),
  `join-line` (`C-x C-j`).
- **C3 — auto-pairing** (`agent-c3-auto-pair`). Typing `(`, `[`, `{`,
  `"`, `` ` `` inserts the closing partner; the close key over an
  existing close steps past it; backspace between an empty pair deletes
  both. A `defcustom` toggles it. This touches key handling — keep the
  logic in Lisp; stop and note if it needs a host change.
- **C4 — `occur`** (`agent-c4-occur`). Prompt for a pattern
  (`(interactive (string …))`), list every matching line of the buffer
  in a results buffer; `M-s o`.
- **C5 — `expand-region`** (`agent-c5-expand-region`). `C-=` grows the
  selection structurally — word, then line, then paragraph/buffer;
  repeated presses keep growing.

---

## Track D — Polish *(start immediately)*

- **D1 — theme system** (`agent-d1-themes`). A `theme` `defcustom`
  (`:choice`) that swaps the editor's CSS custom properties; ship the
  current theme plus two more (e.g. a light theme and a second dark).
  **New files:** theme CSS / data. **Shared:** `styles.css` (lift the
  palette to swappable variables), a small `themes.lisp`, `app.js` (the
  `:on-change` applying the theme).
- **D2 — mode-specific keymaps** (`agent-d2-mode-keymaps`). Give the
  HTML, LaTeX, Python and Makefile modes their own mode keymaps with a
  few apt commands each, the way `markdown-mode-map` works.
- **D3 — multi-line highlighting** (`agent-d3-multiline-highlight`).
  Whole-file tokenizers for LaTeX and Makefile so multi-line constructs
  highlight past their first line. **Shared:** `highlight.js`.

---

## Integration pass *(last)*

**Branch** `agent-integration`. After the feature agents are done:
merge their branches into `main` one at a time, in the order T0 (done)
→ A → C → D → B. After each merge run `pnpm test` and, for app-touching
branches, the smoke test. Most branches will merge cleanly; the few
shared-file conflicts (`app.js`, `keymap.lisp`, `STDLIB_FILES`,
`highlight.js`) will be trivial append-only resolutions — **keep both
sides**. If any conflict is *not* trivial, stop that merge and record
it precisely in `architect-notes.md` for the architect to resolve.
Finish with a summary: what merged, what is parked, the final test and
smoke results.

## Notes

- Every feature uses the infrastructure that just shipped — `defcommand`
  with interactive specs, `defcustom` for settings. This is deliberate
  dogfooding.
- If a track runs short on time, the language and polish tracks are the
  most droppable; Track A (the differentiators) is the point of the
  night and should land.
