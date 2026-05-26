;;; scheme.lisp — the Scheme major mode.

(define-mode scheme-mode
  :name "Scheme"
  :comment-prefix ";; "
  :highlight :scheme)

(register-mode ".scm" scheme-mode)
(register-mode ".ss"  scheme-mode)
(register-mode ".sld" scheme-mode)
(register-mode ".sps" scheme-mode)
(register-mode ".sls" scheme-mode)
