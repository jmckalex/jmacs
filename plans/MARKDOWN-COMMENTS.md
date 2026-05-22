# Plan — pretty-printed markdown in comments

**Status: planned, not started.** A detailed design for review.

## Context

The architect wants block comments in source files — e.g. a multi-line
`/* … */` in a JavaScript file — to display their *rendered HTML* in
place of the raw comment text in the editor view.

The **sticky notes** subsystem is a near-complete precedent for every
hard part: it renders JMarkdown source to HTML and overlays it on the
buffer in document coordinates, scrolling with the text, anchored
through edits. This feature reuses that pipeline rather than inventing
a new one.

What the research established:

- **Comment extent.** The line tokenizers in `highlight.js` are
  line-independent and do *not* track a multi-line `/* … */`. Only
  **tree-sitter** (`treesitter.js`, used for JS/HTML/Python) yields a
  real `(comment)` capture spanning a multi-line comment's full range.
  But the view currently receives only per-line *runs* from tree-sitter
  — the capture *ranges* are discarded in `runs.js`. Surfacing those
  ranges is the load-bearing change.
- **The view** (`packages/renderer/src/view.js`) virtualises lines and
  *recreates the line DOM every render* — so rendered content must live
  in the persistent, host-owned `overlayLayer`, never in `linesEl`.
- **The render pipeline** — `host.renderJMarkdown` → the `jmarkdown:render`
  IPC → a shell-out to the configured command — is reused unchanged.

## Detection

**Recommendation: opt-in via a magic first line**, not all block
comments — render a comment as markdown only when it begins with a
marker (`/*md …`, `<!--md …`, a `#md` line in Python). Rendering *all*
block comments would mangle licence headers and JSDoc and give the
developer no way to opt out. Detection is isolated in one predicate,
`isMarkdownComment`, so the policy can change without touching the
renderer. **This is an open question** — alternatives are all block
comments, only `/** */` doc-comments, or a per-buffer toggle.

Phase 1 covers tree-sitter languages only (JS/HTML/Python), since only
tree-sitter reliably gives multi-line comment extent.

## From comment to markdown

A pure, unit-tested `commentToMarkdown(commentText, language)` strips
the delimiters (`/*md`, `*/`, a leading `* ` per interior line) and
de-indents to the comment's own column — the same line-walk idea as
`parseNoteSource` in the sticky-notes module. The result is fed to the
existing `host.renderJMarkdown`, reusing its source-keyed HTML cache so
an unedited comment never re-renders.

## Rendering — HTML in place of the raw lines

The hard part. Three options were weighed: an **overlay block** over
the comment; **collapsing** the comment's source lines; a **toggle**.

**Recommendation: an overlay block with an opaque background, plus a
toggle.** A `.comment-md` div in `overlayLayer` (host-owned, persists
across renders), positioned at the comment's first line on the `1lh`
grid, with a background matching the editor so the raw lines underneath
are visually replaced. Build a `comment-markdown.js` module modelled
directly on `sticky-notes.js`.

The decisive design rule: **the rendered block occupies exactly the
comment's source line count; the buffer text is never altered, and no
lines are collapsed.** This keeps `lineCount`, the gutter, the cursor
arithmetic, selection and tree-sitter offsets all correct by
construction — collapsing lines would desynchronise every one of them.
Tall rendered output scrolls *inside* the grid-sized box.

Each markdown-comment gets an anchor at its start offset, tracked
through edits with `adjustAnchor` (reused from the sticky-notes module)
and re-placed on every buffer change — so editing above the comment
moves the overlay with it, exactly as sticky notes already do.

## Editing

The comment *is* real buffer text, so editing is just editing the
buffer — no textarea swap (that was a sticky-note necessity). A toggle
hides the `.comment-md` overlay, revealing the editable `.editor-line`s
underneath. **Recommended default**: render when the cursor is outside
the comment, show raw when it is inside — intuitive, and a cheap
cursor-position check in the existing render path. A manual per-buffer
toggle command is also provided.

## Components

1. `packages/renderer/src/runs.js` / `treesitter.js` — surface the
   tree-sitter `(comment)` ranges, currently discarded. The
   load-bearing change.
