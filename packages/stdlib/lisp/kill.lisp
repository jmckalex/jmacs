;;; kill.lisp — the kill ring (cut, copy, paste).
;;;
;;; The kill ring is ordinary Lisp state: a list of killed strings,
;;; most recent first. The commands are built on the buffer primitives.

(define *kill-ring* (list))

(define (kill-ring-add! text)
  "Push TEXT onto the kill ring."
  (set! *kill-ring* (cons text *kill-ring*)))

(define (kill-ring-top)
  "The most recent kill, or an empty string when the ring is empty."
  (if (nil? *kill-ring*) "" (car *kill-ring*)))

(define (copy-region)
  "Copy the selected text to the kill ring."
  (when (region-active?)
    (kill-ring-add! (region-text))
    (clear-mark!)))

(define (kill-region)
  "Cut the selected text to the kill ring."
  (when (region-active?)
    (kill-ring-add! (region-text))
    (delete-backward!)))

(define (kill-line)
  "Kill from the cursor to the end of the line; at a line's end, kill
   the newline."
  (let ((from (point))
        (to (line-end)))
    (when (> (buffer-length) from)
      (let ((end (if (< from to) to (+ from 1))))
        (kill-ring-add! (buffer-substring from end))
        (delete-region! from end)))))

(define (yank)
  "Insert the most recent kill at the cursor."
  (insert! (kill-ring-top)))

(define (kill-word)
  "Kill forward to the end of the next word."
  (let ((from (point))
        (to (word-forward-offset)))
    (when (> to from)
      (kill-ring-add! (buffer-substring from to))
      (delete-region! from to))))

(define (backward-kill-word)
  "Kill backward to the start of the previous word."
  (let ((from (point))
        (to (word-backward-offset)))
    (when (< to from)
      (kill-ring-add! (buffer-substring to from))
      (delete-region! to from))))
