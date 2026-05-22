;;; javascript.lisp — the JavaScript major mode.
;;;
;;; The canonical example of "how to add a language" on the Lisp side.
;;; A language is two files: this one (mode + suffix mapping) and the
;;; JS-side registration in
;;; `packages/renderer/src/languages/javascript.js`. Both are dropped
;;; in; no other file changes. See the README beside this one.

(define-mode javascript-mode
  :name "JavaScript"
  :comment-prefix "// "
  :highlight :javascript)

(register-mode ".js"  javascript-mode)
(register-mode ".mjs" javascript-mode)
