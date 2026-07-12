# Data layer (storage, buffer, pane, view) — audit

**Auditor:** audit agent 10 (data layer) — FINISH pass (re-verified every finding with a fresh `node` repro)
**Date:** 2026-07-02
**Branch/commit:** main @ efe0fa6d (suite green, 3290 tests)
**Mode:** read-only; repros via `node` against the real package sources. Every
repro below was executed; its actual stdout is pasted verbatim.

## Scope

| Package | File | Lines | Read fully |
|---|---|---|---|
| `packages/storage` | `src/buffer.js` | 473 | yes |
| `packages/storage` | `src/index.js`, `src/persistence.js` | 12 / 33 | yes |
| `packages/buffer` | `src/buffer.js` | 862 | yes |
| `packages/pane` | `src/pane.js` | 166 | yes |
| `packages/pane` | `src/tree.js` | 391 | yes |
| `packages/pane` | `src/layout.js` | 233 | yes |
| `packages/pane` | `src/navigation.js` | 97 | yes |
| `packages/pane` | `src/index.js` | 55 | yes |
| `packages/view` | `src/view.js` | 235 | yes |
| `packages/view` | `src/view-utils.js`, `src/index.js` | 35 / 27 | yes |

Cross-checked (partial reads) for reachability/caller inventory:
`apps/desktop/mwb/spine.js`, `.../pane-model.js`, `.../protocol.js`,
`.../buffer-registry.js`, `apps/desktop/src/app.js`,
`packages/stdlib/src/buffer-primitives.js`, `packages/stdlib/lisp/editing.lisp`,
`.../keymap.lisp`, and every test file in the four packages.

## Executive summary

No **P0** in the data layer (worst first): the two P1s both need a precondition
that ordinary single-view typing doesn't hit, so neither is a spontaneous
corruption/crash on the happy path.

- **DATA-01 (P1, CONFIRMED):** vertical/column motion (`moveUp`/`moveDown` →
  `positionAt`/`offsetAt`) is computed in **UTF-16 code units**, not code
  points. Moving up or down into a line whose column N falls between the two
  halves of a surrogate pair lands `point` *inside* the pair; the next
  insert/delete then splits the astral character into lone surrogates. Three
  corruption modes reproduced (insert, delete-forward, delete-backward).
- **DATA-02 (P1, CONFIRMED):** `moveUp`/`moveDown`/`moveLineStart`/`moveLineEnd`
  do **not** clamp `point` before handing it to `storage.positionAt`/`lineAt`,
  which throw `RangeError` on an out-of-range offset. A stale over-length cursor
  + one arrow-key press throws. This is the same unclamped-`positionAt` family
  the codebase already patches defensively at three *restore* boundaries
  (SPINE-01 `pointPosition`, DESK-01 restore clamp, `clampRestoredPoints`) — but
  the motion methods themselves, the root, are unguarded.
- **DATA-03 (P2, CONFIRMED):** multi-cursor `insert`/`deleteBackward`/
  `deleteForward` issue one L1 edit per cursor with **no change group**, so an
  N-cursor edit lands as N undo steps. One <kbd>undo</kbd> reverts only the last
  cursor. Reproduced for both insert and delete.
- **DATA-04 (P2, CONFIRMED):** the L1 plain-string backing is O(n) per edit
  *and* `lineStarts()` is recomputed uncached on every `positionAt`/`lineAt`/
  `lineCount`/`offsetAt`, so every cursor-position query — hence every vertical
  keystroke and every modeline repaint — is O(n). ~31 ms per `positionAt` on a
  20 MB line. Acknowledged in the file header ("does not scale"); quantified here.
- **DATA-05 (P3):** an empty insert (`insert(p, '')`) records a live but no-op
  undo step. Minor history pollution.
- **DATA-06 (P3):** `bumpIdCounterPast` has **zero** direct tests and no
  defence against duplicate ids in a hand-edited/corrupt layout blob (two panes
  can end up sharing an id).

## Findings

### DATA-01: vertical motion (`moveUp`/`moveDown` → `offsetAt`) lands point inside a surrogate pair → the next insert/delete corrupts the astral char

