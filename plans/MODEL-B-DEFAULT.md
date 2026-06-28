# Plan — One world on the server: make Model B the default, remove the flag, and delete the renderer Lisp interpreter

> **STATUS:** DRAFT (2026-06-28). Not started. Branch base: `main` (green, 63 ahead of `origin/main`).
> Scope chosen by the architect: **Deep** — not just remove the flag, but eliminate the
> renderer's Lisp interpreter entirely so there is a single Lisp world (the spine) and the
> renderer becomes a pure-JS thin client.
> Recovery tag to cut before the first merge: `pre-model-b-default`.

---

## 1. Goal & end state

Today the renderer runs a **second, full Lisp interpreter** alongside the spine's. Under
Model B it no longer dispatches keys or edits buffers (the spine does), but it is still the
live owner of renderer chrome: **faces/themes→CSS, syntax-highlight rules, customize,
docs, config vars, and ~31 renderer-only stdlib features** (file dialogs, project chooser,
directory views, sticky notes, jukebox, element views, utility dock, inline-eval/REPL,
folding, …). It loads the full 66-file `STDLIB_FILES` and the user's `init.lisp`/`custom.lisp`.

**End state:**

- One Lisp interpreter, in the **spine**. It loads (nearly) the whole stdlib **and** the
  user's `init.lisp`/`custom.lisp`/`faces.json`.
- The **renderer imports no `@editor/lisp` / `@editor/stdlib`** and constructs no
  interpreter. It is a pure-JS thin client: DOM painting (`view.js`), tree-sitter
  highlighting, `keyEventToString`, and a fat **`applyDirective`** switch that turns
  server effects into DOM/CSS.
- `GODOT_SERVER` is gone; a bare `electron .` is the only mode.

**What stays renderer-side (presentation, not logic):** `view.js` + the editor DOM,
tree-sitter highlighting (pure JS), `face-styles.js` CSS injection, the `customize-view`
and `doc-view` HTML rendering, the utility dock, the `<audio>`/`<webview>`/element-view
host elements, `keyEventToString`. These are *fed by directives* instead of by a local
interpreter.

---

## 2. The pivotal design decisions (read before anything)

1. **Highlighting stays in the renderer.** tree-sitter runs as WASM in the renderer; the
   highlight engine (`treesitter.js`, `highlight-overrides.js`, `runs.js`, `view.js`) is
   **pure JS** and already cached on `(text, lang, mode, ruleGeneration)`. The Lisp side
   only holds the *rules data* (pattern→face, from `faces.json`), already injected via the
   **JS** primitive `set-highlight-overrides!` → `highlightOverrideStore.replaceAll()`.
   So: the server becomes the owner of the rules *data* and pushes it as a directive once
   (and on change); the renderer keeps highlighting locally. **No per-keystroke
   re-highlight crosses the port.** This removes the epic's only real hot-path risk.

2. **The renderer keeps a "presentation" layer; it loses only the interpreter.** The
   renderer is not becoming a dumb terminal — it keeps all the DOM/CSS/element machinery.
   What dies is *logic expressed in renderer Lisp*. Every renderer-only command becomes:
   **spine command → `CLIENT_DIRECTIVE` → renderer `applyDirective` case** that calls the
   (now plain-JS) presentation function.

3. **The spine must load user config.** Once the renderer interpreter is gone, `init.lisp`
   / `custom.lisp` / `faces.json` must be read+evaluated **by the spine** (it's a Node
   `utilityProcess` — it can use `fs` directly). This is a prerequisite for Part B and a
   real behaviour change (user config currently only affects the renderer).

4. **Two separable deliverables.** **Part A** (flag removal + dead-dispatch deletion) is
   small, low-risk, and independently valuable — ship it first; it makes Model B the only
   mode while the renderer interpreter *remains* (serving chrome). **Part B** (the
   interpreter teardown) is the epic — migrate each chrome subsystem to the spine, then
   delete the interpreter. The app stays fully working after every phase.

---

## 3. Reconnaissance summary (the inventory the plan acts on)

- **Renderer interpreter:** `app.js` `createInterpreter` (≈L3686) with primitives spread
  from `createBufferPrimitives` / `createViewPrimitives` / `createPanePrimitives` /
  `createLatexPrimitives` + **~41 renderer-only primitives** registered inline. **103**
  `interpreter.call/.evaluate` sites. No other module imports `@editor/lisp`/`@editor/stdlib`
  — everything funnels through this one singleton.
