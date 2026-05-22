;;; line-ops.lisp — whole-line editing commands.
;;;
;;; Four commands that act on lines rather than characters:
;;; `move-line-up` / `move-line-down` swap the current line with its
;;; neighbour; `duplicate-line` copies it below; `join-line` pulls the
;;; next line onto the end of the current one. All are ordinary Lisp
;;; built on the buffer primitives — no host change.

;; --- line geometry helpers ---------------------------------------------

(define (current-line-text)
  "The text of the line the cursor is on, without its newline."
  (buffer-substring (line-start) (line-end)))

(define (line-column)
  "The cursor's offset within its line (0 at the line start)."
  (- (point) (line-start)))

(define (last-line?)
  "True when the cursor's line is the buffer's final line — there is
   no newline after `line-end`."
  (>= (line-end) (buffer-length)))

(define (first-line?)
  "True when the cursor's line is the buffer's first line."
  (= (line-start) 0))

(define (drop-leading-blanks s)
  "S with any leading spaces and tabs removed."
  (cond
    ((= (string-length s) 0) s)
    ((or (string-prefix? " " s) (string-prefix? "\t" s))
     (drop-leading-blanks (substring s 1)))
    (else s)))

;; --- moving a line up or down ------------------------------------------
;;
;; Both commands work by deleting the current line together with one
;; bounding newline, then re-inserting it on the other side of the
;; neighbour. The cursor is restored to the same column on the moved
;; line so it travels with the text.

(defcommand move-line-up ()
  "Move the current line up one, swapping it with the line above.
   The cursor keeps its column and travels with the line."
  (when (not (first-line?))
    (let ((col (line-column))
          (text (current-line-text))
          (start (line-start))
          (end (line-end)))
      ;; Remove the line and the newline that precedes it.
      (delete-region! (- start 1) end)
      ;; The cursor is now on what was the previous line; its start is
      ;; where the moved line must be re-inserted.
      (let ((above (line-start)))
        (goto! above)
        (insert! (str text "\n"))
        (goto! (+ above col))))))

(defcommand move-line-down ()
  "Move the current line down one, swapping it with the line below.
   The cursor keeps its column and travels with the line."
  (when (not (last-line?))
    (let ((col (line-column))
          (text (current-line-text))
          (start (line-start))
          (end (line-end)))
      ;; Remove the line and the newline that follows it.
      (delete-region! start (+ end 1))
      ;; The cursor now sits at the start of what was the next line;
      ;; step to that line's end and re-insert below it.
      (goto! start)
      (let ((below-end (line-end)))
        (goto! below-end)
        (insert! (str "\n" text))
        (goto! (+ (line-start) col))))))

;; --- duplicating a line ------------------------------------------------

(defcommand duplicate-line ()
  "Insert a copy of the current line immediately below it. The cursor
   moves to the copy, keeping its column."
  (let ((col (line-column))
        (text (current-line-text))
        (end (line-end)))
    (goto! end)
    (insert! (str "\n" text))
    (goto! (+ (line-start) col))))

;; --- joining lines -----------------------------------------------------

(defcommand join-line ()
  "Join the next line onto the end of the current one: the intervening
   newline and the next line's leading whitespace collapse to a single
   space (Emacs-style). The cursor lands at the join."
  (when (not (last-line?))
    (let ((end (line-end)))
      (goto! end)
      ;; From the line end, the next line starts after one newline.
      (let* ((next-start (+ end 1))
             (rest (buffer-substring next-start (buffer-length)))
             (trimmed (drop-leading-blanks rest))
             (consumed (- (string-length rest) (string-length trimmed))))
        ;; Replace the newline and the leading blanks with one space.
        (delete-region! end (+ next-start consumed))
        (insert! " ")
        (goto! end)))))