- **Severity:** P1 · **Dimension:** Correctness (Unicode / data integrity) · **Confidence:** CONFIRMED (node repro)
- **Location:**
  - `packages/buffer/src/buffer.js:574` `moveUp` and `:585` `moveDown` — use
    `storage.positionAt(c.point).column` and `storage.offsetAt(line±1, column)`.
  - `packages/storage/src/buffer.js:316` `positionAt` → `column: offset - starts[line]`
    (code-unit distance), `:342` `offsetAt` → `Math.min(starts[line] + column, lineEnd)`
    (code-unit addition).
  - `packages/buffer/src/buffer.js:229` `moveCursor` → `clamp(offset)` clamps only
    to `[0, length]` (`:159`), never to a surrogate boundary.

- **Evidence.** `positionAt`'s `column` and `offsetAt`'s `starts[line]+column` are
  both raw UTF-16 code-unit arithmetic. `moveLeft`/`moveRight` avoid this by
  stepping through the surrogate-aware `stepBackward`/`stepForward`
  (`storage/src/buffer.js:235`,`:260`) — but the *vertical* path does not, and
  neither `clamp` nor `moveCursor` re-aligns to a code-point boundary. Once the
  caret sits mid-pair, even the surrogate-aware delete helpers slice exactly one
  half (from offset 5, `stepForward` sees a low surrogate → +1; `stepBackward`
  sees a high surrogate → −1).

  Repro (`data01.mjs`, buffer `"abc\n😀xy"`; U+1F600 = `d83d de00`):

  ```
  point before moveDown: 1 (line0 col1)
  point after moveDown: 5   positionAt=> {"line":1,"column":1}
    offset 4 is high surrogate? charCode(4)= d83d
    offset 5 is low  surrogate? charCode(5)= de00
    => point landed at 5 which is BETWEEN the two halves of the emoji

  (a) after moveDown + insert "Z":
      text units: 61 62 63 a d83d 5a de00 78 79
      emoji still present? false  lone surrogate? true
  (b) after moveDown + deleteForward:
      text units: 61 62 63 a d83d 78 79  lone surrogate? true
  (c) after moveDown + deleteBackward:
      text units: 61 62 63 a de00 78 79  lone surrogate? true
  ```

  Case (a) wedges `Z` (`5a`) between `d83d` and `de00` — the emoji becomes two
  lone surrogates. (b)/(c) each amputate one half. All three yield ill-formed
  UTF-16 that will round-trip to disk as replacement characters.

- **Failure scenario.** File with an emoji (or any astral char: mathematical
  alphanumerics `𝐀`, CJK Ext-B, older-plane glyphs) not in the first column.
  User is on the line above/below, at a column that maps mid-pair, and presses
  <kbd>↑</kbd>/<kbd>↓</kbd> then types or deletes. The character is silently
  destroyed; a subsequent save writes corrupt bytes. The math-preview / LaTeX
  and JMarkdown modes (which the architect uses daily) routinely contain astral
  math letters, so the trigger is not exotic.

- **Fix direction.** Make the vertical path code-point aware. Either (a) after
  computing the target offset in `moveUp`/`moveDown`, snap it to a code-point
  boundary (`storage.stepBackward(target, 0)`-style realignment, or a dedicated
  `snapToCharBoundary`), or (b) measure/apply `column` in code points inside
  `positionAt`/`offsetAt` (heavier — changes the column semantics every caller
  sees). (a) is the localized fix and matches how horizontal motion already
  behaves. A regression test moving vertically onto a surrogate column belongs
  in `packages/buffer/test/unicode.test.js` (which today only exercises
  horizontal motion and deletes).

---

### DATA-02: stale cursor + `moveUp`/`moveDown`/`moveLineStart`/`moveLineEnd` do NOT clamp point before `storage.positionAt`/`lineAt` → `RangeError`

