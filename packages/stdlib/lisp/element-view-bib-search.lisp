;;; element-view-bib-search.lisp — the bibliography search panel.
;;;
;;; A built-in element-view (see element-views.lisp): a self-contained
;;; `<bib-search>` web component — a fast search engine over a bibliography
;;; that inserts `\cite{…}` into the active buffer. Think a nicer RefTeX you
;;; keep open in a pane. The element bundles citation.js and ingests any
;;; format it auto-detects (BibTeX, BibLaTeX, CSL-JSON, RIS, …).
;;;
;;; The whole Godot integration is this one form — no bib-specific host code:
;;;   - :no-focus keeps the cursor in the document when you use the panel;
;;;   - the element fires `insert-text`, and the generic element-view channel
;;;     drops it into the active buffer via `insert!`.
;;;
;;;   M-x bib-search
;;;
;;; Point :src at your own bibliography (a repo path, or an
;;; `app://editor/__host__/<abs path>` URL for a file outside the repo). The
;;; default is the bundled sample. See plans/BIB-SEARCH-VIEW.md.

(define-element-view bib-search
  :title    "Bibliography"
  :module   "apps/desktop/vendor/bib-search/bib-search.js"
  :tag      "bib-search"
  :attrs    '((src "app://editor/apps/desktop/vendor/bib-search/sample.bib"))
  :no-focus #t
  :fit      'fill
  :keyboard 'grab)
