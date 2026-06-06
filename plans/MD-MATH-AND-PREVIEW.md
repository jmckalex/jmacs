# Markdown LaTeX-math highlighting + morphdom preview

Two related markdown features. Plan 1 first — its code-awareness helper and
math scanning feed Plan 2.

Status: **Plan 1 building** on branch `md-math-highlight`. Plan 2 queued on
`md-preview-morphdom`. Both hand off for live testing before merge (per
`test-before-merge`): unit tests can't exercise real MathJax.

---

## Plan 1 — LaTeX-math syntax highlighting in Markdown

**Goal:** in `.md`/`.jmd` buffers, the four math constructs `$…$`, `$$…$$`,
`\(…\)`, `\[…\]` get LaTeX highlighting on their *contents* (commands →
keyword, braces → paren, `%` → comment), with the delimiters in their own
face — except inside code, where `$` is literal.

Note this is *more* than `latex-mode` itself does: latex-mode colours an
inline `$x^2$` as one `string` blob (see `highlight.test.js:143`). We tokenize
the body so `\alpha` etc. light up.

**Territory:** `packages/renderer/` only.

### Changes — `packages/renderer/src/highlight.js`

- Import `scanMathSegments`, `MARKDOWN_MATH_CONFIG` from `./math-segments.js`
  (pure module, no cycle).
- Add `highlightMarkdownBuffer(text) → Run[][]`, registered in
  `highlightBuffer` (line ~647) next to `latex`/`makefile`.
- Line splitting via `text.split('\n')` — matches `highlightMakefileBuffer`
  and the view's line indexing exactly.

**Why whole-buffer, not per-line:** inline `$…$` fits a line, but display
`$$…$$` / `\[…\]` span lines — the per-line `tokenizeMarkdown` (`highlightLine`)
structurally cannot see across them.

**Integration correction (found in live testing).** Markdown is highlighted by
its *tree-sitter* grammar (`tag: 'markdown'`, `suffixes: ['.md','.markdown']`),
and the view consults `highlighters[language]` **before** `highlightBuffer`
(`view.js:554`) — so `highlightMarkdownBuffer` was only ever the
grammar-failed-to-load fallback and was dead in the app. The real fix is an
**overlay**: `overlayMarkdownMath(text, perLine)` splices LaTeX onto the math
regions of *already-computed* per-line runs (whatever produced them), called
from the view's tree-sitter branch for markdown before caching.
`highlightMarkdownBuffer` now delegates to it so the fallback path matches.

### Algorithm

