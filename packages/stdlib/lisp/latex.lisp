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
   "n" 'latex-enumerate})

(set! latex-mode-map {"C-c" latex-c-c-map})
