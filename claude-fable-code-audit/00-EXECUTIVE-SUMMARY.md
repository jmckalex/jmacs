# Godot — whole-app code audit — executive summary

**Date:** 2026-07-01 → 07-02 · **Commit:** `main` @ `efe0fa6d` (suite green, 3290 tests)
**Auditor:** Claude Fable 5, orchestrating 13 read-only area agents + an adversarial
verification pass. **Weighting:** port-first (the Model-B seam got the deepest read).
**Dimensions:** correctness & data-safety · security & IPC · architecture & consistency
· tests & coverage.

Read this first, then `FINDINGS.md` (severity-ranked register with per-finding
verification verdicts), then the numbered area reports (`01`–`13`, finding-prefix map
in `INDEX.md`).

---

## The one-paragraph verdict

The Model-B port is, structurally, a success: the spine owns the interpreter, the
directive channel is clean, the inert-interpreter teardown is genuinely complete, the
core paint pipeline is DOM-sink-safe, and the highest-stakes non-port code — the audio
tag **rewriter** that mutates users' music files — is byte-correct with no corruption
path on a normal file. But the port left a **small family of sharp edges that are
individually severe**: an unsanitized-Markdown→`innerHTML` sink in the privileged top
frame that is a **drive-by RCE from a hostile file**; a **whole-app crash** reachable
by ordinary two-window editing because one cursor-offset path was left unclamped and
the spine has no exception net; and the **documented reload shortcut bricks the
window**. None are exotic; all are fixable in a focused sprint, several in one line.

---

## Verified P0 — fix before any wider release

Four P0s (the fourth, the notebook RCE, surfaced in the finish-up pass). Each was
re-verified after the area pass — by an independent adversarial agent, by full inline
code-tracing, or by a reproduced probe.

### 1. Drive-by RCE via a hostile `.godot-metadata` sticky-note  · `MAIN-01` / `APPB-03`
Opening a document whose travelling sidecar carries a sticky note runs attacker JS in
the top frame **with no click**. The note body renders through `marked@18` (no
sanitizer) and is assigned to `innerHTML` in the main document, which holds
`window.host` → `process:run`, `shell:spawn`, arbitrary file write. CSP carries
`'unsafe-inline'`, so `<img src=x onerror=…>` fires. Every hop was traced end-to-end by
the verifier. There is **no sanitizer (DOMPurify or equivalent) anywhere in the repo**;
a secondary same-class sink exists for docstring/help panels (`doc-view.js:465`).
Reassuringly, the verifier also **confirmed the isolation that holds**: webview guests
and the preview iframe do *not* receive `window.host` — the break is from inside the
top frame via file content, not from remote pages.
**Fix:** sanitize or sandbox the note/docstring render; drop `'unsafe-inline'`; ideally
strip `window.host` reach from the note-overlay realm.

### 2. Stale cross-window cursor crashes the whole spine — every window dies · `SPINE-01`
`viewStateOf` (`spine.js:5390`) calls `buffer.positionAt(v.point)` **unclamped**, while
its sibling `pointPosition` (`spine.js:5712`) clamps — the recent freeze-fix covered one
path and not this one. Per-view points are plain numbers in per-client pane models and
do **not** ride another window's edits. So: open one file in two windows, put window A's
cursor near the end, select-all-delete in window B; B's edit fans out via the
**unguarded** `broadcastView` loop (`server.js:585`) → `sendViewTo(A)` →
`positionAt(staleOffset)` on the now-shorter buffer → throw. The spine has **no
`uncaughtException` handler and no respawn**, so the `utilityProcess` dies and every
window with it. This is the *live* generalisation of the restore-freeze the team just
fixed; the edit fan-out path was left unclamped **and** unguarded.
**Fix (defence in depth, each independently sufficient):** clamp in `viewStateOf` (one
line, mirror `pointPosition`); guard the `broadcastView`/`fanDelta` loops per-client;
add a spine-level `uncaughtException` net + respawn.

