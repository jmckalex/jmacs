;;; buffers.lisp — commands for working with several open buffers.
;;;
;;; The editor holds a list of buffers with one current. These commands
;;; wrap host primitives that change which buffer is current and
;;; re-point the editor view at it.

(defcommand next-buffer ()
  "Switch to the next buffer in the list."
  (next-buffer!))

(defcommand previous-buffer ()
  "Switch to the previous buffer in the list."
  (previous-buffer!))

(defcommand new-buffer ()
  "Create a fresh empty buffer and switch to it."
  (new-buffer!))

(defcommand switch-buffer ()
  "Switch to a buffer chosen by name, with completion."
  (start-buffer-switcher!))

(defcommand kill-buffer ()
  "Remove the current buffer from the list and switch to the next
   one. Killing the last buffer creates a fresh empty `*scratch*`
   so the list is never empty. Bound to `C-x k`."
  (kill-buffer!))
