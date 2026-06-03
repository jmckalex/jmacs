;;; reftex.lisp — RefTeX R1: the multi-file document model + DB.
;;;
;;; This is Phase R1 of plans/RefTeX.md. It builds the *document model*
;;; the RefTeX pickers (R2, a later task) query: master-file detection,
;;; transitive `\input`/`\include` resolution, a unified cross-file
;;; database (labels / sections / refs / cites / index / inputs / bib),
;;; caching, and a single `reftex-reparse` command. No pickers, no
;;; views, no keybindings beyond `reftex-reparse` (M-x only — R2 wires
;;; the `C-c` RefTeX map).
;;;
;;; Loaded AFTER latex-compile.lisp so the redefinition of
;;; `latex-master-file` at the bottom overrides cleanly (latex-compile's
;;; R1 NOTE seam). latex-compile.lisp is NOT edited.
;;;
;;; ## Design
;;;
;;; The whole engine is Lisp over the pure host primitives `latex-scan`,
;;; `path-resolve`, `path-dirname`, `path-basename` (latex-primitives.js)
;;; plus the impure I/O primitives `read-file-text!`, `file-exists?`,
;;; and the view primitives (`view-list`, `view-file-path`, `view-buffer`,
;;; `buffer-text`, `current-view`). To stay unit-testable, the document
;;; builder is split into:
;;;
;;;   * a PURE core, `-reftex-build-db`, parameterised by a `read-fn`
;;;     (path -> text-or-nil) and an `exists-fn` (path -> #t/#f). It does
;;;     all master-relative resolution, cycle-guarding, scanning, tagging
;;;     and merging without touching the real filesystem or views; and
;;;   * a thin IMPURE wrapper, `reftex-document`, that supplies the real
;;;     `read-fn`/`exists-fn` (preferring open-buffer text for files that
;;;     are on screen) and caches the result.
;;;
;;; The pure core is exercised directly from `reftex-db.test.js` with
;;; in-memory fixture maps.

;; --- user-facing settings ---------------------------------------------

(defgroup 'reftex 'jmacs "RefTeX: multi-file references, labels, TOC.")

;; Explicit master-file override. Empty string = auto-detect via the
;; ladder in `reftex-master`. A relative path is resolved against the
;; current file's directory. This is the deferred answer to RefTeX.md
;; open-question #2 (master ambiguity): rather than an interactive
;; prompt (a follow-up tied to that question), the user pins the master
;; with this setting or with a `% !TEX root = …` magic comment.
(defcustom *reftex-master* ""
  :string
  :group 'reftex
  :doc "Explicit master .tex path for RefTeX, overriding auto-detection.
   Empty (the default) means auto-detect: `% !TEX root` magic comment,
   then `\\documentclass`, then who-includes-me, then the current file
   itself. A relative value is resolved against the current file's
   directory. An interactive master prompt (RefTeX.md open-question #2)
   is a follow-up; until then pin the master here or with `% !TEX root`.")

;; Prefix -> type table for label `:type` inference (RefTeX.md's labels
;; table). The car is the label-name prefix (with its colon), the cdr
;; the inferred type keyword.
(define *reftex-label-prefix-types*
  (list (cons "eq:" :equation)
        (cons "fig:" :figure)
        (cons "tab:" :table)
        (cons "sec:" :section)
        (cons "lst:" :listing)
        (cons "chap:" :section)
        (cons "thm:" :theorem)
        (cons "def:" :definition)))

;; Environment -> type table, used when the label name carries no
;; recognised prefix. The car is the enclosing environment name (as the
;; scanner reports it, sans a trailing `*`), the cdr the inferred type.
(define *reftex-env-types*
  (list (cons "equation" :equation)
        (cons "align" :equation)
        (cons "gather" :equation)
        (cons "multline" :equation)
        (cons "eqnarray" :equation)
        (cons "figure" :figure)
        (cons "subfigure" :figure)
        (cons "table" :table)
        (cons "longtable" :table)
        (cons "lstlisting" :listing)
        (cons "listing" :listing)
        (cons "verbatim" :listing)
        (cons "theorem" :theorem)
        (cons "lemma" :theorem)
        (cons "definition" :definition)))

;; --- the DB cache -----------------------------------------------------
;; A hash-map keyed by master absolute path -> the built DB. `reftex-db`
;; / `reftex-document` return the cached entry if present (refreshing the
;; current buffer's slice live — see the freshness note on
;; `reftex-document`); `reftex-reparse` clears it.

(define *reftex-db-cache* {})

;; --- small helpers ----------------------------------------------------

(define (-reftex-tex-file? path)
  "Whether PATH names a .tex file."
  (and (string? path) (string-suffix? ".tex" path)))

(define (-reftex-ensure-tex path)
  "Append `.tex` to PATH when it has no extension. A path that already
   ends in `.tex` (or carries some other extension via a `.` in its
   basename) is returned unchanged."
  (let ((base (path-basename path)))
    (if (>= (string-index-of base ".") 0)
        path
        (str path ".tex"))))

(define (-reftex-strip-star name)
  "Drop a trailing `*` from an environment NAME (`align*` -> `align`)."
  (if (and (> (string-length name) 0)
           (string-suffix? "*" name))
      (substring name 0 (- (string-length name) 1))
      name))

;; --- label :type inference --------------------------------------------

(define (-reftex-type-by-prefix name table)
  "Walk TABLE (a list of (prefix . type)); return the type whose prefix
   NAME starts with, or nil. Tail-recursive (no named let)."
  (cond ((nil? table) nil)
        ((string-prefix? (car (car table)) name) (cdr (car table)))
        (else (-reftex-type-by-prefix name (cdr table)))))

(define (-reftex-type-by-env env table)
  "Walk TABLE (a list of (env . type)); return the type whose env name
   equals ENV, or nil."
  (cond ((nil? table) nil)
        ((nil? env) nil)
        ((string=? (car (car table)) env) (cdr (car table)))
        (else (-reftex-type-by-env env (cdr table)))))

(define (-reftex-label-type name env)
  "Infer a label's :type from its NAME prefix first (eq:->equation,
   fig:->figure, …), then from its enclosing ENV (display-math env
   ->equation, figure->figure, …). Returns nil when neither matches —
   an unprefixed label in no recognised environment has no type."
  (let ((by-prefix (-reftex-type-by-prefix name *reftex-label-prefix-types*)))
    (if (not (nil? by-prefix))
        by-prefix
        (-reftex-type-by-env (if (nil? env) nil (-reftex-strip-star env))
                             *reftex-env-types*))))

;; --- master detection (pure helpers over scanned text) ----------------

(define (-reftex-tex-root-comment text)
  "Extract the path X from a `% !TEX root = X` magic comment in TEXT, or
   nil. Tolerant of the TeXShop / TeXworks / VS Code spellings: case in
   `TEX root` is ignored and surrounding whitespace is trimmed. Only the
   first line carrying the directive is honoured."
  (-reftex-tex-root-scan (string-split text "\n")))

(define (-reftex-tex-root-scan lines)
  (cond
    ((nil? lines) nil)
    (else
     (let ((hit (-reftex-tex-root-of-line (car lines))))
       (if (not (nil? hit)) hit (-reftex-tex-root-scan (cdr lines)))))))

(define (-reftex-tex-root-of-line line)
  "If LINE is a `% !TEX root = X` directive, return X (trimmed); else nil.
   Matches `%` (any leading whitespace) then `!TEX root` (any case) then
   `=` or `:` then the path. Hand-rolled because the dialect has no regex
   value type at this layer; case-folds the whole line to find the marker
   but slices the path from the original to preserve its case."
  (let* ((lower (string-downcase line))
         (marker-at (-reftex-find-tex-root-marker lower)))
    (if (< marker-at 0)
        nil
        ;; The path starts after the `root` token plus an `=`/`:` and any
        ;; spaces. Find the `=` or `:` after the marker, then trim.
        (let* ((after (+ marker-at 9)) ; length of "!tex root"
               (sep (-reftex-sep-index lower after)))
          (if (< sep 0)
              nil
              (-reftex-trim (substring line (+ sep 1) (string-length line))))))))

(define (-reftex-find-tex-root-marker lower)
  "The index of `!tex root` in the (already lower-cased) LOWER, or -1.
   Accepts one or more spaces between `!tex` and `root` only in the
   common single-space form; the directive is conventionally `!TEX root`."
  (let ((i (string-index-of lower "!tex root")))
    i))

(define (-reftex-sep-index lower from)
  "The index at/after FROM of the first `=` or `:` in LOWER, or -1."
  (let ((eq (string-index-of lower "=" from))
        (co (string-index-of lower ":" from)))
    (cond ((< eq 0) co)
          ((< co 0) eq)
          ((< eq co) eq)
          (else co))))

(define (-reftex-trim s)
  "Strip leading and trailing spaces / tabs / carriage returns from S."
  (-reftex-trim-trailing (-reftex-trim-leading s)))

(define (-reftex-trim-leading s)
  (cond ((equal? s "") s)
        ((-reftex-space-char? (substring s 0 1))
         (-reftex-trim-leading (substring s 1 (string-length s))))
        (else s)))

(define (-reftex-trim-trailing s)
  (let ((n (string-length s)))
    (cond ((= n 0) s)
          ((-reftex-space-char? (substring s (- n 1) n))
           (-reftex-trim-trailing (substring s 0 (- n 1))))
          (else s))))

(define (-reftex-space-char? c)
  (or (equal? c " ") (equal? c "\t") (equal? c "\r")))

(define (-reftex-has-documentclass? text)
  "Whether TEXT declares a `\\documentclass`."
  (and (string? text) (string-contains? text "\\documentclass")))

;; --- transitive file resolution (pure) --------------------------------

(define (-reftex-resolve-input including-file path)
  "Resolve an `\\input`/`\\include` PATH (as written) against the
   directory of INCLUDING-FILE, appending `.tex` when it has no
   extension. Returns an absolute (normalised) path."
  (-reftex-ensure-tex
   (path-resolve (path-dirname including-file) path)))

(define (-reftex-input-paths text including-file)
  "The resolved absolute target paths of every `\\input`/`\\include`/
   `\\subfile`/`\\import` in TEXT, in document order, each resolved
   against INCLUDING-FILE's directory."
  (map (lambda (rec)
         (-reftex-resolve-input including-file (get rec :path "")))
       (get (latex-scan text) :inputs nil)))

;; --- the pure DB builder ----------------------------------------------
;; Walk the inclusion tree depth-first from MASTER, scanning each file's
;; text (via READ-FN) once, tagging every record with its absolute :file,
;; and accumulating the merged tables. Guards against cycles and skips
;; inputs whose resolved target does not exist (per EXISTS-FN), recording
;; the missing paths in :missing rather than crashing.

(define (-reftex-build-db read-fn exists-fn master)
  "Build the document DB rooted at MASTER (an absolute .tex path), using
   READ-FN (path -> text-or-nil) for file contents and EXISTS-FN
   (path -> #t/#f) for input existence. PURE: no host I/O, no views —
   all effects are confined to the two injected functions. Returns the
   DB hash-map (see `reftex-document` for the shape)."
  (let* ((acc (-reftex-fresh-acc master))
         (filled (-reftex-scan-file read-fn exists-fn master acc)))
    (-reftex-finish-db master filled)))

(define (-reftex-fresh-acc master)
  "A mutable accumulator (a hash-map of reversed-list cells) for the
   build walk. Stored as single-element vectors so the recursion can
   push without threading state — the dialect's lists are immutable, so
   we accumulate in boxes and reverse at the end."
  (hash-map
   :visited (list)        ; absolute paths already scanned (cycle guard)
   :files (list)          ; files in document order (reversed)
   :labels (list)
   :sections (list)
   :refs (list)
   :cites (list)
   :index (list)
   :inputs (list)
   :bib (list)
   :missing (list)))

;; Because the dialect's hash-maps are immutable (assoc returns a copy),
;; the walk threads the accumulator functionally: each step returns the
;; updated acc. We implement the depth-first walk as a fold.

(define (-reftex-scan-file read-fn exists-fn file acc)
  "Scan FILE into ACC (returning the updated acc), then recurse into its
   inputs in document order. Cycle-guarded on :visited. A FILE whose text
   READ-FN returns nil is still marked visited and added to :files (so it
   appears in document order) but contributes no records."
  (if (-reftex-member? file (get acc :visited nil))
      acc
      (let* ((acc1 (-reftex-mark-visited file acc))
             (text (read-fn file)))
        (if (nil? text)
            acc1
            (let* ((scan (latex-scan text))
                   (acc2 (-reftex-absorb-scan file scan acc1)))
              (-reftex-recurse-inputs read-fn exists-fn file scan acc2))))))

(define (-reftex-mark-visited file acc)
  (assoc (assoc acc :visited (cons file (get acc :visited nil)))
         :files (cons file (get acc :files nil))))

(define (-reftex-absorb-scan file scan acc)
  "Tag every record in SCAN with FILE and prepend it to the matching
   reversed list in ACC. Labels additionally gain an inferred :type."
  (let* ((labels (map (lambda (r) (-reftex-tag-label file r))
                      (get scan :labels nil)))
         (sections (map (lambda (r) (-reftex-tag file r))
                        (get scan :sections nil)))
         (refs (map (lambda (r) (-reftex-tag file r))
                    (get scan :refs nil)))
         (cites (map (lambda (r) (-reftex-tag file r))
                     (get scan :cites nil)))
         (index (map (lambda (r) (-reftex-tag file r))
                     (get scan :index nil)))
         (inputs (map (lambda (r) (-reftex-tag file r))
                      (get scan :inputs nil)))
         (bib (map (lambda (r) (-reftex-tag file r))
                   (get scan :bib nil))))
    (assoc
     (assoc
      (assoc
       (assoc
        (assoc
         (assoc
          (assoc acc :labels (-reftex-prepend-all labels (get acc :labels nil)))
          :sections (-reftex-prepend-all sections (get acc :sections nil)))
         :refs (-reftex-prepend-all refs (get acc :refs nil)))
        :cites (-reftex-prepend-all cites (get acc :cites nil)))
       :index (-reftex-prepend-all index (get acc :index nil)))
      :inputs (-reftex-prepend-all inputs (get acc :inputs nil)))
     :bib (-reftex-prepend-all bib (get acc :bib nil)))))

(define (-reftex-tag file rec)
  "Return REC with an absolute :file slot added."
  (assoc rec :file file))

(define (-reftex-tag-label file rec)
  "Tag a label record with :file and an inferred :type."
  (assoc (assoc rec :file file)
         :type (-reftex-label-type (get rec :name "")
                                   (get rec :env nil))))

(define (-reftex-prepend-all items lst)
  "Prepend ITEMS (a list) onto LST in order, so that after the whole
   walk a final reverse yields document order. Folds left: each item is
   consed, leaving the list reversed overall."
  (cond ((nil? items) lst)
        (else (-reftex-prepend-all (cdr items) (cons (car items) lst)))))

(define (-reftex-recurse-inputs read-fn exists-fn file scan acc)
  "Recurse into FILE's `\\input` children in document order, accumulating
   into ACC. A child whose resolved target does not exist is recorded in
   :missing and skipped (not scanned)."
  (-reftex-recurse-loop read-fn exists-fn file
                        (get scan :inputs nil) acc))

(define (-reftex-recurse-loop read-fn exists-fn file inputs acc)
  (cond
    ((nil? inputs) acc)
    (else
     (let* ((rec (car inputs))
            (target (-reftex-resolve-input file (get rec :path ""))))
       (if (exists-fn target)
           (-reftex-recurse-loop
            read-fn exists-fn file (cdr inputs)
            (-reftex-scan-file read-fn exists-fn target acc))
           (-reftex-recurse-loop
            read-fn exists-fn file (cdr inputs)
            (assoc acc :missing
                   (cons target (get acc :missing nil)))))))))

(define (-reftex-finish-db master acc)
  "Turn the reversed accumulator into the public DB hash-map, reversing
   every table back into document order and adding the bib path list."
  (hash-map
   :master master
   :files (reverse (get acc :files nil))
   :labels (reverse (get acc :labels nil))
   :sections (reverse (get acc :sections nil))
   :refs (reverse (get acc :refs nil))
   :cites (reverse (get acc :cites nil))
   :index (reverse (get acc :index nil))
   :inputs (reverse (get acc :inputs nil))
   :bib (-reftex-collect-bib-paths (reverse (get acc :bib nil)))
   :missing (reverse (get acc :missing nil))))

(define (-reftex-collect-bib-paths bib-records)
  "Flatten the :paths of every bib record into one list of bib paths,
   then append `*citation-bib-path*` when it is set and not already
   present. The result is the document's bibliography source list."
  (let ((from-doc (-reftex-flatten
                   (map (lambda (r) (get r :paths nil)) bib-records))))
    (if (or (nil? *citation-bib-path*)
            (string=? *citation-bib-path* "")
            (-reftex-member? *citation-bib-path* from-doc))
        from-doc
        (append from-doc (list *citation-bib-path*)))))

(define (-reftex-flatten lists)
  "Concatenate a list of lists into one list."
  (cond ((nil? lists) nil)
        (else (append (car lists) (-reftex-flatten (cdr lists))))))

(define (-reftex-member? x lst)
  "Whether X (compared with equal?) is in LST."
  (cond ((nil? lst) #f)
        ((equal? x (car lst)) #t)
        (else (-reftex-member? x (cdr lst)))))

;; --- master detection (impure: reads the current view + files) --------

(define (-reftex-current-file)
  "The current view's file path, or nil when it has none."
  (let ((v (current-view)))
    (if (nil? v) nil (view-file-path v))))

(define (-reftex-find-view-for-file path)
  "An open view whose file path equals PATH, or nil."
  (-reftex-find-view-loop (view-list) path))

(define (-reftex-find-view-loop views path)
  (cond ((nil? views) nil)
        ((equal? (view-file-path (car views)) path) (car views))
        (else (-reftex-find-view-loop (cdr views) path))))

(define (-reftex-text-for-file file current)
  "Text for FILE: when FILE is the CURRENT file, read the live buffer
   (`buffer-text`); otherwise read the file from disk (`read-file-text!`).
   Returns nil when the file can't be read.

   NOTE: the host exposes only the *current* buffer's text to Lisp
   (`buffer-text`), not an arbitrary view's buffer text. So an OTHER file
   that is open in a buffer is read from disk, not from its (possibly
   dirty) buffer. R2 / a host primitive (`buffer-text-of`) could refine
   this later; for R1 the current buffer is always live, which covers the
   file the user is editing."
  (if (and (not (nil? current)) (equal? file current))
      (buffer-text)
      (read-file-text! file)))

(define (reftex-master)
  "The absolute path of the document's master .tex for the current view,
   or nil when the current view has no .tex file. Detection ladder:

     1. `*reftex-master*` override (resolved relative to the current
        file's dir when relative) — the deferred answer to RefTeX.md
        open-question #2.
     2. A `% !TEX root = X` magic comment in the current file.
     3. The current file itself, when it has a `\\documentclass`.
     4. Who-includes-me: a sibling/parent .tex that `\\input`s this file
        (single unambiguous hit), preferring one with `\\documentclass`.
     5. Fallback: the current file is its own master."
  (let ((current (-reftex-current-file)))
    (cond
      ((nil? current) nil)
      ((not (-reftex-tex-file? current)) nil)
      (else
       (let ((override (-reftex-master-override current)))
         (if (not (nil? override))
             override
             (-reftex-detect-master current)))))))

(define (-reftex-master-override current)
  "The `*reftex-master*` setting resolved for CURRENT, or nil when it is
   unset. A relative override is taken relative to CURRENT's directory;
   `.tex` is appended when missing."
  (if (or (nil? *reftex-master*) (string=? *reftex-master* ""))
      nil
      (-reftex-ensure-tex
       (path-resolve (path-dirname current) *reftex-master*))))

(define (-reftex-detect-master current)
  "Steps 2-5 of the ladder for CURRENT (already known to be a .tex). The
   dialect's `cond` has no `=>` arrow form, so each candidate is bound
   and tested for nil explicitly."
  (let* ((text (-reftex-text-for-file current current))
         (from-comment (-reftex-master-from-comment current text)))
    (cond
      ;; 2. magic comment
      ((not (nil? from-comment)) from-comment)
      ;; 3. self has \documentclass
      ((-reftex-has-documentclass? text) current)
      ;; 4. who-includes-me (single unambiguous hit)
      (else
       (let ((from-includers (-reftex-master-from-includers current)))
         ;; 5. fallback: self
         (if (nil? from-includers) current from-includers))))))

(define (-reftex-master-from-comment current text)
  "Resolve a `% !TEX root` directive in TEXT against CURRENT's dir, or
   nil when there is none. The result has `.tex` appended when missing."
  (if (nil? text)
      nil
      (let ((root (-reftex-tex-root-comment text)))
        (if (or (nil? root) (string=? root ""))
            nil
            (-reftex-ensure-tex
             (path-resolve (path-dirname current) root))))))

(define (-reftex-sibling-dirs current)
  "The directories to search for an includer of CURRENT: its own
   directory and one level up."
  (let* ((dir (path-dirname current))
         (up (path-dirname dir)))
    (if (string=? dir up) (list dir) (list dir up))))

(define (-reftex-tex-siblings dir current)
  "The absolute paths of `.tex` files in DIR other than CURRENT, using
   `list-directory-paths`. Returns nil when DIR can't be listed."
  (let ((entries (list-directory-paths dir)))
    (if (nil? entries)
        nil
        (-reftex-tex-sibling-paths dir current entries))))

(define (-reftex-tex-sibling-paths dir current entries)
  (cond
    ((nil? entries) nil)
    (else
     (let* ((entry (car entries))
            (name (if (pair? entry) (car entry) entry))
            (full (path-resolve dir name)))
       (if (and (-reftex-tex-file? name) (not (equal? full current)))
           (cons full (-reftex-tex-sibling-paths dir current (cdr entries)))
           (-reftex-tex-sibling-paths dir current (cdr entries)))))))

(define (-reftex-includes-file? candidate current)
  "Whether CANDIDATE (a .tex path) `\\input`s CURRENT, resolved against
   CANDIDATE's directory. Reads CANDIDATE from disk."
  (let ((text (read-file-text! candidate)))
    (if (nil? text)
        #f
        (-reftex-member? current
                         (-reftex-input-paths text candidate)))))

(define (-reftex-master-from-includers current)
  "Find a single unambiguous .tex among CURRENT's siblings/parents that
   `\\input`s CURRENT (preferring one that also has `\\documentclass`),
   or nil when there is none or it is ambiguous."
  (let ((includers (-reftex-collect-includers current)))
    (if (nil? includers)
        nil
        ;; Prefer an includer that itself has \documentclass (the real
        ;; root); else a single includer of any kind.
        (let ((rooted (-reftex-single
                       (filter -reftex-has-documentclass-file? includers))))
          (if (not (nil? rooted))
              rooted
              (-reftex-single includers))))))

(define (-reftex-has-documentclass-file? path)
  (-reftex-has-documentclass? (read-file-text! path)))

(define (-reftex-single lst)
  "The sole element of LST when it has exactly one, else nil."
  (if (and (pair? lst) (nil? (cdr lst))) (car lst) nil))

(define (-reftex-collect-includers current)
  "Every sibling/parent .tex that `\\input`s CURRENT, de-duplicated."
  (-reftex-dedup
   (filter (lambda (cand) (-reftex-includes-file? cand current))
           (-reftex-flatten
            (map (lambda (dir) (-reftex-tex-siblings dir current))
                 (-reftex-sibling-dirs current))))))

(define (-reftex-dedup lst)
  "LST with later duplicates (by equal?) removed."
  (cond ((nil? lst) nil)
        ((-reftex-member? (car lst) (cdr lst))
         (-reftex-dedup (cdr lst)))
        (else (cons (car lst) (-reftex-dedup (cdr lst))))))

;; --- transitive file list (public) ------------------------------------

(define (reftex-document-files master)
  "The absolute paths of every file in the document rooted at MASTER, in
   document (inclusion, depth-first) order, master first. Resolves
   `\\input`/`\\include`/`\\subfile`/`\\import` against each including
   file's dir, appends `.tex`, checks existence, guards cycles, and skips
   (without crashing) inputs whose target is absent."
  (get (-reftex-build-db -reftex-read-file -reftex-file-exists? master)
       :files nil))

;; --- the impure I/O the wrapper injects -------------------------------

(define (-reftex-file-exists? path)
  "EXISTS-FN for the real build: the current buffer's own file always
   counts as present even if unsaved; otherwise consult `file-exists?`."
  (let ((current (-reftex-current-file)))
    (if (and (not (nil? current)) (equal? path current))
        #t
        (file-exists? path))))

(define (-reftex-read-file path)
  "READ-FN for the real build: live buffer text for the current file,
   else `read-file-text!`."
  (-reftex-text-for-file path (-reftex-current-file)))

;; --- the public DB (cached) -------------------------------------------

(define (reftex-document)
  "Build (or return the cached) RefTeX DB for the current document and
   return it as a hash-map:

     {:master    absolute master .tex path
      :files     [absolute path]            ; document order, master first
      :labels    [{:name :line :col :env :file :type}]
      :sections  [{:level :title :line :col :file}]
      :refs      [{:name :macro :line :file}]
      :cites     [{:keys :macro :line :file}]
      :index     [{:entry :line :file}]
      :inputs    [{:kind :path :line :file}]
      :bib       [bib-path …]               ; doc \\bibliography + *citation-bib-path*
      :missing   [absolute path]}           ; \\input targets that don't exist

   Caching/freshness: the DB is cached by master path in
   `*reftex-db-cache*`. The CURRENT buffer's slice is always rebuilt live
   (the build's READ-FN reads `buffer-text` for the current file), so the
   file the user is typing in is never stale. Other files are read from
   disk at build time; their cached records persist until `reftex-reparse`.
   Per-edit auto-invalidation of other files is a noted follow-up — for
   R1, `reftex-reparse` (RefTeX's `r`/`g`) is the explicit refresh.

   Returns nil when the current view has no master (no .tex)."
  (let ((master (reftex-master)))
    (if (nil? master)
        nil
        (-reftex-document-for master))))

(define (-reftex-document-for master)
  "The DB for MASTER. Rebuilds when the current file is part of the
   document (so live edits to it are reflected) or when nothing is
   cached; otherwise returns the cached DB."
  (let ((cached (get *reftex-db-cache* master nil))
        (current (-reftex-current-file)))
    (if (and (not (nil? cached))
             (not (-reftex-current-in-files? current cached)))
        cached
        (let ((db (-reftex-build-db -reftex-read-file
                                    -reftex-file-exists? master)))
          (set! *reftex-db-cache* (assoc *reftex-db-cache* master db))
          db))))

(define (-reftex-current-in-files? current db)
  "Whether the CURRENT file is among DB's :files (so a live rescan is
   warranted). A nil current is never a member."
  (and (not (nil? current))
       (-reftex-member? current (get db :files nil))))

(define (reftex-db)
  "Alias for `reftex-document` — the current document's DB hash-map."
  (reftex-document))

;; --- query accessors (the thin surface R2 calls) ----------------------

(define (reftex-labels . type)
  "The document's label records, optionally filtered to those whose
   :type matches the single optional TYPE keyword. Returns nil when no
   document (no master). Document order."
  (let ((db (reftex-document)))
    (if (nil? db)
        nil
        (let ((labels (get db :labels nil)))
          (if (nil? type)
              labels
              (filter (lambda (l) (eq? (get l :type nil) (car type)))
                      labels))))))

(define (reftex-sections)
  "The document's section records in document order (the TOC), or nil."
  (let ((db (reftex-document)))
    (if (nil? db) nil (get db :sections nil))))

(define (reftex-label-names)
  "Just the label names (for completion), or nil."
  (let ((labels (reftex-labels)))
    (if (nil? labels) nil (map (lambda (l) (get l :name "")) labels))))

(define (reftex-find-label name)
  "The label record for NAME, or nil when there is none."
  (-reftex-find-label-loop (reftex-labels) name))

(define (-reftex-find-label-loop labels name)
  (cond ((nil? labels) nil)
        ((string=? (get (car labels) :name "") name) (car labels))
        (else (-reftex-find-label-loop (cdr labels) name))))

(define (reftex-cite-keys)
  "The citation keys available to the document: parse the first existing
   bib path (document `\\bibliography`/`\\addbibresource` then
   `*citation-bib-path*`) and return its `citation-keys`. Returns nil
   when no document or no readable bib."
  (let ((db (reftex-document)))
    (if (nil? db)
        nil
        (-reftex-cite-keys-from (-reftex-bib-abs-paths db)))))

(define (-reftex-bib-abs-paths db)
  "DB's bib paths resolved to absolute paths against the master's dir.
   A bib entry with no extension gets `.bib` appended; an entry that
   already names a file is left as written (resolved)."
  (let ((dir (path-dirname (get db :master ""))))
    (map (lambda (p) (-reftex-resolve-bib dir p)) (get db :bib nil))))

(define (-reftex-resolve-bib dir p)
  "Resolve a bib path P against DIR, appending `.bib` when it has no
   extension."
  (let* ((resolved (path-resolve dir p))
         (base (path-basename resolved)))
    (if (>= (string-index-of base ".") 0)
        resolved
        (str resolved ".bib"))))

(define (-reftex-cite-keys-from paths)
  "Parse the first PATH that exists and reads, returning its
   `citation-keys`; nil when none work."
  (cond
    ((nil? paths) nil)
    ((file-exists? (car paths))
     (let ((text (read-file-text! (car paths))))
       (if (nil? text)
           (-reftex-cite-keys-from (cdr paths))
           (citation-keys (citation-parse text)))))
    (else (-reftex-cite-keys-from (cdr paths)))))

;; --- reparse command --------------------------------------------------

(defcommand reftex-reparse ()
  "Clear the RefTeX DB cache and rebuild the current document's DB,
   echoing how many files and labels were scanned. The only command R1
   adds (M-x only — R2 wires the `C-c` RefTeX map). RefTeX's `r`/`g`."
  (set! *reftex-db-cache* {})
  (let ((db (reftex-document)))
    (if (nil? db)
        (show-status! "RefTeX: no master file for this view")
        (show-status!
         (str "RefTeX: scanned " (length (get db :files nil)) " file"
              (if (= (length (get db :files nil)) 1) "" "s")
              ", " (length (get db :labels nil)) " label"
              (if (= (length (get db :labels nil)) 1) "" "s"))))))

;; --- master-file seam integration (Phase 1) ---------------------------
;; Redefine latex-compile.lisp's `latex-master-file` to consult RefTeX's
;; master detection, so `latex-compile` / `latex-view` build/view the
;; MASTER, not just the current file. The contract (() -> path-or-nil) is
;; preserved. latex-compile.lisp is NOT edited — this redefinition, loaded
;; after it, overrides cleanly.

(define (latex-master-file)
  "The .tex file the LaTeX build should compile: the RefTeX-detected
   master for the current view (`reftex-master`), or nil when the view
   has no .tex. Redefines latex-compile.lisp's Phase-1 stub so the
   compile/view loop follows the master across a multi-file document."
  (reftex-master))
