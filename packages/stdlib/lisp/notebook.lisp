;;; notebook.lisp — the reactive engine for the Lisp notebook view.
;;;
;;; A notebook is a sequence of cells. Each cell has a *name* and a
;;; *form*; a cell may read another cell's value via `(ref 'name)`.
;;; Editing one cell recomputes everything downstream (spreadsheet /
;;; Observable style). The whole reactive engine — dependency discovery,
;;; the dependency graph, Kahn's topological sort, cycle detection,
;;; value-preservation across edits, and the value→string formatter — is
;;; implemented here in Lisp.
;;;
;;; This is the engine ported from the earlier `agent-reactive-notebook`
;;; branch, with its text-buffer surface removed: there is no
;;; buffer-text round-trip and no major mode. The custom-element
;;; `<notebook-view>` owns the cell editors and the result panels; it
;;; drives the engine through the single host bridge `notebook-eval!`,
;;; which returns plain marshallable per-cell records (name / output /
;;; state / error / deps) — never raw Lisp values.
;;;
;;; --- dep-tracking strategy ------------------------------------------
;;; Dependencies are discovered dynamically: a cell calls `(ref 'name)`
;;; and `ref` records, against the global *current-cell*, that the
;;; running cell read NAME. This is exact, naturally handles
;;; conditionals, and needs no static analysis. The interpreter has only
;;; lexical scope and global `set!`, so we simulate dynamic binding by
;;; saving the previous *current-cell*, set!-ing it for the duration of
;;; the cell body, then restoring it.
;;;
;;; --- cell isolation --------------------------------------------------
;;; A cell's body is evaluated in the global environment via `eval`, but
;;; the engine does NOT `define` cell names globally. Values live in the
;;; notebook's private :values map; `ref` reads them.

;; --- the notebook record ---------------------------------------------
;;
;; A notebook is a map:
;;   :cells   — a list of cell maps in source order
;;   :order   — a topologically sorted list of cell names
;;   :values  — a map name -> value (for `ref`)
;;
;; A cell is a map:
;;   :name    — the cell's symbol
;;   :form    — the cell's body expression (a Lisp form)
;;   :deps    — a list of names this cell read on its last run
;;   :value   — the cell's last value
;;   :output  — a printable label of :value
;;   :state   — :ok | :error | :stale
;;   :error   — an error message when :state is :error

;; --- dynamic *current-cell* via set! save/restore --------------------
;;
;; The interpreter has only lexical scope, so we fake dynamic binding:
;; save the previous binding into a local, set! the global for the
;; duration of the body, and restore it on the way out. The engine
;; catches around the whole eval; on error we restore in the catch.

(define *current-cell* nil)

(define (with-current-cell cell-name thunk)
  "Run THUNK with *current-cell* bound to CELL-NAME, then restore."
  (let ((previous *current-cell*)
        (result nil))
    (set! *current-cell* cell-name)
    (set! result (thunk))
    (set! *current-cell* previous)
    result))

;; --- the dependency-tracking ref -------------------------------------

;; The notebook the engine is currently driving — set by the recompute
;; pass. `ref` reads from it so the engine works without any buffer.
(define *engine-notebook* nil)

;; A list of (cell-name . dep-name) pairs collected during the current
;; recompute pass — flushed into each cell's :deps after the run.
(define *ref-trace* (list))

(define (ref name)
  "Look up NAME in the engine notebook, recording the dependency."
  (when (not (nil? *current-cell*))
    (set! *ref-trace* (cons (cons *current-cell* name) *ref-trace*)))
  (let* ((nb *engine-notebook*)
         (values (if (map? nb) (get nb :values {}) {})))
    (get values name nil)))

;; --- parsing the source ----------------------------------------------

(define (cell-form? form)
  "True if FORM is a `(cell NAME EXPR)` list."
  (and (pair? form)
       (eq? (car form) 'cell)
       (pair? (cdr form))
       (symbol? (cadr form))
       (pair? (cdr (cdr form)))))

(define (parse-cells source)
  "Read SOURCE and return a list of cell maps (just :name and :form)."
  (let ((forms (read-string source)))
    (-collect-cells forms (list))))

(define (-collect-cells forms acc)
  (cond
    ((nil? forms) (reverse acc))
    ((cell-form? (car forms))
     (-collect-cells (cdr forms)
                     (cons (-blank-cell (cadr (car forms))
                                        (caddr (car forms)))
                           acc)))
    (else (-collect-cells (cdr forms) acc))))

(define (-blank-cell name form)
  {:name name :form form :deps (list) :value nil :output "" :state :stale})

;; --- engine: dependency graph + Kahn's topo-sort ---------------------

(define (-dep-edges cells)
  "Edges as (from . to) — FROM depends on TO."
  (-flat-map (lambda (c)
               (map (lambda (d) (cons (get c :name nil) d))
                    (get c :deps (list))))
             cells))

(define (-flat-map f lst)
  (cond
    ((nil? lst) (list))
    (else (append (f (car lst)) (-flat-map f (cdr lst))))))

(define (-names cells)
  (map (lambda (c) (get c :name nil)) cells))

(define (-cell-by-name cells name)
  (cond
    ((nil? cells) nil)
    ((eq? (get (car cells) :name nil) name) (car cells))
    (else (-cell-by-name (cdr cells) name))))

(define (topo-sort cells)
  "Kahn's algorithm. Returns (:ok ordered-names) or (:cycle names)."
  (let* ((names (-names cells))
         (edges (-dep-edges cells)))
    (-kahn names edges (list))))

(define (-kahn remaining edges sorted)
  "Iterative Kahn's. REMAINING are unsorted names; SORTED is the result."
  (cond
    ((nil? remaining) (cons :ok (reverse sorted)))
    (else
      (let ((ready (-ready remaining edges)))
        (cond
          ((nil? ready) (cons :cycle remaining))
          (else
            (let ((picked (car ready)))
              (-kahn (-without picked remaining)
                     (-remove-edges-to picked edges)
                     (cons picked sorted)))))))))

(define (-ready remaining edges)
  "Names in REMAINING with no incoming edges among REMAINING."
  (filter (lambda (n) (= 0 (-in-degree-among n remaining edges)))
          remaining))

(define (-in-degree-among name remaining edges)
  "How many edges FROM something-in-REMAINING point to NAME? (excludes
   self-loops, which are caught as cycle errors elsewhere)."
  (cond
    ((nil? edges) 0)
    ((and (eq? (cdr (car edges)) name)
          (not (eq? (car (car edges)) name))
          (-member-eq? (car (car edges)) remaining))
     (+ 1 (-in-degree-among name remaining (cdr edges))))
    (else (-in-degree-among name remaining (cdr edges)))))

(define (-member-eq? x lst)
  (cond
    ((nil? lst) false)
    ((eq? (car lst) x) true)
    (else (-member-eq? x (cdr lst)))))

(define (-without item lst)
  (cond
    ((nil? lst) (list))
    ((eq? (car lst) item) (cdr lst))
    (else (cons (car lst) (-without item (cdr lst))))))

(define (-remove-edges-to name edges)
  (cond
    ((nil? edges) (list))
    ((eq? (cdr (car edges)) name) (-remove-edges-to name (cdr edges)))
    (else (cons (car edges) (-remove-edges-to name (cdr edges))))))

;; --- engine: evaluating a cell ---------------------------------------

(define (eval-cell-form cell)
  "Evaluate CELL's :form with dependency tracing. Returns an updated
   cell map (with :value, :output, :state, :deps refreshed). Catches
   errors and reports them as :state :error."
  (let* ((name (get cell :name nil))
         (form (get cell :form nil))
         (previous-trace *ref-trace*)
         (previous-cell *current-cell*))
    (set! *ref-trace* (list))
    (try
      (let* ((value (with-current-cell name (lambda () (eval form))))
             (deps (-extract-deps name *ref-trace*)))
        (set! *ref-trace* previous-trace)
        (set! *current-cell* previous-cell)
        (assoc (assoc (assoc (assoc cell :value value)
                             :output (-format-value value))
                      :deps deps)
               :state :ok))
      (catch err
        (let ((deps (-extract-deps name *ref-trace*))
              (msg (get err :message "error")))
          (set! *ref-trace* previous-trace)
          (set! *current-cell* previous-cell)
          (assoc (assoc (assoc (assoc cell :state :error)
                               :error msg)
                        :deps deps)
                 :output (str "! " msg)))))))

(define (-extract-deps name trace)
  "Names recorded in TRACE for cell NAME, deduplicated, in first-seen
   order."
  (-dedupe (-collect-names-for name (reverse trace))))

(define (-collect-names-for name pairs)
  (cond
    ((nil? pairs) (list))
    ((eq? (car (car pairs)) name)
     (cons (cdr (car pairs))
           (-collect-names-for name (cdr pairs))))
    (else (-collect-names-for name (cdr pairs)))))

(define (-dedupe lst)
  (cond
    ((nil? lst) (list))
    ((-member-eq? (car lst) (cdr lst))
     (-dedupe (cdr lst)))
    (else (cons (car lst) (-dedupe (cdr lst))))))

;; --- value formatter --------------------------------------------------

(define (-format-value v)
  "A printable label for a cell value."
  (cond
    ((nil? v) "nil")
    ((boolean? v) (if v "#t" "#f"))
    ((string? v) (str "\"" v "\""))
    ((number? v) (number->string v))
    ((symbol? v) (symbol->string v))
    ((pair? v) (str "(" (-format-list-items v) ")"))
    ((vector? v) (str "[" (-format-vector-items v 0) "]"))
    ((map? v) "<map>")
    (else (str v))))

(define (-format-list-items p)
  (cond
    ((nil? p) "")
    ((pair? p)
      (str (-format-value (car p))
           (if (nil? (cdr p)) "" " ")
           (-format-list-items (cdr p))))
    (else (-format-value p))))

(define (-format-vector-items v i)
  (cond
    ((>= i (vector-length v)) "")
    (else (str (-format-value (vector-ref v i))
               (if (= i (- (vector-length v) 1)) "" " ")
               (-format-vector-items v (+ i 1))))))

;; --- recompute: full and incremental ----------------------------------

(define (-update-cell-in-list cells name new-cell)
  "Replace the cell named NAME in CELLS with NEW-CELL."
  (cond
    ((nil? cells) (list))
    ((eq? (get (car cells) :name nil) name)
     (cons new-cell (cdr cells)))
    (else (cons (car cells)
                (-update-cell-in-list (cdr cells) name new-cell)))))

(define (-recompute-all nb)
  "Recompute every cell in NB in topological order. Sets the engine
   notebook so `ref` reads from this notebook during evaluation.

   Cycles can only show up once dependencies are known: a fresh
   notebook's cells have no :deps yet, so we run the topo-sort on the
   *post-recompute* graph. If a cycle appears, we run a SECOND pass —
   marking the cycle cells as :error — so they don't keep their stale
   (pre-cycle-detection) values."
  (let* ((cells (get nb :cells (list)))
         (sort-result (topo-sort cells))
         (order (cdr sort-result)))
    (cond
      ((eq? (car sort-result) :cycle)
       (-mark-cycle nb order))
      (else
        (let* ((stepped (-step-through-order nb order))
               (after-cells (get stepped :cells (list)))
               (after-sort (topo-sort after-cells)))
          (cond
            ;; A cycle emerged once deps were known.
            ((eq? (car after-sort) :cycle)
             (-mark-cycle stepped (cdr after-sort)))
            (else (assoc stepped :order order))))))))

(define (-step-through-order nb names)
  "Recompute each cell in NAMES, updating the notebook between steps so
   later cells see fresh upstream values via `ref`."
  (cond
    ((nil? names) nb)
    (else
      (let* ((name (car names))
             (cell (-cell-by-name (get nb :cells (list)) name))
             ;; Make this nb the engine's current notebook for `ref`.
             (saved-engine *engine-notebook*)
             (_ (set! *engine-notebook* nb))
             (new-cell (eval-cell-form cell))
             (_2 (set! *engine-notebook* saved-engine))
             (new-cells (-update-cell-in-list
                          (get nb :cells (list)) name new-cell))
             (new-values (if (eq? (get new-cell :state :stale) :ok)
                             (assoc (get nb :values {}) name
                                    (get new-cell :value nil))
                             (get nb :values {}))))
        (-step-through-order
          (assoc (assoc nb :cells new-cells) :values new-values)
          (cdr names))))))

(define (-mark-cycle nb names)
  "Mark every cell in NAMES as :error with a cycle message."
  (let ((message (str "cycle: " (-format-names names))))
    (assoc nb :cells
      (map (lambda (c)
             (if (-member-eq? (get c :name nil) names)
                 (assoc (assoc (assoc c :state :error)
                               :error message)
                        :output (str "! " message))
                 c))
           (get nb :cells (list))))))

(define (-format-names names)
  (cond
    ((nil? names) "")
    ((nil? (cdr names)) (symbol->string (car names)))
    (else (str (symbol->string (car names)) " -> "
               (-format-names (cdr names))))))

;; --- the public API: a notebook from source ---------------------------

(define (notebook-from-source source)
  "Parse SOURCE into a notebook and recompute every cell."
  (let* ((cells (parse-cells source))
         (nb {:cells cells :order (list) :values {}}))
    (-recompute-all nb)))

(define (notebook-update-source nb source)
  "Re-parse SOURCE preserving previously-computed :values where a cell's
   form is unchanged, then recompute."
  (let* ((new-cells (parse-cells source))
         (preserved (-preserve-known nb new-cells))
         (next (assoc nb :cells preserved)))
    (-recompute-all next)))

(define (-preserve-known nb new-cells)
  "For each cell in NEW-CELLS, if NB had a cell with the same name AND
   the same form, carry over its :value and :state — that cell needs no
   recompute. Otherwise mark :state :stale."
  (let ((old-cells (get nb :cells (list))))
    (map (lambda (nc)
           (let ((old (-cell-by-name old-cells (get nc :name nil))))
             (if (and (map? old) (equal? (get old :form nil)
                                         (get nc :form nil)))
                 (assoc (assoc (assoc nc :value (get old :value nil))
                               :output (get old :output ""))
                        :state (get old :state :stale))
                 nc)))
         new-cells)))

;; --- the host bridge --------------------------------------------------
;;
;; The `<notebook-view>` keeps one live notebook per view, keyed by a
;; host-supplied id. It sends the current source on every edit and gets
;; back the marshalled cells to repaint. Values are preserved across
;; edits (only changed cells recompute) because the previous notebook is
;; stored here and fed to `notebook-update-source`.

(define *notebooks* {})

(define (notebook-eval! id source)
  "Update notebook ID from SOURCE (preserving unchanged cells), store it,
   and return the marshalled per-cell records for the view to repaint."
  (let* ((existing (get *notebooks* id nil))
         (nb (if (map? existing)
                 (notebook-update-source existing source)
                 (notebook-from-source source))))
    (set! *notebooks* (assoc *notebooks* id nb))
    (-marshal-cells nb)))

(define (notebook-forget! id)
  "Drop the stored notebook for ID — called when its view is closed."
  (set! *notebooks* (assoc *notebooks* id nil)))

(define (-marshal-cells nb)
  "Project NB's cells into plain records the host can read without
   touching Lisp values: {:name <string> :output <string>
   :state <string> :error <string> :deps <list of strings>}. The state
   keyword is rendered to a string so the renderer needn't unwrap Lisp
   keywords."
  (map (lambda (c)
         {:name   (symbol->string (get c :name nil))
          :output (get c :output "")
          :state  (-state-string (get c :state :ok))
          :error  (get c :error "")
          :deps   (map symbol->string (get c :deps (list)))})
       (get nb :cells (list))))

(define (-state-string state)
  "A plain-string name for a cell :state keyword."
  (cond
    ((eq? state :error) "error")
    ((eq? state :stale) "stale")
    (else "ok")))
