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
   "C-c"   'quit-editor
   "b"     'switch-buffer
   "right" 'next-buffer
   "left"  'previous-buffer
   "n"     'new-buffer
   "p"     'toggle-repl
   "h"     'mark-whole-buffer
   ";"     'comment-line
   "C-d"   'duplicate-line
   "C-j"   'join-line
   "C-x"   'exchange-point-and-mark})

;; The C-h prefix map — help.
(define c-h-keymap
  {"k" 'describe-key
   "f" 'describe-command})

;; The M-n prefix map — sticky notes (see sticky-notes.lisp).
(define sticky-note-keymap
  {"n" 'add-sticky-note
   "e" 'edit-sticky-note
   "d" 'delete-sticky-note
   "f" 'next-sticky-note
   "b" 'previous-sticky-note
   "t" 'toggle-sticky-notes})

;; The M-s prefix map — search-related commands (see occur.lisp).
(define m-s-keymap
  {"o" 'occur})

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
   "C-S-f"        'forward-char-extending
   "C-S-b"        'backward-char-extending
   "C-S-n"        'next-line-extending
   "C-S-p"        'previous-line-extending
   "C-S-a"        'beginning-of-line-extending
   "C-S-e"        'end-of-line-extending
   "C-space"      'set-mark-command
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
   "C-o"          'open-line
   "C-j"          'newline
   "C-v"          'scroll-up
   "C-l"          'recenter
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
   "M-y"          'yank-pop
   "M-f"          'forward-word
   "M-b"          'backward-word
   "M-m"          'back-to-indentation
   "M-v"          'scroll-down
   "M-g"          'goto-line
   "M-r"          'replace-string
   "M-q"          'fill-paragraph
   "M-a"          'backward-sentence
   "M-e"          'forward-sentence
   "M-k"          'kill-sentence
   ;; M-< and M-> — the symbols arrive shifted.
   "M-S-comma"    'beginning-of-buffer
   "M-S-period"   'end-of-buffer
   "M-d"          'kill-word
   "M-backspace"  'backward-kill-word
   "M-up"         'move-line-up
   "M-down"       'move-line-down
   ;; expand-region — C-= as the spec names it; the host normalises that
   ;; keystroke (event.code "Equal") to "C-equal".
   "C-equal"      'expand-region
   "C-x"          c-x-keymap
   "C-h"          c-h-keymap
   "M-n"          sticky-note-keymap
   "M-s"          m-s-keymap})

;; While a key sequence is in progress this holds the prefix keymap the
;; next keystroke is looked up in; at rest it is nil, meaning the key is
;; resolved through the buffer's mode chain (see lookup-key).
(define active-keymap nil)

(define (reset-keymap!)
  "Return dispatch to rest — resolve the next key through the modes."
  (set! active-keymap nil))

;; --- keymap composition ------------------------------------------------
;; A key is resolved through a chain of keymaps: the active minor-mode
;; maps, then the major mode's map, then the global keymap. The first
;; map that binds the key wins, so a mode can shadow a global binding
;; without disturbing other buffers.

(define (keymap-chain)
  "The keymaps to resolve a key through, highest precedence first:
   the minor-mode maps, then the major-mode map, then the global map."
  (append (minor-mode-keymaps) (list (major-mode-keymap) the-keymap)))

(define (lookup-in-chain key maps)
  "The first binding for KEY among MAPS, skipping nil maps."
  (cond
    ((nil? maps) nil)
    ((nil? (car maps)) (lookup-in-chain key (cdr maps)))
    (else
      (let ((binding (get (car maps) key nil)))
        (if (nil? binding)
            (lookup-in-chain key (cdr maps))
            binding)))))

(define (lookup-key key)
  "Resolve KEY: through the active prefix map mid-sequence, otherwise
   through the buffer's mode chain."
  (if (nil? active-keymap)
      (lookup-in-chain key (keymap-chain))
      (get active-keymap key nil)))

(defcommand keyboard-quit ()
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
      (let ((binding (lookup-key key)))
        (cond
          ;; A nested keymap: KEY is a prefix — wait for the next key.
          ((map? binding)
           (set! active-keymap binding)
           #t)
          ;; A command name: run it, then return to rest.
          ((symbol? binding)
           (reset-keymap!)
           (run-command binding)
           #t)
          ;; Mid-sequence with nothing bound: the sequence is undefined.
          ((not (nil? active-keymap))
           (reset-keymap!)
           #t)
          ;; At rest: self-insert a character, else leave unhandled.
          ((self-insert-key? key)
           (insert! key)
           #t)
          (else #f)))))
