;;; keymap.lisp — the default key bindings, and key dispatch.
;;;
;;; The renderer reports each keystroke as a normalised string: a single
;;; character for printable keys ("a", " "), a name for the rest
;;; ("left", "backspace"), with modifier prefixes "C-" (Ctrl/Cmd),
;;; "M-" (Alt) and "S-" (Shift) — e.g. "S-left", "C-z", "C-S-z".
;;;
;;; A keymap maps a key string to either a command *name* (a symbol) or
;;; a nested keymap. A nested keymap is a prefix: press the prefix key,
;;; then a key from that map — this is how "C-x C-f" works. Commands
;;; are bound by name and resolved late, so redefining one takes effect
;;; immediately.

;; The C-x prefix map — keys reached by first pressing C-x.
(define c-x-keymap
  {"C-f"   'find-file
   "C-s"   'save-buffer
   "C-r"   'reload-stdlib
   "b"     'switch-buffer
   "right" 'next-buffer
   "left"  'previous-buffer
   "n"     'new-buffer
   "h"     'mark-whole-buffer
   ";"     'comment-line})

;; The C-h prefix map — help.
(define c-h-keymap
  {"k" 'describe-key
   "f" 'describe-command})

;; The root keymap.
(define the-keymap
  {"left"         'backward-char
   "right"        'forward-char
   "up"           'previous-line
   "down"         'next-line
   "S-left"       'backward-char-extending
   "S-right"      'forward-char-extending
   "S-up"         'previous-line-extending
   "S-down"       'next-line-extending
   "home"         'move-beginning-of-line
   "end"          'move-end-of-line
   "S-home"       'beginning-of-line-extending
   "S-end"        'end-of-line-extending
   "C-left"       'move-beginning-of-line
   "C-right"      'move-end-of-line
   "C-up"         'beginning-of-buffer
   "C-down"       'end-of-buffer
   "backspace"    'delete-backward
   "delete"       'delete-forward
   "enter"        'newline
   "tab"          'insert-tab
   "C-f"          'forward-char
   "C-b"          'backward-char
   "C-n"          'next-line
   "C-p"          'previous-line
   "C-a"          'move-beginning-of-line
   "C-e"          'move-end-of-line
   "C-d"          'delete-forward
   "C-t"          'transpose-chars
   "C-g"          'keyboard-quit
   "C-z"          'undo
   "C-S-z"        'redo
   "C-s"          'isearch-forward
   "C-r"          'isearch-backward
   "M-x"          'execute-command
   "C-w"          'kill-region
   "M-w"          'copy-region
   "C-k"          'kill-line
   "C-y"          'yank
   "M-f"          'forward-word
   "M-b"          'backward-word
   "M-g"          'goto-line
   "M-r"          'replace-string
   "M-d"          'kill-word
   "M-backspace"  'backward-kill-word
   "C-x"          c-x-keymap
   "C-h"          c-h-keymap})

;; The keymap the next keystroke is looked up in: the root keymap, or a
;; prefix keymap while a key sequence is in progress.
(define active-keymap the-keymap)

(define (reset-keymap!)
  "Return dispatch to the root keymap."
  (set! active-keymap the-keymap))

(define (keyboard-quit)
  "Abort a partial key sequence and clear the selection (C-g)."
  (reset-keymap!)
  (clear-mark!))

(define (self-insert-key? key)
  "True when KEY is a single character to be inserted as text."
  (and (string? key) (= (string-length key) 1)))

;; A procedure to receive the next keystroke instead of the keymap, or
;; nil. This is how a command like describe-key reads a key.
(define *key-reader* nil)

(define (read-next-key callback)
  "Route the next keystroke to CALLBACK rather than the keymap."
  (set! *key-reader* callback))

(define (handle-key key)
  "Dispatch KEY. If a key-reader is pending it receives the key;
   otherwise KEY runs a command, begins a sequence, or self-inserts.
   Returns #t when the key was handled."
  (if (not (nil? *key-reader*))
      (let ((reader *key-reader*))
        (set! *key-reader* nil)
        (reader key)
        #t)
      (let ((binding (get active-keymap key nil)))
        (cond
          ;; A nested keymap: KEY is a prefix — wait for the next key.
          ((map? binding)
           (set! active-keymap binding)
           #t)
          ;; A command name: run it, then return to the root keymap.
          ((symbol? binding)
           (reset-keymap!)
           ((eval binding))
           #t)
          ;; Mid-sequence with nothing bound: the sequence is undefined.
          ((not (eq? active-keymap the-keymap))
           (reset-keymap!)
           #t)
          ;; At the root: self-insert a character, else leave unhandled.
          ((self-insert-key? key)
           (insert! key)
           #t)
          (else #f)))))
