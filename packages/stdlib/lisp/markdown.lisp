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
   "v" 'markdown-preview})

;; markdown-mode-map is declared empty in modes.lisp; fill it in here.
(set! markdown-mode-map {"C-c" markdown-c-c-map})
