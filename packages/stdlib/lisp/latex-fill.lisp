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
;;; ## The completed port (the pieces beyond basic indent + wrap)
;;;
;;;   * COMMENTS — AUCTeX `LaTeX-fill-paragraph`'s comment handling:
;;;       - A run of comment-only lines fills as a comment paragraph: the
;;;         leading %-run (`%', `%%', …) is preserved as the fill prefix
;;;         (normalised to one space after it) and the content wraps to the
;;;         fill column behind it. Runs of DIFFERENT %-depth never merge; a
;;;         bare `%' line is a boundary between comment paragraphs.
;;;       - A code line's trailing comment (a "code comment") ends its fill
;;;         unit: the code words fill normally, the comment stays glued —
;;;         unfilled — after the last code word (AUCTeX: "Code comments …
;;;         will not be filled"), and the following lines start a fresh
;;;         unit at the interrupted run's indent.
;;;       - `\%' is not a comment start; backslash-run parity decides
;;;         (`\\%' after a line-break macro IS one). A `%' inside a
;;;         \verb group is not a comment either.
;;;   * PARAGRAPH-COMMAND UNITS — a \caption{…} / \section{…} / \chapter…
;;;     line is its own fill unit spanning the MACRO'S EXTENT: following
;;;     lines are gathered while the macro's braces stay unclosed
;;;     (AUCTeX's `LaTeX-forward-paragraph`: the paragraph command's
;;;     paragraph ends with its macro) and the whole unit re-wraps to the
;;;     fill column. Continuation lines indent an extra
;;;     `*latex-brace-indent-level*' per brace still open at the break —
;;;     AUCTeX's `TeX-brace-indent-level' — dropping back to the
;;;     environment indent once the closing `}' is passed. \noindent and
;;;     \newblock instead LEAD IN an ordinary prose paragraph (following
;;;     lines merge into it), and a display-math \[ / \] line keeps its
;;;     own unwrapped line.
;;;   * `LaTeX-fill-break-at-separators` — with
;;;     `*latex-fill-break-at-separators*' (default on, matching AUCTeX's
;;;     default `(\( \) \[ \])`): an inline \(…\) or \[…\] math group is
;;;     never broken across lines — the break lands before the opener or
;;;     after the closer, the whole group moving to the next line when it
;;;     straddles the column. A \verb<delim>…<delim> group is NEVER broken,
;;;     regardless of the option (its spaces are not break points).
;;;   * PROTECTED ENVIRONMENTS inside the block — verbatim / tabular /
;;;     alignment / display-math envs (`*latex-fill-protected-envs*',
;;;     AUCTeX's `LaTeX-indent-environment-list` no-refill outcome)
;;;     encountered INSIDE the filled block pass through byte-identical:
;;;     the \begin/\end lines re-indent, the body lines do not change at
;;;     all. Filling with point INSIDE one is still refused outright.
;;;   * SENTENCE SPACING — Emacs's `sentence-end-double-space' rule, which
;;;     AUCTeX inherits, behind `*latex-sentence-end-double-space*': when
;;;     on, joining a line after a sentence-ending word inserts two spaces,
;;;     and an existing run of two-or-more spaces between words is
;;;     preserved as two. Default OFF here (Emacs defaults it ON): TeX
;;;     collapses source spacing anyway and the architect's documents are
;;;     single-spaced — on would inject double spaces at every refill.
;;;   * POINT — after filling, point returns to the same prose position
;;;     (the same count of non-whitespace characters), as AUCTeX does,
;;;     instead of jumping to the end of the block.
;;;
;;; ## Remaining approximations vs. real AUCTeX (for the architect)
;;;
;;;   * `$…$' groups break freely — `$' is not in AUCTeX's default
;;;     `LaTeX-fill-break-at-separators' either.
;;;   * `LaTeX-syntactic-comments''s full code/comment indentation
;;;     interplay is reduced to the rules above (comment content is filled
;;;     as prose, re-indented to the environment depth).
;;;   * The env-marker scanner does not ignore \begin/\end inside comments
;;;     (pre-existing, shared with latex-insert.lisp).

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

(defcustom *latex-brace-indent-level* 2
  :number
  :group 'latex
  :doc "Extra spaces of indentation per unclosed `{' for the wrapped
   continuation lines of a paragraph-command fill unit (\\caption{…},
   \\section{…}, …) in `latex-fill-paragraph' (M-q) — AUCTeX's
   `TeX-brace-indent-level' (default 2). Continuation lines inside the
   macro's argument indent this much beyond the environment indent;
   once the closing `}' is passed they drop back.")

(defcustom *latex-fill-break-at-separators* #t
  :boolean
  :group 'latex
  :doc "When on, `latex-fill-paragraph' (M-q) never breaks a line inside
   an inline \\(…\\) or \\[…\\] math group: the break lands before the
   opening or after the closing delimiter, the whole group moving to the
   next line when it straddles the fill column. Mirrors AUCTeX's
   `LaTeX-fill-break-at-separators' (default `(\\( \\) \\[ \\])`).
   A \\verb group is never broken regardless of this option.")

(defcustom *latex-sentence-end-double-space* #f
  :boolean
  :group 'latex
  :doc "When on, `latex-fill-paragraph' (M-q) puts TWO spaces after a
   sentence-ending word when joining lines, and preserves an existing run
   of two-or-more spaces between words — Emacs's
   `sentence-end-double-space' fill rule, which AUCTeX inherits. Off by
   default (Emacs defaults it ON): with it off, all inter-word whitespace
   collapses to a single space when filling.")

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

;; --- pure: character classes and trims ---------------------------------

(define *latex-fill-letters*
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")

(define (-latex-fill-letter? c)
  "Whether single-character string C is an ASCII letter."
  (>= (string-index-of *latex-fill-letters* c) 0))

(define (-latex-fill-ws-char? c)
  "Whether single-character string C is a space, tab or newline. PURE."
  (or (string=? c " ") (string=? c "\t") (string=? c "\n")))

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

;; --- pure: backslash-escape parity --------------------------------------
;; A `%' (or `\(' etc.) only counts when the backslash run immediately
;; before it has EVEN length: `\%' is escaped, `\\%' (a % after the \\
;; line-break macro) is a real comment, `\\\%' escaped again, and so on.

(define (-latex-fill-escaped? s i)
  "Whether the character at index I of S is escaped — preceded by an ODD
   run of backslashes. PURE."
  (-latex-fill-odd-backslash-run? s (- i 1) #f))

(define (-latex-fill-odd-backslash-run? s i odd?)
  (if (or (< i 0) (not (string=? (substring s i (+ i 1)) "\\")))
      odd?
      (-latex-fill-odd-backslash-run? s (- i 1) (not odd?))))

;; --- pure: net brace count ----------------------------------------------
;; The grouping-brace surplus of a string: +1 per unescaped `{', -1 per
;; unescaped `}'. \{ and \} don't count (escape parity) and a \verb
;; group's argument is skipped. Drives both the extent of a
;; paragraph-command fill unit and its continuation-line indentation.

(define (-latex-fill-brace-net s)
  "The net count of unescaped grouping `{' minus `}' in S. PURE."
  (-latex-fill-brace-net-loop s 0 0))

(define (-latex-fill-brace-net-loop s i n)
  (cond
    ((>= i (string-length s)) n)
    ((-latex-fill-verb-at? s i)
     (-latex-fill-brace-net-loop s (-latex-fill-verb-end s i) n))
    ((and (string=? (substring s i (+ i 1)) "{")
          (not (-latex-fill-escaped? s i)))
     (-latex-fill-brace-net-loop s (+ i 1) (+ n 1)))
    ((and (string=? (substring s i (+ i 1)) "}")
          (not (-latex-fill-escaped? s i)))
     (-latex-fill-brace-net-loop s (+ i 1) (- n 1)))
    (else (-latex-fill-brace-net-loop s (+ i 1) n))))

;; --- pure: line classification ----------------------------------------
;; Each line of the block is classified by its leading control word (after
;; stripping indentation). This drives both its own indent and whether it
;; is a fill boundary.

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

(define (-latex-fill-comment-line? content)
  "Whether left-trimmed CONTENT is a comment-only line (its first
   character is `%'; an escaped \\% cannot reach column 0 of the trimmed
   content). PURE."
  (string-prefix? "%" content))

(define (-latex-fill-comment-run content)
  "The leading run of `%' characters of CONTENT (which starts with `%'):
   \"%\", \"%%\", … — the comment prefix AUCTeX preserves when filling
   comment paragraphs. PURE."
  (substring content 0 (-latex-fill-percent-run-end content 0)))

(define (-latex-fill-percent-run-end s i)
  (cond
    ((>= i (string-length s)) i)
    ((string=? (substring s i (+ i 1)) "%")
     (-latex-fill-percent-run-end s (+ i 1)))
    (else i)))

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

;; --- pure: trailing ("code") comments -----------------------------------
;; AUCTeX: "Code comments, i.e. comments with uncommented code preceding
;; them in the same line, will not be filled unless they comprise a single
;; line." The code part fills; the comment ends the fill unit and stays
;; glued, verbatim, after the last code word.

(define (-latex-fill-comment-pos s i)
  "The index of the first REAL comment `%' at/after I in S, or -1: not
   backslash-escaped (`\\%'), and not inside a \\verb group's delimited
   argument. PURE."
  (cond
    ((>= i (string-length s)) -1)
    ((-latex-fill-verb-at? s i)
     (-latex-fill-comment-pos s (-latex-fill-verb-end s i)))
    ((and (string=? (substring s i (+ i 1)) "%")
          (not (-latex-fill-escaped? s i)))
     i)
    (else (-latex-fill-comment-pos s (+ i 1)))))

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

;; --- pure: sentence-end detection ---------------------------------------

(define *latex-fill-sentence-closers* "\"')]}")

(define (-latex-fill-sentence-end-word? w)
  "Whether word W ends a sentence: after stripping trailing closing
   quotes/brackets, it ends with `.', `?' or `!'. PURE."
  (let ((core (-latex-fill-strip-closers w)))
    (and (> (string-length core) 0)
         (let ((last (substring core (- (string-length core) 1)
                                (string-length core))))
           (or (string=? last ".") (string=? last "?") (string=? last "!"))))))

(define (-latex-fill-strip-closers w)
  (let ((n (string-length w)))
    (if (and (> n 0)
             (>= (string-index-of *latex-fill-sentence-closers*
                                  (substring w (- n 1) n))
                 0))
        (-latex-fill-strip-closers (substring w 0 (- n 1)))
        w)))

(define (-latex-fill-last-word s)
  "The final whitespace-delimited word of S (\"\" when S is blank). PURE."
  (let ((end (-latex-fill-skip-ws-back s (string-length s))))
    (substring s (-latex-fill-word-start s end) end)))

(define (-latex-fill-skip-ws-back s i)
  "The index after the last non-whitespace character at or before I. PURE."
  (if (or (= i 0)
          (not (-latex-fill-ws-char? (substring s (- i 1) i))))
      i
      (-latex-fill-skip-ws-back s (- i 1))))

(define (-latex-fill-word-start s end)
  "The start index of the word ending (exclusively) at END in S. PURE."
  (if (or (= end 0)
          (-latex-fill-ws-char? (substring s (- end 1) end)))
      end
      (-latex-fill-word-start s (- end 1))))

(define (-latex-fill-join-sep prev-text)
  "The separator for joining the next source line onto PREV-TEXT: two
   spaces after a sentence-ending word when
   `*latex-sentence-end-double-space*' is on (the Emacs fill rule AUCTeX
   inherits), else one space. PURE w.r.t. the custom."
  (if (and *latex-sentence-end-double-space*
           (-latex-fill-sentence-end-word? (-latex-fill-last-word prev-text)))
      "  "
      " "))

;; --- pure: tokenizing (\verb-safe, math-group-safe) ---------------------
;; A prose run is split into wrap TOKENS — records {:w word :sep2 bool}
;; where :sep2 marks a two-space separator BEFORE the token (preserved on
;; output when `*latex-sentence-end-double-space*' is on). A token is
;; normally a whitespace-delimited word, but:
;;   * a \verb<delim>…<delim> / \verb*<delim>…<delim> group is ALWAYS one
;;     token — its spaces are never break points;
;;   * with `*latex-fill-break-at-separators*', an inline \(…\) or \[…\]
;;     math group (closer present) is one token, so a line break can only
;;     land before its opener or after its closer — AUCTeX's
;;     `LaTeX-fill-break-at-separators'.

(define (-latex-fill-tokens text)
  "Split TEXT (one joined prose run) into wrap-token records
   {:w word :sep2 double-space-before?}. PURE w.r.t. the customs."
  (-latex-fill-tokens-loop text 0 (list)))

(define (-latex-fill-tokens-loop text i acc)
  (let* ((start (-latex-fill-skip-ws text i))
         (run (- start i)))
    (if (>= start (string-length text))
        (reverse acc)
        (let ((end (-latex-fill-token-end text start)))
          (-latex-fill-tokens-loop
           text end
           (cons (hash-map :w (substring text start end)
                           :sep2 (and *latex-sentence-end-double-space*
                                      (> i 0)
                                      (>= run 2)))
                 acc))))))

(define (-latex-fill-skip-ws text i)
  "The index of the first non-whitespace character at/after I in TEXT (its
   length when none). PURE."
  (if (and (< i (string-length text))
           (-latex-fill-ws-char? (substring text i (+ i 1))))
      (-latex-fill-skip-ws text (+ i 1))
      i))

(define (-latex-fill-token-end text i)
  "The end index of the wrap token starting at I in TEXT: the next
   whitespace, except that a \\verb group's delimited argument — and, when
   `*latex-fill-break-at-separators*' is on, an inline \\(…\\) / \\[…\\]
   math group — is scanned straight through. PURE w.r.t. the customs."
  (cond
    ((>= i (string-length text)) i)
    ((-latex-fill-ws-char? (substring text i (+ i 1))) i)
    ((-latex-fill-verb-at? text i)
     (-latex-fill-token-end text (-latex-fill-verb-end text i)))
    ((and *latex-fill-break-at-separators*
          (-latex-fill-math-open-at? text i "\\(" "\\)"))
     (-latex-fill-token-end text (-latex-fill-math-end text i "\\)")))
    ((and *latex-fill-break-at-separators*
          (-latex-fill-math-open-at? text i "\\[" "\\]"))
     (-latex-fill-token-end text (-latex-fill-math-end text i "\\]")))
    (else (-latex-fill-token-end text (+ i 1)))))

(define (-latex-fill-verb-at? text i)
  "Whether an unescaped \\verb (or \\verb*) macro WITH its delimiter
   character starts at I in TEXT — the delimiter is the character right
   after the macro name, any non-letter non-whitespace (so \\verbatim etc.
   do not match). PURE."
  (and (>= (string-length text) (+ i 6))
       (string=? (substring text i (+ i 5)) "\\verb")
       (not (-latex-fill-escaped? text i))
       (let ((d (-latex-fill-verb-delim-pos text i)))
         (and (< d (string-length text))
              (let ((c (substring text d (+ d 1))))
                (and (not (-latex-fill-letter? c))
                     (not (-latex-fill-ws-char? c))))))))

(define (-latex-fill-verb-delim-pos text i)
  "The index of the delimiter character of the \\verb / \\verb* macro at I
   (just past the macro name and optional star). PURE."
  (let ((j (+ i 5)))
    (if (and (< j (string-length text))
             (string=? (substring text j (+ j 1)) "*"))
        (+ j 1)
        j)))

(define (-latex-fill-verb-end text i)
  "The index just after the closing delimiter of the \\verb group at I
   (the end of TEXT when unterminated). PURE."
  (let* ((d (-latex-fill-verb-delim-pos text i))
         (delim (substring text d (+ d 1)))
         (close (string-index-of text delim (+ d 1))))
    (if (< close 0) (string-length text) (+ close 1))))

(define (-latex-fill-math-open-at? text i opener closer)
  "Whether an unescaped math OPENER (\\( or \\[) starts at I in TEXT and a
   matching unescaped CLOSER exists later — only then is the group
   atomized (an unclosed opener wraps as ordinary words). PURE."
  (and (>= (string-length text) (+ i 2))
       (string=? (substring text i (+ i 2)) opener)
       (not (-latex-fill-escaped? text i))
       (>= (-latex-fill-find-unescaped text closer (+ i 2)) 0)))

(define (-latex-fill-math-end text i closer)
  "The index just after the unescaped CLOSER matching the math opener at I
   in TEXT (the opener is known to be closed). PURE."
  (+ (-latex-fill-find-unescaped text closer (+ i 2)) 2))

(define (-latex-fill-find-unescaped text needle from)
  "The index of the first backslash-unescaped occurrence of NEEDLE
   at/after FROM in TEXT, or -1. PURE."
  (let ((p (string-index-of text needle from)))
    (cond
      ((< p 0) -1)
      ((-latex-fill-escaped? text p)
       (-latex-fill-find-unescaped text needle (+ p 1)))
      (else p))))

;; --- pure: word wrapping ----------------------------------------------
;; Wrap the token list into lines no longer than the fill column. The
;; FIRST line is prefixed with FIRST-INDENT, every continuation line with
;; REST-INDENT (they differ for \item, equal for plain prose). A single
;; token longer than the column is left on its own line (never split) —
;; AUCTeX does the same for an unbreakable construct.

(define (-latex-fill-wrap tokens first-indent rest-indent fill-column
                          brace-step)
  "Greedily wrap TOKENS ({:w :sep2} records) into a list of lines. The
   first line carries FIRST-INDENT, the rest REST-INDENT; no line exceeds
   FILL-COLUMN unless it holds a single over-long token. A :sep2 token
   keeps two spaces before it. When BRACE-STEP is non-zero (a
   paragraph-command unit), each continuation line indents an extra
   BRACE-STEP spaces per grouping brace still open where the break lands
   — AUCTeX's `TeX-brace-indent-level' rule — dedenting back after the
   closing `}'. PURE."
  (cond
    ((nil? tokens) (list))
    (else
     (-latex-fill-wrap-loop (cdr tokens)
                            (str first-indent (get (car tokens) :w ""))
                            rest-indent fill-column
                            (if (= brace-step 0)
                                0
                                (-latex-fill-brace-net (get (car tokens) :w "")))
                            brace-step (list)))))

(define (-latex-fill-wrap-loop tokens current rest-indent fill-column
                               braces brace-step acc)
  "Tail loop for `-latex-fill-wrap`: CURRENT is the line being built,
   BRACES the grouping-brace surplus of the tokens consumed so far, ACC
   the completed lines (reversed)."
  (cond
    ((nil? tokens) (reverse (cons current acc)))
    (else
     (let* ((tok (car tokens))
            (w (get tok :w ""))
            (sep (if (get tok :sep2 #f) "  " " "))
            (candidate (str current sep w))
            (nb (if (= brace-step 0)
                    0
                    (+ braces (-latex-fill-brace-net w)))))
       (if (> (string-length candidate) fill-column)
           ;; The token does not fit: flush CURRENT, start a new line
           ;; (brace-indented by the surplus open BEFORE this token).
           (-latex-fill-wrap-loop (cdr tokens)
                                  (str rest-indent
                                       (-latex-fill-spaces
                                        (* (if (> braces 0) braces 0)
                                           brace-step))
                                       w)
                                  rest-indent fill-column nb brace-step
                                  (cons current acc))
           (-latex-fill-wrap-loop (cdr tokens) candidate
                                  rest-indent fill-column nb brace-step
                                  acc))))))

;; --- pure: the pending prose/comment run --------------------------------
;; A "pending" run is a record of the text gathered so far and the
;; first/rest indents to wrap it with; :comment holds the %-run prefix
;; string for a comment run (nil for prose). A record whose :text is nil
;; is "ARMED": a code comment just ended the previous unit, and the next
;; prose line should start a fresh run AT THE SAME INDENTS (an item's
;; continuation level survives the interruption).

(define (-latex-fill-pending text first-indent rest-indent comment brace)
  "A fresh pending-run record from TEXT with the given indents; COMMENT is
   the %-run prefix for a comment run (nil for prose); BRACE is the
   per-open-brace continuation indent step (0 for prose/comments,
   `*latex-brace-indent-level*' for a paragraph-command unit)."
  (hash-map :text text :first first-indent :rest rest-indent
            :comment comment :brace brace))

(define (-latex-fill-pending-empty? pending)
  "Whether PENDING (a list = no run, or a record) holds no text to wrap.
   An ARMED record (indents but nil :text) counts as empty for flushing."
  (or (nil? pending)
      (and (list? pending) (nil? pending))
      (nil? (get pending :text nil))))

(define (-latex-fill-pending-comment pending)
  "The %-run prefix of PENDING's comment run, or nil for prose / no run."
  (if (or (nil? pending) (and (list? pending) (nil? pending)))
      nil
      (get pending :comment nil)))

(define (-latex-fill-pending-comment? pending)
  "Whether PENDING is a comment run (strict boolean)."
  (not (nil? (-latex-fill-pending-comment pending))))

(define (-latex-fill-armed pending fallback-indent)
  "An ARMED pending record carrying forward PENDING's rest indent (or
   FALLBACK-INDENT when PENDING has none): the next prose line starts a
   fresh run at that indent — how a unit continues after a trailing code
   comment ended it."
  (let ((r (if (or (nil? pending) (and (list? pending) (nil? pending)))
               fallback-indent
               (get pending :rest fallback-indent))))
    (hash-map :text nil :first r :rest r :comment nil :brace 0)))

