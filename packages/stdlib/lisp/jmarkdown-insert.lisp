;;; jmarkdown-insert.lisp — AUCTeX-style smart insertion for jmarkdown-mode.
;;;
;;; The daily-authoring layer: completing insertion of @begin environments,
;;; ::: directives and headings, plus templated inserts for every rich
;;; JMarkdown construct (floats, tables, code, math, alerts, diagrams,
;;; lists, collection markers, anchors, comments, extension skeletons). A
;;; faithful port of the latex-insert.lisp machinery — the completing
;;; minibuffer + TAB hook-chaining + NUL-sentinel templates + region
;;; capture — retargeted at JMarkdown syntax. All Lisp over existing
;;; primitives; no new host primitives.
;;;
;;; A TOP-LEVEL stdlib file (loaded before the languages/ glob): it defines
;;; commands, defcustoms and the shared completion machinery, but does NOT
;;; touch jmarkdown-mode-map — the keybindings live in languages/jmarkdown.lisp
;;; (loaded last). The completion machinery here (the `*jmarkdown-insert-*`
;;; globals + the `minibuffer-tab-complete` chaining) is ALSO reused by
;;; jmarkdown-ref.lisp (loaded after this file).
;;;
;;; Loaded after jmarkdown-compile.lisp (shares its `jmarkdown` group).

;; --- candidate lists (defcustoms merged with buffer scans) ------------

(defcustom *jmarkdown-environments*
  '("theorem" "lemma" "corollary" "proposition" "definition" "example"
    "remark" "proof" "equation" "figure" "subfigure" "table" "listing"
    "game" "abstract" "feedback" "comment" "TeX" "HTML")
  :list
  :group 'jmarkdown
  :doc "Candidate `@begin(NAME)` environment names offered by
   `jmarkdown-insert-environment` (C-c C-e), merged with the `@begin(…)`
   names already used in the buffer. Floats/theorems/equation get a
   caption/id template; the rest a plain body.")

(defcustom *jmarkdown-directives*
  '("note" "aside" "abstract" "feedback" "TeX" "HTML" "mermaid" "TiKZ"
    "game" "comment" "markdown-demo" "target" "source" "section" "figure")
  :list
  :group 'jmarkdown
  :doc "Candidate `:::NAME` container-directive names offered by
   `jmarkdown-insert-directive` (C-c C-m), merged with the `:::` names
   already used in the buffer.")

