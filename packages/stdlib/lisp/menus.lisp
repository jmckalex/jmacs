;;; menus.lisp — mode menus.
;;;
;;; The host shows a native menu for the current buffer's mode. The
;;; menu is built from the mode's keymaps: every command they bind is
;;; listed, with the key sequence that runs it. `mode-menu-entries` is
;;; what the host calls to get that list — it walks the active minor
;;; modes' keymaps and the major mode's keymap, but not the global
;;; keymap, because the menu is mode-specific.
;;;
;;; Loaded after keymap.lisp and modes.lisp, whose accessors it uses.

(define (-flatten-keymap keymap prefix)
  "Entries (key-sequence . command-symbol) for KEYMAP. A nested keymap
   is a prefix: its entries carry PREFIX and the prefix key, joined by
   a space. Bindings that are neither a command nor a sub-keymap are
   skipped."
  (reduce
    (lambda (entries key)
      (let ((binding (get keymap key nil))
            (sequence (if (= (string-length prefix) 0)
                          key
                          (str prefix " " key))))
        (cond
          ((map? binding)
           (append entries (-flatten-keymap binding sequence)))
          ((symbol? binding)
           (append entries (list (cons sequence binding))))
          (else entries))))
    (list)
    (keys keymap)))

(define (-command-doc name)
  "The docstring of the command named NAME (a symbol), or an empty
   string when it has none."
  (let ((info (doc (eval name))))
    (if (string? info) info "")))

(define (mode-menu-entries)
  "The menu entries for the current buffer's mode keymaps — the active
   minor modes first, then the major mode. Each entry is a list
   (key-sequence command-name docstring), all strings. The global
   keymap is left out: this menu lists only mode-specific commands."
  (let ((keymaps (append (minor-mode-keymaps)
                         (list (major-mode-keymap)))))
    (map (lambda (entry)
           (list (car entry)
                 (symbol->string (cdr entry))
                 (-command-doc (cdr entry))))
         (reduce (lambda (entries keymap)
                   (if (nil? keymap)
                       entries
                       (append entries (-flatten-keymap keymap ""))))
                 (list)
                 keymaps))))
