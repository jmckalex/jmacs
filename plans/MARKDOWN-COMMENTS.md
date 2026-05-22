# Plan — pretty-printed markdown in comments

**Status: planned, not started.** A detailed design for review.

**Revised** — the view *replaces* the comment lines with the rendered
block, rather than overlaying a fixed-height box. See "The approach".

## Context

The architect wants block comments in source files — e.g. a multi-line
`/* … */` in a JavaScript file — to display their *rendered HTML* in
place of the raw comment text in the editor view.

Detection and the markdown rendering reuse machinery already in the
tree: tree-sitter's `(comment)` captures (`treesitter.js`) give a
multi-line comment's full range, and the JMarkdown render pipeline
(`host.renderJMarkdown` → the `jmarkdown:render` IPC → a shell-out to
the configured command) turns markdown source into HTML. Those parts
are settled. The hard part — and the part this revision changes — is
how the rendered HTML appears in the view.

## The approach: the view replaces, it does not overlay

An earlier draft of this plan overlaid a rendered box on top of the
comment, sized to the comment's line count. **Rejected by the
architect**, for a sound reason: the formatted markdown will not occupy
the same vertical space as the raw comment — a heading-and-list comment
of three source lines may render to eight lines' worth of HTML, or one.
A box sized to the source's line count is simply wrong.

Instead, **the view replaces the comment's lines with the rendered
block, at whatever height the HTML needs, and flows the rest of the
document around it.**

This is deliberately a stress test of the Layer 2 / Layer 4 separation.
**L2, the semantic buffer, is untouched** — it holds the raw comment
text, every line, every offset; point and mark are unchanged. **L4, the
view, *projects* that buffer** — and the projection is no longer
uniform: a region of the buffer is shown as a single, variable-height
block. The view stops assuming "buffer line *N* is at `N · 1lh`."

Today that assumption is everywhere, because the view is a nearly 1:1
projection. Breaking it forces the buffer↔view boundary to become a
real, explicit, tested abstraction — which is the point. It also yields
a *general* mechanism (below), not a comment-only hack.

## What this requires of the view — a layout model

The view today positions every line at `top: calc(index · 1lh)` and
sizes the document to `lineCount · 1lh`. The cursor, `offsetFromPoint`,
the gutter, virtualisation and selection rectangles all rest on that
uniform grid.

A variable-height block breaks the grid. The view needs a **layout**: an
ordered list of *rows*, each either

- a **text line** — one buffer line, height `1lh`; or
- a **replaced region** — a contiguous range of buffer lines shown as a
  single block of measured, intrinsic height.

The layout assigns each row a `top` and `height` by accumulation; the
document's total height is the sum. A buffer line ↔ a view pixel is now
a *lookup through the layout*, not arithmetic.

This is the well-known *block widget* / *replaced range* pattern
(CodeMirror's block widgets, Monaco's view zones). It is a renderer
architecture change, and worth doing as one: once the view can place a
variable-height block, the same mechanism later serves folded regions,
inline images, even hosting the sticky notes as real block widgets.

Concretely, in `packages/renderer/src/view.js`:

- **A layout pass** runs before line rendering: walk the buffer's
  lines; emit a replaced-region row where a markdown-comment region is
  active, a text-line row otherwise; accumulate `top`/`height`.
- **Line positioning** reads `top` from the layout instead of computing
  `index · 1lh`.
- **`content.style.height`** is the layout's accumulated total.
- **Virtualisation** — "which rows are visible" becomes a search over
  the layout (the row containing `scrollTop`), not `floor(scrollTop /
  lineHeight)`.
- **`offsetFromPoint`** (pixel → buffer offset, for the mouse) resolves
  through the layout: find the row at *y*, then the column, or — for a
  replaced region — the comment's offset.
- **The cursor, current-line band, selection rectangles, brackets** —
  all positioned via the layout.
- **The gutter** — a replaced region spans several buffer lines but is
  one block; the gutter shows the region's first line number (see Open
  questions).

## The replaced block's height — estimate, measure, reflow

A block's true height is its rendered HTML's natural height, knowable
only *after* the HTML exists — and the JMarkdown render is asynchronous.
So: the layout uses an **estimate** first (e.g. the comment's own line
count), renders the HTML, **measures** the block, caches the height,
and **reflows** the layout when the measurement differs. This
estimate→measure→reflow cycle is standard for variable-height viewports;
the async render the feature already needs makes the asynchrony free.

## Detection and comment → markdown

Unchanged from the earlier design.

- **Detection** — opt-in via a magic first line (`/*md …`, `<!--md …`,
  a `#md` line in Python), not all block comments, so licence headers
  and JSDoc are untouched. Isolated in one predicate,
  `isMarkdownComment`. *Open question* — the alternatives are all block
  comments, only `/** */`, or a per-buffer toggle.
- **`commentToMarkdown(commentText, language)`** — a pure, unit-tested
  function that strips the delimiters (`/*md`, `*/`, a leading `* ` per
  line) and de-indents. Its output goes to `host.renderJMarkdown`,
  reusing the source-keyed HTML cache.
- Phase 1 covers tree-sitter languages (JS/HTML/Python) only — only
  tree-sitter reliably gives multi-line comment extent.

