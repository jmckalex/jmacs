# Model B — state & morning test guide

> ⚠️ **STALE (~70 commits behind as of 2026-06-24).** Early morning-test snapshot.
> For CURRENT state read `HANDOVER.md` (repo root, in the `main` worktree) + the
> memory `project_model_b_graduation.md`. Tip is now `b4cf01b`, ~153 ahead, suite
> 878 — single-window + G4 multi-window + composable panes + a full VIEW-PORT SWEEP
> (media/PDF, directory views, element-views, jukebox) all live. The "what works"
> list below is broadly accurate but predates all of that.

> Branch **`multi-window-b`** in worktree `/Users/jalex/Source/jmacs/godot-mw-b`,
> tip **`8ac50e6`**, **84 commits ahead of `main`**, full suite **GREEN 822/0**,
> **nothing merged**, `main` untouched. Deep references: `architect-notes.md`
> (rolling log of every wave), `plans/MWB-GRADUATION.md` (the flip plan),
> `apps/desktop/mwb/PRIMITIVE-SPLIT.md` (the model/render port map).

## TL;DR
The Model-B central-server architecture is **proven and now genuinely usable**
behind `GODOT_SERVER=1`. Overnight it went from "types through a server" to
"an editor you can actually work in." With the flag **off** the editor is
**byte-for-byte today** (the green suite is the tripwire, held every commit).
With the flag **on**, a real `<text-view>` edits through the central Lisp
server — and now does so with commands, the minibuffer, search, and citations.

## ▶ How to run it
From `/Users/jalex/Source/jmacs/godot-mw-b/apps/desktop`:
- **Flag-ON (the new path):** `GODOT_SERVER=1 ./node_modules/.bin/electron .`
- **Flag-OFF (must be identical to today):** `./node_modules/.bin/electron .`
  (no `godot-server` process; the editor exactly as on `main`.)

## ✅ What now works through the server (boot-tested each wave)
- **Typing** — native feel; every key routes through the server's `handle-key`.
- **Auto-pair** — `(` `[` `{` `"` close + step-over (W1; fixed the local-echo bypass).
- **Prefix chords** — `C-x …`, `C-c …` resolve (W1; fixed the chord-eating bug).
- **Minibuffer** — `M-x`, `C-x C-f` find-file prompt + read, focus returns on close (W1).
- **Picker** — `C-x C-b` buffer list, find-file completions, the cite/ref pickers (W1/W4).
- **Modeline + echo area** — server-driven; the pending prefix (`C-x-`) shows (W1).
- **Multi-file** — `C-x C-f` opens + re-mirrors, `C-x b` switches, one live view (W3).
- **Screenful scroll** — `C-v` / `M-v` track the real pane height (W2).
- **Undo** — `C-/` (no more bell — the dual-router was gated off in server-mode, W2).
- **Full-ish keymap** — `C-o`, `C-t`, `M-m`, `M-a`/`M-e`, `M-k`, `M-q`, `M-g`, `M-r`,
  `C-=`, `C-x C-x`, `C-x h`, `C-x ;` (W3) on top of the G3 base.
- **LaTeX writing + nav** chain (G3) and **Makefile/Markdown** modes.
- **Citations + RefTeX (W4)** — `C-c [` cite (real CSL rows via the picker → `\cite{…}`),
  `C-c )` ref/eqref, `C-c (` label. The server reuses the renderer's pure-ESM `citation.js`.
- **Incremental search (W5)** — `C-s` / `C-r`: type to extend, repeat to advance
  (wrapping), `backspace` shrinks, `C-g` aborts, `RET` exits. Literal + case-sensitive.
- From the prototype/G3: kill/yank, motion, mark, **atomic save + autosave** (`●`),
  **shared undo**, **multi-buffer**, overlays/multi-cursor, the **step-budget interrupt**.
- **`view.js` unchanged throughout** — the headline result.

## ▶ Suggested morning test pass (flag-ON)
1. `C-x C-f` a file → it displays + edits; `C-x C-s` saves it.
2. Type `(`, `[`, `"` → they auto-close. Type some prose; `C-/` to undo (no bell).
3. `C-x b` to switch buffers; `C-x C-b` for the buffer-list picker.
4. `M-x` a command (e.g. `goto-line`). `C-s` to search, repeat with `C-s`, `C-g` to abort.
5. `C-v` / `M-v` to page down/up.
6. Open a `.tex` with a `Bibliography:` header (or a `\bibliography`) → `C-c [` to cite,
   `C-c )` to ref, `C-c (` to label.
7. The "feel" is the thing only you can judge — typing latency, focus flow, whether
   the chrome tracks correctly. (The build agents can't launch the GUI; everything
   above is unit-tested + boot-tested, but the *feel* is your call.)

## ⚑ Still the G2 *overlay* — the one big thing held for the live session
All of the above runs in a **self-contained server-view overlay**, not by flipping
the real editor leaves in place. The real app mounts views in
**`ensureEditorViewForLeaf` (`app.js`)**, whose closures bind a Lisp View handle,
not a buffer. The **leaf-flip** — teaching `ensureEditorViewForLeaf` a server-mode
branch so the *normal* leaves (panes/splits/tabs/multi-window) are server-backed,
and retiring the overlay — is **the biggest `app.js` seam and the natural first
thing to do together, live** (it's GUI-shaped, so best verified with you driving).

## Next steps (roughly in order)
1. **Live-verify** the morning test pass; note anything that doesn't feel right.
2. **The leaf-flip** — retire the overlay; real leaves through the server. *Live.*
3. **Multi-window (G4)** — multiple real windows as clients on shared buffers.
4. **Render-coupled stdlib** — bookmarks, sticky-notes, project tree, jukebox, etc.
   (need the renderer surfaces; come with / after the leaf-flip).
5. **The toolbar (the Conn)** graduation — collectors → server, rendering → client.
6. **G5** — flip the default + delete the dead in-renderer interpreter path
   (`app.js` ~10.8k → ~4k; `view.js`/stdlib unchanged). *The final commit; live.*

## Notes / caveats
- **Deferred, recorded:** regexp-isearch still stubbed (literal isearch is real);
  cite-picker SPC-peek/multi-mark (single-choice path works); `C-x C-o`
  delete-blank-lines (command not defined in any loaded lisp); the bottom-dock
  live cite-preview + SyncTeX/compile loop (render/process slices).
- **Pre-existing stdlib bug** (not Model-B): `latex-fill-paragraph` throws on prose
  with no enclosing environment — `packages/stdlib/lisp/latex-fill.lisp` ~580 wants
  a `(when …)` guard. The in-environment path (the real use) works.
- **Tooling quirk:** BSD `grep` mis-reads `mwb/spine.js` as binary (a stray
  multibyte char); use `grep -a` / `rg -a` on that file.
- **Sibling worktrees:** `godot-mw-a` = Model A Phase 0 (independent-windows) for the
  A/B comparison; the `toolbar` branch (the Conn) is unmerged and must also graduate.
- **Merge nothing** until we've live-verified together; `main` is clean.
