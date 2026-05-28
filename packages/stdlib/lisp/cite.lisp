;;; cite.lisp — citation parsing and formatting via citation.js.
;;;
;;; The host primitives (`citation-parse`, `citation-format`,
;;; `citation-format-bibliography`, `citation-keys`) bridge the
;;; renderer-side citation.js bundle to Lisp. They speak in
;;; *bibliography handles* — JSON-serialised CSL-JSON arrays.
;;; A typical flow:
;;;
;;;   (define bib (load-bibliography "~/refs.bib"))
;;;   (format-bibliography bib)                  ; default style
;;;   (format-bibliography bib :style "vancouver")
;;;
;;; The intent is to ship the primitives and the defcustoms now;
;;; commands (pickers, inline-cite expansion, format-on-save) layer
;;; on top — write them in `init.lisp`.

;; --- user-facing settings ---------------------------------------------

(defcustom *citation-style* "apa" :string
  :group 'editing
  :doc "Default CSL style id for citation formatting. Common values:
        `apa`, `vancouver`, `harvard1`. Citation.js ships a handful of
        styles by default; the broader CSL ecosystem (~2k styles) is
        loadable via `register-citation-style!` when needed.")

(defcustom *citation-bib-path* "" :string
  :group 'editing
  :doc "Default path to a BibTeX / BibLaTeX / CSL-JSON file. Read by
        `load-default-bibliography` when no explicit path is given.
        An empty string means no default — callers must pass a path.")

;; --- convenience wrappers ---------------------------------------------

(define (load-bibliography path)
  "Read the file at PATH and parse it into a bibliography handle.
   PATH is run through the host's tilde-expansion. Returns the
   CSL-JSON serialisation of the entries; pass the result back to
   `format-bibliography`, `format-citation`, or `citation-keys`.
   Errors out (via the host primitive) if the file is unreadable or
   the content is unparseable."
  (citation-parse (read-file-text! path)))

(define (load-default-bibliography)
  "Read `*citation-bib-path*` and return a bibliography handle. Errors
   when the setting is empty."
  (if (or (nil? *citation-bib-path*)
          (string=? *citation-bib-path* ""))
      (error "load-default-bibliography: *citation-bib-path* is unset")
      (load-bibliography *citation-bib-path*)))

(define (format-bibliography handle . opts)
  "Render HANDLE (a bibliography handle from `load-bibliography` or
   `citation-parse`) as a bibliography string. Optional keyword args
   override `*citation-style*` — :style \"vancouver\", :format \"html\",
   :lang \"de-DE\". Defaults: *citation-style* / text / en-US."
  (let* ((kw (apply hash-map opts))
         (style  (get kw :style  *citation-style*))
         (format (get kw :format "text"))
         (lang   (get kw :lang   "en-US")))
    (citation-format-bibliography handle style format lang)))

(define (format-citation handle . opts)
  "Render HANDLE as an in-text citation string. Same option keywords
   as `format-bibliography`."
  (let* ((kw (apply hash-map opts))
         (style  (get kw :style  *citation-style*))
         (format (get kw :format "text"))
         (lang   (get kw :lang   "en-US")))
    (citation-format handle style format lang)))
