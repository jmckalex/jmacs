;;; yank-pop.lisp — browse the kill ring after a yank.
;;;
;;; After `yank` (C-y) inserts the most recent kill, `yank-pop` (M-y)
;;; replaces it with the *previous* kill, and repeated `M-y` keeps
;;; cycling back through the ring. This is Emacs's `yank-pop`.
;;;
;;; `yank-pop` is only valid immediately after a `yank` or another
;;; `yank-pop` — it relies on the yank state recorded in `kill.lisp`
;;; (`*yank-start*`, `*yank-length*`, `*yank-index*`) and on the command
;;; history (`*last-command*`) recorded by `run-command`. When run after
;;; any other command it does nothing but report.

(define (after-yank?)
  "True when the command just run was `yank` or `yank-pop`, so the yank
   state describes a real, still-current insertion."
  (or (eq? *last-command* 'yank)
      (eq? *last-command* 'yank-pop)))

(defcommand yank-pop ()
  "Replace the text of the last `yank` with the previous kill in the
   ring; repeated invocations cycle back through it. Valid only
   immediately after a `yank` or `yank-pop`."
  (cond
    ((not (after-yank?))
     (println "yank-pop: previous command was not a yank"))
    ((nil? *kill-ring*)
     (println "yank-pop: the kill ring is empty"))
    (else
     (let* ((next-index (+ *yank-index* 1))
            (text (kill-ring-ref next-index))
            (start *yank-start*)
            (end (+ start *yank-length*)))
       ;; delete-region! leaves the cursor at START; insert! there.
       (delete-region! start end)
       (insert! text)
       (record-yank! start text next-index)))))