(define (-latex-fill-extend-pending pending text first-indent rest-indent
                                    comment)
  "Append TEXT (one source line's trimmed content) to PENDING with the
   sentence-aware join separator. An empty PENDING starts a new run with
   the given indents and COMMENT prefix; an ARMED record starts the run at
   ITS OWN stored indents instead."
  (cond
    ((or (nil? pending) (and (list? pending) (nil? pending)))
     (-latex-fill-pending text first-indent rest-indent comment 0))
    ((nil? (get pending :text nil))
     (-latex-fill-pending text
                          (get pending :first first-indent)
                          (get pending :rest rest-indent)
                          (get pending :comment comment)
                          (get pending :brace 0)))
    (else
     (hash-map :text (str (get pending :text "")
                          (-latex-fill-join-sep (get pending :text ""))
                          text)
               :first (get pending :first first-indent)
               :rest (get pending :rest rest-indent)
               :comment (get pending :comment nil)
               :brace (get pending :brace 0)))))

(define (-latex-fill-flush pending acc fill-column)
  "Wrap PENDING's run (if any) to FILL-COLUMN onto ACC (reversed output
   lines), returning the new reversed ACC. An empty/armed run leaves ACC
   unchanged."
  (if (-latex-fill-pending-empty? pending)
      acc
      (-latex-fill-prepend-reversed
       (-latex-fill-wrap (-latex-fill-tokens (get pending :text ""))
                         (get pending :first "")
                         (get pending :rest "")
                         fill-column
                         (get pending :brace 0))
       acc)))

