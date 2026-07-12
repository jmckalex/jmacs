# svg-editor — a vector-drawing view with LaTeX-in-text-boxes

**Status:** Phases 1–4 essentially BUILT (+ big slices of Phase 5); branch
`svg-editor` (this worktree), rebased-by-merge onto Model-B-default main
2026-07-12, tip `8887f9c1`, **merge-ready** (main is the merge-base — a
`--no-ff` merge applies conflict-free). The live registration is
`ELEMENT_VIEW_SPECS` in `apps/desktop/src/element-spec.js` (the renderer
Lisp interpreter is deleted; `element-view-svg-editor.lisp` is
stdlib-test parity only).

Built 2026-07-12 across three rounds (headless-verified via drive.js;
suite green):
- **Editor core**: select/multi-select/marquee, move/resize, zoom/pan,
  snapshot undo/redo, duplicate, z-order, grid + snap-to-grid,
  group/ungroup, host-backed Save / Save As / Open (native dialogs) +
  clean **Export** + 2× **PNG export**. Save keeps `data-godot-*` (the
  file re-opens editable); Export strips it.
- **TikZ nodes** (tool `t`): plain prose = NATIVE flowed text (word-wrap
  tspans, resize = wrap width, selectable font); `$math$`/TeX = MathJax
  vector islands; mixed = `\text{…}`; fitted rect/rounded/circle/
  ellipse/diamond borders; inline overlay label editor.
- **Paths + connectors** (pen `p`, edit-points `n`): Bezier pen with
  symmetric handles; anchors/handles editing, knot insertion, corner⇄
  smooth toggle; pen clicks on shapes create ATTACHED connectors
  (compass or auto border anchors, arrow tip exactly on the border,
  live reroute on move/resize/rebuild).
- **Properties sidebar**: paint, dash, arrowheads, corner radius, node
  knobs (border/padding/font/size/width), fill styles (linear/radial
  gradients + hatch/crosshatch/dots/checker patterns), align/distribute.

NOT merged; Jason's live pass pending (checklist in HANDOVER.md at the
main repo root). Parked: `.svg` default-handler decision (§9.1), the
server-owned `svg-document` data-source (persistence / multi-window, §5 —
an `element` view still vanishes from a restored session), PDF export,
and the Lisp `svg-*` scripting module.
**Motivating use case (Jason):** "An SVG editor with drawing functions and
toolbars a bit like Inkscape, but with the ability to include LaTeX math in
text boxes which gets formatted to SVG graphics via MathJax. Useful for knocking
out flowcharts, state diagrams, and the like."
**Standout feature:** LaTeX text → the *existing* MathJax-SVG pipeline → vector
glyphs embedded in the drawing. We do not add a second MathJax.

---

## STATUS

- [~] Phase 0 — host-side seam: shipped as an ELEMENT-VIEW (JS registry,
      `element-spec.js`), not yet a `svg-document` data-source; `.svg`
      ownership decision still open (image view stays the default).
- [x] Phase 1 — MVP raw vector editor: rect / ellipse / line / text;
      select / move / resize; tool palette + properties sidebar; save `.svg`
      (host dialogs, atomic write; save keeps `data-godot-*`).
- [x] Phase 2 — **LaTeX text boxes** via the MathJax-SVG pipeline: TikZ-style
      nodes, text/math/mixed classification, fitted borders, defs id
      de-collision, inline re-edit, colour/size knobs.
- [x] Phase 3 — flowchart layer: pen-drawn connectors attach to shape borders
      (compass/auto anchors), arrow tip exactly on the border, LIVE re-route
      on move/resize/rebuild; arrowhead markers; grouping; align/distribute.
- [~] Phase 4 — path / pen editing DONE (Bezier pen, anchors/handles, knot
      insertion, corner⇄smooth); grid + snap DONE; freehand / boolean ops /
      guides NOT built.
- [~] Phase 5 — clean-SVG export + 2× PNG export DONE; gradients/patterns
      DONE; PDF export, the Lisp `svg-*` scripting surface, and
      session-restore (server-owned data-source) NOT built.

Each phase is a live-verify gate (Jason runs the GUI). The build side cannot
launch the GUI.

---

## Goal

