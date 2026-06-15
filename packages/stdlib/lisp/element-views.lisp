;;; element-views.lisp — register a view backed by an arbitrary custom
;;; HTML element, in a few lines of Lisp.
;;;
;;; The desktop host provides ONE generic view kind, `element`, plus the
;;; primitive `open-element-view!`. This file is the Lisp surface on top:
;;; `define-element-view` records a spec and defines a command that opens
;;; the view. Every embeddable web component a user drops in becomes a
;;; Godot view this way — no new host code per component.
;;;
;;; See plans/ELEMENT-VIEWS.md for the architecture.

;; kind (a symbol) -> spec (a hash-map). Pure data, for introspection
;; (`element-views`) and so a re-registration overwrites cleanly.
(define *element-views* {})

(define (register-element-view! kind spec)
  "Record an element-view KIND and its SPEC (a hash-map). Returns KIND,
   so a `define-element-view` echoes the kind (like `define`)."
  (set! *element-views* (assoc *element-views* kind spec))
  kind)

(define (element-views)
  "The registry of element-views — kind -> spec. Plain data."
  *element-views*)

(define (element-view-spec kind)
  "The spec hash-map for element-view KIND, or nil."
  (get *element-views* kind nil))

;; define-element-view — register an element-view and a command to open it.
;;
;;   (define-element-view atari
;;     :title    "Atari 2600"
;;     :module   "apps/desktop/vendor/stella/stella-element.js"
;;     :tag      "stella-emulator"
;;     :attrs    '((controls))
;;     :keyboard 'grab)
;;
;; KIND is an UNQUOTED symbol (like `defcommand`/`defcustom`); it names
;; both the view kind and the command. OPTS is a plist:
;;
;;   :title     modeline label (defaults to the tag)
;;   :module    the ES module to load; a repo-relative path is served from
;;              the app:// origin, an absolute app://-/http(s)-URL passes
;;              through. Loading it must define the custom element.
;;   :tag       the custom-element tag the module registers
;;   :attrs     a list of attributes — a bare symbol is a boolean attr, a
;;              list (name value) is a valued one: '((controls) (width "480px"))
;;   :keyboard  'grab (the element owns the keyboard while focused — the
;;              default), 'share (let C-/M-/A- chords through), or 'off
;;   :on-ready  optional (lambda (el) …) run once the element is created
;;
;; Expands to a `register-element-view!` plus a `defcommand` whose body
;; calls the host primitive with the spec hash-map.
(defmacro define-element-view (kind . opts)
  (let ((spec (cons 'hash-map (cons :kind (cons (list 'quote kind) opts)))))
    (list 'begin
          (list 'register-element-view! (list 'quote kind) spec)
          (list 'defcommand kind '()
                (string-append "Open the " (symbol->string kind)
                               " element view.")
                (list 'open-element-view! spec)))))
