;;; latex-fill.lisp — AUCTeX-style `LaTeX-fill-paragraph` for latex-mode.
;;;
;;; A faithful port of AUCTeX's `LaTeX-fill-paragraph` (latex.el): re-wrap
;;; the paragraph around point to the fill column, re-indenting every line
;;; of the affected block by its LaTeX environment depth — nested
;;; environments, list items (itemize / enumerate / description), and the
;;; \begin / \end lines themselves — using spaces, never tabs.
;;;
;;; Bound to M-q in latex-mode-map, overriding the global generic
;;; `fill-paragraph` (keymap.lisp's M-q). All of it is Lisp on existing
;;; primitives; no new host primitives, no new view kinds.
;;;
;;; Loaded AFTER latex-nav.lisp (registered in src/index.js right after it).
;;; It reuses latex-insert.lisp's pure \begin/\end environment-stack
;;; scanner — generalised here to return the FULL open-env stack at an
;;; offset (depth = its length), see `-latex-open-env-stack`.
;;;
;;; ## AUCTeX correspondence (latex.el)
;;;
;;; AUCTeX computes indentation incrementally per line in
;;; `LaTeX-indent-calculate` / `LaTeX-indent-calculate-last`, driven by
;;; `LaTeX-indent-level-count` (each unmatched \begin adds
;;; `LaTeX-indent-level`, each \end subtracts it). The NET effect, which
;;; this file reproduces directly:
;;;
;;;   * A body line at environment depth D indents  D * indent-level.
;;;   * A \begin{...} line sits at the OUTER level (its body is one
;;;     deeper); an \end{...} line dedents back to the outer level —
;;;     AUCTeX's "Backindent at \end" branch.
;;;   * Environments in `*latex-non-indenting-environments*' (AUCTeX's
;;;     `LaTeX-document-regexp', default `document') add NO level: prose
;;;     directly inside \begin{document} stays at column 0.
;;;   * An \item line indents at  D * indent-level; its wrapped
;;;     CONTINUATION lines indent one level deeper, (D+1) * indent-level,
;;;     so continuation prose aligns past the item marker. In AUCTeX terms
;;;     this is the net of `LaTeX-indent-level` and `LaTeX-item-indent`
;;;     (whose default is the NEGATIVE of `LaTeX-indent-level`, i.e. -2):
;;;     the item line is pulled back by `LaTeX-item-indent` while the
;;;     following continuation text stays at the env body level. We expose
;;;     the single `*latex-indent-level*` custom (the requirement) and also
;;;     an optional `*latex-item-indent*` for parity; the continuation rule
;;;     above is the (D+1)*level the examples assert with the defaults.
;;;
;;; Paragraph boundaries for filling (AUCTeX's `LaTeX-forward-paragraph` /
;;; `LaTeX-backward-paragraph`, `LaTeX-paragraph-commands`,
;;; `LaTeX-set-paragraph-start`): a blank line, a \begin / \end line, an
;;; \item / \bibitem, and the paragraph commands (\par, \section family,
;;; \caption, \label, \maketitle, \noindent, \newpage, \clearpage,
;;; \part, \chapter, \include, \includeonly, \appendix, \newblock,
;;; \tableofcontents) and display-math \[ \]. Prose never merges across
;;; these; each \item starts a fresh fill unit so list items stay separate.
;;;
;;; ## Approximations vs. real AUCTeX (documented for the architect)
;;;
;;;   * `*latex-indent-environment-list*` envs (verbatim, tabular, align,
;;;     matrix, cases, …): AUCTeX leaves these to a per-env indenter and
;;;     does not fill them. We do NOT special-case them in the pure core —
;;;     the command refuses to fill when point is inside a verbatim-like or
;;;     tabular/math alignment env (`-latex-fill-protected-env?`), so their
;;;     contents are left untouched (the AUCTeX-faithful no-fill outcome).
;;;     Math display environments are likewise protected.
;;;   * Comment-aware filling (code comments, comment fill-prefix,
;;;     `LaTeX-syntactic-comments`): NOT ported. A `%` comment line is
;;;     treated as ordinary prose and is a fill boundary only when blank.
;;;     Filling a paragraph that contains a trailing `%` comment is left
;;;     for the architect's live-testing.
;;;   * `LaTeX-fill-break-at-separators` (breaking before \( \[ etc.): NOT
;;;     ported; we wrap purely on whitespace at the fill column.

;; --- user-facing settings ---------------------------------------------
;; The `latex` customize group is declared by latex-compile.lisp (loaded
;; first). We add the indent-level (the requirement) and item-indent.

(defcustom *latex-indent-level* 2
  :number
  :group 'latex
  :doc "Number of spaces of indentation added for each enclosing LaTeX
   environment (each unmatched \\begin), mirroring AUCTeX's
   `LaTeX-indent-level' (default 2). `latex-fill-paragraph' (M-q)
   re-indents the paragraph's lines by their environment depth times this
   value, using spaces (never tabs).")

(defcustom *latex-item-indent* -2
  :number
  :group 'latex
  :doc "Extra indentation for an \\item line relative to the environment
   body, mirroring AUCTeX's `LaTeX-item-indent' (default -2, the negative
   of `LaTeX-indent-level'). With the default an \\item line sits at the
   list's body level and its wrapped continuation lines indent one
   `*latex-indent-level*' deeper. The item line's indent is
   (body-level + this); its continuation lines stay at body-level + one
   step.")

;; The fill column. AUCTeX uses Emacs's `fill-column' (default 70); the
;; editor's existing generic fill (`fill-paragraph!`) hardcodes 72, so we
;; keep 72 for consistency across the editor.
(define *latex-fill-column* 72)

;; Environments that do NOT add an indentation level — AUCTeX's
;; `LaTeX-document-regexp'. By default `document': prose directly inside
;; \begin{document}…\end{document} stays flush-left, as AUCTeX leaves it,
;; rather than picking up a spurious level of indent. A list of env name
;; strings so a user can add their own (e.g. a custom wrapper env).
(defcustom *latex-non-indenting-environments* (list "document")
  :list
  :group 'latex
  :doc "Environment names whose body does NOT gain a level of indentation
   from `latex-fill-paragraph' (M-q), mirroring AUCTeX's
   `LaTeX-document-regexp'. Default `(\"document\")` — content directly
   inside \\begin{document} stays at column 0. Add names here to treat
   other wrapper environments the same way.")

(define (-latex-non-indenting-env? name)
  "Whether environment NAME adds no indentation level (it is listed in
   `*latex-non-indenting-environments*', e.g. `document'). A nil NAME is
   not a match. PURE w.r.t. the custom list."
  (and (not (nil? name))
       (-latex-member? name *latex-non-indenting-environments*)))

;; --- pure: the full open-environment stack ----------------------------
;; latex-insert.lisp's `-latex-open-env-walk` returns only the INNERMOST
;; open env. For depth we need the whole stack. We reuse its
;; `-latex-env-markers` scanner (the begin/end marker list up to an
;; offset) and fold it ourselves, returning the stack of open env names
;; (innermost first). The depth is the stack's length.

(define (-latex-open-env-stack text offset)
  "The stack of LaTeX environment names open at OFFSET in TEXT, innermost
   first (so `(length ...)` is the nesting depth and `(car ...)` is the
   innermost env, or nil-list when none is open). Reuses
   latex-insert's `-latex-env-markers` (the \\begin/\\end marker list up to
   OFFSET). PURE."
  (-latex-env-stack-walk (-latex-env-markers text offset) (list)))

(define (-latex-env-stack-walk markers stack)
  "Fold MARKERS (document order) maintaining STACK of open env names
   (innermost first): a 'begin pushes, an 'end pops the nearest match.
   Returns the final STACK. PURE. (`-latex-pop-env` from latex-insert.lisp
   removes the nearest matching name, tolerating a mismatched \\end.)"
  (cond
    ((nil? markers) stack)
    (else
     (let* ((m (car markers))
            (name (get m :name "")))
       (if (eq? (get m :which nil) 'begin)
           (-latex-env-stack-walk (cdr markers) (cons name stack))
           (-latex-env-stack-walk (cdr markers) (-latex-pop-env name stack)))))))

(define (-latex-env-depth-at text offset)
  "The INDENTATION depth at OFFSET in TEXT: the number of open \\begin not
   yet matched by an \\end, EXCLUDING environments that add no indent level
   (`*latex-non-indenting-environments*', e.g. `document'), so prose inside
   \\begin{document} is not pushed in a level. PURE."
  (length (filter (lambda (e) (not (-latex-non-indenting-env? e)))
                  (-latex-open-env-stack text offset))))

;; --- pure: line classification ----------------------------------------
;; Each line of the block is classified by its leading control word (after
;; stripping indentation). This drives both its own indent and whether it
;; is a fill boundary.

(define *latex-fill-letters*
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")

(define (-latex-fill-letter? c)
  "Whether single-character string C is an ASCII letter."
  (>= (string-index-of *latex-fill-letters* c) 0))

(define (-latex-fill-trim-leading s)
  "S with leading spaces/tabs removed (not newlines — lines are split
   already). PURE."
  (cond
    ((string=? s "") s)
    ((or (string=? (substring s 0 1) " ")
         (string=? (substring s 0 1) "\t"))
     (-latex-fill-trim-leading (substring s 1 (string-length s))))
    (else s)))

(define (-latex-fill-trim-trailing s)
  "S with trailing spaces/tabs/newlines removed. PURE."
  (let ((n (string-length s)))
    (cond
      ((= n 0) s)
      ((or (string=? (substring s (- n 1) n) " ")
           (string=? (substring s (- n 1) n) "\t")
           (string=? (substring s (- n 1) n) "\n"))
       (-latex-fill-trim-trailing (substring s 0 (- n 1))))
      (else s))))

(define (-latex-fill-blank-line? line)
  "Whether LINE is blank (only spaces/tabs). PURE."
  (string=? (-latex-fill-trim-leading line) ""))

;; Paragraph commands that AUCTeX gives their own line (a fill boundary),
;; from `LaTeX-paragraph-commands-internal`. \begin / \end / \item are
;; handled by their own predicates; the rest are listed here.
(define *latex-fill-paragraph-commands*
  (list "par" "section" "subsection" "subsubsection" "paragraph"
        "subparagraph" "part" "chapter" "caption" "label" "maketitle"
        "newblock" "noindent" "appendix" "include" "includeonly"
        "tableofcontents" "newpage" "clearpage"))

(define (-latex-fill-control-word content)
  "The control word at the start of CONTENT (already left-trimmed): the
   run of ASCII letters after a leading backslash, or \"\" when CONTENT
   does not begin with `\\letter`. PURE."
  (if (or (< (string-length content) 2)
          (not (string=? (substring content 0 1) "\\"))
          (not (-latex-fill-letter? (substring content 1 2))))
      ""
      (substring content 1 (-latex-fill-letter-run-end content 1))))

(define (-latex-fill-letter-run-end s i)
  "The index after the run of ASCII letters starting at I in S. PURE."
  (cond
    ((>= i (string-length s)) i)
    ((-latex-fill-letter? (substring s i (+ i 1)))
     (-latex-fill-letter-run-end s (+ i 1)))
    (else i)))

(define (-latex-fill-begin-line? content)
  "Whether left-trimmed CONTENT is a \\begin{...} line. PURE."
  (string=? (-latex-fill-control-word content) "begin"))

(define (-latex-fill-end-line? content)
  "Whether left-trimmed CONTENT is an \\end{...} line. PURE."
  (string=? (-latex-fill-control-word content) "end"))

(define (-latex-fill-item-line? content)
  "Whether left-trimmed CONTENT begins an item (\\item or \\bibitem),
   AUCTeX's `LaTeX-item-regexp'. PURE."
  (let ((cw (-latex-fill-control-word content)))
    (or (string=? cw "item") (string=? cw "bibitem"))))

(define (-latex-fill-env-name content)
  "The environment name in a \\begin{NAME} / \\end{NAME} CONTENT line — the
   text between the first `{` and the next `}` — or \"\" when absent. Used
   to recognise a non-indenting env (`document') on a begin/end line inside
   a filled block. PURE."
  (let ((open (string-index-of content "{")))
    (if (< open 0)
        ""
        (let ((close (string-index-of content "}" (+ open 1))))
          (if (< close 0) "" (substring content (+ open 1) close))))))

(define (-latex-fill-display-math-line? content)
  "Whether left-trimmed CONTENT starts a display-math \\[ or \\] (a
   paragraph boundary). PURE."
  (or (string-prefix? "\\[" content) (string-prefix? "\\]" content)))

(define (-latex-fill-paragraph-command-line? content)
  "Whether left-trimmed CONTENT starts with a `LaTeX-paragraph-commands'
   macro (\\par, \\section…, \\caption, \\label, …) — a fill boundary that
   keeps its own line. PURE. (\\begin / \\end / \\item are handled by
   their own predicates.)"
  (or (-latex-fill-display-math-line? content)
      (-latex-member? (-latex-fill-control-word content)
                      *latex-fill-paragraph-commands*)))

(define (-latex-fill-boundary-line? content)
  "Whether left-trimmed CONTENT is a STRUCTURAL fill boundary that should
   keep its own re-indented line and not merge into surrounding prose:
   a \\begin / \\end / \\item / \\bibitem / paragraph-command / display
   math line. (A blank line is a boundary too but is handled separately.)
   PURE."
  (or (-latex-fill-begin-line? content)
      (-latex-fill-end-line? content)
      (-latex-fill-item-line? content)
      (-latex-fill-paragraph-command-line? content)))

;; --- pure: indentation ------------------------------------------------

(define (-latex-fill-spaces n)
  "A string of N spaces (N<=0 -> \"\"). PURE."
  (if (<= n 0) "" (string-repeat " " n)))

(define (-latex-fill-body-indent depth level)
  "The indent (a space string) of a plain body line at environment DEPTH
   with indent step LEVEL. PURE."
  (-latex-fill-spaces (* depth level)))

(define (-latex-fill-item-indent depth level item-indent)
  "The indent (a space string) of an \\item line at environment DEPTH.
   AUCTeX computes an item's indentation as its continuation (body) level
   plus `LaTeX-item-indent' (negative by default): the item marker is
   pulled back from the wrapped text. The body/continuation level inside a
   list is one step deeper than the \\begin, (DEPTH+1)*LEVEL, so the item
   line lands at (DEPTH+1)*LEVEL + ITEM-INDENT — with the defaults
   (LEVEL 2, ITEM-INDENT -2) that is DEPTH*LEVEL, exactly the AUCTeX
   layout. PURE."
  (-latex-fill-spaces (+ (* (+ depth 1) level) item-indent)))

(define (-latex-fill-continuation-indent depth level)
  "The indent (a space string) of an item's wrapped CONTINUATION lines at
   environment DEPTH: the list body level, one step deeper than the
   \\begin, (DEPTH+1)*LEVEL. PURE."
  (-latex-fill-spaces (* (+ depth 1) level)))

;; --- pure: word wrapping ----------------------------------------------
;; Wrap a list of WORDS into lines no longer than the fill column. The
;; FIRST line is prefixed with FIRST-INDENT, every continuation line with
;; REST-INDENT (they differ for \item, equal for plain prose). A single
;; word longer than the column is left on its own line (never split) —
;; AUCTeX does the same for an unbreakable token.

(define (-latex-fill-wrap words first-indent rest-indent fill-column)
  "Greedily wrap WORDS (a list of non-empty strings) into a list of lines.
   The first line carries FIRST-INDENT, the rest REST-INDENT; no line
   exceeds FILL-COLUMN unless it holds a single over-long word. PURE."
  (cond
    ((nil? words) (list))
    (else
     (-latex-fill-wrap-loop (cdr words) (str first-indent (car words))
                            rest-indent fill-column (list)))))

(define (-latex-fill-wrap-loop words current rest-indent fill-column acc)
  "Tail loop for `-latex-fill-wrap`: CURRENT is the line being built, ACC
   the completed lines (reversed)."
  (cond
    ((nil? words) (reverse (cons current acc)))
    (else
     (let ((candidate (str current " " (car words))))
       (if (> (string-length candidate) fill-column)
           ;; The word does not fit: flush CURRENT, start a new line.
           (-latex-fill-wrap-loop (cdr words)
                                  (str rest-indent (car words))
                                  rest-indent fill-column
                                  (cons current acc))
           (-latex-fill-wrap-loop (cdr words) candidate
                                  rest-indent fill-column acc))))))

(define (-latex-fill-words content)
  "Split left-trimmed CONTENT (one or more already-joined prose lines)
   into a list of whitespace-separated words, dropping empties. PURE."
  (filter (lambda (w) (not (string=? w "")))
          (string-split (-latex-fill-collapse-spaces content) " ")))

(define (-latex-fill-collapse-spaces s)
  "S with every run of spaces/tabs/newlines collapsed to a single space,
   and leading/trailing whitespace trimmed. PURE."
  (-latex-fill-trim-trailing
   (-latex-fill-trim-leading
    (-latex-fill-collapse-loop s 0 "" #f))))

(define (-latex-fill-collapse-loop s i acc prev-space?)
  (cond
    ((>= i (string-length s)) acc)
    (else
     (let ((c (substring s i (+ i 1))))
       (if (or (string=? c " ") (string=? c "\t") (string=? c "\n"))
           (-latex-fill-collapse-loop s (+ i 1)
                                      (if prev-space? acc (str acc " "))
                                      #t)
           (-latex-fill-collapse-loop s (+ i 1) (str acc c) #f))))))

;; --- pure: the block filler -------------------------------------------
;; The heart of the command. Given the BLOCK (the paragraph region's text,
;; newline-joined) and the env depth at its FIRST line, walk the lines
;; tracking depth from \begin/\end, re-indent every line, and re-wrap each
;; run of prose lines (between boundaries) to the fill column. Returns the
;; rebuilt block text (no trailing newline). PURE — fully unit-testable.

(define (latex-fill-block block base-depth level item-indent fill-column)
  "Re-indent and re-wrap BLOCK (a newline-joined run of LaTeX source
   lines) as AUCTeX's `LaTeX-fill-paragraph` would. BASE-DEPTH is the
   environment nesting depth at the block's first line; LEVEL is
   `*latex-indent-level*`; ITEM-INDENT is `*latex-item-indent*`;
   FILL-COLUMN the wrap column. Every line is re-indented by its depth
   (nested envs, list items, \\begin/\\end backindent); consecutive prose
   lines are joined and wrapped, broken at \\begin/\\end/\\item/paragraph
   commands so items and structure never merge. Spaces only. PURE — string
   in, string out, no buffer."
  (-latex-fill-join-lines
   (-latex-fill-walk (string-split block "\n") base-depth level item-indent
                     fill-column (list) (list))))

(define (-latex-fill-walk lines depth level item-indent fill-column
                          pending acc)
  "Walk LINES tracking DEPTH; PENDING accumulates the words of the prose
   run currently being gathered (with their first/rest indents), ACC the
   emitted output lines (reversed, each a final string). A structural or
   blank line flushes PENDING first. Returns the output lines in order."
  (cond
    ((nil? lines)
     (reverse (-latex-fill-flush pending acc)))
    (else
     (let* ((raw (car lines))
            (content (-latex-fill-trim-leading raw)))
       (cond
         ;; Blank line: flush any prose, emit an empty line.
         ((-latex-fill-blank-line? raw)
          (-latex-fill-walk (cdr lines) depth level item-indent fill-column
                            (list) (cons "" (-latex-fill-flush pending acc))))
         ;; \begin{...}: flush, emit at outer level, then go one deeper —
         ;; UNLESS it is a non-indenting env (`document'), which keeps the
         ;; depth so its body stays at the outer level.
         ((-latex-fill-begin-line? content)
          (let ((next (if (-latex-non-indenting-env? (-latex-fill-env-name content))
                          depth
                          (+ depth 1))))
            (-latex-fill-walk
             (cdr lines) next level item-indent fill-column (list)
             (cons (str (-latex-fill-body-indent depth level) content)
                   (-latex-fill-flush pending acc)))))
         ;; \end{...}: flush, dedent first, emit at the outer level — unless
         ;; a non-indenting env (`document'), which never changed the depth.
         ((-latex-fill-end-line? content)
          (let ((d (if (-latex-non-indenting-env? (-latex-fill-env-name content))
                       depth
                       (- depth 1))))
            (-latex-fill-walk
             (cdr lines) d level item-indent fill-column (list)
             (cons (str (-latex-fill-body-indent d level) content)
                   (-latex-fill-flush pending acc)))))
         ;; \item / \bibitem: flush the previous unit, start a NEW prose
         ;; run seeded with the item's own words (so items never merge),
         ;; first line at item indent, continuations one step deeper.
         ((-latex-fill-item-line? content)
          (-latex-fill-walk
           (cdr lines) depth level item-indent fill-column
           (-latex-fill-pending (-latex-fill-words content)
                                (-latex-fill-item-indent depth level item-indent)
                                (-latex-fill-continuation-indent depth level))
           (-latex-fill-flush pending acc)))
         ;; Paragraph command (\par, \section, \caption, …) / display math:
         ;; flush, emit on its own line at the body level.
         ((-latex-fill-paragraph-command-line? content)
          (-latex-fill-walk
           (cdr lines) depth level item-indent fill-column (list)
           (cons (str (-latex-fill-body-indent depth level) content)
                 (-latex-fill-flush pending acc))))
         ;; Plain prose: append its words to the current run (seeding the
         ;; run's indents from the body level when it is the first line).
         (else
          (-latex-fill-walk
           (cdr lines) depth level item-indent fill-column
           (-latex-fill-extend-pending
            pending (-latex-fill-words content)
            (-latex-fill-body-indent depth level)
            (-latex-fill-body-indent depth level))
           acc)))))))

;; A "pending" prose run is a record of the accumulated words and the
;; first/rest indents to wrap them with. Kept as a hash-map so the walk
;; stays readable.

(define (-latex-fill-pending words first-indent rest-indent)
  "A fresh pending-run record from WORDS with the given indents."
  (hash-map :words words :first first-indent :rest rest-indent))

(define (-latex-fill-pending-empty? pending)
  "Whether PENDING (a list = no run, or a record) holds no run/words."
  (or (nil? pending)
      (and (list? pending) (nil? pending))
      (nil? (get pending :words nil))))

(define (-latex-fill-extend-pending pending words first-indent rest-indent)
  "Add WORDS to PENDING. When PENDING is empty, start a new run with the
   given indents (a plain-prose run uses the body indent for both)."
  (if (-latex-fill-pending-empty? pending)
      (-latex-fill-pending words first-indent rest-indent)
      (hash-map :words (append (get pending :words (list)) words)
                :first (get pending :first first-indent)
                :rest (get pending :rest rest-indent))))

(define (-latex-fill-flush pending acc)
  "Wrap PENDING's prose run (if any) onto ACC (reversed output lines),
   returning the new reversed ACC. An empty run leaves ACC unchanged."
  (if (-latex-fill-pending-empty? pending)
      acc
      (-latex-fill-prepend-reversed
       (-latex-fill-wrap (get pending :words (list))
                         (get pending :first "")
                         (get pending :rest "")
                         *latex-fill-column*)
       acc)))

(define (-latex-fill-prepend-reversed lines acc)
  "Push LINES (in order) onto ACC (a reversed list), keeping ACC reversed."
  (cond
    ((nil? lines) acc)
    (else (-latex-fill-prepend-reversed (cdr lines) (cons (car lines) acc)))))

(define (-latex-fill-join-lines lines)
  "Join LINES with newlines into one string (no trailing newline). PURE."
  (cond
    ((nil? lines) "")
    ((nil? (cdr lines)) (car lines))
    (else (str (car lines) "\n" (-latex-fill-join-lines (cdr lines))))))

;; --- pure: protected (non-fillable) environments ----------------------
;; AUCTeX does not reflow verbatim / tabular / math-alignment envs (its
;; `LaTeX-indent-environment-list` hands them to a dedicated indenter and
;; filling skips them). We refuse to fill when point's innermost env is
;; one of these, leaving the contents byte-for-byte unchanged.

(define *latex-fill-protected-envs*
  (list "verbatim" "verbatim*" "lstlisting" "filecontents" "filecontents*"
        "tabular" "tabular*" "array" "eqnarray" "eqnarray*"
        "align" "align*" "aligned" "alignat" "alignat*" "gather" "gather*"
        "multline" "multline*" "split" "cases" "matrix" "pmatrix"
        "bmatrix" "Bmatrix" "vmatrix" "Vmatrix" "smallmatrix"
        "equation" "equation*" "displaymath" "math"))

(define (-latex-fill-protected-env? env)
  "Whether ENV (a name string, or nil) is a verbatim / tabular /
   math-alignment environment AUCTeX does not fill. PURE."
  (and (not (nil? env))
       (-latex-member? env *latex-fill-protected-envs*)))

;; --- pure: paragraph bounds in the buffer text ------------------------
;; Find the run of lines around point delimited by blank lines — the
;; region `latex-fill-paragraph` rewrites (the structural \begin/\end
;; lines inside it are re-indented; the prose inside is wrapped). Mirrors
;; the generic `fill-paragraph!`'s blank-line paragraph, but returns line
;; indices so the command can map them to offsets.

(define (-latex-fill-paragraph-bounds lines line)
  "Given LINES (the buffer split on newline) and the cursor's LINE index,
   the (start . end) inclusive line-index range of the non-blank run
   containing LINE, or nil when LINE itself is blank. PURE."
  (if (-latex-fill-line-blank? lines line)
      nil
      (cons (-latex-fill-scan-up lines line)
            (-latex-fill-scan-down lines line))))

(define (-latex-fill-line-blank? lines i)
  "Whether line index I is out of range or a blank line of LINES. PURE."
  (or (< i 0)
      (>= i (length lines))
      (-latex-fill-blank-line? (nth lines i))))

(define (-latex-fill-scan-up lines i)
  "The first line index of the non-blank run ending at I. PURE."
  (if (-latex-fill-line-blank? lines (- i 1)) i (-latex-fill-scan-up lines (- i 1))))

(define (-latex-fill-scan-down lines i)
  "The last line index of the non-blank run starting at I. PURE."
  (if (-latex-fill-line-blank? lines (+ i 1)) i (-latex-fill-scan-down lines (+ i 1))))

;; --- pure: offsets of a line range ------------------------------------

(define (-latex-fill-line-offset lines i)
  "The character offset of the start of line index I in the text whose
   newline-split is LINES. PURE."
  (-latex-fill-line-offset-loop lines i 0 0))

(define (-latex-fill-line-offset-loop lines target i acc)
  (cond
    ((>= i target) acc)
    (else (-latex-fill-line-offset-loop
           lines target (+ i 1)
           (+ acc (string-length (nth lines i)) 1)))))

;; --- the command ------------------------------------------------------

(defcommand latex-fill-paragraph ()
  "Re-wrap the paragraph around point the way AUCTeX's
   `LaTeX-fill-paragraph' does: fill prose to `*latex-fill-column*' and
   re-indent every line of the enclosing block by its LaTeX environment
   depth — nested environments, list items (itemize / enumerate /
   description), and the \\begin / \\end lines themselves — using spaces
   only (`*latex-indent-level*' spaces per level; \\item lines pulled back
   by `*latex-item-indent*' with continuations one level deeper).

   The paragraph is the run of non-blank lines around point; structural
   lines (\\begin / \\end / \\item / \\par / \\section… / display math) are
   re-indented in place and never merged into surrounding prose. A blank
   line, or point inside a verbatim / tabular / math-alignment environment,
   leaves the buffer unchanged. Bound to M-q in latex-mode (overriding the
   global `fill-paragraph')."
  (let* ((text (buffer-text))
         (lines (string-split text "\n"))
         (cursor-line (-latex-fill-line-of-offset text (point)))
         (bounds (-latex-fill-paragraph-bounds lines cursor-line)))
    (cond
      ((nil? bounds)
       (show-status! "Nothing to fill (blank line)"))
      ((-latex-fill-protected-env?
        (car (-latex-open-env-stack text (point))))
       (show-status! "latex-fill-paragraph: not filling a verbatim/math/tabular environment"))
      (else
       (let* ((start-line (car bounds))
              (end-line (cdr bounds))
              (from (-latex-fill-line-offset lines start-line))
              (to (+ (-latex-fill-line-offset lines end-line)
                     (string-length (nth lines end-line))))
              (base-depth (-latex-fill-env-depth-at text from))
              (block (substring text from to))
              (filled (latex-fill-block block base-depth
                                        *latex-indent-level* *latex-item-indent*
                                        *latex-fill-column*)))
         (if (string=? filled block)
             (show-status! "Paragraph already filled")
             (begin
               (delete-region! from to)
               (goto! from)
               (insert! filled)
               (show-status! "Filled paragraph"))))))))

(define (-latex-fill-env-depth-at text from)
  "The environment depth that applies to the FIRST line of the block at
   offset FROM: the depth at FROM, but if FROM's own line opens with an
   \\end, that \\end has not yet been counted at FROM, so the depth is one
   LESS than the surrounding-body depth — the block's own \\end re-dedents
   it inside `latex-fill-block`. We therefore use the depth at FROM
   directly (the \\begin/\\end on the first line are handled by the walk)."
  (-latex-fill-env-depth text from))

(define (-latex-fill-env-depth text from)
  "Environment depth at offset FROM. Thin name kept distinct from the pure
   `-latex-env-depth-at` so the command reads clearly."
  (-latex-env-depth-at text from))

(define (-latex-fill-line-of-offset text offset)
  "The 0-based line index containing OFFSET in TEXT (the count of newlines
   strictly before OFFSET). PURE."
  (-latex-fill-count-newlines text 0 (min offset (string-length text)) 0))

(define (-latex-fill-count-newlines text i limit acc)
  (cond
    ((>= i limit) acc)
    ((string=? (substring text i (+ i 1)) "\n")
     (-latex-fill-count-newlines text (+ i 1) limit (+ acc 1)))
    (else (-latex-fill-count-newlines text (+ i 1) limit acc))))

;; --- keybinding -------------------------------------------------------
;; Bind M-q in latex-mode-map, overriding keymap.lisp's global
;; M-q -> fill-paragraph for LaTeX buffers. latex-nav.lisp last re-installed
;; latex-mode-map as {"C-c" latex-c-c-map "M-enter" … "\"" …}; we read its
;; current value and `assoc` the M-q slot on, so the C-c sub-map and the two
;; top-level Phase-5 keys all survive. (The mode map's binding shadows the
;; global keymap for LaTeX buffers — see modes.lisp's keymap chain.)

(set! latex-mode-map (assoc latex-mode-map "M-q" 'latex-fill-paragraph))