- **Stdlib split:** `STDLIB_FILES` = **66** files (renderer); `SPINE_STDLIB` = **35**
  (server). The **31 renderer-only** files are the Part-B work list: `faces.lisp`,
  `themes.lisp`, `highlight-rules.lisp`, `docs.lisp`, `help.lisp`, `face-info.lisp`,
  `inline-eval.lisp`, `folding.lisp`, `files.lisp`, `views.lisp`, `view-menu.lisp`,
  `tabline.lisp`, `panes.lisp`, `minimap.lisp`, `system.lisp`, `utility-pane.lisp`,
  `menus.lisp`, `snippets-keymap.lisp`, `project.lisp`, `palette.lisp`, `sticky-notes.lisp`,
  `jukebox.lisp`, `directory-tree.lisp`, `directory-columns.lisp`, `notebook.lisp`,
  `notebook-commands.lisp`, `latex-compile.lisp`, `latex-menu.lisp`, `element-views.lisp`
  + the four `element-view-*.lisp`. (Verify the exact set against both files when starting
  each phase — names move.)
- **Already server-side (no work):** buffer/kill/yank/search/regex/markdown/latex/reftex/
  bookmarks/citations/browser/shell/gnuplot/auto-pair/snippets/modes/keymap, plus the
  **help family** (`C-h k/f/a` emit `show-help`/`show-apropos`), reftex picker rows, the
  minibuffer round-trip, and customize **cross-window sync** (`CUSTOMIZE_SYNC`).
- **The flag:** `isServerMode` (`server-bridge.js`), `serverMode` (`preload.mjs` field +
  port-listener), and ~26 `main.js`/`app.js` conditionals. Full site list in §4 (Part A).

---

## PART A — Make Model B the default; remove the flag; delete the dead dispatch path

The renderer interpreter **stays** through Part A (it still serves chrome). What we remove
is the build-time flag and the in-renderer **dispatch/editing/session** path that only ran
with the flag off.

**A0 — Pre-flight.** Branch `model-b-default` off green `main`; tag `pre-model-b-default`.
Confirm `pnpm test` green and the app boots with `GODOT_SERVER=1` (baseline).

**A1 — Flip the default (reversible checkpoint).** `preload.serverMode = true`
unconditionally; `main.js` forks the server unconditionally; preload port-listener
unconditional. Delete nothing else yet. **Live-verify a bare `electron .` (no env) boots
Model B** — types, chords, M-x, find-file, splits, multi-window, themes, docs. This proves
default-on before any deletion.

**A2 — Remove the flag plumbing.** Delete `isServerMode` (`server-bridge.js`) + its import;
collapse every `main.js` guard to the server branch (window registry, bounds listeners,
free window-close, `closed` cleanup, `window:new`/`:close`/`:set-bounds`, `canNewWindow:
true`, `focusedWindow()` quit target, unconditional fork + `serverBridge.dispose()`);
collapse the preload port-listener. Delete the three `isServerMode` tests in
`server-bridge.test.js` (keep the `createServerBridge` factory tests). `node --check` +
live-verify.

**A3 — Delete the dead in-renderer dispatch/editing/session path (app.js).** Staged by
concern, `node --check` + live-verify after **each** (app.js is not in the suite):
`updateModeline`, `ensureMajorMode`, the placeholder/split chooser, the local
M-x/buffer-switcher/describe pickers, `currentModeMenu`, `toggleMinimapForFocusedLeaf`,
the local-dispatch branch of the global key router (**boot-window trap, §7**), the
bookmark/element-view local `insertText`/`configureBookmarkView` branches, the
`NULL_SESSION`/`activeSession` fork + local session restore/recovery.
Rewrite `server-router-gate.test.js` (`serverMode` is always true → "defer iff mounted").

**A4 — Docs/launch for Part A.** Drop the `GODOT_SERVER=1` prefix from `CLAUDE.md`,
`docs/MAP.md`, `docs/MODEL-B-DISPATCH.md`, `.claude/skills/run-and-verify/SKILL.md`. Note
in `MWB-GRADUATION.md` that its final "make default" step is done.

> **End of Part A:** Model B is the only mode; the flag is gone; the renderer interpreter
> remains but is reached only for chrome. This is a clean, mergeable milestone — consider
> merging Part A to `main` before starting Part B.

---

## PART B — Move every chrome subsystem to the spine, then delete the renderer interpreter