- **Severity:** P1 · **Dimension:** Robustness / API footgun · **Confidence:** CONFIRMED (node repro; reachability plausible)
- **Location:**
  - `packages/buffer/src/buffer.js:576` `storage.positionAt(c.point)` (moveUp),
    `:587` (moveDown), `:601` `storage.lineAt(c.point)` (moveLineStart), `:610`
    (moveLineEnd) — **all pass `c.point` raw**, no `clamp`.
  - Contrast `:558` moveLeft / `:567` moveRight, which *do* `clamp(c.point)`.
  - `packages/storage/src/buffer.js:83` `assertOffset` throws `RangeError` when
    `offset > text.length`; called by `positionAt` (`:310`) and `lineAt` (`:292`).
  - Primitive path: `packages/stdlib/src/buffer-primitives.js:338` `cursor-down!`
    → `buffer().moveDown()`; `:334` `cursor-up!`; `:342`/`:346` line-start/end.
  - Command/key path: `editing.lisp:20` `next-line` → `cursor-down!`;
    `keymap.lisp:137` `"down" → next-line`. So a bare <kbd>↓</kbd> reaches the
    unclamped call.

- **Evidence.** Repro (`data0203.mjs`). Part (A) binds a cursor source whose
  point (100) is past a length-11 buffer; part (B) is the realistic two-view
  path — an edit through view V2 shrinks the buffer while V1's cursor (not a
  marker, so it does **not** ride edits) is left stale, then focus returns to V1:

  ```
  (A) moveUp: THREW RangeError: offset 100 out of range [0, 11]
  (A) moveDown: THREW RangeError: offset 100 out of range [0, 11]
  (A) moveLineStart: THREW RangeError: position 100 out of range [0, 11]
  (A) moveLineEnd: THREW RangeError: position 100 out of range [0, 11]
  (A) moveLeft : survived, point -> 10          <- moveLeft clamps, so it lives
  (B) after V2 delete: buffer length = 0, V1.point still = 100
  (B) moveUp on stale V1: THREW RangeError: offset 100 out of range [0, 0]
  ```

  How a live cursor goes stale: cursors are stored **per view** (`view.js:109`,
  Q2 per-view-point) and the buffer only shifts **markers** on an edit
  (`buffer.js:152-157`); it never shifts sibling views' cursors. So an edit that
  shrinks the buffer through one view leaves every *other* view over that buffer
  holding a possibly-over-length point. The point setters at the pane/wire layer
  reinforce this: `pane-model.js:714/720` `setFocusedPoint` and `protocol.js:674`
  both clamp only `Math.max(0, …)` — i.e. against negatives, **not** against the
  buffer length. The only length-aware clamps (`spine.js:4992`
  `clampRestoredPoints`, `app.js:8679` restore, `spine.js:5712` `pointPosition`)
  are all at *read/restore* boundaries; the write path and the motion methods are
  unguarded.

- **Failure scenario.** Same file open in two panes/windows; a large deletion
  (kill-region, `set-buffer-text!` to something shorter than the other view's
  point, revert) happens in one; the user clicks into the other pane and presses
  an arrow. `next-line` throws inside the spine's command dispatch. Because this
  is the *exact* `positionAt`-out-of-range family the team has already had to
  patch three times at other seams (the doc-comments at `spine.js:5708-5710` and
  `app.js:8672-8674` describe precisely this crash → "freeze the window"), the
  hazard is demonstrably live; only the root has been left unpatched.

- **Fix direction.** Clamp at the source — one line each in `moveUp`/`moveDown`/
  `moveLineStart`/`moveLineEnd`: `const p = clamp(c.point); …positionAt(p)`,
  exactly as `moveLeft`/`moveRight` already do. That fixes every caller
  (primitives, keymap, tests) at once and lets the scattered defensive clamps be
  simplified rather than multiplied. Optionally also clamp inside `bindCursor`
  when a source is (re)bound, so a view can never present an over-length point.

---

### DATA-03: multi-cursor insert/delete are not wrapped in a change group → undo is non-atomic (one undo per cursor)

- **Severity:** P2 · **Dimension:** Correctness (undo/history) · **Confidence:** CONFIRMED (node repro)
- **Location:**
  - `packages/buffer/src/buffer.js:642-675` `insert` — loops the cursor set and
    calls `storage.insert`/`storage.replace` once per cursor (`:658`,`:663`) with
    **no** surrounding `beginChangeGroup`/`endChangeGroup`.
  - Same shape in `deleteBackward` (`:684-721`) and `deleteForward` (`:730-767`).
  - The machinery exists and is unused here: `beginChangeGroup`/`endChangeGroup`
    (`buffer.js:791-798` → `storage` `:367-385`) coalesce edits into a single
    undo entry; `applyEdit` (`storage/src/buffer.js:115-123`) pushes one undo
    entry per call otherwise.

