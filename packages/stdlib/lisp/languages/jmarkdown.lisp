;;; jmarkdown.lisp — the JMarkdown major mode.
;;;
;;; JMarkdown is the architect's Markdown dialect (`.jmd`): a metadata
;;; header, `:::` directives, `@begin/@end` environments, remapped
;;; emphasis (`*bold*`, `/italic/`, `**intense**`, `__underline__`,
;;; `==highlight==`), citations, footnotes, embedded JS, TiKZ and
;;; Mermaid blocks. Highlighting and folding live in the renderer's
;;; `jmarkdown` tree-sitter language (see
;;; packages/renderer/src/languages/jmarkdown.js and jmarkdown-scan.js).
;;;
;;; The shared inline-formatting commands in markdown.lisp already
;;; speak JMarkdown (`markdown-bold` inserts `*…*`, `markdown-italic`
;;; `/…/`, `markdown-highlight` `==…==`, `markdown-insert-cite`
;;; `\cite{}`), so this mode binds those same commands and adds only
;;; the dialect-specific ones. Loaded after markdown.lisp (languages
;;; files load last), so the shared helpers are present.

(define jmarkdown-mode-map {})

(define-mode jmarkdown-mode
  :name "JMarkdown"
  :highlight :jmarkdown
  :keymap 'jmarkdown-mode-map
  ;; auto-fill-mode's continuation indenter (auto-fill.lisp's
  ;; :fill-indent-function seam). Stored as a symbol so it resolves live
  ;; and load order doesn't matter — the procedure is defined below. Kept
  ;; on the mode map (not set! after register-mode) so the registered
  ;; copy carries it. See `jmarkdown-fill-indent`.
  :fill-indent-function 'jmarkdown-fill-indent)

(register-mode ".jmd" jmarkdown-mode)

;; --- dialect-specific inline formatting ---------------------------------

(defcommand jmarkdown-intense ()
  "Make the selection intense (JMarkdown **...**, bold italic)."
  (surround "**" "**"))

(defcommand jmarkdown-underline ()
  "Underline the selection (JMarkdown __...__)."
  (surround "__" "__"))

(defcommand jmarkdown-insert-ref ()
  "Insert a :ref[...] cross-reference, with point on the key."
  (insert! ":ref[]")
  (goto! (- (point) 1)))

(defcommand jmarkdown-insert-label ()
  "Insert a :label[...] anchor, with point on the key."
  (insert! ":label[]")
  (goto! (- (point) 1)))

;; --- block templates ----------------------------------------------------

(define (-jmarkdown-block opener closer cursor-offset)
  "Insert an OPENER/CLOSER block pair, wrapping the selection as the
   body (an empty line when there is none), then place point
   CURSOR-OFFSET characters after the block's start."
  (let ((text (if (region-active?) (region-text) "")))
    (atomic-change-group
      (unless (equal? text "") (delete-backward!))
      (let ((p (point)))
        (insert! (str opener "\n" text "\n" closer))
        (goto! (+ p cursor-offset))))))

(defcommand jmarkdown-insert-directive ()
  "Insert a ::: directive block around the selection. With no
   selection, point is left after ::: to type the directive name."
  (-jmarkdown-block ":::" ":::" 3))