(define (-latex-fill-glue-comment pending cmt indent acc fill-column)
  "Flush PENDING and glue ` CMT` (a trailing %-comment, verbatim) onto the
   flushed run's LAST line — AUCTeX's code-comment rule: the comment ends
   the fill unit and is not itself filled (the line may exceed the column).
   An empty PENDING emits the comment alone at INDENT."
  (if (-latex-fill-pending-empty? pending)
      (cons (str indent cmt) acc)
      (let ((flushed (-latex-fill-flush pending acc fill-column)))
        (cons (str (car flushed) " " cmt) (cdr flushed)))))

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
;; filling skips them). We refuse to fill when POINT's innermost env is
;; one of these; when one appears INSIDE the filled block its body passes
;; through byte-identical (only the \begin/\end lines re-indent).

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
   commands so items and structure never merge. Comment paragraphs fill
   behind their %-run prefix; trailing code comments end their fill unit
   and stay glued; protected envs inside the block pass through
   byte-identical. Spaces only. PURE — string in, string out, no buffer."
  (-latex-fill-join-lines
   (-latex-fill-walk (string-split block "\n") base-depth level item-indent
                     fill-column (list) (list))))

(define (-latex-fill-walk lines depth level item-indent fill-column
                          pending acc)
  "Walk LINES tracking DEPTH; PENDING accumulates the prose/comment run
   currently being gathered (with its wrap indents), ACC the emitted
   output lines (reversed, each a final string). A structural or blank
   line flushes PENDING first. Returns the output lines in order."
  (cond
    ((nil? lines)
     (reverse (-latex-fill-flush pending acc fill-column)))
    (else
     (let* ((raw (car lines))
            (content (-latex-fill-trim-leading raw)))
       (cond
         ;; Blank line: flush any run, emit an empty line.
         ((-latex-fill-blank-line? raw)
          (-latex-fill-walk (cdr lines) depth level item-indent fill-column
                            (list)
                            (cons "" (-latex-fill-flush pending acc
                                                        fill-column))))
         ;; Comment-only line: fill as a comment paragraph behind the
         ;; %-run prefix. Runs of different %-depth never merge; a bare
         ;; `%' line is a boundary emitted as-is.
         ((-latex-fill-comment-line? content)
          (let* ((run (-latex-fill-comment-run content))
                 (body (-latex-fill-trim-trailing
                        (-latex-fill-trim-leading
                         (substring content (string-length run)
                                    (string-length content)))))
                 (prefix (str (-latex-fill-body-indent depth level) run " "))
                 (pc (-latex-fill-pending-comment pending)))
            (cond
              ((string=? body "")
               (-latex-fill-walk (cdr lines) depth level item-indent
                                 fill-column (list)
                                 (cons (str (-latex-fill-body-indent depth level)
                                            run)
                                       (-latex-fill-flush pending acc
                                                          fill-column))))
              ((and (not (nil? pc)) (string=? pc run))
               (-latex-fill-walk (cdr lines) depth level item-indent
                                 fill-column
                                 (-latex-fill-extend-pending pending body
                                                             prefix prefix run)
                                 acc))
              (else
               (-latex-fill-walk (cdr lines) depth level item-indent
                                 fill-column
                                 (-latex-fill-pending body prefix prefix run 0)
                                 (-latex-fill-flush pending acc
                                                    fill-column))))))
         ;; \begin{...}: flush, emit at outer level, then go one deeper —
         ;; UNLESS it is a non-indenting env (`document'), which keeps the
         ;; depth, or a PROTECTED env, whose body passes through verbatim.
         ((-latex-fill-begin-line? content)
          (let ((env (-latex-fill-env-name content)))
            (if (-latex-fill-protected-env? env)
                (-latex-fill-emit-protected
                 (cdr lines) env 0 depth level item-indent fill-column
                 (cons (str (-latex-fill-body-indent depth level)
                            (-latex-fill-trim-trailing content))
                       (-latex-fill-flush pending acc fill-column)))
                (let ((next (if (-latex-non-indenting-env? env)
                                depth
                                (+ depth 1))))
                  (-latex-fill-walk
                   (cdr lines) next level item-indent fill-column (list)
                   (cons (str (-latex-fill-body-indent depth level)
                              (-latex-fill-trim-trailing content))
                         (-latex-fill-flush pending acc fill-column)))))))
         ;; \end{...}: flush, dedent first, emit at the outer level — unless
         ;; a non-indenting env (`document'), which never changed the depth.
         ((-latex-fill-end-line? content)
          (let ((d (if (-latex-non-indenting-env? (-latex-fill-env-name content))
                       depth
                       (- depth 1))))
            (-latex-fill-walk
             (cdr lines) d level item-indent fill-column (list)
             (cons (str (-latex-fill-body-indent d level)
                        (-latex-fill-trim-trailing content))
                   (-latex-fill-flush pending acc fill-column)))))
         ;; \item / \bibitem: flush the previous unit, start a NEW run
         ;; seeded with the item's own text (so items never merge), first
         ;; line at item indent, continuations one step deeper. A trailing
         ;; code comment ends the unit with the comment glued on.
         ((-latex-fill-item-line? content)
          (let ((first-ind (-latex-fill-item-indent depth level item-indent))
                (rest-ind (-latex-fill-continuation-indent depth level))
                (acc0 (-latex-fill-flush pending acc fill-column))
                (cpos (-latex-fill-comment-pos content 0)))
            (if (< cpos 0)
                (-latex-fill-walk
                 (cdr lines) depth level item-indent fill-column
                 (-latex-fill-pending (-latex-fill-trim-trailing content)
                                      first-ind rest-ind nil 0)
                 acc0)
                (-latex-fill-walk
                 (cdr lines) depth level item-indent fill-column
                 (-latex-fill-armed (list) rest-ind)
                 (-latex-fill-glue-comment
                  (-latex-fill-pending
                   (-latex-fill-trim-trailing (substring content 0 cpos))
                   first-ind rest-ind nil 0)
                  (-latex-fill-trim-trailing
                   (substring content cpos (string-length content)))
                  first-ind acc0 fill-column)))))
         ;; Display math \[ / \]: a boundary that keeps its own unwrapped
         ;; line at the body level (its content is never re-broken).
         ((-latex-fill-display-math-line? content)
          (-latex-fill-walk
           (cdr lines) depth level item-indent fill-column (list)
           (cons (str (-latex-fill-body-indent depth level)
                      (-latex-fill-trim-trailing content))
                 (-latex-fill-flush pending acc fill-column))))
         ;; \noindent / \newblock LEAD IN a prose paragraph (AUCTeX: text
         ;; after the macro continues as an ordinary paragraph): flush the
         ;; previous unit, then treat this line as plain prose so the
         ;; following lines merge into it.
         ((-latex-fill-prose-lead-command-line? content)
          (-latex-fill-prose-line lines depth level item-indent fill-column
                                  (list)
                                  (-latex-fill-flush pending acc fill-column)
                                  content))
         ;; Paragraph command (\caption, \section, \par, …): its own fill
         ;; unit spanning the macro's extent — gathered while its braces
         ;; stay unclosed, wrapped with brace-indented continuations.
         ((-latex-fill-paragraph-command-line? content)
          (-latex-fill-emit-pcommand
           lines depth level item-indent fill-column
           (-latex-fill-flush pending acc fill-column)))
         ;; Plain prose.
         (else
          (-latex-fill-prose-line lines depth level item-indent fill-column
                                  pending acc content)))))))

(define (-latex-fill-prose-line lines depth level item-indent fill-column
                                pending acc content)
  "Handle one plain-prose line (CONTENT is (car LINES) left-trimmed):
   append its text to the current run — seeding the run's indents from
   the body level when it is the first line; a comment run in PENDING is
   flushed first, prose and comments never merge. A trailing code comment
   ends the unit: the code fills, the comment glues onto the last line,
   and the following lines resume at the unit's indent (ARMED record).
   Continues the walk on (cdr LINES)."
  (let* ((body-ind (-latex-fill-body-indent depth level))
         (comment? (-latex-fill-pending-comment? pending))
         (acc0 (if comment?
                   (-latex-fill-flush pending acc fill-column)
                   acc))
         (pend0 (if comment? (list) pending))
         (cpos (-latex-fill-comment-pos content 0)))
    (if (< cpos 0)
        (-latex-fill-walk
         (cdr lines) depth level item-indent fill-column
         (-latex-fill-extend-pending
          pend0 (-latex-fill-trim-trailing content)
          body-ind body-ind nil)
         acc0)
        (let ((pend1 (-latex-fill-extend-pending
                      pend0
                      (-latex-fill-trim-trailing
                       (substring content 0 cpos))
                      body-ind body-ind nil)))
          (-latex-fill-walk
           (cdr lines) depth level item-indent fill-column
           (-latex-fill-armed pend1 body-ind)
           (-latex-fill-glue-comment
            pend1
            (-latex-fill-trim-trailing
             (substring content cpos (string-length content)))
            body-ind acc0 fill-column))))))

;; --- the paragraph-command fill unit ------------------------------------
;; AUCTeX's `LaTeX-forward-paragraph`: a paragraph command's paragraph is
;; the MACRO'S EXTENT — a \caption{…} whose argument spans lines is one
;; unit through its closing `}'. The unit re-wraps to the fill column;
;; the wrap indents continuation lines `*latex-brace-indent-level*' per
;; brace still open at the break (see `-latex-fill-wrap`). A blank or
;; structural line ends the gather early (the runaway guard for an
;; unbalanced brace), and a trailing %-comment ends it with the comment
;; glued on, unfilled.

(define *latex-fill-prose-lead-commands* (list "noindent" "newblock"))

(define (-latex-fill-prose-lead-command-line? content)
  "Whether left-trimmed CONTENT starts with a paragraph command that
   LEADS IN prose (\\noindent, \\newblock) rather than carrying its own
   braced argument. PURE."
  (-latex-member? (-latex-fill-control-word content)
                  *latex-fill-prose-lead-commands*))

(define (-latex-fill-emit-pcommand lines depth level item-indent fill-column
                                   acc)
  "Fill the paragraph-command unit starting at (car LINES): the macro
   line plus following lines while its grouping braces stay unclosed.
   Resumes the walk on the remaining lines."
  (let* ((base (-latex-fill-body-indent depth level))
         (content (-latex-fill-trim-leading (car lines)))
         (cpos (-latex-fill-comment-pos content 0))
         (code (-latex-fill-trim-trailing
                (if (< cpos 0) content (substring content 0 cpos))))
         (cmt (if (< cpos 0)
                  nil
                  (-latex-fill-trim-trailing
                   (substring content cpos (string-length content)))))
         (pend (-latex-fill-pending code base base nil
                                    *latex-brace-indent-level*)))
    (if (and (nil? cmt) (> (-latex-fill-brace-net code) 0))
        (-latex-fill-pcommand-continue (cdr lines) depth level item-indent
                                       fill-column acc pend
                                       (-latex-fill-brace-net code))
        ;; Balanced on its own line (or comment-stopped): a
        ;; self-contained unit — wrap it now.
        (-latex-fill-walk (cdr lines) depth level item-indent fill-column
                          (list)
                          (if (nil? cmt)
                              (-latex-fill-flush pend acc fill-column)
                              (-latex-fill-glue-comment pend cmt base acc
                                                        fill-column))))))

(define (-latex-fill-pcommand-continue lines depth level item-indent
                                       fill-column acc pend deficit)
  "Gather the continuation lines of an open paragraph-command unit: PEND
   holds the text so far, DEFICIT its unclosed-brace surplus. The unit
   closes when the braces balance; a blank / structural / comment-only
   line closes it early (unbalanced-brace guard)."
  (cond
    ((nil? lines)
     (-latex-fill-walk lines depth level item-indent fill-column (list)
                       (-latex-fill-flush pend acc fill-column)))
    (else
     (let ((raw (car lines))
           (content (-latex-fill-trim-leading (car lines))))
       (if (or (-latex-fill-blank-line? raw)
               (-latex-fill-comment-line? content)
               (-latex-fill-boundary-line? content))
           (-latex-fill-walk lines depth level item-indent fill-column
                             (list)
                             (-latex-fill-flush pend acc fill-column))
           (let* ((cpos (-latex-fill-comment-pos content 0))
                  (code (-latex-fill-trim-trailing
                         (if (< cpos 0) content (substring content 0 cpos))))
                  (cmt (if (< cpos 0)
                           nil
                           (-latex-fill-trim-trailing
                            (substring content cpos
                                       (string-length content)))))
                  (pend2 (-latex-fill-extend-pending pend code "" "" nil))
                  (d2 (+ deficit (-latex-fill-brace-net code))))
             (if (and (nil? cmt) (> d2 0))
                 (-latex-fill-pcommand-continue (cdr lines) depth level
                                                item-indent fill-column
                                                acc pend2 d2)
                 (-latex-fill-walk
                  (cdr lines) depth level item-indent fill-column (list)
                  (if (nil? cmt)
                      (-latex-fill-flush pend2 acc fill-column)
                      (-latex-fill-glue-comment pend2 cmt "" acc
                                                fill-column))))))))))

(define (-latex-fill-emit-protected lines env nest depth level item-indent
                                    fill-column acc)
  "Emit LINES byte-identical (indentation and spacing preserved) until the
   \\end line closing the protected ENV opened just above; that closing
   line is emitted re-indented at DEPTH (the \\begin's level) and the
   normal walk resumes. Same-name nested \\begin{ENV} groups are tracked
   via NEST; an unterminated env runs to the end of the block. This is
   AUCTeX's `LaTeX-indent-environment-list' outcome: begin/end indent, the
   body is never refilled."
  (cond
    ((nil? lines)
     (-latex-fill-walk lines depth level item-indent fill-column (list) acc))
    (else
     (let* ((raw (car lines))
            (content (-latex-fill-trim-leading raw)))
       (cond
         ((and (-latex-fill-end-line? content)
               (string=? (-latex-fill-env-name content) env))
          (if (= nest 0)
              (-latex-fill-walk
               (cdr lines) depth level item-indent fill-column (list)
               (cons (str (-latex-fill-body-indent depth level)
                          (-latex-fill-trim-trailing content))
                     acc))
              (-latex-fill-emit-protected (cdr lines) env (- nest 1) depth
                                          level item-indent fill-column
                                          (cons raw acc))))
         ((and (-latex-fill-begin-line? content)
               (string=? (-latex-fill-env-name content) env))
          (-latex-fill-emit-protected (cdr lines) env (+ nest 1) depth
                                      level item-indent fill-column
                                      (cons raw acc)))
         (else
          (-latex-fill-emit-protected (cdr lines) env nest depth
                                      level item-indent fill-column
                                      (cons raw acc))))))))

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

;; --- pure: point restoration --------------------------------------------
;; Filling never adds or removes a non-whitespace character, so a position
;; in the old block maps to the new one by its count of non-whitespace
;; characters — AUCTeX keeps point at its place in the prose the same way.

(define (-latex-fill-map-offset old new rel)
  "Map REL (an offset into OLD) to the corresponding offset in NEW: the
   position with the same count of non-whitespace characters before it.
   When REL sits ON a non-whitespace character, the mapped offset sits on
   that same character in NEW. PURE."
  (if (and (< rel (string-length old))
           (not (-latex-fill-ws-char? (substring old rel (+ rel 1)))))
      (-latex-fill-offset-at-nth-solid new
                                       (+ (-latex-fill-count-solid old rel) 1))
      (-latex-fill-offset-after-nth-solid new
                                          (-latex-fill-count-solid old rel))))

(define (-latex-fill-count-solid s limit)
  "The number of non-whitespace characters in S strictly before LIMIT."
  (-latex-fill-count-solid-loop s 0 (min limit (string-length s)) 0))

(define (-latex-fill-count-solid-loop s i limit acc)
  (cond
    ((>= i limit) acc)
    ((-latex-fill-ws-char? (substring s i (+ i 1)))
     (-latex-fill-count-solid-loop s (+ i 1) limit acc))
    (else (-latex-fill-count-solid-loop s (+ i 1) limit (+ acc 1)))))

(define (-latex-fill-offset-at-nth-solid s n)
  "The index OF the N-th (1-based) non-whitespace character of S — the end
   of S when it has fewer. PURE."
  (-latex-fill-at-nth-loop s 0 n))

(define (-latex-fill-at-nth-loop s i n)
  (cond
    ((>= i (string-length s)) i)
    ((-latex-fill-ws-char? (substring s i (+ i 1)))
     (-latex-fill-at-nth-loop s (+ i 1) n))
    ((<= n 1) i)
    (else (-latex-fill-at-nth-loop s (+ i 1) (- n 1)))))

(define (-latex-fill-offset-after-nth-solid s n)
  "The index just AFTER the N-th (1-based) non-whitespace character of S
   (0 for N=0) — the end of S when it has fewer. PURE."
  (-latex-fill-after-nth-loop s 0 n))

(define (-latex-fill-after-nth-loop s i n)
  (cond
    ((<= n 0) i)
    ((>= i (string-length s)) i)
    ((-latex-fill-ws-char? (substring s i (+ i 1)))
     (-latex-fill-after-nth-loop s (+ i 1) n))
    (else (-latex-fill-after-nth-loop s (+ i 1) (- n 1)))))

;; --- the command ------------------------------------------------------

(defcommand latex-fill-paragraph ()
  "Re-wrap the paragraph around point the way AUCTeX's
   `LaTeX-fill-paragraph' does: fill prose to `*latex-fill-column*' and
   re-indent every line of the enclosing block by its LaTeX environment
   depth — nested environments, list items (itemize / enumerate /
   description), and the \\begin / \\end lines themselves — using spaces
   only (`*latex-indent-level*' spaces per level; \\item lines pulled back
   by `*latex-item-indent*' with continuations one level deeper).

   Comment paragraphs fill behind their %-run prefix; a code line's
   trailing comment ends its fill unit and stays glued, unfilled. Inline
   \\(…\\)/\\[…\\] math never breaks across lines when
   `*latex-fill-break-at-separators*' is on, and a \\verb group never
   breaks at all. Verbatim / tabular / math-alignment environments inside
   the block pass through byte-identical. Point stays at its position in
   the prose.

   The paragraph is the run of non-blank lines around point; structural
   lines (\\begin / \\end / \\item / display math) are re-indented in
   place and never merged into surrounding prose. A paragraph command
   (\\caption{…}, \\section{…}, …) is its own fill unit spanning the
   macro's extent — gathered to its closing `}' and re-wrapped, with
   continuation lines indented `*latex-brace-indent-level*' per brace
   still open at the break (AUCTeX's `TeX-brace-indent-level'). A blank
   line, or point inside a verbatim / tabular / math-alignment environment,
   leaves the buffer unchanged. Bound to M-q in latex-mode (overriding the
   global `fill-paragraph')."
  (let* ((text (buffer-text))
         (pt (point))
         (lines (string-split text "\n"))
         (cursor-line (-latex-fill-line-of-offset text pt))
         (bounds (-latex-fill-paragraph-bounds lines cursor-line)))
    (cond
      ((nil? bounds)
       (show-status! "Nothing to fill (blank line)"))
      ;; (car nil) throws in this Lisp — an empty open-env stack (point
      ;; outside every environment) must not reach `car'; it used to, so
      ;; M-q crashed on top-level prose.
      ((let ((stack (-latex-open-env-stack text pt)))
         (and (not (nil? stack))
              (-latex-fill-protected-env? (car stack))))
       (show-status! "latex-fill-paragraph: not filling a verbatim/math/tabular environment"))
      (else
       (let* ((start-line (car bounds))
              (end-line (cdr bounds))
              (from (-latex-fill-line-offset lines start-line))
              (to (+ (-latex-fill-line-offset lines end-line)
                     (string-length (nth lines end-line))))
              (base-depth (-latex-env-depth-at text from))
              (block (substring text from to))
              (filled (latex-fill-block block base-depth
                                        *latex-indent-level* *latex-item-indent*
                                        *latex-fill-column*)))
         (if (string=? filled block)
             (show-status! "Paragraph already filled")
             (begin
               (atomic-change-group
                 (delete-region! from to)
                 (goto! from)
                 (insert! filled))
               (goto! (+ from (-latex-fill-map-offset block filled
                                                      (- pt from))))
               (show-status! "Filled paragraph"))))))))

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
