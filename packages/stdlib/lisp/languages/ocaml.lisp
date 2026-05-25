;;; ocaml.lisp — the OCaml major mode.

(define-mode ocaml-mode
  :name "OCaml"
  :comment-prefix "(* "
  :highlight :ocaml)

(register-mode ".ml"  ocaml-mode)
(register-mode ".mli" ocaml-mode)
