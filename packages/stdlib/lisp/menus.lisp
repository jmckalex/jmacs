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

;; --- structured (nested) mode menus -----------------------------------
;;
;; `mode-menu-entries` above is the flat auto-menu: every bound command,
;; in keymap order. It is unchanged and remains what every mode gets by
;; default. A mode may *additionally* register a structured menu — a list
;; of named sections — so the host can show grouped submenus instead of
;; one long list. This is purely additive: a mode with no registration
;; has empty `mode-menu-sections` and the host keeps the flat path.
;;
;; A registration is keyed by the mode's display name (the same string
;; `major-mode-name` returns, e.g. "LaTeX"). Each section is
;;   (section-label (friendly-label . command-symbol) …)
;; The host resolves keys / docstrings per command from the flat
;; `mode-menu-entries` data, so a section need only name commands.

;; Registry: display-name → list of sections. A plain map so a later
;; registration for a mode overrides an earlier one.
(define *mode-menu-sections* {})

(define (register-mode-menu! mode-name sections)
  "Register SECTIONS as the structured menu for the major mode whose
   display name is MODE-NAME (the string `major-mode-name` returns).
   SECTIONS is a list of sections, each
     (section-label (friendly-label . command-symbol) …)
   This is additive: it does not affect `mode-menu-entries`, only the
   grouped menu the host builds when a registration is present. A later
   call for the same MODE-NAME replaces the earlier registration."
  (set! *mode-menu-sections*
        (assoc *mode-menu-sections* mode-name sections))
  sections)

(define (mode-menu-sections)
  "The registered structured menu (list of sections) for the current
   buffer's major mode, or nil when none is registered. Each section is
   (section-label (friendly-label . command-symbol) …). The host uses
   this — when non-nil — to build grouped submenus; otherwise it falls
   back to the flat `mode-menu-entries`."
  (get *mode-menu-sections* (major-mode-name) nil))

(define (mode-menu-sections-resolved)
  "The current mode's structured menu in a host-friendly, all-strings
   shape: a list of sections, each
     (section-label (friendly-label command-name) …)
   where command-name is the command symbol rendered as a string. This
   is `mode-menu-sections` with the dotted (friendly . symbol) leaves
   normalised to proper two-element lists, so the host can consume it
   with `listToArray` alone (no dotted-pair handling). Empty list — not
   nil — when the mode has no registration, so the host can test length."
  (let ((sections (mode-menu-sections)))
    (if (nil? sections)
        (list)
        (map (lambda (section)
               (cons (car section)
                     (map (lambda (leaf)
                            (list (car leaf)
                                  (symbol->string (cdr leaf))))
                          (cdr section))))
             sections))))