### 3. Window **reload** permanently disconnects the window · `SRV-01`
The server port is delivered exactly once per window via
`webContents.once('did-finish-load')` (`server-bridge.js:120`). A reload — **View ▸
Reload `Ctrl+Cmd+R`, the exact shortcut CLAUDE.md tells you to use for renderer
edits** (`menu.js:174`) — never re-receives a port, so the reloaded window paints but
has dead keys and no editor, no error surfaced; recovery only by opening a new window.
Confirmed by the area agent with an offscreen Electron probe (`loads=2 delivers=1`) and
re-confirmed by the verifier. Blast radius: the one reloaded window.
**Fix:** re-deliver a port on every `did-finish-load`, or have the renderer request one
on boot when it has none.

### 4. Notebook cells run unsandboxed in the spine's Node process — RCE from a shared notebook · `MWBC-01`
The **second** code-execution hole, distinct from #1. `compileCell`
(`notebook-engine.js:296`) builds cells with `new AsyncFunction`, whose body runs in
the spine's Node **global scope**; the facade params shadow only their own names, so
`process`, `fetch`, and `import('node:child_process')` stay reachable (the re-run
agent's probe ran `execSync`). Eval was **deliberately** moved out of the
CSP-sandboxed renderer into the unsandboxed spine (`server.js:1014` comment). Reachable
in the merged `notebook-cells` feature. **Distinction from #1:** this is *explicit-eval*
(the "Run all" button), not a zero-click drive-by — but "download a shared notebook and
Run all" is normal use, there is no sandbox and no trust/consent gate, and downloaded
notebooks are in the threat model, so arbitrary system access from someone else's
notebook is P0-class. (Two near-identical engines exist — spine + renderer — so any
fix patches both.)
**Fix (a design decision for you):** run cells in a `vm`/worker sandbox with a
capability facade, and gate first-run of an untrusted notebook behind explicit consent.

---

## The cross-cutting themes (why the individual bugs cluster)

Six findings above the fold are really **four root causes**. Fixing the root kills
several findings at once.

**A. The unclamped-`positionAt` family — the single highest-leverage fix.**
The L1 buffer's `positionAt` *throws* on an out-of-range offset (the code says so in
its own comments). The session-restore fix clamped exactly one path. At least **five
other call sites feed it an unclamped, possibly-stale offset**: `viewStateOf`
(`SPINE-01`, P0, whole-spine crash), sticky-note `place` (`DESK-01`, view-mount crash
on a stale anchor), the data-layer motion commands `moveUp`/`Down`/`lineStart`/`lineEnd`
(`DATA-02`, crash), the restore fallback when a file was deleted (`SPINE-02`), and the
client pane-model that never length-clamps `point` (`MWBC-07`, the persistence-time
sibling of SPINE-01). One `clampToLength` helper at the storage boundary — or making
`positionAt` clamp instead of throw — plus a spine exception net, retires the entire
family.

**B. The spine has no safety net.** No `uncaughtException`/`unhandledRejection`
handler, no respawn, and the recent per-send guard (`sendClientState`) covers only the
initial-paint path — **not** the live edit fan-out (`broadcastView`/`fanDelta`,
`SRV-03`/`SRV-05`) or the malformed-message boundary (`SRV-04`). So *any* uncaught
throw anywhere in dispatch takes down every window. Theme A supplies the throws; theme
B makes each one fatal instead of survivable.

**C. Unsanitized content → `innerHTML` in a privileged realm.** `marked@18` with no
sanitizer, `'unsafe-inline'` CSP, `window.host` in the top frame, no DOMPurify in the
tree. File-sourced sticky notes are the drive-by (`MAIN-01`); docstrings/help a
secondary sink; notebook cell svg/html output is another (`MWBC-02`); the (currently
unwired) `markdown-preview.js` srcdoc iframe (`RVK-03`) would be a fourth if enabled.
One sanitize/sandbox utility covers all of them.

**D. tmpdir data-loss, redux.** The 2026-07-01 fix moved the *workspace store* out of
the macOS-swept tmpdir but **did not** move the **crash-recovery snapshots** — the only
post-crash copy of unsaved edits — which still default to `$TMPDIR/godot-mw-b-recovery`
because `main.js` never sets `MWB_RECOVERY_DIR` (`SRV-02`, one-line fix). Compounding
it, two *save-prompt* gaps let edits reach only that autosave in the first place: native
Cmd-Q bypasses the spine's cross-window save walk (`APPB-01`/`APPV-03`), and
close-tab / C-x k kill a modified buffer with no confirm (`SPINE-04`).