(defcommand jmarkdown-insert-environment ()
  "Insert an @begin()/@end() environment around the selection, with a
   cursor inside BOTH parens: type the name once and it lands in
   @begin(…) and @end(…) together. ESC (or C-g) collapses back to the
   single cursor when done."
  (let ((text (if (region-active?) (region-text) "")))
    (atomic-change-group
      (unless (equal? text "") (delete-backward!))
      (let ((p (point)))
        (insert! (str "@begin()\n" text "\n@end()"))
        ;; Primary cursor inside @begin(, secondary inside @end( — the
        ;; multi-cursor set mirrors typed input into both.
        (goto! (+ p 7))
        (add-selection! (+ p 15 (string-length text)))))))

(defcommand jmarkdown-insert-tikz ()
  "Insert a :::TiKZ block, with point on the (LaTeX) body line."
  (-jmarkdown-block ":::TiKZ" ":::" 8))

(defcommand jmarkdown-insert-mermaid ()
  "Insert a :::mermaid block, with point on the diagram body line."
  (-jmarkdown-block ":::mermaid" ":::" 11))

;; --- live inline math preview -------------------------------------------
;; Same machinery as markdown-mode: the general math-preview minor mode
;; (math-preview.lisp), scanning per the JMarkdown provider on the host
;; side (packages/renderer/src/math-preview-providers.js).

(defcustom *jmarkdown-math-preview-default* #f :boolean
  :group 'godot
  :doc "When #t, typeset math inline automatically for JMarkdown buffers.
   Off by default — opt in per-buffer with `toggle-jmarkdown-math-preview`,
   or set this in your init / customisation to default it on.")

(defcommand toggle-jmarkdown-math-preview ()
  "Toggle live inline MathJax typesetting for the current JMarkdown
   buffer. With it on, math segments render typeset in place of their
   source and flip back to source for editing when point enters them."
  (toggle-math-preview))

;; --- fill-paragraph (M-q), JMarkdown-aware --------------------------------
;; The generic `fill-paragraph!` bounds a paragraph only at blank lines,
;; so filling inside an @begin/@end environment swallowed the delimiter
;; lines into the prose. This fill (the latex-fill.lisp pattern: a pure,
;; unit-tested planner + a thin buffer command) bounds paragraphs at
;; structural lines — @begin/@end, ::: directives, ATX headings, fences,
;; dash rules — keeps the paragraph's own indent when re-wrapping, and
;; gives a long `@begin(env)[label]{attrs}` line its own treatment: the
;; @begin stays put and each [label] / {attrs} part wraps onto its own
;; line, indented one tab-width further.

(define *jmarkdown-fill-column* 72)

(define (-jmd-line-indent line)
  "LINE's leading whitespace, as a string. PURE."
  (substring line 0 (- (string-length line)
                       (string-length (drop-leading-blanks line)))))

(define (-jmd-begin-line? line)
  "Whether LINE opens an @begin(...) environment. PURE."
  (string-prefix? "@begin(" (drop-leading-blanks line)))

(define (-jmd-dash-rule? content)
  "Whether left-trimmed CONTENT is a dash rule (---…), a thematic break
   or a metadata-header fence. PURE."
  (and (>= (string-length content) 3)
       (equal? content (string-repeat "-" (string-length content)))))

(define (-jmd-fill-boundary? line)
  "Whether LINE bounds a fill unit: blank, an @begin/@end line, a :::
   directive line, an ATX heading, a code fence, or a dash rule. PURE."
  (let ((content (drop-leading-blanks line)))
    (or (equal? content "")
        (string-prefix? "@begin(" content)
        (string-prefix? "@end(" content)
        (string-prefix? ":::" content)
        ;; A flush-right / centred line (>> …) bounds an ordinary
        ;; paragraph; the aligned block is filled by its own plan branch.
        (string-prefix? ">>" content)
        (string-prefix? "#" content)
        (string-prefix? "```" content)
        (string-prefix? "~~~" content)
        (-jmd-dash-rule? content))))

;; --- structural prefixes: lists, ordered lists, blockquotes, definitions -
;; A paragraph's first line may open a list item (`- `, `* `, `+ `), an
;; ordered item (`1. `, `2) `), a description-list definition (`: `), or a
;; blockquote (`> `, nested `> > `). When such a paragraph is re-wrapped
;; (M-q) or auto-filled, the CONTINUATION lines want a hanging indent —
;; the list/definition marker replaced by spaces so the text stays
;; aligned, but a blockquote's `>` markers repeated verbatim. These pure
;; helpers compute that; `jmarkdown-fill-paragraph` and
;; `jmarkdown-fill-indent` share them so M-q and auto-fill agree.

(define (-jmd-space? c)
  "Whether the one-character string C is a space or tab. PURE."
  (or (equal? c " ") (equal? c "\t")))

(define (-jmd-count-spaces s i)
  "Index past the run of spaces/tabs in S starting at I. PURE."
  (if (and (< i (string-length s)) (-jmd-space? (substring s i (+ i 1))))
      (-jmd-count-spaces s (+ i 1))
      i))

(define (-jmd-count-digits s i)
  "Index past the run of decimal digits in S starting at I. PURE."
  (if (and (< i (string-length s))
           (string-contains? "0123456789" (substring s i (+ i 1))))
      (-jmd-count-digits s (+ i 1))
      i))

(define (-jmd-blockquote-walk s i)
  "Index past the blockquote run in S starting at I (`>` then optional
   spaces, repeated). PURE."
  (cond
    ((>= i (string-length s)) i)
    ((equal? (substring s i (+ i 1)) ">")
     (-jmd-blockquote-walk s (-jmd-count-spaces s (+ i 1))))
    (else i)))

(define (-jmd-blockquote-len s)
  "Length of the leading blockquote run in S (`>` characters each with
   optional trailing spaces, repeated) — S must have no leading
   whitespace. 0 when S is not a blockquote. PURE."
  (-jmd-blockquote-walk s 0))

(define (-jmd-ordered-marker-len s)
  "Length of an ordered-list marker (`digits` then `.` or `)` then at
   least one space, plus the spaces) at the start of S, or 0. PURE."
  (let ((d (-jmd-count-digits s 0)))
    (if (and (> d 0)
             (< (+ d 1) (string-length s))
             (member (substring s d (+ d 1)) (list "." ")"))
             (-jmd-space? (substring s (+ d 1) (+ d 2))))
        (-jmd-count-spaces s (+ d 1))
        0)))

