;;; reftex-cite.lisp — RefTeX R3: citations.
;;;
;;; Phase R3 of plans/RefTeX.md, built on R1's document model + DB
;;; (reftex.lisp) and reusing R2's origin bookkeeping (reftex-refs.lisp).
;;; It adds the daily citation command and the two bottom-docked panels
;;; that drive it:
;;;
;;;   C-c [   reftex-citation   — choose a cite format, then pick entries
;;;
;;; The flow is RefTeX's: **format first, then entries**.
;;;
;;;   1. `reftex-citation` builds the entry rows (parse the bib, format
;;;      each entry to HTML via the CSL style), remembers the origin, and
;;;      opens the *format menu* (`open-reftex-cite-format!`): a small
;;;      bottom panel listing `*reftex-cite-format*` (\cite / \citep /
;;;      \citet / …), each on a single key.
;;;   2. Picking a format (`reftex-cite-format-chosen`) swaps the bottom
;;;      panel for the *cite picker* (`open-reftex-cite-select!`): the
;;;      formatted references, searchable, with `m` to mark several.
;;;   3. RET inserts `<macro>{k1,k2,…}` at the origin (`reftex-cite-insert`).
;;;
;;; The references are shown professionally formatted (citation.js + a CSL
;;; style) purely as a *picking* aid — the inserted text is always the
;;; LaTeX `\cite`-family macro over the bib keys, so BibTeX/biblatex still
;;; own the typeset result.
;;;
;;; Loaded AFTER reftex-refs.lisp (it reuses `*reftex-ref-origin-view*` /
;;; `-reftex-remember-origin` / `-reftex-return-to-origin` and extends the
;;; `latex-c-c-map` with the `[` slot) and AFTER reftex.lisp (it reuses the
;;; R1 DB, `-reftex-bib-abs-paths`, and the master-detecting document
;;; model). Host primitives: `citation-parse`, `citation-entries`,
;;; `citation-format-entries`, `citation-register-style!`, the bottom-panel
;;; openers, plus the file/buffer/view verbs R2 already uses.

;; --- user-facing settings ---------------------------------------------
;; The `reftex` customize group is declared by reftex.lisp (loaded first).

;; The CSL style the cite picker renders each entry with. A built-in id
;; (`apa` / `vancouver` / `harvard1`) or a path to a `.csl` file (any
;; style — the file is registered with citation.js on first use). This is
;; display only; it does NOT change the inserted `\cite` macro. Distinct
;; from cite.lisp's `*citation-style*` (used by the inline-citation
;; commands) so the picker's look can differ from the inline format.
(defcustom *reftex-cite-style* "harvard1"
  :string
  :group 'reftex
  :doc "The CSL style the citation picker formats each reference with: a
   built-in id (\"apa\", \"vancouver\", \"harvard1\") or the path to a
   `.csl` file for any other style. Display only — the inserted text is
   still the `\\cite`-family macro over the bib keys.")

;; The citation formats offered in the format menu: a list of
;; (KEY MACRO DESCRIPTION) rows. KEY is the keystroke that selects the
;; format (matching the editor's key names — "enter" is the default,
;; selected by RET; single printables like "p"/"P" select the rest).
;; MACRO is the LaTeX command inserted; DESCRIPTION is the menu hint.
;; The default set covers the common natbib + biblatex commands; narrow
;; it to one package family by customising this.
(defcustom *reftex-cite-format*
  (list (list "enter" "\\cite"       "default")
        (list "p"     "\\citep"      "natbib parenthetical")
        (list "t"     "\\citet"      "natbib textual")
        (list "P"     "\\parencite"  "biblatex parenthetical")
        (list "x"     "\\textcite"   "biblatex textual")
        (list "a"     "\\citeauthor" "author only")
        (list "y"     "\\citeyear"   "year only"))
  :list
  :group 'reftex
  :doc "The citation formats the `reftex-citation` format menu offers, as
   a list of (KEY MACRO DESCRIPTION) rows. KEY is the keystroke that picks
   the format (\"enter\" for the RET default; single characters for the
   rest); MACRO is the LaTeX command inserted around the chosen keys.")

;; --- style resolution -------------------------------------------------

(define (-reftex-cite-template)
  "Resolve `*reftex-cite-style*` to a citation.js template id: a built-in
   id passed through as-is, or — when it names an existing `.csl` file —
   the id obtained by registering that file's XML. Falls back to \"apa\"
   when a `.csl` path is set but unreadable."
  (let ((s *reftex-cite-style*))
    (if (and (string-suffix? ".csl" s) (file-exists? s))
        (let ((xml (read-file-text! s)))
          (if (nil? xml) "apa" (citation-register-style! xml)))
        s)))

;; --- the bib handle + entry rows --------------------------------------

(define (-reftex-cite-handle)
  "The parsed-bib handle (`citation-parse` output) for the first existing
   bibliography path of the current document, or nil. Bib paths come from
   the R1 DB (`\\bibliography`/`\\addbibresource` + `*citation-bib-path*`),
   resolved absolute by reftex.lisp's `-reftex-bib-abs-paths`."
  (let ((db (reftex-document)))
    (if (nil? db)
        nil
        (-reftex-cite-handle-from (-reftex-bib-abs-paths db)))))

(define (-reftex-cite-handle-from paths)
  "Parse the first PATH that exists and reads, returning its handle; nil
   when none work."
  (cond
    ((nil? paths) nil)
    ((file-exists? (car paths))
     (let ((text (read-file-text! (car paths))))
       (if (nil? text)
           (-reftex-cite-handle-from (cdr paths))
           (citation-parse text))))
    (else (-reftex-cite-handle-from (cdr paths)))))

(define (-reftex-cite-plain entry)
  "A lowercase-ish plain-text blob for ENTRY (a {:key :author :year
   :title} record) used by the picker's substring filter: key, author,
   year, and title joined with spaces, skipping nil fields."
  (string-join
   (filter (lambda (s) (and (not (nil? s)) (not (string=? s ""))))
           (list (get entry :key "")
                 (-reftex-cite-field entry :author)
                 (-reftex-cite-field entry :year)
                 (-reftex-cite-field entry :title)))
   " "))

(define (-reftex-cite-field entry key)
  "ENTRY's KEY field as a string, or \"\" when nil. Coerces the numeric
   :year to a string."
  (let ((v (get entry key nil)))
    (cond
      ((nil? v) "")
      ((number? v) (number->string v))
      (else v))))

(define (-reftex-cite-row entry formatted)
  "One picker row (KEY HTML PLAIN) from a parallel ENTRY record (key /
   author / year / title) and FORMATTED record (key / html)."
  (list (get entry :key "")
        (get formatted :html "")
        (-reftex-cite-plain entry)))

