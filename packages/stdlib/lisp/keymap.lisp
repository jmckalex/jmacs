;;; keymap.lisp — the default key bindings, and key dispatch.
;;;
;;; The renderer reports each keystroke as a normalised string: a single
;;; character for printable keys ("a", " "), a name for the rest
;;; ("left", "backspace"), with modifier prefixes "C-" (Ctrl/Cmd),
;;; "M-" (Command — Meta, Emacs-on-Mac style), "A-" (Option — free for
;;; user bindings; an UNBOUND A- chord falls through to inserting the
;;; character Option composed, so curly quotes and accents type
;;; natively) and "S-" (Shift) — e.g. "S-left", "C-z", "M-x", "A-]".
;;;
;;; A keymap maps a key string to either a command *name* (a symbol) or
;;; a nested keymap. A nested keymap is a prefix: press the prefix key,
;;; then a key from that map — this is how "C-x C-f" works. Commands
;;; are bound by name and resolved late, so redefining one takes effect
;;; immediately.

;; The C-x r prefix map — bookmarks (Emacs's register/bookmark family).
;; C-x r m set · C-x r b jump. (C-x r l list arrives with the bookmark
;; view.) C-x r d is left free — it is delete-rectangle in Emacs; delete
;; a bookmark via M-x bookmark-delete or the bookmark list.
(define bookmark-keymap
  {"m" 'bookmark-set
   "b" 'bookmark-jump
   "l" 'list-bookmarks})

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
   ;; n was new-view (still on M-x); a seeded scratch is the more
   ;; useful reach — architect's call, 2026-06-12.
   "n"     'scratch-buffer
   "k"     'kill-view
   "p"     'toggle-repl
   ;; C-x m — toggle the minimap companion pane (packages/stdlib/lisp/minimap.lisp).
   "m"     'toggle-minimap
   "h"     'mark-whole-buffer
   ";"     'comment-line
   "C-d"   'duplicate-line
   "C-j"   'join-line
   "j"     'jukebox
   "C-x"   'exchange-point-and-mark
   "C-e"   'eval-expression-before-point
   ;; C-x r — bookmarks (set / jump; see bookmark-keymap above).
   "r"     bookmark-keymap
   ;; Panes (phase 3a of plans/PANES.md) — Emacs's C-x 2/3/0/1/o.
   "0"     'delete-pane
   "1"     'delete-other-panes
   "2"     'split-vertical
   "3"     'split-horizontal
   "o"     'other-pane
   ;; Visual add-pane macro: highlights every splitter + the four
   ;; outer borders of the editor area; click one to insert there.
   "+"     'add-pane
   ;; Move-views-between-panes commands (jmacs additions; no Emacs
   ;; analogue). `x` sends the focused view to the next pane;
   ;; capital-X swaps with it. Same alphabet position as `o` for
   ;; navigating between panes.
   "x"     'send-view-to-other-pane
   "X"     'swap-with-other-pane
   ;; Spatial pane navigation. C-x <arrow> is already taken
   ;; (next/previous-view); use C-x C-<arrow>.
   "C-left"   'focus-pane-left
   "C-right"  'focus-pane-right
   "C-up"     'focus-pane-up
   "C-down"   'focus-pane-down})

;; The C-h prefix map — help.
(define c-h-keymap
  {"d" 'open-manual
   "k" 'describe-key
   "f" 'describe-command
   "F" 'describe-face-at-point
   "C-f" 'highlight-construct-at-point
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
   "D"         'select-all-matches
   ;; C-c g opens a gnuplot buffer (see gnuplot.lisp). Bound by symbol;
   ;; the command resolves at dispatch time, so load order doesn't matter.
   "g"         'gnuplot
   ;; C-c n opens a reactive Lisp notebook (see notebook-commands.lisp);
   ;; C-c C-n / C-c C-p cycle among open notebooks.
   "n"         'notebook
   "C-n"       'next-notebook
   "C-p"       'previous-notebook})

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
   ;; ESC clears the selection on every cursor without collapsing the
   ;; multi-cursor set — `C-c d` / `C-c D` followed by ESC drops the
   ;; selections to bare carets, ready to navigate or type a prefix.
   "escape"       'deselect
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
   ;; Cmd+Z / Cmd+Shift+Z. Before Command-as-Meta these reached C-z by
   ;; modifier folding; now they arrive as M-z and must be claimed —
   ;; the Edit menu's role-based Undo they'd otherwise fall through to
   ;; drives the native DOM undo stack, which can't see the buffer.
   ;; (Native inputs — REPL, minibuffer — still get the role: the key
   ;; router only fires while the editing surface has focus.)
   "M-z"          'undo
   "M-S-z"        'redo
   ;; Universal-argument prefix. Pressing C-u sets `*prefix-arg*` so
   ;; the next command can alter its behaviour (e.g. flip a split's
   ;; direction). Numeric multi-press isn't supported yet — a single
   ;; C-u is treated as a boolean "argument present".
   "C-u"          'universal-argument
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
   ;; Arrow word motion — synonyms for M-f/M-b (and on the Option side
   ;; too, matching the macOS-native Option+arrow habit).
   "M-right"      'forward-word
   "M-left"       'backward-word
   "A-right"      'forward-word
   "A-left"       'backward-word
   ;; Shifted arrow motion selects: word-wise left/right (on both the
   ;; Meta and Option sides), line-wise up/down.
   "M-S-right"    'forward-word-extending
   "M-S-left"     'backward-word-extending
   "A-S-right"    'forward-word-extending
   "A-S-left"     'backward-word-extending
   "M-S-up"       'previous-line-extending
   "M-S-down"     'next-line-extending
   "A-S-up"       'previous-line-extending
   "A-S-down"     'next-line-extending
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
   ;; Sublime-style block indentation (line-ops.lisp), on Cmd+[ / Cmd+].
   ;; (With Command as Meta these no longer collide with Option-chord
   ;; quote macros — Option is the separate "A-" modifier.)
   "M-["          'outdent-region
   "M-]"          'indent-region
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

;; While a key sequence is in progress this holds the *list* of prefix
;; keymaps the next keystroke is looked up in — every map along the mode
;; chain that bound the chord-leading key to a prefix sub-map. Mid-chord
;; lookup walks the stack in chain order, so a mode-local prefix doesn't
;; shadow the global one for keys it doesn't itself bind: pressing C-c d
;; in markdown-mode (whose markdown-c-c-map has no `d`) falls through to
;; the global c-c-keymap, finds `'add-cursor-next`, and runs it.
;;
;; At rest the value is nil, meaning the next key is resolved through
;; the buffer's mode chain afresh (see lookup-key).
(define active-keymap nil)

;; The keys typed in the current sequence, joined with spaces. When
;; `active-keymap` is nil this is the empty string and the echo area
;; is clear; mid-sequence it shows what's been typed so far, with a
;; trailing dash signalling that more keys are coming.
(define *chord-prefix* "")

;; The pending universal-argument, consumed by the next command. Nil
;; when no C-u has been pressed; #t after a single C-u. Commands that
;; care (e.g. split-horizontal / split-vertical) consult this variable
;; to alter their behaviour. `handle-key` clears it as soon as a
;; non-universal-argument command runs.
(define *prefix-arg* nil)

(define (reset-prefix-arg!)
  "Clear the pending universal-argument."
  (set! *prefix-arg* nil))

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

(define (-prefix-maps-for key maps)
  "Walk MAPS and collect every *prefix-map* binding of KEY (those whose
   value is itself a keymap), in chain order. Stops short of any map
   whose KEY binding is a command — that command would have already
   run as the chord-leading keystroke, so we never reach the chord."
  (cond
    ((nil? maps) (list))
    ((nil? (car maps)) (-prefix-maps-for key (cdr maps)))
    (else
      (let ((b (get (car maps) key nil)))
        (cond
          ((nil? b) (-prefix-maps-for key (cdr maps)))
          ((map? b) (cons b (-prefix-maps-for key (cdr maps))))
          ;; A command binding at this level — chord fallthrough stops;
          ;; the command at this level can't be reached mid-chord (the
          ;; chord was entered by a higher-priority prefix), but neither
          ;; should it interfere.
          (else (-prefix-maps-for key (cdr maps))))))))

(define (-lookup-in-stack key maps)
  "Mid-chord lookup: walk MAPS (the active prefix-map stack) and return
   the first non-nil binding of KEY across them, or nil. A command in a
   higher-priority map shadows a same-keyed binding lower down — same
   precedence as the chain at rest."
  (cond
    ((nil? maps) nil)
    (else
      (let ((b (get (car maps) key nil)))
        (if (nil? b)
            (-lookup-in-stack key (cdr maps))
            b)))))

(define (lookup-key key)
  "Resolve KEY: through every prefix map in the active stack mid-chord,
   otherwise through the buffer's mode chain afresh."
  (if (nil? active-keymap)
      (lookup-in-chain key (keymap-chain))
      (-lookup-in-stack key active-keymap)))

(defcommand keyboard-quit ()
  "Abort a partial key sequence and clear the selection (C-g)."
  (reset-keymap!)
  (reset-prefix-arg!)
  (clear-mark!))

(defcommand universal-argument ()
  "Set the pending prefix-argument (so the next command sees a non-nil
   `*prefix-arg*`). Bound to `C-u`. Commands that consult the prefix
   alter their behaviour — e.g. `C-u C-x 2` splits the pane above
   instead of below, `C-u C-x 3` to the left instead of right."
  (set! *prefix-arg* #t)
  ;; Echo the chord so the user sees the prefix was registered.
  (show-status! "C-u-"))

(define (self-insert-key? key)
  "True when KEY is a single character to be inserted as text."
  (and (string? key) (= (string-length key) 1)))

;; A procedure to receive the next keystroke instead of the keymap, or
;; nil. This is how a command like describe-key reads a key.
(define *key-reader* nil)

(define (read-next-key callback)
  "Route the next keystroke to CALLBACK rather than the keymap."
  (set! *key-reader* callback))

(define (chord-in-progress?)
  "True when a multi-key sequence is mid-flight (a prefix chord has
   started) or a key-reader is pending — i.e. the next keystroke, even a
   plain character, should be routed to the keymap rather than typed. A
   non-text input view (e.g. the gnuplot prompt) consults this so the
   continuation of C-x 3 etc. completes even though `3` carries no
   modifier."
  (or (not (nil? active-keymap)) (not (nil? *key-reader*))))

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
          ;; and show the running prefix in the echo area. The active
          ;; stack collects every prefix-map this key resolves to so
          ;; that mid-chord lookups can fall through past mode-local
          ;; maps. At rest we walk the full mode chain; mid-chord we
          ;; descend into the current stack instead.
           ((map? binding)
            (set! active-keymap
                  (if (nil? active-keymap)
                      (-prefix-maps-for key (keymap-chain))
                      (-prefix-maps-for key active-keymap)))
            (-extend-chord-prefix! key)
            #t)
          ;; A command name: run it, then return to rest. The chord
          ;; display is cleared by reset-keymap! before the command
          ;; runs, so a command's own echo-area message is not
          ;; overwritten by the cleanup. The pending prefix-arg is
          ;; cleared *after* the command runs (so it sees the value),
          ;; but only when the command isn't `universal-argument` —
          ;; that command exists to *set* the prefix and clearing it
          ;; right after would defeat the purpose.
          ((symbol? binding)
           (reset-keymap!)
           (run-command binding)
           (when (not (eq? binding 'universal-argument))
             (reset-prefix-arg!))
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
