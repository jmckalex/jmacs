;;; markdown.lisp — Markdown / JMarkdown writing commands and the
;;; AUCTeX-style math symbol minor mode. Loaded after modes.lisp and
;;; keymap.lisp; it fills in markdown-mode-map.

;; --- helpers -----------------------------------------------------------
(define (surround opener closer)
  "Wrap the selection in OPENER and CLOSER, or — with no selection —
   insert the pair and place the cursor between them."
  (if (region-active?)
      (let ((text (region-text)))
        (delete-backward!)
        (insert! (str opener text closer)))
      (begin
        (insert! (str opener closer))
        (goto! (- (point) (string-length closer))))))

(define (insert-at-line-start text)
  "Insert TEXT at the start of the current line."
  (let ((p (point)))
    (goto! (line-start))
    (insert! text)
    (goto! (+ p (string-length text)))))

;; --- inline formatting -------------------------------------------------
(defcommand markdown-bold ()
  "Make the selection strong (JMarkdown *...*)."
  (surround "*" "*"))

(defcommand markdown-italic ()
  "Make the selection emphasised (JMarkdown /.../)."
  (surround "/" "/"))

(defcommand markdown-code ()
  "Make the selection inline code."
  (surround "`" "`"))

(defcommand markdown-highlight ()
  "Highlight the selection (==...==)."
  (surround "==" "=="))

(defcommand markdown-insert-link ()
  "Insert a link, wrapping the selection as the link text."
  (if (region-active?)
      (let ((text (region-text)))
        (delete-backward!)
        (insert! (str "[" text "]()"))
        (goto! (- (point) 1)))
      (begin
        (insert! "[]()")
        (goto! (- (point) 3)))))

(defcommand markdown-insert-cite ()
  "Insert a JMarkdown \\cite{} citation."
  (insert! "\\cite{}")
  (goto! (- (point) 1)))

(defcommand markdown-insert-footnote ()
  "Insert a JMarkdown footnote."
  (insert! "[^: ]")
  (goto! (- (point) 3)))

;; --- block structure ---------------------------------------------------
(defcommand markdown-heading-1 () "Make the line a level-1 heading." (insert-at-line-start "# "))
(defcommand markdown-heading-2 () "Make the line a level-2 heading." (insert-at-line-start "## "))
(defcommand markdown-heading-3 () "Make the line a level-3 heading." (insert-at-line-start "### "))
(defcommand markdown-heading-4 () "Make the line a level-4 heading." (insert-at-line-start "#### "))
(defcommand markdown-heading-5 () "Make the line a level-5 heading." (insert-at-line-start "##### "))
(defcommand markdown-heading-6 () "Make the line a level-6 heading." (insert-at-line-start "###### "))
(defcommand markdown-blockquote () "Make the line a blockquote." (insert-at-line-start "> "))
(defcommand markdown-list-item () "Make the line a list item." (insert-at-line-start "- "))

;; --- live preview ------------------------------------------------------
(defcommand markdown-preview ()
  "Toggle the live Markdown preview pane. It renders the current
   markdown-mode buffer to HTML through the JMarkdown pipeline and
   refreshes as the buffer is edited."
  (markdown-preview!))

;; --- preview styling ---------------------------------------------------
;; The preview renders into an isolated iframe, so it can carry its own
;; CSS without affecting (or being affected by) the editor chrome.
;;   *markdown-preview-css* — a list of stylesheet file paths the iframe
;;     links, e.g. your book's CSS. Absolute or ~ paths are served as-is;
;;     a relative path resolves against the previewed file's directory.
;;     Set it in init.lisp, e.g. (set! *markdown-preview-css*
;;       (list "~/book/style.css")).
;;   *markdown-preview-default-style* — link the built-in stylesheet;
;;     turn off to let your own CSS fully own the look.
(define *markdown-preview-css* (list))

(defcustom *markdown-preview-default-style* #t :boolean
  :group 'jmacs
  :doc "Link the built-in Markdown-preview stylesheet in the preview iframe. Turn off to let your own *markdown-preview-css* fully control the preview's appearance.")

