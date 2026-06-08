# Inline MathJax typesetting for LaTeX minor mode

Design note for live, in-buffer MathJax typesetting with an edit-cycle:
math renders as typeset SVG until point enters it, flips back to source
for editing, and re-typesets when point leaves. Pre-implementation;
settle here, then build on a branch.

**Status:** drafted 2026-06-03 from a design conversation with Jason and
a read-only architecture sweep (findings cited inline). All five open
questions are now **[settled]** (see "Settled decisions" at the end);
the body is updated to match.

## What it does

When `latex-math-preview` is on for a LaTeX buffer, every math segment
(`$…$`, `\(…\)`, `$$…$$`, `\[…\]`) is shown **typeset in place** of its
source. The edit cycle:

- **Point enters a segment** (arrow/`C-f`, word/line motion, or a
  **click** on the typeset math) → that segment flips to **source**
  (raw LaTeX, normally highlighted, fully editable). Other segments stay
  typeset.
- **Point leaves the segment** → MathJax re-typesets the (possibly
  edited) source and the widget reappears.
- **Freshly typed math** (`$|$`, `$$|$$`, `\(|\)`, `\[|\]`) is *not*
  typeset while you author it — because point is inside it, so the
  reveal rule already keeps it as source until you move out. No special
  case needed.

Unlike Emacs (separate process → images → buffer fiddling), we typeset
in-renderer with the already-loaded MathJax and never leave the DOM.

## Architecture findings (what exists vs must be built)

| Need | Status | Evidence |
|---|---|---|
| MathJax available | **Ready** | `apps/desktop/index.html` loads `vendor/mathjax/tex-svg.js` v3.2.2, `startup.typeset:false`, SVG + local font cache; `MathJax.tex2svg(str,{display})` is synchronous once startup resolves (sticky-notes already calls `typesetPromise`). |
| Math delimiters recognised | **Ready** | LaTeX tree-sitter grammar marks `inline_formula` (`$…$`, `\(…\)`) and `displayed_equation` (`$$…$$`, `\[…\]`) — `packages/renderer/src/languages/latex.js`. |
| Point-change hook | **Ready** | `buffer.onChange` fires on every cursor move; the view re-renders from it. Cursor position is **offset-based** (`projection.js`), so widgets don't break cursor math as long as char counts are untouched. |
| Replace a text range with a widget | **MUST BUILD** | `renderRuns` (`view.js`) is `{text,face}`-only; swatches/inline-eval *layer* elements, they don't replace text. |
| Hide a multi-line range, show one row | **Adapt folding** | `folding.js` + `view.js` already hide lines (`displayRowForLine=-1`); display math spanning lines reuses this. |
| Per-range metadata / "reveal unless point-inside" | **MUST BUILD** | No overlay/text-property system; no conceal-on-cursor precedent. Lives in the minor mode + a small renderer hook. |

## The core new capability — replaced-range widget decorations

A general renderer feature (math is the first consumer; images/etc. could
follow): the view accepts a list of **replaced ranges**

```
{ start, end, kind: 'inline'|'block', el: () => Node }   // el is lazy/cached
```

Rendering rules:

- **`inline`** (single visual line): in `renderRuns`, the run(s) covering
  `[start,end)` are replaced by `el()` (an inline `<span>` wrapping the
  SVG); the source characters are not emitted for that span.
- **`block`** (may span lines): hide every line the range touches
  (folding-style) and emit `el()` as a block row at the range's start
  line.
- **Auto-reveal:** any replaced range that **contains point** is
  suppressed and rendered as ordinary source. This is the whole edit
  cycle, expressed once in the renderer. (Multi-cursor: revealed if *any*
  cursor is inside — **[rec]**.)

"Contains point" = `start < point < end` — **exclusive at both ends**
[settled]. The moment point reaches either outer edge (including stepping
past the closing delimiter) the segment counts as exited and re-typesets;
a cursor immediately before the opening or after the closing delimiter
shows the widget, and one step inward reveals the source.

Cursor/click:
- The cursor never lands *inside* a hidden widget: crossing into the
  range reveals it first (re-render on the same `onChange`).
- **Click on a widget** must resolve to a buffer offset inside the
  segment so it reveals and places point — the click-to-offset path
  needs a "click landed on a math widget → segment start (after the
  opening delimiter)" case. **[build]**

## The minor mode controller

`latex-math-preview` (a minor mode; toggle command + optional default):

1. **Scan** the buffer for math segments using the LaTeX tree-sitter
   parse (`inline_formula` / `displayed_equation` nodes → ranges + kind).
   Falls back to a delimiter scanner only if the parse is unavailable.
   Re-scan on text change (debounced).
2. **Typeset + cache.** A `latex → SVG` cache keyed by the segment's exact
   source string (incl. delimiters stripped to the body) and display
   flag. `tex2svg` is sync post-startup, so producing a widget is cheap on
   a cache hit and a single sync call on a miss.
