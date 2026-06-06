# 03 — Stability & Data Safety

**Pillar:** Before strangers use it, jmacs must not crash and must never
lose their work.

This plan is grounded in the current `main` (`2f6e970`, 1725 tests green).
It is a planning document — nothing here is implemented yet. Every claim
cites the file/line it came from so the work can start without
re-discovery.

The ordering principle: **data loss is P0.** A crash that loses no work is
recoverable embarrassment; a clean exit that silently discards an
afternoon's editing is the thing that makes a stranger never open the app
again. Crashiness is P1. Performance cliffs on real files are P2 but can
*cause* both of the above, so they are not optional.

---

## 0. Executive findings (the concrete state today)

| Area | State on `main` | Severity |
|------|-----------------|----------|
| **Atomic save** | `file:save` is a bare `writeFile(target, content)` (`apps/desktop/src/files.js:368`). A crash or power loss mid-write truncates the user's real file. The audio-metadata writer already does the temp+rename dance (`files.js:650`), so the pattern exists in-repo but was not applied to the main save path. | **P0** |
| **Cmd+Q bypasses the dirty check** | The macOS app menu uses `{ role: 'appMenu' }` (`apps/desktop/src/menu.js:60`), whose native **Quit** calls Electron `app.quit()` directly. There is **no `before-quit` / `will-quit` handler** in `main.js` (it only has `window-all-closed`, `main.js:83`). The dirty-buffer confirmation lives only in the renderer's `quitInteractive()` (`app.js:2449`, `window.confirm`). So **Cmd+Q / native Quit discards unsaved changes with no prompt.** | **P0** |
| **No autosave / backup / recovery** | Grep finds zero autosave, backup, or recovery code. `session.js` persists only the *pane tree + file paths + point/mark* — never buffer **contents** (`session.js:178`, the text-view blob is `{path, point, mark}`). A crash with unsaved edits in a file-backed buffer loses them; a crash with an unsaved *new* buffer (no path) loses it entirely — `session.js` `isEphemeral` drops path-less buffers (`session.js:122-123`). | **P0** |
| **No renderer error boundary** | No `window.onerror`, no `unhandledrejection` listener anywhere in `apps/desktop/src` or `packages/renderer/src`. The render loop is a single `requestAnimationFrame(render)` (`view.js:970`); an uncaught throw inside `render()` kills the rAF chain — the editor stops repainting (frozen, not white-screened, but equally dead). No `uncaughtException` handler in main either. | **P1** |
| **Whole-buffer reparse every keystroke** | Tree-sitter highlighting calls `parser.parse(text)` on the **entire buffer** each render (`treesitter.js:209,250,284`), with `tree.delete()` after — **no incremental `tree.edit()`**. The view-level cache (`view.js:567-588`) only skips reparse when the *text is unchanged* (i.e. scroll-only). Every keystroke in a tree-sitter buffer re-parses + re-queries the whole file. | **P2** |
| **L1 storage is a flat JS string** | `packages/storage/src/buffer.js:92-94` builds every edit as `text.slice(0,start)+inserted+text.slice(...)` — a full re-allocation of the buffer per edit. The header explicitly notes it is "to be replaced by a piece tree behind this exact public API" (`buffer.js:11`). No file-size guard on open (`files.js:264` reads the whole file as one UTF-8 string). | **P2** |
| **Smoke `bufferMenu` arm** | Pre-existing failure: tests an obsolete UI. `C-x C-b` now opens an **HTML `view-list-view`** (`view-menu.lisp`, `app.js:6031`), not the old text `*Buffer List*`; the arm presses `C-x C-b`, then `JSON.parse((buffer-text))` and dies "No number after minus sign" (`smoke.js:1429`). It aborts the smoke before ~30 later arms run. | **P1 (test infra)** |
| **Testing gap** | ~1725 unit tests, but they **stub the host primitives** (per CLAUDE.md) — the real bodies in `app.js` (8646 lines) never execute under `pnpm test`. Real-DOM coverage is only the one smoke script, which currently *can't finish* because of the `bufferMenu` abort. | **P1** |

