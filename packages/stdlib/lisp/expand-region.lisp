;;; expand-region.lisp — grow the region structurally with one key.
;;;
;;; `expand-region` (C-=) is the editor's "select the next bigger thing"
;;; command. Each press grows the active region one structural step:
;;;
;;;   no region → the current word
;;;            → the current line
;;;            → the current paragraph
;;;            → the whole buffer
;;;
;;; Repeated presses keep growing — the previous-command check (the same
;;; trick `yank-pop` uses) detects whether this is an adjacent press in a
;;; growing sequence or a fresh start. Any other command between presses
;;; resets the chain, so the next C-= starts again at the word step.
;;;
;;; Implementation note. The bounds at each step are computed as pure
;;; functions of the buffer text and an anchor offset (the point where
;;; the chain began). The anchor is remembered in `*expand-region-anchor*`
;;; so each step grows around the *same* original cursor position rather
;;; than drifting as the region's edges move.

;; --- the growth state --------------------------------------------------

;; The point where the current expansion chain began. Re-captured at the
;; first press in a chain (when *last-command* is not expand-region).
(define *expand-region-anchor* 0)

;; The step the most recent press grew to: 0 means none, 1 word, 2 line,
;; 3 paragraph, 4 buffer.
(define *expand-region-step* 0)

;; The maximum step. Once at the buffer, further presses are no-ops.
(define *expand-region-max-step* 4)

;; --- pure helpers: structural bounds -----------------------------------
;;
;; Each helper takes a TEXT and an offset and returns a (start . end)
;; pair, or nil when no such structural unit applies at the offset. They
;; do not touch the buffer.

