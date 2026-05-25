;;; c.lisp — the C major mode.

(define-mode c-mode
  :name "C"
  :comment-prefix "// "
  :highlight :c)

(register-mode ".c" c-mode)
(register-mode ".h" c-mode)
