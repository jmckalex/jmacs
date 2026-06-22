# Model B — state & live-debug guide (autonomous run parked)

> Written when the autonomous build paused for the live debugging session.
> Branch **`multi-window-b`** in worktree `/Users/jalex/Source/jmacs/godot-mw-b`,
> tip **`57d4fd4`**, **64 commits ahead of `main`**, full suite **GREEN 747/0**,
> **nothing merged**, `main` untouched. Deep references: `architect-notes.md`
> (rolling log of every wave), `plans/MWB-GRADUATION.md` (the flip plan),
> `apps/desktop/mwb/PRIMITIVE-SPLIT.md` (the model/render port map).

## TL;DR
The Model-B architecture is **proven end-to-end and partly graduated into the
real app behind a `GODOT_SERVER=1` flag.** With the flag **off**, the editor is
**byte-for-byte today** (that's the invariant every commit held — the green
suite is the tripwire). With the flag **on**, the real `main.js` forks the Lisp
server in a `utilityProcess` and one real window edits through it.

## What's proven (the prototype, all green, node-tested)
A usable editor through the server: open files · **multi-buffer** (`C-x b`/`C-x
C-b`/`C-x k`) · edit · **overlays + multi-cursor** · **real atomic save +
autosave/recovery** (`●` dirty) · **shared undo** · the **step-budget interrupt**
· **two windows on one buffer in lockstep** · **panes/splits** (server pane tree
+ `PANE_TREE`/`PANE_INTENT` + a multi-pane client render) · a **generic `PICKER`
channel** (proven on the buffer list, templates the rest). **`view.js` unchanged
throughout** — the headline result.

## What's graduated into the real app (behind `GODOT_SERVER=1`)
- **G1** — `main.js` forks the server + plumbs a `MessageChannelMain` port to the
  renderer (`app.js` stashes `godotServerPort`). Flag-off unchanged.
- **G2** — one real `<text-view>` (real `createEditorView` + highlighters)
  mounts on a `ClientBuffer` mirror and edits **through the server** (keystrokes
  round-trip; motion/overlays/multi-cursor/scroll reconcile).
- **G3** — **~26 of ~70 stdlib files run server-side** via the primitive-split:
  commands/editing/kill/yank/search/occur/auto-pair/**full snippet engine**/the
  **LaTeX writing+nav chain**/makefile/markdown/panes/regex-search/query-replace.

## ▶ How to run it (live)
From `/Users/jalex/Source/jmacs/godot-mw-b/apps/desktop`:
- **Flag-ON (the new path):** `GODOT_SERVER=1 ./node_modules/.bin/electron .`
  — type in the editor; this is the decisive "does it feel native?" check. Watch
  for `[main] GODOT_SERVER=1: Model-B server forked` + renderer `[godot] Model-B
  server port connected`; a `godot-server` process should appear and die on quit.
- **Flag-OFF (must be identical to today):** `./node_modules/.bin/electron .` —
  no `godot-server` process; the editor exactly as it is on `main`.
- **Headless self-tests** (each forks the real server; `[…-done] PASS` on success):
  `GODOT_SERVER=1 ./node_modules/.bin/electron mwb/server-bridge-selftest.js …`
  (G1 handshake), `… mwb/server-view-selftest.js …` (G2 typing round-trip),
  plus `MWB_*_SELFTEST=1 … mwb/launch.js …` for the prototype slices (pane,
  picker, save, undo, overlay, commands — listed in `architect-notes.md`).
  (The build agents could not launch the GUI — these are unverified *live*; that
  is the first thing to confirm.)

## ⚑ The key finding for the live session — the leaf seam
G2 proved a real window can be a server client, but via a **self-contained
overlay**, not by flipping an existing leaf in place. Why: the real app mounts
views in **`ensureEditorViewForLeaf` (`app.js` ~6190)**, whose closures bind a
**Lisp View handle (`_boundLeaf.view`), not a buffer.** Truly graduating the view
machinery means teaching `ensureEditorViewForLeaf` a **server-mode branch** that
admits a mirror-backed view (and making the global key router's server-mode case
explicit — two routers currently coexist, neutralised only by the overlay's
focus + `preventDefault`). **This is the biggest `app.js` seam and the natural
first thing to do together live.**

## Prioritized next steps
1. **Live-verify G1/G2** (run the two self-tests + flag-on by hand). Confirm
   typing-through-the-server feels native; note anything that doesn't.
2. **The leaf flip** — `ensureEditorViewForLeaf` server-mode branch + explicit
   router branch; retire the G2 overlay. *The core surgery; do it live.*
3. **Chrome wiring** — drive the shared modeline/status/minibuffer DOM from the
   server `VIEW` message (it already carries the data).
4. **Citation/RefTeX server-side** — the last clean server wave (serves your
   academic writing). *Obstacle the stalled agent hit:* requiring `citation.js`
   from the `utilityProcess` — resolve it against the repo's hoisted
   `node_modules` (test inside the repo dir, not `/tmp`). The cite picker rows
   ride the existing `PICKER` channel.
5. **Multi-window (G4)** — multiple real windows as clients on shared buffers.
6. **G5** — flip the default + delete the dead in-renderer interpreter path
   (`app.js` ~10.8k → ~4k; `view.js`/stdlib unchanged). *The final commit; live.*

## Notes
- **Pre-existing stdlib bug** (not Model-B, found in passing): `latex-fill-
  paragraph` throws on prose with no enclosing environment —
  `packages/stdlib/lisp/latex-fill.lisp` ~580 wants a `(when …)` guard. The
  in-environment path (the real use) works.
- **Sibling worktrees:** `godot-mw-a` = **Model A Phase 0** (independent-windows,
  complete, its own `architect-notes.md`) for the A/B comparison; the `toolbar`
  branch (the Conn) is unmerged and must also graduate (its `define-toolbar-*`
  collectors → server, rendering → client) — see decision #5 in the graduation
  plan.
- **Merge nothing** until we've debugged live; `main` is clean.
