;;; reftex-refs.lisp — RefTeX R2: labels & references.
;;;
;;; Phase R2 of plans/RefTeX.md, built on R1's document model + DB
;;; (reftex.lisp). It adds the two daily RefTeX commands and the picker
;;; that drives the second:
;;;
;;;   C-c (   reftex-label       — insert a smart, unique `\label{KEY}`
;;;   C-c )   reftex-reference   — pick a label, insert `\ref`/`\eqref`/…
;;;
;;; Two pickers (RefTeX.md's "dual picker, selection-first"):
;;;
;;;   * the `*RefTeX Select*` view — a grouped, context-showing selection
;;;     surface (Part B) — is the primary path for `reftex-reference`; and
;;;   * a minibuffer fast-path (`reftex-reference-minibuffer`) for the
;;;     know-the-key case, mirroring find-file's TAB-completion flow.
;;;
;;; Loaded AFTER reftex.lisp (it queries the R1 DB via `reftex-labels`,
;;; `reftex-label-names`, `reftex-find-label`, `reftex-sections`) and
;;; AFTER latex-compile.lisp (it extends `latex-c-c-map` further with the
;;; `(` and `)` slots). reftex.lisp and latex-compile.lisp are NOT edited.
;;;
;;; ## Design — the pure core
;;;
;;; Everything that can be a pure function is one, so it is unit-testable
;;; without a buffer, a view, or the minibuffer (see reftex-refs.test.js):
;;;
;;;   * `-reftex-type-at-point` — infer the innermost enclosing-environment
;;;     type of an offset in a buffer's text (via `latex-scan`);
;;;   * `-reftex-slugify` — lowercase + non-alnum→`-` + collapse;
;;;   * `-reftex-prefix-for-type` / `-reftex-macro-for-type` — the
;;;     defcustom-table lookups;
;;;   * `-reftex-uniquify` — append `-2`, `-3`, … against a taken-name list;
;;;   * `-reftex-suggest-key` — compose the above into a suggested KEY.
;;;
;;; The commands are thin impure wrappers that gather the text/offset/DB,
;;; call the pure core, and `insert!` (optionally via the minibuffer to
;;; confirm/edit). The minibuffer/insert round-trip itself is live-smoke.

;; --- user-facing settings ---------------------------------------------
;; The `reftex` customize group is declared by reftex.lisp (loaded first).

;; type -> label-name prefix (with its trailing colon). Used to build a
;; suggested label key for `reftex-label`. The keys are the inferred-type
;; keywords R1 assigns (:equation, :figure, …); a type not listed here
;; falls back to `*reftex-label-default-prefix*`.
(defcustom *reftex-label-prefixes*
  (list (cons :equation "eq:")
        (cons :figure "fig:")
        (cons :table "tab:")
        (cons :section "sec:")
        (cons :listing "lst:")
        (cons :theorem "thm:")
        (cons :definition "def:"))
  :list
  :group 'reftex
  :doc "Alist mapping a label's inferred :type to the prefix used when
   `reftex-label` suggests a key (e.g. :equation -> \"eq:\"). A type not
   listed here uses `*reftex-label-default-prefix*`.")

;; The prefix for a label whose type isn't in `*reftex-label-prefixes*`
;; (an unrecognised environment / a bare paragraph). Empty by default —
;; a generic label carries no prefix.
(defcustom *reftex-label-default-prefix* ""
  :string
  :group 'reftex
  :doc "The label-key prefix `reftex-label` uses when the type at point
   isn't in `*reftex-label-prefixes*`. Empty (the default) means the
   suggested key is just the slugified stem.")

;; type -> the reference macro `reftex-reference` inserts for a label of
;; that type. Equations get `\eqref`; everything else `\ref`. The keys
;; are the same inferred-type keywords; an unlisted type uses
;; `*reftex-ref-macro-default*`.
(defcustom *reftex-ref-macro-by-type*
  (list (cons :equation "\\eqref"))
  :list
  :group 'reftex
  :doc "Alist mapping a label's :type to the reference macro
   `reftex-reference` inserts (e.g. :equation -> \"\\\\eqref\"). A type
   not listed uses `*reftex-ref-macro-default*` (\"\\\\ref\").")

(defcustom *reftex-ref-macro-default* "\\ref"
  :string
  :group 'reftex
  :doc "The reference macro `reftex-reference` inserts for a label whose
   :type is not in `*reftex-ref-macro-by-type*` (the common case).")

;; The default citation macro. Defined here so the RefTeX customize group
;; is coherent; R3 (`reftex-citation`) is its first consumer.
(defcustom *reftex-cite-macro* "\\cite"
  :string
  :group 'reftex
  :doc "The default citation macro RefTeX inserts. Used by R3's
   `reftex-citation` (not yet built); defined here so the RefTeX group is
   coherent and the setting is available to customize.")

;; Whether `reftex-label` confirms/edits the suggested key in the
;; minibuffer before inserting (#t, the default) or inserts it straight.
(defcustom *reftex-label-confirm* #t
  :boolean
  :group 'reftex
  :doc "When #t (the default), `reftex-label` shows the suggested label
   key in the minibuffer for confirmation/editing before inserting; when
   #f it inserts the suggestion directly. Either way the key is made
   unique against the document's existing labels.")

;; --- pure: type at point ----------------------------------------------

(define (-reftex-env->type env)
  "Map an environment NAME (as `latex-scan` reports it, possibly starred)
   to an inferred type keyword via R1's `*reftex-env-types*`, stripping a
   trailing `*` first. nil when ENV is nil or unrecognised."
  (if (nil? env)
      nil
      (-reftex-type-by-env (-reftex-strip-star env) *reftex-env-types*)))

(define (-reftex-section-before? text offset)
  "Whether the line containing OFFSET in TEXT begins (ignoring leading
   whitespace) with a `\\section`-family sectioning macro — used to type
   a label placed right after a section heading as :section."
  (let* ((ls (-reftex-line-start-of text offset))
         (le (-reftex-line-end-of text offset))
         (line (substring text ls le)))
    (-reftex-line-is-section? line)))

(define (-reftex-line-is-section? line)
  "Whether LINE (after trimming leading space) opens with a sectioning
   macro: \\part \\chapter \\section \\subsection \\subsubsection
   \\paragraph \\subparagraph (starred forms included)."
  (let ((s (-reftex-trim-leading line)))
    (or (string-prefix? "\\part" s)
        (string-prefix? "\\chapter" s)
        (string-prefix? "\\section" s)
        (string-prefix? "\\subsection" s)
        (string-prefix? "\\subsubsection" s)
        (string-prefix? "\\paragraph" s)
        (string-prefix? "\\subparagraph" s))))

(define (-reftex-type-at-point text offset)
  "Infer the label :type for a label inserted at OFFSET in TEXT: the type
   of the innermost `\\begin…\\end` environment open at OFFSET (mapped via
   R1's `*reftex-env-types*`), else :section when OFFSET's line opens with
   a sectioning macro, else nil (a generic label). PURE — `latex-scan`
   over TEXT, no buffer."
  (let ((by-env (-reftex-type-from-env text offset)))
    (cond
      ((not (nil? by-env)) by-env)
      ((-reftex-section-before? text offset) :section)
      (else nil))))

(define (-reftex-type-from-env text offset)
  "The type of the innermost environment open at OFFSET in TEXT, or nil.
   Computed by scanning `\\begin{…}` / `\\end{…}` spans directly (the
   scanner's label records only carry env for actual labels, so we walk
   the begin/end pairs ourselves to cover an offset with no label yet)."
  (-reftex-env->type (-reftex-innermost-env text offset)))

;; A small begin/end span walker, independent of `latex-scan`'s internal
;; env lookup (which is not exposed): find the innermost environment whose
;; `\begin` precedes OFFSET and whose matching `\end` follows it.

(define (-reftex-innermost-env text offset)
  "The name of the innermost `\\begin{ENV}` open at OFFSET in TEXT, or
   nil. Pairs each `\\begin{E}` with the next unmatched `\\end{E}` by a
   stack walk over the begin/end markers in document order."
  (-reftex-env-stack-walk (-reftex-env-markers text) offset (list) nil))

(define (-reftex-env-markers text)
  "Every `\\begin{E}` / `\\end{E}` in TEXT as records
   (:which 'begin|'end :name E :start OFFSET), in offset order. Uses
   `find-regexp` would be current-buffer-bound, so this is a hand walk
   over the text via `string-index-of`."
  (-reftex-scan-markers text 0 (list)))

(define (-reftex-scan-markers text from acc)
  "Collect begin/end markers from FROM onward into ACC (reversed)."
  (let ((b (string-index-of text "\\begin{" from))
        (e (string-index-of text "\\end{" from)))
    (cond
      ((and (< b 0) (< e 0)) (reverse acc))
      ((or (< e 0) (and (>= b 0) (< b e)))
       (-reftex-scan-markers
        text (+ b 7)
        (cons (-reftex-marker-at text b (+ b 7) 'begin) acc)))
      (else
       (-reftex-scan-markers
        text (+ e 5)
        (cons (-reftex-marker-at text e (+ e 5) 'end) acc))))))

(define (-reftex-marker-at text start name-start which)
  "Build a begin/end marker record: the environment name is the run of
   characters from NAME-START to the next `}`."
  (let ((close (string-index-of text "}" name-start)))
    (hash-map :which which
              :name (if (< close 0)
                        ""
                        (substring text name-start close))
              :start start)))

(define (-reftex-env-stack-walk markers offset stack best)
  "Fold MARKERS (in order) maintaining STACK of open (name . start)
   pairs; whenever a marker sits past OFFSET, the current top of STACK is
   the innermost env enclosing OFFSET. Returns that env name, or nil."
  (cond
    ((nil? markers) best)
    (else
     (let* ((m (car markers))
            (start (get m :start 0)))
       (if (> start offset)
           ;; First marker beyond OFFSET: the innermost open env (top of
           ;; stack) encloses OFFSET — unless the stack is empty.
           (if (nil? stack) nil (car (car stack)))
           (-reftex-env-stack-walk
            (cdr markers) offset
            (-reftex-apply-marker m stack)
            best))))))

(define (-reftex-apply-marker m stack)
  "Apply marker M to STACK: push (name . start) on 'begin, pop the
   nearest matching name on 'end."
  (if (eq? (get m :which nil) 'begin)
      (cons (cons (-reftex-strip-star (get m :name "")) (get m :start 0)) stack)
      (-reftex-pop-env (-reftex-strip-star (get m :name "")) stack)))

(define (-reftex-pop-env name stack)
  "Pop the nearest entry named NAME from STACK (a mismatched \\end is
   tolerated — left as-is if no match)."
  (cond
    ((nil? stack) stack)
    ((string=? (car (car stack)) name) (cdr stack))
    (else (cons (car stack) (-reftex-pop-env name (cdr stack))))))

;; line bounds in a text string (pure analogues of the buffer ops) -------

(define (-reftex-line-start-of text offset)
  "The offset of the start of the line containing OFFSET in TEXT."
  (let ((i (-reftex-last-newline text (- offset 1))))
    (if (< i 0) 0 (+ i 1))))

(define (-reftex-line-end-of text offset)
  "The offset of the end of the line containing OFFSET (the next newline,
   or the text length)."
  (let ((i (string-index-of text "\n" offset)))
    (if (< i 0) (string-length text) i)))

(define (-reftex-last-newline text from)
  "The index of the last `\\n` at or before FROM in TEXT, or -1."
  (cond ((< from 0) -1)
        ((>= from (string-length text))
         (-reftex-last-newline text (- (string-length text) 1)))
        ((equal? (substring text from (+ from 1)) "\n") from)
        (else (-reftex-last-newline text (- from 1)))))

;; --- pure: slugify ----------------------------------------------------

(define *reftex-slug-alphabet* "abcdefghijklmnopqrstuvwxyz0123456789")

(define (-reftex-slug-char? c)
  "Whether single-character string C is a slug-safe char (a-z 0-9). The
   caller lower-cases first, so only the lowercase alphabet is checked."
  (>= (string-index-of *reftex-slug-alphabet* c) 0))

(define (-reftex-slugify s)
  "Slugify S: lowercase, every run of non-alphanumeric characters becomes
   a single `-`, leading/trailing `-` trimmed. PURE."
  (-reftex-slug-trim
   (-reftex-slug-collapse (string-downcase s) 0 "" #f)))

(define (-reftex-slug-collapse s i acc pending-dash)
  "Walk S char by char from I building ACC. A slug-safe char is appended
   (emitting a single pending `-` first); any other char sets the
   pending-dash flag so a run collapses to one `-`."
  (cond
    ((>= i (string-length s)) acc)
    (else
     (let ((c (substring s i (+ i 1))))
       (if (-reftex-slug-char? c)
           (-reftex-slug-collapse
            s (+ i 1)
            (str acc (if (and pending-dash (> (string-length acc) 0)) "-" "") c)
            #f)
           (-reftex-slug-collapse s (+ i 1) acc #t))))))

(define (-reftex-slug-trim s)
  "Strip a leading and trailing `-` from slug string S (the collapse step
   never emits a leading dash, but a trailing one can't occur either —
   this is belt-and-braces for hand-built inputs)."
  (-reftex-slug-trim-trailing (-reftex-slug-trim-leading s)))

(define (-reftex-slug-trim-leading s)
  (if (and (> (string-length s) 0) (string-prefix? "-" s))
      (-reftex-slug-trim-leading (substring s 1 (string-length s)))
      s))

(define (-reftex-slug-trim-trailing s)
  (let ((n (string-length s)))
    (if (and (> n 0) (string-suffix? "-" s))
        (-reftex-slug-trim-trailing (substring s 0 (- n 1)))
        s)))

;; --- pure: prefix / macro lookups -------------------------------------

(define (-reftex-assq-default key alist default)
  "The cdr of the first (key . v) pair in ALIST whose car `eq?`s KEY, or
   DEFAULT. (`assq` over a keyword-keyed alist.)"
  (cond
    ((nil? alist) default)
    ((eq? (car (car alist)) key) (cdr (car alist)))
    (else (-reftex-assq-default key (cdr alist) default))))

(define (-reftex-prefix-for-type type)
  "The label-key prefix for TYPE from `*reftex-label-prefixes*`, falling
   back to `*reftex-label-default-prefix*`."
  (-reftex-assq-default type *reftex-label-prefixes*
                        *reftex-label-default-prefix*))

(define (-reftex-macro-for-type type)
  "The reference macro for TYPE from `*reftex-ref-macro-by-type*`, falling
   back to `*reftex-ref-macro-default*`."
  (-reftex-assq-default type *reftex-ref-macro-by-type*
                        *reftex-ref-macro-default*))

;; --- pure: uniquify ---------------------------------------------------

(define (-reftex-uniquify key taken)
  "KEY made unique against the list of TAKEN names: KEY itself when free,
   else KEY-2, KEY-3, … for the first free suffix. PURE."
  (if (-reftex-member? key taken)
      (-reftex-uniquify-loop key taken 2)
      key))

(define (-reftex-uniquify-loop key taken n)
  (let ((candidate (str key "-" (number->string n))))
    (if (-reftex-member? candidate taken)
        (-reftex-uniquify-loop key taken (+ n 1))
        candidate)))

;; --- pure: suggest a key ----------------------------------------------

(define (-reftex-suggest-key text offset taken)
  "Suggest a unique label KEY for a label inserted at OFFSET in TEXT,
   against the TAKEN name list. Composes type-at-point -> prefix + slug of
   the nearest caption/section stem, uniquified. PURE — everything it
   needs is in TEXT (it derives the stem by scanning) plus TAKEN."
  (let* ((type (-reftex-type-at-point text offset))
         (prefix (-reftex-prefix-for-type type))
         (stem (-reftex-stem-for text offset type)))
    (-reftex-uniquify (str prefix stem) taken)))

(define (-reftex-stem-for text offset type)
  "A slugified stem for the label at OFFSET: the nearest enclosing
   `\\caption{…}` (figures/tables) or `\\section`-family title, else the
   inferred type name, else \"label\". Numeric disambiguation is left to
   `-reftex-uniquify`."
  (let ((raw (-reftex-nearest-stem-text text offset type)))
    (if (or (nil? raw) (string=? (-reftex-slugify raw) ""))
        (-reftex-type-stem type)
        (-reftex-slugify raw))))

(define (-reftex-type-stem type)
  "A fallback stem when no caption/title is found: the type's own name
   (\"equation\", \"figure\", …) or \"label\" for a typeless label."
  (cond
    ((nil? type) "label")
    (else (keyword->string type))))

(define (-reftex-nearest-stem-text text offset type)
  "The raw stem text for a label at OFFSET: for a figure/table, the
   nearest `\\caption{…}` argument; for a section, the enclosing
   section title; else nil. Searches within the text only."
  (cond
    ((or (eq? type :figure) (eq? type :table))
     (-reftex-nearest-arg text offset "\\caption{"))
    ((eq? type :section)
     (-reftex-enclosing-section-title text offset))
    (else
     ;; A typeless label right after a sectioning line still gets the
     ;; section title as its stem.
     (if (-reftex-section-before? text offset)
         (-reftex-enclosing-section-title text offset)
         nil))))

(define (-reftex-nearest-arg text offset macro)
  "The `{…}` argument of the nearest occurrence of MACRO (e.g.
   \"\\caption{\") in TEXT, searching backward from OFFSET first, then
   forward. nil when MACRO is absent. The argument is the run up to the
   next `}`."
  (let ((back (-reftex-last-index-before text macro offset)))
    (if (>= back 0)
        (-reftex-arg-after text (+ back (string-length macro)))
        (let ((fwd (string-index-of text macro offset)))
          (if (< fwd 0)
              nil
              (-reftex-arg-after text (+ fwd (string-length macro))))))))

(define (-reftex-arg-after text start)
  "The run of characters from START up to the next `}`, or nil."
  (let ((close (string-index-of text "}" start)))
    (if (< close 0) nil (substring text start close))))

(define (-reftex-last-index-before text needle offset)
  "The index of the last occurrence of NEEDLE in TEXT that starts before
   OFFSET, or -1."
  (-reftex-last-index-loop text needle offset -1 0))

(define (-reftex-last-index-loop text needle offset best from)
  (let ((hit (string-index-of text needle from)))
    (cond
      ((< hit 0) best)
      ((>= hit offset) best)
      (else (-reftex-last-index-loop text needle offset hit (+ hit 1))))))

(define (-reftex-enclosing-section-title text offset)
  "The title of the sectioning command whose line is at OFFSET, or the
   nearest preceding sectioning command, or nil. Uses `latex-scan`'s
   section records (which carry line + title) and picks the last one at
   or before OFFSET's line."
  (let* ((line (-reftex-line-number-of text offset))
         (sections (get (latex-scan text) :sections nil)))
    (-reftex-section-title-at-or-before sections line nil)))

(define (-reftex-section-title-at-or-before sections line best)
  "The title of the last section in SECTIONS whose :line is <= LINE."
  (cond
    ((nil? sections) (if (nil? best) nil (get best :title nil)))
    ((<= (get (car sections) :line 0) line)
     (-reftex-section-title-at-or-before (cdr sections) line (car sections)))
    (else (if (nil? best) nil (get best :title nil)))))

(define (-reftex-line-number-of text offset)
  "The 1-based line number of OFFSET in TEXT (counting newlines before
   it). Matches `latex-scan`'s 1-based line numbering."
  (+ 1 (-reftex-count-newlines text 0 offset 0)))

(define (-reftex-count-newlines text i limit acc)
  (cond
    ((>= i limit) acc)
    ((>= i (string-length text)) acc)
    ((equal? (substring text i (+ i 1)) "\n")
     (-reftex-count-newlines text (+ i 1) limit (+ acc 1)))
    (else (-reftex-count-newlines text (+ i 1) limit acc))))

;; --- the reference-candidate model ------------------------------------

(define (reftex-ref-candidates)
  "The reference candidates for the current document: one record per
   label, `{:name :type :macro}`, where :macro is chosen from the label's
   :type via `*reftex-ref-macro-by-type*`. Document order. nil when no
   document/labels."
  (let ((labels (reftex-labels)))
    (if (nil? labels)
        nil
        (map (lambda (l)
               (hash-map :name (get l :name "")
                         :type (get l :type nil)
                         :macro (-reftex-macro-for-type (get l :type nil))))
             labels))))

(define (-reftex-macro-for-label name)
  "The reference macro for the label called NAME (looked up in the DB),
   falling back to `*reftex-ref-macro-default*` for an unknown name."
  (let ((rec (reftex-find-label name)))
    (if (nil? rec)
        *reftex-ref-macro-default*
        (-reftex-macro-for-type (get rec :type nil)))))

;; --- reftex-label (C-c () ---------------------------------------------

(define (-reftex-current-text)
  "The current buffer's text (the insert target is always the current
   buffer — R1's note: only the current buffer's text is exposed)."
  (buffer-text))

(defcommand reftex-label ()
  "Insert a `\\label{KEY}` at point with a smart, unique key. The type is
   inferred from the innermost enclosing LaTeX environment (equation /
   figure / table / listing / …) or a preceding sectioning command; the
   key is `<prefix><slug-of-caption-or-title>`, made unique against the
   document's existing labels. With `*reftex-label-confirm*` (the default)
   the suggested key is offered in the minibuffer for editing. Bound to
   C-c (."
  (let* ((text (-reftex-current-text))
         (offset (point))
         (taken (-reftex-label-taken-names))
         (suggested (-reftex-suggest-key text offset taken)))
    (if *reftex-label-confirm*
        (begin
          (open-completing-minibuffer! "Label: " suggested)
          (set! *minibuffer-reader*
                (lambda (key) (-reftex-label-deliver key taken))))
        (-reftex-insert-label suggested))))

(define (-reftex-label-taken-names)
  "The label names already in the document (for uniqueness), or the empty
   list when there is no document."
  (let ((names (reftex-label-names)))
    (if (nil? names) (list) names)))

(define (-reftex-label-deliver key taken)
  "Minibuffer submit handler for `reftex-label`: insert KEY (made unique
   once more against TAKEN, in case the user edited it to a clash). A
   cancelled prompt (nil) inserts nothing."
  (cond
    ((nil? key) nil)
    ((string=? key "") nil)
    (else (-reftex-insert-label (-reftex-uniquify key taken)))))

(define (-reftex-insert-label key)
  "Insert `\\label{KEY}` at point and echo it."
  (insert! (str "\\label{" key "}"))
  (show-status! (str "Inserted \\label{" key "}")))

;; --- reftex-reference: minibuffer fast-path (C-c ) prefix arg) --------
;; The originating view + point are captured before the minibuffer opens
;; (the minibuffer doesn't move the current buffer's point, but capturing
;; is explicit and shared with the select-view path). `insert!` targets
;; the current buffer at the saved point.

(define *reftex-ref-origin-view* nil)
(define *reftex-ref-origin-point* nil)

(define (-reftex-remember-origin)
  "Record the current view + point so a picker can insert back at the
   originating location."
  (set! *reftex-ref-origin-view* (current-view))
  (set! *reftex-ref-origin-point* (point)))

(define (-reftex-insert-ref-at-origin name)
  "Insert `<macro>{NAME}` at the remembered origin (view + point), the
   macro chosen by NAME's :type. Switches back to the origin view first
   when it isn't current, restores point, inserts."
  (let ((macro (-reftex-macro-for-label name))
        (view *reftex-ref-origin-view*)
        (pt *reftex-ref-origin-point*))
    (when (and (not (nil? view)) (not (eq? view (current-view))))
      (switch-to-view! view))
    (when (not (nil? pt)) (goto! pt))
    (insert! (str macro "{" name "}"))
    (show-status! (str "Inserted " macro "{" name "}"))))

(defcommand reftex-reference-minibuffer ()
  "Insert a `\\ref`/`\\eqref`/… to a label chosen in the minibuffer with
   TAB completion over the document's label names — the know-the-key
   fast-path. The macro is chosen by the label's type. `reftex-reference`
   (C-c )) uses the `*RefTeX Select*` view by default; this is the
   minibuffer alternative (and what runs when no document is available to
   populate the select view)."
  (let ((names (reftex-label-names)))
    (cond
      ((nil? names)
       (show-status! "RefTeX: no labels in this document"))
      (else
       (-reftex-remember-origin)
       (set! *reftex-tab-complete* -reftex-label-tab-complete)
       (open-completing-minibuffer! "Reference: " "")
       (set! *minibuffer-reader* -reftex-ref-deliver)))))

(define (-reftex-ref-deliver name)
  "Minibuffer submit handler for `reftex-reference-minibuffer`: insert a
   reference to label NAME at the origin. A cancelled / empty prompt
   inserts nothing. Always clears the label tab-complete hook so the next
   minibuffer prompt (find-file etc.) completes normally."
  (set! *reftex-tab-complete* nil)
  (cond
    ((nil? name) nil)
    ((string=? name "") nil)
    (else (-reftex-insert-ref-at-origin name))))

;; Tab-completion for the Reference: prompt. The host's onTab always calls
;; `minibuffer-tab-complete` (defined in files.lisp for find-file). To
;; complete over LABEL NAMES while the Reference: prompt is active, we add
;; a hook variable `*reftex-tab-complete*`: when set (a 1-arg lambda), the
;; redefinition of `minibuffer-tab-complete` below dispatches to it; when
;; nil it delegates to files.lisp's original handler. The original binding
;; is captured before the redefinition so find-file is unaffected. This
;; mirrors reftex.lisp's clean `latex-master-file` override — a later-loaded
;; redefinition that adds behaviour without editing the earlier file.

;; A 1-arg tab handler installed while the Reference: minibuffer is open,
;; or nil. `reftex-reference-minibuffer` sets it; `-reftex-ref-deliver`
;; clears it.
(define *reftex-tab-complete* nil)

;; Capture files.lisp's `minibuffer-tab-complete` so the redefinition can
;; delegate to it for non-RefTeX prompts (find-file).
(define -reftex-orig-tab-complete minibuffer-tab-complete)

(define (minibuffer-tab-complete current)
  "Dispatch TAB completion: when a RefTeX picker installed
   `*reftex-tab-complete*`, use it (completing over label names); else
   delegate to files.lisp's original find-file handler. Redefines the
   files.lisp function, loaded later — find-file's path is preserved via
   the captured `-reftex-orig-tab-complete`."
  (if (nil? *reftex-tab-complete*)
      (-reftex-orig-tab-complete current)
      (*reftex-tab-complete* current)))

(define (-reftex-label-tab-complete current)
  "TAB handler for the Reference: minibuffer — extend CURRENT to the
   longest common prefix of label names that start with it, or list the
   matches in the status line. Mirrors find-file's behaviour over the
   label-name set."
  (let* ((names (reftex-label-names))
         (matches (filter (lambda (n) (string-prefix? current n))
                          (if (nil? names) (list) names))))
    (cond
      ((nil? matches) (show-status! "(no matching labels)") current)
      ((nil? (cdr matches)) (clear-status!) (car matches))
      (else
       (let ((lcp (-reftex-fold-common-prefix matches)))
         (if (> (string-length lcp) (string-length current))
             (begin (clear-status!) lcp)
             (begin (show-status! (-reftex-join-labels matches)) current)))))))

(define (-reftex-fold-common-prefix items)
  (cond ((nil? items) "")
        ((nil? (cdr items)) (car items))
        (else (-reftex-fold-common-prefix
               (cons (-reftex-common-prefix (car items) (cadr items))
                     (cddr items))))))

(define (-reftex-common-prefix a b)
  (-reftex-common-prefix-loop a b 0))

(define (-reftex-common-prefix-loop a b i)
  (if (or (>= i (string-length a))
          (>= i (string-length b))
          (not (equal? (substring a i (+ i 1)) (substring b i (+ i 1)))))
      (substring a 0 i)
      (-reftex-common-prefix-loop a b (+ i 1))))

(define (-reftex-join-labels names)
  (cond ((nil? names) "")
        ((nil? (cdr names)) (car names))
        (else (str (car names) "  " (-reftex-join-labels (cdr names))))))

;; --- keybindings ------------------------------------------------------
;; Extend the C-c prefix map further (latex.lisp built it, latex-compile
;; and reftex added to it). The `(` and `)` punctuation slots are the
;; RefTeX label/reference bindings (plans/RefTeX.md keybinding table).
;; `assoc` returns a new map; we re-install it under "C-c".
;;
;; reftex-reference is wired in Part B (the select-view command); until
;; then `)` is bound to the minibuffer fast-path so both pickers reach an
;; insertion. Part B rebinds `)` to the select-first `reftex-reference`.

(set! latex-c-c-map
  (assoc (assoc latex-c-c-map "(" 'reftex-label)
         ")" 'reftex-reference-minibuffer))

(set! latex-mode-map {"C-c" latex-c-c-map})
