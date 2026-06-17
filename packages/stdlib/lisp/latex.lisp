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
;; $$…$$, \[…\]) — and, in LaTeX, \begin…\end math environments — is shown
;; typeset in place of its source, flipping back to editable source when
;; point enters it. The scan/typeset/cache and the replaced-range
;; rendering live in the renderer (packages/renderer/src/math-preview.js),
;; with the LaTeX scanning config chosen by the buffer's major mode (see
;; math-preview-providers.js). OFF by default — opt in per buffer with
;; `toggle-latex-math-preview` (C-c C-p), or globally via the defcustom
;; below.
;;
;; This is now built on the GENERAL math-preview minor mode defined in
;; math-preview.lisp: `latex-math-preview-mode` is an alias of
;; `math-preview-mode`, and the toggle/binding below are preserved exactly
;; so the LaTeX UX is unchanged. The host recognises the (general) mode on
;; a LaTeX buffer and the LaTeX provider scans it as before.

(defcustom *latex-math-preview-default* #f :boolean
  :group 'godot
  :doc "When #t, typeset math inline automatically for LaTeX buffers.
   Off by default — opt in per-buffer with `toggle-latex-math-preview`,
   or set this in your init / customisation to default it on.")

;; `latex-math-preview-mode` is the general `math-preview-mode` under its
;; historical name. Aliasing (not a second `define-mode`) keeps host
;; membership checks — which compare the resolved `math-preview-mode` map
;; by identity — working for LaTeX buffers toggled either way.
(define latex-math-preview-mode math-preview-mode)

(defcommand toggle-latex-math-preview ()
  "Toggle live inline MathJax typesetting for the current LaTeX buffer.
   With it on, math segments render typeset in place of their source and
   flip back to source for editing when point enters them."
  (toggle-math-preview))

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
