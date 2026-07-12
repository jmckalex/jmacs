# Test suite & coverage — audit

**Auditor:** audit agent 13 (test suite & coverage story)
**Date:** 2026-07-01
**Repo:** `/Users/jalex/Source/jmacs/main` (Godot editor — Model B: spine server `utilityProcess` + thin renderer clients; vanilla JS ES2022; pnpm workspace)
**Suite state at audit:** green, ~3290 tests reported; `3270` literal `test(`/`it(` calls across `173` `*.test.js` files.

## Method note

- Read-only audit. Enumerated every non-test source file under `packages/*/src/**`,
  `apps/desktop/src/**`, `apps/desktop/mwb/*.js`; measured LOC with `wc -l`.
- Built a source→test import map: for each source file, counted how many test
  files reference its basename as an import path. Then **manually corrected the
  false positives** (a test that only asserts on a module *path string*, or names
  a file in a comment, is not coverage) and the false negatives (files reached
  only through a package barrel `index.js`).
- Verified the app.js/spine.js "not in the suite" claim by grepping actual
  `import` statements (not string matches) in every test file.
- Read `spine.test.js` (202 cases) plus `protocol`, `pane-model`, `session-store`,
  `snippets`, `isearch`, `save-integration`, `undo-integration` closely to see how
  the spine is constructed under test and what is stubbed.
- Extracted the stdlib test harness stub registry (`packages/stdlib/test/stdlib.test.js`
  `editor()` helper) and compared stub bodies against the real spine primitives.
- Sampled ~20 test files across packages for assertion quality.
- Did **not** run the full root suite. Ran individual suites only where noted.

## Executive summary

- **The "app.js/spine.js are not tested" claim resolves cleanly.** `apps/desktop/src/app.js`
  (**9,141 LOC**, the renderer client) and `apps/desktop/mwb/server.js` (**2,360 LOC**,
  the `utilityProcess` entry + `parentPort` message loop) are **NAKED** — no test
  imports either. But the command *logic* those files used to hold now lives in
  `apps/desktop/mwb/spine.js` (**6,103 LOC**), which **is** tested: `spine.test.js`
  drives the **real** `createSpine` with recording effect callbacks (202 cases). So
  the spine is genuinely covered; its two thin wrappers (renderer glue in app.js,
  process wiring in server.js) are not.
- **~38% of source LOC sits in NAKED files.** Total non-test source is **~77,029 LOC**
  (215 files); NAKED files total **~29,167 LOC** (37.9%). Counting `view.js`'s
  `createEditorView` (imported but its inner editor is stubbed — a tested-via-import
  false positive) pushes it to ~41%.
- **The single biggest naked file is `app.js` (9,141 LOC = 11.9% of the whole
  codebase), followed by `server.js` (2,360).** These are exactly the two files that
  carry the live crash paths sibling agents flagged.
- **No jsdom in the repo.** Every DOM-heavy renderer view (`view.js` 2,131,
  `pdf-view.js` 1,509, `directory-columns-view.js` 936, `notebook-cells-view.js` 772,
  `gnuplot-view.js`, `customize.js`, `bookmark-view.js`, `shell-view.js`, …) is either
  naked or exercised only through a recording *wrapper* stub. The real rendering /
  event / measurement machinery never runs under `node --test`.
- **The stdlib Lisp suite is real-logic-but-stubbed-host.** It loads the *real* .lisp
  against a *real* buffer + *real* interpreter, but replaces every host primitive
  (`open-file!`, `save-buffer!`, `current-view`, tree-sitter, faces, view state) with
  a recording no-op. The .lisp control flow is genuinely tested; anything that depends
  on a host primitive's *return value or side effect* is only as correct as the stub.
- **Stub / real divergence is real and demonstrable.** Several stubs return richer or
  different values than the spine's real primitives (e.g. stub `view-modified?` reads a
  test flag; stub `current-view` returns `NIL`; stub file ops never fail). Tests that
  assert on those paths would pass regardless of the spine's real behaviour.
