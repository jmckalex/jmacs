;;; commands.lisp — the command system.
;;;
;;; A *command* is a procedure declared with `defcommand`. Unlike a
;;; plain `define`d procedure, a command is recorded in a registry, so
;;; M-x offers it whether or not it is bound to a key.
;;;
;;; defcommand also carries an optional `(interactive …)` clause that
;;; declares how the command's arguments are gathered — from the
;;; region, the cursor, a minibuffer prompt — so a command is an
;;; ordinary function, callable both programmatically and by name.
;;;
;;; Loaded first in the standard library — every command file declares
;;; its commands with `defcommand`.

;; name (a symbol) -> the command's interactive spec, or nil.
(define *commands* {})

(define (register-command! name spec)
  "Record command NAME and its interactive SPEC in the registry."
  (set! *commands* (assoc *commands* name spec)))

(define (command-registered? name)
  "True when NAME names a registered command."
  (contains? *commands* name))

(define (registered-command-names)
  "The names of every registered command, as strings."
  (map symbol->string (keys *commands*)))

;; defcommand — define a procedure and register it as a command.
;;
;;   (defcommand name (params…) "doc"? (interactive source…)? body…)
;;
;; The optional (interactive …) clause is the first body form after the
;; docstring; its sources declare how the command's arguments are read.
(defmacro defcommand (name params . rest)
  (let* ((has-doc (and (pair? rest) (string? (car rest))))
         (after-doc (if has-doc (cdr rest) rest))
         (has-spec (and (pair? after-doc)
                        (pair? (car after-doc))
                        (eq? (car (car after-doc)) 'interactive)))
         (spec (if has-spec (cdr (car after-doc)) nil))
         (body (if has-spec (cdr after-doc) after-doc))
         (define-body (if has-doc (cons (car rest) body) body)))
    (list 'begin
          (cons 'define (cons (cons name params) define-body))
          (list 'register-command!
                (list 'quote name)
                (list 'quote spec)))))

;; --- the interactive argument gatherer ---------------------------------
;;
;; A command's `(interactive …)` spec is a list of source descriptors.
;; Each descriptor yields one or more values; concatenated in order they
;; are the command's arguments. Synchronous sources (point, region) are
;; read at once; asynchronous sources (minibuffer prompts) suspend and
;; resume in a callback — a continuation-style fold over the spec.

;; A procedure awaiting a minibuffer result, or nil.
(define *minibuffer-reader* nil)

(define (minibuffer-read prompt callback)
  "Prompt in the minibuffer; CALLBACK receives the entered string, or
   nil when the prompt is cancelled."
  (set! *minibuffer-reader* callback)
  (open-minibuffer! prompt))

(define (minibuffer-delivered result)
  "Called by the host when a minibuffer-read prompt resolves."
  (let ((reader *minibuffer-reader*))
    (set! *minibuffer-reader* nil)
    (if (not (nil? reader)) (reader result))))

(define (-region-bounds)
  "The active region's (start end); errors when there is no region."
  (if (region-active?)
      (let ((m (mark)) (p (point)))
        (list (min m p) (max m p)))
      (error "this command needs an active region")))

(define (-region-or-buffer-bounds)
  "The active region's (start end), or the whole buffer when none."
  (if (region-active?)
      (let ((m (mark)) (p (point)))
        (list (min m p) (max m p)))
      (list 0 (string-length (buffer-text)))))

(define (gather-source descriptor k)
  "Produce the value(s) for one interactive source DESCRIPTOR and pass
   them, as a list, to the continuation K. A cancelled prompt does not
   call K, so the command does not run."
  (cond
    ((eq? descriptor 'point) (k (list (point))))
    ((eq? descriptor 'region) (k (-region-bounds)))
    ((eq? descriptor 'region-or-buffer) (k (-region-or-buffer-bounds)))
    ((and (pair? descriptor) (eq? (car descriptor) 'string))
     (minibuffer-read (cadr descriptor)
                      (lambda (s) (if (nil? s) nil (k (list s))))))
    ((and (pair? descriptor) (eq? (car descriptor) 'number))
     (minibuffer-read (cadr descriptor)
                      (lambda (s)
                        (if (nil? s) nil (k (list (string->number s)))))))
    (else (error (str "unknown interactive source: " descriptor)))))

(define (gather-args spec collected done)
  "Walk the interactive SPEC, accumulating argument values in COLLECTED;
   DONE receives the final argument list."
  (if (nil? spec)
      (done collected)
      (gather-source
        (car spec)
        (lambda (values)
          (gather-args (cdr spec) (append collected values) done)))))

;; --- command history ---------------------------------------------------
;;
;; Each command dispatch records the command's name. `*last-command*` is
;; the command that ran just before the current one; `*this-command*` is
;; the one running now. A command can consult `*last-command*` to behave
;; differently when it immediately follows a particular command — this is
;; how `yank-pop` knows it follows a `yank`.

(define *last-command* nil)
(define *this-command* nil)

(define (run-command name)
  "Invoke command NAME. A command with no interactive spec is called
   with no arguments; one with a spec has its arguments gathered (from
   the region, the minibuffer, …) and applied. Records the command in
   `*this-command*`, shifting the previous one into `*last-command*`."
  (set! *last-command* *this-command*)
  (set! *this-command* name)
  (let ((spec (get *commands* name nil)))
    (if (nil? spec)
        ((eval name))
        (gather-args spec (list)
                     (lambda (args) (apply (eval name) args))))))