---

## Notable P1s beyond the themes

- **`LISP-01` — the interpreter interrupt is built, tested, and never wired.**
  `(while #t)` in any command or in user config freezes the single-threaded spine —
  and thus every window — permanently; C-g can't help (it dispatches through the frozen
  interpreter). The `setStepBudget`/`setInterruptCheck` machinery exists and is reset to
  `Infinity`/`null` on every `createInterpreter`, with no production caller. Verified inline.
- **`LISP-03` — `Object.prototype` names are phantom special forms.** Repro'd:
  `(toString)`→`"[object Undefined]"`, `(hasOwnProperty 1)`→raw uncatchable `TypeError`,
  and a user `(define (toString) …)` is silently uncallable. Null-proto the lookup map.
- **`LISP-04` — `writeString` corrupts non-finite numbers** (Infinity/-Infinity/NaN
  round-trip back as *unbound symbols*). Repro'd. Low day-to-day reachability
  (division-by-zero is guarded; needs float overflow like `1e400`), but it corrupts the
  port format and persisted `custom.lisp` when it does occur.
- **`APPV-01` — media/browser tab close leaks the element** (a closed audio tab keeps
  playing, a closed `<webview>` survives hidden). Area-agent CONFIRMED; not re-verified
  inline (verifier lost to the spend limit).
- **`APPV-02` — server-buffer leak** on closing a tab in a non-`_serverLeafTabline`
  strip (renderer-only close → spine buffer leaks, tab resurrects). The already-known
  bug whose fix sits unmerged on `tabclose-kill-server-buffer`; the *default* close path
  does kill correctly.

**Verification earned its keep:** `LISP-02` (claimed `equal?` stack-overflow at ~5k
list elements) was **REFUTED** by direct repro — flat lists to 100k and nested to 50k
compare fine. One finding removed from the register before it could mislead a fix.

---

## What's solid (audited and found sound — silence ≠ unread)

- **The audio tag rewriter** (`audio-metadata-write.js`, the highest data-loss-stakes
  code in the app): parse→mutate→re-serialise→temp+rename for MP3/MP4/Ogg; syncsafe
  ints, `stco`/`co64` patching, and page/CRC assembly all check out. **No P0 corruption
  path on a well-formed file.** (Edges: no `fsync` before rename `DESK-02`; Ogg drops
  cover art `DESK-03`.)
- **The core renderer paint pipeline is DOM-sink-clean** — tokens, file paths in
  completions, and filenames in tabline/modeline/echo all reach the DOM via
  `textContent`/`className`, never `innerHTML`. rAF-batched render with a degraded
  retry, line virtualisation, highlight caching (no per-keystroke re-tokenise). The
  tabline detachment hazard is correctly defused (capture-phase focus).
- **Remote content is isolated from the host bridge** — webview guests and the preview
  iframe don't get `window.host` (verified against Electron 42 subframe behaviour). The
  RCE is an *internal* sink, not a remote-page escape.
- **The spine primitive layer is disciplined** — no duplicate object keys, no `null?`
  (nil-truthiness respected), directive args flat + clone-safe, embedded-Lisp escapes
  correct. The recurring port traps were not re-tripped.
- **`spine.js` is genuinely tested** — `spine.test.js` drives the real `createSpine`
  (202 cases). The interpreter's TCO, `try`/`finally`, and environments are sound.
- **Atomic writes** cover every user-data file, with an external-change save guard; the
  inert-interpreter teardown and the init-TDZ fix are complete.
- **The stdlib dispatch core is sound** — the `keymap.lisp` prefix-stack and every live
  key-reader (isearch, query-replace, quit-walk, describe-key) observe clean re-arm/abort
  discipline (the quit-walk chord-eating family is *not* present); nil-truthiness is
  disciplined (no `null?` anywhere). No P0/P1 in the 14k-line stdlib.

