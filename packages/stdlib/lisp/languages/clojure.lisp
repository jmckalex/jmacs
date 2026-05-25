;;; clojure.lisp — the Clojure major mode.

(define-mode clojure-mode
  :name "Clojure"
  :comment-prefix ";; "
  :highlight :clojure)

(register-mode ".clj"  clojure-mode)
(register-mode ".cljs" clojure-mode)
(register-mode ".cljc" clojure-mode)
(register-mode ".edn"  clojure-mode)