2. `packages/renderer/src/view.js` — expose the current parse's comment
   ranges to the host (a `getCommentRanges()` accessor or an `onParse`
   callback).
3. `packages/renderer/src/comment-markdown.js` — **new.** The core
   module, modelled on `sticky-notes.js`: `commentToMarkdown` and
   `isMarkdownComment` (pure, tested); the overlay manager that builds,
   places, renders (async, source-keyed cache, stale-guard, MathJax —
   copied from the sticky-notes module), re-places on buffer change,
   and toggles. Reuses `adjustAnchor` — lift it into a shared module.
4. `apps/desktop/src/app.js` — instantiate the module alongside
   `createStickyNotes`, sharing the JMarkdown render function and the
   new comment-range accessor.
5. `apps/desktop/styles.css` — `.comment-md` rules, modelled on
   `.sticky-note`.
6. No new IPC — `jmarkdown:render` is reused.

## Phasing

0. **Expose comment ranges** — the `runs.js` / `treesitter.js` /
   `view.js` change. No user-visible effect.
1. **Detection + rendering, manual, JS only** — `comment-markdown.js`
   with the pure functions; render `/*md … */` to an overlay block; a
   Lisp command toggles the buffer's blocks on/off.
2. **Auto toggle + editing UX** — raw when the cursor is inside the
   comment, rendered when outside; overflow scrolls inside the box.
3. **HTML and Python** — `<!--md … -->` and Python `#md` / `"""md`.
4. **Deferred** — runs of `;` / `//` line comments as one block
   (needs the line tokenizers to gain multi-line state — a separate
   piece of work).

## Testing

- **Unit tests** — `commentToMarkdown` (delimiter stripping,
  de-indent), `isMarkdownComment`, and a `runs.js` test that comment
  ranges are extracted; the sticky-notes test file is the model.
- **Smoke test** — a `commentMarkdown` block like the `sticky` block:
  open a `.js` buffer, insert a `/*md … */` comment, set
  `*jmarkdown-command*` to `cat` for determinism, assert a `.comment-md`
  element appears with rendered HTML, rides a scroll, and toggles to
  raw.

## Risks

- **Comment identity across re-parses** — tree-sitter returns a fresh
  range set on every edit; matching new ranges to existing blocks needs
  a stable key. Key by the `adjustAnchor`-projected anchor; the
  source-keyed cache makes an ambiguous re-render cheap.
- **Parse failure** — on a failed/`null` tree-sitter parse, clear all
  blocks (show raw) rather than leave them stale.
- **Render command missing** — fall back to showing raw comment text,
  exactly as sticky notes do.
- **Two overlay subsystems** — sticky notes and comment-markdown both
  fill `overlayLayer`; give `.comment-md` a lower z-index, both stop
  `mousedown` propagation.
- **Selection across a rendered comment** selects the raw buffer text
  underneath (correct, but visually surprising) — resolved in phase 2
  by showing raw whenever a selection intersects the comment.

## Open questions for the architect

1. **Detection policy** — magic marker (`/*md`), all block comments,
   only `/** */`, or a per-buffer mode toggle? *(Load-bearing — drives
   the whole UX.)*
2. **Toggle behaviour** — auto (raw when the cursor is inside) vs.
   purely manual? Plan recommends auto plus a manual command.
3. **Tall comments** — scroll inside a grid-sized box (keeps the line
   grid intact), vs. let the block expand and push code down?
4. **Lisp / line-comment runs** — should a run of `;` or `//` lines be
   one block? Phase 4; confirm it is wanted before investing.
5. **The tree-sitter contract change** — extend `highlight()` to return
   `{perLine, comments}`, or add a parallel `comments()` method?

## Critical files

- `packages/renderer/src/comment-markdown.js` — **new**, the core
  module.
- `packages/renderer/src/treesitter.js`, `runs.js`, `view.js` — surface
  the comment ranges.
- `apps/desktop/src/app.js` — instantiate and wire the module.
- `apps/desktop/src/sticky-notes.js` — source of `adjustAnchor` and the
  render/cache/MathJax helpers to share.