(define (-jmd-marker-len s)
  "Length of a leading list / ordered / definition marker (with its
   trailing spaces) in S — S having no leading whitespace or blockquote.
   0 when S opens no such marker. Bullets: `- ` `* ` `+ `; ordered:
   `1. ` `2) `; description-list definition: `: `. PURE."
  (cond
    ((< (string-length s) 2) 0)
    ((and (member (substring s 0 1) (list "-" "*" "+"))
          (-jmd-space? (substring s 1 2)))
     (-jmd-count-spaces s 1))
    ;; `: ` opens a definition; `::`/`:::` are directives (handled as
    ;; boundaries elsewhere), and the space test excludes them here.
    ((and (equal? (substring s 0 1) ":") (-jmd-space? (substring s 1 2)))
     (-jmd-count-spaces s 1))
    (else (-jmd-ordered-marker-len s))))

(define (-jmd-structural-prefixes line)
  "For LINE, the pair (first-prefix . cont-prefix). FIRST-PREFIX is the
   leading whitespace + blockquote markers + the list/definition marker
   verbatim — what the first wrapped line keeps. CONT-PREFIX keeps the
   whitespace + blockquote markers but replaces the list/definition
   marker with spaces of equal width (the hanging indent for continuation
   lines). For a plain line both are just the leading indentation. PURE."
  (let* ((lead (-jmd-line-indent line))
         (rest (substring line (string-length lead)))
         (bq (-jmd-blockquote-len rest))
         (bq-str (substring rest 0 bq))
         (after-bq (substring rest bq))
         (mk (-jmd-marker-len after-bq)))
    (cons (str lead bq-str (substring after-bq 0 mk))
          (str lead bq-str (string-repeat " " mk)))))

(define (-jmd-strip-quote line)
  "LINE with its leading whitespace and any blockquote markers stripped —
   the raw text of a continuation line, ready for word collapsing. PURE."
  (let ((l (drop-leading-blanks line)))
    (drop-leading-blanks (substring l (-jmd-blockquote-len l)))))

;; --- aligned blocks: flush-right (>>) and centred (>> … <<) --------------
;; JMarkdown's two line-oriented alignment forms (docs/syntax-adjustments):
;; a line prefixed with the `>>` token is pushed flush right; a line that
;; ALSO ends with the `<<` token is centred (the trailing `<<` is what
;; distinguishes the two, and its column is free to pad). `>>` and `<<` are
;; whitespace-delimited TOKENS — `>> <<` is an aligned pair, `> > < <` is
;; not (docs/extensions-simple) — so detection requires whitespace after
;; `>>` and before `<<`, which also keeps them distinct from a `> `
;; blockquote. M-q reflows an aligned block like a blockquote: the run's
;; text is re-wrapped to the fill column, `>> ` kept on every line and (for
;; centred) `<<` re-aligned to the column.

(define (-jmd-rtrim-walk s n)
  (if (and (> n 0) (-jmd-space? (substring s (- n 1) n)))
      (-jmd-rtrim-walk s (- n 1))
      (substring s 0 n)))

(define (-jmd-rtrim s)
  "S without trailing spaces/tabs. PURE."
  (-jmd-rtrim-walk s (string-length s)))

(define (-jmd-aligned-line? line)
  "Whether LINE is an aligned line: after its leading whitespace it opens
   with the `>>` token (>> then whitespace, or >> alone). PURE."
  (let ((c (drop-leading-blanks line)))
    (and (string-prefix? ">>" c)
         (or (= (string-length c) 2)
             (-jmd-space? (substring c 2 3))))))

