# Stdlib Lisp + loader — audit

**Date:** 2026-07-02
**Auditor:** audit agent 9 (final re-run)
**Branch:** main @ efe0fa6d
**Scope:** `packages/stdlib/` — the JS loader in `src/` (~2650 lines) and all of `lisp/*.lisp` (~13,900 lines). Cross-referenced against `apps/desktop/mwb/spine.js` (SPINE_STDLIB + embedded commands + host primitives), `packages/lisp/src/` (core), and `packages/buffer/src/buffer.js` (L2 selection/point semantics that the stdlib depends on).

| Dimension | Covered |
|---|---|
| Correctness (dispatch state machine, editing semantics, point/mark) | yes |
| Robustness (commands that error → stuck state) | yes |
| Architecture & consistency (three-ways-broken-port, shadowing, load order) | yes |
| Tests & coverage (stub-masking) | yes |

---

## Executive summary

The stdlib dispatch core is in good shape. The two live server-side key-reader
state machines (isearch `search.lisp`, query-replace `regex-search.lisp`) and
the two spine-embedded readers (quit-walk, describe-key) all observe clean
re-arm/abort discipline: every branch either re-arms `read-next-key` after
consuming a key or exits leaving **no** pending reader, and C-g/Escape is always
a clean abort. The `nil`-truthiness discipline is genuinely clean (no `null?`
anywhere; `get`-with-`nil`-default is always *retrieval* whose result is then
tested with `nil?`; `member`/`find` return `#f`). **No P0 was found.** Several
plausible freeze paths were chased to ground and found *defended* — but the
defenses are non-local host invariants, not in-Lisp guards, so they are logged
as latent hazards.

Worst first:

- **STD-01 (P2)** — `*prefix-arg*` leaks across a command error: `handle-key`
  clears the chord state *before* running the command but clears the pending
  universal-argument *after*, so a command that throws (errors reach only spine
  stderr — LISP-05) strands `*prefix-arg* = #t` into the next command.
- **STD-02 (P2)** — `M-x customize` persisted-value validation is `:choice`-only.
  A wrong-typed value in the custom file is `set!` into the live variable with no
  numeric/boolean/string validation, and its `:on-change` hook fires at
  custom-file load time; a downstream type assumption then throws (to stderr).
- **STD-03 (P2)** — C-M-s / C-M-r (`isearch-regexp-forward/-backward`) are bound
  in the global keymap but resolve to a spine **stub**: they emit a status line
  and do nothing (family-2 broken port). Known/deferred, but user-reachable.
- **STD-04 (P3)** — C-x C-r (`reload-stdlib`) is a dead binding: defined only in
  the not-loaded `system.lisp`, absent from the spine embedded block → "not
  available here."
- **STD-05 (P3, latent)** — `-add-all-matches` (C-c D) and the query-replace `!`
  loop are unbounded pure-Lisp loops with **no in-Lisp empty-needle guard**;
  termination rides entirely on buffer/`expand-region` invariants. A zero-length
  needle would spin forever (the interpreter interrupt/step-budget is never
  wired — LISP-01), freezing every window. Currently unreachable.

---

## Findings

### STD-01: `*prefix-arg*` leaks when a command errors mid-dispatch

- **Severity:** P2
- **Dimension:** Robustness / Correctness (dispatch state machine)
- **Location:** `packages/stdlib/lisp/keymap.lisp:445-457` (`handle-key`, the `symbol?` branch)
- **Evidence:**
  ```lisp
  ((symbol? binding)
   (reset-keymap!)                       ; chord state cleared up-front (good)
   (if (command-registered? binding)
       (run-command binding)             ; <- may throw
       (show-status! ...))
   (when (not (eq? binding 'universal-argument))
     (reset-prefix-arg!))                ; <- SKIPPED if run-command threw
   #t)
  ```
  `run-command` is called with no error boundary. If the command body raises,
  the exception unwinds out of `handle-key` to the spine (`interpreter.call`),
  which surfaces it only to stderr (LISP-05). Because the `(when … (reset-prefix-arg!))`
  is *after* `run-command`, it never runs on the throwing path, so a pending
  `*prefix-arg*` (set to `#t` by a preceding `C-u`) survives into the next
  command. `active-keymap` and `*chord-prefix*` *are* reset (line 446, before the
  call), so there is no chord freeze — only the numeric/universal argument leaks.
