;;; docs.lisp — the in-editor documentation system.
;;;
;;; A `pnpm run docs` build (scripts/build-docs.js) renders the
;;; jmacs manual to HTML and produces `docs/build/manifest.json`,
;;; a flat name → relative-path map. The host loads that manifest
;;; at startup and exposes it as the list of names through the
;;; `load-doc-manifest!` primitive; `open-doc!` reads a doc page
;;; by name and shows it in a `doc`-kind buffer.
;;;
;;; This file owns the Lisp surface: a cached list of known doc
;;; names and the `open-doc` command. `help.lisp` uses
;;; `doc-known?` to route `describe-command` and `describe-key`
;;; through a doc page when one exists, falling back to the REPL
;;; otherwise.

;; Cached after the first non-empty read. `nil` = not yet loaded
;; (or still empty). Re-queries on every call until the host
;; reports a populated manifest, so the cache settles whenever the
;; async fetch on the host side completes. Rebuilding the docs
;; while the editor is open requires a `reload-stdlib!` to pick up
;; the new list.
(define *doc-manifest* nil)

(define (doc-manifest)
  "The list of names known to the documentation system, or `()`
   when the docs haven't been built (or the host's fetch hasn't
   completed yet)."
  (if (nil? *doc-manifest*)
      (let ((loaded (load-doc-manifest!)))
        (cond
          ((nil? loaded) (list))          ; not yet — try again next time
          (else
            (set! *doc-manifest* loaded)
            loaded)))
      *doc-manifest*))

(define (doc-known? name)
  "True if NAME has a doc page in the built manifest."
  (if (member name (doc-manifest)) #t #f))

(define (doc-source-for-name name)
  "The docstring of the procedure bound to NAME, or `nil` when the
   symbol is unbound, doesn't name a procedure, or has no docstring.
   Used by `open-doc` as the source for live (user-defined) docs."
  (try
    (let ((value (eval (string->symbol name))))
      (if (procedure? value)
          (let ((source (doc value)))
            (if (string? source) source nil))
          nil))
    (catch err nil)))

(defcommand open-doc (name)
  "Open the documentation page for the function called NAME. The
   pre-built reference is consulted first; for user-defined
   procedures that aren't in the manifest, the docstring is
   rendered as Markdown and shown in a doc buffer. Falls back to
   a REPL message when NAME names nothing documented."
  (interactive (string "Documentation for: "))
  (cond
    ((doc-known? name) (open-doc! name))
    (else
      (let ((source (doc-source-for-name name)))
        (if (string? source)
            (open-docstring-page! name source)
            (println (str "no doc page for " name)))))))
