;;; html.lisp — the HTML major mode.

(define-mode html-mode
  :name "HTML"
  :highlight :html)

(register-mode ".html" html-mode)
(register-mode ".htm"  html-mode)