- **Failure scenario:** `C-u` (sets `*prefix-arg* = #t`), then invoke any command
  whose body errors (e.g. a mode command hitting a stub or a bad buffer state).
  The error vanishes to stderr; the user retypes and next presses `C-x 2`
  (split). `split-vertical` consults `*prefix-arg*`, still `#t`, and splits in the
  C-u direction (above instead of below) with no C-u having been pressed.
- **Fix direction:** clear the prefix-arg in an unwind-protect around the command,
  or reset it *before* `run-command` and have `universal-argument` re-set it (it
  already sets it in its own body). Simplest: wrap the call
  `(try (run-command binding) (finally (when (not (eq? binding 'universal-argument)) (reset-prefix-arg!))))`.
- **Confidence:** CONFIRMED (by reading; the throw-reaches-only-stderr premise is the sibling-confirmed LISP-05).

### STD-02: `defcustom` persisted-value validation is `:choice`-only — corrupt custom file applies verbatim

- **Severity:** P2
- **Dimension:** Robustness (persisted-data integrity)
- **Location:** `packages/stdlib/lisp/custom.lisp:107-137` (`-coerce-for-type`, `custom-apply!`, `custom-set-saved!`)
- **Evidence:** `-coerce-for-type` coerces **only** `:choice` (a stale string
  `"dark"` → the symbol `'dark`); its first clause `((not (eq? type :choice)) value)`
  passes every other type through unchanged. `custom-apply!` then does
  `(eval (list 'set! name (list 'quote coerced)))` — the value is written into the
  live variable with no numeric/boolean/string check — and immediately runs the
  entry's `:on-change` hook. `custom-set-saved!` (the form the persisted custom
  file is rebuilt from at load) calls `custom-apply!`, so this path runs at
  **custom-file load time**.
- **Failure scenario:** the custom file (hand-edited, or mis-migrated) records
  `(custom-set-saved! '*tab-width* "banana")`. On next launch the value is applied
  verbatim; `*tab-width*` is now the string `"banana"`. `insert-tab` →
  `(string-repeat " " (-tab-width-effective))` → `string-repeat` calls `num()` on a
  string → `LispError`, surfaced only to stderr; TAB silently does nothing. If a
  setting's `:on-change` hook is type-sensitive, the throw happens during custom
  load and can abort the rest of the file's settings.
- **Fix direction:** give `-coerce-for-type` real per-type validation (reject/coerce
  non-numbers for `:number`, non-booleans for `:boolean`, …) and have
  `custom-apply!`/`custom-set-saved!` skip + log a setting whose value fails its
  type rather than `set!`-ing garbage. At minimum wrap the load-time apply so one
  bad setting can't strand the rest.
- **Confidence:** CONFIRMED (no numeric/boolean validation path exists in the file).

### STD-03: C-M-s / C-M-r (regexp isearch) resolve to a spine stub — bound key, silent no-op

- **Severity:** P2
- **Dimension:** Architecture (three-ways-broken-port, family 2: stub primitive)
- **Location:** `packages/stdlib/lisp/regex-search.lisp:35-41` (`isearch-regexp-forward`/`-backward` → `start-regexp-search!` / `start-regexp-search-backward!`); stub in `apps/desktop/mwb/spine.js:2301-2312`.
- **Evidence:** keymap.lisp binds `"C-M-s" 'isearch-regexp-forward` and
  `"C-M-r" 'isearch-regexp-backward` (lines 200-201). The commands are registered
  (regex-search.lisp is in SPINE_STDLIB) so `command-registered?` is true and
  `handle-key` runs them — but their bodies call `start-regexp-search!` /
  `start-regexp-search-backward!`, which the spine registers as no-op stubs that
  only set a status string (`"I-search regexp … (spine stub — host-side loop)"`).
  The per-keystroke incremental regexp loop was never ported to the server
  (documented in the SPINE_STDLIB comment for regex-search.lisp and the stub site).
