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

(defgroup 'jmacs nil "All jmacs customisation.")

;; --- the registry ------------------------------------------------------

(define (custom-registered? name)
  "True when NAME names a registered setting."
  (contains? *custom-registry* name))

(define (custom-entry name)
  "The registry entry for setting NAME, or nil."
  (get *custom-registry* name nil))

(define (custom-register! name default type . options)
  "Record a setting in the registry. OPTIONS is keyword pairs —
   :group, :doc, :options. On a re-register (a hot reload) the
   existing :value is kept, so a setting the user has customised is
   not reset to its default."
  (let ((existing (custom-entry name))
        (opts (apply hash-map options)))
    (let ((value (if (nil? existing)
                     default
                     (get existing :value default))))
      (set! *custom-registry*
            (assoc *custom-registry* name
                   (hash-map :name name
                             :default default
                             :value value
                             :type type
                             :group (get opts :group 'jmacs)
                             :doc (get opts :doc "")
                             :options (get opts :options nil)))))))

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
  "The current session value of setting NAME, or nil."
  (let ((entry (custom-entry name)))
    (if (nil? entry) nil (get entry :value nil))))

(define (custom-default name)
  "The default value of setting NAME, or nil."
  (let ((entry (custom-entry name)))
    (if (nil? entry) nil (get entry :default nil))))

(define (custom-apply! name value)
  "Set setting NAME to VALUE for this session: update the registry and
   the live variable. Does nothing for an unregistered setting."
  (let ((entry (custom-entry name)))
    (when (not (nil? entry))
      (set! *custom-registry*
            (assoc *custom-registry* name (assoc entry :value value)))
      ;; The variable is named by data, so build and evaluate a set!.
      (eval (list 'set! name (list 'quote value))))))

(define (custom-reset! name)
  "Reset setting NAME to its default value."
  (custom-apply! name (custom-default name)))

(define (custom-state name)
  "The state of setting NAME: 'saved when its value is the persisted
   value, 'standard when it holds its default, 'set otherwise."
  (let ((entry (custom-entry name)))
    (cond
      ((nil? entry) 'standard)
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
   is the form the persisted custom file is built from."
  (custom-apply! name value)
  (let ((entry (custom-entry name)))
    (when (not (nil? entry))
      (set! *custom-registry*
            (assoc *custom-registry* name (assoc entry :saved value))))))

(define (custom-save! name)
  "Mark setting NAME's current value as its saved value."
  (let ((entry (custom-entry name)))
    (when (not (nil? entry))
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
