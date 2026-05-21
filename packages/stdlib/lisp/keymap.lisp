;;; keymap.lisp — the default key bindings, and key dispatch.
;;;
;;; The renderer reports each keystroke as a normalised string: a single
;;; character for printable keys ("a", " "), a name for the rest
;;; ("left", "backspace"), with modifier prefixes "C-" (Ctrl/Cmd),
;;; "M-" (Alt) and "S-" (Shift) — e.g. "S-left", "C-z", "C-S-z".
;;;
;;; Keys are bound to command *names* (symbols), not to procedures, so
;;; redefining a command takes effect immediately — `handle-key`
;;; resolves the name afresh on every keystroke.

(define the-keymap
  {"left"      'backward-char
   "right"     'forward-char
   "up"        'previous-line
   "down"      'next-line
   "S-left"    'backward-char-extending
   "S-right"   'forward-char-extending
   "S-up"      'previous-line-extending
   "S-down"    'next-line-extending
   "home"      'move-beginning-of-line
   "end"       'move-end-of-line
   "S-home"    'beginning-of-line-extending
   "S-end"     'end-of-line-extending
   "C-left"    'move-beginning-of-line
   "C-right"   'move-end-of-line
   "C-up"      'beginning-of-buffer
   "C-down"    'end-of-buffer
   "backspace" 'delete-backward
   "delete"    'delete-forward
   "enter"     'newline
   "tab"       'insert-tab
   "C-z"       'undo
   "C-S-z"     'redo
   "C-o"       'find-file
   "C-s"       'save-buffer})

(define (self-insert-key? key)
  "True when KEY is a single character to be inserted as text."
  (and (string? key) (= (string-length key) 1)))

(define (handle-key key)
  "Dispatch KEY: run its bound command, or self-insert a character.
   Returns #t when the key was handled."
  (let ((command (get the-keymap key nil)))
    (cond
      ((not (nil? command)) ((eval command)) #t)
      ((self-insert-key? key) (insert! key) #t)
      (else #f))))
