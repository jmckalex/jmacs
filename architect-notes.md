## [2026-06-01] Snippets (godot-snippets, inline build): Phases 1–3 done, ready for live test

**Branch**: `worktree-agent-a6b0e3df7f194a59a` (isolated worktree off `main`).
**Do not merge.** Tests are green; this is a hand-off for live testing per
the "test before merge" rule.

### What I built

A yasnippet-style snippet engine, inline in the stdlib (the package
system doesn't exist yet — see `docs/SNIPPETS-INLINE-NOTES.md` for the
repackaging checklist).

- **Phase 1 (static expansion)** — file-format reader, body parser,
  per-mode store with `.yas-parents` fallthrough, `*snippet-directories*`,
  commands `snippet-expand` / `snippet-insert` / `snippet-list` /
  `snippet-reload`, a built-in starter set (~11 snippets), and the TAB
  trigger with the documented precedence.
- **Phase 2 (tab stops + navigation)** — `$N` / `${N:default}` / `$0`,
  the buffer-local active-snippet record, `snippet-next-field` (TAB) /
  `snippet-prev-field` (S-TAB) / `snippet-cancel` (ESC, C-g), default
  selected on field arrival (type to replace), modeline `[snippet: 2/4]`.
  Field highlighting uses the **selection/region** mechanism (see "Gap"),
  not overlays.
- **Phase 3 (mirrors)** — STRETCH, done and committed separately so it
  can be dropped. Repeated `$N` installs a multi-cursor set (Policy A);
  typing updates every occurrence live; `*snippet-mirror-multi-cursor*`
  (default #t) toggles it.

Phases 4 (transformations / embedded code / conditions) and 5 are out of
scope and not built. `# condition:` is parsed but not evaluated.

### Files

- New Lisp: `packages/stdlib/lisp/snippets-parser.lisp`,
  `snippets.lisp`, `snippets-keymap.lisp` (added to `STDLIB_FILES` after
  `multi-cursor.lisp`).
- New tests: `packages/stdlib/test/snippets.test.js` (39 tests).
- Edited test harness: `packages/stdlib/test/stdlib.test.js` (snippet
  primitive stubs; the face-count test relaxed to a subset check since I
  added 4 decoration faces).
- **Host territory (apps/desktop), edited because the feature needs host
  wiring — please eyeball these):**
  - `apps/desktop/src/preload.mjs` — exposes `host.userDataDirectory`
    (one new sync IPC call at preload time).
  - `apps/desktop/src/files.js` — `userdata:dir-sync` ipcMain handler.
  - `apps/desktop/src/app.js` — `USER_DATA_DIR` const; two new Lisp
    primitives (`snippet-user-directory`, `snippet-date-string`);
    modeline appends `(snippet-modeline-indicator)`; buffer `onChange`
    calls `(snippet-after-edit!)`; `dispatchKey` calls
    `(snippet-soft-commit-if-outside)` after each key. All hooks are
    guarded in Lisp (no-op when no snippet active) and wrapped so a
    snippet error never breaks editing/key dispatch.
- New docs: `docs/SNIPPETS-INLINE-NOTES.md` (repackaging checklist).

### Tests

`packages/stdlib`: 410 pass / 0 fail (39 snippet). `apps/desktop`: 166 /
0. All other packages unchanged and green. (`pnpm test` at the root trips
a pnpm install-check on the ignored `citation-js` build script — run
`node --test` per package instead, which is what `pnpm -r test` invokes.)

### How to live-test (in the running app)

Open or create a buffer. The starter snippets are mode-aware:

1. **Static expansion (fundamental-mode, any `.txt`):** type `todo` then
   TAB -> `TODO(author): describe the task` with point on `author`
   selected. Type to replace, TAB to the next field, TAB again to commit.
2. **Date snippet:** type `date` + TAB in a `.txt` buffer -> today's date
   (no fields, commits immediately). `datetime`, `copyright` (uses
   `` `year` ``) too.
3. **for-loop (a `.js` buffer):** type `for` + TAB ->
   `for (let i = 0; i < n; i++) { … }` with `i` selected; TAB cycles to
   `n` then to the body exit. Watch the modeline show `[snippet: 1/2]`,
   `[snippet: 2/2]`.
4. **Mirrors (Phase 3):** the built-in `for` has `$1` three times
   (`i`, `i < n`, `i++`). On arrival at field 1 you should get **three
   cursors**; typing `idx` updates all three live. (If mirrors misbehave,
   `(set! *snippet-mirror-multi-cursor* #f)` in the REPL disables them and
   isolates the rest.)
5. **TAB fall-through:** TAB with no trigger word still indents
   (`insert-tab`). `(set! *snippet-expand-key* nil)` disables the trigger
   entirely.
6. **ESC / C-g cancel:** mid-snippet, ESC or C-g drops the active record;
   the text stays.
7. **User snippets:** drop a file at
   `<userData>/snippets/fundamental-mode/greet` (a `# key: greet` /
   `# --` / body file), `M-x snippet-reload`, then `greet` + TAB. On
   macOS `<userData>` is `~/Library/Application Support/<app>/`. A user
   file silently shadows a built-in of the same key.
8. `M-x snippet-list` echoes the available triggers for the current mode;
   `M-x snippet-insert` prompts for a key.

**The single most important thing to verify live:** the **TAB key in a
real text buffer** — that expansion + field navigation + the fall-through
to indent all feel right, and that mirrors (item 4) update live via the
multi-cursor surface without leaving stray cursors after commit. The unit
tests drive `handle-key` directly; the live keyboard path (renderer key
normalisation -> `dispatchKey` -> `handle-key`) and the multi-cursor
rendering are the parts the tests can't fully exercise.

### Gap / decision to review

- **Field highlighting uses the selection, not face overlays.** The
  renderer's overlay surface (`inline-eval.js` pattern) is a single pill
  that hides on any edit — not a robust offset-tracking highlight. Per
  the brief, I selected the active field's default via the
  selection/region mechanism instead (which is robust under edits and
  gives "type to replace" for free). The four `snippet-*-face` faces are
  registered and the host can read `(snippet-active-region)` /
  `(snippet-mirror-regions)` to paint them later, but no overlay
  painting is wired yet. If you want the yasnippet-style coloured field
  boxes, that's a renderer task (a real offset-tracking decoration layer)
  — flag it and I'll spec it.
- **Embedded code is a 3-token allow-list** (`` `date` ``,
  `` `datetime` ``, `` `year` ``), not general `` `(form)` ``. Phase 4.

---
