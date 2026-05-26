# Architect Notes

Notes from autonomous sessions for Jason to review. Newest at the top.
Nothing here is blocking — these are decisions made under the "build a
running app" brief that touch standing commitments or span territories,
flagged so the standing instructions can be updated if you disagree.

---

## [2026-05-25 → 2026-05-26 overnight] Audio metadata edit + two older branches

The full `plans/AUDIO-METADATA-EDIT.md` sequence landed end-to-end:

- `agent-audio-edit-ui` — inline-edit UI for the audio view (double-
  click a value to edit, red minus button per editable row, dashed
  plus pill below for new tags). Failures revert the UI and minibuffer
  the error. Two new methods on the view (`pauseAndRelease`,
  `resumeFrom`) for the writer's atomic temp-file + rename.
- `agent-audio-edit-id3v2` — ID3v2.4 writer for `.mp3`. Atomic write
  + cover preservation + symmetric round-trip tests + real Lisp
  primitives (`set-audio-metadata!`, `remove-audio-metadata!`).
- `agent-audio-edit-mp4` — MP4 / M4A serialiser. Parses atom tree,
  rebuilds `ilst`, patches `stco`/`co64` chunk offsets by the moov
  size delta, handles slow-start and fast-start layouts, preserves
  cover art and mdat byte-for-byte. The Jesus Jones `.m4a` is now
  editable.
- `agent-audio-edit-ogg` — Ogg Vorbis serialiser. Rebuilds comment
  packet, recomputes page CRCs (Ogg's documented polynomial 0x04C11DB7
  unreflected), patches audio page sequence numbers if the new header
  count drifts from the original.

All four merged via `--no-ff`. 13 + 13 + 12 = 38 new round-trip tests
across `apps/desktop/test/audio-metadata-write.test.js`; smoke arm
re-reads the seeded MP3 after the edit lifecycle and asserts disk
state. Full suite green at the end: 130 desktop, 35 buffer, 228
renderer, 278 stdlib, 68 lisp.

Two extra older branches landed cleanly:

- `agent-latex` — single conflict in `smoke.js`'s treesitterOk that
  was straightforward additive (HEAD's faceInfoOk + branch's tex*
  assertions).
- `agent-folding` — the `loadLanguageHighlighters` return-shape
  change the prior handover called out. Reconciled to keep both:
  the exposed callable retains `captures` + `nodeAtPoint` properties
  AND the registry returns `{ highlighters, foldCaptures }`.
  `stdlib.test.js`'s test fixture gained a `foldCalls` channel
  alongside the existing `tsCalls`. Test failures during the merge
  flagged an unresolved conflict marker in `language-registry.js`
  the auto-merge had silently left (Git "Auto-merging" reported
  but the markers were still in the file). Fixed by hand.

Skipped, with notes:

- `agent-regex-search` — ~230 lines of test conflicts in
  `stdlib.test.js` that interleave face-info tests (HEAD) with
  regex tests (branch) plus a trailing `});` that both sides
  share. Resolution is "keep both" but the diff layout made
  surgical reconstruction risky without judgement on test order
  and naming. **Quick path for you:** the regex tests are
  preserved on the branch; you can either rebase the branch onto
  current main (the only conflict is the test file) or apply the
  branch's test additions as a fresh commit.
- `agent-session` — 12 conflicts across `app.js`, `files.js`,
  `preload.mjs`, `smoke.js`. Each individual conflict is additive
  (new IPC handler / new preload entry / new smoke arm) but the
  surface across four files is substantial. Skipped to keep the
  overnight session bounded.
- `agent-reactive-notebook` — the jukebox smoke arm has been
  rewritten between when this branch was forked and now (HEAD has
  `jukebox.visible / .hasAudio / .embeddedArtShown`, the branch has
  `jukebox.major / .body / .afterShuffle`). Resolving means
  porting the notebook smoke arm onto the new jukebox shape, which
  needs judgement about what's still relevant.
- `agent-multi-cursor` — still needs the `hash-set` → `assoc` fix
  before it can load. Untouched.
- `agent-lsp`, `agent-chord-find-file`, `agent-file-nav` — binding
  displacements (K, C-x C-f, C-x p). Taste calls; left for you.

The four asked-for-but-not-started items from the prior handover
(splits plan-doc, directory tree-view, Finder-style column view)
weren't started — you asked tonight whether the directory views
might be a better overnight target, then said to stay with the
MP4/Ogg writers. Worth confirming you still want those next.

**Test of the audio metadata feature**: open a real `.m4a` (the
Jesus Jones file from your earlier screenshot), double-click
"Artist", change it, press Enter. The file should be edited on
disk. Verify by re-opening or running `(audio-metadata "path")`
from the REPL. Cover art should survive an edit. The minus button
removes a tag; the plus pill adds one. On failure (read-only file,
etc.) the UI reverts and the REPL gets the error message.

---

## [2026-05-22 overnight, continued] Goto-line, replace, more

You asked me to keep building without greenlighting each step. Six more
features after the ten below, same discipline (branch, test, smoke,
merge):

