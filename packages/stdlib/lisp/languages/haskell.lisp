;;; haskell.lisp — the Haskell major mode.

(define-mode haskell-mode
  :name "Haskell"
  :comment-prefix "-- "
  :highlight :haskell)

(register-mode ".hs"  haskell-mode)
(register-mode ".lhs" haskell-mode)
