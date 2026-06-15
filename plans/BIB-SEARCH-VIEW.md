# bib-search — an always-open bibliography search that inserts `\cite{…}`

**Status:** BUILT on branch `bib-search-view` (awaiting live smoke). `M-x
bib-search`. Origin: Jason's `<bib-search>` web component (used on iPad via BTT
Mobile). Godot side: `:no-focus` + the `insert-text` channel (both generic). The
element (`apps/desktop/vendor/bib-search/bib-search.js`) is self-contained —
bundles citation.js (sibling `citation-js.esm.js`), ingests any format, inserts
`\cite{…}`. Registered in 7 lines (`element-view-bib-search.lisp`).

## The vision (precise scope)

A **dumb** agent: a fancy search engine over a bibliography that inserts
`\cite{…}` keys into the active buffer. That's it. Think a nicer **RefTeX** that
can stay **always open in a pane** beside your prose. It does not format
references, manage citations, or know anything about Godot.

Two halves, and the split is the whole point:

- **The element is self-contained and does all the work** — exactly like
  `<stella-emulator>`. It bundles **citation.js**, ingests a bibliography in
  **any format citation.js handles** (BibTeX, BibLaTeX, CSL-JSON, RIS…),
  provides the search/select UI, and on pick **emits the citation text**. It
  owes Godot nothing.
- **Godot just hosts it** in 6–8 lines of `define-element-view`, with
  `:no-focus` (keep the cursor in the document) and the generic insert channel.
  **No bib-specific Godot code.**

The real work is **writing the new element**. The Godot side is two small,
bib-agnostic generic features (both done) + a declarative registration.

## Why the element can't be *fully* self-contained — and how that's still clean

The element can produce `\cite{…}` but can't reach into Godot's buffer to place
it — just as on iPad it hands the text to **BTT**, which pastes it. Same shape
here: the element says "insert this text," and the **host** drops it in. That
channel is **generic and bib-agnostic** — a property of *element-views*, not of
bib-search:

> Any hosted element may dispatch an `insert-text` CustomEvent
> (`detail: { text }`, composed + bubbling); the `<element-view>` host inserts
> it into the active view via `(insert!)`. Set-and-forget, like `:no-focus`.

So the bib element fires `insert-text` with `\cite{k1,k2}` and is done. Zero
bib-specific Lisp or host code.

## Godot side — DONE (both generic, reusable)

1. **`:no-focus`** (commit `6b511f9`) — a `noFocus` view never becomes the active
   pane (`setCurrentPaneId` guard), so a panel acts on the document without
   stealing the editing focus. DOM focus untouched, so the panel's own search
   box still types. Opt in: `:no-focus #t`.
2. **`insert-text` channel** — `<element-view>` listens for the `insert-text`
   event and calls the host's `insertText` service → `(insert! text)` into the
   current buffer (the document, thanks to `:no-focus`). Shares undo/markers.

## The registration (the whole Godot integration)

```lisp
(define-element-view bib-search
  :title    "Bibliography"
  :module   "apps/desktop/vendor/bib-search/bib-search.js"  ; self-contained: UI + citation.js
  :tag      "bib-search"
  :attrs    '((src "app://editor/__host__/…/bibliography.bib"))  ; any citation.js format
  :no-focus #t
  :fit      'fill)
```

## The real work — the new `<bib-search>` element (self-contained)

A from-scratch (adapting Jason's MIT component) custom element, bundled with
citation.js, that:

1. **Ingests any format** — `src` (or an attribute/property) points at a
   bibliography; `new Cite(text)` auto-detects BibTeX/BibLaTeX/CSL-JSON/RIS and
   yields structured entries (key, author, year, title…).
2. **Searches** — fast incremental filter over author/title/year/key, the nice
   scholarly UI from the existing component.
3. **Selects** — multi-select (it's a `\cite{a,b,c}` after all).
4. **Inserts** — on the action (button / Enter / double-click), dispatches
   `insert-text` with the formatted macro. Default `\cite{keys}`; a small
   control can switch the macro (`\citep`/`\citet`/`[@key]` for pandoc/jmd) —
   the element owns that choice, not Godot.

Bundled (`apps/desktop/vendor/bib-search/`): the element module + citation.js
(Jason's `citation.min.js`). Served via `app://`; loads like the Stella bundle.

## Open forks (Jason's call — element-level, not Godot)

- **Default cite macro & the per-macro switch** — `\cite` only, or a
  `\cite`/`\citep`/`\citet`/`[@key]` selector in the element's UI.
- **Bibliography source** — a fixed `:src`, or have the element discover the
  buffer's `\bibliography{}` (Godot could pass it as an attribute on open).

## Licensing

`<bib-search>` is **MIT**; bundled citation.js is the same `@citation-js` family
already vendored (MIT). No copyleft concern (unlike Atari/Stella GPLv2).