(define (-jmd-centred-line? line)
  "Whether LINE is a CENTRED aligned line: aligned and ending with the
   `<<` token (a space then `<<` at the end). PURE."
  (and (-jmd-aligned-line? line)
       (string-suffix? " <<" (-jmd-rtrim (drop-leading-blanks line)))))

(define (-jmd-strip-align line centred?)
  "The inner text of an aligned LINE: the `>>` opener (and following
   whitespace) removed, and for a CENTRED line the trailing `<<` (and the
   whitespace before it) too. PURE."
  (let ((after (drop-leading-blanks (substring (drop-leading-blanks line) 2))))
    (if centred?
        (let ((rt (-jmd-rtrim after)))
          (if (string-suffix? "<<" rt)
              (-jmd-rtrim (substring rt 0 (- (string-length rt) 2)))
              rt))
        (-jmd-rtrim after))))

(define (-jmd-aligned-content-line? line)
  "An aligned line that carries body text — not a bare `>>` / `>> <<`
   paragraph separator (which bounds sub-paragraphs like a blank line). PURE."
  (and (-jmd-aligned-line? line)
       (not (equal? (-jmd-strip-align line (-jmd-centred-line? line)) ""))))

(define (-jmd-centre-pad line fill-column)
  "Pad the `>> …` LINE with spaces and append `<<` so the closing marker
   lands at FILL-COLUMN, with at least one space before it. PURE."
  (let ((pad (- (- fill-column 2) (string-length line))))
    (str line (string-repeat " " (if (> pad 1) pad 1)) "<<")))

(define (-jmd-aligned-wrap words lead centred? fill-column)
  "Reflow WORDS as an aligned block at indent LEAD: `>> ` on every line,
   wrapped to FILL-COLUMN. For CENTRED, wrap shorter and append a
   column-aligned `<<`. PURE."
  (let ((prefix (str lead ">> ")))
    (if centred?
        (map (lambda (l) (-jmd-centre-pad l fill-column))
             (-jmd-wrap2 words prefix prefix (- fill-column 3)))
        (-jmd-wrap2 words prefix prefix fill-column))))

;; --- the metadata frontmatter (where syntax extensions are defined) ------
;; A JMarkdown document opens with a `---`-fenced metadata header carrying
;; Title:, Bibliography:, and multi-line `Extension …:` definitions (whose
;; indented replacement-HTML lines are whitespace-significant). Reflowing
;; any of that corrupts it, so fill never touches the frontmatter.

(define (-jmd-find-dash lines i)
  (cond
    ((nil? lines) -1)
    ((-jmd-dash-rule? (drop-leading-blanks (car lines))) i)
    (else (-jmd-find-dash (cdr lines) (+ i 1)))))

(define (-jmd-frontmatter-end lines)
  "If LINES opens with a `---` metadata fence (line 0 a dash rule), the
   index of its closing dash-rule line; else -1. PURE."
  (if (and (not (nil? lines))
           (-jmd-dash-rule? (drop-leading-blanks (car lines))))
      (-jmd-find-dash (cdr lines) 1)
      -1))

(define (-jmd-in-frontmatter? lines index)
  "Whether line INDEX sits strictly inside the `---` metadata frontmatter.
   The fence lines themselves are dash-rule boundaries already. PURE."
  (let ((end (-jmd-frontmatter-end lines)))
    (and (>= end 0) (> index 0) (< index end))))

