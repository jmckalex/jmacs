;;; latex-insert.lisp — AUCTeX Phase 2: smart insertion for latex-mode.
;;;
;;; Phase 2 of plans/AUCTeX.md: the daily-authoring layer —
;;; environment / macro / section / font insertion — on top of the
;;; `latex-surround` helper (latex.lisp) and the completing minibuffer.
;;; All of it is Lisp on existing primitives; no new host primitives,
;;; no new view kinds. The commands added to the `C-c` prefix map:
;;;
;;;   C-c C-e  latex-insert-environment  — \begin{ENV}…\end{ENV} (template)
;;;   C-c ]    latex-close-environment   — \end the innermost open env
;;;   C-c C-m  latex-insert-macro        — \NAME{} (point inside / wrap region)
;;;   C-c C-s  latex-insert-section      — \<level>{} (+ optional \label)
;;;   C-c C-f …  font sub-map            — C-b/C-i/C-e/C-t → bf/it/emph/tt
;;;
;;; Loaded AFTER reftex-refs.lisp (it extends `latex-c-c-map` further and
;;; softly reuses RefTeX's `*reftex-label-prefixes*` when present). It does
;;; not edit latex.lisp / latex-compile.lisp / reftex-refs.lisp; like those
;;; files it `assoc`s onto `latex-c-c-map` and re-installs latex-mode-map.
;;;
;;; ## Design — the pure core
;;;
;;; Everything that can be a pure function is one, so it is unit-testable
;;; without a buffer, a view, or the minibuffer (see latex-insert.test.js):
;;;
;;;   * `-latex-env-template`   — (env, indent, body)->string : the
;;;     \begin…\end block with the right content lines per env kind;
;;;   * `-latex-env-candidates` — (text)->list : the static env list
;;;     merged with `\begin{NAME}`s scanned from the buffer text, deduped;
;;;   * `-latex-macro-candidates` — likewise for macros;
;;;   * `-latex-innermost-open-env` — (text, offset)->env-or-nil : the
;;;     unmatched-innermost `\begin{X}` open at OFFSET (for close-env);
;;;   * `-latex-section-level?`  — whether a string names a section level.
;;;
;;; The commands are thin impure wrappers that gather text/offset/region,
;;; call the pure core, and `insert!` (via the minibuffer to choose a
;;; name). The minibuffer/insert round-trip itself is live-smoke.

;; --- user-facing settings ---------------------------------------------
;; The `latex` customize group is declared by latex-compile.lisp (loaded
;; first). We add three settings to it.

;; Candidate environment names for `latex-insert-environment`. Merged at
;; prompt time with the environment names already used in the buffer (a
;; scan for `\begin{NAME}`), so a document's own environments complete
;; even when not listed here.
(defcustom *latex-environments*
  '("itemize" "enumerate" "description" "figure" "table" "tabular"
    "equation" "align" "gather" "multline" "verbatim" "quote" "quotation"
    "center" "flushleft" "flushright" "abstract" "minipage" "matrix"
    "cases" "array" "theorem" "proof" "lemma" "definition" "lstlisting")
  :list
  :group 'latex
  :doc "Candidate environment names offered by `latex-insert-environment`
   (C-c C-e), merged with the `\\begin{NAME}` environments already used in
   the buffer. Add your document's recurring environments here so they
   complete without first appearing in the text.")

;; Candidate macro names (without the leading backslash) for
;; `latex-insert-macro`. Merged at prompt time with `\macro`s scanned
;; from the buffer.
(defcustom *latex-macros*
  '("textbf" "textit" "texttt" "textsc" "textsf" "textrm" "emph"
    "underline" "ref" "eqref" "pageref" "cite" "citep" "citet" "label"
    "footnote" "marginpar" "section" "subsection" "subsubsection"
    "chapter" "paragraph" "item" "caption" "includegraphics" "url"
    "href" "mathbf" "mathit" "mathrm" "mathcal" "frac" "sqrt" "sum"
    "int" "text")
  :list
  :group 'latex
  :doc "Candidate macro names (no leading backslash) offered by
   `latex-insert-macro` (C-c C-m), merged with the `\\macro`s already used
   in the buffer. On choosing NAME the command inserts `\\NAME{}` with
   point inside the braces (or wraps the active region).")

;; Whether `latex-insert-section` follows the heading with a `\label{}`.
(defcustom *latex-section-insert-label* #f
  :boolean
  :group 'latex
  :doc "When #t, `latex-insert-section` (C-c C-s) inserts a `\\label{}`
   right after the sectioning macro (with a `sec:` key prefix, reusing
   RefTeX's section prefix when RefTeX is loaded). Off by default — the
   heading is inserted alone, and RefTeX's `reftex-label` (C-c () is the
   richer way to add a label.")

;; The sectioning levels offered by `latex-insert-section`, outermost
;; first. The default level when the prompt is empty is "section".
(define *latex-section-levels*
  '("part" "chapter" "section" "subsection" "subsubsection"
    "paragraph" "subparagraph"))

;; --- pure: candidate merge --------------------------------------------
;; Both the environment and macro pickers offer a static list MERGED with
;; names scanned from the buffer text, deduplicated, in a stable order
;; (static names first in their declared order, then buffer-only names in
;; first-seen order). PURE — driven by a text string.

(define (-latex-dedup lst)
  "LST with duplicate strings removed, keeping first occurrences in order."
  (-latex-dedup-loop lst (list) (list)))

(define (-latex-dedup-loop lst seen acc)
  (cond
    ((nil? lst) (reverse acc))
    ((-latex-member? (car lst) seen)
     (-latex-dedup-loop (cdr lst) seen acc))
    (else
     (-latex-dedup-loop (cdr lst) (cons (car lst) seen) (cons (car lst) acc)))))

(define (-latex-member? x lst)
  "Whether string X is `string=?` to some element of LST."
  (cond
    ((nil? lst) #f)
    ((string=? (car lst) x) #t)
    (else (-latex-member? x (cdr lst)))))

(define (-latex-merge-candidates static scanned)
  "Merge the STATIC candidate list with the SCANNED (buffer) names: static
   first (declared order), then buffer-only names (first-seen order), all
   deduped. PURE."
  (-latex-dedup (append static scanned)))

;; --- pure: scan the buffer text for names -----------------------------

(define (-latex-scan-after text marker)
  "Every `{NAME}` argument following an occurrence of MARKER (e.g.
   \"\\begin{\") in TEXT, as a list of NAME strings in document order.
   PURE — a hand walk via `string-index-of`."
  (-latex-scan-after-loop text marker 0 (list)))

(define (-latex-scan-after-loop text marker from acc)
  (let ((hit (string-index-of text marker from)))
    (if (< hit 0)
        (reverse acc)
        (let* ((start (+ hit (string-length marker)))
               (close (string-index-of text "}" start)))
          (if (< close 0)
              (reverse acc)
              (-latex-scan-after-loop
               text marker (+ close 1)
               (cons (substring text start close) acc)))))))

(define (-latex-scan-env-names text)
  "Environment names used in TEXT (the `\\begin{NAME}` arguments), in
   document order, deduped. PURE."
  (-latex-dedup (-latex-scan-after text "\\begin{")))

(define (-latex-env-candidates text)
  "The environment completion candidates for TEXT: `*latex-environments*`
   merged with the buffer's own `\\begin{…}` names, deduped. PURE."
  (-latex-merge-candidates *latex-environments* (-latex-scan-env-names text)))

(define (-latex-scan-macro-names text)
  "Macro names used in TEXT — the run of letters after each `\\` — in
   document order, deduped. Single-letter and symbol control sequences are
   skipped (only [A-Za-z]+ macro names are collected). PURE."
  (-latex-dedup (-latex-scan-macros-loop text 0 (list))))

(define (-latex-scan-macros-loop text from acc)
  (let ((bs (string-index-of text "\\" from)))
    (if (< bs 0)
        (reverse acc)
        (let* ((name-end (-latex-letter-run-end text (+ bs 1)))
               (name (substring text (+ bs 1) name-end)))
          (if (string=? name "")
              ;; A control symbol (\\, \{, …) — skip the escaped char.
              (-latex-scan-macros-loop text (+ bs 2) acc)
              (-latex-scan-macros-loop text name-end (cons name acc)))))))

(define (-latex-letter-run-end text i)
  "The index after the run of ASCII letters starting at I in TEXT."
  (cond
    ((>= i (string-length text)) i)
    ((-latex-letter? (substring text i (+ i 1)))
     (-latex-letter-run-end text (+ i 1)))
    (else i)))

(define *latex-letters*
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")

(define (-latex-letter? c)
  "Whether single-character string C is an ASCII letter."
  (>= (string-index-of *latex-letters* c) 0))

(define (-latex-macro-candidates text)
  "The macro completion candidates for TEXT: `*latex-macros*` merged with
   the buffer's own `\\macro` names, deduped. PURE."
  (-latex-merge-candidates *latex-macros* (-latex-scan-macro-names text)))

;; --- pure: environment templates --------------------------------------
;; `-latex-env-template` builds the full `\begin…\end` block for ENV,
;; indented by INDENT (the current line's leading whitespace), with the
;; right content per env kind. BODY, when non-empty, is wrapped as the
;; environment body (region-wrap); when "" a kind-specific empty template
;; is produced. The returned block carries a NUL (`\0`) sentinel marking
;; where point should land; the caller splits on it (so the pure function
;; stays a plain string->string and the cursor logic is testable). NUL
;; never appears in LaTeX source, and the Lisp reader supports `\0` (it
;; does not support `\f`).

(define *latex-point-mark* "\0")

(define (-latex-list-env? env)
  (or (string=? env "itemize")
      (string=? env "enumerate")
      (string=? env "description")))

(define (-latex-float-env? env)
  (or (string=? env "figure") (string=? env "table")))

(define (-latex-math-env? env)
  (or (string=? env "equation")
      (string=? env "align")
      (string=? env "gather")
      (string=? env "multline")
      (string=? env "displaymath")
      (string=? env "eqnarray")))

(define (-latex-float-prefix env)
  "The label-key prefix for a float ENV: `fig:` for figure, `tab:` for
   table. Reuses RefTeX's `*reftex-label-prefixes*` when RefTeX is loaded
   (so a user who customised those prefixes gets them here too); degrades
   to the built-in defaults otherwise."
  (if (string=? env "figure")
      (-latex-soft-reftex-prefix :figure "fig:")
      (-latex-soft-reftex-prefix :table "tab:")))

(define (-latex-soft-reftex-prefix type fallback)
  "RefTeX's label prefix for TYPE if `*reftex-label-prefixes*` is bound and
   carries it, else FALLBACK. A soft dependency — RefTeX is on this branch,
   but the lookup degrades gracefully when it isn't: referencing the
   variable when RefTeX is absent raises, which `try` turns into FALLBACK."
  (try
   (-latex-assq-default type *reftex-label-prefixes* fallback)
   (catch _e fallback)))

(define (-latex-assq-default key alist default)
  "The cdr of the first (key . v) pair in ALIST whose car `eq?`s KEY, or
   DEFAULT."
  (cond
    ((nil? alist) default)
    ((eq? (car (car alist)) key) (cdr (car alist)))
    (else (-latex-assq-default key (cdr alist) default))))

(define (-latex-env-content env indent body)
  "The content LINES (each already prefixed with INDENT + one step) for
   ENV's body. When BODY is non-empty it is used verbatim as the single
   content line (region-wrap); otherwise a kind-specific empty template is
   produced, with the `*latex-point-mark*` placed where point should land.
   Returns the joined content string (no trailing newline)."
  (let ((step (str indent "  ")))
    (cond
      ((not (string=? body ""))
       ;; Region-wrap: the region text becomes the body, point after it.
       (str step body *latex-point-mark*))
      ((string=? env "description")
       (str step "\\item[] " *latex-point-mark*))
      ((-latex-list-env? env)
       (str step "\\item " *latex-point-mark*))
      ((-latex-float-env? env)
       (let ((prefix (-latex-float-prefix env)))
         (str step "\\centering\n"
              step *latex-point-mark* "\n"
              step "\\caption{}\n"
              step "\\label{" prefix "}")))
      ((string=? env "tabular")
       ;; The column spec is part of the \begin line, handled by the
       ;; caller; the body is a single empty content line.
       (str step *latex-point-mark*))
      ((-latex-math-env? env)
       (str step *latex-point-mark*))
      (else
       (str step *latex-point-mark*)))))

(define (-latex-begin-line env indent colspec)
  "The `\\begin{ENV}` line (indented), with `{COLSPEC}` appended when
   COLSPEC is a non-empty string (tabular/array). No trailing newline."
  (str indent "\\begin{" env "}"
       (if (or (nil? colspec) (string=? colspec ""))
           ""
           (str "{" colspec "}"))))

(define (-latex-env-template env indent body colspec)
  "The full `\\begin{ENV}…\\end{ENV}` block, INDENT-prefixed, with a
   content template per ENV kind (BODY wraps a region when non-empty;
   COLSPEC is the tabular/array column spec, ignored otherwise). The
   string carries one `*latex-point-mark*` (NUL) marking the cursor
   landing spot. PURE — string in, string out."
  (str (-latex-begin-line env indent colspec) "\n"
       (-latex-env-content env indent body) "\n"
       indent "\\end{" env "}"))

;; --- pure: innermost open environment (for close-environment) ----------
;; Scan `\begin{X}` / `\end{X}` from the buffer start to OFFSET, tracking
;; nesting on a stack; the unmatched innermost `\begin{X}` still open at
;; OFFSET is the one `latex-close-environment` should close. PURE — a hand
;; walk over the text (the same begin/end-marker approach reftex-refs uses,
;; kept independent so this file doesn't depend on RefTeX internals).

(define (-latex-innermost-open-env text offset)
  "The name of the innermost `\\begin{ENV}` open at OFFSET in TEXT (i.e.
   begun before OFFSET with no matching `\\end` before OFFSET), or nil when
   none is open. PURE."
  (-latex-open-env-walk (-latex-env-markers text offset) (list)))

(define (-latex-env-markers text limit)
  "Every `\\begin{E}` / `\\end{E}` whose marker starts before LIMIT in
   TEXT, as records (:which 'begin|'end :name E), in document order. PURE."
  (-latex-marker-scan text 0 limit (list)))

(define (-latex-marker-scan text from limit acc)
  (let ((b (string-index-of text "\\begin{" from))
        (e (string-index-of text "\\end{" from)))
    (cond
      ((and (< b 0) (< e 0)) (reverse acc))
      ((or (< e 0) (and (>= b 0) (< b e)))
       (if (>= b limit)
           (reverse acc)
           (-latex-marker-scan
            text (+ b 7) limit
            (cons (-latex-marker text (+ b 7) 'begin) acc))))
      (else
       (if (>= e limit)
           (reverse acc)
           (-latex-marker-scan
            text (+ e 5) limit
            (cons (-latex-marker text (+ e 5) 'end) acc)))))))

(define (-latex-marker text name-start which)
  "Build a begin/end marker record from NAME-START (the index just after
   the opening `{`): the env name runs to the next `}`."
  (let ((close (string-index-of text "}" name-start)))
    (hash-map :which which
              :name (if (< close 0) "" (substring text name-start close)))))

(define (-latex-open-env-walk markers stack)
  "Fold MARKERS (document order) maintaining STACK of open env names; a
   'begin pushes, an 'end pops the nearest match. At the end the top of
   STACK is the innermost still-open env, or nil when balanced."
  (cond
    ((nil? markers) (if (nil? stack) nil (car stack)))
    (else
     (let* ((m (car markers))
            (name (get m :name "")))
       (if (eq? (get m :which nil) 'begin)
           (-latex-open-env-walk (cdr markers) (cons name stack))
           (-latex-open-env-walk (cdr markers) (-latex-pop-env name stack)))))))

(define (-latex-pop-env name stack)
  "Pop the nearest STACK entry equal to NAME (a mismatched `\\end` is
   tolerated — left as-is when no match is found)."
  (cond
    ((nil? stack) stack)
    ((string=? (car stack) name) (cdr stack))
    (else (cons (car stack) (-latex-pop-env name (cdr stack))))))

;; --- pure: section level handling -------------------------------------

(define (-latex-section-level? s)
  "Whether string S names a sectioning level in `*latex-section-levels*`."
  (-latex-member? s *latex-section-levels*))

(define (-latex-normalize-level s)
  "Normalise a section-level choice S: a recognised level is returned as
   is; an empty / unrecognised choice defaults to \"section\"."
  (if (-latex-section-level? s) s "section"))

;; --- impure: insertion at point ---------------------------------------
;; The block-with-sentinel is materialised at point: insert the text up to
;; the `*latex-point-mark*`, remember point, insert the rest, then return
;; point to the mark. So the pure template stays string->string and the
;; cursor placement is one shared helper.

(define (-latex-insert-with-mark block)
  "Insert BLOCK (a string carrying exactly one `*latex-point-mark*`) at
   point, leaving point where the mark was. When BLOCK has no mark, the
   whole thing is inserted and point ends after it."
  (let ((i (string-index-of block *latex-point-mark*)))
    (if (< i 0)
        (insert! block)
        (begin
          (insert! (substring block 0 i))
          (let ((p (point)))
            (insert! (substring block (+ i (string-length *latex-point-mark*))
                                (string-length block)))
            (goto! p))))))

;; --- captured region body for the minibuffer pickers ------------------
;; latex-surround works synchronously, so it reads the region itself. The
;; env / macro / section pickers, by contrast, choose a name through the
;; minibuffer first; the region might not survive that round-trip, so they
;; capture (and delete) any active region UP FRONT, then wrap the captured
;; body when the name comes back. `-latex-capture-body!` is the shared
;; capture; `-latex-wrap-or-insert` the shared materialiser (used by macro
;; / section; the environment picker wraps the body into its template).

(define *latex-pending-body* "")

(define (-latex-capture-body!)
  "Capture any active region into `*latex-pending-body*`, deleting it from
   the buffer; otherwise clear the pending body. Called at command time,
   before a picker's minibuffer opens."
  (set! *latex-pending-body*
        (if (region-active?)
            (let ((t (region-text))) (delete-backward!) t)
            "")))

(define (-latex-wrap-or-insert opener closer)
  "Insert OPENER + the captured `*latex-pending-body*` + CLOSER at point;
   with no captured body, leave point between OPENER and CLOSER (mirrors
   `latex-surround`, but over the pre-captured body so it survives the
   minibuffer). Clears the pending body."
  (let ((body *latex-pending-body*))
    (set! *latex-pending-body* "")
    (if (string=? body "")
        (begin
          (insert! (str opener closer))
          (goto! (- (point) (string-length closer))))
        (insert! (str opener body closer)))))

;; --- latex-insert-environment (C-c C-e) -------------------------------

(define (latex-insert-environment-body env colspec body)
  "Materialise the environment ENV at point: build its template (wrapping
   BODY when a region was active) and insert it with point on the content
   line. COLSPEC is the tabular/array column spec (\"\" otherwise). The
   block is indented to the current line's leading whitespace."
  (let* ((indent (line-indent))
         (block (-latex-env-template env indent body colspec)))
    (-latex-insert-with-mark block)
    (show-status! (str "Inserted \\begin{" env "}"))))

(define (-latex-needs-colspec? env)
  "Whether ENV takes a mandatory column-spec argument on its \\begin line."
  (or (string=? env "tabular") (string=? env "array")))

;; The region body to wrap (or "") is captured into the shared
;; `*latex-pending-body*` when `latex-insert-environment` opens its prompt
;; (`-latex-capture-body!`, defined with the macro/section pickers below) —
;; the minibuffer may not preserve the buffer's selection across the
;; round-trip, so the body is grabbed (and the region deleted) at
;; invocation time, then materialised when the env name (and column spec)
;; come back. Mirrors RefTeX's origin-capture pattern.

(define (-latex-env-deliver env)
  "Minibuffer submit handler for `latex-insert-environment`: with the
   chosen ENV (nil/empty cancels), either prompt for a column spec
   (tabular/array) or insert straight away, wrapping the pre-captured
   region body (`*latex-pending-body*`)."
  (set! *latex-insert-tab-complete* nil)
  (let ((body *latex-pending-body*))
    (set! *latex-pending-body* "")
    (cond
      ((nil? env) nil)
      ((string=? env "") nil)
      ((-latex-needs-colspec? env)
       (open-completing-minibuffer! (str "Column spec for " env ": ") "lcr")
       (set! *minibuffer-reader*
             (lambda (spec)
               (latex-insert-environment-body
                env (if (nil? spec) "" spec) body))))
      (else (latex-insert-environment-body env "" body)))))

(defcommand latex-insert-environment ()
  "Insert a `\\begin{ENV}…\\end{ENV}` environment chosen in the minibuffer
   with TAB completion over `*latex-environments*` merged with the
   environments already used in the buffer. The body is templated per kind
   (itemize/enumerate→\\item; description→\\item[]; figure/table→
   \\centering/\\caption/\\label; tabular→a column-spec prompt;
   equation/align/…→a math body line), with point on the content line. An
   active region is wrapped as the environment body instead. Bound to
   C-c C-e."
  ;; Capture (and remove) any active region NOW — the body is wrapped once
  ;; the env name comes back from the minibuffer. The region may not
  ;; survive the minibuffer, so grab it up front.
  (-latex-capture-body!)
  (set! *latex-insert-candidates* (-latex-env-candidates (buffer-text)))
  (set! *latex-insert-tab-complete* -latex-insert-name-tab-complete)
  (open-completing-minibuffer! "Environment: " "")
  (set! *minibuffer-reader* -latex-env-deliver))

;; --- latex-close-environment (C-c ]) ----------------------------------

(defcommand latex-close-environment ()
  "Close the innermost currently-open LaTeX environment: scan from the
   buffer start to point tracking `\\begin`/`\\end` nesting, find the
   unmatched innermost `\\begin{X}`, and insert `\\end{X}` on its own line
   at point (indented to the current line). Echoes which env was closed;
   reports and does nothing when no environment is open. Bound to C-c ]."
  (let ((env (-latex-innermost-open-env (buffer-text) (point))))
    (cond
      ((nil? env)
       (show-status! "latex-close-environment: no open environment"))
      (else
       ;; If point is on an otherwise-blank line (only whitespace before
       ;; it), close in place — the existing leading whitespace is the
       ;; indent, so the `\end` goes straight in. If point is mid-line,
       ;; drop the `\end` onto a fresh line indented to the current line.
       (if (-latex-at-line-start-ish?)
           (insert! (str "\\end{" env "}"))
           (insert! (str "\n" (line-indent) "\\end{" env "}")))
       (show-status! (str "Closed \\end{" env "}"))))))

(define (-latex-at-line-start-ish?)
  "Whether point sits at the start of its line or after only whitespace —
   so `latex-close-environment` knows whether to prepend a newline before
   the `\\end`."
  (let ((from (line-start))
        (p (point)))
    (string=? (-latex-trim (buffer-substring from p)) "")))

(define (-latex-trim s)
  "S with leading and trailing ASCII whitespace removed."
  (-latex-trim-trailing (-latex-trim-leading s)))

(define (-latex-trim-leading s)
  (cond
    ((string=? s "") s)
    ((-latex-space? (substring s 0 1))
     (-latex-trim-leading (substring s 1 (string-length s))))
    (else s)))

(define (-latex-trim-trailing s)
  (let ((n (string-length s)))
    (cond
      ((= n 0) s)
      ((-latex-space? (substring s (- n 1) n))
       (-latex-trim-trailing (substring s 0 (- n 1))))
      (else s))))

(define (-latex-space? c)
  "Whether single-character string C is a space, tab, or newline."
  (or (string=? c " ") (string=? c "\t") (string=? c "\n")))

;; --- latex-insert-macro (C-c C-m) -------------------------------------

(define (-latex-insert-macro-named name)
  "Insert `\\NAME{}` at point with point inside the braces, or wrap the
   captured region as `\\NAME{<region>}`. Multi-argument macros get a
   single `{}` (point in the first/only argument) — a v1 limitation;
   further arguments are typed by hand."
  (-latex-wrap-or-insert (str "\\" name "{") "}"))

(define (-latex-macro-deliver name)
  "Minibuffer submit handler for `latex-insert-macro`: insert the chosen
   macro (nil/empty cancels). The leading backslash is stripped if the
   user typed one, so `\\emph` and `emph` both work."
  (set! *latex-insert-tab-complete* nil)
  (cond
    ((nil? name) (set! *latex-pending-body* "") nil)
    ((string=? name "") (set! *latex-pending-body* "") nil)
    (else
     (let ((clean (if (string-prefix? "\\" name)
                      (substring name 1 (string-length name))
                      name)))
       (-latex-insert-macro-named clean)
       (show-status! (str "Inserted \\" clean "{}"))))))

(defcommand latex-insert-macro ()
  "Insert a `\\NAME{}` macro chosen in the minibuffer with TAB completion
   over `*latex-macros*` merged with the `\\macro`s already used in the
   buffer. Point lands inside the braces; an active region is wrapped as
   the argument. Bound to C-c C-m."
  (-latex-capture-body!)
  (set! *latex-insert-candidates* (-latex-macro-candidates (buffer-text)))
  (set! *latex-insert-tab-complete* -latex-insert-name-tab-complete)
  (open-completing-minibuffer! "Macro: " "")
  (set! *minibuffer-reader* -latex-macro-deliver))

;; --- latex-insert-section (C-c C-s) -----------------------------------

(define (-latex-section-label-prefix)
  "The label-key prefix for a section, reusing RefTeX's `:section` prefix
   when RefTeX is loaded, else \"sec:\"."
  (-latex-soft-reftex-prefix :section "sec:"))

(define (-latex-insert-section-named level)
  "Insert `\\LEVEL{}` at point (point in the braces, or wrap the captured
   region), then a `\\label{<prefix>}` on a fresh line when
   `*latex-section-insert-label*` is on."
  (-latex-wrap-or-insert (str "\\" level "{") "}")
  (when *latex-section-insert-label*
    ;; Drop to a new line after the heading and add an empty-key \label
    ;; for the user to fill; point stays in the heading braces.
    (let ((p (point))
          (indent (line-indent)))
      (goto! (line-end))
      (insert! (str "\n" indent "\\label{" (-latex-section-label-prefix) "}"))
      (goto! p))))

(define (-latex-section-deliver level)
  "Minibuffer submit handler for `latex-insert-section`: insert the chosen
   sectioning level (an empty / unrecognised choice defaults to
   \"section\"; a cancelled prompt inserts nothing)."
  (set! *latex-insert-tab-complete* nil)
  (cond
    ((nil? level) (set! *latex-pending-body* "") nil)
    (else (-latex-insert-section-named (-latex-normalize-level level)))))

(defcommand latex-insert-section ()
  "Insert a sectioning command chosen in the minibuffer with TAB
   completion over the levels part/chapter/section/subsection/
   subsubsection/paragraph/subparagraph (empty defaults to section). Point
   lands in the braces; an active region is wrapped as the title. When
   `*latex-section-insert-label*` is on, a `\\label{}` follows. The quick
   wraps `latex-section`/`latex-subsection` (C-c s / C-c S) stay. Bound to
   C-c C-s."
  (-latex-capture-body!)
  (set! *latex-insert-candidates* *latex-section-levels*)
  (set! *latex-insert-tab-complete* -latex-insert-name-tab-complete)
  (open-completing-minibuffer! "Section level: " "section")
  (set! *minibuffer-reader* -latex-section-deliver))

;; --- latex-texttt (font sub-map) --------------------------------------

(defcommand latex-texttt ()
  "Wrap the selection in \\texttt{…} (or insert the pair with point
   between). The monospace member of the C-c C-f font sub-map, alongside
   latex-textbf / latex-textit / latex-emph from latex.lisp."
  (latex-surround "\\texttt{" "}"))

;; --- shared completion dispatch ---------------------------------------
;; The host's onTab always calls `minibuffer-tab-complete`. reftex-refs
;; already redefined it to dispatch on `*reftex-tab-complete*` (delegating
;; to find-file's handler otherwise). To add a THIRD completion source
;; (over the env / macro / section candidate list a Phase-2 picker
;; installs) without clobbering either, we add our own hook
;; `*latex-insert-tab-complete*` and redefine `minibuffer-tab-complete`
;; once more, capturing the reftex-era binding and delegating to it when
;; our hook is unset. So the chain is: latex-insert hook? -> RefTeX hook?
;; -> find-file. The picker sets the hook on open and every deliver clears
;; it, so the next unrelated prompt completes normally.

;; The candidate list the open Phase-2 picker completes over (env names,
;; macro names, or section levels). Empty when no picker is open.
(define *latex-insert-candidates* (list))

;; A 1-arg TAB handler installed while a Phase-2 picker is open, or nil.
(define *latex-insert-tab-complete* nil)

;; Capture reftex-refs's `minibuffer-tab-complete` (which itself wraps
;; find-file's) so this redefinition can delegate for non-Phase-2 prompts.
(define -latex-insert-orig-tab-complete minibuffer-tab-complete)

(define (minibuffer-tab-complete current)
  "Dispatch TAB completion: when a Phase-2 picker installed
   `*latex-insert-tab-complete*`, use it (completing over
   `*latex-insert-candidates*`); else delegate to the previously-installed
   handler (RefTeX's dispatcher, which falls through to find-file). Adds a
   third source without editing the earlier files."
  (if (nil? *latex-insert-tab-complete*)
      (-latex-insert-orig-tab-complete current)
      (*latex-insert-tab-complete* current)))

(define (-latex-insert-name-tab-complete current)
  "TAB handler for a Phase-2 name prompt: extend CURRENT to the longest
   common prefix of `*latex-insert-candidates*` that start with it, or list
   the matches in the status line. Mirrors find-file's behaviour over the
   candidate set."
  (let ((matches (filter (lambda (n) (string-prefix? current n))
                         *latex-insert-candidates*)))
    (cond
      ((nil? matches) (show-status! "(no matches)") current)
      ((nil? (cdr matches)) (clear-status!) (car matches))
      (else
       (let ((lcp (-latex-fold-common-prefix matches)))
         (if (> (string-length lcp) (string-length current))
             (begin (clear-status!) lcp)
             (begin (show-status! (-latex-join matches)) current)))))))

(define (-latex-fold-common-prefix items)
  (cond ((nil? items) "")
        ((nil? (cdr items)) (car items))
        (else (-latex-fold-common-prefix
               (cons (-latex-common-prefix (car items) (cadr items))
                     (cddr items))))))

(define (-latex-common-prefix a b)
  (-latex-common-prefix-loop a b 0))

(define (-latex-common-prefix-loop a b i)
  (if (or (>= i (string-length a))
          (>= i (string-length b))
          (not (equal? (substring a i (+ i 1)) (substring b i (+ i 1)))))
      (substring a 0 i)
      (-latex-common-prefix-loop a b (+ i 1))))

(define (-latex-join items)
  (cond ((nil? items) "")
        ((nil? (cdr items)) (car items))
        (else (str (car items) "  " (-latex-join (cdr items))))))

;; --- the font sub-map -------------------------------------------------
;; A nested keymap reached by C-c C-f, then a single font key. The keymap
;; dispatcher treats a map value found mid-chord as a deeper prefix (the
;; same mechanism that makes latex-c-c-map a sub-map under "C-c"), so a
;; "C-f" -> this map entry gives the C-c C-f <key> three-level chord.

(define latex-font-map
  {"C-b" 'latex-textbf
   "C-i" 'latex-textit
   "C-e" 'latex-emph
   "C-t" 'latex-texttt})

;; --- keybindings ------------------------------------------------------
;; Extend the C-c prefix map further (latex.lisp built it; latex-compile,
;; reftex-refs added to it). The Phase-2 chords (none collide with the
;; existing b/i/e/m/M/s/S/l/n/C-p, C-c/C-v/`, (/) bindings):
;;
;;   C-c C-e   latex-insert-environment
;;   C-c ]     latex-close-environment
;;   C-c C-m   latex-insert-macro
;;   C-c C-s   latex-insert-section
;;   C-c C-f   the font sub-map (C-b/C-i/C-e/C-t)
;;
;; `assoc` returns a new map; we rebuild it and re-install under "C-c".

(set! latex-c-c-map
  (assoc (assoc (assoc (assoc (assoc latex-c-c-map
                                     "C-e" 'latex-insert-environment)
                              "]" 'latex-close-environment)
                       "C-m" 'latex-insert-macro)
                "C-s" 'latex-insert-section)
         "C-f" latex-font-map))

(set! latex-mode-map {"C-c" latex-c-c-map})
