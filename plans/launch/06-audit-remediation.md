# 06 — Audit Remediation & Beta Execution Tracker

_The execution layer beneath the five pillar plans. Where 01–05 say
**what** each launch pillar needs, this doc is the **ordered backlog of
tickets** to work through — derived from the 2026-06-10 code audit, which
read every package and verified its load-bearing claims by running the
code. Each ticket traces back to a pillar plan for the deeper design._

Sibling plans: [01 Packaging](01-packaging-and-first-run.md) ·
[02 Extension onboarding](02-extension-onboarding.md) ·
[03 Stability & data safety](03-stability-and-data-safety.md) ·
[04 Positioning](04-positioning-and-launch.md) ·
[05 Governance](05-governance-and-community.md)

---

## Locked decisions (2026-06-10) and their consequences

| Decision | Choice | Consequence for this plan |
|---|---|---|
| **Product name** | **Commit to "Godot"** | A full rename pass moves onto the critical path (**C1**). Accept the Godot-game-engine SEO/identity collision as a known, monitored risk — flag it in launch copy (Plan 04). `appId` is locked at first release, so finalise it in C1 *before* the first signed build. |
| **Beta platforms** | **macOS + Linux + Windows** | Cross-platform packaging, CI matrix, and per-platform validation are all in scope, not fast-follow. The embedded PTY/shell (`shell.js`) and titlebar styling need per-OS testing (**C5/C6**). This roughly doubles Phase C. |
| **macOS signing** | **Developer ID + notarization** | Apple Developer enrollment is a **latency long-pole — start it today** (**C0**). Notarization must run in CI (**C4/D2**). |

### Long poles — start in parallel with Phase A, today
- **C0 — Apple Developer enrollment** (signing Path B). Latency, not effort.
- **Screencast/demo assets** (Plan 04, Phase D there). The demo *is* the launch; start filming early. Not ticketed here — owned by Plan 04.
- **Windows/Linux CI runners** — confirm availability (GitHub-hosted covers all three).

### Decision gates still open (need the architect, don't block Phase A)
1. Recovery-file location (recommend `userData`) and native Save/Don't-Save/Cancel dialog vs the current renderer `window.confirm` (Plan 03 / branch).
2. Is `github.com/jmckalex/jmacs` already public? Governs urgency of license/governance gaps (Plan 05).
3. ✅ **RESOLVED 2026-06-16** — `appId` is **`com.godot.editor`**, mirroring the
   sibling app Folio's `com.<product>.<descriptor>` structure (`com.folio.taskmanager`).
   Distinct from the Godot game engine's `org.godotengine.godot`. Folio also keeps
   electron-builder config **inline in `package.json`** under a `build` key (no separate
   `electron-builder.yml`) — adopt that convention in C3, and set `productName: "Godot"`.
4. Maintainer model for surge survival (Plan 05).
5. Launch channel/scope (Plan 04).

---

## How to use this tracker

Work top-down **within** a phase; phases A→D gate the launch event, E
overlaps and fast-follows. Each ticket carries: **severity · effort ·
branch · traces-to**, a one-line rationale, the files, and
**acceptance criteria** written to be checkable. "Effort" is ideal
focused time, not calendar time.

