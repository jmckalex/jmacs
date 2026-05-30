# PDF reader view

A `<pdf-view>` custom element — chrome (page navigation, zoom,
find-in-document) wrapping a PDF renderer. Lets the user open a
`.pdf` inside a Godot pane, scroll through it, jump to pages, copy
text. Designed to leave the door open for citation extraction and
multi-PDF search later.

Effort: **1-2 focused days** for v1.

## Why this fits Godot's character

Godot already treats research artefacts as first-class (`<doc-view>`,
citation.js, the `.bib` plumbing). A PDF view that gives Lisp
programmatic access to the document's text — for citation
extraction, copy-into-a-text-buffer, search-across-papers — is the
kind of integration the editor's character earns. A "view a PDF"
feature that's only a viewer is a missed opportunity.

## The renderer choice

This is the only real design decision in the plan; the rest is
mechanical.

| Option | What | Effort | Trade-off |
|--------|------|--------|-----------|
| **A. Chromium's built-in PDF plugin via `<webview>`** | Point a webview at a local PDF; Chromium's viewer takes over. | ~half a day | Free page nav / zoom / search / print. No theming, no programmatic text access. Feels like an iframe. |
| **B. PDF.js with custom chrome** | Mozilla's PDF library (Apache 2.0, powers Firefox's viewer, ~2 MB). Render pages to canvas + text layer, control the chrome ourselves. | 1-2 days | Matching theme, Godot-keymap integration (`j`/`k` page nav, `/` find), programmatic text access for Lisp-side features later. |
| **C. PDF.js's pre-built viewer in an iframe** | PDF.js ships a complete viewer (`pdf.js/web/viewer.html`); iframe it, configure via URL params. | ~half a day | More chrome control than A, but still iframed — no programmatic text access. |

**Recommendation: Option B.** The Lisp access to text is what
distinguishes "Godot has a PDF view" from "Godot can show PDFs."
The chrome matching the editor's theme is a small but real win.

If you want the half-day version, Option A is a fine v0 — and
the view-class signature stays unchanged, so you can swap in
PDF.js later without touching the dispatch / Lisp / session-restore
plumbing.

## Architecture (Option B)

### The class

`class PdfView extends ViewElement`, registered as `<pdf-view>` via
`defineViewElement('pdf-view', PdfView)`. Follows the existing
pattern (TextView, ImageView, BrowserView): `configure` →
`connectedCallback` → `setBuffer` / `focus` / `destroy`. Kind
getter returns `'pdf'`.

### Inner DOM

```html
<pdf-view>
  <div class="pdf-toolbar">
    <button class="pdf-prev" title="Previous page">←</button>
    <input class="pdf-page" type="number" min="1">
    <span class="pdf-page-count">/ 23</span>
    <button class="pdf-next" title="Next page">→</button>
    <span class="pdf-toolbar-sep"></span>
    <button class="pdf-zoom-out">−</button>
    <select class="pdf-zoom">
      <option value="fit">Fit page</option>
      <option value="width">Fit width</option>
      <option value="0.5">50%</option>
      <option value="1">100%</option>
      <option value="1.5">150%</option>
      <option value="2">200%</option>
    </select>
    <button class="pdf-zoom-in">+</button>
    <span class="pdf-toolbar-sep"></span>
    <input class="pdf-find" type="text" placeholder="Find...">
  </div>
  <div class="pdf-viewport">
    <!-- PDF.js renders one canvas per visible page here -->
  </div>
</pdf-view>
```

CSS: toolbar is `flex: 0 0 36px`, viewport is `flex: 1; overflow:
auto`. PDF.js renders each page as a canvas + an overlapping text
layer (invisible spans positioned over the visible text — that's
what enables selection and search).

### State

On the element:

- `_options` — `{ onKey, fitMode: 'fit' | 'width' | number }`
- `_pdfDoc` — the PDF.js `PDFDocumentProxy` after load
- `_pageNumber` — currently visible page (or top-of-viewport for
  multi-page render)
- `_zoom` — current scale factor
- `_pageTextCache` — per-page extracted text strings, lazily
  filled (for find + Lisp queries)

On the view object (so they survive `setBuffer` round-trips and
session restore):

- `view.filePath` — local PDF path
- `view.page` — last-viewed page number
- `view.zoom` — last zoom level

### PDF source

PDF.js needs a `Uint8Array` or a URL. We use the existing
`media://` protocol the audio / video views already use — pass
`media://localhost/<filepath>` and PDF.js fetches it. No new IPC.
The handler in `apps/desktop/src/serve.js` already streams files
with Range support; PDF.js handles Range responses fine.

### Wiring

In `connectedCallback`, after the chrome mounts:

| Source                                      | Effect                                                       |
|---------------------------------------------|--------------------------------------------------------------|
| `prev` / `next` click                       | Page number changes; viewport scrolls / re-renders           |
| Page input change                           | Same                                                         |
| Zoom select / `+` / `−` click               | Scale changes; visible pages re-render                       |
| Find input change (debounced 200 ms)        | Extract text lazily; highlight matches in the text layer    |
| Viewport scroll                             | Update the current page number in the toolbar               |
| `setBuffer(view)`                           | Load `view.filePath` via PDF.js; jump to `view.page`; apply `view.zoom` |

