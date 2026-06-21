# Projects — Nova-style directory workspaces

Status: **Increments 1 + 2 built** on branch `project-workspace`
(2026-06-21), suite green (~2,578 / 0), **awaiting live test** (main-process
change — needs **quit + relaunch**, not reload). Not yet merged.
Increment 1 = the workspace (open/find/close-project, 3-column layout,
per-project save-state). Increment 2 = the **Project Chooser** (this
session's "Phase 5"): the Nova-style launcher modal + custom thumbnails.

A *project* is a directory opened as a workspace, modelled on Nova's project
windows. Opening one reconfigures the window into a three-column layout and
gives that directory its own restorable save-state.

## What a project is

```
┌─ window ──────────────────────────────────────────┐
│ ┌────────┬───────────────────────┬──────────────┐ │
│ │ dir-   │   editing tabline      │  bookmark    │ │
│ │ tree   │   (open files)         │  outline     │ │
│ │ (left) │                        │  (right)     │ │
│ └────────┴───────────────────────┴──────────────┘ │
└────────────────────────────────────────────────────┘
   ~18%            ~64%                    ~18%
```

- **Left** — a `directory-tree` view rooted at the project directory.
- **Middle** — a `tabline` holding the open files (the editing surface).
- **Right** — the `bookmark` outline (auto-follows the focused buffer).

The sidebars are **normal focusable panes** (not no-focus), matching how
`directory-tree` / `bookmark` already behave when opened standalone — they're
interactive (click a file in the tree, click a bookmark to jump).

## Decisions (from the architect, 2026-06-21)

1. **Single window, reconfigure in place.** `open-project` rebuilds the live
   pane tree; it does *not* open a new OS window. True multi-window (Nova's
   actual model) is a deferred, larger refactor (`mainWindow` → Map,
   per-window IPC routing).
2. **In-directory dotfile** for state: `<root>/.godot/project.json`, so the
   state travels with the project if it's moved/copied. A central index
   (`<userData>/projects-index.json`, known paths + names only) is the
   future chooser's catalogue.
3. **Additive** vs the global session: the always-on `session.json` is the
   "home" state. `open-project` flushes the current workspace, then loads the
   project; `close-project` writes the project back and restores home. **Boot
   always lands on home.**

## How it works (where the code lives)

- **Host IPC** (`apps/desktop/src/files.js`, `preload.mjs`):
  `project:read/write` → `<root>/.godot/project.json` (mkdir + atomicWrite);
  `project:index-read/write` → `<userData>/projects-index.json`. Bridge:
  `host.readProject/writeProject/readProjectIndex/writeProjectIndex`.
- **Reuse of the session machinery** (`apps/desktop/src/session.js` —
  unchanged). A project's `project.json` is just a **v2 pane-tree blob**
  (`serialiseTree`). Save/restore is a **second `createSession`** instance
  whose `host` shim points at the project file (`projectStateHost(root)`);
  `serialiseTree` / `installRootPane` are reused as-is. `serialiseTree`
  already serialises a directory-tree (its `rootPath`), a tabline (tabs with
  point/mark), and a bookmark view — so the whole 3-column layout round-trips
  for free, including any extra splits the user makes inside the project.
- **Workspace wiring** (`apps/desktop/src/app.js`, "Projects" section after
  the session controller): `activeProjectPath` / `projectSession`;
  `activeSession()` selects the live controller so every save/flush targets
  the right file. `openProject` / `closeProject` / `buildCanonicalProjectLayout`
  (first open) / `buildScratchWorkspace` (home fallback) / `rememberProject`
  (index). First open builds the canonical layout; later opens restore the
  saved tree (detected by a rootPane-identity change, same as boot).
- **Pure module** (`apps/desktop/src/project-index.js` + test):
  `upsertProject` (move-to-front + dedupe by path), `projectNameFromRoot`.
- **Lisp** (`packages/stdlib/lisp/project.lisp`): `open-project` (native
  picker), `find-project` (completing minibuffer, find-file-style filesystem
  TAB completion — mirrors `directory-tree`), `close-project`. Primitives in
  app.js: `open-project!`, `open-project-at!`, `close-project!`,
  `current-project`. `find-project` is bound to **`C-x C-p`** (keymap.lisp);
  `open-project` / `close-project` are `M-x` for now. `openProject` guards against a
  non-directory path (the minibuffer / `open-project-at!` can yield one):
  `listDirectorySync` is an array only for a real directory, else the status
  line reports it and the open is declined.

## Known limitation (accepted for increment 1)

**Orphaned views accumulate in the global `views` list across workspace
switches.** The additive model keeps the old workspace's view handles in
`views[]` after a switch (restore uses `forceDuplicate`, minting fresh
handles). The *correct* files show in the *correct* panes — this is clutter
in `C-x b` / the *View List*, not a functional break, and no unsaved buffer is
dropped. A follow-up should prune unreferenced, clean (unmodified) text views
after a workspace install (guarding against dropping dirty buffers and the
bookmark/dir-tree singletons).

Other notes: each project root gets its own `directory-tree` view handle (kept
across opens); the `bookmark` view is a true singleton, retargeted per
workspace. `.godot/` is visible in the dir-tree (like Nova's `.nova`).

**Dir-tree open routing (fixed 2026-06-21):** double-clicking a file in the
sidebar tree was opening it in the *tree's own* pane (`openFileInTabAdjacent`
promotes the focused pane). Now routed through `*directory-tree-open-target*`
(`:choice` defcustom — `editing-pane` default / `other-pane` / `this-pane`)
via the overridable Lisp `directory-tree-open-file` → `open-file-from-tree!`
primitive; `editing-pane` opens in the main editing area (the middle tabline
in a project) and focuses it. Pure pane pick in `tree-open.js` (`pickEditingLeaf`).

**Pane focusability + focus border (2026-06-21):** generalised the minimap's
`:no-focus` into per-pane focusability so projects feel like Nova. In a
project the sidebar kinds (`directory-tree` / `directory-columns` /
`bookmark`) are **passive** — clicking works but they never become the active
pane, so focus stays in the middle tabline (`isNoFocusPane` auto-derives this
from `activeProjectPath`; `C-x o` skips them; `installRootPane` won't land
focus on one). Lisp control: `(set-pane-focusable! #f/#t)` / `(pane-focusable?)`
for custom UIs (re-derived for projects, not persisted). New defcustom
`*pane-focus-border*` (`auto` default / `on` / `off`): `auto` hides the
active-pane border when only one pane is focusable — so a project shows none.
Pure policy in `pane-focus.js` (`shouldDrawFocusBorder`). **Keyboard-nav
caveat:** a passive sidebar is mouse-driven (it isn't the active pane, so it
doesn't receive editor keystrokes) — verify the tree's own arrow-nav in the
running app.

## Increment 2 — the Project Chooser (this session's "Phase 5")

A Nova-style launcher **modal** (not a view/pane — it's transient and never
part of a saved workspace). `M-x project-chooser` → `open-project-chooser!`.

- **Presentation** — a fixed-position centered dialog appended to `<body>`
  with a dark backdrop, modelled on the `directory-columns-modal` /
  `colour-picker` pattern: capture-phase keydown (so the editor's global
  dispatcher doesn't interfere), backdrop-click / Escape / × to dismiss.
  `apps/desktop/src/project-chooser.js` (`openProjectChooser(options)`),
  alongside `add-pane-mode.js` / `move-view-mode.js`.
- **Tiles** — each project shows a custom thumbnail (an image path stored on
  its index entry) **or** a generated colored letter tile
  (`projectTileAppearance`, deterministic from the name — Nova-style).
- **Thumbnails** — set via the per-card 📷 picker **or by dragging an image
  file from Finder onto the tile** (the tile is a drop target; a drop path
  comes from `webUtils.getPathForFile`, since Electron 42 removed `File.path`,
  exposed as `host.getPathForFile`). Host channels `project:pick-image`
  (image-filtered dialog, formats limited to what `imageMimeType` reads back)
  and `project:thumbnail` (read an image path → data URL, 8 MB cap); a dropped
  file is validated through `project:thumbnail` before it's stored, so a
  non-image drop is a silent no-op. The index entry's `thumbnail` is preserved
  across re-opens (`upsertProject` merges existing fields).
- **Actions** — *Open Folder…* (picker → open immediately), *Add Project…*
  (picker → add to the index without opening), per-card 📷 set-thumbnail and ✕
  remove-from-list. Search filter (`filterProjects`), arrow-key + Enter nav.
- **Wiring** — `showProjectChooser()` in app.js reads the index
  (`readProjectList`/`writeProjectList`) and supplies all side-effect
  callbacks; the chooser stays host-agnostic. Pure helpers in
  `project-index.js`; fake-DOM smoke test in `test/project-chooser.test.js`.
- **Unbound** — `M-x project-chooser` only; no keybinding chosen (see notes).

## Known limitations / notes

- **Orphaned views** (increment 1, unchanged) — see above; pruning still TODO.
- **Open Folder… closes the chooser before the native picker opens**, so
  cancelling the picker leaves you in the editor (re-invoke the chooser). This
  is deliberate: `openProject` rebuilds the window, and the body-level overlay
  must be gone first. Add/Set-thumbnail do *not* close (no window rebuild).
- **Clicking a stale tile** (project dir since deleted) closes the chooser,
  then `openProject`'s guard reports "Not a directory" on the status line and
  declines. Stale entries aren't auto-pruned — use the ✕ to remove one.

## Deferred — later increments

- **Show the chooser on startup** when there's no project (Nova does). A
  boot-behaviour change — intentionally NOT done autonomously; Jason's call.
- **Orphaned-view pruning** (the increment-1 limitation).
- **Window title** reflecting the open project.
- **Keybindings** — a project prefix map vs single binds (the `C-x p` question
  is still open); a `current-project` modeline segment.
- **New Document / Clone** actions from Nova's chooser — out of scope (Clone =
  git; New Document = a plain new buffer).
- **True multi-window** (a project per OS window) — the larger refactor.

## Recovery

Branch `project-workspace` off `main` @ `b2ead59`. Increment-1 commits: host
IPC + index (`9bba905`), workspace + Lisp (`5917fe7`), find-project +
`C-x C-p`. Increment-2 (chooser) commits: index helpers, thumbnail IPC,
chooser modal + styles, wiring + command, smoke test. Pre-merge tag to add
before any `--no-ff` merge: `pre-project-workspace`.
