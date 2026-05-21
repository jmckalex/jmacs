;;; search.lisp — search commands.
;;;
;;; The interactive search loop runs in the minibuffer (host code); this
;;; command starts it.

(define (isearch-forward)
  "Begin an incremental forward search in the current buffer."
  (start-search!))