- **Failure scenario:** user presses `C-M-s`; the echo area shows a stub message
  and nothing else happens — no incremental search. (Plain isearch C-s/C-r works;
  `replace-regexp` C-M-% works — those are fully model-side. Only the *incremental*
  regexp variant is dead.)
- **Fix direction:** port the incremental regexp loop to a server-side
  `read-next-key` state machine mirroring `search.lisp` (over `find-regexp-forward`/
  `-backward`, which already exist and are real), or drop the two bindings until
  ported so the key isn't advertising a dead feature.
- **Confidence:** CONFIRMED (stub site read in spine.js).

### STD-04: `reload-stdlib` (C-x C-r) is a dead keybinding server-side

- **Severity:** P3
- **Dimension:** Architecture (SPINE_STDLIB membership, family 1)
- **Location:** binding `packages/stdlib/lisp/keymap.lisp:30` (`"C-r" 'reload-stdlib` in `c-x-keymap`); definition only in `packages/stdlib/lisp/system.lisp` (NOT in SPINE_STDLIB) and absent from the spine embedded block.
- **Evidence:** a full diff of every command symbol bound in keymap.lisp against
  the union of (defcommands in the 46 loaded SPINE_STDLIB files) ∪ (spine embedded
  defcommands) leaves exactly one real dead binding: `reload-stdlib`
  (`self-insert` is the other diff hit but it is the `*last-command*` sentinel, not
  a command). `grep reload-stdlib apps/desktop/mwb/spine.js` → none.
- **Failure scenario:** `C-x C-r` → `handle-key` resolves the symbol, `command-registered?`
  is false → echo "reload-stdlib is not available here". The key does nothing.
- **Fix direction:** either add a server-side `reload-stdlib` to the spine embedded
  block (the server owns the interpreter, so a disk re-load is meaningful) or drop
  the binding.
- **Confidence:** CONFIRMED (diff + grep).

### STD-05: unbounded pure-Lisp match loops rely on non-local empty-needle invariants (latent freeze)

- **Severity:** P3 (latent; currently unreachable)
- **Dimension:** Robustness (spin → freeze, given LISP-01 unwired interrupt)
- **Location:** `packages/stdlib/lisp/multi-cursor.lisp:127-137` (`-add-all-matches`, C-c D); `packages/stdlib/lisp/regex-search.lisp:125-144` (`query-replace-replace-rest-loop`, the `!` path).
- **Evidence:** `-add-all-matches` recurses with `from = (+ found n)` where
  `n = (string-length needle)`. `-search-from` is `string-index-of`, and JS
  `"…".indexOf("", k) === k`, so with `n = 0` the offset never advances → infinite
  tail recursion. The interpreter's step-budget/interrupt is never installed
  (LISP-01), so this is a hard freeze of the whole spine (every window). There is
  **no** in-Lisp guard that `needle` is non-empty. It is safe **only** because of
  two external invariants: (a) `-target-bounds`' region branch runs solely when
  `region-active?`, and `buffer.js` `selectionOf` returns `null` when
  `mark === point`, so a zero-width region is never "active" → the region needle
  is always ≥ 1 char; (b) `expand-region-word-bounds` returns `nil` (not a
  zero-width pair) off a word, so the no-region path is guarded by the
  `(when (not (nil? bounds)) …)`. The query-replace `!` loop is analogously safe
  only because `find-string-forward` guards `needle === '' → #f`.
