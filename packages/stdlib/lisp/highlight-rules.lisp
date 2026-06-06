;;; highlight-rules.lisp — the Lisp customisation surface for syntax
;;; highlighting: user-defined `kind -> face` rules that the JS engine
;;; applies ON TOP of each language's built-in tree-sitter query.
;;;
;;; The principle: JavaScript holds the DEFAULTS (the per-language
;;; highlight queries in `packages/renderer/src/languages/*.js`); the
;;; user OVERRIDES/EXTENDS them from here, live, without editing those
;;; files or restarting. A rule maps a tree-sitter pattern (a node type,
;;; or a small query fragment) to a registered face. The host pushes the
;;; current rule set into the highlighter, which augments the base query,
;;; recompiles, and re-paints.
;;;
;;; Two scopes:
;;;   - 'mode      this major mode only (the default) — keyed by the
;;;                mode's display name (e.g. "LaTeX", "Python")
;;;   - 'language  everywhere for the language — keyed by the language
;;;                tag (e.g. "latex", "python")
;;;
;;; Persistence: the rule set is part of faces.json (see faces-store.lisp
;;; / face-overrides.js). `add-highlight-rule!` and friends persist via
;;; the same `*face-overrides-saver*` hook the colour overrides use.

;; The live rule store. A hash-map keyed by a scope string:
;;   "mode:<Mode Name>"  -> a list of (pattern . face) cons pairs
;;   "lang:<tag>"        -> a list of (pattern . face) cons pairs
;; Order within a bucket is preserved (it can affect match precedence).
(define *highlight-rules* {})

;; --- scope keys --------------------------------------------------------

(define (-hr-scope-key scope key)
  "The store key for SCOPE ('mode or 'language) and KEY (a string —
   the mode display name, or the language tag)."
  (cond
    ((eq? scope 'mode)     (str "mode:" key))
    ((eq? scope 'language) (str "lang:" key))
    (else (error (str "unknown highlight-rule scope: " scope)))))

(define (-hr-bucket scope key)
  "The current rule list for SCOPE/KEY, or the empty list."
  (get *highlight-rules* (-hr-scope-key scope key) '()))

;; --- mutation ----------------------------------------------------------

(define (-hr-without pattern rules)
  "RULES with any rule whose pattern = PATTERN removed."
  (cond
    ((nil? rules) '())
    ((string=? (car (car rules)) pattern) (-hr-without pattern (cdr rules)))
    (else (cons (car rules) (-hr-without pattern (cdr rules))))))

(define (-hr-set-bucket! scope key rules)
  "Replace SCOPE/KEY's bucket with RULES (a list of (pattern . face)).
   An empty bucket is dropped from the store entirely."
  (let ((k (-hr-scope-key scope key)))
    (set! *highlight-rules*
          (if (nil? rules)
              (dissoc *highlight-rules* k)
              (assoc *highlight-rules* k rules)))))

(define (add-highlight-rule! scope key pattern face)
  "Add (or replace) a highlight rule: in SCOPE ('mode or 'language) for
   KEY (the mode display name, or the language tag), paint nodes matching
   PATTERN (a tree-sitter node type or query fragment, a string) with
   FACE (a registered face name — a symbol or string). Re-pushes the rule
   set to the highlighter (live) and persists. Side-effecting; note the
   `!`."
  (let* ((face-str (if (symbol? face) (symbol->string face) (str face)))
         (existing (-hr-without pattern (-hr-bucket scope key)))
         (updated (append existing (list (cons pattern face-str)))))
    (-hr-set-bucket! scope key updated)
    (-on-highlight-rules-change!)))

(define (remove-highlight-rule! scope key pattern)
  "Remove the highlight rule for PATTERN in SCOPE/KEY. Re-pushes + persists."
  (-hr-set-bucket! scope key (-hr-without pattern (-hr-bucket scope key)))
  (-on-highlight-rules-change!))

(define (clear-highlight-rules!)
  "Drop every user highlight rule. Re-pushes + persists."
  (set! *highlight-rules* {})
  (-on-highlight-rules-change!))

;; --- data accessors (no side effects) ----------------------------------

(define (highlight-rules)
  "The whole rule store: a hash-map of scope-key -> list of
   (pattern . face). Plain data, no side effects."
  *highlight-rules*)

(define (highlight-rules-for scope key)
  "The list of (pattern . face) rules for SCOPE/KEY, or '()."
  (-hr-bucket scope key))

;; --- flattening for the host -------------------------------------------
;; The host's `set-highlight-overrides!` primitive takes a flat list of
;; records, one per rule: {:scope "mode"|"language", :key, :pattern, :face}.
;; (Scope is a *string* across the bridge — the engine matches on it.)

(define (-hr-scope-string store-key)
  "Decode a store key (\"mode:…\" / \"lang:…\") to the host scope string."
  (cond
    ((string-prefix? "mode:" store-key) "mode")
    ((string-prefix? "lang:" store-key) "language")
    (else "language")))

(define (-hr-scope-value store-key)
  "Decode a store key to its KEY part (mode name or language tag)."
  (cond
    ((string-prefix? "mode:" store-key) (substring store-key 5))
    ((string-prefix? "lang:" store-key) (substring store-key 5))
    (else store-key)))

(define (-hr-bucket->records store-key rules)
  "Turn one bucket (its STORE-KEY and its (pattern . face) RULES) into a
   list of host records."
  (let ((scope (-hr-scope-string store-key))
        (kv (-hr-scope-value store-key)))
    (map (lambda (rule)
           (hash-map :scope scope
                     :key kv
                     :pattern (car rule)
                     :face (cdr rule)))
         rules)))

(define (-hr-flatten-step store-keys acc)
  "Accumulate every bucket's records into ACC."
  (if (nil? store-keys)
      acc
      (-hr-flatten-step
        (cdr store-keys)
        (append acc
                (-hr-bucket->records (car store-keys)
                                     (get *highlight-rules* (car store-keys) '()))))))

(define (highlight-rule-records)
  "The whole rule store flattened into a list of host records, ready for
   `set-highlight-overrides!`."
  (-hr-flatten-step (keys *highlight-rules*) '()))

;; --- the live + persist hook -------------------------------------------

(define (-on-highlight-rules-change!)
  "Push the rule set to the highlighter (live) and persist. The host
   primitive `set-highlight-overrides!` recompiles the affected queries
   and bumps the override generation so open buffers re-highlight."
  (set-highlight-overrides! (highlight-rule-records))
  (when (procedure? *face-overrides-saver*)
    (*face-overrides-saver*)))

(define (push-highlight-rules!)
  "Push the current rule set to the highlighter without persisting.
   Called by the host after load / reload-stdlib to (re-)install rules
   into a freshly-built highlighter set."
  (set-highlight-overrides! (highlight-rule-records)))

;; --- loading from persistence ------------------------------------------

(define (set-highlight-rules! store)
  "Replace the live rule store with STORE (a hash-map of scope-key ->
   list of (pattern . face)). Pushes to the highlighter but DOES NOT
   persist — the host calls this during load, when persisting would loop."
  (set! *highlight-rules* (if (nil? store) {} store))
  (push-highlight-rules!))
