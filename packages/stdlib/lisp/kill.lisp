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

(define (kill-ring-length)
  "The number of entries in the kill ring."
  (length *kill-ring*))

(define (kill-ring-ref index)
  "The kill at INDEX (0 is the most recent), or an empty string when the
   ring is empty. INDEX wraps around the ring."
  (if (nil? *kill-ring*)
      ""
      (nth *kill-ring* (mod index (kill-ring-length)))))

;; --- yank state --------------------------------------------------------
;;
;; `yank` records where it inserted text so a following `yank-pop` can
;; find and replace it. `*yank-start*` is the offset of the inserted
;; text, `*yank-length*` its length, and `*yank-index*` which kill it
;; came from (0 = the most recent). The state is only meaningful when the
;; command just run was `yank` or `yank-pop` (see `yank-pop`).

(define *yank-start* 0)
(define *yank-length* 0)
(define *yank-index* 0)

(define (record-yank! start text index)
  "Remember that TEXT (from kill INDEX) was inserted at offset START, so
   a following `yank-pop` can replace it."
  (set! *yank-start* start)
  (set! *yank-length* (string-length text))
  (set! *yank-index* index))

(defcommand copy-region ()
  "Copy the selected text to the kill ring."
  (when (region-active?)
    (kill-ring-add! (region-text))
    (clear-mark!)))

(defcommand kill-region ()
  "Cut the selected text to the kill ring."
  (when (region-active?)
    (kill-ring-add! (region-text))
    (delete-backward!)))

(defcommand kill-line ()
  "Kill from the cursor to the end of the line; at a line's end, kill
   the newline."
  (let ((from (point))
        (to (line-end)))
    (when (> (buffer-length) from)
      (let ((end (if (< from to) to (+ from 1))))
        (kill-ring-add! (buffer-substring from end))
        (delete-region! from end)))))

(defcommand yank ()
  "Insert the most recent kill at the cursor. Records the insertion so a
   following `yank-pop` (M-y) can cycle through the kill ring."
  (let ((start (point))
        (text (kill-ring-top)))
    (insert! text)
    (record-yank! start text 0)))

(defcommand kill-word ()
  "Kill forward to the end of the next word."
  (let ((from (point))
        (to (word-forward-offset)))
    (when (> to from)
      (kill-ring-add! (buffer-substring from to))
      (delete-region! from to))))

(defcommand kill-sentence ()
  "Kill forward to the end of the sentence."
  (let ((from (point))
        (to (sentence-forward-offset)))
    (when (> to from)
      (kill-ring-add! (buffer-substring from to))
      (delete-region! from to))))

(defcommand backward-kill-word ()
  "Kill backward to the start of the previous word."
  (let ((from (point))
        (to (word-backward-offset)))
    (when (< to from)
      (kill-ring-add! (buffer-substring to from))
      (delete-region! to from))))
