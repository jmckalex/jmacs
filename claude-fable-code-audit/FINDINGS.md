# Findings register — verification verdicts

Living document. Severity-ranked; updated as each P0/P1 is adversarially verified
(by an independent agent where one survived, or inline by the lead auditor by
reading the exact code path). `main` @ `efe0fa6d`. Started 2026-07-01.

**Verdict key:** UPHELD (finding stands at stated severity) · DOWNGRADE (real but
lower severity) · REFUTED (finding is wrong) · UPGRADE · PENDING (not yet
re-verified — carries the area agent's own CONFIRMED/PLAUSIBLE label until then).

Verification note: many verifier subagents were killed mid-run by an account
spend limit and lost their verdicts; those items are being re-verified inline and
are marked accordingly. Two verifier verdicts survived intact (MAIN-01, SRV-01/04).

---

## P0 — user-reachable crash / freeze / data-loss / RCE in normal use

### MAIN-01 / APPB-03 — Drive-by RCE via a hostile `.godot-metadata` sticky-note body
**Verdict: UPHELD-P0 (independently verified, full chain).** Opening (visiting) a
document whose travelling `.godot-metadata` sidecar carries a sticky note detonates
attacker JS in the privileged top frame **with no click** — the note body renders
through `marked@18` (no sanitizer) and is assigned to `innerHTML` in the main
document, which holds `window.host` (→ `process:run`, `shell:spawn`, arbitrary FS
write). CSP carries `'unsafe-inline'`, so an `<img src=x onerror=…>` fires. Chain,
each hop confirmed: sidecar read `spine.js:4217` / `server.js:326` → shipped in
SNAPSHOT `server.js:726` → `renderMarkdownHtml`→`marked.parse` (no sanitize)
`markdown.js:74-99` → `setBody(){ innerHTML }` `sticky-notes.js:246` → top-frame
overlay with `window.host` `preload.mjs:11,546,655` → CSP `'unsafe-inline'`
`index.html:7`. Fires on mount for collapsed notes too. Secondary same-class sink:
`doc-view.js:465` (docstring source — weaker, not a clean drive-by).
**Fix:** sanitize (DOMPurify) or sandbox the note/docstring render; drop
`'unsafe-inline'`; ideally strip `window.host` reach from the note overlay realm.

### MWBC-01 — Notebook cells execute unsandboxed in the spine's Node process (RCE from a shared notebook)
**Verdict: UPHELD-P0 (verified inline; agent repro'd `execSync`), with an
explicit-eval caveat.** `compileCell` (`notebook-engine.js:296`) builds cells with
`new AsyncFunction(...FACADE_NAMES, body)` (lines 301,305). An AsyncFunction body runs
in the Node **global scope**; the facade params only shadow their own names, so
`process`, `globalThis`, `fetch`, and `import('node:child_process')` remain reachable —
the re-run agent's scratchpad probe compiled a body the same way and ran
`execSync('echo pwned')`. Reachable in production: `INTENT.NOTEBOOK_EVAL`
(`server.js:1014`) → `runNotebookCell` (`spine.js:5783`) → the engine; the code comment
says eval was **deliberately** moved out of the CSP-sandboxed renderer into the
**unsandboxed** spine (*"The renderer can't eval… run the cell in the spine's Node
context"*). `notebook-cells` is a merged, live feature.
**Caveat vs MAIN-01:** this is **explicit-eval**, not a drive-by — it fires on the
"Run all" button (`notebook-cells-view.js:126,438`), not on open. But a notebook is a
"download and Run all" workflow (normal use), there is **no sandbox and no trust/consent
gate**, and the audit threat model puts a downloaded notebook in scope — so arbitrary
system access (fs, subprocess, network) from someone else's notebook is P0-class.
Two near-identical engines exist (spine `notebook-engine.js` + renderer
`notebook-cells-engine.js`) — hardening must patch both.
**Fix (design decision — architect's call):** run cells in a worker/`vm` sandbox with a
capability facade, and gate first-run of an untrusted notebook behind explicit consent.

### MWBC-02 — Notebook cell svg/html output → `innerHTML`, unsanitized (secondary XSS)
**Verdict: UPHELD-P1.** Cell output containing `<svg`/html is written to the DOM via
`innerHTML` with no sanitization (`notebook-cells-view.js:347,350`); `inspect()` also
routes any returned string containing `<svg` down the svg path. Secondary to MWBC-01
(which already gives full code exec), but independently an XSS sink for notebook output.
**Fix:** sanitize, or render output in a sandboxed frame.

### SPINE-01 — Stale cross-window cursor crashes the whole spine (every window dies)
**Verdict: UPHELD-P0 (verified inline, full path traced).** Every link confirmed
by direct read:
1. `viewStateOf` (`spine.js:5390`) calls `buf.positionAt(v.point)` **unclamped** —
   while the sibling `pointPosition()` (`spine.js:5712`) *does* clamp
   (`Math.max(0, Math.min(...))`). The defensive fix landed on one path, not this one.
2. `positionAt` **throws** on an out-of-range offset — stated as fact in the code's
   own comments (`spine.js:4973,5010,5708`); the whole `clampRestoredPoints` fix
   exists because of it.
3. Per-view points are **plain numbers** in **per-client** pane models
   (`pane-model.js:26` `{bufferId,point,mark,scrollLine}`); only the *focused* leaf's
   point is written back after an edit (`setFocusedPoint`, `pane-model.js:709`). A
   non-focused window's stored point does **not** ride another window's edits.
4. A shared-buffer edit fans out to every client showing it: buffer edit →
   `onBufferChange`→`fanDelta` (`server.js:409`) and the post-command
   **`broadcastView()`** (`server.js:900,1158`).
5. `broadcastView` is an **unguarded** loop — `for (const c of clients) sendViewTo(c)`
   (`server.js:585`) — and `sendViewTo` calls the unclamped `viewStateOf`
   (`server.js:575`). The recent `sendClientState` per-send guard (`server.js:745`)
   does **not** wrap this path.
6. No `uncaughtException` net in the spine (only SIGTERM/SIGINT/exit) → an uncaught
   throw kills the `utilityProcess` and **every** window.

**Trigger (normal actions):** open one file in two windows/panes; window A's cursor
sits near the end; in window B select-all + delete (or delete-to-end) so the buffer
becomes shorter than A's offset. B's edit → `broadcastView` → `sendViewTo(A)` →
`positionAt(staleOffset)` on the shrunk buffer → throw → whole spine down, all
windows dead, no recovery until relaunch. This is the **live** generalisation of the
restore-freeze the team fixed for one path; the edit fan-out path was left unclamped
and unguarded. Root-shares with SRV-05 (unguarded fan loops).
**Fix:** clamp in `viewStateOf` like `pointPosition` already does (one line), AND/OR
guard the `broadcastView`/`fanDelta` loops per-client, AND add a spine-level
`uncaughtException` net + respawn so no single stale offset can ever be fatal.

### SRV-01 — Window **reload** permanently disconnects the client (dead window)
**Verdict: UPHELD-P0 (independently verified).** The server port is delivered
exactly once per window via `webContents.once('did-finish-load')`
(`server-bridge.js:120`); `attachWindow` runs once per window creation
(`main.js:245`). A reload consumes nothing new — the reloaded page never receives a
port, `bootServerViewClient()` never runs → painted chrome, dead keys, only a
`console.info` the user never sees. No renderer-initiated port-request path exists.
Server drops the old client's pane state on port close (`server.js:509,523`).
**Reachable via the documented workflow:** View ▸ Reload `Ctrl+Cmd+R` and Hard
Reload `Cmd+Shift+R` (`menu.js:174,183`, native `role:'reload'`) — exactly the
chord CLAUDE.md recommends for picking up renderer edits. Blast radius: the one
reloaded window (others keep their ports). Recovery: open a new window.
**Fix:** re-deliver a port on `did-finish-load` for every load (not `once`), or
have the renderer request one on boot if it has none.

---

## P1 — real bug on a plausible path

### SRV-04 — A malformed `intent` message crashes the entire server
**Verdict: UPHELD-P1 (independently verified).** `{type:'intent'}` with no `intent`
field reaches `applyIntent(client, undefined)` (`server.js:1366`); line 816
(`currentEchoId = intent.id`) derefs before the `try` at 832. Boundary guard checks
only `msg` is an object (`server.js:1306`), never `msg.intent`. No `uncaughtException`
net → whole-server crash (every window). P1 (needs a malformed/hostile message, not
a normal action) is the right severity; the trust-boundary gap + whole-server blast
radius are real. **Fix:** validate message shape at `onClientMessage`; wrap the
dispatch switch; add a process-level exception net + spine respawn.

---

### SRV-02 / SPINE-03 — Crash-recovery snapshots written to the macOS-swept tmpdir (data-loss)
**Verdict: UPHELD-P1 (verified inline).** `RECOVERY_DIR = process.env.MWB_RECOVERY_DIR
|| join(tmpdir(), 'godot-mw-b-recovery')` (`server.js:1516`), and `main.js` sets
`MWB_SESSION_SEED` (423), `MWB_CONFIG_HOME` (426), `MWB_SESSION_STORE` (443) but
**never** `MWB_RECOVERY_DIR`. So the post-crash autosave — the only copy of unsaved
edits after a crash — lands in `/var/folders/.../T`, which macOS sweeps after ~3
days. Identical bug family to the workspaces.json store just relocated on 2026-07-01;
the fix for that one didn't cover recovery data. Found independently by two agents.
**Fix:** set `MWB_RECOVERY_DIR = <configHome>/recovery` in main.js (one line), beside
the other three env vars.

### LISP-01 — Interpreter interrupt/step-budget built but never wired → `(while #t)` freezes every window
**Verdict: UPHELD-P1 (verified inline).** eval.js has the full cooperative-interrupt
+ step-budget machinery (`setInterruptCheck`, `setStepBudget`, `LispInterrupt`,
`CHECK_INTERVAL`); interpreter.js:151-152 resets it to `null`/`Infinity` on every
`createInterpreter`, and a repo-wide grep finds **no production caller** of either
setter (only the module's own defs + tests). eval.js's own comment says "in Model B
it *will* read a…" (future tense). So an infinite loop in any command or in user
config spins the single-threaded spine forever; C-g can't help (it dispatches
through the frozen interpreter) → every window hangs, hard-kill only.
**Fix:** at the dispatch call site install a step-budget and an interrupt-check wired
to a C-g / cancel flag; the machinery already exists and is tested.

### LISP-03 — `Object.prototype` names are phantom special forms / silently shadow user defs
**Verdict: UPHELD-P1 (repro'd).** `SPECIAL_FORMS`/lookup is a plain object, so
prototype keys leak. Repro against the real package:
`(toString)` → `"[object Undefined]"`; `(constructor 1)` → the form returned
unevaluated; `(hasOwnProperty 1)` / `(valueOf)` → raw JS `TypeError: Cannot convert
undefined or null to object` (NOT a Lisp error — uncatchable by Lisp `try`, and at
dispatch time swallowed); and `(define (toString) 42) (toString)` still returns
`"[object Undefined]"` — a user function named any of ~12 prototype names is silently
uncallable. Severity sits on the P1/P2 line (naming a fn `toString` is uncommon), but
the raw-TypeError-during-dispatch is the P1-worthy part.
**Fix:** back the special-form + global lookup with a null-prototype map (or guard
with `Object.hasOwn`).

### LISP-04 — `writeString` prints non-finite numbers as barewords that re-read as symbols (corrupts port + persisted config)
**Verdict: UPHELD-P1 (repro'd), with a reachability caveat.** Direct round-trip on
the real package: `writeString(Infinity)`→`"Infinity"`→reads back as the **unbound
symbol** `Infinity` (Sym), not a number; same for `-Infinity` and `NaN`. (`-0`→`0`
and finite floats like `0.1` round-trip fine.) Since the client↔server port and the
persisted `custom.lisp` both round-trip through `writeString`→`read`, a non-finite
value corrupts silently, and one unreadable persisted value can drop all
customizations at boot. **Caveat:** producing a non-finite number takes float
overflow (`1e400`, or `(* 1e308 1e10)` — both confirmed to yield Infinity);
`(/ 1.0 0.0)` is guarded (throws `division by zero`), so day-to-day reachability is
low. Real hazard, uncommon trigger.
**Fix:** print `+inf.0`/`-inf.0`/`+nan.0` (and add reader support) or refuse to
serialize non-finite numbers.

### LISP-02 — `equal?` stack-overflow on ~5k-element lists — **REFUTED**
**Verdict: REFUTED.** Direct repro against the real package: `equal?` on flat lists
of 1k / 5k / 20k / **100k** elements all return `true` with no `RangeError`; deep
*nesting* to 50k likewise. `equal?` does not overflow at any plausible size — the
finding does not reproduce. (The other four LISP findings stand.)

### SRV-04 — malformed `intent` crashes the server — *(verified above under P1)*

### Remaining P1s — carrying the area agents' CONFIRMED label (inline spot-check pending)
- **SRV-03** (unguarded handler paths + no `uncaughtException` net → one throw kills
  the whole server): effectively **UPHELD** as a by-product of the SPINE-01 trace —
  `broadcastView`/`fanDelta` are unguarded loops (`server.js:585`) and the spine has
  no process-level net; SPINE-01 is the concrete exploit.
- **SPINE-02** (restore-of-deleted-file applies an unclamped point to the fallback
  scratch → crash on first keystroke): same mechanism as SPINE-01, high confidence;
  `clampRestoredPoints` early-returns when `registry.findByPath` misses (`spine.js:4990`).
- **SPINE-04** (close-tab / C-x k kill a modified buffer with no confirm): `killBufferById`
  body has no dirty/save/confirm check (confirmed by read); loss window = edits since
  the last debounced autosave.
- **APPB-01 / APPV-03** (native Cmd-Q bypasses the spine save-buffers walk):
  **UPHELD (P1/P2 boundary), bypass CONFIRMED inline.** `before-quit` (`main.js:502`)
  → `app:confirm-quit` → renderer `quitInteractive` (`app.js:2198`), which gates only
  on the renderer's `dirtyBuffers` set — it never invokes the spine's authoritative
  cross-window `save-some-buffers` walk (`spine.js:1845`) that C-x C-c uses. And
  `dirtyBuffers` is unreliable under Model B: the **echoed** delta path (how the
  user's own typing is confirmed) returns at `client-buffer.js:158` **without calling
  `emit()`**, so typed edits never fire the renderer `onChange`→`dirtyBuffers.add`
  (`app.js:513`). Net: native Quit can skip the save prompt for unsaved typed content;
  the only net is the spine autosave — which writes to the swept tmpdir (see SRV-02).
  **Live test to pin P1-vs-P2:** type into a file, Cmd-Q, observe whether a save
  prompt appears. **Fix:** route `before-quit` through the spine `quit-editor` walk.

### DATA-01 / DATA-02 — data-layer motion bugs (report now complete; both re-verified)
- **DATA-02 (P1, CONFIRMED — re-verified with executed repro):** vertical/line motion
  (`moveUp`/`moveDown`/`moveLineStart`/`moveLineEnd`, `buffer.js:576,587,601,610`) passes
  raw `c.point` to `storage.positionAt`/`lineAt`, which **throw `RangeError`** on an
  over-length offset. A stale over-length cursor + one arrow key throws — the **fourth**
  confirmed site of the unclamped-`positionAt` family (with SPINE-01 `viewStateOf`,
  DESK-01 sticky-note `place`, MWBC-07 pane-model). `moveLeft`/`moveRight` already clamp
  and are surrogate-aware — these motion methods are the unguarded outliers. One-line fix
  per method; the family-wide fix is a clamp at the storage boundary.
- **DATA-01 (P1, CONFIRMED — re-verified with executed repro, 3 modes):** vertical
  motion (UTF-16 code-unit math in `positionAt`/`offsetAt`) can land point **inside a
  surrogate pair**, so the next insert/delete splits the emoji into lone surrogates.
  Precondition: an astral char off-column (doesn't fire on plain single-view ASCII typing).
- *Also from the completed sweep:* **DATA-04 (P2)** — `lineStarts` is uncached, so
  `positionAt` is O(n) per call (~31 ms measured at 20 MB) — a large-file typing perf
  cliff; **DATA-03 (P2)** multi-cursor edits aren't one change-group (N cursors → N undos).
  *(The MWBC and STD reports were completed in a dedicated finish-up pass. MWBC added
  the notebook-RCE P0 `MWBC-01` and the notebook-output P1 `MWBC-02` — both recorded
  above. STD found no P0/P1 — the stdlib dispatch core is sound; its five P2/P3 findings
  (`STD-01`..`STD-05`, incl. the `*prefix-arg*` leak on a command error and the C-M-s
  regexp-isearch stub) are in `09-stdlib-lisp.md`.)*
- **APPV-01** (media/browser tab close leaks the element; audio keeps playing): PENDING.
- **APPV-02** (server-buffer tab in a non-`_serverLeafTabline` closes renderer-only →
  buffer leak + tab resurrects): PENDING; note the *default* close path DOES kill.
- **MWBC / STD / DATA / TEST** re-run reports landed compact; their P1s (if any) are
  read from the reports and folded into the executive summary.