---

## 1. Pre-launch QA checklist

A gating checklist. Nothing ships public until every **[P0]** box is
checked and demonstrated *in the running app* (not just green tests —
CLAUDE.md warns the suite stubs primitives).

### Data safety (P0 — blocking)
- [ ] Saving a file is **atomic**: kill `-9` the app mid-save (large file,
      slow disk) → the file on disk is either fully old or fully new, never
      truncated.
- [ ] **Cmd+Q / native Quit** with unsaved changes prompts (Save / Discard /
      Cancel) — and Cancel actually aborts the quit.
- [ ] Closing the **last window** (`window-all-closed` on non-mac, or
      `Cmd+W`) with unsaved changes prompts.
- [ ] **Crash recovery**: force-crash with unsaved edits (file-backed *and*
      a path-less new buffer) → on relaunch the user is offered the recovered
      content.
- [ ] **Autosave** writes recovery snapshots on an interval and on blur;
      verify the recovery file exists after editing without saving.
- [ ] A failed save (read-only file, full disk, permission denied) shows a
      clear error and **does not** clear the dirty flag (`app.js:2400`
      currently clears it only on success — verify the failure path keeps it).
- [ ] Opening a file the editor cannot read (binary, huge, permission) fails
      gracefully — no crash, a readable message.

### Crash resistance (P1)
- [ ] A throwing extension command (defcommand that errors) surfaces the
      error in the REPL and **leaves the editor usable** — does not freeze the
      render loop.
- [ ] A throwing *render* path (malformed overlay, bad widget) is caught and
      the editor keeps repainting.
- [ ] An infinite loop in user Lisp does not hard-hang the UI with no escape
      (see §3 on a Lisp step budget / interrupt).
- [ ] A malformed `session.json`, `custom.lisp`, `init.lisp`, `faces.json`,
      or `panes.json` does not prevent startup. (`session.js` already
      degrades to empty on bad JSON, `files.js:592` returns null on parse
      fail — *verify the custom.lisp eval path is equally defensive*.)
- [ ] Restoring a session whose files were **deleted/moved** since last quit
      degrades to scratch, not a crash (`session.js:566` swallows open
      failures — verify in the running app).

### Performance (P2 — see §5 for targets)
- [ ] Typing in a 10 k-line code file (tree-sitter language) stays at
      interactive latency (< ~50 ms/keystroke).
