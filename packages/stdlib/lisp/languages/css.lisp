;;; css.lisp — the CSS major mode.

(define-mode css-mode
  :name "CSS"
  :comment-prefix "/* "
  :highlight :css)

(register-mode ".css" css-mode)