Each phase: (i) move the relevant `.lisp` into `SPINE_STDLIB` (or add a spine command),
(ii) define the directive(s) in `protocol.js`, (iii) emit from the spine, (iv) add the
renderer `applyDirective` case calling the existing plain-JS presentation function, (v)
delete the now-unused renderer interpreter calls/primitives for that subsystem, (vi)
**live-verify**. The renderer interpreter shrinks each phase; it is deleted only in B7.

### B0 — Foundations (prerequisites for everything after)

- **Spine loads user config.** In the spine boot (after `SPINE_STDLIB`), read+eval
  `custom.lisp` then `init.lisp` from `userData` via `fs`; read `faces.json`. Mirrors
  `app.js loadUserConfig`. The forked `utilityProcess` already has `MWB_SESSION_SEED`; add
  the config dir similarly, or resolve `app.getPath('userData')` in `main.js` and pass it.
  *Decision:* `init.lisp` may call renderer-only primitives today — once it runs in the
  spine, those must exist as spine primitives or directive emitters. Audit common init.lisp
  usage; provide spine equivalents or graceful no-ops. (Flag in §7 as a behaviour change.)
- **Config snapshot push.** Add a `CONFIG` directive (or VIEW fields) carrying the
  defcustom values the renderer reads (`*autosave-recovery*`, `*autosave-recovery-interval*`,
  `*pdf-restore-default*`, `*markdown-preview-follow-cursor*`, `math-preview-mode` active,
  `*bib-search-doc-override*`, …). Renderer caches them; replace the inert
  `interpreter.evaluate('*…*')` reads with the cached value. Push on connect + on change.

### B1 — Faces / themes / CSS (highest value; cross-window sync already exists)

- Move `themes.lisp`, `faces.lisp`, `highlight-rules.lisp` into `SPINE_STDLIB`.
- Spine computes `current-theme-css-vars`, `current-face-styles`, `current-mode-face-styles`,
  and the highlight-rule entries; emits `THEME_APPLY` / `FACES_APPLY` / `HIGHLIGHT_RULES`
  directives **to all windows** (consistency for free).
- Renderer keeps `face-styles.js` (CSS gen + `<style id="face-overrides">` injection),
  `document.documentElement.style.setProperty` for CSS vars, and `highlightOverrideStore`
  — now driven by the directives, not the interpreter.
- `faces.json` read/write moves to the spine (`fs`); drop the renderer `readFaces`/
  `write-faces!` path. `-migrate-stale-theme!` runs in the spine.
- CSS knobs (`set-css-tab-width!`, `set-css-line-height!`) → `CSS_KNOB` directive.
- **Verify:** theme switch (all windows), per-face customize live preview, per-mode faces,
  user `faces.json` honored, syntax colors unchanged.

### B2 — Customize

- `custom.lisp` already loads server-side. Move the **model** computation server-side:
  `custom-group-model`, `faces-group-model`, `face-row`. Push the model as the payload of
  an `OPEN_CUSTOMIZE` directive (scope → model).
- `customize-view` HTML rendering stays renderer; it renders from the pushed model.
- `open-customize!` + variants become spine commands emitting `OPEN_CUSTOMIZE`.
- Apply/save/reset already round-trip through the server sync — finalize so the renderer no
  longer evals `(custom-apply! …)` locally; it sends an intent, the spine applies + persists
  (`custom.lisp` write via `fs`) + re-emits `FACES_APPLY`/`THEME_APPLY` to all windows.
- **Verify:** customize a setting + a face, save, reopen, second window reflects it.

### B3 — Docs / help (manual, doc-search, hover)

- `C-h k/f/a` done. Move `docs.lisp`/`help.lisp` server-side (or add spine commands):
  `doc-manifest`, `doc-summary-for`, `open-doc`, the manual (`C-h d`).
- `doc-view`/`doc-panel.js` rendering stays renderer; fed by `show-doc`/`open-doc` directives.
- Hover tooltip: push the doc summary (a VIEW field or a small request/response intent), or
  drop the inline preview if not worth a round-trip.
- **Verify:** `C-h d` manual, doc fuzzy search, symbol hover.

### B4 — Rich views & file/project UI (the bulk; sub-batch it)

Each is a renderer-only `.lisp` + primitives → spine command + directive(s). Group into
small, independently shippable batches, live-verifying each:

- **File/IO commands:** find-file/open-file dialogs, save, `read-file-text!` →
  spine commands; file *picking* (an OS dialog) stays a renderer effect via a directive
  (the dialog is a host concern). `files.lisp`.