;; --- small list/line helpers (the dialect's Lisp has no list-ref) ------

(define (-jmd-nth lst n)
  "Element N of LST, or nil past the end. PURE."
  (cond ((nil? lst) nil)
        ((<= n 0) (car lst))
        (else (-jmd-nth (cdr lst) (- n 1)))))

(define (-jmd-slice lst from to)
  "Elements FROM..TO (inclusive, 0-based) of LST. PURE."
  (cond ((nil? lst) (list))
        ((> from 0) (-jmd-slice (cdr lst) (- from 1) (- to 1)))
        ((< to 0) (list))
        (else (cons (car lst) (-jmd-slice (cdr lst) 0 (- to 1))))))

(define (-jmd-join lines)
  "LINES joined with newlines. PURE."
  (cond ((nil? lines) "")
        ((nil? (cdr lines)) (car lines))
        (else (str (car lines) "\n" (-jmd-join (cdr lines))))))

;; --- prose collapsing and wrapping --------------------------------------

(define (-jmd-collapse-walk s i acc prev-space?)
  (if (>= i (string-length s))
      acc
      (let ((c (substring s i (+ i 1))))
        (if (or (equal? c " ") (equal? c "\t") (equal? c "\n"))
            (-jmd-collapse-walk s (+ i 1) (if prev-space? acc (str acc " ")) #t)
            (-jmd-collapse-walk s (+ i 1) (str acc c) #f)))))

(define (-jmd-words s)
  "Whitespace-separated words of S, in order. PURE."
  (filter (lambda (w) (not (equal? w "")))
          (string-split (-jmd-collapse-walk s 0 "" #t) " ")))

(define (-jmd-wrap2-walk words current cont-prefix fill-column acc)
  (cond
    ((nil? words) (reverse (cons current acc)))
    (else
     (let ((candidate (str current " " (car words))))
       (if (> (string-length candidate) fill-column)
           (-jmd-wrap2-walk (cdr words) (str cont-prefix (car words))
                            cont-prefix fill-column (cons current acc))
           (-jmd-wrap2-walk (cdr words) candidate cont-prefix fill-column acc))))))

(define (-jmd-wrap2 words first-prefix cont-prefix fill-column)
  "WORDS greedily wrapped at FILL-COLUMN, the first line prefixed with
   FIRST-PREFIX and every continuation line with CONT-PREFIX; an over-long
   word keeps its own line. When the two prefixes are equal this is a
   plain indented wrap. PURE."
  (if (nil? words)
      (list)
      (-jmd-wrap2-walk (cdr words) (str first-prefix (car words))
                       cont-prefix fill-column (list))))

(define (-jmd-para-body para first-prefix)
  "PARA (a paragraph's line list) as one string with structural prefixes
   removed: the first line loses FIRST-PREFIX, each continuation line its
   leading whitespace and blockquote markers — ready for -jmd-words. PURE."
  (-jmd-join
    (cons (substring (car para) (string-length first-prefix))
          (map -jmd-strip-quote (cdr para)))))

(define (-jmd-aligned-edge lines index delta)
  "The last aligned-CONTENT line index reachable from INDEX by DELTA
   (+1/-1) without crossing a non-content line (a separator, a plain line,
   or the buffer edge). PURE."
  (let ((next (+ index delta)))
    (if (or (< next 0)
            (nil? (-jmd-nth lines next))
            (not (-jmd-aligned-content-line? (-jmd-nth lines next))))
        index
        (-jmd-aligned-edge lines next delta))))

(define (-jmd-aligned-body block centred?)
  "BLOCK (an aligned-line list) joined into one text string, each line's
   `>>` (and `<<`) sigils stripped. PURE."
  (-jmd-join (map (lambda (l) (-jmd-strip-align l centred?)) block)))

(define (-jmd-aligned-plan lines cursor fill-column)
  "Plan the reflow of the flush-right / centred block at line CURSOR.
   Returns nil (nothing to do) or (start end . replacement-lines). PURE."
  (let* ((centred? (-jmd-centred-line? (-jmd-nth lines cursor)))
         (start (-jmd-aligned-edge lines cursor -1))
         (end (-jmd-aligned-edge lines cursor 1))
         (block (-jmd-slice lines start end))
         (lead (-jmd-line-indent (-jmd-nth lines cursor)))
         (wrapped (-jmd-aligned-wrap
                   (-jmd-words (-jmd-aligned-body block centred?))
                   lead centred? fill-column)))
    (if (equal? wrapped block)
        nil
        (cons start (cons end wrapped)))))

;; --- the @begin(...) line treatment --------------------------------------

(define (-jmd-scan-balanced line i open close)
  "Index one past the closer matching the OPEN at index I in LINE
   (depth-counting), or -1 when unclosed. PURE."
  (-jmd-balanced-walk line (+ i 1) open close 1))

(define (-jmd-balanced-walk line i open close depth)
  (cond
    ((>= i (string-length line)) -1)
    (else
     (let ((c (substring line i (+ i 1))))
       (cond
         ((equal? c open) (-jmd-balanced-walk line (+ i 1) open close (+ depth 1)))
         ((and (equal? c close) (= depth 1)) (+ i 1))
         ((equal? c close) (-jmd-balanced-walk line (+ i 1) open close (- depth 1)))
         (else (-jmd-balanced-walk line (+ i 1) open close depth)))))))

(define (-jmd-begin-parts-walk line i acc)
  "Collect the [..] / {..} parts (and any trailing text) of an @begin
   line from index I. Returns the parts in order. PURE."
  (cond
    ((>= i (string-length line)) (reverse acc))
    ((equal? (substring line i (+ i 1)) " ")
     (-jmd-begin-parts-walk line (+ i 1) acc))
    ((equal? (substring line i (+ i 1)) "[")
     (let ((end (-jmd-scan-balanced line i "[" "]")))
       (if (< end 0)
           (reverse (cons (substring line i) acc))
           (-jmd-begin-parts-walk line end (cons (substring line i end) acc)))))
    ((equal? (substring line i (+ i 1)) "{")
     (let ((end (-jmd-scan-balanced line i "{" "}")))
       (if (< end 0)
           (reverse (cons (substring line i) acc))
           (-jmd-begin-parts-walk line end (cons (substring line i end) acc)))))
    (else (reverse (cons (drop-leading-blanks (substring line i)) acc)))))

(define (-jmd-split-begin line)
  "Split an @begin line into (head . parts): HEAD is the indent plus
   `@begin(name)`, PARTS the [..] / {..} pieces and any trailing text.
   Nil when the line has no closing paren. PURE."
  (let* ((indent (-jmd-line-indent line))
         (close (-jmd-scan-balanced line
                                    (+ (string-length indent) 6) "(" ")")))
    (if (< close 0)
        nil
        (cons (substring line 0 close)
              (-jmd-begin-parts-walk line close (list))))))

(define (-jmd-wrap-begin line fill-column step)
  "The replacement lines for a too-long @begin line: the @begin(name)
   alone at its own indent, each [..] / {..} part on its own line
   indented STEP further. Nil when the line already fits or carries no
   parts. PURE."
  (if (<= (string-length line) fill-column)
      nil
      (let ((parsed (-jmd-split-begin line)))
        (if (or (nil? parsed) (nil? (cdr parsed)))
            nil
            (let ((part-indent (str (-jmd-line-indent line)
                                    (string-repeat " " step))))
              (cons (car parsed)
                    (map (lambda (p) (str part-indent p)) (cdr parsed))))))))

;; --- the pure fill planner ------------------------------------------------

(define (-jmd-para-edge lines index delta)
  "The last line index reachable from INDEX by DELTA (+1/-1) without
   crossing a fill boundary. PURE."
  (let ((next (+ index delta)))
    (if (or (< next 0)
            (nil? (-jmd-nth lines next))
            (-jmd-fill-boundary? (-jmd-nth lines next)))
        index
        (-jmd-para-edge lines next delta))))

(define (-jmd-in-fence? lines index)
  "Whether line INDEX sits inside a fenced code block — an odd number
   of fence lines precede it. Fenced code is never filled. PURE."
  (-jmd-fence-walk lines 0 index #f))

(define (-jmd-fence-walk lines i index inside?)
  (cond
    ((or (>= i index) (nil? lines)) inside?)
    (else
     (let ((content (drop-leading-blanks (car lines))))
       (-jmd-fence-walk (cdr lines) (+ i 1) index
                        (if (or (string-prefix? "```" content)
                                (string-prefix? "~~~" content))
                            (not inside?)
                            inside?))))))

(define (jmarkdown-fill-plan lines cursor fill-column step)
  "Plan the JMarkdown-aware fill for the line list LINES with point on
   line CURSOR. Returns nil when there is nothing to do, else
   (start end . replacement-lines): replace lines START..END inclusive
   with the replacement. PURE — fully unit-testable."
  (let ((line (-jmd-nth lines cursor)))
    (cond
      ((nil? line) nil)
      ;; The metadata frontmatter (syntax-extension definitions etc.) is
      ;; whitespace-significant and never filled.
      ((-jmd-in-frontmatter? lines cursor) nil)
      ((-jmd-in-fence? lines cursor) nil)
      ((-jmd-begin-line? line)
       (let ((replacement (-jmd-wrap-begin line fill-column step)))
         (if (nil? replacement)
             nil
             (cons cursor (cons cursor replacement)))))
      ;; A flush-right (>>) / centred (>> … <<) block reflows like a
      ;; blockquote, keeping its sigils on every line.
      ((-jmd-aligned-content-line? line)
       (-jmd-aligned-plan lines cursor fill-column))
      ;; Any other structural line (@end, :::, heading, fence, rule, a bare
      ;; >> / >> << separator, blank): nothing to fill.
      ((-jmd-fill-boundary? line) nil)
      (else
       (let* ((start (-jmd-para-edge lines cursor -1))
              (end (-jmd-para-edge lines cursor 1))
              (para (-jmd-slice lines start end))
              (prefixes (-jmd-structural-prefixes (car para)))
              (wrapped (-jmd-wrap2 (-jmd-words
                                    (-jmd-para-body para (car prefixes)))
                                   (car prefixes) (cdr prefixes)
                                   fill-column)))
         (if (equal? wrapped para)
             nil
             (cons start (cons end wrapped))))))))

;; --- the command -----------------------------------------------------------

(define (-jmd-line-offset lines n)
  "The buffer offset of line N's first character. PURE over LINES."
  (if (or (<= n 0) (nil? lines))
      0
      (+ (string-length (car lines)) 1
         (-jmd-line-offset (cdr lines) (- n 1)))))

(define (-jmd-line-index lines offset)
  "The index of the line containing buffer OFFSET. PURE over LINES."
  (-jmd-line-index-walk lines offset 0))

(define (-jmd-line-index-walk lines offset i)
  (cond
    ((nil? lines) (- i 1))
    ((<= offset (string-length (car lines))) i)
    (else (-jmd-line-index-walk (cdr lines)
                                (- offset (+ (string-length (car lines)) 1))
                                (+ i 1)))))

(defcommand jmarkdown-fill-paragraph ()
  "Fill the paragraph at point, JMarkdown-aware (M-q). Structural lines
   — @begin/@end, ::: directives, headings, fences, dash rules — bound
   the paragraph instead of being swallowed into it, the re-wrapped
   text keeps the paragraph's indent, and fenced code is never filled.
   With point on a too-long @begin(...) line, the @begin(name) keeps
   its line and each [label] / {attributes} part wraps onto its own
   line, indented one tab-width further."
  (let* ((lines (string-split (buffer-text) "\n"))
         (cursor (-jmd-line-index lines (point)))
         (plan (jmarkdown-fill-plan lines cursor *jmarkdown-fill-column*
                                    (-tab-width-effective))))
    (unless (nil? plan)
      (let* ((start (car plan))
             (end (car (cdr plan)))
             (replacement (cdr (cdr plan)))
             (from (-jmd-line-offset lines start))
             (to (+ (-jmd-line-offset lines end)
                    (string-length (-jmd-nth lines end)))))
        (atomic-change-group
          (delete-region! from to)
          (goto! from)
          (insert! (-jmd-join replacement)))))))

;; --- fill-indent-function: the auto-fill continuation indenter -----------
;; auto-fill-mode (auto-fill.lisp) breaks a too-long line and then calls
;; the major mode's :fill-indent-function with point at the start of the
;; new continuation line. For JMarkdown that means: reproduce the broken
;; line's *continuation* prefix (list/definition marker → hanging spaces,
;; blockquote `>` markers repeated, plain prose → its indent), so a
;; wrapped list item stays aligned under its text and a blockquote keeps
;; its `>`. The same -jmd-structural-prefixes M-q uses, so they agree.

(define (-jmd-bol-before offset)
  "The beginning-of-line offset for OFFSET: scan back to just after the
   previous newline (or buffer start). Reads the buffer."
  (cond
    ((<= offset 0) 0)
    ((equal? (buffer-substring (- offset 1) offset) "\n") offset)
    (else (-jmd-bol-before (- offset 1)))))

(define (jmarkdown-fill-indent)
  "auto-fill-mode's :fill-indent-function for JMarkdown. Point is at the
   start of the freshly-broken continuation line; indent it with the
   paragraph's hanging prefix, read from the line just above."
  (let ((ls (line-start)))
    (when (> ls 0)
      (let* ((prev (buffer-substring (-jmd-bol-before (- ls 1)) (- ls 1)))
             (cont (cdr (-jmd-structural-prefixes prev))))
        (unless (equal? cont "")
          (insert! cont))))))

;; --- TAB / S-TAB: indent / dedent the selection -------------------------
;; With a region active, TAB indents and S-TAB outdents the lines it
;; touches (the same `indent-region` / `outdent-region` as M-] / M-[, on
;; the Tab keys). Snippet navigation must still win: an active snippet
;; field is usually SELECTED, so we defer to `snippet-tab` /
;; `snippet-shift-tab` whenever a snippet is active — those also handle
;; trigger-expansion and the plain `insert-tab` fallback, so non-selection
;; TAB behaviour is unchanged.

(defcommand jmarkdown-tab ()
  "TAB — indent the selected lines by one level when a region is active
   (and no snippet is running), else the normal TAB (snippet field /
   expand / insert-tab)."
  (if (and (region-active?) (not (snippet-active?)))
      (indent-region)
      (snippet-tab)))

(defcommand jmarkdown-backtab ()
  "S-TAB — outdent the selected lines by one level when a region is
   active (and no snippet is running), else step to the previous snippet
   field (a no-op when no snippet is active)."
  (if (and (region-active?) (not (snippet-active?)))
      (outdent-region)
      (snippet-shift-tab)))

;; --- the jmarkdown-mode keymap ------------------------------------------
;; C-c is the prefix, mirroring markdown-mode's map for the shared
;; commands and adding the dialect's own.

(define jmarkdown-c-c-map
  {"b" 'markdown-bold
   "i" 'markdown-italic
   "e" 'jmarkdown-intense
   "u" 'jmarkdown-underline
   "c" 'markdown-code
   "h" 'markdown-highlight
   "l" 'markdown-insert-link
   "k" 'markdown-insert-cite
   "f" 'markdown-insert-footnote
   "r" 'jmarkdown-insert-ref
   "a" 'jmarkdown-insert-label
   "d" 'jmarkdown-insert-directive
   "@" 'jmarkdown-insert-environment
   "t" 'jmarkdown-insert-tikz
   "g" 'jmarkdown-insert-mermaid
   "q" 'markdown-blockquote
   "-" 'markdown-list-item
   "1" 'markdown-heading-1
   "2" 'markdown-heading-2
   "3" 'markdown-heading-3
   "4" 'markdown-heading-4
   "5" 'markdown-heading-5
   "6" 'markdown-heading-6
   "m" 'toggle-math-mode
   "v" 'markdown-preview
   "C-v" 'markdown-preview-sync
   "C-p" 'toggle-jmarkdown-math-preview})

;; M-q overrides keymap.lisp's global generic fill with the
;; JMarkdown-aware one (the latex-mode-map does the same).
(set! jmarkdown-mode-map
      {"C-c" jmarkdown-c-c-map
       "M-q" 'jmarkdown-fill-paragraph
       ;; TAB / S-TAB indent / dedent the selection (snippets still win).
       "tab" 'jmarkdown-tab
       "S-tab" 'jmarkdown-backtab})

;; --- the jmarkdown-mode menu --------------------------------------------

(register-mode-menu! "JMarkdown"
  (list
    (cons "Format"
          (list (cons "Bold" 'markdown-bold)
                (cons "Italic" 'markdown-italic)
                (cons "Intense" 'jmarkdown-intense)
                (cons "Underline" 'jmarkdown-underline)
                (cons "Highlight" 'markdown-highlight)
                (cons "Inline Code" 'markdown-code)
                (cons "Fill Paragraph" 'jmarkdown-fill-paragraph)))
    (cons "Insert"
          (list (cons "Link" 'markdown-insert-link)
                (cons "Citation" 'markdown-insert-cite)
                (cons "Footnote" 'markdown-insert-footnote)
                (cons "Cross-reference" 'jmarkdown-insert-ref)
                (cons "Label" 'jmarkdown-insert-label)))
    (cons "Blocks"
          (list (cons "Directive (:::)" 'jmarkdown-insert-directive)
                (cons "Environment (@begin)" 'jmarkdown-insert-environment)
                (cons "TiKZ Diagram" 'jmarkdown-insert-tikz)
                (cons "Mermaid Diagram" 'jmarkdown-insert-mermaid)
                (cons "Blockquote" 'markdown-blockquote)
                (cons "List Item" 'markdown-list-item)))
    (cons "Headings"
          (list (cons "Heading 1" 'markdown-heading-1)
                (cons "Heading 2" 'markdown-heading-2)
                (cons "Heading 3" 'markdown-heading-3)
                (cons "Heading 4" 'markdown-heading-4)
                (cons "Heading 5" 'markdown-heading-5)
                (cons "Heading 6" 'markdown-heading-6)))
    (cons "Preview & Math"
          (list (cons "Toggle Preview Pane" 'markdown-preview)
                (cons "Toggle Math Preview" 'toggle-jmarkdown-math-preview)
                (cons "Toggle Math Symbols" 'toggle-math-mode)))))
