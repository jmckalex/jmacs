;;; buffers.lisp — commands for working with several open buffers.
;;;
;;; The editor holds a list of buffers with one current. These commands
;;; wrap host primitives that change which buffer is current and
;;; re-point the editor view at it.

(define (next-buffer)
  "Switch to the next buffer in the list."
  (next-buffer!))

(define (previous-buffer)
  "Switch to the previous buffer in the list."
  (previous-buffer!))

(define (new-buffer)
  "Create a fresh empty buffer and switch to it."
  (new-buffer!))

(define (switch-buffer)
  "Switch to a buffer chosen by name, with completion."
  (start-buffer-switcher!))
