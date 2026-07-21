;;; editing.lisp — the editor's editing commands.
;;;
;;; These are ordinary Lisp procedures, defined on top of the buffer
;;; primitives (cursor-left!, insert!, …). They are what keymap.lisp
;;; binds to keys. This is the layer the editor's behaviour lives in:
;;; redefine a command and the editor changes.

;; --- cursor movement ---------------------------------------------------

(defcommand forward-char ()
  "Move the cursor one character to the right."
  (cursor-right! #f))

(defcommand backward-char ()
  "Move the cursor one character to the left."
  (cursor-left! #f))

(defcommand next-line ()
  "Move the cursor down one line."
  (cursor-down! #f))

(defcommand previous-line ()
  "Move the cursor up one line."
  (cursor-up! #f))

(defcommand move-beginning-of-line ()
  "Move the cursor to the start of the current line."
  (cursor-line-start! #f))

(defcommand move-end-of-line ()
  "Move the cursor to the end of the current line."
  (cursor-line-end! #f))

(defcommand beginning-of-buffer ()
  "Move the cursor to the start of the buffer."
  (cursor-buffer-start! #f))

(defcommand end-of-buffer ()
  "Move the cursor to the end of the buffer."
  (cursor-buffer-end! #f))

(defcommand forward-word ()
  "Move forward to the end of the next word."
  (goto! (word-forward-offset)))

(defcommand backward-word ()
  "Move backward to the start of the previous word."
  (goto! (word-backward-offset)))

(defcommand forward-sentence ()
  "Move forward to the end of the sentence."
  (goto! (sentence-forward-offset)))

(defcommand backward-sentence ()
  "Move backward to the start of the sentence."
  (goto! (sentence-backward-offset)))

(defcommand goto-line (line)
  "Move the cursor to LINE."
  (interactive (number "Goto line: "))
  (goto-line! line))

(defcommand replace-string (from to)
  "Replace every occurrence of FROM with TO."
  (interactive (string "Replace: ") (string "Replace with: "))
  (replace-all! from to))

(defcommand recenter ()
  "Scroll so the cursor's line is centred in the viewport."
  (recenter!))

(defcommand back-to-indentation ()
  "Move the cursor to the first non-blank character of the line."
  (goto! (+ (line-start) (string-length (line-indent)))))

(defcommand exchange-point-and-mark ()
  "Move point to the mark, and the mark to where point was."
  (let ((m (mark)))
    (when m                             ; no mark set is #f; offset 0 is truthy
      (let ((p (point)))
        (goto! m)
        (set-mark! p)))))

(defcommand scroll-up ()
  "Move the cursor forward by roughly one screenful."
  (for-each (lambda (i) (cursor-down! #f)) (range (page-lines))))

(defcommand scroll-down ()
  "Move the cursor backward by roughly one screenful."
  (for-each (lambda (i) (cursor-up! #f)) (range (page-lines))))

;; --- movement that extends the selection -------------------------------

(defcommand forward-char-extending () (cursor-right! #t))
(defcommand backward-char-extending () (cursor-left! #t))
(defcommand next-line-extending () (cursor-down! #t))
(defcommand previous-line-extending () (cursor-up! #t))
(defcommand beginning-of-line-extending () (cursor-line-start! #t))
(defcommand end-of-line-extending () (cursor-line-end! #t))

;; Word-wise selection: anchor the mark when no region is active, then
;; move — `goto!` extends an active region, so repeated presses keep
;; growing (or shrinking) the selection word by word.
(defcommand forward-word-extending ()
  "Extend the selection to the end of the next word (M-S-right)."
  (unless (region-active?) (set-mark! (point)))
  (goto! (word-forward-offset)))

(defcommand backward-word-extending ()
  "Extend the selection to the start of the previous word (M-S-left)."
  (unless (region-active?) (set-mark! (point)))
  (goto! (word-backward-offset)))

;; --- editing -----------------------------------------------------------

(defcommand delete-backward ()
  "Delete the character before the cursor (or the selection)."
  (delete-backward!))

(defcommand delete-forward ()
  "Delete the character after the cursor (or the selection)."
  (delete-forward!))

(defcommand newline ()
  "Insert a line break, copying the current line's indentation."
  (insert! (str "\n" (line-indent))))

(defcommand open-line ()
  "Insert a newline after the cursor, leaving the cursor before it."
  (let ((p (point)))
    (insert! "\n")
    (goto! p)))

(defcommand fill-paragraph ()
  "Re-wrap the paragraph around the cursor to the fill column."
  (fill-paragraph!))

;; --- atomic undo grouping ----------------------------------------------
;; A command that edits the buffer several times (fill-paragraph,
;; indent-region, the surround helpers) should undo as ONE step, not
;; edit by edit — Emacs's `atomic-change-group`. The host primitives
;; `begin-change-group!` / `end-change-group!` collect the edits into a
;; single undo entry; the wrapper here guarantees the group closes even
;; when the body raises.

(define (call-with-atomic-undo thunk)
  "Run THUNK with every buffer edit it makes grouped into a single undo
   step. The group is closed on every exit — normal return, a Lisp
   error, even a raw JS exception from a host primitive — and any error
   propagates untouched."
  (begin-change-group!)
  (try (thunk)
       (finally (end-change-group!))))

(defmacro atomic-change-group (first . rest)
  "Evaluate the body with every buffer edit grouped into a single undo
   step (Emacs's atomic-change-group). Use around any command body that
   edits the buffer more than once."
  (list 'call-with-atomic-undo
        (cons 'lambda (cons (list) (cons first rest)))))

;; --- markers and excursions ---------------------------------------------
;; A marker (make-marker) is an edit-tracking position: its offset rides
;; insertions and deletions made before it, where a saved integer goes
;; stale. Markers cost the buffer a little work on every edit, so each
;; one must be released; `with-marker` scopes one to a body and
;; guarantees the release, and `save-excursion` uses one to put point
;; back where it was.

(defmacro with-marker (binding first . rest)
  "Evaluate the body with a fresh marker in scope:
   (with-marker (name offset?) body…). NAME is bound to a marker in the
   current buffer at OFFSET (point when omitted), and released on every
   exit — normal return or error — so it cannot leak. Returns the
   body's value."
  (let ((name (car binding))
        (init (if (pair? (cdr binding))
                  (list 'make-marker (cadr binding))
                  (list 'make-marker))))
    `(let ((,name ,init))
       (try (begin ,first ,@rest)
            (finally (release-marker! ,name))))))

(defmacro save-excursion (first . rest)
  "Evaluate the body, then restore point to where it was — on normal
   return and on error alike. The saved place is a marker, not a plain
   integer, so edits the body makes before point do not shift the
   restore target. Point only: the mark is deliberately left alone.
   Returns the body's value."
  (let ((m (gensym "excursion")))
    `(with-marker (,m)
       (try (begin ,first ,@rest)
            (finally (goto! (marker-position ,m)))))))

;; --- transposing -------------------------------------------------------
;; The transpose family follows Emacs's drag model: the thing before
;; point is dragged forward past the thing after it, and point ends up
;; after both — so repeated presses keep dragging it rightward.
;;
;; Character boundaries are measured with the cursor-motion primitives
;; (cursor-left! / cursor-right!) rather than offset arithmetic, so a
;; character that is a surrogate pair (an emoji) transposes as a unit.

(define (-char-start-before p)
  "The offset where the character ending at P starts, stepping back a
   whole character — or #f when P is the buffer start. Moves point."
  (goto! p)
  (cursor-left! #f)
  (let ((q (point)))
    (if (= q p) #f q)))

(define (-char-end-after p)
  "The offset just past the character starting at P, stepping forward a
   whole character — or #f when P is the buffer end. Moves point."
  (goto! p)
  (cursor-right! #f)
  (let ((q (point)))
    (if (= q p) #f q)))

(defcommand transpose-chars ()
  "Interchange the characters around the cursor, moving forward — the
   character before point is dragged past the one after it, so repeated
   presses drag it rightward (C-t). At the end of a line or of the
   buffer, the two characters before the cursor are exchanged instead
   and the cursor stays put (Emacs's rule)."
  (clear-mark!)
  (let ((p (point)))
    (when (> p 0)
      (if (or (= p (buffer-length)) (= p (line-end)))
          ;; End of line: swap the two characters before point.
          (let ((b-start (-char-start-before p)))
            (when b-start
              (let ((a-start (-char-start-before b-start)))
                (when a-start
                  (let ((a (buffer-substring a-start b-start))
                        (b (buffer-substring b-start p)))
                    (atomic-change-group
                      (delete-region! a-start p)
                      (insert! (str b a))))))))
          ;; Mid-line: drag the character before point past the one after.
          (let ((b-start (-char-start-before p))
                (c-end (-char-end-after p)))
            (when (and b-start c-end)
              (let ((b (buffer-substring b-start p))
                    (c (buffer-substring p c-end)))
                (atomic-change-group
                  (delete-region! b-start c-end)
                  (insert! (str c b))))))))))

(defcommand transpose-words ()
  "Interchange the word at or after the cursor with the word before it,
   leaving the cursor after both (M-t) — repeated presses drag a word
   rightward. Does nothing without two words to transpose."
  (clear-mark!)
  (let ((orig (point)))
    (goto! (word-forward-offset))
    (let ((start2 (word-backward-offset)))
      (goto! start2)
      (let ((end2 (word-forward-offset)))
        (let ((start1 (word-backward-offset)))
          (goto! start1)
          (let ((end1 (word-forward-offset)))
            (if (or (= start1 start2)     ; no previous word
                    (= start2 end2)       ; no word at or after point
                    (> end1 start2))      ; the "two" words overlap
                (goto! orig)
                (let ((w1 (buffer-substring start1 end1))
                      (mid (buffer-substring end1 start2))
                      (w2 (buffer-substring start2 end2)))
                  (atomic-change-group
                    (delete-region! start1 end2)
                    (insert! (str w2 mid w1)))))))))))

;; --- case conversion ---------------------------------------------------
;; The word commands are Emacs's dwim versions: with an active region
;; they convert the region, otherwise they convert from the cursor to
;; the end of the word and leave the cursor there.

(define (-convert-region! start end convert)
  "Replace [START, END) with CONVERT applied to its text, as one undo
   step. Leaves the cursor at END's replacement."
  (let ((text (buffer-substring start end)))
    (atomic-change-group
      (delete-region! start end)
      (insert! (convert text)))))

(define (-case-word-or-region! convert)
  "Apply CONVERT to the active region, or from the cursor to the end
   of the word."
  (if (region-active?)
      (let ((m (mark)) (p (point)))
        (-convert-region! (min m p) (max m p) convert))
      (let ((from (point))
            (to (word-forward-offset)))
        (when (> to from)
          (-convert-region! from to convert)))))

(defcommand upcase-word ()
  "Uppercase from the cursor to the end of the word — or the active
   region (M-u)."
  (-case-word-or-region! string-upcase))

(defcommand downcase-word ()
  "Lowercase from the cursor to the end of the word — or the active
   region (M-l)."
  (-case-word-or-region! string-downcase))

(defcommand capitalize-word ()
  "Capitalize from the cursor to the end of the word — or every word in
   the active region (M-c)."
  (-case-word-or-region! string-capitalize))

(defcommand upcase-region (start end)
  "Uppercase the active region (C-x C-u)."
  (interactive region)
  (-convert-region! start end string-upcase))

(defcommand downcase-region (start end)
  "Lowercase the active region (C-x C-l)."
  (interactive region)
  (-convert-region! start end string-downcase))

;; --- whitespace --------------------------------------------------------

(define (-hspace-start p floor)
  "The start of the run of spaces and tabs ending at P, not before FLOOR."
  (if (and (> p floor)
           (let ((ch (buffer-substring (- p 1) p)))
             (or (equal? ch " ") (equal? ch "\t"))))
      (-hspace-start (- p 1) floor)
      p))

(define (-hspace-end p ceiling)
  "The end of the run of spaces and tabs starting at P, not past CEILING."
  (if (and (< p ceiling)
           (let ((ch (buffer-substring p (+ p 1))))
             (or (equal? ch " ") (equal? ch "\t"))))
      (-hspace-end (+ p 1) ceiling)
      p))

(defcommand delete-horizontal-space ()
  "Delete all spaces and tabs around the cursor (M-\\)."
  (let ((s (-hspace-start (point) (line-start)))
        (e (-hspace-end (point) (line-end))))
    (when (< s e) (delete-region! s e))))

(defcommand just-one-space ()
  "Replace the spaces and tabs around the cursor with a single space
   (M-SPC), inserting one when there is none."
  (let ((s (-hspace-start (point) (line-start)))
        (e (-hspace-end (point) (line-end))))
    (atomic-change-group
      (when (< s e) (delete-region! s e))
      (insert! " "))))

(defcommand delete-indentation ()
  "Join this line to the previous one, collapsing the newline and the
   surrounding whitespace to a single space (M-^) — the upward twin of
   `join-line` (C-x C-j)."
  (when (> (line-start) 0)
    (goto! (- (line-start) 1))
    (join-line)))

;; --- blank lines and paragraphs ----------------------------------------
;; A paragraph is a run of non-blank lines; blank (empty or
;; whitespace-only) lines separate paragraphs.

(define (-cursor-line-blank?)
  "True when the cursor's line is empty or only spaces and tabs."
  (>= (+ (line-start) (string-length (line-indent))) (line-end)))

(define (-blank-at? off)
  "True when the line containing OFF is blank. Restores point."
  (save-excursion (goto! off) (-cursor-line-blank?)))

(defcommand delete-blank-lines ()
  "On a blank line, delete all surrounding blank lines, leaving one; on
   an isolated blank line, delete it; on a non-blank line, delete the
   blank lines that follow (C-x C-o)."
  (if (-cursor-line-blank?)
      (begin
        ;; Walk to the first line of the blank run…
        (while (and (> (line-start) 0) (-blank-at? (- (line-start) 1)))
          (goto! (- (line-start) 1)))
        (let ((run-start (line-start)))
          ;; …and to the last.
          (while (and (< (line-end) (buffer-length))
                      (-blank-at? (+ (line-end) 1)))
            (goto! (+ (line-end) 1)))
          (if (= run-start (line-start))
              ;; A single blank line: delete it, newline included.
              (delete-region! run-start
                              (min (+ (line-end) 1) (buffer-length)))
              ;; A run: keep one blank line, and empty it of whitespace.
              (atomic-change-group
                (delete-region! run-start (line-start))
                (delete-region! (line-start) (line-end))))))
      ;; Non-blank line: delete any blank run that follows it.
      (let ((eol (line-end)))
        (when (and (< eol (buffer-length)) (-blank-at? (+ eol 1)))
          (save-excursion
            (goto! (+ eol 1))
            (while (and (< (line-end) (buffer-length))
                        (-blank-at? (+ (line-end) 1)))
              (goto! (+ (line-end) 1)))
            (delete-region! (+ eol 1)
                            (min (+ (line-end) 1) (buffer-length))))))))

(defcommand forward-paragraph ()
  "Move forward to the end of the paragraph (M-}): past any blank
   lines, then to the start of the blank line that ends the paragraph
   (or the end of the buffer). Extends an active region."
  (while (and (-cursor-line-blank?) (< (line-end) (buffer-length)))
    (goto! (+ (line-end) 1)))
  (while (and (not (-cursor-line-blank?)) (< (line-end) (buffer-length)))
    (goto! (+ (line-end) 1)))
  (when (not (-cursor-line-blank?)) (goto! (buffer-length))))

(defcommand backward-paragraph ()
  "Move backward to the start of the paragraph (M-{): before any blank
   lines, then to the start of the blank line above the paragraph (or
   the start of the buffer). Extends an active region."
  (while (and (-cursor-line-blank?) (> (line-start) 0))
    (goto! (- (line-start) 1)))
  (while (and (not (-cursor-line-blank?)) (> (line-start) 0))
    (goto! (- (line-start) 1)))
  (if (-cursor-line-blank?) (goto! (line-start)) (goto! 0)))

(defcommand mark-paragraph ()
  "Select the paragraph around the cursor: point at its start, mark at
   its end (M-h)."
  (forward-paragraph)
  (let ((end (point)))
    (backward-paragraph)
    (set-mark! end)))

(defcommand mark-word ()
  "Set the mark at the end of the next word (M-@); with a forward
   region already active, extend it by another word."
  (if (and (region-active?) (> (mark) (point)))
      (set-mark! (save-excursion (goto! (mark)) (word-forward-offset)))
      (set-mark! (word-forward-offset))))

(defcommand mark-whole-buffer ()
  "Select the entire buffer."
  (goto! (buffer-length))
  (set-mark! 0))

(defcommand set-mark-command ()
  "Set the mark at the cursor, starting a region (C-SPC). While the
   mark is set, cursor movement extends the region; C-g clears it."
  (set-mark! (point)))

(defcommand deselect ()
  "Clear the selection on every cursor without collapsing the
   multi-cursor set (ESC). Lets a multi-cursor word-select (C-c d /
   C-c D) be dropped to bare carets at every match — ready to navigate
   away or type a prefix/suffix, with the cursor set intact. For a
   single cursor this is the same as `clear-mark!` (or `C-g` minus the
   side-effects of resetting any in-progress key chord)."
  (clear-mark!))

(defcommand comment-line ()
  "Comment or uncomment the current line."
  (let ((prefix (comment-prefix))
        (indent-end (+ (line-start) (string-length (line-indent)))))
    (if (string-prefix? prefix (buffer-substring indent-end (line-end)))
        (delete-region! indent-end (+ indent-end (string-length prefix)))
        (begin (goto! indent-end) (insert! prefix)))))

(defcommand insert-tab ()
  "Insert a tab at the cursor — either a literal `\\t` or `*tab-width*`
   spaces, depending on `*indent-tabs-mode*` and the current major
   mode's `:indent-tabs?` key. Makefile-mode pins indent-tabs on, so
   Tab in a Makefile always emits a real tab."
  (if (-indent-tabs-effective)
      (insert! "\t")
      (insert! (string-repeat " " (-tab-width-effective)))))

;; --- history -----------------------------------------------------------

(defcommand undo ()
  "Undo the last change."
  (undo!))

(defcommand redo ()
  "Redo the last undone change."
  (redo!))