- **Project:** `project.lisp` + chooser → spine command + `OPEN_PROJECT_CHOOSER` directive.
- **Directory views:** `directory-tree.lisp`, `directory-columns.lisp` — already partly
  server data-sources; finish (`directory-tree-open-file` → intent).
- **View list / view-menu / tabline / panes / minimap / utility-pane / menus** —
  most pane/tab/minimap logic is already server-owned (PANE_TREE); delete the renderer
  command shims, route the few remaining via directives. `utility-dock` open/activate →
  directives (the `show-help` idiom already proves this).
- **Sticky notes, jukebox, inline-eval/REPL, folding, palette** — each its own batch.
  Jukebox callbacks (`jukebox-on-directory-chosen`, `jukebox-track-ended`) → intents UP.
  Inline-eval/REPL: eval runs in the spine session; the overlay UI stays renderer.
- **Element views:** `element-views.lisp` + the four `element-view-*.lisp`. The registry is
  renderer-coupled (module URLs); keep the registry renderer-side **as plain JS data** (not
  via the interpreter), or push it from the spine. M-x already routes unknown commands down
  via `RUN_CLIENT_COMMAND`. On-ready callbacks become plain-JS handlers.
- **synctex inverse, recenter/goto-line, search UI openers** → directives/intents.

### B5 — Drain the last interpreter calls

Sweep `app.js` for any remaining `interpreter.call/.evaluate`. Each must be either (a)
replaced by a pushed value/directive, or (b) confirmed pure-JS and rewritten without Lisp
(e.g. `format-track` template formatting can be plain JS, or pushed pre-formatted). Target:
**zero** `interpreter.*` references in the renderer.

### B6 — Renderer primitive teardown

Delete the ~41 renderer-only primitives and the four primitive-factory spreads from the
`createInterpreter` call. Anything still referenced is a missed B4/B5 item — find its home.

### B7 — Delete the renderer interpreter

- Remove `createInterpreter`, `loadStdlib`, `reloadStdlib`, `loadUserConfig`, the
  `@editor/lisp` + `@editor/stdlib` imports from `app.js`.
- Remove the renderer's dependency on `@editor/stdlib`'s `STDLIB_FILES` load. (Keep the
  packages — the spine uses them. Only the *renderer* stops importing them.)
- Update the build (Rollup/bundler config) so the renderer bundle no longer pulls
  `@editor/lisp`/`@editor/stdlib`. Confirm a meaningful bundle-size drop as the proof.
- **Verify the full matrix** (below). The renderer now boots with no interpreter.

---

## 4. Definition of done

- Bare `electron .` boots Model B; `GODOT_SERVER` appears nowhere in `apps/**`/`packages/**`.
- `app.js` contains **zero** `interpreter.*` calls; the renderer imports no
  `@editor/lisp`/`@editor/stdlib`; no `createInterpreter`/`loadStdlib` in the renderer.
- The spine loads `init.lisp`/`custom.lisp`/`faces.json` and is the only Lisp world.
- `pnpm test` green (flag-off + renderer-interpreter-contract tests removed/rewritten).
- **Full live matrix:** type/chords/auto-pair; M-x; find-file (+TAB); buffer switch; splits
  + multi-window (C-x 5 2/0); **themes + customize live, across windows**; **syntax colors
  unchanged**; per-user `init.lisp`/`custom.lisp`/`faces.json` honored; docs (C-h d/k/f/a);
  directory views; sticky notes; jukebox; element views (atari/bib-search/notebook); inline
  eval/REPL; folding; shell; browser-view; jmarkdown preview; quit-confirm; session restore.

---

## 5. Suggested sequencing & checkpoints

1. **Part A** → merge to `main` (its own milestone; tag `pre-model-b-default` already cut).
2. **B0 foundations** → merge (user-config-on-spine is a real behaviour change; soak it).
3. **B1 faces/themes** → merge. **B2 customize** → merge. **B3 docs** → merge.
4. **B4** in batches, each merged independently.
5. **B5–B7** (drain → primitive teardown → delete interpreter) as the finale, in one
   focused arc, behind a recovery tag.

Each merge: `git merge --no-ff`, pre-merge recovery tag, architect runs the push.

---

## 6. Risks & traps (the careful bits)

- **Boot-window dispatch (Part A).** `server-router-gate.test.js` documents that today, in
  server mode but *before the server view mounts*, the renderer still handles keys. Confirm
  there's no editable surface before the snapshot lands (a splash/empty), or keep a "swallow
  keys until mounted" guard — don't blind-delete the router.
