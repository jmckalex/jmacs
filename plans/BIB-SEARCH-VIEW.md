# bib-search — a self-contained bibliography view that inserts into the active buffer

**Status:** spec. Building on `element-views` (merged). Branch `bib-search-view`.
**Motivating client / origin:** Jason's `<bib-search>` web component (used on
iPad via BetterTouchTool Mobile) + his `biblify` citation.js renderer.

## Goal

A **Bibliography** panel you keep open beside your prose: type a query, pick
references, and they're inserted **into the document you're editing** — the
panel never steals the editor's focus. Feed it a bibliography in **any format
citation.js handles** (BibTeX, BibLaTeX, CSL-JSON, RIS, …); it does the parse +
render + search itself. "Self-contained" is a hard requirement (Jason: avoid
DLL-hell — spend program space to buy dependency robustness).

## What the source material actually is (verified)

- **`<bib-search>`** (`~/Sites/jmckalex/software/components/bib-search`, v1.0.0,
  **MIT**, rollup-built) is a *consumer* of **pandoc/CSL-rendered HTML** — its
  `parser.js` reads `.csl-entry` divs keyed `ref-<bibKey>`. It does **not** parse
  BibTeX. It exposes `el.onAction = (entries, mode) => …` (entries =
  `[{html,text,bibKey,markdown}]`, mode = `full|markdown|bibkey`) and dispatches
  `bib-loaded` / `selection-change` / `bib-error` CustomEvents.
- **`biblify`** (`~/Sites/jmckalex/software/biblify`) is the citation.js engine:
  `require('citation-js')` → `new Cite(bib).format('bibliography', …)` →
  the CSL-HTML that bib-search consumes.
- The **BTT Mobile** preset (`…/PresetBundles/D8B2B1BE-…Default/`) wires
  `<bib-search src="test-bib.html">` at a **pre-rendered** HTML bibliography (no
  citation.js in the bundle); `onAction` is the insert hook (on iPad it
  types/pastes into the active app — the iOS analog of "insert into active
  view").

So today bib-search needs a separate pre-render step. The new capability is to
**fold biblify's citation.js step into the element** so it ingests any format
directly.

## Why Godot makes this easy

Godot already vendors **`@citation-js`** (`+ plugin-bibtex + plugin-csl`,
`packages/renderer/vendor/citation-js.esm.js`; the renderer exports
`parseCitations` / `formatBibliography` for `cite.lisp`/RefTeX). citation.js
**auto-detects input format** (`new Cite(text)`), so the self-contained element
is just the MIT search UI + a `new Cite(...).format('bibliography',{format:'html'})`
step on its data path. We bundle citation.js *into* the element (Jason's
`citation.min.js`) so the artifact stays portable — the same upgraded element
also improves his BTT Mobile setup (drop the pandoc pre-render there too).

## Architecture — three building blocks, then Lisp

### 1. `:no-focus` (generic view-focus feature — the foundation)

A view flagged `noFocus` **never becomes the active pane**. Precise semantics:
*decouple DOM focus from Godot's `currentPaneId`/`currentView`.* The panel's
search box can hold DOM focus (so you type into it), while the editor's active
view stays on your document — so `insert!` targets your prose.

Mechanism: `setCurrentPaneId` (the single focus entry point, `app.js`) refuses a
pane whose peeled view has `noFocus` (helper: `isNoFocusPane`). Every focus path
(`focusPaneFromEvent` capture-phase click, `other-pane`, restore) goes through
it, so all respect it. Clicking the panel still reaches its controls (no
`preventDefault`/`stopPropagation`), so its inputs work. Opt in from Lisp with
`:no-focus #t`.

Generalizes to any HUD / inspector / control-surface helper view.

### 2. `element-on` (element-views Phase 4 — the callback bridge)

A host primitive to wire an element's events/callbacks to a Lisp handler
(delivered via the existing `deliverLispCallback`). bib-search forces it (Atari
forced the base mechanism). Since we control the (MIT) element, it will dispatch
a `bib-action` **CustomEvent** (`detail = { entries, mode }`) — cleaner for
`addEventListener` than the `onAction` property. `element-on el "bib-action" fn`.

### 3. The insert bridge (mode-aware, reuse cite/RefTeX)

The Lisp handler receives `(entries mode)` and inserts at point in the **active**
view (the document, thanks to `:no-focus`) via `insert!`:
- `bibkey` → a cite macro over the keys, **per major mode**: LaTeX `\cite{k1,k2}`
  (reuse `reftex-cite.lisp`'s cite-format menu), Markdown/jmd `[@k1; @k2]` /
  Biblify `\cite{}`.
- `full`/`markdown` → the formatted reference (the entry's `markdown`).

### Then the view is Lisp

```lisp
(define-element-view bib-search
  :title    "Bibliography"
  :module   "apps/desktop/vendor/bib-search/bib-search.js"  ; self-contained: UI + citation.js
  :tag      "bib-search"
  :attrs    '((src "app://editor/__host__/…/bibliography.bib"))  ; ANY citation.js format
  :no-focus #t
  :on-ready (lambda (el)
              (element-on el "bib-action"
                (lambda (entries mode) (bib-insert-into-active! entries mode)))))
```

## Data flow

`.bib` (or CSL-JSON/RIS) served via `app://` (repo or `__host__`) → the element
`fetch`es it → `new Cite(text)` (auto-detect) → `.format('bibliography',
{format:'html'})` → its existing `.csl-entry` search UI → `bib-action` →
`bib-insert-into-active!` → `insert!` into the document. Bibliography path is a
`defcustom` (e.g. `*bib-search-source*`) or the spec's `:src`.

## Where it lives

A persistent **right-side split** beside the document is best for search-as-you-
write (the utility dock is an alternative; the RefTeX cite picker already lives
there). A `:no-focus` view should **open in its own pane**, not replace the
focused one — so `open-element-view!` for a `:no-focus` view splits (e.g. right)
and leaves focus on the original pane. *(Deferred to the view-assembly phase; the
`:no-focus` guard lands first.)*

## Phasing

1. **`:no-focus`** — the focus guard + spec threading (`:no-focus #t` →
   `view.noFocus`). *(This branch. Foundation; live-demoed once a no-focus view
   exists.)*
2. **`element-on`** — the element-views callback/event bridge to Lisp.
3. **The self-contained element** — vendor `<bib-search>` extended with
   citation.js inside (bundle `citation.min.js`); ingest any format; emit
   `bib-action`. Under `apps/desktop/vendor/bib-search/`.
4. **Open-in-split for `:no-focus` views** + the `bib-insert-into-active!`
   handler (mode-aware, reuse cite/RefTeX) + the `define-element-view`
   registration + a `*bib-search-source*` defcustom.

## Open forks (Jason's call)

- **Insert format mapping** — cite-key macro vs formatted reference, and which
  cite macro per mode (reuse RefTeX's `*reftex-cite-format*` menu?).
- **Bibliography source** — a single `*bib-search-source*` defcustom, or
  per-project / follow the buffer's `\bibliography{}` / `*citation-bib-path*`
  (RefTeX already tracks this).
- **Where it lives** — right-side split vs utility-dock tab.

## Licensing

`<bib-search>` is **MIT** (clean). citation.js bundled in is the same
`@citation-js` family already vendored (MIT; see ATTRIBUTION.md). No new
copyleft concern (unlike the Atari/Stella GPLv2 question).