- **Failure scenario:** none today. If the buffer ever adopts Emacs-style
  transient-mark (a zero-width region counting as active), or `expand-region-word-bounds`
  is changed to return a zero-width pair, `C-c D` with an empty target spins the
  spine forever with no way to C-g out (the interrupt is unwired).
- **Fix direction:** add a local guard — `(when (> (string-length needle) 0) …)`
  around the match loops — so correctness does not depend on a remote buffer
  invariant; and (systemically) wire the interpreter interrupt so *any* runaway
  command is abortable (LISP-01, out of this package).
- **Confidence:** CONFIRMED (loop logic + `indexOf("",k)=k`); trigger currently unreachable (defended by buffer/expand-region semantics, verified in `buffer.js:212-218` and `expand-region.lisp:72-86`).

---

## SPINE_STDLIB membership & primitive-availability tables

### Load order (the frozen `SPINE_STDLIB` array, `spine.js:310-585`, 46 files, in order)

| # | file | # | file | # | file |
|--|--|--|--|--|--|
| 1 | commands.lisp | 17 | search.lisp | 33 | snippets-parser.lisp |
| 2 | editing.lisp | 18 | regex-search.lisp | 34 | snippets.lisp |
| 3 | custom.lisp | 19 | markdown.lisp | 35 | snippets-keymap.lisp |
| 4 | indent.lisp | 20 | latex.lisp | 36 | bookmarks.lisp |
| 5 | modes.lisp | 21 | latex-compile.lisp | 37 | cite.lisp |
| 6 | faces.lisp | 22 | latex-insert.lisp | 38 | reftex.lisp |
| 7 | themes.lisp | 23 | latex-math.lisp | 39 | reftex-refs.lisp |
| 8 | highlight-rules.lisp | 24 | latex-nav.lisp | 40 | reftex-cite.lisp |
| 9 | keymap.lisp | 25 | latex-fill.lisp | 41 | latex-synctex.lisp |
| 10 | math-preview.lisp | 26 | makefile.lisp | 42 | latex-menu.lisp |
| 11 | kill.lisp | 27 | panes.lisp | 43 | docs.lisp |
| 12 | yank-pop.lisp | 28 | minimap.lisp | 44 | folding.lisp |
| 13 | line-ops.lisp | 29 | shell.lisp | 45 | project.lisp |
| 14 | occur.lisp | 30 | gnuplot.lisp | 46 | face-info.lisp |
| 15 | expand-region.lisp | 31 | browser.lisp | | |
| 16 | multi-cursor.lisp | 32 | auto-pair.lisp | | |

Load-order dependencies verified sound: `commands.lisp` first (everyone needs
`defcommand`); `custom.lisp` before its `defcustom` users; `faces.lisp` before
`themes.lisp`/`snippets.lisp`; `keymap.lisp` before `multi-cursor.lisp` before
`snippets-keymap.lisp` (the C-g / ESC decorator chain depends on exactly this
order — see Architecture observations); `expand-region.lisp` before
`multi-cursor.lisp` (word-bounds). **Correction to the brief's premise:**
`docs.lisp` **is** in SPINE_STDLIB (#43) on this branch — the "docs.lisp not
loaded server-side" claim is stale. `help.lisp` is genuinely not loaded (and
nothing server-reachable references it — its `describe-key`/help commands are
re-implemented in the spine embedded block).

### Files present in `lisp/` but NOT in SPINE_STDLIB (18)

`directory-columns`, `directory-tree`, `element-view-atari`,
`element-view-bib-search`, `element-view-notebook-cells`, `element-views`,
`files`, `help`, `inline-eval`, `jukebox`, `menus`, `palette`, `sticky-notes`,
`system`, `tabline`, `utility-pane`, `view-menu`, `views`.

