;;; modes.lisp — major modes.
;;;
;;; A mode is a map: it carries a display name, an optional keymap, a
;;; comment prefix and a highlighter hint. A buffer's major mode is
;;; chosen from its name. See docs/spec/modes.md.

;; define-mode — sugar. (define-mode lisp-mode :name "Lisp" ...) builds
;; the mode map and binds it.
(defmacro define-mode (name . pairs)
  (list 'define name (cons 'hash-map pairs)))

;; --- mode keymaps ------------------------------------------------------
;; Mode-specific bindings, consulted before the global keymap. A mode
;; refers to its keymap by name (a symbol), so a feature file can fill
;; the map in later and edits to it are seen live (see resolve-keymap).
(define lisp-mode-map {})
(define markdown-mode-map {})
(define latex-mode-map {})
(define makefile-mode-map {})

;; --- the modes ---------------------------------------------------------
(define-mode fundamental-mode
  :name "Fundamental")

(define-mode lisp-mode
  :name "Lisp"
  :comment-prefix ";; "
  :highlight :lisp
  :keymap 'lisp-mode-map)

(define-mode markdown-mode
  :name "Markdown"
  :highlight :markdown
  :keymap 'markdown-mode-map)

;; Languages with their own tree-sitter grammar live under
;; `languages/`, each in its own drop-in file. The ones still defined
;; here are the hand-tokenized languages (no published grammar / no
;; tree-sitter yet).
(define-mode latex-mode
  :name "LaTeX"
  :comment-prefix "% "
  :keymap 'latex-mode-map
  :highlight :latex)

(define-mode makefile-mode
  :name "Makefile"
  :comment-prefix "# "
  :keymap 'makefile-mode-map
  :highlight :makefile
  ;; A Makefile recipe needs a literal tab as its leading character;
  ;; spaces are a hard error from `make`. Pin :indent-tabs? on so the
  ;; Tab key produces a real `\t` regardless of the global setting.
  :indent-tabs? #t)

;; The shell mode — a `shell`-kind buffer is shown through the L4 shell
;; view, not the editor view, so no text-buffer keymap applies. The
;; mode exists for the modeline label only. See `shell.lisp` and
;; `packages/renderer/src/shell-view.js`.
(define-mode shell-mode
  :name "Shell")

;; The gnuplot mode — a `gnuplot`-kind buffer is shown through the L4
;; gnuplot view (a notebook REPL), not the editor view, so no text-buffer
;; keymap applies. The mode exists for the modeline label only. See
;; `gnuplot.lisp` and `packages/renderer/src/gnuplot-view.js`.
(define-mode gnuplot-mode
  :name "Gnuplot")

;; Note: a jukebox buffer is *not* a text buffer — it is shown through
;; the L4 jukebox view, not the editor view, so no major mode applies.
;; See `jukebox.lisp` and `packages/renderer/src/jukebox-view.js`.

;; --- the registry — a filename suffix chooses a major mode -------------
(define *mode-registry* (list))

(define (register-mode suffix mode)
  "Associate a filename SUFFIX with a major MODE."
  (set! *mode-registry* (cons (cons suffix mode) *mode-registry*)))

;; The core stdlib registers only the modes defined above (and a few
;; suffixes those modes catch); the tree-sitter languages register
;; their own suffixes from `languages/<name>.lisp`.
(register-mode ".lisp"    lisp-mode)
(register-mode ".jmd"     markdown-mode)
(register-mode ".md"      markdown-mode)
(register-mode ".tex"     latex-mode)
(register-mode ".latex"   latex-mode)
(register-mode "Makefile" makefile-mode)
(register-mode "makefile" makefile-mode)
(register-mode ".mk"      makefile-mode)

(define (registry-lookup entries name)
  "Find the mode for NAME among registry ENTRIES, or fundamental-mode."
  (cond
    ((nil? entries) fundamental-mode)
    ((string-suffix? (caar entries) name) (cdr (car entries)))
    (else (registry-lookup (cdr entries) name))))

(define (mode-for-name name)
  "The major mode registered for a buffer NAME."
  (registry-lookup *mode-registry* name))

;; --- mode hooks --------------------------------------------------------
(define (run-mode-hook mode key)
  "Run MODE's hook stored under KEY (a procedure), if it has one."
  (unless (nil? mode)
    (let ((hook (get mode key nil)))
      (when (procedure? hook) (hook)))))

;; --- the current buffer's major mode -----------------------------------
(define (switch-major-mode mode)
  "Make MODE the current buffer's major mode, running the old mode's
   :on-disable hook and the new mode's :on-enable hook."
  (run-mode-hook (buffer-major-mode) :on-disable)
  (set-major-mode! mode)
  (run-mode-hook mode :on-enable))

(define (choose-major-mode!)
  "Set the current view's major mode from its (view) name."
  (switch-major-mode (mode-for-name (view-name))))

(define (major-mode-name)
  "The display name of the current buffer's major mode."
  (let ((m (buffer-major-mode)))
    (if (nil? m) "Fundamental" (get m :name "Fundamental"))))

(define (resolve-keymap k)
  "Resolve a mode's :keymap — a symbol naming a keymap, or a keymap
   itself. Resolving by name means the keymap stays live-editable."
  (cond
    ((nil? k) nil)
    ((symbol? k) (eval k))
    (else k)))

(define (major-mode-keymap)
  "The current buffer's major-mode keymap, or nil."
  (let ((m (buffer-major-mode)))
    (if (nil? m) nil (resolve-keymap (get m :keymap nil)))))

(define (comment-prefix)
  "The comment prefix of the current buffer's major mode."
  (let ((m (buffer-major-mode)))
    (if (nil? m) ";; " (get m :comment-prefix ";; "))))

;; --- minor modes -------------------------------------------------------
;; Minor modes are orthogonal, toggleable. They stack by an explicit
;; :priority — higher first — ahead of the major mode in the keymap
;; chain (see keymap.lisp).

(define (minor-modes)
  "The current buffer's active minor modes, as a list."
  (let ((m (buffer-minor-modes)))
    (if (nil? m) (list) m)))

(define (mode-priority mode)
  "A mode's :priority (default 0)."
  (get mode :priority 0))

(define (insert-by-priority mode modes)
  "Insert MODE into MODES, keeping descending :priority order."
  (cond
    ((nil? modes) (list mode))
    ((>= (mode-priority mode) (mode-priority (car modes))) (cons mode modes))
    (else (cons (car modes) (insert-by-priority mode (cdr modes))))))

(define (without-item item lst)
  "LST with the first ITEM (compared by identity) removed."
  (cond
    ((nil? lst) (list))
    ((eq? item (car lst)) (cdr lst))
    (else (cons (car lst) (without-item item (cdr lst))))))

(define (enable-minor-mode mode)
  "Activate a minor MODE in the current buffer. Idempotent."
  (unless (member mode (minor-modes))
    (set-minor-modes! (insert-by-priority mode (minor-modes)))
    (run-mode-hook mode :on-enable)))

(define (disable-minor-mode mode)
  "Deactivate a minor MODE in the current buffer."
  (when (member mode (minor-modes))
    (set-minor-modes! (without-item mode (minor-modes)))
    (run-mode-hook mode :on-disable)))

(define (minor-mode-keymaps)
  "The keymaps of the active minor modes, highest priority first."
  (map (lambda (m) (resolve-keymap (get m :keymap nil))) (minor-modes)))

(define (join-minor-names modes)
  "Each minor mode's name, two-space-prefixed and concatenated."
  (if (nil? modes)
      ""
      (str "  " (get (car modes) :name "?")
           (join-minor-names (cdr modes)))))

(define (minor-mode-line)
  "The active minor mode names, for the modeline."
  (join-minor-names (minor-modes)))
