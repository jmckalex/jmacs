;;; element-view-bib-search.lisp — the bibliography search panel.
;;;
;;; A built-in element-view (see element-views.lisp): a self-contained
;;; `<bib-search>` web component — a fast search engine over a bibliography
;;; that inserts `\cite{…}` into the active buffer. Think a nicer RefTeX you
;;; keep open in a pane. The element bundles citation.js and ingests any
;;; format it auto-detects (BibTeX, BibLaTeX, CSL-JSON, RIS, …).
;;;
;;; Godot stays bib-agnostic: `:no-focus` opens it beside the document and
;;; keeps the cursor there; the element fires `insert-text`, and the generic
;;; element-view channel drops it into the active buffer via `insert!`.
;;;
;;;   M-x bib-search
;;;
;;; `bib-search` auto-loads the ACTIVE document's bibliography:
;;;   - LaTeX/TeX: its \bibliography / \addbibresource (via RefTeX);
;;;   - markdown/jmarkdown: a `Bibliography: path` metadata-header line;
;;;   - else `*citation-bib-path*`, else the bundled sample.
;;; See plans/BIB-SEARCH-VIEW.md.

(define-element-view bib-search
  :title    "Bibliography"
  :module   "apps/desktop/vendor/bib-search/bib-search.js"
  :tag      "bib-search"
  :attrs    '((src "app://editor/apps/desktop/vendor/bib-search/sample.bib"))
  :no-focus #t
  :fit      'fill
  :keyboard 'grab)

(define *bib-search-sample*
  "app://editor/apps/desktop/vendor/bib-search/sample.bib")

;; --- detect the active document's bibliography -------------------------

(define (-bib-search-latex-path)
  "The first bib path of the active LaTeX document (its \\bibliography /
   \\addbibresource, resolved to an absolute path by RefTeX), or nil."
  (let ((db (reftex-document)))
    (if (nil? db)
        nil
        (let ((paths (-reftex-bib-abs-paths db)))
          (if (or (nil? paths) (= (length paths) 0))
              nil
              (car paths))))))

(define (-bib-search-scan-lines lines n)
  "Walk header LINES (cap 60) for a `Bibliography: VALUE` line
   (case-insensitive); return VALUE trimmed, or nil."
  (cond
    ((nil? lines) nil)
    ((>= n 60) nil)
    (else
     (let ((trimmed (string-trim (car lines))))
       (if (string-prefix? "bibliography:" (string-downcase trimmed))
           (string-trim (substring trimmed 13))
           (-bib-search-scan-lines (cdr lines) (+ n 1)))))))

(define (-bib-search-metadata-path)
  "The bib path from a markdown/jmarkdown `Bibliography: path` metadata
   header, resolved against the document's directory, or nil."
  (let ((decl (-bib-search-scan-lines (string-split (buffer-text) "\n") 0)))
    (if (or (nil? decl) (string=? decl ""))
        nil
        (path-resolve (view-directory (current-view)) decl))))

(define (-bib-search-document-path)
  "The active document's bibliography path (absolute), or nil — LaTeX via
   RefTeX, markdown/jmarkdown via the `Bibliography:` header, else
   `*citation-bib-path*`."
  (let* ((mode (major-mode-name))
         (from-doc
          (cond
            ((string-contains? mode "TeX") (-bib-search-latex-path))
            ((string-contains? (string-downcase mode) "markdown")
             (-bib-search-metadata-path))
            (else nil))))
    (cond
      ((and from-doc (not (string=? from-doc ""))) from-doc)
      ((and (string? *citation-bib-path*)
            (not (string=? *citation-bib-path* "")))
       *citation-bib-path*)
      (else nil))))

(define (-bib-search-source)
  "A src URL for the panel: the active document's bibliography as an
   `app://…/__host__` URL if one can be found, else the bundled sample."
  (let ((path (-bib-search-document-path)))
    (if (and (string? path) (not (string=? path "")) (string-prefix? "/" path))
        (let ((url (host-file-url path)))
          (if (string=? url "") *bib-search-sample* url))
        *bib-search-sample*)))

;; The smart open: shadows the command `define-element-view` generated above,
;; adding the document's bibliography as the panel's `:src` and `:bib-path`.
;; `:src` is the URL the panel fetches; `:bib-path` is the bib's absolute
;; host path, which the panel hands back when opening a BibDesk PDF so the
;; host can anchor the relative-path fallback. (Re-running while the panel is
;; already open is a no-op; use the View menu to load a different
;; bibliography — see the host's per-mode menu wiring.)
(defcommand bib-search ()
  "Open the bibliography search panel beside the document, auto-loading the
   active document's bibliography (LaTeX \\bibliography / \\addbibresource,
   or a markdown/jmarkdown `Bibliography:` metadata header), falling back to
   `*citation-bib-path*` then the bundled sample. Search, then click an
   entry (or its checkbox) and Insert to drop `\\cite{…}` into the document.
   Where an entry carries a BibDesk PDF alias, its title links to the PDF."
  (let* ((path (-bib-search-document-path))
         (abs  (and (string? path) (not (string=? path "")) (string-prefix? "/" path) path))
         (src  (if abs
                   (let ((url (host-file-url abs)))
                     (if (string=? url "") *bib-search-sample* url))
                   *bib-search-sample*))
         (attrs (if abs
                    (list (list 'src src) (list 'bib-path abs))
                    (list (list 'src src)))))
    (open-element-view!
      (assoc (element-view-spec 'bib-search) :attrs attrs))))
