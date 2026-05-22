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
;; Mode-specific bindings, consulted before the global keymap. Empty for
;; now — a mode can grow its own keys, including prefix maps.
(define lisp-mode-map {})
(define markdown-mode-map {})

;; --- the modes ---------------------------------------------------------
(define-mode fundamental-mode
  :name "Fundamental")

(define-mode lisp-mode
  :name "Lisp"
  :comment-prefix ";; "
  :highlight :lisp
  :keymap lisp-mode-map)

(define-mode markdown-mode
  :name "Markdown"
  :highlight :markdown
  :keymap markdown-mode-map)

(define-mode javascript-mode
  :name "JavaScript"
  :comment-prefix "// "
  :highlight :javascript)

;; --- the registry — a filename suffix chooses a major mode -------------
(define *mode-registry* (list))

(define (register-mode suffix mode)
  "Associate a filename SUFFIX with a major MODE."
  (set! *mode-registry* (cons (cons suffix mode) *mode-registry*)))

(register-mode ".lisp" lisp-mode)
(register-mode ".jmd"  markdown-mode)
(register-mode ".md"   markdown-mode)
(register-mode ".js"   javascript-mode)
(register-mode ".mjs"  javascript-mode)

(define (registry-lookup entries name)
  "Find the mode for NAME among registry ENTRIES, or fundamental-mode."
  (cond
    ((nil? entries) fundamental-mode)
    ((string-suffix? (caar entries) name) (cdr (car entries)))
    (else (registry-lookup (cdr entries) name))))

(define (mode-for-name name)
  "The major mode registered for a buffer NAME."
  (registry-lookup *mode-registry* name))

;; --- the current buffer's major mode -----------------------------------
(define (choose-major-mode!)
  "Set the current buffer's major mode from its name."
  (set-major-mode! (mode-for-name (buffer-name))))

(define (major-mode-name)
  "The display name of the current buffer's major mode."
  (let ((m (buffer-major-mode)))
    (if (nil? m) "Fundamental" (get m :name "Fundamental"))))

(define (major-mode-keymap)
  "The current buffer's major-mode keymap, or nil."
  (let ((m (buffer-major-mode)))
    (if (nil? m) nil (get m :keymap nil))))

(define (comment-prefix)
  "The comment prefix of the current buffer's major mode."
  (let ((m (buffer-major-mode)))
    (if (nil? m) ";; " (get m :comment-prefix ";; "))))
