;;; indent.lisp — tab and indentation settings.
;;;
;;; Two customisable variables drive how the Tab key (and any future
;;; indent commands) behave:
;;;
;;;   *tab-width*       — How wide a literal tab character should look
;;;                       in the editor (CSS `tab-size`) and how many
;;;                       spaces `insert-tab` emits when tabs-mode is
;;;                       off. Default 4.
;;;
;;;   *indent-tabs-mode* — When `#t`, the Tab key inserts a literal
;;;                        `\t`; when `#f`, it inserts `*tab-width*`
;;;                        spaces. Default `#t` (literal tabs).
;;;
;;; A major mode can pin either to a mode-local value via the
;;; `:indent-tabs?` and `:tab-width` keys on the mode map; those win
;;; over the global setting. Makefile-mode in particular pins
;;; `:indent-tabs?` to `#t` (a Makefile with leading spaces is broken,
;;; not a style choice).

(defcustom *tab-width* 4 :number
  :group 'editing
  :doc "How many columns wide a tab character should appear, and how
        many spaces `insert-tab` produces when `*indent-tabs-mode*` is
        off. Applies to the editor view and the directory-columns
        preview pane via the `--tab-width` CSS variable — the host
        synchronises the var after stdlib load and on every
        customisation change of this setting.")

(defcustom *indent-tabs-mode* #t :boolean
  :group 'editing
  :doc "When `#t` (the default), the Tab key inserts a literal tab
        character; when `#f`, it inserts `*tab-width*` spaces. A major
        mode can pin a mode-local value via the `:indent-tabs?` key on
        its mode map, which wins over this global setting (Makefile-mode
        pins it on; a mode that needs spaces can pin it off).")

(define (-indent-tabs-effective)
  "Whether the Tab key should insert a literal tab right now: the
   current mode's `:indent-tabs?` if set, otherwise the global
   `*indent-tabs-mode*`. Used by `insert-tab` in editing.lisp."
  (let* ((mode (buffer-major-mode))
         (mode-flag (if (nil? mode) nil (get mode :indent-tabs? nil))))
    (if (nil? mode-flag) *indent-tabs-mode* mode-flag)))

(define (-tab-width-effective)
  "How wide a tab is right now: the current mode's `:tab-width` if set,
   otherwise the global `*tab-width*`."
  (let* ((mode (buffer-major-mode))
         (mode-width (if (nil? mode) nil (get mode :tab-width nil))))
    (if (nil? mode-width) *tab-width* mode-width)))