- **Evidence.** Repro (`data0203.mjs`):

  ```
  cursorCount = 2
  after 2-cursor insert "X":  "Xaa\nXbb"
  after ONE undo:             "Xaa\nbb"  (undo returned true)
  canUndo still true?         true  <- second edit still on the stack
  after a SECOND undo:        "aa\nbb"

  --- same for multi-cursor deleteBackward ---
  after 2-cursor deleteBackward: "aa\nbb"
  after ONE undo:                "aa\nXbb"  (only one deletion restored)
  ```

  Two cursors, one `insert('X')`, one <kbd>undo</kbd> → only the second `X`
  disappears; the buffer is left in a state the user never typed. It takes N
  undos to reverse one N-cursor keystroke, and each intermediate state is a
  never-authored mixture.

- **Failure scenario.** Any multi-cursor session (`add-selection!`, column
  edit): type or backspace across several carets, then undo. Instead of the
  edit vanishing, carets peel off one at a time. Also collapses the cursor set
  to the primary on the first undo (`buffer.js:808` `collapseInPlace`), so the
  remaining orphaned edits can't even be undone "in formation."

- **Fix direction.** Wrap each multi-cursor editing method's loop in
  `storage.beginChangeGroup()` / `endChangeGroup()` (try/finally). The group is
  re-entrant, so nesting under an outer `atomic-change-group` stays correct. One
  undo then reverses the whole multi-caret edit. Add a buffer test asserting a
  2-cursor insert takes exactly one undo.

---

### DATA-04: plain-string L1 makes every edit O(n) and — worse — every cursor-position query O(n) (uncached `lineStarts`)

- **Severity:** P2 · **Dimension:** Performance / complexity · **Confidence:** CONFIRMED (traced + timed)
- **Location:** `packages/storage/src/buffer.js:99-107` `emit` rebuilds the whole
  string on each edit; `:136-144` `lineStarts` scans the entire text and is
  called *fresh* (no memoization) by `lineCount` (`:282`), `lineAt` (`:293`),
  `positionAt` (`:311`) and `offsetAt` (`:331`).
