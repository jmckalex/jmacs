# Auto-fill mode — wrap-as-you-type, mode-aware indent

A minor mode that breaks the current line at the fill column as the user
types, indenting the continuation line the way the major mode wants.
Emacs's `auto-fill-mode` / `do-auto-fill`, rebuilt on the editor's own
buffer primitives and mode system.

Requested by the architect 2026-07-04 (build autonomously on a branch).

## STATUS

- **Branch:** `auto-fill-mode` (off `main` @ `0badde23`).
- **State:** BUILT + unit-tested; **not yet live-verified** (touches
  `keymap.lisp` and `spine.js`, both in the server slice → needs a full
  quit + relaunch, which the build env can't drive). See the live-verify
  checklist at the bottom.
- **Merge:** await the architect's live pass, per
  `feedback_test_before_merge`.

## What it does

- `M-x auto-fill-mode` toggles a per-buffer minor mode. **Off by
  default** (Emacs convention; opt in per buffer or per major mode).
- With it on, typing a character that pushes the current line past the
  fill column breaks the line at the last word boundary at/before the
  column (falling back to the first boundary after the column for an
  over-long word, exactly as Emacs does), then indents the new line.
- `*fill-column*` (defcustom, default **70** — Emacs's default)
  controls the width; a major mode may pin its own value via a
  `:fill-column` key on the mode map (like `:tab-width` / `:indent-tabs?`
  in `indent.lisp`).
- `C-x f` = `set-fill-column` (Emacs's binding) sets it interactively.

## The design

Three seams, smallest-thing-that-works, all server-side (Model B: the
spine owns the buffer and resolves every key).

### 1. `*post-self-insert-hook*` (keymap.lisp) — the general seam

Emacs runs `post-self-insert-hook` after each self-inserting keystroke;
auto-fill is its canonical member. We add the same seam to `handle-key`'s
self-insert clause:

```lisp
((self-insert-key? key)
 (set! *last-command* 'self-insert)
 (insert! key)
 (run-post-self-insert-hook key)   ; NEW
 #t)
```

`*post-self-insert-hook*` is an empty list by default, so a self-insert
costs nothing until something registers. Each hook fn is called with the
inserted key string, **inside a `try`/`catch`** so a buggy hook can never
wedge typing or crash the spine (cf. the open "top-level catch" design
question — this scopes the guard to the one hot path that must never
throw). This is a reusable seam (electric-pair-style behaviours could use
it later); auto-fill is just the first client.

**Why a general hook rather than a hard-coded `(maybe-auto-fill)` call:**
if `auto-fill.lisp` fails to load, the hook stays empty and typing is
unaffected — a hard-coded call to a missing symbol would throw on every
keystroke. It is also the architecturally-correct seam (matches Emacs,
generalises).

**Global hook + per-buffer mode.** The hook variable is global, but the
mode is per-buffer (the modes spec forbids buffer-local variables in v1).
So auto-fill registers its fn on the hook **once, at load**, and the fn
guards on `(member auto-fill-mode (minor-modes))` for the *current*
buffer. Enabling/disabling the mode must NOT add/remove the hook fn (that
would clobber other buffers); membership is the only activeness test.

### 2. `do-auto-fill` (auto-fill.lisp) — the algorithm

Runs after each self-insert when the mode is active. Pure core, thin glue:

- **Pure, heavily tested:** `-auto-fill-break-index line fill-column
  prefix-len` → the index of the whitespace char to break at, or `#f`.
  Prefers the last breakpoint at/before the column; falls back to the
  first after it; never breaks inside the leading indentation
  (`prefix-len`) or where it would leave the first line contentless.
- **Glue:** compute the column as `(- (point) (line-start))`, read the
  line text and its leading indent, ask the pure helper for a break
  index, and if there is one, break: replace the whitespace run at the
  break with `"\n"` + the continuation indent, wrapped in
  `atomic-change-group` (one undo step) with a marker holding point so
  the caret stays on the character it was on.

### 3. `:fill-indent-function` — the mode-specified indenter

The continuation line's indent is chosen by the **major mode**, per the
request ("the particular lisp function used for the indent can be
specified by the major mode, to handle each syntax's peculiarities"):

- If the current major mode's map has a `:fill-indent-function` (a
  procedure, or a symbol naming one — resolved like `:keymap`), auto-fill
  positions point at the start of the new line and calls it; the mode's
  function sets the line's indent from syntactic context.
- Otherwise the **default** reproduces the broken line's leading
  indentation (the classic prose fill-prefix). Correct for
  fundamental/markdown/text out of the box.

A mode plugs in its indenter by `assoc`-ing the key onto its mode value,
e.g. `(set! some-mode (assoc some-mode :fill-indent-function 'some-indent-line))`.

## Files

- `packages/stdlib/lisp/auto-fill.lisp` — NEW. The mode, the defcustom,
  the algorithm, the two commands, the hook registration.
- `packages/stdlib/lisp/keymap.lisp` — the `*post-self-insert-hook*` seam
  + the self-insert call + the `C-x f` binding.
- `packages/stdlib/src/index.js` (`STDLIB_FILES`) and
  `apps/desktop/mwb/spine.js` (`SPINE_STDLIB`) — register `auto-fill.lisp`
  right after `keymap.lisp` (it needs the hook seam at load time).
- `packages/stdlib/test/auto-fill.test.js` — NEW. Pure-helper cases +
  real-buffer mutation over a `{text,pos,mark}` stub (line-indent.test.js
  pattern), fill-column customisation, the `:fill-indent-function` seam,
  the hook wiring, the toggle.

## Assumptions made (architect to confirm / adjust)

1. **Off by default.** Matches Emacs. Enable per major mode with, e.g.,
   `(add-hook markdown-mode (lambda () (enable-minor-mode auto-fill-mode)))`
   in `init.lisp`. Not registered as a default text minor mode — I judged
   auto-wrapping-everywhere too intrusive to force on. Easy to flip if you
   want it default-on in prose modes.
2. **Default column 70** (Emacs). The generic `M-q` `fill-paragraph!`
   host primitive hardcodes 72; I did **not** change that — auto-fill and
   M-q are independent code paths and I kept the change surface minimal.
   If you want them unified on `*fill-column*`, that's a follow-up (the
   primitive is JS in `buffer-primitives.js`).
3. **Column measured in characters** (`point - line-start`), like the
   existing `fillParagraph` (`.length`). A literal tab counts as one
   column, not `*tab-width*`. Fine for prose (no leading tabs mid-line);
   a tab-aware visual column is a later refinement if code auto-fill
   needs it.
4. **Auto-fill only ever creates continuation lines** — it never
   re-indents the first line or re-flows the paragraph. That's `M-q`'s
   job. It also fires only on self-insert, never on `newline` (RET copies
   indent via `newline` in editing.lisp already).
5. **Only the prose default indenter ships.** The `:fill-indent-function`
   seam is built and tested, but no language currently defines a
   line-indent function (there is no `indent-line-function` anywhere in
   the tree yet), so no mode sets the key. Wiring a real per-syntax
   indenter (LaTeX/Lisp) is a separate feature that this seam enables.
6. **Client-prediction reconcile.** Because the spine owns the buffer,
   the client predicts the plain self-insert and the server's fill
   (delete space, insert newline+indent) arrives as a reconcile a frame
   or two later. End state is correct; watch for visible flicker in the
   live pass. No client-side fill — that would violate the
   server-authoritative model.
7. **`C-x f` = `set-fill-column`.** `f` was free under `C-x` and this is
   the Emacs binding. `auto-fill-mode` itself gets no key (M-x only, as
   in Emacs).

## Live-verify checklist (needs full quit + relaunch)

1. `M-x auto-fill-mode` in a `*scratch*` / `.md` buffer; type a long
   paragraph — lines should wrap at ~70 cols as you pass the boundary,
   caret staying on the character you're typing.
2. `C-x f` → set a small column (e.g. 30) → type; wraps sooner. `M-x
   customize` `*fill-column*` should show + persist.
3. Toggle off (`M-x auto-fill-mode`) → typing no longer wraps.
4. Indented paragraph (leading spaces) → continuation lines keep the
   indent.
5. Undo (`C-z`) after a wrap → the break undoes as one step with the
   typed char.
6. Confirm typing in a buffer **without** the mode is unaffected (the
   empty-hook / membership guard), and that a non-text view (shell/media)
   doesn't choke.