Every command these files define that is *also bound in keymap.lisp* is
**re-defined in the spine embedded block** (verified): `find-file`/`save-buffer`/
`write-file` (files.lisp → spine), `switch-view`/`list-views`/`scratch-buffer`/
`kill-view`/`next-view`/`previous-view` (views/view-menu → spine), `toggle-repl`
(system → spine), the M-n sticky-note family (sticky-notes → spine),
`jukebox`/`directory-tree`/`directory-columns` (→ spine). So the not-loaded files
do not strand their keybindings — **except `reload-stdlib`** (STD-04). M-x cannot
offer a command from a not-loaded file because such commands are never registered
server-side, so there is no "M-x offers X but X errors" hazard from this set.

### Primitive availability (family-2 spot check of user-reachable stubs)

| primitive | called by (loaded) | server status | user-reachable effect |
|--|--|--|--|
| `start-regexp-search!` / `-backward!` | regex-search.lisp (C-M-s/r) | **STUB** (status only) | **STD-03** — no-op |
| `isearch-highlight!` / `-clear!` | search.lisp (C-s/r) | real (overlay push) | works |
| `find-string-forward` / `-backward` | search, regex-search | real (guards empty needle) | works |
| `replace-regexp-all!` | regex-search.lisp (C-M-%) | real | works |
| `apply-theme!` / `apply-face-styles!` / `set-css-*` / `set-highlight-overrides!` | themes/faces/highlight-rules | stub *paired with a directive push* | works (chrome pushed) |
| system clipboard (kill.lisp) | C-w/M-w/C-y | server-local STUB (no cross-app) | in-editor kill-ring works; cross-app paste deferred (intentional) |
| `toggle-fold-at-point!`/`fold-all!`/`unfold-all!` | folding.lisp (C-c TAB/,/.) | real directive emitters | works |
| `open-doc!`/`open-manual!`/`open-docstring-page!` | docs.lisp (C-h d/.) | real directive emitters | works |

No *other* loaded, user-reachable command was found calling a bare stub whose
stub is the sole effect path (the theme/face stubs are compensated by the pushed
chrome directives; the clipboard stub is a documented deferral that still
round-trips the in-editor kill ring). STD-03 is the one genuinely dead bound key.

---

## Architecture observations

_(in progress — appended below as confirmed)_

---

## Test coverage

_(in progress)_

---

## What's solid

- **`nil`-truthiness discipline.** `null?` appears nowhere in the stdlib. `get`
  with a `nil` default is used only as *retrieval*, and callers test the result
  with `nil?`/`eq?`/`string?` — never `(if (get m k nil) …)` as a bare boolean
  (which would be an always-true bug). `member`/`find-string-*` return `#f` on a
  miss, so `(if (member …) …)` is correct. Core `NIL` is the single
  empty-list/nil object; `symbol?`/`map?` are both false for `nil`, so
  `lookup-key`'s `nil` (unbound) correctly falls through `handle-key`'s `map?`/
  `symbol?` cond arms to the reset branch.
- **Key-reader discipline (the P0 ground).** isearch (`search.lisp`),
  query-replace (`regex-search.lisp`), quit-walk and describe-key (spine embedded)
  all re-arm `read-next-key` only after consuming a key, and every terminal branch
  (enter/escape/C-g/"any other key") exits leaving no pending reader. Re-prompting
  branches (query-replace "unrecognised key", quit-walk "any other key") always
  keep C-g/Escape as a clean abort. No stranded-reader / eats-all-chords path found.
- **`goto!` clamps** (`buffer-primitives.js:358` → `moveTo`), and `positionAt` is
  only ever called on `buf.point` (always valid) — the positionAt-throws family
  does not manifest in stdlib. `back-to-indentation`, `mark-whole-buffer`,
  `transpose-chars` all set point via `goto!`/guards, never raw arithmetic past EOF.
- **Atomic undo + marker discipline** (`editing.lisp:155-202`): `call-with-atomic-undo`,
  `with-marker`, `save-excursion` all close the group / release the marker in a
  `finally`, so a throwing body cannot leak a change-group or a marker.

---

## Open questions

_(in progress)_

---

## Stats

_(filled at close)_
