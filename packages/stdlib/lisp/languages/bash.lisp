;;; bash.lisp — the Bash major mode.

(define-mode bash-mode
  :name "Bash"
  :comment-prefix "# "
  :highlight :bash)

(register-mode ".sh"   bash-mode)
(register-mode ".bash" bash-mode)
