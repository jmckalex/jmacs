;;; perl.lisp — the Perl major mode.

(define-mode perl-mode
  :name "Perl"
  :comment-prefix "# "
  :highlight :perl)

(register-mode ".pl"   perl-mode)
(register-mode ".pm"   perl-mode)
(register-mode ".t"    perl-mode)
(register-mode ".psgi" perl-mode)
(register-mode ".perl" perl-mode)
