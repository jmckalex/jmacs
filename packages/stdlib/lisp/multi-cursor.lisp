;;; multi-cursor.lisp — Sublime/VSCode-style multi-cursor commands.
;;;
;;; Two entry points:
;;;
;;;   add-cursor-next     (C-c d) — find the next occurrence of the word
;;;                                 at point and add a cursor selecting
;;;                                 it. With an active region, find the
;;;                                 next match of the region's text
;;;                                 instead.
;;;
;;;   select-all-matches  (C-c D) — add a cursor at every match of the
;;;                                 current selection (or the word at
;;;                                 point), each one selecting the match.
;;;
;;; Both build on the buffer-layer multi-cursor primitives:
;;; `add-selection!`, `collapse-to-primary!`, `cursor-count` and
;;; `selections`. The primary cursor's selection is what subsequent
;;; commands operate against, so each new cursor is created with both
;;; ends set so its match is selected.
;;;
;;; `keyboard-quit` (C-g) is extended to collapse the cursor set back
;;; to the primary, matching Sublime/VSCode.

;; --- helpers ----------------------------------------------------------

(define (-target-bounds)
  "The (start . end) of the text to multi-match: the active region if
   one is set, otherwise the word at point. Returns nil when there is
   neither a region nor a word at point."
  (cond
    ((region-active?)
     (let ((m (mark)) (p (point)))
       (cons (min m p) (max m p))))
    (else
     (expand-region-word-bounds (buffer-text) (point)))))

(define (-search-from text needle start)
  "The offset of the next occurrence of NEEDLE in TEXT at or after
   START, or nil when there is none."
  (let ((idx (string-index-of text needle start)))
    (if (< idx 0) nil idx)))

(define (-selection-at? rest offset)
  "Walk the selection list REST looking for a cursor whose point is at
   OFFSET. Helper for `-selection-already-at?`."
  (cond
    ((nil? rest) #f)
    ((= (car (car rest)) offset) #t)
    (else (-selection-at? (cdr rest) offset))))

(define (-selection-already-at? offset)
  "True when the current cursor set already contains a cursor whose
   point is at OFFSET."
  (-selection-at? (selections) offset))

(define (-walk-selections-max rest best)
  "Tail-recursive helper for `-max-selection-end`."
  (cond
    ((nil? rest) best)
    (else
      (let* ((cursor (car rest))
             (p (car cursor))
             (m (cdr cursor))
             (end (if (nil? m) p (max p m))))
        (-walk-selections-max (cdr rest) (max best end))))))

(define (-max-selection-end)
  "The largest end-offset across every current selection. Used by
   `add-cursor-next` so each press searches from just past the
   last-added cursor's range — Sublime's semantics."
  (-walk-selections-max (selections) 0))

;; --- the commands -----------------------------------------------------

(defcommand add-cursor-next ()
  "Add a cursor at the next match of the word at point (or the active
   region's text). On the first press with no region, the current word
   becomes selected as the primary; the next press selects the next
   match. Repeated presses keep adding cursors."
  (let ((bounds (-target-bounds)))
    (when (not (nil? bounds))
      (let* ((start (car bounds))
             (end (cdr bounds))
             (text (buffer-text))
             (needle (substring text start end)))
        (cond
          ;; First press, no region active — make the word the region
          ;; selected by the primary cursor. Matches Sublime: press
          ;; once to select the word, press again to add the next match.
          ;; Point lands at the *end* of the word (the active end), mark
          ;; at the start, so the convention matches secondary cursors.
          ((not (region-active?))
           (goto! end)
           (set-mark! start))
          (else
           ;; Search past the *last-added* cursor's end (not the
           ;; primary's), so a sequence of presses keeps adding the
           ;; next match each time — matches Sublime's M-d / C-d.
           (let* ((search-from (-max-selection-end))
                  (found (-search-from text needle search-from)))
             (when (and (not (nil? found))
                        (not (-selection-already-at?
                              (+ found (string-length needle)))))
               ;; The new cursor sits at the end of the match with the
               ;; mark at its start, so the matched text is selected.
               (add-selection! (+ found (string-length needle)) found)))))))))

(defcommand select-all-matches ()
  "Add a cursor at every occurrence of the current selection (or the
   word at point), each one selecting the match."
  (let ((bounds (-target-bounds)))
    (when (not (nil? bounds))
      (let* ((start (car bounds))
             (end (cdr bounds))
             (text (buffer-text))
             (needle (substring text start end))
             (n (string-length needle)))
        ;; Establish the primary cursor as a region around the first
        ;; instance of the word/text (point at the end, mark at the
        ;; start — matches secondary-cursor direction), then add cursors
        ;; for every other match in document order.
        (when (not (region-active?))
          (goto! end)
          (set-mark! start))
        (-add-all-matches text needle n 0)))))

(define (-add-all-matches text needle n from)
  "Tail-recursive helper for `select-all-matches`: scan TEXT for
   NEEDLE starting at FROM and add a cursor at each new match. N is
   the needle's length, hoisted out of the loop."
  (let ((found (-search-from text needle from)))
    (cond
      ((nil? found) nil)
      (else
        (when (not (-selection-already-at? (+ found n)))
          (add-selection! (+ found n) found))
        (-add-all-matches text needle n (+ found n))))))

;; --- extend keyboard-quit to collapse cursors ------------------------
;;
;; `keyboard-quit` (C-g) already clears the active region and resets
;; the key dispatch. We extend it here to also collapse a multi-cursor
;; set back to the primary cursor, matching Sublime/VSCode behaviour.

(define -keyboard-quit-base keyboard-quit)

(defcommand keyboard-quit ()
  "Abort a partial key sequence, clear the selection, and collapse to
   the primary cursor (C-g)."
  (-keyboard-quit-base)
  (collapse-to-primary!))
