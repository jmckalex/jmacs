# app.js — boot, dispatch & directive arm — audit

**Date:** 2026-07-01
**Auditor:** audit agent 4 of 13 (read-only)
**Target:** `apps/desktop/src/app.js` (9141 lines) — the renderer/client entry point under Model B.
**Method:** full read of app.js in chunks, cross-read of `docs/MODEL-B-DISPATCH.md`, `server-view-client.js`, `boot-guard.js`, `server-router-gate.js`, `keymap.js`, `minibuffer.js`, `markdown.js`, `doc-view.js`, `utility-dock.js`, plus `spine.js` / `server.js` / `main.js` / `preload.mjs` for the directive-producer and quit-flow ends. Verified against current code, not comments. `node --check apps/desktop/src/app.js` passes.

| Scope dimension | Coverage |
|---|---|
| Boot/init sequence + TDZ audit | Full — module-level statements enumerated in execution order (deliverable below) |
| Server wiring / reconnect / boot-guard interplay | Full |
| `applyDirective` — every case, args validation, XSS, focus | Full (30+ cases) |
| Key routing (global router, IME guard, pre-mount swallow, RUN_CLIENT_COMMAND gate) | Full |
| `config-snapshot` / `config-apply` / RENDERER_CONFIG_VARS | Full (cross-checked spine.js) |
| `resolved*` helpers + inert-interpreter inventory | Full |
| Renderer host-primitives block | N/A — **the renderer host-primitives object no longer exists** (B7; interpreter deleted). See Architecture. |
| Echo/status/minibuffer client half, performShutdown / soft-quit | Full |
| **Not my territory** (agent 5): views/tablines/panes/buffer-lifecycle/session-restore internals — noted at boundaries only, not audited in depth |

---

## Executive summary

The dispatch arm is in good shape: the inert-interpreter teardown is genuinely complete (no live `interpreter.call`/`.evaluate` remains — every `interpreter` token in the file is now a comment), the documented init-TDZ trap is fixed, directive args are validated with `String()`/`Number()`/`JSON.parse`-in-`try`, and the `resolved*` helpers correctly prefer server-pushed VIEW fields. The systematic TDZ sweep found **no** new module-level read of a later-declared binding.

