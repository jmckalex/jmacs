;;; editing.lisp — the editor's editing commands.
;;;
;;; These are ordinary Lisp procedures, defined on top of the buffer
;;; primitives (cursor-left!, insert!, …). They are what keymap.lisp
;;; binds to keys. This is the layer the editor's behaviour lives in:
;;; redefine a command and the editor changes.

;; --- cursor movement ---------------------------------------------------

(define (forward-char)
  "Move the cursor one character to the right."
  (cursor-right! #f))

(define (backward-char)
  "Move the cursor one character to the left."
  (cursor-left! #f))

(define (next-line)
  "Move the cursor down one line."
  (cursor-down! #f))

(define (previous-line)
  "Move the cursor up one line."
  (cursor-up! #f))

(define (move-beginning-of-line)
  "Move the cursor to the start of the current line."
  (cursor-line-start! #f))

(define (move-end-of-line)
  "Move the cursor to the end of the current line."
  (cursor-line-end! #f))

(define (beginning-of-buffer)
  "Move the cursor to the start of the buffer."
  (cursor-buffer-start! #f))

(define (end-of-buffer)
  "Move the cursor to the end of the buffer."
  (cursor-buffer-end! #f))

(define (forward-word)
  "Move forward to the end of the next word."
  (goto! (word-forward-offset)))

(define (backward-word)
  "Move backward to the start of the previous word."
  (goto! (word-backward-offset)))

(define (goto-line)
  "Prompt for a line number and move the cursor to that line."
  (start-goto-line!))

;; --- movement that extends the selection -------------------------------

(define (forward-char-extending) (cursor-right! #t))
(define (backward-char-extending) (cursor-left! #t))
(define (next-line-extending) (cursor-down! #t))
(define (previous-line-extending) (cursor-up! #t))
(define (beginning-of-line-extending) (cursor-line-start! #t))
(define (end-of-line-extending) (cursor-line-end! #t))

;; --- editing -----------------------------------------------------------

(define (delete-backward)
  "Delete the character before the cursor (or the selection)."
  (delete-backward!))

(define (delete-forward)
  "Delete the character after the cursor (or the selection)."
  (delete-forward!))

(define (newline)
  "Insert a line break, copying the current line's indentation."
  (insert! (str "\n" (line-indent))))

(define (mark-whole-buffer)
  "Select the entire buffer."
  (goto! (buffer-length))
  (set-mark! 0))

(define (comment-line)
  "Comment or uncomment the current line."
  (let ((prefix (comment-prefix))
        (indent-end (+ (line-start) (string-length (line-indent)))))
    (if (string-prefix? prefix (buffer-substring indent-end (line-end)))
        (delete-region! indent-end (+ indent-end (string-length prefix)))
        (begin (goto! indent-end) (insert! prefix)))))

(define (insert-tab)
  "Insert two spaces at the cursor."
  (insert! "  "))

;; --- history -----------------------------------------------------------

(define (undo)
  "Undo the last change."
  (undo!))

(define (redo)
  "Redo the last undone change."
  (redo!))
