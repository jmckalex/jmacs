;;; commands.lisp — the command system.
;;;
;;; A *command* is a procedure declared with `defcommand`. Unlike a
;;; plain `define`d procedure, a command is recorded in a registry, so
;;; M-x offers it whether or not it is bound to a key.
;;;
;;; defcommand also carries an optional `(interactive …)` clause that
;;; declares how the command's arguments are gathered. The gatherer
;;; that reads them is added in a later slice; for now a command is
;;; invoked with no arguments.
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

(define (run-command name)
  "Invoke command NAME. The interactive argument gatherer is added in a
   later slice; for now every command is invoked with no arguments."
  ((eval name)))
