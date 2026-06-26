# Multi-window — plan

Status: **planning** (branch `multi-window-plan`, off the projects work). No
code yet. This doc maps the conversion, foregrounds the decisions, and lays
out a phased roadmap. "The last huge outstanding task" (Jason, 2026-06-21).

**Gating decisions LOCKED (Jason, 2026-06-21):**
- **(1) Independent windows** (Nova/VS Code), not Emacs shared-buffer frames.
- **(2) Hybrid windows↔projects** — `open-project`/chooser open a project in a
  **new** window by default (focus the existing window if already open), with
  an **"Open in This Window"** alternative that keeps today's reconfigure-in-
  place behaviour.

Phase 0 can start on these. Decisions 3–9 settle as their phases come up.

---

## 1. The goal

Turn the single-window app into a multi-window one: several top-level OS
windows, each an independent editor surface, in the spirit of Nova / VS Code
(one window per project, plus untitled windows). Today there is exactly one
`BrowserWindow` (`main.js` `let mainWindow = null` — "there is only ever
one").

## 2. The good news: the renderer is already isolated

Almost all editor state is **module-level in the renderer** (`app.js`): `views`,
`currentViewIndex`, `rootPane`, `currentPaneId`, `currentTextBuffer`,
`tablineStateByView`, the Lisp `interpreter`, the `repl`, the `sessionController`,
and the project layer (`activeProjectPath` / `projectSession`). Buffers
(`packages/buffer`) live in the renderer too. The main process holds **no
buffer/document model** — `files.js` is stateless file ops plus a single shared
`changeTracker` (on-disk mtimes).

**Consequence:** a second `BrowserWindow` is a second renderer process with its
own, fully independent copy of all of that — *for free*. We are not building a
windowing/state-sharing layer from scratch; we are (a) teaching the **main
process** to manage N windows instead of one, and (b) keeping the few **shared
global files** (session.json, panes.json, faces.json, recovery/) from
clobbering each other across windows.

That framing is what makes this large-but-tractable rather than a rewrite.

---

## 3. THE foundational decision: window/buffer model

Everything else follows from this. Two models:

### (A) Independent windows — *Nova / VS Code* — **recommended**
Each window is a self-contained editor with **its own buffer list**. Opening
the same file in two windows yields two independent buffers (the shared
`changeTracker` already turns the second save into a normal "changed on disk"
conflict, which is correct). Leverages the renderer isolation above; the main
process just routes per-window. **Cheap, and matches the product's Nova
lineage.**

### (B) Shared buffer list — *Emacs frames*
All windows share one buffer list; one buffer can show in many frames. This
requires **moving the buffer/view model out of the renderer into the main
process** (or a shared store) with cross-renderer synchronisation of every
edit, cursor, overlay, and marker. That is a ground-up re-architecture of L1–L4
and the view layer. **Not recommended** — the cost is enormous and the payoff
(same buffer in two frames) is a niche Emacs habit the Nova model doesn't need.

> **DECIDED: (A) Independent windows** (Jason, 2026-06-21). The rest of this
> plan assumes (A).

A sub-question under (A): **opening a file that's already open in another
window** → allow a second independent buffer (simplest), or focus the existing
window (VS Code does this)? Recommend *allow*, with an optional later "reveal
in existing window" nicety.

---

## 4. Current single-window assumptions (the change surface)

### Main process — must change
- **`main.js` `mainWindow` singleton** (l.56) → a registry of windows +
  focused-window tracking.
- **`dispatchMenuCommand`** (l.64) sends `menu:invoke` to `mainWindow` → must
  send to the **focused** window.
- **`shouldHoldForConfirm` / `before-quit` / `win.on('close')`** (l.111, 171,
  190) assume one window → per-window close confirm, and an app-quit that
  confirms across **all** windows with unsaved work.
- **`menu.js` + `menu:set`** (main.js l.152): the macOS menu bar is app-global
  but the mode menu comes from one renderer → must track focus and rebuild the
  menu for the **focused** window's mode (and restore it on focus change).
- **`createWindow()`** (l.68) → parameterised (`{ workspace }`) and tracked.

### Main process — shared files that would collide (the real persistence work)
- **`session.json`** (`session:read/write`, files.js) — one global file. With N
  windows, every window's debounced save clobbers it. Needs per-window scoping.
- **`panes.json`** (`panes:read/write`) — splitter sizes, one global file. Same.
- **`recovery/`** (`recovery:write`, key = file path) — two windows editing the
  same file generate the **same key** → snapshots overwrite each other. Needs a
  window-discriminator in the key.
- **`faces.json`** / config — shared *source* (intended), but a live change in
  one window doesn't propagate to others (see Decision 5).

### Main process — already multi-window-safe (good)
- **`shell.js` / `process.js` / `gnuplot.js`** already capture `event.sender`
  per session and guard `sender.isDestroyed()` before sending output back — so
  output routes to the right window and is dropped if it's gone. **But** none of
  them **reap** their child processes when a window closes: must add per-window
  reaping (kill sessions whose `sender` is destroyed) on window close. Session
  ids are renderer-generated; keep them unique per renderer (they already are).
- **`serve.js` + `__host__` allowlist** — process-wide by design; the security
  boundary is per-app, not per-window. **No change.** (`media://`, `app://`
  handlers are stateless.)
- **`changeTracker`** (external-change mtimes) — shared and global is *correct*:
  one source of truth for on-disk state across windows.

### Renderer — additions (small)
- A **window identity** the renderer knows (assigned by main at creation) so
  its session/panes/recovery calls are scoped to its window.
- **Window-management commands/host bridge**: `new-window`, `close-window`,
  `next/previous-window`, `list-windows` → `window:*` IPC.
- **Boot**: read the per-window workspace rather than the single global session.

### Things that already "just work" per-window (no change)
The Project Chooser modal, the minimap/sticky/fold machinery, the Lisp
interpreter, the preload `host` bridge (each window gets its own preload), the
view/pane tree — all per-renderer already.

---

## 5. Decisions we need to make

Each has a recommended default so the plan is actionable; all are Jason's call.

1. **Window/buffer model** — Independent (A) vs Emacs-frames (B).
   **DECIDED: A** (Jason, 2026-06-21). Section 3.

2. **Windows ↔ projects.** The projects feature (just built) reconfigures the
   *current* window in place. Multi-window options:
   - (a) **One window per project** (Nova): `open-project` / chooser opens the
     project in a **new** window; if that project is already open, focus its
     window. The current window stays as it was.
   - (b) Keep reconfigure-in-place; windows are orthogonal (you manually make
     windows; each can open a project in place).
   - (c) **Hybrid:** "Open Project" opens in a new window by default, with an
     "Open in This Window" alternative; the chooser's tiles open in a new
     window.
   **DECIDED: (c)** (Jason, 2026-06-21) — new-window by default,
   focus-existing-if-open, with an "Open in This Window" alternative that keeps
   the reconfigure-in-place path. Reshapes the projects UX accordingly.

3. **Per-window persistence + restore-on-launch.** Today one `session.json`
   restores on boot. Multi-window:
   - A top-level **`windows.json` manifest** lists the open windows, each with
     its **workspace identity**: `{ kind: 'home'|'project', root?, … }`. On
     boot, recreate each window; each restores its own workspace — a *project*
     window from its `<root>/.godot/project.json` (already exists), a *home*
     window from a home-session file.
   - Sub-decisions: **can there be multiple "home" (untitled) windows?** (Rec:
     yes — key their session by a per-window logical id, e.g. `home-1.json`.)
     **Window geometry** (position/size) persisted per window? (Rec: yes, in the
     manifest.) **`webContents.id` is not stable across runs** — persistence
     must key on *workspace identity* (project root / logical home id), not the
     runtime window id.
   **Rec:** the `windows.json` manifest + per-workspace restore. Projects
   already self-persist; this mostly adds the manifest + a home-session-per-
   window split.

4. **Quit & window lifecycle.**
   - **Close last window:** macOS stays alive (convention, current behaviour);
     Win/Linux quits. Keep.
   - **Close one window with unsaved work:** per-window confirm (extend the
     existing close→`app:confirm-quit` handshake to the specific window).
   - **Cmd+Q with unsaved work in several windows:** confirm across all. Options:
     sequentially focus + confirm each dirty window, or one aggregate prompt.
     **Rec:** iterate dirty windows, focus + confirm each (simple, transparent).
   - **New window contents** (Cmd+N-for-window / "New Window"): scratch/home.
     **Rec:** a fresh home workspace.

5. **Shared config — live propagation.** custom.lisp/init.lisp/faces.json/
   keymap load per renderer at boot (shared source). A live theme/face change
   in window A writes `faces.json` but **doesn't update window B**.
   - (a) Leave it — other windows are stale until reloaded (simplest).
   - (b) **Broadcast**: main fans out a `config:changed` event to all windows;
     each re-reads + re-applies (faces/theme at least).
   **Rec: (b) for faces/theme** (it's jarring otherwise), scoped to the cheap
   re-apply path; full custom.lisp re-eval can stay reload-only.

6. **Cross-window view movement.** Move a tab/view to another window; tear a tab
   off into a new window (Nova/VS Code). Under model (A) this is *serialize the
   view (path + point/mark + kind) → open in target → close in source*.
   **Rec: defer.** Ship windows first; add a simple `move-view-to-window`
   command in a later phase, tab tear-off (drag-out) as a stretch.

7. **Recovery keying.** Include a window discriminator so two windows editing
   the same file don't overwrite each other's snapshots. **Rec:** prefix the
   recovery key with the window's workspace id; `recovery:list` on boot still
   shows everything (the *Recover* view already handles multiple snapshots).

8. **Menu / platform model.** macOS = one app menu bar that must follow the
   focused window; Win/Linux = per-window menu bars. The app targets all three
   (memory: all-3-platforms + notarization). **Rec:** track focus in main,
   rebuild the menu from the focused window's last `menu:set`; verify Win/Linux
   per-window menus separately.

9. **Global vs per-window keyboard/commands.** `other-window` exists for panes
   *within* a window; we need `other-window`-style commands *across* windows.
   Decide the command set + bindings (e.g. a `C-x 5` family, Emacs's
   frame-command prefix: `C-x 5 2` new window, `C-x 5 0` close, `C-x 5 o`
   other). **Rec:** adopt the `C-x 5` family (Emacs muscle memory, and the
   prefix is free).

---

## 6. Target architecture (under model A)

```
main process (one)
├─ windows registry:  Map<windowId, { win, workspace, modeMenu }>
├─ focusedWindowId
├─ window:new / close / list / focus IPC + menu dispatch → focused window
├─ per-window reaping: on window close, kill shell/process/gnuplot sessions
│     whose sender is that window
├─ stateless services (files, dialogs, serve, media, changeTracker) — shared
└─ persistence: windows.json manifest + per-workspace session files

each window = one renderer (independent)
├─ its own views / rootPane / interpreter / buffers / project layer
├─ knows its workspace identity (passed in at creation)
├─ session/panes/recovery calls carry that identity → its own files
└─ host bridge (preload) per window
```

**Window identity plumbing:** main assigns a stable *workspace id* at
creation and passes it to the renderer (URL query `?ws=<id>` on `EDITOR_URL`,
or a `host.workspaceId` exposed via preload from an injected value). The
renderer threads it into `session:read/write`, `panes:*`, `recovery:write`.

---

## 7. Phased roadmap

**Phase 0 — Main-process multi-window plumbing (no persistence yet).**
- `main.js`: `mainWindow` → `windows` registry + `focusedWindowId` (track
  `BrowserWindow.on('focus')`); `createWindow({ workspace })`; per-window
  `close` confirm; `before-quit` confirms across all dirty windows; menu
  dispatch → focused window.
- `menu.js`: store mode menu per window; rebuild on focus change.
- Reaping: on window close, kill that window's shell/process/gnuplot sessions.
- `window:new` / `window:close` / `window:list` IPC + `host` bridge +
  renderer commands (`C-x 5 2/0/o`, `M-x new-window`).
- New windows open a fresh scratch/home. **Exit criteria:** open 2–3 windows,
  each edits independently, menu follows focus, closing a window reaps its
  shells, quit confirms each dirty window. No restore yet.

**Phase 1 — Per-window identity & persistence.**
- Assign + thread a workspace id; scope `session.json` → per-workspace file,
  `panes.json` likewise, `recovery` key prefixed.
- `windows.json` manifest (open windows + geometry + workspace identity);
  boot restores the window set; each window restores its workspace.
- Home-session-per-window (`home-N.json`); keep the projects' `.godot/
  project.json` as-is.

**Phase 2 — Windows ↔ projects (Decision 2).**
- `open-project` / chooser open in a new window (focus-existing-if-open);
  "Open in This Window" alternative. Window title shows project/file name.

**Phase 3 — Live config propagation (Decision 5).**
- `config:changed` fan-out; faces/theme re-apply across all windows.

**Phase 4 — Cross-window view movement (Decision 6, optional).**
- `move-view-to-window`; tab tear-off as a stretch.

**Phase 5 — Polish.** Window titles, the Window menu (list/cycle/focus),
platform menu correctness (Win/Linux per-window), docs.

---

## 8. Risks & landmines
- **Smoke harness** (`scripts/smoke.js`, screenshot.js) assumes one window —
  must be updated (it drives `mainWindow`).
- **The projects "additive home session" model** (just built) interacts with
  per-window sessions — the home/project save routing must become per-window.
  Plan Phase 1 around it carefully.
- **Quit-confirm correctness** with N dirty windows (don't lose a window's
  unsaved work because another window answered the prompt).
- **Focus tracking races** — the menu/mode and "current window" must stay in
  sync with the OS focus (capture-phase listeners, `blur`/`focus`).
- **Stable identity across runs** — never key persistence on `webContents.id`.
- **macOS no-windows-alive state** — app stays running with zero windows; the
  Dock-reactivate path (`activate`) must recreate a sensible window (last set?
  a chooser? a scratch home?). Decide as part of Phase 1.
- **Recovery list semantics** across windows (don't double-recover one file in
  two windows).

## 9. Testing
- Pure/unit: the windows-manifest serialize/restore, the workspace-id keying,
  per-window reaping selection (which sessions belong to a closed window) —
  all extractable as pure helpers + `node --test` (the project's convention;
  DOM/multi-window is live-only).
- Live: the matrix in each phase's exit criteria; plus the smoke harness,
  updated to spawn/drive ≥2 windows.

## 10. What I need from Jason
The **two gating decisions** before any code: **(1)** independent windows vs
Emacs-frames (Section 3 — rec: independent), and **(2)** how windows relate to
projects (Decision 2 — rec: open-in-new-window, focus-if-open, with an
"in this window" option). With those locked, Phase 0 can start. Decisions
3–9 can be settled as their phases come up, but a quick read on **3**
(per-window restore model) and **5** (live config propagation) would help
shape Phase 1.