- **goto-line** (`M-g`).
- **Bracket matching skips strings and comments** — closes the v0
  limitation flagged earlier; a whole-buffer non-code mask.
- **Comment toggling** (`C-x ;`), language-aware.
- **Backward incremental search** (`C-r`); `C-s`/`C-r` flip direction
  mid-search.
- **replace-string** (`M-r`) — a chained two-prompt minibuffer flow.
- **transpose-chars** (`C-t`) and a live OS window title.

Every suite green — storage 47, buffer 31, lisp 67, renderer 63,
stdlib 50 (258 total); the smoke test covers the whole stack.

The editor now has a genuinely complete editing surface: Emacs-style
motion and editing, kill ring, search (both directions) and replace,
multiple buffers, a command palette, a help system, syntax
highlighting, and its keymap/commands in hot-reloadable Lisp.

---

## [2026-05-21 overnight] Tree-sitter, kill ring, words, gutter, help, more

**Context**: You went to sleep asking for "an amazing app" by morning.
Ten features built overnight, each on its own branch, each merged to
`main` only with all tests and the Electron smoke test green.

**What's new**:

1. **Tree-sitter for JavaScript** — `web-tree-sitter` + the prebuilt
   `tree-sitter-javascript` grammar. The Lisp dialect keeps its
   tokenizer (per your call — it has no grammar and is still moving).
2. **Keymap hardening** — modified keys normalise via `event.code`, so
   `M-x` survives Option-compose on macOS (the bug I had flagged).
3. **Kill ring** — `C-w` / `M-w` / `C-k` / `C-y`.
4. **Word movement** — `M-f` / `M-b` / `M-d` / `M-⌫`.
5. **Line-number gutter + current-line highlight**.
6. **Buffer switcher** — `C-x b` with fuzzy completion.
7. **Help system** — `C-h k` describes a key, `C-h f` a command,
   drawing on the self-documentation.
8. **Emacs movement keys** — `C-f/b/n/p/a/e/d`, `C-g` keyboard-quit.
9. **Matching-bracket highlight**.
10. **Auto-indent on newline** (copies the line's indentation) and
    select-all (`C-x h`).

**Decisions / things to know**:

- **Vendored WASM.** `web-tree-sitter.js` and two `.wasm` files are
  committed in `packages/renderer/vendor/` (~750 KB). The editor has no
  bundler; this keeps it self-contained. devDependencies record the
  source packages.
- **pnpm `allowBuilds`.** `tree-sitter-javascript`'s native build is
  disabled in `pnpm-workspace.yaml` — the editor uses its prebuilt
  WASM, not the Node binding.
- **CSP** now allows `wasm-unsafe-eval` (needed to compile WebAssembly).
- **Known v0 limitations**: bracket matching and the Lisp tokenizer do
  not skip strings/comments; tree-sitter highlighting is recomputed per
  render (fine at current buffer sizes; virtualisation is still
  pending). All noted in code and `docs/spec/lisp.md` where relevant.

**Process note**: a third time I began editing on `main` before
cutting the branch (after a prior merge). The pre-commit hook blocked
it; I branched and nothing landed on `main` directly. Still worth a
guard — perhaps a hook that warns on un-committed edits to a clean
`main`, or just my discipline.

**State of the work**: `main` only; every suite green — storage 47,
buffer 31, lisp 66, renderer 59, stdlib 43 (246 total) — and the smoke
test exercises the whole stack. All feature branches merged.

---

## [2026-05-21] Multiple buffers, search, command palette, syntax highlighting

**Context**: You asked for all four, "press ahead, no questions." All
built, tested and merged.

**Multiple buffers**: a buffer list with a current index; the buffer
primitives operate through a `session.current` indirection; the view
gained `setBuffer`. `C-x b` / `C-x p` cycle, `C-x n` makes a new one,
`find-file` now opens into a new buffer. A second buffer, `scratch.lisp`,
is seeded. **Not built**: a buffer-list UI or select-by-name (cycling
only).

**Minibuffer + search**: a reusable minibuffer component; `C-s` runs an
incremental forward search (repeated `C-s` advances). The interactive
search loop is host JavaScript — the Lisp keymap only starts it.

**Command palette**: `M-x` opens the minibuffer, a fuzzy matcher ranks
command names collected from the keymap, the top match runs on Enter.
**Caveat**: `M-x` relies on `event.key` being `x` with Alt held; on
macOS, Option composes characters, so `M-x` may not register depending
on keyboard settings. A more robust key-normalisation (using
`event.code` for modified keys) is worth doing. No completion dropdown —
matches show in the minibuffer status line.

**Syntax highlighting — deviates from architecture commitment #4
(tree-sitter).** I used hand-written tokenizers for the Lisp dialect
and JavaScript instead. Reasons: (1) the editor's Lisp is a *custom*
dialect — there is no tree-sitter grammar for it, and writing/compiling
one to WASM is itself a project; (2) a tokenizer is reliable and
dependency-free. The architecture explicitly allows the renderer's
internals to be revised, and tree-sitter can replace this behind the
same run interface later. Limitation: highlighting is line-independent,
so a string or block comment spanning lines highlights only its first
line. If you want tree-sitter sooner (e.g. for JS), say so.

**Territory**: branches `agent-9-buffers`, `agent-10-search`,
`agent-11-palette`, `agent-12-highlight`, all merged to `main`.

**State of the work**: all suites green — storage 47, buffer 31,
lisp 66, renderer 46, stdlib 23 (213 total) — and the Electron smoke
test exercises rendering, the keymap, sequences, modules, buffers,
highlighting, search, M-x, the REPL and file I/O.

---

## [2026-05-21] File open/save, key sequences, module system + hot reload

**Context**: You asked for these three, in this order. All built and
merged.

**File open/save**: filesystem access lives in the Electron main
process (`files.js`), reached over IPC through a `preload.mjs` context
bridge (`window.host`). L2 gained `setText` to load content; the
modeline shows a `●` dirty marker. **v0 is single-buffer** — opening a
file replaces the current buffer's contents. Multiple buffers (a buffer
list, `C-x b`) are a deliberate next step, not built.