---

## Coverage picture (`13-tests-coverage.md`)

- **~38% of source LOC sits in NAKED files** (29,167 of 77,029). The two biggest are
  `app.js` (9,141 LOC) and `server.js` (2,360) — **exactly where the live crash paths
  (SPINE-01, SRV-01, SRV-04) live.** `spine.js` itself *is* covered.
- **No jsdom**; every DOM-heavy view runs only through recording stubs. The stdlib Lisp
  suite is real-logic-but-stubbed-host, and stub/real divergence is demonstrable.
- **CI runs `pnpm test` on push/PR, but the Electron smoke job is `continue-on-error`**
  — nothing that needs a real screen gates a merge.
- **Regression-pinning gap:** none of the P0/P1 families here are pinned by a test. The
  highest-value additions are unit tests for `viewStateOf`/`broadcastView` against a
  shrunk shared buffer, the malformed-intent boundary, and the reload port hand-off.

---

## Recommended fix order

**P0 — before wider release**
1. Sanitize/sandbox the Markdown `innerHTML` sinks + drop `'unsafe-inline'` (`MAIN-01`). RCE.
2. Clamp `viewStateOf` **and** add a spine `uncaughtException` net + respawn (`SPINE-01`,
   theme A+B). The clamp is one line; the net makes the whole positionAt family non-fatal.
3. Re-deliver the server port on reload (`SRV-01`). The dev-workflow brick.
4. Sandbox notebook cell execution + a trust/consent gate for untrusted notebooks
   (`MWBC-01`). RCE via a shared notebook (explicit-eval); a design change, so scope it early.

**P1 — the same sprint**
4. `MWB_RECOVERY_DIR` out of tmpdir (`SRV-02`) — one line, data-loss.
5. Route `before-quit` through the spine save walk (`APPB-01`); add confirm before
   `killBufferById` (`SPINE-04`) — save-prompt data-loss.
6. Wire the Lisp interrupt/budget at the dispatch call site (`LISP-01`) — freeze.
7. Guard the `broadcastView`/`fanDelta` loops (`SRV-03`/`SRV-05`); validate message
   shape at the port (`SRV-04`).
8. Fold the remaining unclamped-`positionAt` sites (`DESK-01`, `DATA-02`, `SPINE-02`)
   into the theme-A clamp helper.

**Hardening (P2, batchable)**
Single-instance lock (`SRV-08`/`MAIN-05`); spine-crash respawn + user notice
(`SRV-10`/`MAIN-15`); `file:rename` overwrite guard (`MAIN-08`); `media://` allowlist
(`MAIN-04`); window-open/navigation guard (`MAIN-06`); per-message try/catch in
`server-view-client` (`RVCORE-01`); minibuffer IME guard (`RVCORE-11`); jmarkdown-scan
backtracking (`RVK-02`); browser-view permission handler (`RVK-04`); face-styles CSS
escaping (`DESK-04`); retire the dead `session.js` residue.

---

## Provenance & caveats (read before trusting a count)

- **Method:** 13 area agents read their territory in full and wrote one report each;
  every P0/P1 was then re-verified — by an independent adversarial agent told to
  *refute* it, or (after spend limits killed six verifiers mid-run) by inline
  code-tracing and `node` repros captured in `FINDINGS.md`. Line numbers are `@ efe0fa6d`.
- **Two account limits (session, then monthly spend) repeatedly killed agents mid-run.**
  All 13 area reports are now complete. `03-mwb-client-stack` and `09-stdlib-lisp`
  initially landed as skeletons and were **finished in a dedicated re-run pass** — that
  pass is where the notebook-RCE P0 (`MWBC-01`) surfaced, and it confirmed the stdlib
  dispatch core is sound (no P0/P1 there). Coverage is now even across all areas.
- **Verification status is per-finding in `FINDINGS.md`:** all 3 P0s UPHELD; among P1s,
  several UPHELD inline, `LISP-02` REFUTED, `LISP-04` downgraded on reachability, and a
  few (`APPV-01/02`) still carry the area agent's CONFIRMED label because their verifier
  was lost — flagged as such rather than silently promoted.
