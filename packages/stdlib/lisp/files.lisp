;;; files.lisp — file commands.
;;;
;;; These wrap host primitives (open-file!, save-buffer!) that the
;;; desktop app provides: the actual dialog and filesystem work happens
;;; in the Electron main process, reached over IPC.

(define (find-file)
  "Open a file, replacing the current buffer's contents."
  (open-file!))

(define (save-buffer)
  "Save the current buffer to its file."
  (save-buffer!))