- **`init.lisp` moving to the spine (B0).** User init code may call renderer-only
  primitives. Audit; provide spine equivalents or graceful no-ops; document the change. This
  is the biggest *semantic* shift in the epic.
- **`app.js` TDZ-freeze.** Deleting/moving top-level code near the init focus-paint can
  introduce "Cannot access X before initialization" that silently freezes the renderer.
  After each app.js change: `electron . --enable-logging=stderr | grep "before initialization"`.
- **Not in the suite.** `app.js`/`main.js`/`preload.mjs`/`spine.js` are invisible to
  `pnpm test`. Use `node --check` + the throwaway interpreter harness (run-and-verify) for
  embedded Lisp + **live-verify every phase**. New spine commands prefer a `SPINE_STDLIB`
  `.lisp` file (unit-testable) over the embedded block when possible.
- **Directive args FLAT + structured-clone-safe** (no raw Lisp symbols over the port) — the
  recurring `emit-client-directive!` trap.
- **Duplicate spine host-primitive keys silently shadow** (last wins) — grep before adding.
- **Cross-window correctness.** Faces/themes/customize must fan out to *all* windows
  (B1/B2). The `CUSTOMIZE_SYNC` precedent + `all-window-ids` recipients cover this — use them.
- **Highlight-rule generation.** When the server pushes new rules, the renderer must bump
  the highlight cache generation so editors re-highlight (the existing `rerenderAllEditors`
  / override-store `generation()` path).

---

## 7. Where to look (code map)

| Concern | File | Symbols |
|---|---|---|
| Flag gate | `apps/desktop/src/server-bridge.js` | `isServerMode`, `createServerBridge` |
| Flag in preload / main | `apps/desktop/src/preload.mjs`, `apps/desktop/src/main.js` | `serverMode`, `godot:server-port`, `isServerMode`, `serverBridge`, `createWindow`, `focusedWindow` |
| Renderer interpreter boot | `apps/desktop/src/app.js` | `createInterpreter`, `loadStdlib`, `reloadStdlib`, `loadUserConfig`, the primitive factories |
| Stdlib split | `packages/stdlib/src/index.js`, `apps/desktop/mwb/spine.js` | `STDLIB_FILES`, `SPINE_STDLIB` |
| Faces/themes/CSS | `packages/stdlib/lisp/{faces,themes,highlight-rules}.lisp`, `apps/desktop/src/{face-styles,face-overrides}.js`, `packages/renderer/src/customize.js` | `current-theme-css-vars`, `current-face-styles`, `applyFaceStyles`, `set-highlight-overrides!`, `highlightOverrideStore` |
| Highlighting (stays renderer) | `packages/renderer/src/{treesitter,highlight-overrides,runs,view}.js` | `createTreeSitterHighlighter`, `augmentQuery`, `splitIntoLineRuns` |
| Customize model | `packages/stdlib/lisp/{custom,faces}.lisp` | `custom-group-model`, `faces-group-model`, `face-row`, `custom-apply!` |
| Docs/help | `packages/stdlib/lisp/{docs,help}.lisp`, `apps/desktop/src/server-view-client.js`, `packages/renderer/src/doc-panel.js` | `doc-manifest`, `open-doc`, `show-help`, `displayDocPanel` |
| Directive channel | `apps/desktop/mwb/spine.js`, `apps/desktop/mwb/server.js`, `apps/desktop/src/app.js`, `apps/desktop/mwb/protocol.js` | `emit-client-directive!`, `sendClientDirective`, `applyDirective`, `CLIENT_DIRECTIVE`, `MSG` |
| Config snapshot | `packages/stdlib/lisp/system.lisp`, `apps/desktop/src/app.js` | the `*…*` defcustoms read at L366/374/2492/7133/7570 |
| Playbook | `docs/MODEL-B-DISPATCH.md` | "Porting a renderer feature to Model B" |

---

## 8. Honest scale note

Part A is ~2–4 sessions (mechanical, well-bounded). Part B is a genuine epic: **31
renderer-only stdlib features + ~41 primitives**, each a small migration, plus the
`init.lisp`-on-spine behaviour change. It is best done subsystem-by-subsystem over many
sessions, merging each, with the interpreter deletion (B7) as the final payoff once the
call count hits zero. The architecture is the right one (a single Lisp world); the cost is
breadth, not depth — almost every step reuses the same `command → directive → applyDirective`
pattern the help/markdown-preview/customize ports already proved.