Severity legend: **P0** = launch blocker (data loss, can't install,
can't type) · **P1** = fix before or immediately after announce ·
**P2** = polish / fast-follow.

---

## Phase A — Correctness & data safety (P0 release-gate)

> **Go/no-go bar for the whole launch:** a closed beta that produces
> *zero* unresolved data-loss reports. Everything here is P0.

### A1 — Unblock the clean clone
**P0 · 15 min · branch: direct to `main` · Plan 01**
`pnpm install` / `pnpm dev` fail on a one-line placeholder, so a stranger
fails at step one.
- Files: `pnpm-workspace.yaml:48` (`citation-js: set this to true or false` → `citation-js: false`).
- **Acceptance:** fresh `git clone` → `pnpm install` → `cd apps/desktop && ./node_modules/.bin/electron .` launches with no manual fixups, on a machine that has never built this repo.

### A2 — Fix the Unicode delete-corruption bug *(new from audit; verified)*
**P0 · 1 day · branch: `fix-unicode-edit` · Plan 03**
`deleteBackward(count)`/`deleteForward(count)` treat `count` as characters
but operate on UTF-16 code units. Reproduced: `createBuffer('a🎨b'); moveTo(3); deleteBackward(1)`
→ `"a\ud83cb"` (`isWellFormed() === false`) — a lone surrogate, silent
corruption in the core edit path. Markers inside the split pair become
meaningless.
- Files: `packages/buffer/src/buffer.js` (~line 698, the delete branch shown in audit), `packages/storage/src/buffer.js`.
- Fix: make backward/forward delete (and cursor motion by "character")
  surrogate-pair-aware — expand a delete range that would split a pair;
  ideally grapheme-cluster aware for combining marks.
- **Acceptance:** new tests in `packages/buffer/test/` and `packages/storage/test/` covering emoji (astral), combining marks (`e`+U+0301), and CRLF: after any single backspace/forward-delete the buffer text `.isWellFormed()` is always true; deleting "one character" after an emoji removes the whole emoji; a marker adjacent to an emoji ends at a valid boundary after the emoji is deleted. These are the project's **first** Unicode buffer tests.

### A3 — Land the data-safety quartet
**P0 · 1–2 days (mostly built) · branch: `data-safety-phase-a` → merge · Plan 03**
Autosave + `*Recover*` view, `before-quit` dirty prompt, **window-close**
guard, atomic config/session writes, and the renderer error boundary
already exist on `data-safety-phase-a` (commits `08ed49c`, `af0b304`,
`9df61d2`, `c422dd2`, `6de0c98`, `d1e2489`, `b691bad`, `b5fdba3`). They
are unit-green; what remains is the live acceptance test and merge.
- Remaining work before merge:
  1. Live **`kill -9` → relaunch → `*Recover*`** acceptance test (needs Cmd+Q+relaunch; interactive — architect drives or sets up).
  2. A smoke run (mind the backtick trap in `smoke.js` templates).
  3. **Metadata-atomic reconciliation:** route the bookmarks `.godot-metadata` sidecar writer (now on `main`) through this branch's `atomicWrite` (HANDOVER + memory flag this as DUE on merge).
  4. Cmd+W duplication: `8f9ee2c`+`b9e8f04` are already cherry-picked to `main`; expect git to collapse them, close-guard merges fresh.
- Merge with `git merge --no-ff` + a `pre-data-safety` recovery tag.
- **Acceptance:** force-kill the app mid-edit; on relaunch the unsaved buffer is offered in `*Recover*` and restores into the already-open view (not a duplicate); a renderer exception surfaces in the REPL instead of a blank window; all config/session writes go through `atomicWrite`; full suite green incl. `apps/desktop`.

### A4 — External-file-change detection *(new from audit)*
**P0 · ½–1 day · branch: `external-change-guard` · Plan 03**
No mtime/size is recorded at open and none is checked at save, so editing
a file that another tool (e.g. `git merge`) rewrote silently clobbers the
on-disk version.
- Files: `apps/desktop/src/files.js` (record `stat` at `open-file!`; compare at save), a host primitive + a renderer prompt.
- **Acceptance:** open a file, modify it on disk externally, then save in Godot → a "file changed on disk: reload / overwrite / diff" prompt appears; choosing reload loads the disk version; no path silently overwrites a newer on-disk file. Regression test for the stat-compare logic.

### A5 — stdlib load isolation *(new from audit)*
**P0 · ½ day · branch: `stdlib-load-isolation` · Plan 02**
`loadStdlib` evaluates files in one try/catch; a syntax/eval error in any
`.lisp` file aborts the rest, leaving **no commands and a dead keymap** —
and a user's own broken `init.lisp` can do the same, with no way to
recover in-app.
- Files: `packages/stdlib/src/index.js` (~lines 191–202), `apps/desktop/src/app.js` (the load/reload call sites).
- Fix: load the essential core (commands, editing, keymap) first and fail hard only there; wrap each subsequent file (and `init.lisp`) in its own guard, surfacing a per-file warning to the REPL and continuing.
- **Acceptance:** introduce a deliberate syntax error into one non-core stdlib file and into `init.lisp`; the editor still starts with a working keymap and M-x, shows a clear warning naming the failed file, and the rest of the stdlib loads.

### A6 — Global unhandled-error surface *(reinforces A3)*
**P0 · 2 hours · folds into `data-safety-phase-a` · Plan 03**
Beyond the error boundary, ensure top-level `window.onerror` and
`unhandledrejection` route to the REPL (and `console.error` for logs), so
a thrown primitive or rejected promise is never a silent no-op.
- Files: `apps/desktop/src/preload.mjs` / `app.js` top level.
- **Acceptance:** a primitive that throws and a promise that rejects each print a visible REPL error; nothing fails silently.

### A7 — Fix the stale smoke `bufferMenu` arm + per-arm isolation
**P0 · folds into A3 · Plan 03**
Carried by `532379e` on the data-safety branch; verify it lands and that
smoke arms don't bleed state.
- **Acceptance:** `pnpm --filter @editor/desktop smoke` passes deterministically; the bufferMenu arm asserts against the live `*View List*`.

---

## Phase B — Input, i18n & security hardening (P0/P1)

### B1 — IME / composition input *(new from audit; verified absent)*
**P0 · 1 day · branch: `ime-composition` · Plan 03**
`packages/renderer/src/view.js` listens only for `keydown`; there is **no**
`compositionstart`/`compositionend`/`beforeinput` handling anywhere in the
renderer (grep-confirmed). CJK and other IME users cannot reliably type —
a hard blocker for a *public, international* beta.
- Files: `packages/renderer/src/view.js` (~lines 1055–1064, the keydown listener).
- Fix: track an `inComposition` flag; suppress key-command dispatch while composing; insert committed text on `compositionend`.
- **Acceptance:** with a system IME (e.g. Pinyin), composing and committing multi-character input inserts the correct text and does not trigger editor key-commands mid-composition; ASCII typing is unaffected. Add a smoke/manual checklist item (composition is hard to unit-test).

### B2 — Restrict the `app://` `__host__` file route ✅ *(new from audit; verified)*
**P1 · ½ day · branch: `harden-host-route` · Plan 03/05**
**✅ DONE — merged to `main` 2026-06-10 (merge `d40cad8`, feature `b9613a7`); recovery tag `pre-host-route`. New `host-allowlist.js` allowlist (realpath roots, symlink-escape-proof); `host-allowlist.test.js` 8/8 green; PDFs + Markdown-preview images verified live. B3/B4 skipped by architect decision — see those tickets.**
`serve.js` `__host__` reads **any** absolute path with no traversal guard
(the sibling route right below it *is* guarded — this is an
inconsistency). Since the renderer is exactly where untrusted content runs
(any opened markdown/HTML, any extension), a malicious document can
`fetch('app://editor/__host__/<path>')` and exfiltrate via the
CSP-permitted `https:` connect.
- Files: `apps/desktop/src/serve.js` (~lines 112–127).
- Fix: restrict the route to the directories it actually exists to serve (compile output / image roots), via an allowlist of resolved-real-path prefixes; 403 anything else.
- **Acceptance:** `fetch('app://editor/__host__/etc/passwd')` (and a `..`-traversal variant) returns 403/404; legitimate compiled-PDF and relative-image serving still works.

### B3 — Drop `shell:true` from the jmarkdown spawn *(new from audit; verified)*
**P1 · 2 hours · branch: `harden-host-route` (same) · Plan 03**
**⏭️ SKIPPED — architect decision 2026-06-10. Revisit if the markdown command ever becomes settable from untrusted document content; today it's a trusted user preference (`*markdown-interpreter*`).**
`jmarkdown.js:39` spawns a renderer-configurable command through a shell;
config-modifying content can inject arbitrary commands.
- Files: `apps/desktop/src/jmarkdown.js:39`.
- Fix: parse the configured command to an argv array and `spawn(prog, args)` with `shell:false` (mirror `process.js`'s pattern); source still on stdin.
- **Acceptance:** rendering still works for a normal `jmarkdown` command; a command string containing `; rm …` is treated as a literal program name (fails to launch), not executed by a shell.

### B4 — Sanitize sticky-note HTML + tighten CSP *(new from audit)*
**P1 · ½ day · branch: `sanitize-note-html` · Plan 03**
**⏭️ SKIPPED — architect decision 2026-06-10. Sanitizing note HTML and tightening CSP would curtail what users can legitimately put in a sticky note (embeds, inline scripts/styles); the architect chose user capability over this hardening for v0.1.**
`sticky-notes.js:199` sets `innerHTML` from external renderer output, and
`index.html` CSP carries `'unsafe-inline'`.
- Files: `apps/desktop/src/sticky-notes.js:199`, `apps/desktop/index.html` (CSP).
- Fix: sanitize rendered HTML (DOMPurify or a vetted allowlist) before insertion; remove `'unsafe-inline'` from `script-src` (nonce internal scripts) and restrict `frame-src` to `self`/`app:` unless a feature needs more.
- **Acceptance:** a note whose rendered output contains `<script>`/`onerror=` does not execute; normal MathJax/markdown notes still render; CSP no longer allows arbitrary inline scripts.

### B5 — Reap child processes on window/renderer death *(new from audit)*
**P1 · 3 hours · branch: `process-reaping` · Plan 03**
Shell/gnuplot sessions are only torn down on explicit `kill` IPC; an
abnormal window/renderer death orphans child processes.
- Files: `apps/desktop/src/shell.js`, `apps/desktop/src/gnuplot.js`, `apps/desktop/src/main.js` (a `webContents 'destroyed'` listener).
- **Acceptance:** kill the renderer with active shell + gnuplot sessions; no orphaned child processes remain (verify with `ps`).

### B6 — Source locations in user Lisp errors *(new from audit)*
**P1 · ½–1 day · branch: `lisp-error-locations` · Plan 02**
When extension code throws, the REPL shows the message but not *where* —
undercutting the whole "extend it in Lisp" pitch. The reader already
tracks line:col for list forms.
- Files: `packages/lisp/src/eval.js` (thread form/location through), `values.js` (`LispError` carries location), `apps/desktop/src/app.js` (~line 972, the REPL error print).
- **Acceptance:** evaluating a multi-line user function that errors prints the message *and* the source line:col of the offending form; add interpreter tests for `try`/`catch` (currently untested) and for error-location propagation.

### B7 — Metadata schema versioning/migration *(new from audit)*
**P1 · 3 hours · branch: `metadata-migration` · Plan 03**
Session v1→v2 migration is solid, but `metadata.js` hardcodes
`METADATA_VERSION = 1` with no read-time validation/upgrade path —
against the project's "migrate persisted shapes" policy.
- Files: `apps/desktop/src/metadata.js`, `apps/desktop/src/files.js` (read path).
- **Acceptance:** a metadata file with an unknown/older version is migrated or safely rejected (never silently dropped); regression test for the version branch.

---

## Phase C — Packaging, signing & cross-platform (long-pole heavy)

> Build **macOS first** to retire the packaging unknowns, then Linux, then
> Windows. C0 starts on day one.

### C0 — Apple Developer enrollment *(START TODAY)*
**P0 · latency long-pole · Plan 01**
Required for Developer ID signing + notarization (B-path chosen).
- **Acceptance:** Developer ID Application certificate available to the CI signing step.

### C1 — Rename to "Godot" + product identity *(new on critical path from decision)*
**P0 · 1 day · branch: `rename-godot` · Plan 01/05 · ⏳ BUILT — pending live-test + merge (2026-06-16)**
The rename was deferred; it is now committed and gates the first signed
build (appId is locked at release).
- Files: `package.json` + `apps/desktop/package.json` (name/productName), window title (`document.title = "… — editor"`), `INIT_TEMPLATE` comment in `app.js`, `menu.js` branding, an About dialog, `electron-builder` `appId`/`productName`. Keep the `.godot-metadata` sidecar (already on-brand).
- **Acceptance:** running app shows "Godot" in title bar, About dialog, and OS app menu; `appId` is the finalised reverse-DNS string (decision gate #3); no user-facing "editor"/"jmacs" strings remain (internal `@editor/*` package names may stay).
- **Done on `rename-godot`:** title bar (`index.html` `<title>` + `.titlebar-name`, `app.js` 3× `document.title`), `INIT_TEMPLATE` ("Godot configuration" / "Godot equivalent of .emacs"), root `package.json` name `jmacs`→`godot`, **`app.setName('Godot')`** in `main.js` (drives the `role:'appMenu'` About/Hide/Quit labels *and* relocates userData → `…/Application Support/Godot`; the dev `init.lisp` was migrated). `appId` (`com.godot.editor`) + `productName` deferred to C3's packaging config (no `electron-builder` config on `main` yet) — recorded in decision gate #3. Internal-only strings deliberately left: `serve.js` `app://editor/` scheme host, `@editor/*` package names, `data-jmacs-doc` doc attrs, `.jmacs-metadata` *legacy* migration path, gnuplot protocol markers.

### C2 — Version bump
**P0 · 5 min · branch: `rename-godot` (same) · Plan 01 · ✅ DONE on `rename-godot`**
- Files: root + `apps/desktop` `package.json` `0.0.0` → `0.1.0`.
- **Acceptance:** built artifacts are named `Godot-0.1.0.*`.

### C3 — Land + validate electron-builder (macOS) *(highest unknown)*
**P0 · 1–2 days · branch: `packaging-first-run` → validate → merge · Plan 01**
`electron-builder.yml`, entitlements, and a CI scaffold exist on
`packaging-first-run` (`eeafd3e`, `4492b3e`) but have **never been built**.
The risky unknowns: ESM `main.js` + `sandbox:false` under asar; dynamic
`import()` of language modules over `app://`; pnpm symlink dereference for
`pdfjs-dist`/`@xterm`; `?list` directory scans from packaged Resources;
`serve.js` `repoRoot` repoint for the packaged layout.
- **Acceptance:** an unsigned `.dmg`/`.app` builds and, when launched, can: open + render a PDF, open a working shell PTY, syntax-highlight a tree-sitter language (proves dynamic import + wasm load), and open a directory (proves `?list`). Document any layout fixes in the plan.

### C4 — macOS signing + notarization
**P0 · ½–1 day (after C0) · branch: `packaging-mac-sign` · Plan 01**
- Files: `electron-builder.yml` (sign config), `entitlements.mac.plist` (hardened runtime, JIT), notarization step.
- **Acceptance:** a signed+notarized `.dmg` installs by double-click on a clean Mac with no Gatekeeper override; `spctl -a -vv` reports accepted.

### C5 — Linux packaging + platform-assumption audit
**P0 · 1–1.5 days · branch: `packaging-linux` · Plan 01**
Audit and fix macOS-only assumptions surfaced in the audit: `titleBarStyle: 'hiddenInset'` (cosmetic, safe), any Cmd-only key logic, font-name assumptions, the `open` command, PTY behavior.
- **Acceptance:** an AppImage (and/or `.deb`) launches on a stock Ubuntu; shell PTY, file open/save, and highlighting work; keybindings usable (Super/Ctrl mapping sane).

### C6 — Windows packaging + PTY
**P0 · 1.5–2 days · branch: `packaging-windows` · Plan 01**
The embedded shell is the main Windows risk (ConPTY vs the python-PTY helper in `shell.js`); also path separators and CRLF.
- **Acceptance:** an NSIS installer runs on Windows 10/11; file open/save (CRLF preserved), highlighting, and a usable shell all work or shell degrades gracefully with a clear message.

### C7 — File-metadata preservation on save *(new from audit)*
**P1 · 3 hours · branch: `save-fidelity` · Plan 03**
Atomic write resets mode bits and doesn't handle BOM; verify CRLF round-trips.
- Files: `apps/desktop/src/atomic-write.js`, `files.js`.
- Fix: read original `stat().mode` and `chmod` back after rename; strip/preserve BOM consistently; confirm CRLF is preserved on save.
- **Acceptance:** saving a `chmod +x` script keeps its exec bit (all platforms where applicable); a CRLF file stays CRLF; a BOM file round-trips without a stray `﻿` in the buffer.

---

## Phase D — CI, docs & feedback channel

### D1 — CI test + smoke matrix
**P1 · ½ day · branch: `ci-test` · Plan 01**
No `.github/` exists on `main`.
- Files: `.github/workflows/test.yml` — `pnpm test` + `pnpm --filter @editor/desktop smoke` on macOS, Linux, Windows; runs on PRs and `main` pushes.
- **Acceptance:** green matrix on all three OSes; a deliberately failing test reds the check.

### D2 — CI release pipeline
**P1 · ½–1 day · branch: `ci-release` · Plan 01**
Land the `release.yml` scaffold from `packaging-first-run`, extend to all three OSes, wire in macOS notarization (C4) and artifact upload to a GitHub Release on `v*` tags.
- **Acceptance:** pushing a `v0.1.0` tag produces signed/notarized mac + linux + windows artifacts attached to the release.

### D3 — Beta README + issue templates + feedback channel
**P1 · ½ day · branch: `beta-docs` · Plan 04/05**
- Files: `README.md` (download links, Gatekeeper/`xattr` note even though signed — for older betas, install steps per OS, **Known Limitations (beta)**, config-path-per-OS, "Report a Bug" link); `.github/ISSUE_TEMPLATE/bug.yml`.
- **Acceptance:** a stranger can read the README, download the right artifact, install, find where config lives, and file a structured bug report.

### D4 — Documentation refresh
**P1 · 1 day · branch: `docs-refresh-2` · Plan 02/04**
The `docs-refresh` branch (1970 insertions) predates bookmarks/snippets/games/find-file and the rename. Rebase/refresh it (a "refresh-of-the-refresh"), update `MANUAL.jmd`, add a GETTING-STARTED / config guide and the "first extension in 5 minutes" on-ramp (Plan 02), and ensure `docs/build/` is generated for the in-app `app://docs/`.
- **Acceptance:** in-app docs and `MANUAL.jmd` reflect current features and the "Godot" name; the Lisp on-ramp tutorial works end-to-end.

### D5 — License attribution
**P2 · 2 hours · branch: `attribution` · Plan 05**
GPL-3.0 core is compatible with all bundled deps (MIT/Apache-2.0), but
there's no consolidated notice.
- Files: `ATTRIBUTION.md` or `LICENSES/` (MathJax Apache-2.0, tree-sitter + grammars MIT, pdf.js Apache-2.0, xterm MIT, marked MIT, citation-js); copyright line in `LICENSE`.
- **Acceptance:** every bundled third-party component has its license recorded; nothing GPL-incompatible ships.

---

## Phase E — Test backfill & performance (overlap / fast-follow)

### E1 — Render-loop & view-lifecycle tests
**P2 · 2–4 days · branch: `renderer-tests` · Plan 03**
`view.js` (1,364 LOC, the core render loop) has **zero** tests; ~55% of
renderer view code is untested.
- **Acceptance:** smoke/integration tests for view.js (virtualization: only visible lines in DOM; math-widget mount/cleanup on scroll; fold persistence) and lifecycle tests for `text-view.js` / `tabline-view.js` (setBuffer, destroy unsubscribes, reconnect reuses instance).

### E2 — Interpreter test gaps
**P2 · ½ day · branch: `lisp-tests` (or with B6) · Plan 02**
- **Acceptance:** tests for `try`/`catch` binding, macro variable-capture (documents the intentional non-hygienic behavior), quasiquote nesting >2 and over vectors/maps, lambda arity errors.

### E3 — Large-file responsiveness
**P2 · 1–2 days (cache cheap; async parse larger) · branch: `perf-largefile` · Plan 01/03**
Two compounding costs found: `lineStarts()` is recomputed O(n) on **every**
position query (`storage/src/buffer.js:117`, uncached), and tree-sitter
parses the **whole buffer synchronously in the render loop**.
- Fix order: (1) memoize the line-start table with edit invalidation — cheap, big win, possibly pull into Phase A/B; (2) idle-debounce highlighting + a file-size guard; (3) defer incremental/worker tree-sitter parse.
- **Acceptance:** cursor movement and typing in a 50k-line file stay responsive (no per-keystroke full rescan; highlight does not block input); a perf regression test on a large buffer.

### E4 — Deferred to post-beta (explicitly out of scope for v0.1)
Rope/piece-table storage rewrite; `app.js` (9,175 LOC) decomposition into a
domain-organized primitive registry; hygienic macros; auto-update
(`electron-updater`); undo grouping + stack bound *(optionally pull
forward — cheap and user-visible; decide during Phase A)*; extension
registry.

---

## Suggested first-week order (concrete)

1. **Day 1:** A1 (clone unblock) → push. Start **C0** (Apple enrollment) and kick off Plan 04 screencast filming in parallel. Begin **A2** (Unicode fix).
2. **Day 1–2:** Finish A2 with tests. Begin **A3** prep — run the live `kill -9 → *Recover*` test, do the metadata-atomic reconciliation.
3. **Day 2–3:** Merge **A3** (`pre-data-safety` tag). **A5** (stdlib isolation), **A6** (error surface), **A7** (smoke) ride along / verify.
4. **Day 3–4:** **A4** (external-change). Then **B1** (IME) — the other "can't use it" blocker.
5. **Day 4–5:** Security batch **B2/B3/B4** (one or two branches), **B5** (process reaping).

By end of week one the P0 *correctness/safety/input* set (A1–A7, B1–B5)
should be merged, clearing the launch's data-loss go/no-go bar and the
"can't type" bar — leaving Phase C (packaging, the heaviest now that all
three platforms are in scope) and Phases D/E to fill the remaining time
while the Apple enrollment and screencast long-poles mature.

---

## Traceability — audit finding → ticket

| Audit finding | Severity | Ticket |
|---|---|---|
| Unicode delete corruption (verified) | CRITICAL | A2 |
| No autosave / crash recovery on main | CRITICAL | A3 |
| No external-file-change detection | CRITICAL | A4 |
| No IME/composition handling (verified) | CRITICAL | B1 |
| `pnpm install` broken (citation-js) | CRITICAL | A1 |
| `__host__` arbitrary file read (verified) | HIGH | B2 |
| `shell:true` in jmarkdown (verified) | HIGH | B3 |
| Sticky-note innerHTML + CSP unsafe-inline | HIGH | B4 |
| One bad .lisp bricks the editor | HIGH | A5 |
| User Lisp errors lack source location | HIGH | B6 |
| Hard-close / zombie processes | HIGH | A3 (close-guard) + B5 (reaping) |
| `lineStarts()` O(n) + sync tree-sitter parse | HIGH | E3 |
| Metadata schema migration | HIGH | B7 |
| No packaging / no CI / no version | CRITICAL (release) | C1–C3, D1–D2 |
| Naming collision (Godot) | release risk | C1 + Plan 04 copy |
| No undo grouping / unbounded stack | MEDIUM | E4 (optional pull-forward) |
| File mode / BOM / CRLF on save | MEDIUM | C7 |
| view.js zero tests; interpreter gaps | MEDIUM | E1, E2 |
| app.js god-file (9,175 LOC) | MEDIUM | E4 (post-beta) |
| License attribution | LOW | D5 |
