;;; nix.lisp — the Nix major mode.

(define-mode nix-mode
  :name "Nix"
  :comment-prefix "# "
  :highlight :nix)

(register-mode ".nix" nix-mode)