The worst finding is a **data-safety divergence on quit** (APPB-01, P1): in server mode the renderer no longer tracks buffer dirtiness, so `quitInteractive`'s unsaved-changes check is dead — a native **Cmd-Q / app-menu Quit** therefore skips the server's `save-some-buffers` walk entirely and quits without ever offering to write unsaved server-buffer edits to their files. `C-x C-c` (which routes to the spine's `quit-editor`) does prompt. The server's debounced autosave is the only net, so the newest edits since the last snapshot can be lost silently.

Second: the boot error boundary **stands down before the server view mounts** (APPB-02, P2) — a failure in the async SNAPSHOT/mount round-trip (or a future TDZ in the reconcile) lands past the guard's watch, degrading to a keys-swallowed frozen window with no recovery overlay. Third: the shared `renderMarkdownHtml → marked (unsanitized) → innerHTML` pipeline (APPB-03, P2) is an XSS hazard under a CSP that permits `'unsafe-inline'`; the acute sink (file-sourced sticky-note bodies) is agent 5's territory but the pipeline is app.js's.

Lower-severity: a dead duplicate `switch` case (APPB-04), inconsistent null-guarding of `editorView` across `applyDirective` fold cases (APPB-05), and a documented-but-real config-push drift for three snapshot-only vars (APPB-06).

---

## Findings

### APPB-01: Native Cmd-Q / app-menu Quit bypasses `save-some-buffers` in server mode — unsaved edits never offered to disk

- **Severity:** P1 (data-safety; a normal, habitual path on macOS)
- **Dimension:** Correctness & data safety
- **Location:** `apps/desktop/src/app.js:2198` `quitInteractive`; `:2217` `performShutdown`; `:7983` `onConfirmQuit`; the dirtiness gap at `:3978` (`onServerBuffer`) and `:4421` (`applyTextMountSideEffects` server branch). Producer end: `apps/desktop/src/main.js:502` `before-quit`; `apps/desktop/mwb/spine.js:3334` `quit-editor`.
- **Evidence:**
  - `quitInteractive` gates its confirm on the **renderer's** `dirtyBuffers`:
    ```js
    async function quitInteractive() {
      const dirty = dirtyBuffers.size;
      if (dirty > 0 && !window.confirm(`Discard unsaved changes in ${dirty} buffer(s)?`)) return;
      await performShutdown();
    }
    ```
  - Under Model B the renderer stops tracking buffer dirtiness: `onServerBuffer` sets `currentTextBuffer = mirror` with a **bare assignment** ("under Model B the SERVER owns dirty/autosave, so the renderer dirty-watch is moot", `:3976`), and the server-backed branch of `applyTextMountSideEffects` **early-returns before `watchCurrentBuffer()`** (`:4446`). So `watchCurrentBuffer` stays pinned to the inert boot welcome buffer and `dirtyBuffers.size` is **0** in normal server-mode use.
  - Native quit path: `main.js` `before-quit` → `webContents.send('app:confirm-quit')` → renderer `onConfirmQuit` → `quitInteractive()` → (dirty === 0) → `performShutdown()`. `performShutdown` offers only the **workspace-remember** prompt (arrangement, not documents), then `quitting = true; flushAllMetadata(); recovery.clear(); window.host.quit()`. It never messages the spine to run `save-some-buffers`.
  - `C-x C-c`, by contrast, routes as a key to the spine → `quit-editor` runs the cross-window `save-some-buffers` walk (per-buffer save-to-file), *then* emits the `quit` directive → `performShutdown` (no second check). So the two quit paths diverge: chord saves to files, native quit does not.
  - The only net is the spine's **debounced** autosave (`server.js:1519` `createAutosave`, `:2019` `SIGTERM → shutdownFlushMetadata` flushes the *sidecar metadata*, not buffer text). Recovery snapshots are offered via `*Recover*` on next launch — but they lag the last debounce, and they never write the actual file.
- **Failure scenario:** User edits `report.tex` in server mode, presses **Cmd-Q** (the reflexive Mac quit). No "save changes?" prompt appears (renderer `dirtyBuffers` empty); only "Remember this workspace as…". Enter → app quits, SIGTERM kills the spine. The file on disk is unchanged; the newest keystrokes (since the last ~1 s autosave debounce) are gone, and the user was never warned. Had they pressed `C-x C-c` they'd have been walked through saving.
- **Fix direction:** Native quit in server mode must route the confirm through the spine, not the renderer's dead `dirtyBuffers`. Either (a) have `onConfirmQuit` forward to the spine's `quit-editor` (the same command `C-x C-c` runs) instead of `quitInteractive`, or (b) have `main.js` `before-quit` ask the spine to run `save-some-buffers` and only proceed on its resolution. The renderer-side `dirtyBuffers` confirm is dead code under Model B and gives false assurance.
- **Confidence:** CONFIRMED (traced main→renderer→spine end to end). The *degree* of loss depends on autosave timing, which keeps it off a clean P0, but the missing prompt is unconditional.

---

### APPB-02: Boot error boundary stands down (`markBooted`) before the server view mounts — async mount failures land in a keys-swallowed window with no recovery UI

- **Severity:** P2 (latent crash/freeze; edge trigger, severe consequence)
- **Dimension:** Correctness & data safety
- **Location:** `apps/desktop/src/app.js:9135` (`window.__bootGuard?.markBooted()`); the server-mode boot skips at `:9056` (`if (!serverMode) await sessionController.restore()`) and `:9124` (recovery scan); pre-mount swallow at `:4192`; `apps/desktop/src/boot-guard.js`.
- **Evidence:**
  - `boot-guard.js` catches uncaught `error`/`unhandledrejection` and paints a blocking recovery overlay **only until** `markBooted()` (`state.booted` → `showRecovery` early-returns).
  - In server mode the module body reaches `markBooted()` at `:9135` **synchronously**, because the two `await`s that could yield (`sessionController.restore()`, `scanForRecovery()`) are both inside `if (!serverMode)` guards. But the server view has **not** mounted at that point: the SNAPSHOT→`mountServerView`→`reconcileServerPaneTree` round-trip is driven by a port message, processed only *after* the module finishes (the message queue is drained post-microtask). So `markBooted()` fires while the window still shows the inert boot welcome leaf and the key router is in its **pre-mount swallow** state (`shouldSwallowPreMount` true → every Cmd/Ctrl/Alt chord `preventDefault`'d).
  - If the SNAPSHOT never arrives (spine crash/handshake failure) or the async `reconcileServerPaneTree`/`applyTextMountSideEffects` throws — including a *future* TDZ from adding a read of a later-declared const in that path — the boot boundary is already down. The throw is caught only by app.js's own `reportRendererFault` (`:339`, logs to REPL + flashes minibuffer), which does **not** unblock the window. Result: window painted, chords swallowed, no recovery card, force-quit only.
- **Failure scenario:** The spine `utilityProcess` dies during startup (bad stdlib edit, port transfer race). The window paints the welcome text; the user's keystrokes do nothing (chords swallowed, bare keys edit the throwaway boot buffer). The `boot-guard` overlay — designed for exactly this "painted but frozen" state — never appears because `markBooted` already ran. The user cannot even Cmd-Q cleanly if the dead renderer can't answer the confirm handshake.
- **Fix direction:** Defer `markBooted()` until the first successful server mount (call it from `mountServerView` / the first SNAPSHOT), or keep a lighter server-connection watchdog that re-arms a recovery affordance if no SNAPSHOT lands within N seconds. At minimum, wrap the SNAPSHOT/reconcile entry in a boundary that can re-show a recovery card.
- **Confidence:** CONFIRMED for the `markBooted`-before-mount ordering and the pre-mount swallow. PLAUSIBLE for the frozen-window consequence (depends on a mount-time failure occurring).

---

### APPB-03: `renderMarkdownHtml → marked (no sanitizer) → innerHTML` is an unsanitized HTML sink under a CSP that allows inline handlers

- **Severity:** P2 (security; low attacker-influence on the *directive* paths, high on the shared file-sourced path)
- **Dimension:** Security
- **Location:** `apps/desktop/src/app.js:7426` `renderMarkdownHtml`; `:2337` `displayDocPanel` (show-help/show-apropos bodies, `applyDirective` `:3672`/`:3681`); the sink `packages/renderer/src/doc-view.js:465` (`tmp.innerHTML = buffer.html`); the renderer `packages/renderer/src/markdown.js:93` (`marked.parse`, **no sanitize option**); CSP `apps/desktop/index.html` (`script-src … 'unsafe-inline'`). Shared consumer: `stickyNotes` (`:7440`, `render: renderNoteHtml`) — agent 5's rendering territory.
- **Evidence:**
  - `renderMarkdown` builds HTML with a bare `new Marked({ gfm, breaks })` and no sanitizer; marked passes raw embedded HTML through verbatim. `renderMarkdownHtml` returns it; `displayDocPanel` frames it (`<div class="doc-docstring">${rendered}</div>`) and hands it to `createDocPanel`/`doc-view`, which does `tmp.innerHTML = buffer.html`.
  - The page CSP is `script-src 'self' app: 'unsafe-inline' 'wasm-unsafe-eval'`. Inline `<script>` inserted via `innerHTML` won't execute, but **event-handler vectors** (`<img src=x onerror=…>`, `<svg onload=…>`) DO fire under `'unsafe-inline'`. So an HTML payload reaching this sink is executable.
  - `heading` is escaped (`escapeHtml`, `:2348`), but the **body** is not — it is trusted Markdown→HTML. For `show-help`/`show-apropos` the body is a **server-defined command docstring / apropos list** (not attacker-controlled in normal use → low). The same helper, however, renders **sticky-note bodies** whose content comes from a file's `.godot-metadata` / `.jmacs-metadata` sidecar — **attacker-influenced via a hostile file** — and the hover-doc live-docstring preview (`:7383`, `renderMarkdown(r.source…)`).
- **Failure scenario:** A shared `.jmd`/`.tex` file ships a metadata sidecar whose sticky note is `![x](x "onerror")` / `<img src=x onerror="host.quit()">`. Opening the file renders the note through `renderNoteHtml` (= this pipeline) into the overlay via innerHTML; the handler fires with full `window.host` reach.
- **Fix direction:** Sanitize the marked output before every `innerHTML` sink (a vendored DOMPurify pass, or configure marked to escape HTML), and/or tighten the CSP off `'unsafe-inline'` for scripts. Because the sink is shared, fix it at `renderMarkdownHtml` / the `doc-view` boundary, not per-caller.
- **Confidence:** PLAUSIBLE. The unsanitized pipeline + inline-permissive CSP are CONFIRMED; the acute exploit path (sticky notes) lives in agent 5's module, so I under-claim the reachability. The `applyDirective` doc paths themselves are low-risk (server-authored text).

---

### APPB-04: Duplicate `case 'customize'` in `perKindConfigureFactory` — dead second arm (shadow-family smell)

- **Severity:** P3 (smell)
- **Dimension:** Architecture & consistency
- **Location:** `apps/desktop/src/app.js:6898` and `:6920` (same `switch`).
- **Evidence:** `case 'customize': return configureCustomizeView;` appears twice in the same `switch`; the second is unreachable. Harmless here (identical return), but this is exactly the "duplicate keys silently shadow" family the playbook flags — in `switch` form a future edit that changes one arm and not the other would drift silently, and linters that don't flag duplicate cases won't catch it.
- **Fix direction:** Delete the second `case 'customize'` (line 6920).
- **Confidence:** CONFIRMED.

---

### APPB-05: `applyDirective` fold cases call `editorView.method()` unguarded, unlike the recenter/flash cases

- **Severity:** P3 (latent robustness gap)
- **Dimension:** Correctness & consistency
- **Location:** `apps/desktop/src/app.js:3904` (`fold-toggle` → `editorView.toggleFoldAtPoint()`), `:3907` (`fold-all`), `:3909` (`unfold-all`); contrast the guarded `:3700` (`recenter-current-line`) and `:3708` (`flash-current-line`), both `if (editorView && typeof editorView.recenter === 'function')`.
- **Evidence:** `editorView` is a `let` reassigned on focus/mount; `reconcileServerPaneTree` disposes editor instances (`:3348`) but does not null the `editorView` module variable, so it can transiently reference a destroyed `<text-view>`. The recenter/flash cases defensively typeof-guard; the fold cases do not. An uncaught throw in `applyDirective` propagates through `applyDirectiveDom` (called with no try/catch at `server-view-client.js:612`) up to `port.onmessage`, where only the global `window 'error'` net (`reportRendererFault`) catches it — the directive is lost and a fault is logged.
- **Failure scenario:** A `fold-toggle` directive arrives in the narrow window after a reconcile disposed the focused instance but before `editorView` was repointed → `editorView.toggleFoldAtPoint` throws → directive dropped, fault logged. Low-probability, non-fatal, but inconsistent with the sibling cases.
- **Fix direction:** Guard the three fold cases the same way (`if (editorView && typeof editorView.toggleFoldAtPoint === 'function')`), or wrap the whole `applyDirective` body in a try/catch that reports per-case.
- **Confidence:** PLAUSIBLE (the unguarded calls are CONFIRMED; the destroyed-instance timing is inferred).

---

### APPB-06: Config-push drift — three snapshot-only vars get no live `config-apply`; two read vars are absent from the renderer seed

- **Severity:** P3 (documented staleness gap)
- **Dimension:** Architecture & consistency
- **Location:** `apps/desktop/src/app.js:294` `rendererConfig` seed; the `config-snapshot`/`config-apply` handlers `:3760`/`:3769`; producer gate `apps/desktop/mwb/spine.js:606` `RENDERER_CONFIG_VARS` vs `:626` `RENDERER_CONFIG_SNAPSHOT_VARS`, live-apply gate `spine.js:1936` (`if (!RENDERER_CONFIG_VARS.has(name)) return NIL`).
- **Evidence:**
  - The spine live-pushes `config-apply` **only** for the 7 `RENDERER_CONFIG_VARS`. The 3 snapshot-only vars — `*pane-focus-border*`, `*markdown-preview-follow-cursor*`, `*markdown-preview-debounce-ms*` — are in `RENDERER_CONFIG_SNAPSHOT_VARS` (pushed on connect) but get **no** live `config-apply`. A live customize edit to those three doesn't reach the renderer until the next unrelated chrome re-push. `app.js` reads all three at runtime (`paneFocusBorderMode` `:685`, `previewFollowCursorOn` `:7620`, `previewDebounceMs` `:7665`), so a live toggle silently no-ops until then.
  - The `rendererConfig` seed (`:294`) omits `*math-tooltip-scale*` (read `:4553`) and `*markdown-preview-debounce-ms*` (read `:7665`). Both have inline fallbacks (`|| 1.5`, `400`) and are covered by the connect-time snapshot, so the only exposure is a brief boot window where the default applies before the snapshot lands — acceptable, but the seed is incomplete relative to the read set.
- **Fix direction:** Either add the 3 snapshot-only vars to the live `config-apply` gate (they're already in SPINE_STDLIB so the spine can read them), or accept and document that they are connect-time-only. Add `*math-tooltip-scale*`/`*markdown-preview-debounce-ms*` to the seed for completeness.
- **Confidence:** CONFIRMED (the spine gate and the seed set are both verified).

---

## Architecture observations

### Inert-interpreter inventory — teardown is complete

Every `interpreter` token in app.js is now a **comment** (lines 8, 288, 2439, 3764, 4039, 4325, 5120). There is **no** live `interpreter.call` / `interpreter.evaluate` / interpreter import (`@editor/lisp` is imported only for the pure value model `keyword`/`writeString`, `:33`). The known bug family "inert interpreter reads in a live path" is **cleared** in this file. The `resolved*` helpers that existed to route around the inert interpreter are correct:

| Helper | Line | Reads pushed VIEW field first | Fallback |
|---|---|---|---|
| `resolvedMajorModeName` | 4338 | `buffer.majorModeName` (server-pushed) | `bufferMajorModeName` (flag-off, now near-dead) |
| `resolvedMathPreviewActive` | 4349 | `buffer.mathPreviewActive` (server-pushed) | `isMathPreviewActive` (flag-off) |
| `resolveMathPreviewMode` | 4329 | — | returns `null` (interpreter gone) |

The fallbacks are the retired flag-off path; since Model B is the only mode they rarely run, but they degrade gracefully (typeof-guarded). No state read that *should* use a pushed field was found still going through a dead local map.

### Dead / retired-primitive inventory (renderer host-primitives)

The **renderer host-primitives object is gone** — B7 deleted the renderer interpreter, so there is no big object literal to check for duplicate keys. What remains are JS shims that used to be primitive bodies, now either routed to the server or explicitly stubbed:

| Former primitive | Now | Line |
|---|---|---|
| `set-css-tab-width!` / `set-css-*` | no-op; server pushes `css-knobs` | 2502 (comment), applied `:3744` |
| `set-/remove-audio-metadata!` | direct host I/O via `applyAudioMetadataEdit` (interpreter path dead) | 4986 |
| `snippetDecorationsFor` | returns `[]` (snippets are server-side) | 4268 |
| `refresh-jukebox-labels!` / jukebox auto-advance | server-side; renderer no-op | 2438 (comment) |
| `custom-apply!` re-eval in `config-apply` | replaced by plain `rendererConfig[var] = JSON.parse(...)` | 3779 |
| in-renderer `run-command` (placeholder chooser) | routes to `serverViewClient.runCommand` | 1068 |
| `deliverLispCallback` | plain-JS-only (Lisp-callback arm deleted) | 3175 |

None of these duplicate a live spine primitive with drifted behaviour; they are honest no-ops or host-I/O shims. The one shadow-family smell is the `switch` duplicate (APPB-04).

### Directive-channel completeness

Cross-checked every `onClientDirective(... , NAME, ...)` / `emit-client-directive!` producer in `spine.js` against the `applyDirective` `if/else` chain (`:3662`–`:3946`). **Every emitted directive name has a handler**: `close-window`, `quit`, `show-help`, `show-apropos`, `markdown-preview`, `recenter-current-line`, `flash-current-line`, `markdown-preview-sync`, `theme-apply`, `faces-apply`, `highlight-rules`, `css-knobs`, `config-snapshot`, `config-apply`, `utility-panel-{open,set,append,activate}`, `pdf-reload`, `pdf-synctex-show`, `open-project-dialog`, `remember-project`, `open-project-chooser`, `tree-sitter-query`, `fold-{toggle,all}`/`unfold-all`, `toggle-repl`, `sticky-{add,edit,delete,next,prev,toggle}`, `inline-eval-result`. No orphan producer, no unknown-name case. Unknown names fall through the `if/else` silently (no-op) — acceptable, though a `console.debug('unhandled directive', name)` else-arm would aid future porting.

Args validation is uniformly defensive: `String(args?.[0] ?? '')`, `Number(args?.[1])` + `Number.isFinite`, and `JSON.parse(String(args?.[0] ?? '…'))` wrapped in `try` with a keep-current-on-malformed catch (`theme-apply`, `highlight-rules`, `css-knobs`, `config-snapshot`, `config-apply`). This matches the FLAT/clone-safe contract; no raw-Lisp assumption.

### Boot / init TDZ audit (named deliverable)

Systematic sweep of module-level **executable statements** (not declarations) in execution order, checking whether each can transitively read a binding declared *later* than itself:

| # | Module-level call / stmt | Line | Reads | Later-declared read? |
|---|---|---|---|---|
| 1 | `window.addEventListener('error'/'unhandledrejection', …)` | 364 | `reportRendererFault` → `repl`(2408), `minibuffer`(2249), `recovery`(310) | Only on a *fired* event; try/catch-guarded → safe |
| 2 | server-port `message` listener (serverMode) | 388 | `bootServerViewClient`(`var`, hoisted null), `godotServerPort`(`var`) | `var` hoist → no TDZ |
| 3 | `syncPaneElements()` | 636 | `leafPanes`, `editorHostEl`(537), `paneElements`(550) | none prior-only ✓ |
| 4 | `queueMicrotask(relayoutPanes)` | 639 | (deferred) `splitterHandlesById`(1314) via `refreshSplitterHandles` | microtask runs at first `await` (2546), by which point 1314 is declared ✓ |
| 5 | `new ResizeObserver(...).observe` | 644 | `scheduleRelayout` → rAF-deferred | safe |
| 6 | `refreshPaneFocusIndicators()` | 847 | `activeProjectPath`(654 **hoisted**), `paneElements`, `currentPaneId`(670) | This is the *documented* fix (`activeProjectPath` hoisted above the initial paint) ✓ |
| 7 | `ensureEditorViewForLeaf(initialLeaf)` | 4729 | `highlighters`(2552), closures→`serverViewClient`(2588), `mathTooltip*`(4473) | all prior ✓ |
| 8 | `bootServerViewClient()` (serverMode) | 4110 | `godotServerPort`, `serverViewClient`; `connect()` posts but does **not** sync-process messages | SNAPSHOT deferred post-module ✓ |
| 9 | `hoverDoc`/`inlineEval`/`stickyNotes`/`bookmarks` ctors | 7366–7470 | `editorView`(4731), `currentTextBuffer`(234) | all prior ✓ |
| 10 | `watchCurrentBuffer()`, `editorView.focus()` | 7890 | `editorView`(4731) | prior ✓ |

**Result: no module-level statement reads a binding declared later than itself.** The one cross-`await` case (row 4) is safe because the queued microtask runs at the first top-level `await` (line 2546), after every synchronous declaration up to there. Crucially, in server mode the last top-level `await` is at 2552 (`loadLanguageHighlighters`); the two later `await`s (`sessionController.restore` `:9057`, `scanForRecovery` `:9126`) are both inside `if (!serverMode)`, so from 2552 → 9139 the body runs in one synchronous continuation and no server message is processed mid-body. This is why an early SNAPSHOT cannot hit a half-declared module — but it also means the design is one refactor away from re-introducing the trap (adding a server-mode top-level `await` between 2552 and the late consts would open a real TDZ window). The defensive try/catch guards around `stickyNotes`/`inlineEval`/`hoverDoc` in `onServerBuffer` (`:3979`) and `applyTextMountSideEffects` (`:4432`) anticipate exactly this and are worth keeping.

### Key routing

The global bubble-phase router (`:4155`) is clean: it partitions on `mounted` via the two pure predicates (`shouldGlobalRouterDefer`/`shouldSwallowPreMount`, `server-router-gate.js`), guards `defaultPrevented` / bare-modifier / `targetOwnsKeys` before acting, and only routes held-modifier chords for a focused **non-text** view (bare keys stay with the element — correct for media seek/play). IME/composition is handled one layer down in `view.js` (`:1511`, `composing || event.isComposing || keyCode===229`), not in app.js, so there's no double-guard drift. The `RUN_CLIENT_COMMAND` fallback gate (`:4043`, `if (!elementViewKinds().includes(name)) { minibuffer.message('No command'); return; }`) is **sound** — the spine's M-x fallback forwards any unmatched name, and this refuses anything that isn't a current element-view before it could reach the (deleted) session. `refocusServerView` / the `displayDocPanel` rAF-refocus (`:2378`) correctly guard `minibuffer.isOpen()` so a chained prompt isn't stolen — the dock-focus-steal family is handled.

One minor pre-existing gap: the global keydown listener is registered *after* the highlighter `await`s (`:4155`), so during the ~tens-of-ms highlighter load there is **no** router at all — an early Cmd-W/Cmd-O could hit a native accelerator. Tiny window, not new.

---

## Test coverage

**app.js is entirely outside the suite** (9141 lines, 0 tests; the harness stubs host primitives and never executes app.js bodies). This is the single largest untested surface in the renderer, and it owns the directive landing zone, the boot/mount ordering, and the quit ritual — precisely the areas of APPB-01/02.

Most dangerous consequences of the naked state:
1. **`applyDirective` (30+ cases)** — every case is reachable from the server with attacker-influenceable payloads (file paths, buffer text, JSON blobs). A regression in one case (e.g. dropping a `String()` coercion, or the APPB-05 unguarded call) is invisible to CI. This is the highest-value extraction target.
2. **The quit ritual** (`quitInteractive`/`performShutdown`) — APPB-01 would have been caught by a test asserting "server-mode native quit routes save-some-buffers to the spine."
3. **Boot ordering** — the TDZ trap is a class of bug the suite structurally cannot catch (app.js isn't imported); only `boot-guard.js` (which *is* unit-tested via `installBootGuard(win, doc)` injection) is covered.

Extractable + testable without Electron, in decreasing ease:
- **`applyDirective` as an injected dispatch table.** `server-view-client.js` already proves the pattern (all chrome injected). Lift the `if/else` into a `{ [name]: (args, deps) => … }` map taking injected `{ utilityDock, displayDocPanel, editorView, … }`; each case then unit-tests with fakes (and duplicate-key detection becomes structural). This also fixes APPB-04/05 by construction.
- **Config merge** (`config-snapshot`/`config-apply` → `rendererConfig`) — nearly pure; test malformed-JSON keep-current and the seed/read-set parity (APPB-06).
- **`resolved*` helpers** — pure functions of a buffer object; trivially testable (pushed-field-wins vs fallback).
- **The math-tooltip scheduler** (`scheduleMathTooltip`/`flushMathTooltip`) — pure given an injected `typesetMath`/rAF.

---

## What's solid

- **Inert-interpreter teardown is genuinely complete** — no live interpreter read remains; the `resolved*` helpers correctly prefer pushed VIEW fields (the math-preview / markdown-preview bug family is closed in this file).
- **The documented init-TDZ is fixed and no new one exists** — `activeProjectPath` is hoisted above the initial paint, and the systematic sweep found no later-declared read; the `var`-hoisted port/boot-hook pair avoids the listener-before-boot TDZ correctly.
- **Directive args validation** is uniform and defensive (`String`/`Number.isFinite`/`JSON.parse`-in-`try`, keep-current on malformed), matching the FLAT clone-safe contract; no raw-Lisp-over-the-wire assumption.
- **Directive coverage is complete** — every spine producer has an app.js handler; no orphans.
- **The key router** stands down / swallows via focus-independent pure predicates, guards IME one layer down, and gates `RUN_CLIENT_COMMAND` to element-views soundly.
- **Focus-steal discipline** — `refocusServerView` and the doc-panel refocus both guard `minibuffer.isOpen()`, honoring the `activateUtilityTab`-force-focus hazard the playbook calls out.
- **`boot-guard.js`** is well-designed and *is* unit-testable (injected globals) — the recovery card offers Reload / Reset-layout / direct `app:quit`, the right affordances for a dead renderer. (Its only gap is the stand-down timing, APPB-02.)
- **Preload isolation** — `contextBridge.exposeInMainWorld('host', …)` with no `nodeIntegration`/`eval`/`require` leak into the renderer; the REPL/notebook eval that *does* reach Node goes through the spine round-trip by design, not a renderer capability.

---

## Open questions

1. **APPB-01 intent:** Is the native-Cmd-Q → autosave-only behaviour a *deliberate* "the server autosaves, so don't double-prompt" decision, or an oversight from the dirtiness-tracking move to the server? If deliberate, the divergence from `C-x C-c` (which *does* save-to-file) is surprising and should be documented; if not, it's a save-to-disk gap on the most common quit path. (Architect judgement — the plans don't state which quit path is canonical under Model B.)
2. **APPB-02:** Should `markBooted()` be deferred to the first server SNAPSHOT so the boot boundary covers the mount round-trip? That would also cover a future reconcile-time TDZ. Any reason it must fire at end-of-module instead?
3. **APPB-03 CSP:** Is `'unsafe-inline'` in `script-src` load-bearing (some vendored bundle needs it), or can it be dropped to neutralize the innerHTML-handler vector? If it must stay, sanitizing at `renderMarkdownHtml` is the fallback. (The sticky-note reachability is agent 5's to confirm.)
4. Should the unknown-directive `else` fall-through log (`console.debug`) to aid the next port, rather than silently no-op?

---

## Stats

- **Target:** `apps/desktop/src/app.js`, 9141 lines, read in full (0 skipped).
- **Cross-read:** `docs/MODEL-B-DISPATCH.md`, `server-view-client.js` (976), `boot-guard.js` (186), `server-router-gate.js`, `keymap.js`, `minibuffer.js`, `markdown.js`, `doc-view.js`, `utility-dock.js`, `preload.mjs`, plus `spine.js`/`server.js`/`main.js` for the producer + quit ends.
- **Findings:** 6 total — **P0: 0 · P1: 1 · P2: 2 · P3: 3.**
- **By dimension:** Correctness/data-safety 2 (APPB-01, APPB-02) · Security 1 (APPB-03) · Architecture/consistency 3 (APPB-04, APPB-05, APPB-06).
- **Confidence:** CONFIRMED 3 (APPB-01, APPB-04, APPB-06) · PLAUSIBLE 3 (APPB-02, APPB-03, APPB-05).
- **TDZ sweep:** 10 module-level statements enumerated; 0 later-declared reads found; the documented `activeProjectPath` fix verified in place.
- `node --check apps/desktop/src/app.js`: pass.
