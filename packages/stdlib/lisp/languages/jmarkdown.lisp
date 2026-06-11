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
  :keymap 'jmarkdown-mode-map)

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
    (unless (equal? text "") (delete-backward!))
    (let ((p (point)))
      (insert! (str opener "\n" text "\n" closer))
      (goto! (+ p cursor-offset)))))

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
    (unless (equal? text "") (delete-backward!))
    (let ((p (point)))
      (insert! (str "@begin()\n" text "\n@end()"))
      ;; Primary cursor inside @begin(, secondary inside @end( — the
      ;; multi-cursor set mirrors typed input into both.
      (goto! (+ p 7))
      (add-selection! (+ p 15 (string-length text))))))

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
  :group 'jmacs
  :doc "When #t, typeset math inline automatically for JMarkdown buffers.
   Off by default — opt in per-buffer with `toggle-jmarkdown-math-preview`,
   or set this in your init / customisation to default it on.")

(defcommand toggle-jmarkdown-math-preview ()
  "Toggle live inline MathJax typesetting for the current JMarkdown
   buffer. With it on, math segments render typeset in place of their
   source and flip back to source for editing when point enters them."
  (toggle-math-preview))

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
   "C-p" 'toggle-jmarkdown-math-preview})

(set! jmarkdown-mode-map {"C-c" jmarkdown-c-c-map})

;; --- the jmarkdown-mode menu --------------------------------------------

(register-mode-menu! "JMarkdown"
  (list
    (cons "Format"
          (list (cons "Bold" 'markdown-bold)
                (cons "Italic" 'markdown-italic)
                (cons "Intense" 'jmarkdown-intense)
                (cons "Underline" 'jmarkdown-underline)
                (cons "Highlight" 'markdown-highlight)
                (cons "Inline Code" 'markdown-code)))
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
