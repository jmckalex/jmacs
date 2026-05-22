;;; python.lisp — the Python major mode.

(define-mode python-mode
  :name "Python"
  :comment-prefix "# "
  :highlight :python)

(register-mode ".py" python-mode)