- **Evidence.** The O(n)-per-edit copy is acknowledged in the header
  ("every edit copies the whole text … does not scale … replaced by a piece
  tree"). Less obviously, *read* operations are also O(n): `positionAt` rebuilds
  `lineStarts` every call, and `moveUp`/`moveDown` call `positionAt` **and**
  `offsetAt` (two full scans per vertical keystroke); the modeline's line/column
  readout (`spine.js:5712`) scans on every cursor move. Timed (`storage-edge.mjs`):

  ```
  50x positionAt on a 20M single-line buffer: 1581.451583 ms
  ```

  ≈ 31 ms per position query at 20 MB; linear, so a 100 MB file is ~150 ms *per
  arrow-key* just to locate the caret, before any rendering. A single very long
  line (minified JS/JSON, a data URL) hits the same wall at far smaller sizes.
- **Failure scenario.** Opening a large or single-very-long-line file makes
  navigation and the modeline janky/unresponsive well before the edit-copy cost
  dominates. This is the known "piece tree later" debt; flagged because the
  *read-side* O(n) (uncached `lineStarts`) is a cheap independent win — memoizing
  `lineStarts` behind the existing change listener would remove the per-keystroke
  scan without the full piece-tree rewrite.
- **Fix direction.** Cache `lineStarts` and invalidate it in the `onChange`
  path (or maintain it incrementally per change). Independent of, and much
  smaller than, the eventual piece-tree swap the header promises.

---

### DATA-05: an empty insert records a live no-op undo step

- **Severity:** P3 · **Dimension:** Correctness (history hygiene) · **Confidence:** CONFIRMED (node repro)
- **Location:** `packages/storage/src/buffer.js:155-161` `insert` → `applyEdit`
  unconditionally, even when `insertText === ''`. `delete(start, start)` and an
  empty change group are handled (the group records nothing, `:383-384`), but a
  bare empty insert/delete is not short-circuited.
- **Evidence** (`storage-edge.mjs`):

  ```
  after empty insert: text= "hello" canUndo= true (records an empty undo step)
  empty change group canUndo: false (expect false)
  empty insert (no group) canUndo: true (expect true — undo of a no-op)
  ```

- **Failure scenario.** A Lisp command that does `(insert! "")` (or a delete of a
  zero-width range) on a code path that sometimes has nothing to insert leaves a
  dead entry on the undo stack; the user presses undo and nothing visible
  happens (the "undo did nothing" confusion). Harmless to data, annoying to use.
- **Fix direction.** In `applyEdit` (or the `insert`/`delete` methods), skip
  recording when `inserted === '' && removed === ''`.

---

### DATA-06: `bumpIdCounterPast` — zero direct tests + no duplicate-id defence

- **Severity:** P3 · **Dimension:** Robustness / test coverage · **Confidence:** CONFIRMED (traced)
- **Location:** `packages/pane/src/pane.js:46-53`.
- **Evidence / contract analysis.** The function is the session-restore guard
  that stops a freshly minted id from colliding with a restored one:

  ```js
  const match = seenId.match(/-(\d+)$/);
  if (!match) return;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return;
  if (n >= nextId) nextId = n + 1;
  ```

  - Parses `pane-leaf-<n>` / `pane-split-<n>` correctly; leaf and split share the
    one module-level `nextId`, so bumping past either advances both — correct.
  - Non-numeric-suffix ids (hand-edited `pane-custom`, trailing dash
    `pane-leaf-`) → no match → silently ignored. Documented and safe.
  - A *foreign* id that happens to end in digits (e.g. a view id `view-text-5`)
    would bump the pane counter to 6 — harmless (separate counter), but there's
    no shape check, so a mis-passed id can jump the counter arbitrarily far
    (a pathological `pane-x-999999999999999999999` sets `nextId` into scientific
    notation via the template literal). Low-probability.
  - **Blind spot:** it advances the counter but never detects that a restore blob
    contains **duplicate** ids. A corrupt/hand-edited `workspaces.json` with two
    leaves both `pane-leaf-3` restores two panes sharing an id; `findPaneById`
    (`tree.js:81`) then returns whichever it meets first, and `replacePane` can
    swap the wrong node. No node repro (needs a corrupt blob), traced only.
  - **Coverage:** grepping the pane test dir, every other pane export is
    exercised; `bumpIdCounterPast` is mentioned **zero** times.
- **Fix direction.** Add unit tests pinning the parse contract (leaf/split,
  non-numeric, collision monotonicity). Optionally validate `seenId` against the
  `pane-(leaf|split)-\d+` shape and dedupe ids during restore (log + re-mint on
  collision) rather than trusting the blob.

## API footgun analysis

Two related footguns dominate the layer.

**(1) The `point=` / `mark=` setters never clamp to buffer length.** Both the
local backing (`buffer.js:83-94`) and the View (`view.js:110-121`) expose
`point`/`mark` as plain accessors that write straight through to
`cursors[0]`. The *buffer* API that goes through `moveCursor`/`clamp`
(`buffer.js:229-236`) and `moveTo`/`setMark` is safe, but any code assigning to
`view.point` directly bypasses that. Repo-wide caller inventory:

| Call site | Form | Clamps to length? | Verdict |
|---|---|---|---|
| `buffer.js:235` `moveCursor` | `clamp(offset)` | yes `[0,len]` | SAFE |
| `buffer.js:659-757` insert/delete internals | computed in-range | n/a | SAFE |
| `buffer.js:779` `setText` | `= 0` | n/a | SAFE |
| `buffer.js:809,823` undo/redo | `clamp(lastChange…)` | yes | SAFE |
| `spine.js:4992` `clampRestoredPoints` | `max(0,min(point,len))` | **yes** | SAFE |
| `app.js:8676-8679` restore | `clampOffset(...)` to `len` | **yes** | SAFE |
| `buffer-registry.js:242` | `= 0` | n/a | SAFE |
| `pane-model.js:596,638,666` | `= 0` | n/a | SAFE |
| `pane-model.js:166` `freshState` seed | `p ?? 0` (raw) | **no** | RISKY |
| `pane-model.js:714,720` `setFocusedPoint` | `max(0, floor(point))` | **no (≥0 only)** | RISKY |
| `pane-model.js:988,991` restore leaf | raw `point` | **no** | RISKY |
| `protocol.js:674` deserialize wire node | `max(0, floor(point))` | **no (≥0 only)** | RISKY |
| `app.js:8679` | value already length-clamped above | yes | SAFE |

The RISKY rows can each seat an over-length `point`; DATA-02 is what happens
next when a motion command reads it. Note `setFocusedPoint` is the *general*
post-edit/motion point writer — not a restore-only path — so the gap isn't
confined to session restore.

**(2) The `positionAt`-throws family.** `storage.positionAt`/`lineAt`/`offsetAt`
all `assertOffset` and throw `RangeError` on an out-of-range offset
(`storage/src/buffer.js:83-92`). Callers split into:

- *Guarded* (pre-clamp before calling): `spine.js:5712` `pointPosition`
  (SPINE-01's fix), `app.js:8676` restore (DESK-01's fix), `spine.js:4992`
  `clampRestoredPoints`, `gotoLine` (`spine.js:5725`, clamps the line).
- *Unguarded* (the root): `buffer.js:576/587` `moveUp`/`moveDown` →
  `positionAt`, `:601/610` `moveLineStart`/`moveLineEnd` → `lineAt`.

The pattern is telling: three separate boundaries have each grown a bespoke
clamp to stop the same crash, while the four methods that actually read the raw
cursor stayed unclamped. Fixing the root (DATA-02) subsumes all three patches.

## Architecture observations

- **Cursors are per-view; markers are per-buffer.** Point/mark live on the bound
  cursor source (`view.js:106-122`, `bindCursor` `buffer.js:513-519`); markers
  live in the buffer's `markerShifts` set (`:150-157`) and ride every L1 change
  including undo/redo (undo emits through the same `storage.onChange`). This is a
  clean split and means two views **cannot** fight over one buffer's markers —
  markers are shared and buffer-global (Emacs semantics), cursors are private.
  The cost is DATA-02: nothing shifts a non-focused view's cursor when the buffer
  shrinks under it. Consider treating each view's point as a marker (or shifting
  sibling cursors on edit) so per-view points stay valid by construction.
