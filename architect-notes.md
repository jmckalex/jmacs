# Architect Notes

Notes from autonomous sessions for Jason to review. Newest at the top.
Nothing here is blocking — these are decisions made under the "build a
running app" brief that touch standing commitments or span territories,
flagged so the standing instructions can be updated if you disagree.

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
