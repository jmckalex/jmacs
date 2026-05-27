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
   "b"     'switch-view
   "C-b"   'buffer-menu
   "right" 'next-view
   "left"  'previous-view
   "n"     'new-view
   "k"     'kill-view
   "p"     'toggle-repl
   "h"     'mark-whole-buffer
   ";"     'comment-line
   "C-d"   'duplicate-line
   "C-j"   'join-line
   "j"     'jukebox
   "C-x"   'exchange-point-and-mark
   "C-e"   'eval-expression-before-point
   ;; Panes (phase 3a of plans/PANES.md) — Emacs's C-x 2/3/0/1/o.
   "0"     'delete-pane
   "1"     'delete-other-panes
   "2"     'split-vertical
   "3"     'split-horizontal
   "o"     'other-pane
   ;; Spatial pane navigation. C-x <arrow> is already taken
   ;; (next/previous-view); use C-x C-<arrow>.
   "C-left"   'focus-pane-left
   "C-right"  'focus-pane-right
   "C-up"     'focus-pane-up
   "C-down"   'focus-pane-down})

;; The C-h prefix map — help.
(define c-h-keymap
  {"k" 'describe-key
   "f" 'describe-command
   "F" 'describe-face-at-point
   "a" 'apropos-doc
   "." 'describe-symbol-at-point})

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

;; The C-c prefix map — at the global root for editor-wide commands.
;; (Mode-local C-c bindings live in each mode's own keymap and shadow
;; this map for the mode's buffers.) Note that C-x C-c remains bound to
;; quit-editor; that lives under the c-x-keymap and is unaffected.
(define c-c-keymap
  {"tab"       'toggle-fold-at-point
   "C-comma"   'fold-all
   "C-period"  'unfold-all
   ;; Multi-cursor (see multi-cursor.lisp). C-c d adds the next match;
   ;; C-c D selects all matches of the current word/region.
   "d"         'add-cursor-next
   "D"         'select-all-matches})

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
   "C-M-s"        'isearch-regexp-forward
   "C-M-r"        'isearch-regexp-backward
   ;; M-% (query-replace) — Shift+5 is "%", so the normalised key is M-S-5.
   "M-S-5"        'query-replace
   ;; C-M-% (replace-regexp) — likewise C-M-S-5.
   "C-M-S-5"      'replace-regexp
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
   ;; CIDER-style inline eval — C-Enter evaluates the form at point.
   "C-enter"      'eval-expression-at-point
   "C-x"          c-x-keymap
   "C-h"          c-h-keymap
   "C-c"          c-c-keymap
   "M-n"          sticky-note-keymap
   "M-s"          m-s-keymap})

;; While a key sequence is in progress this holds the prefix keymap the
;; next keystroke is looked up in; at rest it is nil, meaning the key is
;; resolved through the buffer's mode chain (see lookup-key).
(define active-keymap nil)

;; The keys typed in the current sequence, joined with spaces. When
;; `active-keymap` is nil this is the empty string and the echo area
;; is clear; mid-sequence it shows what's been typed so far, with a
;; trailing dash signalling that more keys are coming.
(define *chord-prefix* "")

;; show-status! / clear-status! are host primitives that route to the
;; minibuffer's echo area. Tests register no-op versions; the real app
;; wires them to the minibuffer module.

(define (reset-keymap!)
  "Return dispatch to rest — resolve the next key through the modes,
   and clear any chord-prefix display in the echo area."
  (set! active-keymap nil)
  (set! *chord-prefix* "")
  (clear-status!))

(define (-extend-chord-prefix! key)
  "Append KEY to the chord-prefix display and show it in the echo
   area with a trailing dash — the visual signal that more keys are
   expected. Called when a prefix key has just been resolved."
  (set! *chord-prefix*
        (if (= (string-length *chord-prefix*) 0)
            key
            (str *chord-prefix* " " key)))
  (show-status! (str *chord-prefix* "-")))

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
   Returns #t when the key was handled.

   While a multi-key sequence is in progress the keys typed so far
   are echoed to the minibuffer's status area (Emacs's \"echo area\")
   with a trailing dash. The display is cleared when a command runs,
   when C-g aborts, and when a mid-sequence key is unbound."
  (if (not (nil? *key-reader*))
      (let ((reader *key-reader*))
        (set! *key-reader* nil)
        (reader key)
        #t)
      (let ((binding (lookup-key key)))
        (cond
          ;; A nested keymap: KEY is a prefix — wait for the next key
          ;; and show the running prefix in the echo area.
          ((map? binding)
           (set! active-keymap binding)
           (-extend-chord-prefix! key)
           #t)
          ;; A command name: run it, then return to rest. The chord
          ;; display is cleared by reset-keymap! before the command
          ;; runs, so a command's own echo-area message is not
          ;; overwritten by the cleanup.
          ((symbol? binding)
           (reset-keymap!)
           (run-command binding)
           #t)
          ;; Mid-sequence with nothing bound: the sequence is
          ;; undefined; reset and clear the chord display.
          ((not (nil? active-keymap))
           (reset-keymap!)
           #t)
          ;; At rest: self-insert a character, else leave unhandled.
          ((self-insert-key? key)
           (insert! key)
           #t)
          (else #f)))))