- **Marker gravity is fixed left.** `makeMarker` (`buffer.js:176-199`) holds when
  `pos <= start` (insert at the marker keeps it in place). There's no
  insertion-type / right-gravity option as in Emacs. Fine for bookmarks today;
  worth noting before a feature wants right-gravity markers.
- **Undo restores point to the *change site*, not the pre-edit caret.**
  `buffer.js:809/823` set point to `lastChange.start + inserted.length`; for a
  change-group undo, `lastChange` is the last-emitted inverse (the group's first
  edit). Adequate, but not the "restore the caret where it was" fidelity Emacs
  gives.
- **Pane tree CoW is disciplined.** `replacePane`/`insertAt*`/`swapLeaves`/
  `permuteLeaves` (`tree.js`) rebuild split nodes and share leaf nodes by
  reference *intentionally* (documented at `tree.js:1-12`); I found no in-place
  mutation of a shared split node behind a CoW claim. `createSplitPane` rejects
  ratio ∉ (0,1)/NaN (`pane.js:103-112`), and every restore/mutate caller
  pre-clamps the ratio (`pane-model.js:1010` restore → 0.5 fallback,
  `:506-507` `setSplitRatio` → [0.05, 0.95]), so the strict constructor can't be
  tripped by a corrupt blob. Solid.
- **Line model is LF-only.** `lineStarts` splits on `\n` only, so a `\r` (CRLF or
  lone old-Mac `\r`) is ordinary line text (`storage-edge.mjs`: `"a\r\nb"` →
  `line 0 text "a\r"`; `"a\rb"` → one line). Consistent and matches the buffer
  unicode test's CRLF-delete case; just note that column/offset math counts the
  `\r`.

## Test coverage

Per-package, exports that are **naked** (zero direct tests) vs protected:

