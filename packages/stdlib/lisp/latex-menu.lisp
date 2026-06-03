;;; latex-menu.lisp — the structured (grouped) LaTeX mode menu.
;;;
;;; latex-mode binds enough commands that its flat auto-menu
;;; (`mode-menu-entries`) is one long list. This file registers a
;;; structured menu — a list of named sections — so the host shows
;;; grouped submenus instead. The mechanism (`register-mode-menu!` /
;;; `mode-menu-sections` in menus.lisp) is generic and additive: the
;;; flat menu is unchanged, and modes without a registration keep it.
;;;
;;; Loaded LAST among the LaTeX/RefTeX files (see STDLIB_FILES) so every
;;; command symbol named below already exists. Each section is
;;;   (section-label (friendly-label . command-symbol) …)
;;; The host resolves each command's keys and docstring from the flat
;;; `mode-menu-entries` data, so commands here need only be named.

(register-mode-menu! "LaTeX"
  (list
    (cons "Compile & View"
          (list (cons "Compile" 'latex-compile)
                (cons "View PDF" 'latex-view)
                (cons "Next Error" 'latex-next-error)
                (cons "Previous Error" 'latex-previous-error)
                (cons "Show Output" 'latex-show-output)))
    (cons "Insert"
          (list (cons "Environment…" 'latex-insert-environment)
                (cons "Close Environment" 'latex-close-environment)
                (cons "Macro…" 'latex-insert-macro)
                (cons "Section…" 'latex-insert-section)
                (cons "Itemize" 'latex-itemize)
                (cons "Enumerate" 'latex-enumerate)))
    (cons "Fonts"
          (list (cons "Bold" 'latex-textbf)
                (cons "Italic" 'latex-textit)
                (cons "Emphasis" 'latex-emph)
                (cons "Typewriter" 'latex-texttt)
                (cons "Small Caps" 'latex-textsc)
                (cons "Slanted" 'latex-textsl)
                (cons "Roman" 'latex-textrm)
                (cons "Sans Serif" 'latex-textsf)
                (cons "Medium" 'latex-textmd)))
    (cons "Math"
          (list (cons "Toggle Math Preview" 'toggle-latex-math-preview)
                (cons "Toggle Math Mode" 'toggle-latex-math-mode)
                (cons "Inline Math" 'latex-math-inline)
                (cons "Display Math" 'latex-math-display)))
    (cons "References"
          (list (cons "Insert Label" 'reftex-label)
                (cons "Insert Reference…" 'reftex-reference)
                (cons "Reference (minibuffer)" 'reftex-reference-minibuffer)
                (cons "Reparse Document" 'reftex-reparse)))
    (cons "Navigation"
          (list (cons "Next Section" 'latex-next-section)
                (cons "Previous Section" 'latex-previous-section)
                (cons "Goto Matching Env" 'latex-goto-matching-env)))))