- **CI runs `pnpm test` on every push/PR** (ubuntu+macos × node 22/24). The Electron
  **smoke** job is `continue-on-error` — informational, never blocks. So nothing that
  needs a real screen (app.js, server.js, view rendering) is gated.
- **The pre-commit hook is NOT installed.** `.githooks/pre-commit` exists (branch guard
  + `pnpm test` + secret scan) but `core.hooksPath` still points at `.git/hooks`, which
  contains no `pre-commit`. Local commits run no tests; only CI does.
- **`node --test` with no path arg** is what each package's `test` script runs; in
  `apps/desktop` that transparently discovers `mwb/*.test.js`, `src/*.test.js`, and
  `test/*.test.js`. So `pnpm test` **does** include the mwb spine suite. Good.
- **Regression pinning is strong for extracted/pure logic, weak for the seams.** Most
  P0/P1 bug families that live *inside the spine* are pinned (point clamping, durable
  pane ids, seed-splice index, directive-args-flat, writeString-over-port). The
  families that live in the **naked wrappers** (server.js reload/port-disconnect,
  app.js Cmd-Q save-walk, recovery-dir tmpdir default, Lisp interrupt wiring) are
  **UNPINNED** — nothing would catch a regression.

## Coverage inventory

**Verdict key**
- **TESTED-REAL** — a test imports and exercises the real module's behaviour with
  meaningful assertions.
- **TESTED-VIA-STUBS** — the module (or the Lisp it hosts) runs for real, but the host
  primitives / DOM / I/O it depends on are replaced with recording fakes; correctness of
  stubbed paths is only as good as the stub.
- **PARTIALLY** — some surface tested, large parts (usually DOM/event/measure) not.
- **NAKED** — no test imports it, or it's imported only as a path-string / comment.

### Headline numbers

