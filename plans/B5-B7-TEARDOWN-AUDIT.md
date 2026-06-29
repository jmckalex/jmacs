# Audit — B5–B7: delete the renderer's Lisp interpreter (fresh reconnaissance)

> **Status:** AUDIT ONLY (2026-06-29). Read-only reconnaissance; no code changed.
> This supersedes the **stale §3** of `plans/MODEL-B-DEFAULT.md` (whose numbers were
> taken at the epic's *start*, before B1–B4). Read that plan for the design;
> read this for the **current blast radius** and the staged work-list.
> Produced by a 5-agent parallel sweep of `app.js`, the stdlib split, the
> primitive registry, the dead-dispatch path, and the build/test surface.

## TL;DR

The teardown is **more tractable than the plan's §3 implies**, because B1–B4 already
moved the genuinely-hard subsystems (faces, themes, customize, docs, highlight rules,
folding, inline-eval, sticky-notes, latex-compile, project, face-info) server-side.
What remains is mostly **dead or inert** code that dies *with* the interpreter, plus a
**short list of genuinely-live responsibilities** that must be rehomed (to a directive
or to plain JS) *before* the interpreter is removed.

**The single biggest risk is not a subsystem — it's the boot-window key trap** (below).

### Then (plan §3, epic start) vs Now (this audit)

| Metric | Plan §3 (start) | Now | Δ |
|---|---|---|---|
| `interpreter.call`/`.evaluate` sites (renderer) | 103 | **83** | −20 |
| …all in `app.js` (no other renderer module) | — | **83 / 83** | — |
| `STDLIB_FILES` (renderer loads) | 66 | **64** | −2 |
| `SPINE_STDLIB` (server loads) | 35 | **43** | +8 |
| Renderer-only `.lisp` (the migrate list) | 31 | **21** | −10 migrated, −2 deleted, +1 new |
| Renderer primitives | "~41" (inline only) | **~257** (157 inline + 101 factory) | plan undercounted |

Of the 83 interpreter sites: **~25 live with effect**, **~14 provably dead**,
**~44 inert/unsure** (run, but against the idle renderer mirror the server supersedes).

---

## 1. What is genuinely LIVE and must be rehomed FIRST

These execute with real effect today. Each must become a directive or plain JS *before*
B7 removes the interpreter, or something breaks.

| # | Responsibility | Sites (app.js) | Rehome to | Notes |
|---|---|---|---|---|
| L1 | ~~Boot faces/theme/highlight CSS compute~~ **✅ RESOLVED — pure deletion, no FOUC** | `-migrate-stale-theme!`, `set-user-faces!`/`set-face-overrides!`, `set-highlight-rules!`/`push-highlight-rules!` (boot install + `installHighlightRules`); `current-theme-css-vars`/`current-face-styles`/`current-mode-face-styles` (in `applyCurrentTheme`/`applyCurrentFaceStyles`) | n/a — already server-driven | **L1 check done (2026-06-29).** The renderer paints **zero** faces at boot — B1 removed the boot `applyCurrentTheme()`/`applyCurrentFaceStyles()` calls (stale comment at app.js:5612 confirms). `applyCurrentTheme`/`applyCurrentFaceStyles` (the only callers of `current-*-styles`) are now reached **only** via `reloadStdlib` (M-r). Boot styling is 100% the spine's `theme-apply`/`faces-apply`/`css-knobs` push. The boot face-state install (`set-user-faces!`/etc.) only feeds `reloadStdlib` — a closed loop with no other consumers, so it **dies wholesale with the interpreter + `reloadStdlib`** in B7. **No FOUC mitigation needed** (boot has relied on the spine push since B1, daily-verified). |
| L2 | ~~Config-var reads~~ **✅ DONE (B0, merged `03439537`)** | was 7 reads → `rendererConfig` cache | **B0 config snapshot** — shipped | Renderer reads config from the plain-JS cache; the `config-snapshot` directive seeds it on connect, `config-apply` refreshes it live. |
| L3 | **User config eval at boot** | 5497 `evaluate(custom.lisp)`, 5514 `evaluate(init.lisp)` | **Spine loads config** (B0). custom.lisp already loads server-side (B1.4). | `init.lisp` on the spine is the biggest *semantic* change — it may call renderer-only primitives; audit + provide spine equivalents/no-ops. |
| L4 | ~~Element-view registry + dispatch~~ **✅ DONE + MERGED** (`78ae8631`, tag `pre-l4-element-views`) | was registry read + `run-command` + override pin | **Plain JS** — shipped | Registry is `ELEMENT_VIEW_SPECS` in `element-spec.js`; `runClientCommand` calls `serverViewClient.openElementView(elementViewOpenPayload(…))` directly. Incl. the bib-search 403 fix (`vouchHostFileUrl` allowlists the bib path). Live-verified. The `element-view-*.lisp` + `open-element-view!` stay until B7. |
| L5 | **REPL** (interactive renderer eval) | 5443 `evaluate(source)` | Spine round-trip (like `NOTEBOOK_EVAL`) **or drop** if redundant with the notebook/inline-eval server eval. | The single interactive entry into the renderer interpreter. |
| L6 | **`config-apply` directive handler** | 6919 `custom-apply!` | Plain JS — apply the pushed value directly instead of evaluating Lisp. | Currently the *handler* itself re-enters the renderer interpreter; must not after B7. |

> **Pivot finding:** L1 (faces/themes) looked like the big remaining cluster (10 live
> calls) but is **already server-authoritative** — the renderer just hasn't stopped
> double-computing at boot. Confirming the spine push fully covers boot (no FOUC) is the
> highest-leverage early check; if it holds, B7's "live" surface is just L2–L6.

---

## 2. The A3 dead-dispatch/session path (dies with the interpreter)

`window.host.serverMode` is now hardcoded `true` (`preload.mjs:20`), so every flag-off
fallback is permanently dead. The local pane tree is fully rebuilt from the server
(`reconcileServerPaneTree` → `buildServerPaneNode`), which is what makes the local
split/placeholder machinery dead.

### Safe to delete wholesale (confirmed dead in server mode)
- **`updateModeline`** body + its **23** call sites (LIVE-WRAPPER; body early-returns at 533). Calls `major-mode-name`/`minor-mode-line`/`snippet-modeline-indicator`.
- **`toggleMinimapForFocusedLeaf`** (8691; guarded *and* unreachable).
- **Local pickers** `startCommandPalette` / `startBufferSwitcher` / `startDescribeCommand` / `startDocSearch` (3025–3205) + their `start-*!` primitives — server drives the real minibuffer/pickers.
- **Placeholder chooser UI** + clone/fill helpers (`configurePlaceholderView`, `cloneViewForPlaceholder`, `fillPlaceholderViaOpen/Command`, `replacePlaceholder`, `buildPlaceholderForSplit`, …) — *but first verify the `splitAndOpenFile` callers (jmarkdown-preview split ~11830, bookmark split) are themselves server-gated.*
- **Local arms** of `configureElementView().insertText` (8791–8797) and `configureBookmarkView` (9725–9763) — **keep the functions** (they have live server arms at 8787 / 9710), delete only the flag-off arm.
- **reftex** picker bridges (8 sites, 9370–9454) and **media/pdf/audio/video singleton** callbacks (8149–8364) + **directory-view** flag-off arms (9117/9131/9688) — superseded by server data-source views.

### Must be PRESERVED or REHOMED (live responsibility hides here)
- **⚠️ The boot-window key trap — THE #1 RISK.** `shouldGlobalRouterDefer` returns `false`
  until `serverViewClient.getView()` is non-null, so in the window between
  `keymapReady=true` and the server view mounting, **the local-dispatch arm (7350–7385)
  absorbs early keystrokes**. Deleting it requires a replacement that **swallows keys
  until mounted** — otherwise boot keystrokes fall through to native menu accelerators or
  throw. Do not blind-delete the router arm.
- **`onMenuCommand`** (11485–11493) — native macOS menu clicks run `(run-command …)`
  against the **inert** interpreter with **no serverMode guard**. Rehome to a server
  command/intent before removing the interpreter. *(Latent bug today — see §4.)*
- **`currentModeMenu` / `refreshModeMenu`** (7428–7466) — still executes in server mode at
  live mount sites (9977, 11492); re-point those at `applyServerModeMenu` or the mode menu
  stops refreshing.
- **`activeSession()` call sites** (~9) go inert via `NULL_SESSION` (wrapper pattern) — fine
  to leave until the cull.

### ✅ CORRECTION — the project subsystem is PORTED + live (verified 2026-06-29)
Agent 4 initially flagged the project machinery as "unported, not dead." **That was wrong**
— corrected after Jason live-tested find-project / project-chooser / close-project working,
and confirmed against the code:
- `project.lisp` **is in `SPINE_STDLIB`**; it defines `open-project` / `find-project` /
  `open-project-chooser!` server-side, which emit the `open-project-dialog` /
  `open-project-chooser` / `remember-project` directives.
- The renderer **handles those directives** (app.js:6961/6978/6969): native dir picker /
  visual chooser → `requestOpenProject` → `MSG.PROJECT_OPEN` → spine → a **new** project
  window. This is the live path (matches B4 project Stage 1–3 in `MODEL-B-DEFAULT.md`).
- **KEEP (live, server-driven JS):** `showProjectChooser`, `requestOpenProject`,
  `rememberProject`, the three directive handlers, `PROJECT_OPEN`.
- **DEAD flag-off (deletes WITH the interpreter, like the rest of the session code):** the
  renderer primitives `open-project!`/`open-project-at!`/`close-project!`/
  `open-project-chooser!`/`current-project` (4412–4450) and the local
  `openProject` (12722) / `closeProject` (12790) / `buildCanonicalProjectLayout` (12558) /
  `buildScratchWorkspace` / `restoreInto` they call — reachable only via the inert renderer
  interpreter.
- **Separate, still-open question (do NOT conflate):** the broader **workspace/session
  manager** (save/restore *all* windows' arrangement, the launch chooser, "Remember this
  workspace?" — memory `project_session_manager`, largely on the unmerged `multi-window-b`
  branch) is a *different* feature from "open a directory as a project." On `main`, the local
  session-restore boot path (12859) is serverMode-gated/dead. Whether a server-side
  workspace-restore exists on `main` is its own audit — out of scope here.

### Flagged uncertainties (app.js has NO test coverage — live-verify)
- **`ensureMajorMode`** (639–649) is **not** serverMode-gated; it's dead-in-effect *only if*
  the server mirror buffer always carries a non-null `majorMode` at mount. Unconfirmed — if
  the mirror is ever `null`, `choose-major-mode!` runs against the inert buffer. Verify or
  gate on `!serverMode`.
- **`recovery.flush()`/`recovery.save()`** on pagehide/blur/visibilitychange (12828–12841)
  and in `watchCurrentBuffer` (615) are **not** serverMode-guarded; confirm `recovery` is
  effectively empty in server mode.

---

## 3. The B0 config-snapshot list (the boot-seed gap)

Direct renderer reads of `*…*` defcustoms through the inert interpreter. The
`config-apply` directive already re-pushes these *on change*; B0 must also **seed them at
boot** so the renderer never needs the interpreter to read a config value.

| # | app.js | variable | feeds |
|---|---|---|---|
| 1 | 355 | `*autosave-recovery*` | autosave on/off |
| 2 | 363 | `*autosave-recovery-interval*` | autosave debounce ms |
| 3 | 2425 | `*pdf-restore-default*` | PDF session-persistence default |
| 4 | 825 | `*pane-focus-border*` (`pane-focus-border-setting`) | pane focus-border draw mode |
| 5 | 9575 | `*placeholder-default-action*` | (dies with the placeholder chooser — see §2) |
| 6 | 11027 | `*markdown-interpreter*` | markdown render engine |
| 7 | 11203 | `*markdown-preview-follow-cursor*` | jmarkdown forward-search toggle |

Indirect/adjacent: `*jukebox-track-format*` (read inside `format-track`, app.js:2189) belongs
in the set; `*directory-tree-open-target*` (9117) is in a **dead** arm — its renderer
consumer is already unreachable (flag mismatch worth noting). The plan's cited line numbers
(366/374/2492/7133/7570) have drifted; the 7 above are current.

---

## 4. Two latent bugs to confirm/triage (independent of the teardown)

Both run `(run-command …)` against the **inert** renderer interpreter with **no
serverMode guard**, so they're reachable today and may silently no-op:
- **app.js:1210** `fillPlaceholderViaCommand` — the placeholder-pane `r` (run-command) action.
- **app.js:11488** `onMenuCommand` — native menu-bar command clicks.

Worth a live check now; they *must* be rehomed before B7 removes the interpreter under them.

---

## 5. Stdlib split — the 21 remaining renderer-only `.lisp`

`STDLIB_FILES` (64) ⊃ `SPINE_STDLIB` (43); the spine list is a clean subset (0 spine-only,
0 orphans, 0 missing). Renderer-only (21): `directory-columns`, `directory-tree`,
`element-view-atari`, `element-view-bib-search`, `element-view-notebook-cells`,
`element-views`, `files`, `help`, `inline-eval`, `jukebox`, `latex-menu`, `latex-synctex`,
`menus`, `palette`, `snippets-keymap`, `sticky-notes`, `system`, `tabline`, `utility-pane`,
`view-menu`, `views`.

**Nuance:** "renderer-only file present" ≠ "subsystem not ported." `help`, `inline-eval`,
and `sticky-notes` were ported by **embedding commands in `spine.js`** (or as data-sources),
leaving these `.lisp` files **redundant** — the renderer still loads them, but they're no
longer the source of truth. The teardown simply stops the renderer loading *all* 64; it does
not need to migrate these 21 one-by-one if their behaviour is already server-side. (Migrated
in B1–B4: `docs`, `face-info`, `faces`, `folding`, `highlight-rules`, `latex-compile`,
`minimap`, `panes`, `project`, `themes`. Deleted: `notebook`, `notebook-commands`. New
renderer-only since the plan: `latex-synctex`.)

---

## 6. Build & test surface (de-risking facts)

- **Only `app.js` imports** `@editor/lisp` / `@editor/stdlib` (39–51, 112–119). No
  `packages/renderer` module does. Resolution is a plain **import map** in
  `apps/desktop/index.html` (24–39) served by `serve.js` (`app://`) — **no bundler**.
  `.lisp` files are `fetch`ed at runtime (`fetchStdlibSource` → `loadStdlib`).
- **B7 build changes are small:** delete the two import-map entries (index.html), the two
  `app.js` import blocks, the `createInterpreter` instantiation (~3603–3900+), and the
  `loadStdlib` boot + hot-reload calls (~5547–5575, ~5622–5631). Keep the `@editor/*`
  packages — the spine still uses them.
- **Zero automated tests break.** No renderer test constructs the interpreter
  (`face-styles`/`face-overrides`/`math-preview-host` tests use stand-ins).
  `server-router-gate.test.js` is a **pure predicate** already shaped as "defer iff server
  view mounted" — **no rewrite needed** (the plan's claim is stale). The two
  `mwb/*-selftest.js` are manual (not in `pnpm test`); just drop their `GODOT_SERVER=1`
  guards. No runtime `process.env.GODOT_SERVER` checks remain except those selftests.

---

## 7. Recommended sequencing (verify-first, then drain, then delete)

Each step its own tested commit + **live-verify**; recovery tag before the B7 deletion.

0. **B0 — config snapshot.** ✅ **DONE + MERGED** (`03439537`, tag `pre-b0-config-push`).
   Renderer reads config from the `rendererConfig` cache; the config-snapshot directive
   seeds it on connect. *(The spine-config-load / `init.lisp`-on-spine half is small here —
   `init.lisp` is empty, `custom.lisp` already loads server-side; deferred to the B7 arc.)*
1. **L1 faces/themes boot coverage.** ✅ **RESOLVED — pure deletion, no FOUC** (code-confirmed
   2026-06-29; see L1 in §1). The renderer already paints zero faces at boot; the faces
   interpreter calls are reloadStdlib-only and die with the interpreter. No mitigation.
2. **L4 element-views → plain JS** ✅ **DONE + MERGED** (`78ae8631`). Registry + dispatch
   are plain JS; bib-search 403 fixed. (Found a *separate* pre-existing bug: element-views
   holding live resources, e.g. the atari emulator's audio, aren't reaped on tab-close —
   `disposeKindView('element')` is correct but isn't called; same seam as `liveBrowsers`/
   `liveProcs`. Deferred — Jason's call to do the core teardown first.)
3. **L5 REPL + L6 config-apply handler** → spine round-trip / plain JS. *← NEXT.*
4. **Rehome the live A3 holdouts** (§2): boot-window key-trap replacement (swallow-until-
   mounted), `onMenuCommand` → server command, `currentModeMenu` refresh → `applyServerModeMenu`,
   verify `ensureMajorMode`. The local **project** functions delete with the interpreter, but
   **keep** the live JS helpers (`showProjectChooser`/`requestOpenProject`/`rememberProject` +
   the directive handlers) — the project subsystem is already server-driven.
5. **B5 drain** — sweep `app.js` to **zero** `interpreter.*`. Anything left is a missed item above.
6. **B6 primitive teardown** — the ~257 primitives + 4 factory spreads die with the
   `createInterpreter` call (they exist only to serve it).
7. **B7 delete** — remove `createInterpreter`/`loadStdlib`/imports/import-map entries +
   the now-orphaned dead dispatch/session code (§2 "safe to delete"). Confirm a bundle/boot
   drop. **Run the full live matrix** (plan §4).

## 8. Open questions for the architect

1. **Faces boot ordering (L1):** acceptable to gate first editor paint on the first
   `faces-apply`, or do you want a cached CSS snapshot seeded into the HTML to avoid any
   boot flash? (Determines step 1's shape.)
2. **REPL (L5):** keep an interactive renderer-eval as a spine round-trip, or retire it
   (inline-eval + notebook already cover server-side eval)?
3. **`init.lisp` on the spine (B0):** any of your personal `init.lisp` that calls
   renderer-only primitives? That's the one real behaviour change to design around.
4. **Workspace/session manager** (distinct from the now-confirmed-ported *project* feature):
   does a server-side workspace-restore exist on `main`, or is "Remember this workspace?" /
   the launch chooser still renderer-side (and thus in B7's path)? Its own small audit when
   we get there — not blocking B5–B7.