**Key sequences**: a keymap entry can be a nested keymap. Dispatch
tracks an active keymap; a prefix key switches to its sub-map.
`C-x C-f` / `C-x C-s` / `C-x C-r` work. No prefix-timeout or minibuffer
echo yet.

**Module system + hot reload**: `module` / `import` / `export`, with a
base-vs-global environment split for namespace isolation (modules are
siblings of the global env under a shared base). Hot reload works by
reusing a module's environment on re-evaluation; `reload-stdlib`
(`C-x C-r`) re-evaluates the editor's own Lisp live. One honest
limitation, documented in `docs/spec/lisp.md §6`: an importer holds a
snapshot, so a redefined *export* needs re-importing — a redefined
private helper updates immediately.

**Process note**: twice this session I started editing on `main` before
cutting the feature branch (after a prior merge left me on `main`). I
caught it before committing each time and branched first, so nothing
landed on `main` directly — but flagging the slip.

**State of the work**: branches `agent-6-files`, `agent-7-keyseq`,
`agent-8-modules`, all merged to `main`. Every suite green (storage 47,
buffer 31, lisp 66, renderer 30, stdlib 17 — 191 total) and the
Electron smoke test passing.

---

## [2026-05-21] Lisp standard library + Lisp-defined keymap

**Context**: You chose "Lisp stdlib + keymap" as the next direction.
The editor's commands and keybindings now live in Lisp, not in
hardcoded JavaScript.

**What's built**: new package `@editor/stdlib` — `editing.lisp`
(commands), `keymap.lisp` (bindings + `handle-key` dispatch), and the
`buffer-primitives.js` bridge. The renderer's `createEditorView` now
takes an `onKey` dispatcher; the app routes every keystroke through
`(handle-key …)`. Two host-integration additions to L3:
`interpreter.call` and an `eval` primitive.

**Design decision worth noting**: keymaps bind command **names**
(symbols), resolved late on each keystroke via `eval`, not command
*procedures*. A test ("redefining a command changes the editor")
caught the procedure-binding version — it didn't pick up redefinitions.
Late name resolution is both correct (it is how Emacs keymaps work) and
the groundwork for hot reload. No question for you here — the test
settled it — but flagging the choice since it touches the module/
hot-reload design sketched in `docs/spec/lisp.md §6`.

**Still a v0 floor**: single-chord keys only (no `C-x C-f` sequences),
no command palette / `M-x`, no command registry with metadata. Those
are the natural next stdlib steps.

**Territory note**: spanned `packages/stdlib` (new), `packages/lisp`,
`packages/renderer` and `apps/desktop` on branch `agent-5-stdlib`,
under the direct live brief.

**State of the work**: Branch `agent-5-stdlib`, all committed, every
suite green (storage 47, buffer 29, lisp 57, renderer 30, stdlib 12 —
175 total) and the Electron smoke test passing.

---

## [2026-05-21] L3 Lisp runtime + in-editor REPL

**Context**: Brief was "next step, ambitiously." Built the L3 Lisp
layer and a live REPL panel in the editor.

**Decisions you made this session** (asked and answered live):

1. **Procedural `defmacro`, not hygienic `syntax-case`.** A macro is a
   function from forms to a form. The spec's `syntax-case` target is
   recorded as Planned in `docs/spec/lisp.md §5`; the upgrade is cheap
   while no macro-heavy stdlib exists. Macro authors must `gensym`
   introduced names until hygiene lands.
2. **Interpreter + live REPL**, not interpreter-only — the REPL panel
   shares the editor's buffer, so Lisp edits the document live.

**What's built**: `@editor/lisp` — reader, value model, tree-walking
evaluator, lexical scope, closures, ~75 primitives, procedural macros,
`try`/`catch`, self-documentation. The REPL view is in `@editor/renderer`
(decoupled from the language); the desktop app registers buffer
primitives and wires it together. 57 Lisp tests; smoke test extended to
evaluate Lisp and confirm it edits the rendered buffer.