A genuinely useful in-editor vector tool for **diagrams**, not a full
illustration suite. The bar is "knock out a flowchart or state diagram with
math labels in two minutes, save it as a `.svg`, drop it into a paper or a
`.jmd` document." Where a choice trades Illustrator-grade illustration power for
diagram ergonomics, take the diagram ergonomics. Where a choice trades
conceptual clarity for power, clarity wins (the project's organising principle).

The SVG *is* the document. We are an editor of SVG, not a tool that exports to
SVG — the file on disk and the live object model are the same DOM. This keeps
the format legible, interoperable (Inkscape / browsers / `<img>` / `<object>`),
and means "save" is "serialise the live SVG."

### Concrete example workflows

1. **A state diagram for a paper.** `M-x svg-editor` opens a blank canvas.
   Press `r`, drag two rounded rectangles. Press `t`, click inside one, type
   `q_0`, Tab to commit → it renders as math. Press `c` (connector), drag from
   the edge of the first box to the second; an arrow snaps to both anchors. Drop
   a label on the arrow: `a / b`. `C-s` writes `automaton.svg`. Move a box; the
   arrow re-routes. Done in under a minute.

2. **A flowchart.** Rectangles for steps, a diamond for a branch, connectors
   with arrowheads. Each box's text is plain prose with the odd `$O(n\log n)$`
   inline. Align a column of boxes (`align left`), distribute them evenly,
   group, export PNG for slides.

3. **A quick figure with a formula.** A single display-math text box,
   `\frac{\partial L}{\partial \theta} = \sum_i \nabla_\theta f_i`, scaled and
   centred, exported as a tight-cropped `.svg` for inclusion via `\includegraphics`.

The first feature people will notice — and the reason to build this rather than
open Inkscape — is **#1's math labels rendered as crisp vectors with the same
typesetting as the rest of the editor**.

---

## Why this fits Godot

- The editor **already loads MathJax once, globally, with SVG output**
  (`apps/desktop/index.html`: `window.MathJax = { svg: { fontCache: 'local' },
  startup: { typeset: false } }` then `vendor/mathjax/tex-svg.js`). `tex2svg`
  is synchronous once startup resolves and returns an `mjx-container` wrapping a
  real `<svg>`. The renderer already wraps this in
  `packages/renderer/src/typeset-math.js` (`typesetMath`, `typesetCached`,
  `isMathJaxReady`, `whenMathJaxReady`). **We reuse that file verbatim.** This is
  the single biggest reason the standout feature is cheap here and expensive
  anywhere else.
- The editor already **hosts arbitrary custom elements as views** two ways: the
  lightweight `define-element-view` Lisp path (e.g. the Atari emulator, six
  lines of Lisp, no JS) and the heavyweight **server-owned data-source** path
  (the shell, image, pdf views — persisted, file-backed, multi-window). The SVG
  editor needs the heavyweight path because it is file-backed and stateful (see
  §6).
- Lisp is the scripting surface and JS the engine (project doctrine). The SVG
  document model and tools are JS; every drawing operation is exposed as a Lisp
  command so figures can be drawn or transformed programmatically (§6).

---

## 1. The document model

### The SVG DOM is the model

We do **not** invent a parallel model and serialise to SVG. The live model is a
real `SVGSVGElement` tree owned by the view. The editor manipulates that tree
directly; "save" is `new XMLSerializer().serializeToString(svgRoot)` (plus a
prologue); "open" is parsing the file into an `SVGSVGElement`. This is the
legibility win: what you see in the file is what the editor holds.

```
<svg xmlns viewBox="0 0 W H" width=… height=…>
  <defs> … markers (arrowheads), gradients, reusable symbols … </defs>
  <g class="layer" data-godot-layer="background"> … </g>
  <g class="layer" data-godot-layer="main">
     <rect …/> <ellipse …/> <path …/>
     <g class="godot-text" data-godot-latex="q_0"> … MathJax glyphs … </g>
     <g class="godot-connector" data-from="#id1" data-to="#id2"> <path …/> </g>
  </g>
</svg>
```

**Editor-only metadata** rides in a private namespace / `data-godot-*`
attributes (e.g. `data-godot-latex` holding the LaTeX *source* for a math text
box, `data-godot-shape="rect"`, connector endpoints `data-from` / `data-to`,
anchor side `data-anchor`). These survive a round-trip and are ignored by every
other SVG consumer; an "export clean SVG" pass can strip them (§8). This is how
we keep the file the model *and* keep enough state to re-edit — the same trick as
the math-preview's `data-godot-latex` source-of-truth attribute used here.

### Coordinate system, units, viewBox

- One **user-space coordinate system**, declared once by `viewBox="0 0 W H"`. We
  default to a px-like user unit (`W`/`H` in CSS px; `width`/`height` in `px`).
  No physical units (mm/pt) in MVP — diagrams are screen-and-paper figures, and
  unitless user space is the simplest legible choice. A later "document
  properties" panel can add a physical page size if a real need appears.
- The **canvas viewport** (pan/zoom) is a separate concern from the document
  `viewBox`: pan/zoom is a CSS `transform` on a wrapper `<g>` (or on the host
  element), never written to the file. Zooming must not mutate the document.
- Every object lives in user space. Selection handles, the grid, snap guides,
  and the marquee are drawn in a **separate overlay SVG layer** that shares the
  pan/zoom transform but is *not* part of the document and is never serialised.

### Object identity and z-order

- Every drawable gets a stable `id` (`g1`, `g2`, …) on creation — connectors
  reference shapes by id (`data-from="#g7"`), and the Lisp API addresses objects
  by id. Ids are renumbered/uniquified on open if a foreign file collides.
- **z-order is document order** within a layer (SVG paints in document order).
  Raise/lower = move the node among its siblings; raise-to-front = append.
- **Layers** are top-level `<g class="layer">` children of the root, in paint
  order. MVP ships one `main` layer; the layer model exists in the DOM from day
  one (cheap) but the layer *UI* (show/hide/lock/reorder panel) is Phase 4+.
- **Groups** are `<g>` nodes that the selection treats as a unit; double-click
  to enter a group and select within it (Inkscape's model).
- **Transforms** live on each element's `transform` attribute (we standardise on
  a single `matrix(...)` or a `translate/rotate/scale` triple per element).
  Resize/rotate compose into that transform; we avoid baking transforms into
  geometry so the original geometry stays inspectable.

### Object model the editor manipulates vs. the serialized SVG

They are the *same tree* — but the editor wraps each DOM node in a thin JS
**shape adapter** (not a parallel model, a façade): `{ el, kind, id, bbox(),
move(dx,dy), resize(handle, pt), setStyle(k,v), anchorPoint(side) }`. The
adapter is recreated on open by walking the DOM and reading `data-godot-shape`.
This keeps geometry math (bbox, hit-test, anchors) in one place without
duplicating state — the DOM remains the single source of truth.

---

## 2. Drawing tools + toolbars (Inkscape-like)

### Tool set

| Tool | Key | MVP? | Produces |
|---|---|---|---|
| Select / transform | `s` / `Esc` | ✅ MVP | (none — selects, moves, resizes, rotates) |
| Rectangle | `r` | ✅ MVP | `<rect>` (with `rx` for rounded) |
| Ellipse / circle | `e` | ✅ MVP | `<ellipse>` / `<circle>` |
| Line | `l` | ✅ MVP | `<line>` |
| Text | `t` | ✅ MVP (plain) → ⭐ Phase 2 (LaTeX) | `<g class="godot-text">` |
| Connector / arrow | `c` | Phase 3 | `<g class="godot-connector">` |
| Diamond / polygon | `d` | Phase 3 | `<polygon>` (flowchart decision node) |
| Pen / path (Bézier) | `p` | Phase 4 | `<path>` |
| Freehand / pencil | `f` | Phase 4 | `<path>` (simplified) |

Tools are **modal** (Inkscape/Illustrator-style): pick a tool, it owns the
canvas pointer until you switch. `Esc` always returns to Select. Single-key
shortcuts when the canvas (not a text box) has focus.

### Toolbars / palettes

- **Tool palette** — a vertical strip of tool buttons down the left edge of the
  view (icons via the editor's existing Font Awesome). Highlights the active
  tool.
- **Style / property toolbar** — a horizontal strip across the top: fill swatch,
  stroke swatch, stroke width, stroke dash, opacity, and (when a text box is
  selected) font size + math/plain toggle. Reflects the selection; edits apply
  to the selection live.
- **Context strip** — when a connector is selected, arrowhead start/end pickers;
  when a shape is selected, corner radius; when multiple are selected,
  align/distribute buttons.

These are plain DOM inside the view's shadow root (the view owns its chrome),
styled to match the editor (`var(--fg)`, `color-mix(... transparent)` overlays
per the chrome convention, so light themes don't wash out). **This is the view's
own toolbar, distinct from the editor's titlebar Conn toolbar** — do not entangle
the two.

### Selection handles, snapping, alignment

- **Selection handles**: 8 resize handles + a rotate handle, drawn on the
  overlay layer around the selection bbox. Drag a corner to resize; drag the
  rotate handle to rotate about the bbox centre; drag the body to move.
- **Snapping / grid / guides** (Phase 4 polish, but design now): an optional
  grid (background pattern, not serialised); snap-to-grid, snap-to-object-edge,
  snap-to-object-centre, snap-to-anchor (important for connectors). Snapping is a
  pure function `snap(point, candidates) → point`; hold a modifier to disable.
- **Alignment / distribution**: align left/right/top/bottom/centre, distribute
  horizontally/vertically — operate on the multi-selection's bboxes. Phase 3/4.
- **Grouping**: `C-g` group selection into a `<g>`, `C-S-g` ungroup. Phase 3.
- **z-order**: `PageUp`/`PageDown` raise/lower, `Home`/`End` to front/back.

**MVP cut line:** Select + move + resize (no rotate), rect/ellipse/line/plain
text, fill/stroke/width toolbar, z-order, save. Everything else is Phase 3+.

---

## 3. ⭐ LaTeX-in-text-boxes → MathJax → SVG (the standout feature)

This is the feature that justifies building the tool. Treat it thoroughly.

### The mechanism

A text box is a `<g class="godot-text">` carrying its **LaTeX source** in
`data-godot-latex` (the source of truth) plus presentation attributes
(`data-godot-font-size`, `fill` for colour, the `transform` for
position/scale/rotation). On **commit** (Tab / click-away / `C-c C-c`):

1. Read the source string from the editing overlay.
2. Decide inline vs. display (a per-box toggle; default inline).
3. Call the existing pipeline: `typesetCached(cache, source, display,
   globalThis.MathJax)` from `packages/renderer/src/typeset-math.js`. This
   returns the cached `mjx-container` (an `<svg>` of glyph **paths**), or `null`
   on a parse error.
4. On success: take the inner `<svg>` from the container, **import its children
   into our document** (`document.importNode`, re-homing the glyph `<path>`s and
   any `<defs>` MathJax emitted) under the `<g class="godot-text">`, set the
   group's `transform` to position+scale it, stamp `data-godot-latex` with the
   source. The `mjx-container`'s computed `width`/`height` (in `ex`) give us the
   intrinsic box for scaling and baseline.
5. On `null` (parse error): keep the box in source-edit state, show the source
   with a wavy underline (reuse the math-preview `.math-invalid` convention) and
   a small error affordance — never silently drop the box.

We deliberately **reuse `typeset-math.js`'s cache** (or an instance of
`createMathCache`) so re-rendering an unchanged formula is free and the
"MathJax not ready yet" handshake (`whenMathJaxReady` → one-shot re-render) is
already solved. The cache key is `(source, display)`; a source edit is a clean
miss. We may want to fold a `color`/`font-size` discriminant into our own key
since those affect the embedded output.

### Embedding strategy — **recommend: inline `<g>` of glyph paths**

Three options were weighed:

| Strategy | Selection/scale | Editability | Export fidelity | Verdict |
|---|---|---|---|---|
| **Inline `<g>` of MathJax glyph paths** | native SVG transforms; scales as crisp vectors; hit-tests as a group | re-render from `data-godot-latex` | self-contained, resolution-independent, opens anywhere | ✅ **recommend** |
| `<image href="data:image/svg+xml,…">` | scales but as an opaque box | source still in `data-godot-latex`, re-render replaces the image | a nested SVG-in-SVG; fine but heavier, some renderers fuzzy | fallback |
| `<foreignObject>` with live HTML+MathJax | live HTML reflow | trivially editable | **poor** — `<foreignObject>` is unsupported by many SVG consumers (Illustrator, `librsvg`, some PDF pipelines) and breaks "open this .svg anywhere" | ✗ avoid as the canonical form |

The inline-`<g>` form wins on the project's terms: it is the *most legible*
output (a real vector path tree), the most portable (`MathJax svg` output is
exactly designed for this), and it composes with our transform/selection model
for free. MathJax's `fontCache: 'local'` (already set in `index.html`) keeps
glyph `<defs>` scoped per typeset container — we must **de-collide those defs ids**
when importing into the shared document (prefix them with the box id) so two
math boxes don't share or clobber a `<use>` reference. This is the single
fiddliest part of the embed and is called out in §10.

### Editing (source ↔ rendered)

The math-preview minor mode's **reveal-on-cursor-inside** rule is the model:
- A committed math box shows the rendered glyphs.
- **Double-click** (or `Enter` with the box selected) **enters source-edit
  mode**: the glyphs are hidden and a small inline text editor shows the LaTeX
  source (`data-godot-latex`). Typing edits the source; a **live ghost preview**
  can re-typeset on a debounce.
- **Tab / click-away / `C-c C-c`** re-renders and commits; `Esc` cancels back to
  the last-committed render.

The source editor itself can be a plain `<textarea>`/contenteditable in the
overlay — or, more ambitiously, a real Godot mini-buffer in `latex-mode` so the
author gets the editor's own LaTeX highlighting and completion. **Recommend the
plain editor for MVP**, and note "host a real latex-mode buffer in the box" as a
delicious Phase 5 stretch (it would make the math box *literally* a Godot buffer
embedded in the drawing — very on-brand, but couples to the buffer/view model).

### Positioning, baseline, scaling

- Position = the `<g>`'s `transform` translate. The box's **anchor** (top-left /
  centre / baseline-left) is a `data-godot-anchor` choice; centre-anchoring is
  the right default for diagram labels so they stay centred under resize/scale.
- MathJax reports the box's metrics (width/height in `ex`, and the vertical
  align for inline). We convert `ex` → user units via the box's font-size and set
  the group `transform` scale accordingly; a font-size knob just changes the
  scale factor (no re-typeset needed — a nice property of vector output).
- Display math centres in its box; inline math sits on a baseline so it can be
  mixed with prose (next point).

### Mixing prose + math, styling

- A text box may be **plain text**, **pure math**, or **mixed** (prose with
  inline `$…$`). For mixed, the same MathJax config already used app-wide applies
  (`$…$` inline, `$$…$$` display, `processEscapes`): we can typeset the whole
  box as one `tex2svg` call wrapping the prose in `\text{}` runs, **or** lay out
  prose as native `<text>` and only the math spans as embedded glyph groups.
  **Recommend** for MVP: a box is *either* plain `<text>` *or* a single math
  render (toggle on the style toolbar). True inline-mixed flow (prose + math on a
  line with correct baselines) is genuinely hard (line-breaking, baseline
  alignment) and is a Phase 5 enhancement, not MVP.
- **Colour**: set `fill` on the math `<g>` (MathJax paths inherit `currentColor`
  / `fill`); a colour swatch on the toolbar applies. **Size**: the scale knob.
  Both must fold into the cache key if they change the rendered output (colour via
  `fill` does *not* change geometry, so it stays out of the geometry cache and is
  applied as an attribute post-render).

---

## 4. Flowchart / diagram helpers

The line between "raw vector editor" and "diagram tool" is where this earns its
keep. **Recommendation: a *thin* node+edge layer over raw SVG — smart
connectors, not a full graph engine.**

### Connectors that attach and re-route

- A **connector** is a `<g class="godot-connector" data-from="#g3"
  data-to="#g7" data-from-side="auto" data-to-side="auto">` containing a
  `<path>` and (via markers) arrowheads.
- It stores **endpoints by object id + anchor side**, not absolute coordinates.
  On any move/resize of an attached shape (or on load), a `reroute(connector)`
  pure function recomputes the path from the two shapes' current anchor points.
- **Anchors**: each shape exposes anchor points (N/E/S/W edge midpoints + centre
  for `auto`). `auto` picks the pair of sides that minimises path length /
  crossing. MVP routing: a straight line or a simple orthogonal (Manhattan)
  elbow with one or two bends. Spline/avoid-overlap routing is later.
- **Re-route trigger**: the move/resize commands publish "shape g7 changed";
  connectors with `data-from`/`data-to` referencing it re-route. This is a tiny
  dependency pass over the connector list — fine for diagram-scale documents
  (tens to low hundreds of objects).

### Arrowheads / markers

- Arrowheads are SVG `<marker>` elements in `<defs>`, referenced via
  `marker-end` / `marker-start` on the connector path. A small library of marker
  shapes (arrow, open arrow, diamond, dot, none) ships in `<defs>` and is added
  lazily on first use. Marker pickers live on the connector context strip.

### A lightweight node+edge model — how much "smarts"?

- **Recommend:** nodes are just shapes; edges are just connectors. No separate
  graph data structure beyond what the DOM already encodes (`data-from`/`data-to`
  *are* the edge list). A "node" gets diagram affordances (default rounded-rect +
  centred text box + anchor points) via a **"flow node" convenience command**
  that stamps one out, but it is still a plain group.
- **Auto-layout**: out of scope for MVP and probably for the whole arc unless
  Jason wants it. A *very* simple "align these into a row/column and connect in
  order" macro is a cheap, high-value Lisp helper (it composes align + connect),
  and that is the right altitude — auto-layout *as a scriptable convenience*, not
  a built-in layout engine. Full graph auto-layout (dagre/elk-style) is a
  dependency and a research rabbit hole; defer indefinitely.

The principle: **the document stays raw SVG; "diagram smarts" are connectors +
convenience commands**, so a file is always a plain editable drawing, never a
proprietary diagram blob.

---

## 5. Editor integration

### View kind: **server-owned data-source**, not a bare element-view

The two hosting paths:

- **`define-element-view`** (Atari path): six lines of Lisp, zero JS, but
  *ephemeral* (any non-text kind is `isEphemeral`), *not file-backed*, and its
  shared state cannot cross the Model-B wire. Great for a stateless widget.
- **Server-owned data-source** (shell/image/pdf path): the server owns the
  document state and fans it to thin clients via the PANE_TREE; file-backed,
  persisted in workspaces, survives reconciles. This is what `.svg` files want.

The SVG editor is **file-backed, stateful, save-able, and should restore with a
workspace** → it must be a **data-source view kind `svg-document`**, following
the shell port pattern (`apps/desktop/mwb/spine.js` `openShell`,
`apps/desktop/mwb/server.js`, `apps/desktop/mwb/data-source.js`,
`packages/renderer/src/shell-view.js`, and `buildServerMediaView` /
`serverMediaViews` / hide-not-kill reconcile handling in
`apps/desktop/src/app.js`).

**However** — we still author the renderer element and as much of the editor
*as possible* as a self-contained custom element (`<svg-editor-view>` in
`packages/renderer/src/svg-editor-view.js`), so it could *also* be dropped in via
`define-element-view` for quick experimentation. The data-source plumbing wraps
it for file/persistence/multi-window. This mirrors how the shell element is a
clean custom element that the server merely owns.

### Renderer element lifecycle contract (from the shell template)

`<svg-editor-view> extends ViewElement` and implements:
- `configure(options)` — once, before mount. Options inject host services:
  `save(path, svgString)`, `load(path) → svgString`, `insertText(text)` (to drop
  an `\includegraphics`/path into the active document — bib-search pattern),
  `deliver(callback, args)` (run a Lisp callback), and a theme hook.
- `setBuffer(view)` — bind/rebind the data-source descriptor (`{ filePath,
  state }` where `state` holds the serialised SVG string + per-view UI like
  zoom/pan/selection).
- `focus()` — focus the canvas.
- `destroy()` — explicit teardown.
- `disconnectedCallback()` — **no-op** (hide-not-kill: a tab switch must not
  drop an unsaved canvas). Reaped only when the server closes the source.

### Mounting in a pane / tab

`buildServerMediaView(w)` in `app.js` gains an `svg-document` branch: read
`w.state` (the SVG string + UI state), `createView({ kind: 'svg-document',
extras })`, cache in `serverMediaViews` keyed by `w.bufferId`, flag
`_serverSourceId`. The existing `mountKindView` dispatch grows a
`case 'svg-document'`. The hide-not-kill / reconcile-survival code that exempts
shells must also exempt `svg-document` (an open canvas with unsaved edits must
survive a PANE_TREE reconcile exactly like a live shell).

### Open / save `.svg` — and the `.svg`-is-currently-an-image collision

**The key tension:** `apps/desktop/mwb/media-kinds.js` currently maps `.svg →
image` (a *read-only* immutable media view). Opening a `.svg` today shows it as a
picture, not an editable drawing. The design must resolve this:

- **Recommend:** `.svg` files **open in the SVG editor by default** (route `.svg`
  to the new `svg-document` data-source in `media-kinds.js` / the server's
  open-path, *not* to `image`). Viewing a `.svg` as a flat picture is the
  unusual case; editing it is the point of this feature. Keep a `M-x
  view-svg-as-image` / a "open as image" affordance for the rare read-only case
  (Python-vs-Perl doctrine: allow the unusual config, don't default to it).
- `.svg` is a **mutable, file-backed data-source** — unlike image/pdf which are
  immutable one-shot sources. This means the data-source's `setState` /
  `onStateChange` seam (currently unused, reserved for stella/jukebox) **lights
  up here**: an edit updates the source's `state.svg`, which can fan out to a
  second window viewing the same file (multi-window lockstep, §below). Mark the
  buffer modified on edit; `C-s` serialises and atomic-writes via the existing
  save path; the modified/clean flag and close-guard come along.

### Model-B: server-owned shared state vs. renderer-local

**Recommend: the SVG document is server-owned shared state (the data-source's
`state.svg`), mirroring text buffers.** Rationale: it gives multi-window
lockstep (two windows on the same diagram), session-restore, and the
modified/save model for free, consistent with every other file-backed view. The
cost is marshalling the SVG string across the wire on edits.

The pragmatic refinement: **the live, fine-grained editing happens
renderer-local** (pointer events mutating the local DOM at 60fps — you do *not*
round-trip every drag through the server), and the renderer **commits a new
canonical SVG string to the server on edit boundaries** (mouse-up, commit,
debounce). The server stores it and fans it to *other* viewers of the same
source. This is exactly the shell pattern (live runtime is per-view; the
data-source owns the loadable/canonical state) and the math-preview pattern
(local interaction, canonical source-of-truth re-rendered). Per-view UI (zoom,
pan, current tool, selection) stays renderer-local and is *not* shared.

For Phase 1, a single window is enough; the server merely persists `state.svg`.
The fan-out-to-second-viewer behaviour is a Phase 5 nicety the architecture
already affords.

### Session-restore

Following the shell's `serialiseLeafView` / `loadLayout` resolver: a
`svg-document` leaf serialises as `{ kind: 'svg-document', path }`. Restore
re-opens the file (re-reads the `.svg` from disk) into a fresh data-source — a
workspace saves the *arrangement*, and for a file-backed view the file *is* the
content, so restore reads it back. (Unsaved-at-quit edits are the autosave/recover
path's job, same as text buffers — out of scope for the view itself.)

### Keyboard + the Lisp command surface

- While the canvas is focused, the element **grabs the keyboard** (`keyboard:
  'grab'` equivalent) for single-key tools, but **shares** editor chords
  (`C-`/`M-`) so `C-s` save, `C-x` prefix, etc. still reach the editor — the
  `'share'` policy from `element-view.js`'s `_installKeyGrab`. While a math box
  is in source-edit mode, keys go to the inline editor.
- **Every drawing operation is a Lisp command** (project doctrine: scriptable).
  A `svg` module of primitives the element exposes through `configure`:
  `(svg-add-rect x y w h …)`, `(svg-add-text x y latex …)`, `(svg-connect
  from-id to-id …)`, `(svg-set-style id key value)`, `(svg-select ids)`,
  `(svg-align ids :left)`, `(svg-export-png path)`, etc. The interactive tools
  are thin wrappers that *call these commands*, so a figure can be drawn by hand
  or generated from Lisp (e.g. a macro that stamps a state machine from a
  transition table — the canonical "halfway between Python and Perl" power-user
  payoff, and a natural bridge to the TROCP/automata work).

---

## 6. Interaction & hit-testing

- **Hit-testing**: SVG gives us `document.elementFromPoint` and per-element
  `pointer-events`; for a click we hit-test the document layer, walk up to the
  nearest drawable/group, and select it. The **overlay layer** (handles, marquee,
  grid) has `pointer-events: none` except the handles themselves, so handle drags
  and body drags don't fight. This is far simpler than canvas hit-testing — a
  major reason to be SVG-native rather than `<canvas>`.
- **Marquee select**: drag on empty canvas draws a selection rect on the overlay;
  on mouse-up, select every drawable whose bbox intersects (or is contained,
  with a modifier) the marquee.
- **Drag / resize / rotate**: pointer events on the selection / handles mutate
  the selected element's `transform` (move/rotate) or geometry+transform
  (resize). Use `setPointerCapture` so a drag that leaves the element keeps
  tracking. Snap (§2) applies on the resulting point.
- **Performance with many objects**: SVG is comfortable into the low thousands of
  nodes for diagram-scale work. Guardrails: (a) connectors re-route only for
  shapes that actually moved (dependency pass, not a full relayout); (b) the math
  cache means math boxes don't re-typeset on move; (c) batch DOM mutations and
  read layout once per frame (the renderer's `requestAnimationFrame` batching
  ethos). If a document ever gets large enough to lag, that is a signal it has
  outgrown "knock out a flowchart" and we are not chasing Illustrator. Profile
  before optimising (project doctrine).

---

## 7. Export

- **SVG (native)**: `C-s` writes the document SVG via the editor's atomic-write
  save path. A separate **"export clean SVG"** strips `data-godot-*` editor
  metadata and the de-collided-defs prefixes (or leaves stable defs), producing
  a minimal portable file. The math is already clean vector paths, so MathJax
  output exports faithfully — the whole point of the inline-`<g>` embed.
- **PNG**: render the document SVG to a raster. Cleanest path in Electron:
  serialise the SVG, draw it onto an `OffscreenCanvas`/`<canvas>` via an
  `Image`/`createImageBitmap` from a `data:` URL, `toBlob('image/png')`, write
  via the host. A DPI/scale factor option for crisp slides. Phase 5.
- **PDF**: two routes — (a) `webContents.printToPDF` of a page showing just the
  SVG (Electron main, vector-preserving, easy), or (b) shell out to `rsvg-convert`
  / `inkscape --export-pdf` if present. **Recommend (a)** (no dependency,
  vector-clean, and our MathJax paths survive). Phase 5.
- Export commands are Lisp (`svg-export-png`, `svg-export-pdf`) so they script.

---

## 8. Phasing (detailed)

- **Phase 0 — seam.** `<svg-editor-view>` mounts a blank canvas via `M-x
  svg-editor`. Decide and wire `.svg` ownership (route to `svg-document`, not
  `image`; keep a read-as-image escape hatch). Server `svg-document` data-source
  exists and persists `state.svg`. *Touches the fragile mount path + media-kind
  routing — needs a live smoke pass.*
- **Phase 1 — MVP raw editor.** Select/move/resize (no rotate); rect / ellipse /
  line / plain `<text>`; tool palette + fill/stroke/width style toolbar;
  z-order; marquee select; open + save `.svg`; modified flag + close-guard.
- **Phase 2 — ⭐ LaTeX text boxes.** The MathJax-SVG embed (inline `<g>` of glyph
  paths, defs de-collision), source↔render edit cycle, position/scale/colour,
  inline vs. display toggle, invalid-source handling. *The differentiator;
  needs careful live smoke of the embed + export round-trip.*
- **Phase 3 — flowchart layer.** Connectors (attach by id + anchor, reroute on
  move), arrowhead markers, diamond/polygon node, grouping, align/distribute,
  the flow-node convenience command.
- **Phase 4 — paths & polish.** Pen/Bézier path tool, freehand, rotate handle,
  snapping/grid/guides UI, layers panel, boolean ops (if wanted).
- **Phase 5 — export & scripting.** PNG/PDF export, the full `svg` Lisp command
  module + scripted-figure macros, multi-window fan-out of the shared SVG state,
  session-restore polish, optional real-`latex-mode`-buffer-in-a-math-box.

---

## 9. Risks & open questions (for Jason)

1. **`.svg`-as-image vs. `.svg`-as-editable (open question).** Today `.svg`
   opens as a read-only image. Making the SVG editor the default handler is the
   right call for *this* tool but changes existing behaviour (someone who just
   wanted to *look* at an SVG now lands in an editor). Confirm: default to the
   editor with a "view as image" escape hatch? Or gate the editor behind `M-x
   svg-editor` / a `.gsvg` extension and leave plain `.svg` as image-view? **My
   recommendation: editor-by-default with an escape hatch**, but this is Jason's
   call and it is the first decision that affects everything.

2. **MathJax defs de-collision + embed fidelity (hardest technical risk).**
   `fontCache: 'local'` makes each `tex2svg` emit `<defs>` with `<path>` glyphs
   referenced by `<use href="#…">` whose ids repeat across renders. Importing
   many math boxes into one document **will collide those ids** unless we prefix
   them per box (and rewrite the `<use>` references). Getting this exactly right —
   and verifying the round-trip (save → reopen in Inkscape/a browser → math still
   renders) — is the riskiest part of the standout feature. A `fontCache: 'none'`
   per-render (inlined paths, no `<use>`) sidesteps collisions at the cost of file
   size; that trade may be worth it for export-cleanliness. **Needs a live spike
   early in Phase 2.** (Note: the global config is shared with the rest of the
   app's math-preview; we may need a per-call cache option rather than changing
   the global.)

3. **Connector routing quality (scope risk).** "Re-route on move" is easy for
   straight lines; *good-looking* orthogonal routing that avoids overlapping
   shapes is a genuine rabbit hole. Recommendation: ship straight + simple elbow
   in Phase 3, resist the pull toward a full routing engine, and let users
   hand-adjust bends. Confirm that's an acceptable ceiling.

4. **Scope creep vs. Inkscape (the standing risk).** Vector editors are
   bottomless (gradients, clipping, filters, boolean ops, node editing, text on
   a path…). The vision is *diagrams with math labels*, not Illustrator. The
   phasing draws the line at "flowcharts and state diagrams done well"; resisting
   feature-by-feature creep past that is a discipline question, not a technical
   one — flag it so it's a conscious choice each time.

5. **Math box editing surface (design choice).** Plain `<textarea>` for MVP vs.
   a real embedded `latex-mode` Godot buffer (highlighting/completion/the
   editor's own LaTeX brain, very on-brand but couples to the buffer/view model).
   Recommend plain for MVP, real-buffer as a Phase 5 stretch — confirm that's the
   right deferral.

6. **Shared-state granularity in Model B.** Committing the whole SVG string on
   each edit boundary is simple and correct but coarse. For diagram-scale
   documents it's fine; if it ever isn't, a finer op-based diff is possible but is
   real complexity. Recommend coarse-string-commit until profiling says
   otherwise (consistent with the project's "don't optimise before measuring"
   stance).

---

## Appendix — files this will touch (orientation, not a contract)

- **Reuse as-is:** `packages/renderer/src/typeset-math.js` (MathJax→SVG +
  cache); `apps/desktop/index.html` MathJax config (already SVG output).
- **New renderer element:** `packages/renderer/src/svg-editor-view.js`
  (the `<svg-editor-view>` custom element — document model adapters, tools,
  toolbars, hit-testing, the math-box embed). Registered via
  `defineViewElement('svg-editor', …)` (mirrors `shell-view.js`).
- **Server / data-source (Model B):** a `svg-document` kind in
  `apps/desktop/mwb/data-source.js` usage (it's already kind-generic); an
  `openSvgDocument` in `apps/desktop/mwb/spine.js` (mirror `openShell`); save +
  `setState`/`onStateChange` fan-out in `apps/desktop/mwb/server.js`; `.svg`
  routing in `apps/desktop/mwb/media-kinds.js` (the contentious change);
  serialise/restore in `pane-model.js` / `session-store.js` resolver.
- **Client mount:** a `svg-document` branch in `buildServerMediaView` +
  `mountKindView` + the hide-not-kill / reconcile-survival exemption in
  `apps/desktop/src/app.js` (mirror the shell handling around `serverMediaViews`
  / `serverLiveShells`).
- **Lisp surface:** `packages/stdlib/lisp/svg-editor.lisp` — the `M-x svg-editor`
  command, file-open wiring, and the `svg-*` command module the element exposes
  through `configure`. (Optionally also a `define-element-view` registration for
  quick standalone experimentation.)
