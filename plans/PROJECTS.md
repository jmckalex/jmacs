# Projects — Nova-style directory workspaces

Status: **Increment 1 built** on branch `project-workspace` (2026-06-21),
suite green (2,562 / 0), **awaiting live test** (main-process change — needs
**quit + relaunch**, not reload). Not yet merged.

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
- **Lisp** (`packages/stdlib/lisp/project.lisp`): `open-project` (picker),
  `close-project`. Primitives in app.js: `open-project!`, `open-project-at!`,
  `close-project!`, `current-project`. Unbound — `M-x` for now.

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

## Deferred — later increments

- **Project Chooser** — the visual dialog (the screenshot Jason shared):
  a grid of known projects (from the index), search, New/Open/Add.
- **Custom thumbnail images** per project (vs Nova's letter tiles) — store the
  thumbnail path/data in the project's `.godot/` and surface it in the index.
- **Orphaned-view pruning** (the limitation above).
- **Window title** reflecting the open project.
- **`close-project` keybinding / a `current-project` modeline segment.**
- **True multi-window** (a project per OS window) — the larger refactor.

## Recovery

Branch `project-workspace` off `main` @ `b2ead59`. Commits: host IPC + index
(`9bba905`), workspace + Lisp (`5917fe7`), this doc. Pre-merge tag to add
before any `--no-ff` merge: `pre-project-workspace`.