(defcustom *jmarkdown-alert-types*
  '("NOTE" "TIP" "IMPORTANT" "WARNING" "CAUTION" "QUESTION" "SUGGESTION")
  :list
  :group 'jmarkdown
  :doc "The GitHub-style alert variants for `jmarkdown-insert-alert`
   (`> [!TYPE]`): the five GitHub types plus JMarkdown's QUESTION and
   SUGGESTION.")

(defcustom *jmarkdown-code-languages*
  '("javascript" "js" "typescript" "python" "bash" "shell" "json" "html"
    "css" "c" "cpp" "java" "rust" "go" "sql" "latex" "lisp" "scheme"
    "markdown" "yaml" "text")
  :list
  :group 'jmarkdown
  :doc "Common code-fence language hints offered by
   `jmarkdown-insert-code-block` (any highlight.js language name works).")

;; --- the NUL cursor sentinel + shared materialiser --------------------

(define *jmarkdown-point-mark* "\0")

(define (-jmarkdown-insert-with-mark block)
  "Insert BLOCK (a string carrying at most one `*jmarkdown-point-mark*`) at
   point, leaving point where the mark was (or after BLOCK when it has none)."
  (let ((i (string-index-of block *jmarkdown-point-mark*)))
    (if (< i 0)
        (insert! block)
        (begin
          (insert! (substring block 0 i))
          (let ((p (point)))
            (insert! (substring block (+ i (string-length *jmarkdown-point-mark*))
                                (string-length block)))
            (goto! p))))))

;; --- pure: candidate merge + buffer scan ------------------------------

(define (-jmarkdown-member? x lst)
  (cond ((nil? lst) #f)
        ((string=? (car lst) x) #t)
        (else (-jmarkdown-member? x (cdr lst)))))

(define (-jmarkdown-dedup lst) (-jmarkdown-dedup-loop lst (list) (list)))
(define (-jmarkdown-dedup-loop lst seen acc)
  (cond
    ((nil? lst) (reverse acc))
    ((-jmarkdown-member? (car lst) seen) (-jmarkdown-dedup-loop (cdr lst) seen acc))
    (else (-jmarkdown-dedup-loop (cdr lst) (cons (car lst) seen) (cons (car lst) acc)))))

(define (-jmarkdown-scan-between text marker close)
  "Every substring between an occurrence of MARKER (e.g. \"@begin(\") and the
   next CLOSE char (e.g. \")\") in TEXT, in document order, deduped. Pure."
  (-jmarkdown-dedup (-jmarkdown-scan-between-loop text marker close 0 (list))))

(define (-jmarkdown-scan-between-loop text marker close from acc)
  (let ((hit (string-index-of text marker from)))
    (if (< hit 0)
        (reverse acc)
        (let* ((start (+ hit (string-length marker)))
               (end (string-index-of text close start)))
          (if (< end 0)
              (reverse acc)
              (-jmarkdown-scan-between-loop
               text marker close (+ end 1)
               (cons (substring text start end) acc)))))))

(define (-jmarkdown-env-candidates text)
  "Static env names merged with the buffer's own `@begin(NAME)` names, deduped."
  (-jmarkdown-dedup (append *jmarkdown-environments*
                           (-jmarkdown-scan-between text "@begin(" ")"))))

(define (-jmarkdown-directive-candidates text)
  "Static directive names merged with buffer `:::NAME` names, deduped. A
   `:::` line's name runs to whitespace / `{` / EOL."
  (-jmarkdown-dedup (append *jmarkdown-directives*
                           (-jmarkdown-scan-directive-names text))))

(define (-jmarkdown-scan-directive-names text)
  "Directive names used after a `:::` fence in TEXT, deduped. Pure."
  (-jmarkdown-dedup (-jmarkdown-scan-directives-loop text 0 (list))))

(define (-jmarkdown-scan-directives-loop text from acc)
  (let ((hit (string-index-of text ":::" from)))
    (if (< hit 0)
        (reverse acc)
        (let* ((start (-jmarkdown-skip-colons text (+ hit 3)))
               (end (-jmarkdown-name-run-end text start))
               (name (substring text start end)))
          (-jmarkdown-scan-directives-loop
           text (+ hit 3)
           (if (string=? name "") acc (cons name acc)))))))

(define (-jmarkdown-skip-colons text i)
  (if (and (< i (string-length text)) (equal? (substring text i (+ i 1)) ":"))
      (-jmarkdown-skip-colons text (+ i 1)) i))

(define *jmarkdown-name-chars*
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")

(define (-jmarkdown-name-run-end text i)
  (cond
    ((>= i (string-length text)) i)
    ((>= (string-index-of *jmarkdown-name-chars* (substring text i (+ i 1))) 0)
     (-jmarkdown-name-run-end text (+ i 1)))
    (else i)))

;; --- captured region body (survives the minibuffer round-trip) --------

(define *jmarkdown-pending-body* "")

(define (-jmarkdown-capture-body!)
  "Capture any active region into `*jmarkdown-pending-body*` (deleting it),
   else clear it. Called before a picker's minibuffer opens."
  (set! *jmarkdown-pending-body*
        (if (region-active?)
            (let ((t (region-text))) (delete-backward!) t)
            "")))

;; --- pure: environment templates --------------------------------------

(define (-jmarkdown-theorem-env? name)
  (-jmarkdown-member? name
    (list "theorem" "lemma" "corollary" "proposition" "definition"
          "example" "remark")))

(define (-jmarkdown-float-env? name)
  (-jmarkdown-member? name (list "figure" "subfigure" "table" "listing")))

(define (-jmarkdown-id-prefix name)
  "The conventional `{id=…}` key prefix for a numbered env NAME."
  (cond
    ((string=? name "theorem") "thm:")
    ((string=? name "lemma") "lem:")
    ((string=? name "corollary") "cor:")
    ((string=? name "proposition") "prop:")
    ((string=? name "definition") "def:")
    ((string=? name "example") "ex:")
    ((string=? name "remark") "rem:")
    ((string=? name "figure") "fig:")
    ((string=? name "subfigure") "sub:")
    ((string=? name "table") "tab:")
    ((string=? name "listing") "lst:")
    ((string=? name "equation") "eq:")
    (else "")))

(define (-jmarkdown-float-stub name)
  "The default inner body for an empty float NAME."
  (cond
    ((string=? name "figure") "![](image.png)")
    ((string=? name "subfigure") "![](image.png)")
    ((string=? name "table") "| A | B |\n|---|---|\n|   |   |")
    ((string=? name "listing") "```\n\n```")
    (else "")))

(define (-jmarkdown-env-template name indent body)
  "The full `@begin(NAME) … @end(NAME)` block, INDENT-prefixed, with a
   per-kind template. BODY (a captured region) is wrapped when non-empty,
   with point (one `*jmarkdown-point-mark*`) after it; an empty BODY gets a
   kind stub with point at the natural editing spot. Pure — string in, out."
  (let ((open (str indent "@begin(" name ")"))
        (close (str indent "@end(" name ")"))
        (step (str indent "  ")))
    (cond
      ;; A wrapped region: the body becomes the environment body verbatim.
      ((not (string=? body ""))
       (str open (-jmarkdown-env-open-args name) "\n"
            step body *jmarkdown-point-mark* "\n" close))
      ;; Floats: [caption] with point in it, {id=}, and a kind stub body.
      ((-jmarkdown-float-env? name)
       (str indent "@begin(" name ")[" *jmarkdown-point-mark* "]{id="
            (-jmarkdown-id-prefix name)
            (if (string=? name "subfigure") " width=0.45" "") "}\n"
            step (-jmarkdown-float-stub name) "\n" close))
      ;; Theorem family: optional [name], {id=}, point on the body line.
      ((-jmarkdown-theorem-env? name)
       (str indent "@begin(" name "){id=" (-jmarkdown-id-prefix name) "}\n"
            step *jmarkdown-point-mark* "\n" close))
      ;; Numbered equation: raw math body (NO $$), {id=}.
      ((string=? name "equation")
       (str indent "@begin(equation){id=eq:}\n"
            step *jmarkdown-point-mark* "\n" close))
      ;; Strategic-form game: a 2x2 matrix skeleton.
      ((string=? name "game")
       (str open "\n"
            step *jmarkdown-point-mark* "L & R\n"
            step "T & (1,1) & (0,0)\n"
            step "B & (0,0) & (1,1)\n" close))
      ;; Everything else (proof, abstract, feedback, comment, TeX, HTML,
      ;; custom): a plain body.
      (else
       (str open "\n" step *jmarkdown-point-mark* "\n" close)))))

(define (-jmarkdown-env-open-args name)
  "The opener suffix (`{id=…}` etc.) added when wrapping a region in a
   numbered NAME, so a wrapped theorem/float/equation is still referenceable."
  (cond
    ((-jmarkdown-theorem-env? name) (str "{id=" (-jmarkdown-id-prefix name) "}"))
    ((string=? name "equation") "{id=eq:}")
    ((-jmarkdown-float-env? name) (str "[]{id=" (-jmarkdown-id-prefix name) "}"))
    (else "")))

;; --- jmarkdown-insert-environment (C-c C-e) ---------------------------

(define (-jmarkdown-env-deliver name)
  "Minibuffer handler for `jmarkdown-insert-environment`: insert the chosen
   @begin environment (nil/empty cancels), wrapping the captured region."
  (set! *jmarkdown-insert-tab-complete* nil)
  (let ((body *jmarkdown-pending-body*))
    (set! *jmarkdown-pending-body* "")
    (cond
      ((nil? name) nil)
      ((string=? name "") nil)
      (else
       (-jmarkdown-insert-with-mark
        (-jmarkdown-env-template name (line-indent) body))
       (show-status! (str "Inserted @begin(" name ")"))))))

(defcommand jmarkdown-environment ()
  "Insert an `@begin(NAME) … @end(NAME)` environment chosen in the minibuffer
   with TAB completion over `*jmarkdown-environments*` merged with the
   environments already used in the buffer. Floats get a `[caption]{id=}`
   template, theorem-family and equation get `{id=}`, the rest a plain body;
   an active region is wrapped as the body. The completing counterpart to the
   quick `jmarkdown-insert-environment` (C-c @). Bound to C-c C-e."
  (-jmarkdown-capture-body!)
  (set! *jmarkdown-insert-candidates* (-jmarkdown-env-candidates (buffer-text)))
  (set! *jmarkdown-insert-tab-complete* -jmarkdown-insert-name-tab-complete)
  (open-completing-minibuffer! "Environment: " "")
  (set! *minibuffer-reader* -jmarkdown-env-deliver))

;; --- jmarkdown-insert-directive (C-c C-m) -----------------------------

(define (-jmarkdown-directive-deliver name)
  "Minibuffer handler for `jmarkdown-insert-directive`: insert a `:::NAME …
   :::` container around the captured region (nil/empty cancels)."
  (set! *jmarkdown-insert-tab-complete* nil)
  (let ((body *jmarkdown-pending-body*))
    (set! *jmarkdown-pending-body* "")
    (cond
      ((nil? name) nil)
      ((string=? name "") nil)
      (else
       (let ((indent (line-indent)))
         (-jmarkdown-insert-with-mark
          (if (string=? body "")
              (str ":::" name "\n" indent *jmarkdown-point-mark* "\n" indent ":::")
              (str ":::" name "\n" indent body *jmarkdown-point-mark* "\n" indent ":::"))))
       (show-status! (str "Inserted :::" name))))))

(defcommand jmarkdown-directive ()
  "Insert a `:::NAME … :::` container directive chosen in the minibuffer with
   TAB completion over `*jmarkdown-directives*` merged with the buffer's own
   `:::` names. An active region becomes the body. The completing counterpart
   to the quick `jmarkdown-insert-directive` (C-c d). Bound to C-c C-m."
  (-jmarkdown-capture-body!)
  (set! *jmarkdown-insert-candidates* (-jmarkdown-directive-candidates (buffer-text)))
  (set! *jmarkdown-insert-tab-complete* -jmarkdown-insert-name-tab-complete)
  (open-completing-minibuffer! "Directive: " "")
  (set! *minibuffer-reader* -jmarkdown-directive-deliver))

;; --- jmarkdown-insert-section (C-c C-s) -------------------------------

(define *jmarkdown-section-levels* '("1" "2" "3" "4" "5" "6"))

(define (-jmarkdown-heading-prefix level)
  "The `#`-run for heading LEVEL (a string \"1\"..\"6\"); defaults to \"##\"."
  (let ((n (string->number level)))
    (str (string-repeat "#" (if (and (number? n) (>= n 1) (<= n 6)) n 2)) " ")))

(define (-jmarkdown-section-deliver level)
  "Minibuffer handler for `jmarkdown-insert-section`: turn the current line
   into a heading of the chosen LEVEL, wrapping a captured region as the
   title, with point on the title."
  (set! *jmarkdown-insert-tab-complete* nil)
  (let ((body *jmarkdown-pending-body*))
    (set! *jmarkdown-pending-body* "")
    (cond
      ((nil? level) nil)
      (else
       (let ((prefix (-jmarkdown-heading-prefix (if (string=? level "") "2" level))))
         (if (string=? body "")
             (insert! (str prefix))
             (insert! (str prefix body))))
       (show-status! "Inserted heading")))))

(defcommand jmarkdown-insert-section ()
  "Insert an ATX heading, choosing the level (1–6) in the minibuffer. An
   active region becomes the title; otherwise point lands after the `#`s.
   Bound to C-c C-s."
  (-jmarkdown-capture-body!)
  (set! *jmarkdown-insert-candidates* *jmarkdown-section-levels*)
  (set! *jmarkdown-insert-tab-complete* -jmarkdown-insert-name-tab-complete)
  (open-completing-minibuffer! "Heading level (1-6): " "2")
  (set! *minibuffer-reader* -jmarkdown-section-deliver))

;; --- specialized inserts (menu / M-x) ---------------------------------

(define (-jmarkdown-cells n content)
  "N copies of `<content>|` (no leading pipe). Pure."
  (if (<= n 0) "" (str content "|" (-jmarkdown-cells (- n 1) content))))

(define (-jmarkdown-body-rows rows cols)
  "ROWS newline-prefixed body rows of COLS empty cells. Pure."
  (if (<= rows 0) ""
      (str "\n|" (-jmarkdown-cells cols "   ") (-jmarkdown-body-rows (- rows 1) cols))))

(define (-jmarkdown-table-skeleton rows cols)
  "A GFM table skeleton: a header row (cursor in the first cell), a `---`
   separator row, and ROWS empty body rows of COLS columns each. Pure."
  (str "| " *jmarkdown-point-mark* " |" (-jmarkdown-cells (- cols 1) "   ") "\n"
       "|" (-jmarkdown-cells cols " --- ")
       (-jmarkdown-body-rows rows cols)))

(defcommand jmarkdown-insert-table ()
  "Insert a GFM table skeleton, prompting for its size as ROWSxCOLS (e.g.
   3x2 = a header + 3 body rows, 2 columns). Point lands in the first header
   cell."
  (open-completing-minibuffer! "Table size (rowsxcols, e.g. 3x2): " "2x2")
  (set! *minibuffer-reader*
        (lambda (spec)
          (unless (or (nil? spec) (string=? spec ""))
            (let* ((parts (string-split (-jmarkdown-downcase-x spec) "x"))
                   (rows (-jmarkdown-num (car parts) 2))
                   (cols (-jmarkdown-num (if (nil? (cdr parts)) "2" (car (cdr parts))) 2)))
              (-jmarkdown-insert-with-mark (-jmarkdown-table-skeleton rows cols))
              (show-status! (str "Inserted " rows "x" cols " table")))))))

(define (-jmarkdown-downcase-x s)
  "Replace an `X` with `x` so `3X2` parses like `3x2`."
  (if (string-contains? s "X")
      (string-join (string-split s "X") "x") s))

(define (-jmarkdown-num s default)
  "Parse S as a positive integer, or DEFAULT."
  (let ((n (string->number s)))
    (if (and (number? n) (> n 0)) n default)))

(defcommand jmarkdown-insert-figure ()
  "Insert an `@begin(figure)[caption]{id=fig:}` float wrapping an image."
  (-jmarkdown-capture-body!)
  (-jmarkdown-env-deliver "figure"))

(defcommand jmarkdown-insert-table-float ()
  "Insert an `@begin(table)[caption]{id=tab:}` float wrapping a table."
  (-jmarkdown-capture-body!)
  (-jmarkdown-env-deliver "table"))

(defcommand jmarkdown-insert-listing ()
  "Insert an `@begin(listing)[caption]{id=lst:}` float wrapping a code block."
  (-jmarkdown-capture-body!)
  (-jmarkdown-env-deliver "listing"))

(defcommand jmarkdown-insert-code-block ()
  "Insert a fenced code block, choosing the language in the minibuffer (any
   highlight.js language). Point lands on the empty code line."
  (set! *jmarkdown-insert-candidates* *jmarkdown-code-languages*)
  (set! *jmarkdown-insert-tab-complete* -jmarkdown-insert-name-tab-complete)
  (open-completing-minibuffer! "Code language: " "")
  (set! *minibuffer-reader*
        (lambda (lang)
          (set! *jmarkdown-insert-tab-complete* nil)
          (unless (nil? lang)
            (let ((indent (line-indent)))
              (-jmarkdown-insert-with-mark
               (str "```" (if (string=? lang "") "" lang) "\n"
                    indent *jmarkdown-point-mark* "\n" indent "```")))))))

(defcommand jmarkdown-insert-math ()
  "Insert math, choosing inline / display / equation in the minibuffer.
   inline → `$…$`; display → `$$ … $$`; equation → a numbered
   `@begin(equation){id=eq:}` environment."
  (set! *jmarkdown-insert-candidates* (list "inline" "display" "equation"))
  (set! *jmarkdown-insert-tab-complete* -jmarkdown-insert-name-tab-complete)
  (open-completing-minibuffer! "Math (inline/display/equation): " "inline")
  (set! *minibuffer-reader*
        (lambda (kind)
          (set! *jmarkdown-insert-tab-complete* nil)
          (cond
            ((or (nil? kind) (string=? kind "equation"))
             (when (not (nil? kind)) (-jmarkdown-env-deliver "equation")))
            ((string=? kind "display")
             (let ((indent (line-indent)))
               (-jmarkdown-insert-with-mark
                (str "$$\n" indent *jmarkdown-point-mark* "\n" indent "$$"))))
            (else
             (-jmarkdown-insert-with-mark (str "$" *jmarkdown-point-mark* "$")))))))

(defcommand jmarkdown-insert-alert ()
  "Insert a GitHub-style alert blockquote (`> [!TYPE]`), choosing the type in
   the minibuffer (NOTE/TIP/IMPORTANT/WARNING/CAUTION/QUESTION/SUGGESTION)."
  (set! *jmarkdown-insert-candidates* *jmarkdown-alert-types*)
  (set! *jmarkdown-insert-tab-complete* -jmarkdown-insert-name-tab-complete)
  (open-completing-minibuffer! "Alert type: " "NOTE")
  (set! *minibuffer-reader*
        (lambda (type)
          (set! *jmarkdown-insert-tab-complete* nil)
          (unless (or (nil? type) (string=? type ""))
            (-jmarkdown-insert-with-mark
             (str "> [!" type "]\n> " *jmarkdown-point-mark*))))))

;; NB: mermaid / TiKZ quick-inserts already exist in languages/jmarkdown.lisp
;; (`jmarkdown-insert-mermaid` / `jmarkdown-insert-tikz`, via -jmarkdown-block);
;; we reuse those rather than redefine them.

(defcommand jmarkdown-insert-game ()
  "Insert a strategic-form `@begin(game)` matrix skeleton."
  (-jmarkdown-capture-body!)
  (-jmarkdown-env-deliver "game"))

(defcommand jmarkdown-insert-description-item ()
  "Insert a description-list item `term:: description` (point on the term)."
  (-jmarkdown-insert-with-mark (str *jmarkdown-point-mark* ":: ")))

(defcommand jmarkdown-insert-task-item ()
  "Insert a task-list checkbox item `- [ ] ` (point after it)."
  (insert-at-line-start "- [ ] "))

(defcommand jmarkdown-insert-anchor ()
  "Insert an anchor `⚓️name` (point in the name slot)."
  (-jmarkdown-insert-with-mark (str "⚓️" *jmarkdown-point-mark*)))

(defcommand jmarkdown-comment-region ()
  "Wrap the region (or the current line) in an `@begin(comment) … @end(comment)`
   block — hidden from output unless `{include=true}`."
  (-jmarkdown-capture-body!)
  (-jmarkdown-env-deliver "comment"))

(defcommand jmarkdown-insert-toc ()
  "Insert a `{{TOC}}` table-of-contents placeholder on its own line."
  (insert! "{{TOC}}\n"))

(defcommand jmarkdown-insert-list-of-figures ()
  "Insert a `{{LOF}}` list-of-figures placeholder."
  (insert! "{{LOF}}\n"))

(defcommand jmarkdown-insert-list-of-tables ()
  "Insert a `{{LOT}}` list-of-tables placeholder."
  (insert! "{{LOT}}\n"))

(defcommand jmarkdown-insert-list-of-listings ()
  "Insert a `{{LOL}}` list-of-listings placeholder."
  (insert! "{{LOL}}\n"))

(defcommand jmarkdown-insert-index-block ()
  "Insert an `::Index` block (the back-of-book index)."
  (-jmarkdown-insert-with-mark (str "::Index{title=\"" *jmarkdown-point-mark* "Index\"}")))

(defcommand jmarkdown-insert-bibliography ()
  "Insert a `::Bibliography` reference-list marker."
  (insert! "::Bibliography\n"))

(defcommand jmarkdown-insert-include ()
  "Insert a `[[file.md]]` file-inclusion directive (point in the path)."
  (-jmarkdown-insert-with-mark (str "[[" *jmarkdown-point-mark* ".md]]")))

(defcommand jmarkdown-insert-extension ()
  "Insert a metadata-header simple-extension skeleton (define your own inline
   delimiter). Put this inside the `---` header."
  (-jmarkdown-insert-with-mark
   (str "Extension " *jmarkdown-point-mark* "name: OPEN CLOSE false 1\n"
        "\t<span>${content1}</span>")))

(defcommand jmarkdown-insert-script-block ()
  "Insert a `<script data-type=\"jmarkdown\">` block for defining directives /
   environments inline."
  (-jmarkdown-insert-with-mark
   (str "<script data-type=\"jmarkdown\">\n" *jmarkdown-point-mark* "\n</script>")))

(defcommand jmarkdown-insert-target ()
  "Insert a `:::target{key=\"…\"} … :::` reusable-content block."
  (-jmarkdown-insert-with-mark
   (let ((indent (line-indent)))
     (str ":::target{key=\"" *jmarkdown-point-mark* "\"}\n" indent "\n" indent ":::"))))

(defcommand jmarkdown-insert-source ()
  "Insert a `:::source{key=\"…\"} … :::` reference to a defined target."
  (-jmarkdown-insert-with-mark
   (let ((indent (line-indent)))
     (str ":::source{key=\"" *jmarkdown-point-mark* "\"}\n" indent ":::"))))

;; --- shared completion dispatch (the latex-insert chaining, renamed) --
;; The host's onTab always calls `minibuffer-tab-complete`. Earlier files
;; (find-file, RefTeX, latex-insert) each redefined it to add a source and
;; delegate to the previously-captured binding. We do the same: capture the
;; current binding, redefine to dispatch on our hook when set. jmarkdown-ref
;; reuses the SAME hook + candidate globals (no further redefinition).

(define *jmarkdown-insert-candidates* (list))
(define *jmarkdown-insert-tab-complete* nil)
(define -jmarkdown-insert-orig-tab-complete minibuffer-tab-complete)

(define (minibuffer-tab-complete current)
  "Dispatch TAB completion: use `*jmarkdown-insert-tab-complete*` when a
   JMarkdown picker installed it, else delegate to the previously-captured
   handler. Extends the completion chain without editing earlier files."
  (if (nil? *jmarkdown-insert-tab-complete*)
      (-jmarkdown-insert-orig-tab-complete current)
      (*jmarkdown-insert-tab-complete* current)))

(define (-jmarkdown-insert-name-tab-complete current)
  "TAB over `*jmarkdown-insert-candidates*`: complete CURRENT to the longest
   common prefix of the candidates starting with it, or list the matches."
  (let ((matches (filter (lambda (n) (string-prefix? current n))
                         *jmarkdown-insert-candidates*)))
    (cond
      ((nil? matches) (show-status! "(no matches)") current)
      ((nil? (cdr matches)) (clear-status!) (car matches))
      (else
       (let ((lcp (-jmarkdown-fold-common-prefix matches)))
         (if (> (string-length lcp) (string-length current))
             (begin (clear-status!) lcp)
             (begin (show-status! (-jmarkdown-join matches)) current)))))))

(define (-jmarkdown-fold-common-prefix items)
  (cond ((nil? items) "")
        ((nil? (cdr items)) (car items))
        (else (-jmarkdown-fold-common-prefix
               (cons (-jmarkdown-common-prefix (car items) (car (cdr items)))
                     (cdr (cdr items)))))))

(define (-jmarkdown-common-prefix a b) (-jmarkdown-common-prefix-loop a b 0))
(define (-jmarkdown-common-prefix-loop a b i)
  (if (or (>= i (string-length a)) (>= i (string-length b))
          (not (equal? (substring a i (+ i 1)) (substring b i (+ i 1)))))
      (substring a 0 i)
      (-jmarkdown-common-prefix-loop a b (+ i 1))))

(define (-jmarkdown-join items)
  (cond ((nil? items) "")
        ((nil? (cdr items)) (car items))
        (else (str (car items) "  " (-jmarkdown-join (cdr items))))))