(define (-reftex-build-cite-rows)
  "Build the cite picker rows — (key html plain) per bib entry, in bib
   order — by zipping `citation-entries` (for the filter text) with
   `citation-format-entries` (for the CSL-formatted HTML). Empty list
   when the document has no readable bibliography."
  (let ((handle (-reftex-cite-handle)))
    (if (nil? handle)
        (list)
        (map -reftex-cite-row
             (citation-entries handle)
             (citation-format-entries handle (-reftex-cite-template))))))

;; --- the picker state + host-read accessors ---------------------------

;; The prepared rows for the open cite picker (key html plain), and the
;; cite macro the format menu chose. Both set when `reftex-citation` runs.
(define *reftex-cite-rows* (list))
(define *reftex-cite-macro* "\\cite")

(define (reftex-cite-formats)
  "The format-menu rows — `*reftex-cite-format*` as a list of
   (key macro description). The host's format menu reads this."
  *reftex-cite-format*)

(define (reftex-cite-select-rows)
  "The prepared cite-picker rows — a list of (key html plain). The host's
   getRows closure reads this on every repaint."
  *reftex-cite-rows*)

;; --- the command + callbacks ------------------------------------------

(defcommand reftex-citation ()
  "Insert a citation. RefTeX's format-first flow: choose a cite format
   (\\cite / \\citep / \\citet / …) in a bottom format menu, then pick one
   or more entries — shown as professionally formatted references (CSL
   `*reftex-cite-style*`) — in the cite picker (`m` marks several, RET
   inserts `<macro>{k1,k2}`). The bib is the document's
   `\\bibliography`/`\\addbibresource` (plus `*citation-bib-path*`). A
   no-op with a status message when no readable bibliography is found.
   Bound to C-c [."
  (let ((rows (-reftex-build-cite-rows)))
    (cond
      ((nil? rows)
       (show-status! "RefTeX: no bibliography entries found"))
      (else
       (-reftex-remember-origin)
       (set! *reftex-cite-rows* rows)
       (open-reftex-cite-format!)))))

(define (reftex-cite-format-chosen macro)
  "Format-menu callback: remember the chosen MACRO and swap the bottom
   panel for the cite picker. A nil/empty MACRO (defensive) cancels."
  (cond
    ((or (nil? macro) (string=? macro "")) (reftex-cite-on-cancel))
    (else
     (set! *reftex-cite-macro* macro)
     (open-reftex-cite-select!))))

(define (reftex-cite-insert keys-csv)
  "Cite-picker RET callback: insert `<chosen-macro>{KEYS-CSV}` at the
   remembered origin, where KEYS-CSV is the comma-joined marked keys (or
   the highlighted key when none were marked). An empty KEYS-CSV inserts
   nothing. Returns focus to the origin view."
  (cond
    ((or (nil? keys-csv) (string=? keys-csv ""))
     (-reftex-return-to-origin)
     (show-status! "RefTeX: no citation selected"))
    (else
     (-reftex-insert-cite-at-origin *reftex-cite-macro* keys-csv)
     (-reftex-return-to-origin))))

(define (-reftex-insert-cite-at-origin macro keys-csv)
  "Insert `MACRO{KEYS-CSV}` at the remembered origin (view + point),
   switching back to the origin view first when it isn't current."
  (let ((view *reftex-ref-origin-view*)
        (pt *reftex-ref-origin-point*)
        (text (str macro "{" keys-csv "}")))
    (when (and (not (nil? view)) (not (eq? view (current-view))))
      (switch-to-view! view))
    (when (not (nil? pt)) (goto! pt))
    (insert! text)
    (show-status! (str "Inserted " text))))

(define (reftex-cite-on-cancel)
  "The bottom panel's q/ESC handler: return to the origin without
   inserting anything."
  (-reftex-return-to-origin)
  (show-status! "RefTeX: cancelled"))

;; --- keybinding -------------------------------------------------------
;; Extend the C-c prefix map with the `[` citation slot (plans/RefTeX.md's
;; keybinding table). `assoc` returns a new map; we re-install it under
;; "C-c". reftex-refs added `(`/`)`; this adds `[`.

(set! latex-c-c-map (assoc latex-c-c-map "[" 'reftex-citation))
(set! latex-mode-map {"C-c" latex-c-c-map})