**Deferred** (all additive, none touch the settled core — see
`docs/spec/lisp.md §"Deferred"`): macro hygiene, tail-call optimisation,
the module system + hot reload, conditions/restarts, Lisp→JS interop.

**Territory note**: spanned `packages/lisp`, `packages/renderer`,
`apps/desktop` and `docs/spec/` on branch `agent-3-lisp`, under the
direct live brief.

**State of the work**: Branch `agent-3-lisp`, all committed, every
suite green (storage 47, buffer 29, renderer 26, lisp 57) and the
Electron smoke test passing.

---

## [2026-05-21] Renderer + desktop: a running editor, with deviations to confirm

**Context**: Brief was "be ambitious, I'd love to see a running app
tomorrow." Built the full L1→L2→L4 vertical slice; the editor opens in
an Electron window and is editable. Smoke test confirms typing,
deletion, cursor and modeline.

**Decisions that touch standing commitments — please confirm or correct:**

1. **No bundler (deviates from architecture commitment #6, "Vite for
   the renderer").** For v0 there is nothing to bundle. The renderer
   loads the workspace packages as native ES modules via an import map,
   served over a custom `app://` scheme (`apps/desktop/src/serve.js`).
   This is simpler, has no build step, and is more legible. Fully
   reversible — Vite can be added when there is a real reason (HMR,
   minified release builds). If you want Vite in from the start, say so.

2. **L3 Lisp runtime deferred.** A running editor does not need it, and
   it is the riskiest compounding decision in the architecture —
   rushing it autonomously seemed wrong. The editor runs without Lisp;
   v0 keybindings are a small hardcoded keymap in the renderer
   (`packages/renderer/src/keymap.js`), explicitly a placeholder for the
   real Lisp-defined bindings.

3. **L1 persistence split to a sub-path entry.** `@editor/storage` now
   exports only the browser-safe `createBuffer`; `loadBuffer`/
   `saveBuffer` (which use `node:fs`) moved to
   `@editor/storage/persistence`. Necessary — the renderer pulled
   `node:fs/promises` into the browser otherwise. A genuine improvement:
   L1's default surface is now browser-safe.

4. **pnpm via corepack.** pnpm was not installed; activated it through
   Node's bundled `corepack` (pnpm 11.2.2, pinned in root
   `package.json`'s `packageManager`). No global npm install.

**L2 is minimal.** `@editor/buffer` has point/mark, editing, movement,
undo/redo and events — enough to drive the window. Text properties,
overlays, markers, modes and hooks are deferred (noted in its README).

**Territory note.** This session spanned `packages/renderer` and
`apps/desktop`, both built on branch `agent-4-renderer`, plus a small
browser-safety fix in `packages/storage` (item 3). Done under the
direct "running app" brief rather than routed through notes, since you
were monitoring live.

**State of the work**: Branch `agent-4-renderer`, all committed, tests
green (storage 47, buffer 29, renderer 26) and the Electron smoke test
passing. Pre-commit hook also had a real bug fixed this session
(`pnpm test --silent` forwarded `--silent` to `node --test`); that fix
is already on `main`.

---

## [2026-05-22 23:30] Agent A3 / colour swatches: integration is clean — no shared-registry wiring needed

**Context**: Task A3 — clickable colour swatches — is done on branch
`agent-a3-colour-swatches`.

**Integration pass note**: A3 needs **no** shared-registry wiring. The
feature is self-contained:
- New files: `packages/renderer/src/colour-literals.js`,
  `colour-picker.js`, `colour-swatches.js` (+ two test files).
- `packages/renderer/src/index.js` — append-only export additions.
- `packages/renderer/src/view.js` — the view builds the swatch
  decorator over its own active buffer and runs it per rendered line;
  no app.js change was required (the view already has buffer access,
  as the brief noted). One pre-existing latent bug was fixed in the
  same edit: the new line-offset pre-loop is clamped to `lineCount`
  because `first` can exceed it after switching to a shorter buffer.
- `apps/desktop/styles.css` — append-only swatch + modal styles.
- `apps/desktop/scripts/smoke.js` — a new `swatches` check, inserted
  before the final assertion block (the brief explicitly asked for a
  smoke check).

Merge order A: should apply cleanly. The only shared files touched are
`view.js`, `index.js`, `styles.css`, `smoke.js`; all edits are
additive except the clamp fix in `renderLines`.

**State of the work**: branch `agent-a3-colour-swatches`, four feature
commits + this log/notes commit, `pnpm test` green (all packages),
`pnpm --filter @editor/desktop smoke` PASS. Not merged, per the rules.

---

## [2026-05-23 09:35] Agent B1 / JSON language: clean drop-in, no shared-registry wiring

**Context**: Task B1 — add the JSON tree-sitter language — is done on
branch `agent-b1-lang-json`. This is the first language built on
T0's drop-in mechanism; the experience validates the design.

**Integration pass note**: B1 needs **no** shared-registry wiring.
The feature is self-contained:
- New files: `packages/renderer/src/languages/json.js`,
  `packages/stdlib/lisp/languages/json.lisp`, vendored
  `packages/renderer/vendor/tree-sitter-json.wasm`.
- `packages/renderer/package.json` — one devDependency line
  (`tree-sitter-json: 0.24.8`).
- `pnpm-workspace.yaml` — one row in `allowBuilds`
  (`tree-sitter-json: false`, matching the other tree-sitter
  packages).
- `packages/renderer/vendor/README.md` — one row appended to the
  vendored-files table.
- `apps/desktop/scripts/smoke.js` — JSON arm added to the
  existing treesitter check (a `smoke.json` buffer with
  `[1, true, null]`; asserts ≥1 `.tok-number` and ≥1
  `.tok-constant` span, since JSON has no fallback tokenizer
  and any tok-* span proves the grammar loaded). All additive
  inside the existing `treesitter` IIFE — should merge cleanly.

Merge order B: should apply trivially. Only `smoke.js`,
`pnpm-workspace.yaml`, `pnpm-lock.yaml` and the renderer
`package.json` could collide with sibling B-track agents; each
of those changes is an append-only single row / line. The two
new feature files and the vendored grammar are pure additions.

**State of the work**: branch `agent-b1-lang-json`, one feature
commit + this log/notes commit, `pnpm test` green (472 tests),
`pnpm --filter @editor/desktop smoke` PASS. Not merged, per the
rules.

---

## [2026-05-23 11:10] Overnight chain B2–B6 + D1–D3: ready to fast-forward main

**Context**: B1 is on `agent-b1-lang-json` (committed earlier). Per
the run note, the rest of Track B (B2 CSS, B3 TypeScript, B4 Rust,
B5 Go, B6 Bash) and Track D (D1 themes, D2 mode-specific keymaps,
D3 multi-line highlighting) were built. To match the "chain branches
off B1 tip" preference, each task's branch was created from the
previous task's tip rather than merged into main as it landed.

**The branch chain** (all linear; each branch is a fast-forward of
the previous):
- `agent-b1-lang-json` → `ae1fd66`
- `agent-b2-lang-css` → `ecb3404`
- `agent-b3-lang-typescript` → `9e45b27`
- `agent-b4-lang-rust` → `4bb0e4b`
- `agent-b5-lang-go` → `e8830aa`
- `agent-b6-lang-bash` → `1b70a86`
- `agent-d1-themes` → `0bae397`
- `agent-d2-mode-keymaps` → `11a0687`
- `agent-d3-multiline-highlight` → `b06f266` (current HEAD)

Main is at `01cabeb` (T0). A `git merge --ff-only agent-d3-multiline-highlight`
on main lands the whole chain. (You denied an earlier attempt to do
that automatically; flagging for explicit approval.)

**Deviations from the per-task shared-file list, by task:**
- **B4 (Rust):** discovered that `self` / `super` / `crate` are named
  nodes in tree-sitter-rust, not anonymous tokens. Putting them in a
  `[ "fn" "let" … "crate" ]` alternation throws `Bad node name
  'crate'` at Query construction; they each need a `(name) @keyword`
  capture instead. `mut` is wrapped in `mutable_specifier` for the
  same reason. Recorded in the language file's comments.
- **B6 (Bash):** the same gotcha — `time`, `return`, `local`,
  `export`, `declare`, `readonly`, `unset` aren't anonymous tokens.
  `time` is a named node; the others are builtin words used in
  command position. They ride the `(command_name (word) @function)`
  capture, not the keyword alternation. Recorded in the language
  file's comments.
- **D1 (theme system):** the plan listed only `styles.css`,
  `themes.lisp` (new) and `app.js` as shared. Two extras were
  genuinely needed: (a) one line in `packages/stdlib/src/index.js`
  to add `themes.lisp` to `STDLIB_FILES` (same single-append pattern
  every Track C task used), and (b) `:on-change` support added to
  `custom-register!` and `custom-apply!` in `custom.lisp` — the
  plan's "`:on-change` applying the theme" phrasing implied the
  feature, but no such hook existed yet. The hook is strictly
  additive (default `nil`, only invoked when a procedure) and is
  useful beyond themes.
- **D2 (mode-specific keymaps):** the plan listed no shared files.
  `modes.lisp` gained four lines (two empty mode-map declarations
  for LaTeX and Makefile, two `:keymap` references) to match the
  `markdown-mode-map` pattern. `STDLIB_FILES` gained two entries
  for the new `latex.lisp` and `makefile.lisp` feature files.

**Integration-pass note (now N/A because of the chain).** Each
task above is a clean append to the prior tip — no rebase or
merge-conflict resolution is needed. The whole night ff-merges in
one go.

**Results.** All 490 tests across the workspace pass on the chain
HEAD:

| Package | Tests |
|---------|-------|
| `apps/desktop` | 11 |
| `packages/storage` | 47 |
| `packages/lisp` | 68 |
| `packages/buffer` | 35 |
| `packages/renderer` | 137 |
| `packages/stdlib` | 192 |

`pnpm --filter @editor/desktop smoke` — PASS, with new arms for
JSON / CSS / TypeScript / Rust / Go / Bash highlighters and the
theme-switching check.

---

## [2026-05-23 13:30] Agent docs-system: in-editor documentation, ready for review

**Context**: Built an in-editor documentation system on branch
`agent-docs-system`, layered on top of the overnight Track B/D chain.
Seven commits since `agent-d3-multiline-highlight`; not merged. Full
write-up in `logs/docs-system-2026-05-23.md`.

**What's there**:
- A separate `pnpm run docs` build that renders `docs/MANUAL.jmd`
  (which `[[…]]`-includes the four topic .md files) into
  `docs/build/`. The .jmd's postprocessor splits the result into
  per-function pages and writes a `name → path` manifest.
- A new `doc` buffer kind (peer of `customize` and `image`) that
  shows the rendered HTML and intercepts `[data-jmacs-doc]` cross-
  links. `C-h f` / `M-x describe-command` route through it.
- For user-defined procedures that aren't in the static manifest,
  the docstring is rendered live as Markdown via a vendored
  `marked.js@18.0.4` and shown in the same doc buffer.
- `*jmarkdown-command*` renamed to `*markdown-interpreter*`.
  Default is `"marked"`; any other string falls back to the
  original shell-command path (`pandoc`, `multimarkdown`, etc.).

**Things to flag for review**:

1. *Name collision in the manifest.* `newline` is both a Lisp-core
   primitive (writes a line break) and an editor command (inserts
   into the buffer). The migration emits two `:::function{}` entries
   with the same `name`; the build now prints a warning and the
   last-written entry wins (currently lisp-core). Both HTML pages
   exist on disk but only one is reachable by name. Worth deciding
   whether to disambiguate by namespace (e.g. `commands:newline` vs
   `lisp-core:newline`).
2. *The rendered pages still carry `data-source-line` attributes*
   from jmarkdown's source-mapping feature on every block. They are
   harmless but inflate the HTML; the postprocessor could strip them.
3. *Custom.lisp `:on-change` was extended (in the D1 theme work)*
   to call a procedure on a setting change; the docs change relies
   on it indirectly through `(custom-apply! '*markdown-interpreter*
   …)` continuing to fire any hook. Currently no docs setting uses
   it, so no behaviour change.
4. *Smoke state leaks between arms*: setting
   `*markdown-interpreter*` early in the smoke (sticky notes,
   markdown preview) carried into the live-docs arm and broke it
   until reset. The arm now explicitly resets to `"marked"` — the
   broader lesson is that the smoke runs a single Lisp session and
   per-arm state should reset to defaults if it matters.

**Branch chain at this point** (linear, each ff-merges off prior):
- `agent-b1-lang-json` … `agent-b6-lang-bash` (Track B)
- `agent-d1-themes`, `agent-d2-mode-keymaps`,
  `agent-d3-multiline-highlight` (Track D)
- `agent-docs-system` (current HEAD: `20b31ad`)

Main is still at `01cabeb` (T0). A `git merge --ff-only
agent-docs-system` from main lands the whole sequence in one
fast-forward.

---

## [2026-05-23] agent-markdown / Phase 2: package ships no prebuilt wasm — need a build path

**Context**: Implementing Phase 2 of the tree-sitter language injection
plan (`plans/LANGUAGE-INJECTION.md`) — vendoring the markdown block +
inline grammars and wiring them up via the injection pipeline that
landed in phase 1 (`a1573ed`).

**Question/blocker**: `@tree-sitter-grammars/tree-sitter-markdown@0.3.2`
ships C source and **native `.node` prebuilds** for Node.js bindings,
but **no `.wasm` files**. The editor loads grammars over `app://` and
calls `Language.load(new Uint8Array(...))` — it can only consume
WebAssembly, not native `.node` modules. The task brief was explicit:
"If the package ships only source (no prebuilt wasm), STOP and write a
note to architect-notes.md describing what you found — don't try to
build from source unsupervised." So I'm stopping here.

What's in the package:

```
node_modules/.../@tree-sitter-grammars/tree-sitter-markdown/
├── prebuilds/{darwin-arm64,darwin-x64,linux-x64,win32-x64}/
│   └── @tree-sitter-grammars+tree-sitter-markdown.node      # native, not wasm
├── tree-sitter-markdown/
│   ├── src/{parser.c, scanner.c, tree_sitter/, grammar.json, node-types.json}
│   ├── queries/{highlights.scm, injections.scm}
│   └── grammar.js
├── tree-sitter-markdown-inline/
│   ├── src/{parser.c, scanner.c, tree_sitter/, grammar.json, node-types.json}
│   ├── queries/{highlights.scm, injections.scm}
│   └── grammar.js
└── common/grammar.js
```

No `.wasm` anywhere. The package's only `build` script (`scripts/build.js`)
builds the native `.node` binding via `node-gyp-build`.

The PHP situation is the same in spirit but already solved: the
`tree-sitter-php.wasm` and `tree-sitter-php_only.wasm` files in
`packages/renderer/vendor/` (untracked, ~1MB each, dated May 23 18:30)
were clearly produced out of band — possibly by you, possibly by the
agent-php branch. The same trick is needed here for markdown.

**Options considered**:

1. **Install `tree-sitter-cli` (and Emscripten) and run
   `tree-sitter build --wasm` for both subdirectories.** This is the
   plan document's own suggestion ("vendor a small build step in
   `scripts/build-grammars.sh`, one-time, run when refreshing the
   grammar version, not per-developer"). The build needs either
   Docker or an Emscripten toolchain locally — neither is currently
   set up in this worktree, and the brief told me not to do this
   unsupervised. Pro: reproducible, future-proof. Con: adds a
   build-tooling story to the repo that doesn't exist today.
2. **Fetch prebuilt `.wasm` from a known mirror.** e.g. the
   [tree-sitter wasm-prebuilds](https://github.com/tree-sitter/tree-sitter)
   nightly artifacts, or Helix / Zed's vendored copies. Pro: zero
   build setup. Con: pinning provenance to a third party; the
   markdown grammar specifically is a niche enough package that I'm
   not certain a stable mirror exists.
3. **Pick a different markdown grammar package that does ship
   prebuilt wasm.** I haven't surveyed alternatives — the plan
   document specifically names `@tree-sitter-grammars/tree-sitter-markdown@0.3.2`
   as the maintained choice. If a sibling project (e.g.
   `tree-sitter-md` or similar) ships wasm and is good enough,
   that's the lightest change.

**State of the work**: Branch `agent-markdown` is rebased onto current
main (a1573ed) so it has the phase 1 injection pipeline. The only
changes on the branch beyond main are:

- `packages/renderer/package.json` — `@tree-sitter-grammars/tree-sitter-markdown@0.3.2` added as a devDependency (pinned).
- `pnpm-lock.yaml` — updated by the install.
- `pnpm-workspace.yaml` — `'@tree-sitter-grammars/tree-sitter-markdown': false` added to `allowBuilds` (per the existing convention; pnpm prompted on first install).

Nothing committed yet. No `.wasm` was copied because there's nothing
to copy. No `languages/markdown.js`, `languages/markdown-inline.js`,
or `markdown.lisp` was written, and no smoke arm extended, because
without the grammar binaries those would dead-letter at load time.

If you want me to resume:
- If option 1: tell me what build tool to use (local `tree-sitter-cli`
  + Emscripten, or `tree-sitter generate && tree-sitter build --wasm`
  via Docker) and I'll add `scripts/build-grammars.sh`, run it, and
  commit the artefacts.
- If option 2 or 3: point me at the mirror or alternative package.

In the meantime I'll leave the branch in the worktree (`agent-markdown`,
locked) so the staged install survives.

---

## [2026-05-23] agent-markdown / Phase 2: complete — wasm built, pipeline green

**Resolution of the blocker above.** You built both
`tree-sitter-markdown.wasm` and `tree-sitter-markdown-inline.wasm`
locally via `tree-sitter-cli` + Docker/Emscripten and dropped them in
`/tmp/md-build/`. This session vendored them and finished phase 2.

**What landed on `agent-markdown` since `3dfadf9`** (this commit
brings the branch to the state intended by `plans/LANGUAGE-INJECTION.md`
§Markdown):

- `packages/renderer/vendor/tree-sitter-markdown.wasm` and
  `tree-sitter-markdown-inline.wasm` — the two new grammars (committed
  binaries; ~370 KB each).
- `packages/renderer/src/languages/markdown.js` — block grammar
  registration with highlight query (headings, fenced-code delimiters,
  list/blockquote markers, info-string, link targets) and the
  injection query from the plan, verbatim.
- `packages/renderer/src/languages/markdown-inline.js` — inline grammar
  registration. `suffixes: []` (reached only via injection).
- `packages/stdlib/lisp/languages/markdown.lisp` — adds the
  `.markdown` suffix mapping to the existing `markdown-mode` in
  `modes.lisp` (which already covers `.md`/`.jmd`).
- `scripts/build-grammars.sh` — the build path you used, captured as a
  one-shot script so the next grammar refresh is reproducible. Not
  marked executable from the agent; chmod when you want it runnable.
- `pnpm-workspace.yaml` — added `tree-sitter-cli: true` to
  `allowBuilds` (the CLI's postinstall downloads the prebuilt platform
  binary; we want that).
- `packages/renderer/package.json` — `tree-sitter-cli: 0.25.5` as
  devDep so the build script has its binary on hand.
- `packages/renderer/vendor/README.md` — two new rows plus a paragraph
  explaining that the markdown wasms are built locally, not copied
  from npm.
- `apps/desktop/scripts/smoke.js` — markdown arm in the treesitter
  IIFE: a `.md` buffer with `# heading` + a fenced `javascript` block;
  asserts `tok-heading > 0` and `tok-keyword > 0` (the latter proves
  the markdown → javascript injection ran; the inner JS highlighter's
  `const` capture lights up). `markdown` added to the `langs.includes`
  assertions.

**One judgement call, please review**: the brief asked for a
`\`\`\`lisp` fence body with `(define x 1)` in the smoke arm, on the
assumption that injection would resolve to a Lisp highlighter. The
editor's Lisp dialect has **no tree-sitter grammar** — it's the
hand-written `tokenizeLisp` in `highlight.js`, which never registers
itself with the tree-sitter registry. Injection only resolves inner
highlighters out of that registry, so a `\`\`\`lisp` fence would
silently render with the outer `code` face. I swapped in
`\`\`\`javascript` instead (whose grammar *is* registered) so the
smoke assertion actually proves injection works. Same shape, same
proof. If you'd rather we register the lisp tokenizer as a synthetic
"inner" highlighter, that's a small follow-up — happy to tackle it
under a fresh brief.

**One small smoke-harness gotcha** (kept locally with a comment):
`replInput.value = source` goes through a single-line `<input>`, which
strips literal newlines. The lisp source therefore has to escape
newlines as a literal `\\n` pair (four backslashes in the JS template
literal → two in the JS string → the `\n` escape the Lisp string
reader expects → a real newline in the inserted text). First pass of
the smoke arm passed only the heading because the fence newlines
collapsed; the fix was a mechanical re-escape.

**State of the work**: branch `agent-markdown`, one new feature commit
on top of `3dfadf9`. `pnpm test` green across all packages
(47 + 68 + 12 + 35 + 160 + 206 = 528 tests). `pnpm --filter
@editor/desktop smoke` PASS; the markdown line in the treesitter log:

```
treesitter: {"langs":"bash,css,go,html,javascript,json,markdown_inline,markdown,python,rust,typescript",...,"mdHeadings":1,"mdInjectsJs":2}
```

Not merged. Ready for you to ff-merge or review.

---

## [2026-05-26 15:20] agent-shell-buffer-v2: BSD `script(1)` won't accept non-tty stdin

**Context**: implementing the v2 brief — give the shell buffer a real pty
via `script(1)`. On macOS BSD `script` errors immediately when spawned
from Node:

    script: tcgetattr/ioctl: Operation not supported on socket

BSD `script` calls `tcgetattr(stdin)` on startup to clone the parent's
termios onto the new pty. With stdin being a Node pipe (a socketpair),
that call fails and `script` exits 1 before doing anything useful.
Confirmed at the bare-Node level — not an Electron quirk.

`stdio: 'ignore'` or `stdio: [fd-of-/dev/null, ...]` lets script start
(it opens an interactive shell on a real pty), but with no writable
stdin the shell gets EOF immediately and exits. There is no BSD-script
flag that disables the parent-termios clone, and no `tty(4)` device
we can hand to it from a sandboxed renderer.

util-linux `script` (Linux) does work — it calls `forkpty` directly
and doesn't touch the parent's termios.

**Question/blocker**: not asking — making a judgement call below and
documenting it for review.

**Options considered**:

1. `script(1)` everywhere — fails on macOS as above; would have to
   ship a Linux-only feature, which defeats the point.
2. **`python3 -c '<inline pty.spawn>'`** — `/usr/bin/python3` is
   present on every modern macOS (Apple ships it as a system tool) and
   on every standard Linux distro. The `pty` module is in stdlib (no
   extra install). `pty.spawn(['/bin/zsh', '-i'])` forks, allocates a
   pty, and proxies between the pty and the python process's own
   stdio — which is exactly what we want. Tested end-to-end from Node:
   colours, prompt, line editing, signals all work. **This is what
   I've shipped.** Behaves identically on macOS and Linux.
3. `expect(1)` is also on macOS — but its scripting language is more
   verbose than the four-line python and we'd still need it on Linux.
4. Native addons (`node-pty`) — ruled out by the brief.

**The cost of the python choice**: depending on python is more than
depending on a tiny BSD utility, but it's a system python (no venv,
no pip install), and we only invoke it with a short inline script. If
python isn't present, the spawn fails its existence probe and we fall
back to v1's plain-pipe shell — the same fallback the original brief
described for missing `script`. So nothing is lost for users without
python; they get the v1 experience.

**Files touched relative to the brief**:
- `apps/desktop/src/shell.js` — `buildPtyInvocation` (was
  `buildScriptInvocation`) returns the `python3 -c …` command + args
  instead of the script form. The existence probe is `python3 -c
  'import pty'` (matches the cache shape from the brief).
- Everything else is unchanged: TERM=xterm-256color, `pty: true|false`
  in the spawn reply, SIGINT handling via the `\x03` byte to stdin.

**State of the work**: branch `agent-shell-buffer-v2`, no commit yet —
this is the first PTY-backing commit I'm about to make. Code in
working tree.

---