## Editing — toggle to raw

The comment *is* real buffer text, so editing is just editing the
buffer. **When the cursor is inside the comment's line range, the view
projects those lines raw** — ordinary `1lh` lines — and the layout
reverts that region to text rows; when the cursor leaves, the region
becomes a block again. The set of replaced regions is therefore
cursor-dependent, and the layout recomputes when the cursor crosses a
comment boundary. A manual per-buffer toggle command is also provided.

## Components

- **`packages/renderer/src/layout.js`** (new) — a pure
  `computeLayout(lineCount, replacedRegions, lineHeight)` → rows with
  `top`/`height`, plus lookups (pixel→row, line→row, row→lines). Pure
  and heavily unit-tested — the heart of the buffer↔view mapping.
- **`packages/renderer/src/view.js`** (substantial change) — render
  through the layout: positioning, virtualisation, scroll height,
  `offsetFromPoint`, cursor, selection, gutter. The view gains an input
  for the active replaced regions and their rendered HTML.
- **`packages/renderer/src/treesitter.js` / `runs.js`** — surface the
  tree-sitter `(comment)` ranges, currently discarded.
- **The markdown-comment logic** — `isMarkdownComment` +
  `commentToMarkdown` (pure), and the glue that, given the buffer's
  comment ranges, decides which are markdown, renders them via
  `host.renderJMarkdown`, and hands the view the replaced regions +
  HTML. This can live in a host module (`apps/desktop/src/`) driving a
  view that exposes a "set replaced regions" API — keeping the generic
  block-widget mechanism in the renderer and the comment-specific
  policy outside it.
- **`apps/desktop/styles.css`** — the `.comment-block` rendered-block
  style.
- No new IPC — `jmarkdown:render` is reused.

## Phasing

0. **The layout indirection.** Refactor `view.js` so every line
   position, the scroll height, virtualisation and `offsetFromPoint`
   come from a `layout.js` structure — but with *every* row still
   `1lh`. No behaviour change; all existing renderer tests pass. This
   de-risks everything after it: the uniform-grid assumption is removed
   before any variable-height row exists.
1. **One replaced-region type.** The layout accepts a replaced region
   with a measured height; virtualisation and scroll height become
   layout-driven; estimate→measure→reflow. Render `/*md … */` comments
   (JS) as blocks. A Lisp command toggles the buffer's blocks on/off.
2. **The cursor / raw toggle**, gutter handling for replaced regions,
   `offsetFromPoint` and selection through a block.
3. **HTML and Python** comment syntaxes; polish.
4. **General reuse** (optional) — fold inline images, or the sticky
   notes, onto the same block-widget mechanism.

## Testing

- **`layout.js` is pure** — unit-test exhaustively: rows and tops with
  and without replaced regions, the pixel↔line↔row lookups, a region
  in the middle / at the start / at the end, an empty buffer.
- **Renderer tests** — variable-height virtualisation: the visible
  window is correct when a tall block is partly scrolled past.
- **Pure-function tests** — `commentToMarkdown`, `isMarkdownComment`.
- **Smoke test** — open a `.js` buffer, insert a `/*md … */` comment,
  set `*jmarkdown-command*` to `cat` for determinism, assert the
  comment's source lines are *not* rendered as `.editor-line`s, a
  rendered block is, code below it sits lower than `commentLine · 1lh`
  would put it, and toggling reveals the raw lines.

## Risks

- **This touches the renderer's core assumption.** Every site that
  computed `index · 1lh` must route through the layout. Phase 0 — the
  pure refactor with no variable heights yet — is the deliberate
  mitigation: it isolates the risky change from the new behaviour.
- **Async measure→reflow** — a block's height arrives after its first
  layout; the reflow must not flicker or jump the scroll position.
- **Cursor and selection across a replaced region** — the buffer
  offsets inside the comment still exist; the view must map them
  sensibly (the cursor-inside-shows-raw policy keeps this mostly
  simple, but a selection spanning into a block needs care).
- **Virtualisation cost** — `first`/`last` visible becomes a search;
  keep the layout an array amenable to binary search.
- **Two consumers of the layer space** — sticky notes still use the
  overlay; the block-widget layout and the overlay must coexist.

## Open questions for the architect

1. **Detection policy** — magic marker (`/*md`), all block comments,
   only `/** */`, or a per-buffer mode toggle? *(Load-bearing.)*
2. **Gutter for a replaced region** — the first line's number, the
   line range, or a single marker?
3. **Toggle behaviour** — auto (raw when the cursor is inside) plus a
   manual command, as planned — confirm.
4. **Build the block-widget layout as a general capability** from the
   start (it is the same code), with comments as its first and only
   client for now — recommended — or scope it narrowly to comments?
5. **First-paint estimate** for an unmeasured block — the comment's own
   line count, then reflow on measure — acceptable?

## Critical files

- `packages/renderer/src/layout.js` — **new**, the pure layout model.
- `packages/renderer/src/view.js` — render through the layout.
- `packages/renderer/src/treesitter.js`, `runs.js` — surface comment
  ranges.
- `apps/desktop/src/` — the markdown-comment policy module + wiring.
