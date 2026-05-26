;;; yaml.lisp — the YAML major mode.

(define-mode yaml-mode
  :name "YAML"
  :comment-prefix "# "
  :highlight :yaml)

(register-mode ".yaml" yaml-mode)
(register-mode ".yml"  yaml-mode)