1. `masked = maskMarkdownCode(text)` — a same-length copy with code chars
   replaced by spaces (newlines kept). Covers fenced blocks (```` ``` ````/
   `~~~`, closing fence = same char, length ≥ opener) and inline code spans
   (matched backtick runs of equal length). This is the *only* place the
   highlighter must be code-aware; `scanMathSegments` is not.
   - Masking *before* the scan (not filtering after) is required: a stray `$`
     in code otherwise mis-pairs with a real `$` and eats the following
     formula. Masking → the in-code `$` is a space → correct pairing.
   - v1 gap (noted in commit): 4-space indented code blocks aren't masked.
2. `segments = scanMathSegments(masked, MARKDOWN_MATH_CONFIG)` — offsets are
   into the original text (mask is length-preserving); bodies re-sliced from
   the original.
3. Base runs per line = `tokenizeMarkdown(line)` — **unchanged today's output**
   (parity is a test), so non-math markdown is byte-identical.
4. For each segment, attach its per-line portion to a `byLine` map: the line's
   column range, plus how many leading/trailing chars on that line are
   delimiters (opener only on the segment's first line, closer only on its
   last). `delimiterWidths`: block → 2/2; inline → 1/1 for `$`, 2/2 for `\(`.
5. `spliceMathRuns(line, base, placements)` replaces the math columns: a
   delimiter run (face `string`) + `tokenizeLatex(body-slice)` runs + closing
   delimiter run. Outside the math columns it keeps `base` (via `sliceRuns`).
   Adjacent equal-face runs merged; `runs.join('') === line` invariant holds.

**Delimiter face:** `string` (kin to latex-mode's math tint) — all existing
faces, no stdlib/face registration needed. Body faces come from `tokenizeLatex`
so they inherit the live `C-h C-f` customization for free.

### Tests — `packages/renderer/test/highlight.test.js`
inline `$x^2$`; multi-line `$$…$$`; `\(…\)` / `\[…\]`; escaped `\$`; `$x$`
inside inline-code and fenced-code → *not* math; **parity** (non-math lines ===
`tokenizeMarkdown`); delimiter face; `runs.join('') === line`.

---

## Plan 2 — morphdom upgrade of the `C-c v` preview pane

**Goal:** replace `body.innerHTML = html` (`markdown-preview.js:79`) with a
morphdom diff so refresh is fast, flicker-free, scroll-preserving, and **only
new/changed math is re-typeset** (keyed spans).

**Territory:** `packages/renderer/` + one dep.

**Correction to first-pass assumption:** the current preview is *already*
code-safe — MathJax's default `skipHtmlTags` excludes `<code>`/`<pre>`, and
`marked` renders code as those tags. So there is no "typeset `$` in code" bug
in the preview; code-awareness is a Plan-1 (raw-buffer) concern only. Plan 2's
wrap still skips `code`/`pre`/`script` to avoid minting useless keys.

### Changes

- `packages/renderer/package.json` — add `morphdom` pinned exact (confirm
  latest 2.7.x). Import the ESM build in `markdown-preview.js`.
- `markdown-preview.js` — keep the public API (`element/update/refreshNow/
  clear`); rewrite `refreshNow`:
  1. `html = await render(source)` (unchanged; works for `marked` and the
     JMarkdown shell-out path — we operate on the resulting DOM).
  2. Build detached `next` (`innerHTML = html`).
  3. `wrapMathInDom(next)` — walk text nodes, skipping the MathJax skip-set,
     find math via `scanMathSegments`, wrap each region as
     `<span class="math" data-math-key="{hash(display+body)}#{nth}"
     data-math-display="0|1">$…$</span>` (raw delimiters kept inside so MathJax
     still typesets it; `#nth` keeps keys unique for repeated formulas).
  4. Selective typeset: `currentKeys` = keys already live in `body`; typeset
     **only** the `next` spans whose key is new/changed, in the detached
     fragment, before morphing → no raw-`$` flash, minimal MathJax work.
     - Risk: detached typeset should work with `tex-svg` (SVG needs no layout);
       verify live. Fallback: post-morph typeset of un-flagged `.math` spans
       (brief flash on changed math only).
  5. `morphdom(body, next, { childrenOnly: true, getNodeKey, onBeforeElUpdated })`:
     - `getNodeKey: n => n.dataset?.mathKey ? 'math:'+n.dataset.mathKey : n.id`
       — unchanged math (same key) kept from the live DOM (already typeset);
       changed keys swapped wholesale (no mjx→text diff churn); removed math
       discarded.
     - `onBeforeElUpdated`: equal-key `.math` pair → return `false` (never
       descend into a typeset formula).
  6. Keep the `renderToken` async-ordering guard.

**Net:** unchanged math untouched, only edited/added formulas re-typeset,
scroll preserved (we morph `body`'s children, not replace `body`).

### Tests — `packages/renderer/test/markdown-preview.test.js`
debounce/token preserved; morph preserves an unchanged node's identity across
re-render; changed math → new key, unchanged → same key; math inside code not
wrapped; mocked MathJax called only with new/changed spans. Real MathJax isn't
in the unit env → the morph+typeset dance is **live-tested** in the app
(Cmd+R, renderer code) before merge.

---

## Shared / sequencing
- Build Plan 1 first; its math scanning + (conceptually) code-awareness inform
  Plan 2's wrap.
- Separate branches, each tests-green, each handed to Jason for live testing
  before its own merge.
