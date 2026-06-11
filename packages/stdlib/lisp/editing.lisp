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
    (when (not (nil? m))
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

;; --- editing -----------------------------------------------------------

(defcommand delete-backward ()
  "Delete the character before the cursor (or the selection)."
  (delete-backward!))

(defcommand delete-forward ()
  "Delete the character after the cursor (or the selection)."
  (delete-forward!))

(defcommand transpose-chars ()
  "Swap the two characters before the cursor."
  (when (>= (point) 2)
    (let ((p (point)))
      (let ((a (buffer-substring (- p 2) (- p 1)))
            (b (buffer-substring (- p 1) p)))
        (delete-region! (- p 2) p)
        (insert! (str b a))))))

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
   step. The group is closed even when THUNK raises (the error is
   re-raised)."
  (begin-change-group!)
  (try
    (let ((result (thunk)))
      (end-change-group!)
      result)
    (catch err
      (end-change-group!)
      (error err))))

(defmacro atomic-change-group (first . rest)
  "Evaluate the body with every buffer edit grouped into a single undo
   step (Emacs's atomic-change-group). Use around any command body that
   edits the buffer more than once."
  (list 'call-with-atomic-undo
        (cons 'lambda (cons (list) (cons first rest)))))

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