;; Word characters: letters, digits and underscore. We probe membership
;; with `string-contains?` since the Lisp has no character predicates.
(define *expand-region-word-chars*
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")

(define (-word-char? ch)
  "True when CH (a one-character string) is part of a word."
  (and (= (string-length ch) 1)
       (string-contains? *expand-region-word-chars* ch)))

(define (-char-at text pos)
  "The one-character string at POS in TEXT, or the empty string when
   POS is out of range."
  (if (or (< pos 0) (>= pos (string-length text)))
      ""
      (substring text pos (+ pos 1))))

(define (-scan-back text pos pred)
  "The smallest offset reachable from POS by stepping back over chars
   for which PRED is true. Stops at the buffer start."
  (if (and (> pos 0) (pred (-char-at text (- pos 1))))
      (-scan-back text (- pos 1) pred)
      pos))

(define (-scan-forward text pos pred)
  "The largest offset reachable from POS by stepping forward over chars
   for which PRED is true. Stops at the buffer end."
  (if (and (< pos (string-length text)) (pred (-char-at text pos)))
      (-scan-forward text (+ pos 1) pred)
      pos))

(define (expand-region-word-bounds text pos)
  "The (start . end) of the word at or adjacent to POS in TEXT, or nil
   when POS is not inside or beside a word. POS counts as inside a word
   when the character at POS or just before POS is a word character."
  (let ((here (-word-char? (-char-at text pos)))
        (prev (-word-char? (-char-at text (- pos 1)))))
    (cond
      (here
        (cons (-scan-back text pos -word-char?)
              (-scan-forward text pos -word-char?)))
      (prev
        ;; POS sits just after a word — anchor in that word.
        (cons (-scan-back text (- pos 1) -word-char?)
              (-scan-forward text (- pos 1) -word-char?)))
      (else nil))))

(define (-line-start-of text pos)
  "The offset of the start of the line containing POS in TEXT — that is,
   the position just after the previous newline (or 0)."
  (-scan-back text pos (lambda (ch) (not (equal? ch "\n")))))

(define (-line-end-of text pos)
  "The offset of the end of the line containing POS in TEXT — that is,
   the position of the next newline (or buffer end)."
  (-scan-forward text pos (lambda (ch) (not (equal? ch "\n")))))

(define (expand-region-line-bounds text pos)
  "The (start . end) of the line containing POS in TEXT, excluding the
   trailing newline. Always succeeds (every offset is on a line)."
  (cons (-line-start-of text pos) (-line-end-of text pos)))

(define (-line-blank? text line-start line-end)
  "True when the line between LINE-START and LINE-END contains nothing
   but spaces and tabs."
  (let ((s (substring text line-start line-end)))
    (= (string-length (drop-leading-blanks s)) 0)))

(define (-paragraph-start text pos)
  "The offset of the start of the paragraph containing POS — walk back
   one line at a time while the previous line is non-blank."
  (let ((ls (-line-start-of text pos)))
    (if (= ls 0)
        0
        ;; The line above ends at ls-1 (the newline); its start is found
        ;; by scanning back from there.
        (let* ((above-end (- ls 1))
               (above-start (-line-start-of text above-end)))
          (if (-line-blank? text above-start above-end)
              ls
              (-paragraph-start text above-start))))))

(define (-paragraph-end text pos)
  "The offset of the end of the paragraph containing POS — walk forward
   one line at a time while the next line is non-blank."
  (let ((le (-line-end-of text pos)))
    (if (>= le (string-length text))
        le
        ;; The line below starts at le+1; its end is the next newline.
        (let* ((below-start (+ le 1))
               (below-end (-line-end-of text below-start)))
          (if (-line-blank? text below-start below-end)
              le
              (-paragraph-end text below-end))))))

(define (expand-region-paragraph-bounds text pos)
  "The (start . end) of the paragraph containing POS in TEXT. A paragraph
   is a maximal run of non-blank lines; if POS itself is on a blank line,
   the paragraph is just that one line."
  (cons (-paragraph-start text pos) (-paragraph-end text pos)))

(define (expand-region-buffer-bounds text pos)
  "The whole buffer, ignoring POS."
  (cons 0 (string-length text)))

;; --- the dispatch ------------------------------------------------------
;;
;; `expand-region-bounds-at` returns the (start . end) for STEP given the
;; anchor POS and the buffer TEXT, or nil when that step has no bounds
;; for this anchor (e.g. step 1 with the cursor between non-word chars).

(define (expand-region-bounds-at step text pos)
  "The (start . end) for STEP (1=word, 2=line, 3=paragraph, 4=buffer)
   around POS in TEXT, or nil when the step does not apply."
  (cond
    ((= step 1) (expand-region-word-bounds text pos))
    ((= step 2) (expand-region-line-bounds text pos))
    ((= step 3) (expand-region-paragraph-bounds text pos))
    ((= step 4) (expand-region-buffer-bounds text pos))
    (else nil)))

(define (-bounds-same? a b)
  "True when two (start . end) pairs cover the same range."
  (and (not (nil? a)) (not (nil? b))
       (= (car a) (car b)) (= (cdr a) (cdr b))))

(define (-next-effective-step from text pos prior)
  "The next step beyond FROM whose bounds exist and are strictly larger
   than PRIOR (a (start . end) pair, or nil). Returns the step number
   together with its bounds: (step . (start . end)), or nil when no step
   up to the maximum yields a growth."
  (if (> from *expand-region-max-step*)
      nil
      (let ((bounds (expand-region-bounds-at from text pos)))
        (cond
          ((nil? bounds)
           (-next-effective-step (+ from 1) text pos prior))
          ((-bounds-same? bounds prior)
           (-next-effective-step (+ from 1) text pos prior))
          (else (cons from bounds))))))

;; --- the command -------------------------------------------------------

(define (-expand-region-active?)
  "True when the previous command was also expand-region — the chain is
   still alive and this press should grow the existing selection."
  (eq? *last-command* 'expand-region))

(define (-current-bounds)
  "The active region's (start . end), or nil when no region is active."
  (if (region-active?)
      (let ((m (mark)) (p (point)))
        (cons (min m p) (max m p)))
      nil))

(define (-apply-bounds! bounds)
  "Set the buffer selection from BOUNDS (a (start . end) pair): mark at
   the start, point at the end."
  (let ((s (car bounds)) (e (cdr bounds)))
    ;; Clear first so `goto!` does not extend through an existing mark.
    (clear-mark!)
    (goto! e)
    (set-mark! s)))

(defcommand expand-region ()
  "Grow the active region one structural step: word → line → paragraph →
   whole buffer. Repeated invocations keep growing; any other command in
   between starts the chain over from the current cursor position."
  (let* ((continuing (-expand-region-active?))
         (anchor (if continuing *expand-region-anchor* (point)))
         (prior (if continuing (-current-bounds) nil))
         (start-step (if continuing (+ *expand-region-step* 1) 1))
         (text (buffer-text))
         (found (-next-effective-step start-step text anchor prior)))
    (when (not continuing) (set! *expand-region-anchor* anchor))
    (cond
      ((nil? found)
       ;; No larger step applied — keep the previous selection so a
       ;; further C-= still counts as "the chain continued".
       nil)
      (else
        (let ((step (car found)) (bounds (cdr found)))
          (-apply-bounds! bounds)
          (set! *expand-region-step* step))))))
