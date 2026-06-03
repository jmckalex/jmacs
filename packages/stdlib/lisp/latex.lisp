;;; latex.lisp — LaTeX writing commands. Loaded after modes.lisp and
;;; keymap.lisp; it fills in latex-mode-map.

(define (latex-surround opener closer)
  "Wrap the selection in OPENER and CLOSER, or insert the pair with
   the cursor between them."
  (if (region-active?)
      (let ((text (region-text)))
        (delete-backward!)
        (insert! (str opener text closer)))
      (begin
        (insert! (str opener closer))
        (goto! (- (point) (string-length closer))))))

(defcommand latex-textbf ()
  "Wrap the selection in \\textbf{…}."
  (latex-surround "\\textbf{" "}"))

(defcommand latex-textit ()
  "Wrap the selection in \\textit{…}."
  (latex-surround "\\textit{" "}"))

(defcommand latex-emph ()
  "Wrap the selection in \\emph{…}."
  (latex-surround "\\emph{" "}"))

(defcommand latex-math-inline ()
  "Wrap the selection in $…$."
  (latex-surround "$" "$"))

(defcommand latex-math-display ()
  "Wrap the selection in \\[ … \\]."
  (latex-surround "\\[ " " \\]"))

(defcommand latex-section ()
  "Wrap the selection in \\section{…}."
  (latex-surround "\\section{" "}"))

(defcommand latex-subsection ()
  "Wrap the selection in \\subsection{…}."
  (latex-surround "\\subsection{" "}"))

(defcommand latex-itemize ()
  "Insert a stub itemize environment with the cursor after \\item."
  (insert! "\\begin{itemize}\n  \\item ")
  (let ((p (point)))
    (insert! "\n\\end{itemize}\n")
    (goto! p)))

(defcommand latex-enumerate ()
  "Insert a stub enumerate environment."
  (insert! "\\begin{enumerate}\n  \\item ")
  (let ((p (point)))
    (insert! "\n\\end{enumerate}\n")
    (goto! p)))

;; --- live inline math preview (latex-math-preview) --------------------
;; A per-buffer minor mode: when on, each math segment ($…$, \(…\),
;; $$…$$, \[…\]) is shown typeset in place of its source, flipping back
;; to editable source when point enters it. The scan/typeset/cache and
;; the replaced-range rendering live in the renderer
;; (packages/renderer/src/latex-math-preview.js); this mode is the
;; per-buffer on/off switch the host reads to decide whether to feed the
;; renderer the math segments. OFF by default — opt in per buffer with
;; `toggle-latex-math-preview`, or globally via the defcustom below.

(defcustom *latex-math-preview-default* #f :boolean
  :group 'jmacs
  :doc "When #t, typeset math inline automatically for LaTeX buffers.
   Off by default — opt in per-buffer with `toggle-latex-math-preview`,
   or set this in your init / customisation to default it on.")

;; The mode carries no keymap of its own; it is a pure display toggle.
;; The host watches its membership in the buffer's minor modes (it is
;; checked on the renderer's update path) and supplies / withholds the
;; math replaced-ranges accordingly.
(define-mode latex-math-preview-mode
  :name "MathPreview"
  :priority 5)

(defcommand toggle-latex-math-preview ()
  "Toggle live inline MathJax typesetting for the current LaTeX buffer.
   With it on, math segments render typeset in place of their source and
   flip back to source for editing when point enters them."
  (if (member latex-math-preview-mode (minor-modes))
      (disable-minor-mode latex-math-preview-mode)
      (enable-minor-mode latex-math-preview-mode)))

;; The C-c prefix mirrors markdown-mode-map's pattern.
(define latex-c-c-map
  {"b" 'latex-textbf
   "i" 'latex-textit
   "e" 'latex-emph
   "m" 'latex-math-inline
   "M" 'latex-math-display
   "s" 'latex-section
   "S" 'latex-subsection
   "l" 'latex-itemize
   "n" 'latex-enumerate
   "C-p" 'toggle-latex-math-preview})

(set! latex-mode-map {"C-c" latex-c-c-map})