- **storage** (`createBuffer` + methods): thorough. `index.test.js` covers
  insert/delete/replace/slice/lineAt/positionAt/offsetAt (incl. over-long column
  clamp), onChange, undo/redo, change groups (nesting, empty, unbalanced);
  `unicode.test.js` covers `stepBackward`/`stepForward` (pairs, lone surrogate,
  clamping, out-of-range). **Gap:** no test that `offsetAt`/`positionAt` land on
  a surrogate *column* (DATA-01), and no empty-insert-history test (DATA-05).
  `persistence.js` (`loadBuffer`/`saveBuffer`) has its own small test file.
- **buffer** (`createBuffer` + cursor/edit/undo/marker/multi-cursor): broad —
  `buffer.test.js` (single + multi-cursor + bindCursor), `marker.test.js`
  (gravity, span-collapse, whole-buffer), `unicode.test.js` (horizontal emoji
  edits, marker-near-emoji, combining mark, CRLF). **Gaps, all three findings sit
  here:** (a) `moveDown keeps the column across lines` uses BMP text only — no
  surrogate on the target line (DATA-01); (b) no motion method is driven with a
  stale over-length point (DATA-02); (c) no undo-atomicity assertion after a
  multi-cursor edit (DATA-03).
- **pane**: every `tree.js`/`layout.js`/`navigation.js`/`pane.js` export is
  exercised **except `bumpIdCounterPast` (ZERO)** (DATA-06). `splitRect` is only
  lightly hit directly (3 mentions) but is covered transitively via
  `computeRects`.
- **view**: `createView`/`isView`/`isTablineView`/`tablineActiveChild`/
  `viewFilePath` all tested. Not separately checked: the per-view `point`/`mark`
  accessors' no-clamp behaviour (relevant to the DATA-02 footgun) is asserted
  nowhere.

Assertion quality is generally good (the suites assert concrete text/offset
outcomes, not just "no throw"). The blind spots are unicode-column navigation,
stale-cursor motion, and multi-cursor undo atomicity — precisely the three
confirmed findings.

## What's solid

- Horizontal motion and delete are correctly surrogate-aware end to end
  (`stepBackward`/`stepForward` + the buffer's use of them); the unicode delete
  tests are real regression tests.
- Marker shifting is a single funnel (`markerShifts` over `storage.onChange`), so
  markers ride inserts, deletes, undo and redo uniformly; span-deletion collapse
  and whole-buffer-clear are tested and correct.
- Change-group machinery in L1 is correct and well-tested (nesting, empty group
  records nothing, unbalanced end ignored, undo/redo refused mid-group) — the
  only gap is that the multi-cursor edit methods don't *use* it (DATA-03).
- Pane tree walking/replacement/permutation is immutable with clean structural
  sharing; ratio validation is defended at every caller; layout math is
  pixel-perfect and well-tested.
- The `positionAt`-throws hazard is at least *known* to the team — three
  boundaries already clamp defensively — which makes the remaining root fix
  (DATA-02) low-risk.

## Open questions

1. **DATA-02 live reachability.** The `RangeError` and the two-view staleness are
   confirmed at the buffer/primitive layer. Does any spine broadcast path
   re-clamp a *non-focused* view's point when an edit shrinks a shared buffer? I
   found only restore-time clamps, none on the live edit-broadcast path — but I
   can't run the Electron app here to close the loop end to end. Worth a live
   two-window test (same file, big delete in one, arrow in the other).
2. **DATA-01 scope.** Is the vertical-into-surrogate case the only code-unit
   leak, or do word-motion / paragraph-motion / `goto-column` primitives (not in
   this layer) also compute columns in code units? They should be swept with the
   same lens.
3. Should per-view point be reified as a marker (auto-valid under edits),
   eliminating the DATA-02 class outright rather than clamping at N call sites?

## Stats

- **Findings by severity:** P0 = 0 · P1 = 2 (DATA-01, DATA-02) · P2 = 2
  (DATA-03, DATA-04) · P3 = 2 (DATA-05, DATA-06). Total 6.
- **Confidence:** CONFIRMED via executed node repro = 5 (DATA-01/02/03/04/05);
  CONFIRMED via trace (no runnable repro without a corrupt blob) = 1 (DATA-06).
- **Files read fully:** 12 (all four packages' `src`). Cross-checked partially:
  6 app/stdlib files + all package test files.
- **Repro scripts (scratchpad, not written into the repo):** `data01.mjs`,
  `data0203.mjs`, `storage-edge.mjs`.