- [ ] Opening a 10 MB text file does not hang the UI for seconds.
- [ ] Scrolling a long buffer stays smooth (virtualization already exists,
      `view.js:537-545`; confirm it isn't defeated by re-highlight).

### Sanity / smoke
- [ ] `node --check apps/desktop/scripts/smoke.js` passes (backtick-trap
      guard, MEMORY: `feedback_smoke_arm_backtick_trap`).
- [ ] The smoke script **runs to completion** (after the §2 fix) and all arms
      pass.
- [ ] `pnpm test` green at root.

---

## 2. Fix the smoke `bufferMenu` failure + broaden smoke coverage

### 2a. Root cause (diagnosed)

`smoke.js:1396-1478` (`bufferMenu` arm) tests a UI that no longer exists.
It:
1. presses `C-x C-b`, expecting the old **text** `*Buffer List*` buffer
   with `d`/`x` row commands;
2. reads it back with `JSON.parse((buffer-text))` (`smoke.js:1429`).

But `C-x C-b` → `buffer-menu` → `open-view-list!` now opens an **HTML
`view-list-view`** (`packages/stdlib/lisp/view-menu.lisp`,
`apps/desktop/src/app.js:6031`, replacing the old text menu — the lisp
file's own header says so). On that view `(buffer-text)` does **not**
return a JSON string; `JSON.parse` hits a bare `-` (a dash in the
rendered table / view name) and throws **"No number after minus sign"**,
which is exactly JSON's error for `-` not followed by a digit. The throw
aborts the whole `did-finish-load` handler, so every arm after
`bufferMenu` (jukebox, media-views, splitters, docs, faces, …) never runs.

It is **not** a product bug and **not** from recent work (HANDOVER confirms
it reproduces on the base commit). It is a **stale test** asserting against
removed UI.

### 2b. The fix (rewrite the arm against the live view-list)

Effort: **~half a day.** Rewrite `bufferMenu` to test the *current*
contract:
- press `C-x C-b`; assert the active view is the `view-list` kind
  (`(view-name)` returns `*View List*`, or query
  `document.querySelector('view-list-view:not([style*="display: none"])')`);
- assert the table has one row per open view, and that seeded buffers
  (`bm-target.txt`, `bm-keep.txt`) appear as rows
  (`.view-list-row`-style selectors in `view-list-view.js`);
- click a row's ✕ to kill that view and assert it disappears from the
  table and from `(view-list)` (the primitive array, `app.js:6031` region);
- click a row body and assert it switches to that view.
- **Do not** `JSON.parse((buffer-text))` — read the DOM table directly.
  (Keep the `(view-list)` *primitive* check as the data assertion, since
  `view-menu.lisp` is explicit that the bare name is the data primitive.)

Defensive hardening so a single arm can never again silently swallow the
rest of the run (§2c).

### 2c. Make smoke resilient + broaden it

Effort: **~1–1.5 days.**

1. **Per-arm isolation.** Wrap each arm in its own try/catch that records
   `{arm, ok, error}` and continues, then `finish()` with an aggregate at
   the end. Today a single throw in any `executeJavaScript` block kills the
   whole run (the outer `try` at `smoke.js:239` catches *after* all arms).
   This is the structural reason one stale arm hid 30 others.
2. **Add critical-flow arms that don't exist yet** — the flows that, if
   broken, lose data or brick the editor. Priority order:
   - **Atomic save round-trip**: save, corrupt-interrupt simulation
     (write a huge buffer, assert temp file appears then renames). At
     minimum: save to a path, mutate, save again, assert no `.tmp`/partial
     residue and correct content.
   - **Dirty-buffer quit guard**: dirty a buffer, invoke the quit path,
     assert the confirm is reached (stub `window.confirm`) — covers the §4
     fix once it lands.
   - **Autosave/recovery** (once §4 lands): edit without saving, fire the
     autosave, assert a recovery file exists and round-trips.
   - **Error boundary** (once §3 lands): submit a throwing `defcommand`,
     assert the editor still renders after (type a char, see it appear).
   - **Large-file smoke**: open/insert a few-thousand-line buffer, assert
     virtualization holds (`lineDivs` small, `scrollHeight` large — the
     `virtual` arm at `smoke.js:881` does 400 lines; bump one variant to
     ~20 k and assert it completes under a wall-clock budget).
3. **CI-ize the smoke.** It needs an Electron runtime, so it's out of
   `pnpm test`; add a separate `pnpm --filter @editor/desktop smoke` step to
   pre-launch CI (headless via `xvfb` on Linux), with the per-arm summary as
   the artifact.

---

## 3. Renderer error boundary / graceful degradation

**Goal:** one bad extension, one malformed buffer, or one edge case must
not freeze or brick the editor. Today there is no safety net at all.

### 3a. Global handlers (effort: ~half a day)
- Add `window.addEventListener('error', …)` and
  `window.addEventListener('unhandledrejection', …)` in `app.js` startup.
  On fire: log to the REPL/eval-log (`pushEvalLog`, `app.js:7502`), show a
  non-modal toast/minibuffer message, and — crucially — **trigger an
  immediate autosave/recovery flush** (§4) so a crash-loop can't eat work.
- Add `process.on('uncaughtException')` + `'unhandledRejection'` in
  `main.js` so a main-process throw logs instead of dying silently; and a
  `webContents.on('render-process-gone')` handler that, on relaunch, points
  the user at recovery files (the smoke already listens for this event,
  `smoke.js:234` — reuse the shape).

### 3b. Wrap the render loop (effort: ~half a day)
- Wrap the body of `render()` (`view.js:~970`) in try/catch. On throw:
  keep the rAF chain alive (re-arm `schedule()`), fall back to a
  *highlight-free* render of the visible window (plain text, no overlays),
  and surface the error once (not every frame). The single most important
  invariant: **a throw in highlighting/overlays must never stop repaint.**
  The tree-sitter call already has a local try/catch that nulls `perLine`
  (`view.js:580`) — generalize that discipline to the *whole* render.

### 3c. Sandbox extension command execution (effort: ~1 day)
- `defcommand` / keymap dispatch and REPL eval should run inside a
  try/catch that reports cleanly (REPL eval already does, `app.js:4696`;
  audit the *keymap* dispatch path `handle-key` and menu-invoke path
  `main.js:29` for the same protection).
- **Lisp step budget / interrupt** so a runaway user loop (`(define (f) (f))`
  without TCO benefit, or a non-tail builder — MEMORY notes a few remain)
  doesn't hard-hang with no escape. The interpreter has TCO
  (MEMORY: `project_lisp_tco_parked`); add a periodic step counter that can
  raise an interruptible error bound to a key (e.g. `C-g`). Scope this as a
  stretch goal if time is short — but a public user *will* write an infinite
  loop in the REPL on day one.

### 3d. Degrade, don't disable
- A language whose grammar WASM fails to load should fall back to the
  line tokenizer (the `highlighters[language]` lookup already allows a
  missing entry, `view.js:554` + comment at `view.js:61-64`) — verify a
  *failed* (not absent) grammar load degrades the same way.

---

## 4. Crash-safety & data-loss prevention (the P0 core)

Four independent gaps, each a separate landable commit. Do them in this
order; each is shippable on its own.

### 4a. Atomic save (effort: ~half a day) — **do first**
Replace the bare `writeFile` in `file:save` (`files.js:368`) with
write-temp-then-`rename` (rename is atomic within a filesystem). The repo
*already has the pattern* — `audio-metadata-write.js` does exactly this
("re-serialised and atomically renamed into place", `files.js:650`). Steps:
1. write to `${target}.jmacs-tmp-${pid}` (same directory, so rename stays
   on one filesystem);
2. `fsync` the temp file;
3. `rename` over `target`;
4. on any failure, `rm` the temp and reject with a real error so
   `saveBufferInteractive` (`app.js:2392-2408`) surfaces it and **keeps the
   dirty flag** (verify `app.js:2400` is not reached on failure).
Optional: keep a single `${target}~` backup of the prior contents (Emacs
style) — cheap insurance, opt-out via a defcustom.

### 4b. Save-on-quit guard for the native path (effort: ~half a day)
Cmd+Q must not bypass the dirty check. Add a `before-quit` handler in
`main.js`:
1. on `app.on('before-quit', e)`, if a renderer flag says "buffers dirty",
   `e.preventDefault()` and `webContents.send('app:before-quit')`;
2. the renderer runs the existing `quitInteractive()` (`app.js:2449`) —
   reuse its confirm + `flushAllMetadata()` — and on a confirmed quit,
   sends `app:quit-confirmed`, which main turns into a real `app.quit()`
   (set a "quitting" flag so the second pass doesn't re-prompt).
- The renderer must keep main informed of dirty state. Cheapest: send an
  IPC `dirty:changed(count)` whenever `dirtyBuffers` (`app.js:284`) is
  mutated (add/delete sites are `app.js:451`, `2400`, `6595`), so main
  always has the current count without a round-trip at quit time.
- Replace the renderer `window.confirm` (`app.js:2453`) with a native
  Electron `dialog.showMessageBox` (Save / Don't Save / Cancel) driven from
  main — more trustworthy and gives a real **Save** option, not just
  discard-or-not.
- Also cover `Cmd+W` / window close (`win.on('close')`) with the same guard.

### 4c. Autosave + crash recovery (effort: ~2 days) — **the keystone**
Today `session.js` saves structure, never **content**. Add a recovery
layer modeled on Emacs auto-save + the existing session controller:
1. **Recovery files** in `app.getPath('userData')/recovery/` (or beside the
   file as `#name#`, Emacs-style — pick one; userData is simpler and avoids
   cluttering the user's dirs). One file per dirty buffer, holding the full
   current text + the source path + a timestamp + a content hash.
2. **Triggers**: debounced after edits (reuse the debounce shape from the
   metadata writer, `app.js:2435`, or the session controller's debounce,
   `session.js:531`), on window blur, and on the error handlers (§3a).
   Write via the same **atomic** primitive as §4a.
3. **Path-less buffers count.** A brand-new unsaved buffer (no `filePath`)
   is the highest-value thing to recover and the one most easily lost
   (`session.js:122-123` drops it from the session entirely). The recovery
   file must capture it (keyed by buffer id + name).
4. **Recovery on startup**: before the normal session restore
   (`app.js:8593`), scan the recovery dir. If recovery files exist that are
   *newer than the on-disk file* (or have no on-disk counterpart), present a
   recovery prompt: "jmacs found unsaved changes from a previous session —
   Recover / Discard / Show diff." Recovered content opens as a dirty
   buffer; the user decides whether to save.
5. **Cleanup**: delete a buffer's recovery file on successful save
   (`app.js:2400` region) and on a clean confirmed quit. Never delete on a
   *crash* path (that's the whole point).
6. **Defcustoms** (Lisp UI per `feedback_lisp_ui_js_engine`): autosave
   interval, on/off, recovery location — JS does the writing, Lisp toggles
   it live.

### 4d. Harden the existing persistence writes (effort: ~half a day)
Apply §4a's atomic write to *all* the userData writes so a crash mid-write
can't corrupt config and brick startup: `session:write` (`files.js:603`),
`faces:write` (`files.js:581` — its comment even admits "we don't bother
with a temp-file dance"), `panes:write` (`files.js:557`), `config:write`
(`files.js:534`), `metadata:write` (`files.js:509`). A corrupt
`session.json` already degrades gracefully on *read* (`session.js:307`), but
a corrupt `custom.lisp` could throw during eval at startup — **verify and
sandbox the custom.lisp eval** so a bad config never blocks launch.

---

## 5. Large-file / large-project performance audit

### 5a. The two structural cliffs (both grounded above)
1. **Whole-buffer reparse per keystroke.** `treesitter.js` calls
   `parser.parse(text)` over the entire buffer every render with no
   `tree.edit()` reuse (`treesitter.js:209,250,284`). Cost is O(file size)
   *per keystroke*, not O(edit).
2. **Flat-string L1 storage.** Every insert/delete reallocates the whole
   buffer string (`storage/src/buffer.js:92-94`). Also O(file size) per
   edit. The header already names the intended fix: a piece tree behind the
   same API (`buffer.js:11`).

These compound: a keystroke in a large file is (full string copy) + (full
reparse) + (full highlight query). Virtualization (`view.js:537`) keeps the
*DOM* small but does nothing for the parse/alloc cost.

### 5b. Audit plan (effort: ~1 day to measure, before optimizing)
Per `RISKS.md` ("Profile first, optimise second"):
- Build a benchmark harness (a script arm, or a `*Benchmark*` command) that
  measures keystroke latency vs. file size for: a plain `.txt`, a
  tree-sitter language (`.js`/`.py`), and a markdown file *with math*
  (the overlay path, `highlight.js:808` — the recently-added cost the brief
  flags). Markdown is double-jeopardy: tree-sitter markdown + the LaTeX
  injection over a code-masked scan of the whole buffer
  (`highlight.js:871`, `overlayMarkdownMath` rescans all segments each time).
- Measure: open time, first-paint time, p50/p95 keystroke latency, scroll
  frame time. Capture at 1 k / 10 k / 50 k lines and 1 / 10 / 50 MB.

### 5c. Rough targets (interactive feel; tune after measuring)
| Metric | Target | Hard ceiling |
|--------|--------|--------------|
| Keystroke→paint, 10 k-line code file | < 16 ms (one frame) | < 50 ms |
| Keystroke→paint, 50 k-line code file | < 50 ms | < 100 ms |
| Open a 10 MB text file | < 1 s to first paint | < 3 s |
| Scroll frame time, any size | 60 fps (< 16 ms) | 30 fps |
| Markdown-with-math, 2 k lines | < 33 ms/keystroke | < 80 ms |

### 5d. Likely fixes, cheapest first (do only what measurements justify)
1. **Debounce/idle the highlight** off the keystroke critical path: paint
   the edit immediately with the *previous* (or line-local) highlight, then
   re-highlight on idle (`requestIdleCallback`). RISKS.md anticipates exactly
   this ("syntax highlighting on idle"). This alone removes the worst
   per-keystroke spike without touching the parser.
2. **Incremental tree-sitter** via `tree.edit()` + passing the old tree to
   `parser.parse(text, oldTree)` (web-tree-sitter supports it). Requires
   keeping the tree alive per buffer instead of `tree.delete()` each call
   — a real but contained change in `treesitter.js`. (Note: the renderer
   re-creates highlighter closures per language; the per-buffer tree would
   need to live alongside the view's existing highlight cache, `view.js:349`.)
3. **Markdown-math overlay caching**: cache `scanMathSegments`
   (`highlight.js:809`) keyed by text so a scroll-only or non-math edit
   doesn't rescan the whole buffer.
4. **Piece-tree L1** behind the existing `storage/src/buffer.js` API — the
   biggest lift, deferrable. RISKS.md sanctions a WASM rope "for the rope
   only" if JS proves insufficient. Gate this on measurements: if §5d.1–3
   bring large-file editing under target, the flat string may be acceptable
   for v0.1 with a documented soft cap.
5. **File-size guard** (cheap, do regardless): on open (`files.js:264`),
   for files over a threshold (e.g. 25 MB) prompt before loading, and offer
   a "fundamental/large-file mode" that disables tree-sitter + overlays and
   uses the line tokenizer only. Prevents the worst hang on an accidental
   `open /var/log/...`.

### 5e. Large *project* behavior
- Directory views read synchronously (`files.js:415` `directory:list-sync`,
  `:463` detailed-sync). A huge directory blocks the renderer thread. Audit
  the directory-tree/columns views for sync IO on big dirs; cap or
  async-ify. (Lower priority than the per-buffer cliffs unless dogfooding
  surfaces it.)

---

## 6. Dogfooding / closed-beta plan

Bugs that matter are the ones strangers hit on their own files and
workflows. Surface them before the public sees them.

### Phase 0 — Self-dogfood (1–2 weeks, the architect)
- Use jmacs as the **primary** editor for real work (the book project, this
  repo) for at least a week. The single highest-yield bug source. Keep a
  running bug log; every crash/loss is a P0 regression test.
- Specifically exercise the data-loss paths *on purpose*: Cmd+Q with dirty
  buffers, kill the app mid-edit, edit huge files, open a project tree.

### Phase 1 — Recovery dry-runs (during Phase 0)
- Deliberately crash (`kill -9`) the app dozens of times across states
  (clean, dirty file-backed, dirty path-less, mid-save, mid-large-paste)
  and confirm §4's recovery offers the right content every time. This is the
  acceptance gate for the P0 work — automate as many as possible as smoke
  arms (§2c).

### Phase 2 — Closed beta (3–8 trusted users, 2–4 weeks)
- Once §2–§4 are done and the QA checklist's P0 boxes are green. Hand-picked
  people who will tolerate rough edges and report well (and who use *varied*
  OSes — Cmd+Q is mac-specific; Linux/Windows quit paths differ).
- **Telemetry-light, friction-light reporting**: ship a built-in
  **"Report a problem"** command that bundles the eval-log (`app.js:7502`),
  the last error, OS/version, and (with consent) the recovery state, into a
  pre-filled GitHub issue. Lower the activation energy and you get 10× the
  reports.
- Define explicit beta tasks that stress the risky surfaces: "open your
  biggest file," "write a small extension," "quit without saving on
  purpose," "restore a session after a crash."
- **Triage cadence**: any data-loss or crash report is P0, fixed before the
  next beta build. Track a simple "crashes-per-user-hour" and
  "data-loss-incidents" — both must trend to zero before going public.

### Phase 3 — Go/no-go for public
Public launch only when, across the closed beta:
- zero unresolved data-loss reports;
- crash rate is rare and every known crash has a graceful-degrade path;
- the smoke runs to completion in CI and covers all P0 flows;
- the large-file targets (§5c) are met *or* the file-size guard (§5d.5) +
  documented soft cap make the cliff unreachable by accident.

---

## 7. Prioritized sequencing & effort

Rough order; **P0 items gate the launch.**

| # | Item | Pillar | Effort | Gate |
|---|------|--------|--------|------|
| 1 | **§4a Atomic save** | data loss | 0.5 d | P0 |
| 2 | **§4b Save-on-quit guard (Cmd+Q)** | data loss | 0.5 d | P0 |
| 3 | **§4d Atomic config/session writes + custom.lisp eval guard** | data loss / startup | 0.5 d | P0 |
| 4 | **§2a/b Fix smoke `bufferMenu`** | test infra | 0.5 d | P1 |
| 5 | **§2c Per-arm smoke isolation + critical-flow arms** | test infra | 1–1.5 d | P1 |
| 6 | **§3a/b Global error handlers + render-loop guard** | crash | 1 d | P1 |
| 7 | **§4c Autosave + crash recovery** | data loss | 2 d | P0 |
| 8 | **§3c Extension sandbox + Lisp interrupt** | crash | 1 d | P1 (interrupt = stretch) |
| 9 | **§5b/c Perf audit (measure)** | perf | 1 d | P2 |
| 10 | **§5d.1 Idle/debounced highlight + §5d.5 file-size guard** | perf | 1 d | P2 |
| 11 | **§5d.2/3 Incremental tree-sitter + overlay cache** | perf | 2–3 d | P2 |
| 12 | **§5d.4 Piece-tree L1** | perf | large | deferrable past v0.1 |
| 13 | **§6 Dogfood → closed beta → go/no-go** | process | weeks | gates public launch |

**Critical path to "safe enough to be seen":** items 1, 2, 3, 7 (the P0
data-loss four) + items 4, 5, 6 (so we can *prove* they work and a bad
extension can't brick the editor). Roughly **5–6 focused days** of build,
then the dogfood/beta clock (§6) starts. Performance (9–12) runs in
parallel and is gated by measurement, not guesswork.

---

## 8. Notes for the architect / open decisions

- **Recovery file location** (userData/recovery vs. Emacs-style `#name#`
  beside the file): I lean userData — simpler, doesn't litter the user's
  directories, and dovetails with the existing per-user data dir
  (`files.js:165`). Flagging because it's user-visible and one-way-ish.
- **Native quit dialog vs. renderer `window.confirm`**: §4b proposes moving
  the prompt to a main-process `dialog.showMessageBox` with a real **Save**
  option. This is a small UX behavior change worth a conscious yes.
- **Piece-tree (§5d.4)** is a genuine architecture investment. RISKS.md
  pre-blesses a WASM rope "for the rope only." Recommend deferring past
  v0.1 *if* the cheaper perf fixes (idle highlight, incremental parse,
  file-size guard) clear the targets — but it's the one item here that
  could need real time, so size it early.
- **Lisp interrupt (§3c)** interacts with the interpreter
  (MEMORY: `project_lisp_tco_parked`, on a branch not yet merged). Coordinate
  so the step-budget hook lands cleanly on top of TCO rather than fighting
  it.