3. **Supply replaced ranges** to the view: every segment except an
   empty/invalid one (see below), each with a lazy `el()` that returns the
   cached SVG.
4. **Re-typeset on leave (lazy).** Track the segment containing point. On
   `onChange`, when point has *left* a segment whose body changed while it
   was revealed, typeset its new body (sync) and refresh its widget before
   the view renders (the mode's handler runs ahead of the view's). While a
   segment is revealed, don't typeset it — it isn't shown.

Empty or whitespace-only bodies and MathJax parse errors → **render as
source with a red wavy (spell-check-style) underline** under the segment
[settled], so the user sees it's invalid and can fix it — never a
broken/error widget. (A `.math-invalid` class with a wavy red
`text-decoration` on the source run; see styles.)

## MathJax helper

`typesetMath(latex, { display })` → a detached SVG `Node`, via
`MathJax.tex2svg` once `MathJax.startup.promise` has resolved (guard a
"not ready yet" window by leaving segments as source until ready, then a
one-shot re-render). Wrap so a throw returns `null` (→ treated as
invalid → source). Lives in a host/renderer module; unit-testable behind
a MathJax stub.

## Toggle & customisation

```lisp
(defcommand toggle-latex-math-preview () "…")        ; per-buffer on/off
(defcustom *latex-math-preview-default* #f
  "When #t, typeset math inline automatically for LaTeX buffers. Off by
   default [settled] — the user opts in per-buffer with
   `toggle-latex-math-preview`, or globally by setting this in their
   init / customisation.")
```
Bound under the existing `latex-mode-map` `C-c` prefix. **Off by
default**; never auto-on for `.tex`.

## Delimiters & scanning

In scope: `$…$`, `\(…\)` (inline); `$$…$$`, `\[…\]` (display, may be
multi-line). Respect escaping (`\$`) and verbatim/comment regions — the
tree-sitter parse handles these, which is why it's preferred over a raw
regex. Markdown also has `$…$`, but v1 is **LaTeX-mode only**; the
renderer capability is generic so markdown can adopt it later — **[rec]**.

## Phased build (so it lands and tests in stages)

- **Phase 1 — pure core (unit-tested):** `typesetMath` (behind a MathJax
  stub); the segment **scanner** (text → `[{start,end,kind,body}]`,
  incl. escaping/empty cases). `node --test`.
- **Phase 2 — renderer replaced-range widgets:** inline run-replacement
  first (2a), then multi-line block via folding-style hide (2b), with
  point-auto-reveal and the click-to-segment mapping. Unit-test the
  range/run math; DOM + cursor need live smoke.
- **Phase 3 — minor mode controller:** scan→typeset→cache, supply ranges,
  lazy re-typeset-on-leave, toggle command + defcustom. Unit-test the
  cache + point-enter/leave logic (pure), hand off the wiring for smoke.
*(Auto-pairing `$`/`$$` is **out of scope** [settled] — Jason wants it as
a separate minor mode. Fresh math already stays as source while you type
it, via Phase 2's reveal rule, so nothing here depends on it.)*

## Settled decisions

1. **Multi-line display math is in v1.** Inline *and* display, including
   multi-line `$$…$$` / `\[…\]` via the folding-style block (Phase 2b).
   "Everyone uses multi-line math."
2. **Reveal boundary is exclusive** (`start < point < end`): typeset the
   instant point exits the segment.
3. **Off by default** for `.tex`. The user enables it with
   `toggle-latex-math-preview` or via `*latex-math-preview-default*` in
   their init/customisation.
4. **Empty/invalid math → source with a red wavy underline**
   (spell-check style).
5. **Auto-pairing is out of scope** — a separate minor mode, later.

## Risks

- **The renderer replaced-range capability is real surgery** to the
  run/line pipeline + folding interaction + click-to-offset; it's the bulk
  of the work and the main risk. Phase it (inline before block).
- **`9/7`-style invariants:** the math feature doesn't add views, but the
  view/cursor/scroll math must stay correct when lines are hidden/replaced
  — reuse folding's accounting, don't reinvent it.
- **Typeset cost** on enabling a math-heavy doc: typeset lazily
  (on first display / on leave), cache by source, and only for
  on-screen + nearby segments if it proves slow.

## Testing

- **Pure (`node --test`):** scanner (delimiters, escaping, multi-line,
  empty/invalid); `typesetMath` behind a stub; the cache; point
  enter/leave detection; "range contains point" reveal predicate.
- **Manual / smoke (hand off, test-before-merge):** typeset appears on
  enable; arrow/click into a segment reveals source; edit + leave
  re-typesets; fresh `$$|$$` stays source until you exit; multi-line
  display math collapses/reveals; cursor lands correctly around widgets;
  invalid LaTeX shows source, not a broken widget.