Keyboard nav via the chord forwarder (same pattern as
`<browser-view>`): `j` / `k` / `SPC` / `PageDown` / `PageUp` for
page nav, `/` to focus the find input, `g g` to jump to the first
page, `G` to jump to the last. Chord keys (`C-x b`, `M-x`)
forward through `onKey` so Godot's keymap stays live.

## Kind registration

In `app.js`, one new entry in `SINGLETON_VIEWS`:

```js
{ kind: 'pdf', el: pdfView, releasesBuffer: false },
```

Plus the singleton creation block (same pattern as image / audio
/ video / customize / browser):

```js
const pdfView = /** @type {*} */ (document.createElement('pdf-view'));
pdfView.configure({
  ...(keymapReady ? { onKey: dispatchKey } : {}),
});
editorPaneElement().append(pdfView);
pdfView.style.display = 'none';
```

`mountKindView` and `hideInactiveRendererViews` already iterate
`SINGLETON_VIEWS`; no other dispatch sites need touching.

## File-open dispatch

In `apps/desktop/src/files.js`, add `.pdf` to the suffix mapping.
`openFilePath` returns:

```js
{ path, name, pdfKind: true }
```

`app.js`'s open handler routes to:

```js
createView({
  kind: 'pdf',
  name,
  extras: { filePath: path, page: 1, zoom: 'fit' },
});
```

## Lisp surface

A small set of obvious commands and primitives, easy to extend as
the feature gets used:

```lisp
(defcommand pdf-next-page    "Next page in the PDF view")
(defcommand pdf-prev-page    "Previous page in the PDF view")
(defcommand pdf-goto-page    "Jump to page N")
(defcommand pdf-zoom-in)
(defcommand pdf-zoom-out)
(defcommand pdf-zoom-fit)
(defprim pdf-extract-text
  "Return all text on the current page as a string.")
(defprim pdf-extract-page-range
  "Return text for pages M through N as a list of strings.")
```

`pdf-extract-text` is the primitive that earns Option B over
Option A — it's how you build a `M-x cite-pdf` that pulls
title / author / DOI from the first page or two and hands the
result to citation.js. Same pipeline that already exists for
`.bib` files.

## Session restore

`session.js` already serialises view extras. `filePath`, `page`,
and `zoom` round-trip for free; on restore, `setBuffer` re-loads
the PDF, jumps to the saved page, applies the saved zoom.

The find input state and the page-text cache are not restored —
they're transient.

## Effort

| Step                                                              | Time     |
|-------------------------------------------------------------------|----------|
| `PdfView` class + chrome + CSS                                    | 2-3 hrs  |
| PDF.js integration (load doc, render pages to canvas + text layer)| 3-4 hrs  |
| Toolbar wiring (page nav, zoom, find)                             | 2-3 hrs  |
| `SINGLETON_VIEWS` entry, file-open dispatch, Lisp primitives      | 2 hrs    |
| Smoke arm: open PDF, page-count correct, render visible, find works| 2-3 hrs |
| Polish: keyboard nav (`j`/`k`/`SPC`/`/`), focus, error states     | 2-3 hrs  |

**Realistic total: 1-2 focused days for v1.**

## Edge cases worth a once-over

- **Encrypted PDFs.** PDF.js prompts for a password via a callback.
  v1 just shows "encrypted, can't open" in the viewport and a Lisp
  command `M-x pdf-supply-password` to retry. Don't try to be
  clever about credential storage on the first pass.
- **Malformed / partial PDFs.** PDF.js is fairly tolerant but
  occasionally throws on garbage. Catch the load error, show a
  readable message in the viewport, surface to the modeline.
- **Large PDFs.** A 500-page document renders pages lazily by
  default; PDF.js handles this well. The text-extraction cache
  should be lazy too — only fill on first query for that page.
- **Hidpi / retina.** Render pages at `window.devicePixelRatio`
  scale so canvases stay crisp on retina displays. PDF.js exposes
  the scale parameter on render.
- **Selection across pages.** The text layer enables per-page
  selection naturally. Cross-page selection works if pages are
  visually contiguous in the viewport (PDF.js's default layout).
- **Printing.** v1 can lean on Chromium's built-in print dialog
  via `window.print()` after rendering the current page. Better
  printing UX is a v2 concern.

## v2 thoughts

- **Annotations / highlights.** PDF.js can render annotations;
  making them user-editable is more work but tractable. Store the
  annotation overlay as a sidecar JSON in the same directory as
  the PDF, so the original file stays untouched.
- **Outline / bookmarks side strip.** PDF.js exposes the document
  outline. A small collapsible strip with chapter titles; click
  jumps to the page.
- **Citation extraction.** Use `pdf-extract-text` over the first
  page or two, run heuristics (or hand to a Lisp library that
  parses paper metadata), auto-populate a `.bib` entry. Closes
  the loop with the existing citation.js / `.bib` plumbing.
- **Per-view-instance.** Same story as `<browser-view>`: switching
  tabs with the singleton pattern loses scroll position. Worth
  doing once both view kinds (browser + PDF) are in production
  use; both benefit from the warehouse pattern.
- **Search across multiple PDFs.** Once `pdf-extract-text` is
  available, an index-builder command (`M-x index-pdf-directory`)
  populates a Lisp data structure that `M-x search-pdfs` queries.
  The "research surface" idea also touched on in
  `plans/BROWSER-VIEW.md`.
- **Open-link-as-Godot-view.** PDFs often contain hyperlinks. A
  click on a link could open as a `<browser-view>` (external URL)
  or a Godot text-view (a `file://` link to a code file in the
  same project).