| metric | value |
|---|---|
| Total non-test source files | 215 |
| Total non-test source LOC | ~77,029 |
| &nbsp;&nbsp;packages/*/src | 38,991 (141 files) |
| &nbsp;&nbsp;apps/desktop src+mwb | 38,038 (74 files) |
| stdlib `.lisp` LOC (SPINE_STDLIB + renderer) | ~13,919 (not counted above) |
| Test files | 173 |
| Test LOC | ~43,525 |
| Literal `test(`/`it(` cases | 3,270 |
| **NAKED LOC** | **~29,167 (37.9%)** |
| &nbsp;&nbsp;of which declarative grammar data | 2,575 (low risk) |
| NAKED counting view.js createEditorView | ~31,298 (~40.6%) |

### The 15 biggest NAKED files

| # | file | LOC | why naked |
|---|---|---|---|
| 1 | `apps/desktop/src/app.js` | 9,141 | renderer client; **0 test imports** (map hits are comment/path strings) |
| 2 | `apps/desktop/mwb/server.js` | 2,360 | `utilityProcess` entry + `parentPort` loop; only its *path* is asserted |
| 3 | `packages/renderer/src/pdf-view.js` | 1,509 | DOM view; no jsdom |
| 4 | `apps/desktop/mwb/view-client.js` | 1,082 | client-side view manager; naked |
| 5 | `apps/desktop/src/files.js` | 1,050 | file open/save/dialog glue; naked |
| 6 | `packages/renderer/src/directory-columns-view.js` | 936 | DOM view |
| 7 | `packages/renderer/src/notebook-cells-view.js` | 772 | DOM view |
| 8 | `packages/renderer/src/gnuplot-view.js` | 632 | DOM view |
| 9 | `packages/renderer/src/customize.js` | 578 | DOM customize UI |
| 10 | `packages/renderer/src/bookmark-view.js` | 570 | DOM view |
| 11 | `apps/desktop/src/shell.js` | 537 | PTY/shell main-process glue |
| 12 | `packages/renderer/src/shell-view.js` | 499 | xterm DOM view |
| 13 | `packages/renderer/src/notebook-cells-engine.js` | 463 | notebook eval engine (renderer copy) |
| 14 | `apps/desktop/mwb/notebook-engine.js` | 463 | notebook eval engine (server copy) |
| 15 | `apps/desktop/src/gnuplot.js` | 383 | gnuplot subprocess glue |

*(Plus `view.js` 2,131 — imported by two text-view tests but its inner editor is
stubbed, so `createEditorView` is naked-in-practice.)*

### Per-package roll-up

| area | verdict summary |
|---|---|
| `packages/buffer/src` (buffer, marker, unicode) | **TESTED-REAL** — pure L2 text model, exercised deeply via `@editor/buffer` (buffer/marker/unicode tests). |
| `packages/storage/src` | **TESTED-REAL** — index/persistence/unicode tests. |
| `packages/lisp/src` (eval, primitives, values, reader, environment, interpreter, modules) | **TESTED-REAL** — reached via `@editor/lisp` barrel; the lisp suite (interpreter, primitives, reader, values, environment, error-and-macro, quasiquote-and-arity, modules, module-system-deeper, interrupt) exercises the evaluator hard. Note: these run against no host, so anything host-shaped is out of scope by design. |
| `packages/pane/src` (tree, layout, pane, navigation) | **TESTED-REAL** — pure binary split tree, via `@editor/pane` (pane, pane-edge tests). |
| `packages/view/src` | **TESTED-REAL** — small VIEW abstraction, via view/view-edge/view-utils tests. |
| `packages/stdlib/src` (buffer/pane/view primitives, latex-*, synctex, path-resolve, index) | **TESTED-VIA-STUBS / PARTIALLY** — `.lisp` control flow real; host primitives stubbed. `buffer-primitives` largely real (real buffer). `latex-*`/`synctex-parse` are pure parsers → **TESTED-REAL**. |
| `packages/renderer/src` pure logic (highlight, folding, fuzzy, brackets, indent-guides, keymap, language-registry, markdown, math-*, projection, runs, splitter, treesitter-*, typeset-math, colour-literals, jmarkdown-scan, mermaid-scan) | **TESTED-REAL** — these are the string/AST/geometry modules with real assertions. |
| `packages/renderer/src` DOM views (view.js, pdf-view, directory-columns-view, notebook-cells-view, gnuplot-view, customize, bookmark-view, shell-view, video-view, image-view, media-view, placeholder-view, element-view, minibuffer, hover-doc, tabline, colour-picker, repl) | **NAKED / PARTIALLY** — no jsdom; at most a wrapper-lifecycle stub test. |
| `packages/renderer/src/languages/*` (35 grammar files, 2,575 LOC) | **NAKED** — declarative tree-sitter query strings; low risk (data, not logic). A few reached via `treesitter-injection`/`language-registry` tests. |
| `apps/desktop/mwb/spine.js` (6,103) | **TESTED-REAL** — the real `createSpine`, 202 cases + 14 sibling mwb suites. |
| `apps/desktop/mwb` supporting (protocol, pane-model, client-buffer, buffer-registry, autosave, session-store, citation-bridge, data-source, atomic-write-sync, pane-client-layout, path-complete, path-resolve, media-kinds, picker-panel) | **TESTED-REAL** — each has a direct suite. |
| `apps/desktop/mwb` naked (server.js, view-client.js, client.js, pane-view-client.js, notebook-engine.js, notebook-output.js, launch.js, *-selftest.js) | **NAKED** — no importing test; selftests are not run by `node --test`. |
| `apps/desktop/src` tested (session, sticky-notes, bookmarks, bookmark-relocate, boot-guard, config-home, element-spec, external-change, face-styles, face-overrides, gnuplot-protocol, host-allowlist, jmarkdown-watch, math-preview-host, metadata, mode-menu-build, pane-focus, project-chooser, project-index, recovery, recovery-controller, server-bridge, server-router-gate, server-view-mount, tree-open, view-warehouse, window-geometry, atomic-write, audio-*) | **TESTED-REAL / PARTIALLY** — direct suites; several are pure-helper extractions. |
| `apps/desktop/src` naked (app.js, files.js, shell.js, gnuplot.js, audio.js, main.js, menu.js, serve.js, splash.js, move-view-mode.js, add-pane-mode.js, process.js, jmarkdown.js) | **NAKED** — no importing test. |

<!-- sections below filled incrementally -->
