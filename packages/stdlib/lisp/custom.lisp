;;; custom.lisp — the customisation registry.
;;;
;;; `defcustom` declares a user-customisable setting: a variable with a
;;; type, a group, a default and a docstring. Settings are recorded in
;;; a registry that the customisation view reads and writes. This file
;;; loads early in the standard library, so any later file may declare
;;; settings with `defcustom`.
;;;
;;; A setting carries its default and its current (session) value; its
;;; *state* — standard or set — is derived by comparing the two. The
;;; `saved` state and persistence are added by a later slice.

;; name (a symbol) -> setting map. A setting:
;;   {:name :default :value :type :group :doc :options}
(define *custom-registry* {})

;; name (a symbol) -> group map: {:name :parent :doc}
(define *custom-groups* {})

;; --- groups ------------------------------------------------------------

(define (defgroup name parent doc)
  "Register a customisation group: NAME, its PARENT group (nil for a
   root group), and a docstring. NAME and PARENT are symbols."
  (set! *custom-groups*
        (assoc *custom-groups* name
               (hash-map :name name :parent parent :doc doc))))

(defgroup 'godot nil "All Godot customisation.")

;; Registered here rather than beside its settings because they span
;; three files (indent.lisp, system.lisp, cite.lisp), all loaded later.
(defgroup 'editing 'godot "Editing behaviour: indentation, citations, system integration.")

;; --- the registry ------------------------------------------------------

(define (custom-registered? name)
  "True when NAME names a registered setting."
  (contains? *custom-registry* name))

(define (custom-entry name)
  "The registry entry for setting NAME, or #f when NAME is not a
   registered setting (miss convention: absence is #f, so the result
   is a safe bare if-test — entries are always maps, hence truthy)."
  (get *custom-registry* name))

(define (custom-register! name default type . options)
  "Record a setting in the registry. OPTIONS is keyword pairs —
   :group, :doc, :options, :on-change. On a re-register (a hot
   reload) the existing :value is kept, so a setting the user has
   customised is not reset to its default. :on-change is a
   (lambda (name value)) called by `custom-apply!` whenever the
   setting's value changes."
  (let ((existing (custom-entry name))
        (opts (apply hash-map options)))
    (let ((value (if (not existing)     ; a miss is #f, not nil
                     default
                     (get existing :value default))))
      (set! *custom-registry*
            (assoc *custom-registry* name
                   (hash-map :name name
                             :default default
                             :value value
                             :type type
                             :group (get opts :group 'godot)
                             :doc (get opts :doc "")
                             :options (get opts :options nil)
                             :on-change (get opts :on-change nil)))))))

;; defcustom — declare a setting and define it as an ordinary variable.
;; (defcustom *name* default :type :group 'g :doc "…")
;; The variable is defined to its *registered* value, so a hot reload
;; preserves a customised value rather than resetting it.
(defmacro defcustom (name default type . rest)
  (list 'begin
        (cons 'custom-register!
              (cons (list 'quote name) (cons default (cons type rest))))
        (list 'define name (list 'custom-value (list 'quote name)))))

;; --- reading and changing ----------------------------------------------

(define (custom-value name)
  "The current session value of setting NAME, or nil for an unknown
   setting. Deliberately nil, not #f: a boolean setting's value IS
   often #f, so the result can never discriminate a miss — use
   `custom-registered?` (or `custom-entry`) to test for absence."
  (let ((entry (custom-entry name)))
    (if entry (get entry :value nil) nil)))

(define (custom-default name)
  "The default value of setting NAME, or nil for an unknown setting
   (nil for the same reason as `custom-value`)."
  (let ((entry (custom-entry name)))
    (if entry (get entry :default nil) nil)))

(define (-find-symbol-option rest value)
  "Find the symbol in REST whose printed name matches the string VALUE.
   Returns the symbol, or nil if no match. Tail-recursive helper for
   `-coerce-for-type` — this Lisp dialect doesn't support named let."
  (cond
    ((nil? rest) nil)
    ((and (symbol? (car rest))
          (string=? (symbol->string (car rest)) value))
     (car rest))
    (else (-find-symbol-option (cdr rest) value))))

(define (-coerce-for-type value type options)
  "Coerce VALUE into the canonical shape for a setting of TYPE. Today
   only `:choice` needs this: an older save file (or a hand-edit) may
   record the value as a string `\"dark\"`, but the choice options are
   stored as symbols `'dark`. Without coercion `(eq? *theme* 'dark)`
   in downstream code fails on the string. For other types VALUE is
   passed through unchanged."
  (cond
    ((not (eq? type :choice)) value)
    ((not (string? value)) value)
    ((nil? options) value)
    (else
     (let ((found (-find-symbol-option options value)))
       (if (nil? found) value found)))))

(define (custom-apply! name value)
  "Set setting NAME to VALUE for this session: update the registry,
   the live variable, and run its :on-change hook if one is set.
   Does nothing for an unregistered setting."
  (let ((entry (custom-entry name)))
    (when entry                         ; a miss is #f, not nil
      (let ((coerced (-coerce-for-type
                      value
                      (get entry :type :string)
                      (get entry :options nil))))
        (set! *custom-registry*
              (assoc *custom-registry* name (assoc entry :value coerced)))
        ;; The variable is named by data, so build and evaluate a set!.
        (eval (list 'set! name (list 'quote coerced)))
        (let ((hook (get entry :on-change nil)))
          (when (procedure? hook) (hook name coerced)))))))

(define (custom-reset! name)
  "Reset setting NAME to its default value."
  (custom-apply! name (custom-default name)))

(define (custom-state name)
  "The state of setting NAME: 'saved when its value is the persisted
   value, 'standard when it holds its default, 'set otherwise."
  (let ((entry (custom-entry name)))
    (cond
      ((not entry) 'standard)           ; unknown setting: a #f miss
      ((and (contains? entry :saved)
            (equal? (get entry :value nil) (get entry :saved nil)))
       'saved)
      ((equal? (get entry :value nil) (get entry :default nil)) 'standard)
      (else 'set))))

;; --- persistence -------------------------------------------------------
;; A setting's value is persisted by recording it as the entry's :saved
;; value; `save-customizations` writes every saved setting to the
;; custom file, which `custom-set-saved!` forms reconstitute on load.

(define (custom-set-saved! name value)
  "Apply VALUE to setting NAME and record it as the saved value. This
   is the form the persisted custom file is built from. The saved
   value tracks the *coerced* value the entry now holds (e.g. a
   string-quoted `:choice` from a stale custom.lisp gets rewritten as
   a symbol on next save)."
  (custom-apply! name value)
  (let ((entry (custom-entry name)))
    (when entry
      (set! *custom-registry*
            (assoc *custom-registry* name
                   (assoc entry :saved (get entry :value nil)))))))

(define (custom-save! name)
  "Mark setting NAME's current value as its saved value."
  (let ((entry (custom-entry name)))
    (when entry
      (set! *custom-registry*
            (assoc *custom-registry* name
                   (assoc entry :saved (get entry :value nil)))))))

(define (customs-to-save)
  "A list of (name value) pairs for every setting that has a saved
   value — the data the custom file is written from."
  (map (lambda (name)
         (list name (get (custom-entry name) :saved nil)))
       (filter (lambda (name) (contains? (custom-entry name) :saved))
               (keys *custom-registry*))))

(define (save-customizations)
  "Write every saved setting to the custom file, to persist across
   restarts."
  (write-custom-file! (customs-to-save)))

(define (custom-apply-and-save! name value)
  "Set setting NAME to VALUE for this session and persist it."
  (custom-apply! name value)
  (custom-save! name)
  (save-customizations))

;; --- queries for the customisation view --------------------------------

(define (custom-group-names)
  "The names of every registered group."
  (keys *custom-groups*))

(define (custom-setting-names)
  "The names of every registered setting."
  (keys *custom-registry*))

(define (customs-in-group group)
  "The names of the settings whose :group is GROUP."
  (filter (lambda (name)
            (eq? (get (custom-entry name) :group nil) group))
          (keys *custom-registry*)))

(define (groups-in-group parent)
  "The names of the groups whose :parent is PARENT."
  (filter (lambda (name)
            (eq? (get (get *custom-groups* name {}) :parent nil) parent))
          (keys *custom-groups*)))

;; --- the customisation buffer ------------------------------------------

(defcommand customize ()
  "Open the customisation buffer for all settings."
  (open-customize!))

(define (customize-group group)
  "Open the customisation buffer for GROUP (a symbol)."
  (open-customize-group! (symbol->string group)))

(define (customize-variable name)
  "Open the customisation buffer for the single setting NAME."
  (open-customize-variable! (symbol->string name)))

;; The model the customisation view renders is plain data — strings,
;; values and lists — so the view needs no knowledge of the registry.

(define (custom-field name)
  "A setting as data for the view: a list
   (name type value default doc state options), with name, type and
   state as strings."
  (let ((entry (custom-entry name)))
    (list (symbol->string name)
          (str (get entry :type :string))
          (get entry :value nil)
          (get entry :default nil)
          (get entry :doc "")
          (str (custom-state name))
          (get entry :options nil))))

(define (-group-doc group)
  "The docstring of GROUP, or an empty string."
  (get (get *custom-groups* group {}) :doc ""))

(define (custom-group-model group)
  "The model for a group's customisation buffer: a list
   (title doc parent subgroups settings) — subgroups a list of
   (name doc) pairs, settings a list of custom-field results."
  (let ((parent (get (get *custom-groups* group {}) :parent nil)))
    (list (symbol->string group)
          (-group-doc group)
          (if (nil? parent) nil (symbol->string parent))
          (map (lambda (sub) (list (symbol->string sub) (-group-doc sub)))
               (groups-in-group group))
          (map custom-field (customs-in-group group)))))