;; --- live inline math preview -----------------------------------------
;; Markdown gets the same live MathJax typesetting LaTeX does, built on
;; the general `math-preview-mode` (math-preview.lisp). The host scans a
;; markdown buffer with the *common* config: $…$, $$…$$, \(…\), \[…\] —
;; but NOT \begin…\end environments (those aren't display math in prose).
;; OFF by default — opt in per buffer with `toggle-markdown-math-preview`
;; (C-c C-p), or globally via the defcustom below.

(defcustom *markdown-math-preview-default* #f :boolean
  :group 'jmacs
  :doc "When #t, typeset math inline automatically for Markdown buffers.
   Off by default — opt in per-buffer with `toggle-markdown-math-preview`,
   or set this in your init / customisation to default it on.")

(defcommand toggle-markdown-math-preview ()
  "Toggle live inline MathJax typesetting for the current Markdown buffer.
   With it on, math segments render typeset in place of their source and
   flip back to source for editing when point enters them."
  (toggle-math-preview))

;; --- math symbol minor mode -------------------------------------------
;; AUCTeX-style: with math mode on, ` then a key inserts a LaTeX symbol.
;; ` followed by an unmapped key inserts that key (so ` ` gives a `).
(define *math-symbols*
  {"a" "\\alpha"    "b" "\\beta"     "g" "\\gamma"    "d" "\\delta"
   "e" "\\epsilon"  "z" "\\zeta"     "h" "\\eta"      "q" "\\theta"
   "i" "\\iota"     "k" "\\kappa"    "l" "\\lambda"   "m" "\\mu"
   "n" "\\nu"       "x" "\\xi"       "p" "\\pi"       "r" "\\rho"
   "s" "\\sigma"    "t" "\\tau"      "u" "\\upsilon"  "f" "\\phi"
   "c" "\\chi"      "y" "\\psi"      "w" "\\omega"
   "G" "\\Gamma"    "D" "\\Delta"    "Q" "\\Theta"    "L" "\\Lambda"
   "X" "\\Xi"       "P" "\\Pi"       "S" "\\Sigma"    "F" "\\Phi"
   "Y" "\\Psi"      "W" "\\Omega"
   "8" "\\infty"    "+" "\\sum"      "*" "\\prod"     "6" "\\partial"
   "I" "\\int"      "A" "\\forall"   "E" "\\exists"   "0" "\\emptyset"
   "<" "\\leq"      ">" "\\geq"      "~" "\\approx"   "=" "\\equiv"
   "." "\\cdot"     "v" "\\nabla"})

(defcommand math-insert-symbol ()
  "Read a key and insert the LaTeX math symbol it names; an unmapped
   key is inserted as itself."
  (read-next-key
    (lambda (key)
      (insert! (get *math-symbols* key key)))))

(define math-mode-map {"`" 'math-insert-symbol})

(define-mode math-mode
  :name "Math"
  :keymap 'math-mode-map
  :priority 10)

(defcommand toggle-math-mode ()
  "Toggle the math symbol-insertion minor mode."
  (if (member math-mode (minor-modes))
      (disable-minor-mode math-mode)
      (enable-minor-mode math-mode)))

;; --- the markdown-mode keymap -----------------------------------------
;; C-c is the prefix for the writing commands.
(define markdown-c-c-map
  {"b" 'markdown-bold
   "i" 'markdown-italic
   "c" 'markdown-code
   "h" 'markdown-highlight
   "l" 'markdown-insert-link
   "k" 'markdown-insert-cite
   "f" 'markdown-insert-footnote
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
   "C-p" 'toggle-markdown-math-preview})

;; markdown-mode-map is declared empty in modes.lisp; fill it in here.
(set! markdown-mode-map {"C-c" markdown-c-c-map})

;; --- the markdown-mode menu -------------------------------------------
;; A structured (grouped) menu, like latex-menu.lisp. Kept here rather
;; than in a separate file because every command is defined above in this
;; same file; menus.lisp (which defines register-mode-menu!) loads before
;; markdown.lisp, so the call is safe. Each section is
;;   (section-label (friendly-label . command-symbol) …)
;; and the host resolves each command's keybinding and docstring from the
;; flat `mode-menu-entries` data, so commands need only be named here.
(register-mode-menu! "Markdown"
  (list
    (cons "Format"
          (list (cons "Bold" 'markdown-bold)
                (cons "Italic" 'markdown-italic)
                (cons "Inline Code" 'markdown-code)
                (cons "Highlight" 'markdown-highlight)))
    (cons "Insert"
          (list (cons "Link" 'markdown-insert-link)
                (cons "Citation" 'markdown-insert-cite)
                (cons "Footnote" 'markdown-insert-footnote)))
    (cons "Headings"
          (list (cons "Heading 1" 'markdown-heading-1)
                (cons "Heading 2" 'markdown-heading-2)
                (cons "Heading 3" 'markdown-heading-3)
                (cons "Heading 4" 'markdown-heading-4)
                (cons "Heading 5" 'markdown-heading-5)
                (cons "Heading 6" 'markdown-heading-6)))
    (cons "Blocks"
          (list (cons "Blockquote" 'markdown-blockquote)
                (cons "List Item" 'markdown-list-item)))
    (cons "Preview & Math"
          (list (cons "Toggle Preview Pane" 'markdown-preview)
                (cons "Toggle Math Preview" 'toggle-markdown-math-preview)
                (cons "Toggle Math Symbols" 'toggle-math-mode)))))
