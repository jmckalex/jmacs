;;; dockerfile.lisp — the Dockerfile major mode.

(define-mode dockerfile-mode
  :name "Dockerfile"
  :comment-prefix "# "
  :highlight :dockerfile)

(register-mode "Dockerfile"  dockerfile-mode)
(register-mode ".dockerfile" dockerfile-mode)
