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

;; --- symbol at a buffer offset -----------------------------------------
;; The hover-tooltip and `describe-symbol-at-point` both need the
;; Lisp symbol straddling a buffer offset. Symbol chars are anything
;; that isn't whitespace and isn't a reader delimiter — matches the
;; reader's tokenizer in `packages/lisp/src/reader.js`.

(define (-doc-symbol-char? ch)
  "True when CH is a single character that can appear inside a Lisp
   symbol — anything that isn't whitespace and isn't a delimiter
   (`()[]{}\"`;'`,)."
  (and (= (string-length ch) 1)
       (not (string-contains? " \t\n\r" ch))
       (not (string-contains? "()[]{}\";'`," ch))))

(define (symbol-at-offset text pos)
  "The Lisp symbol straddling POS in TEXT, or `nil` when POS is not
   inside (or just past) a symbol. The semantics match
   `expand-region-word-bounds` — POS counts as inside when the char
   at POS or just before is a symbol char."
  (let ((here (-doc-symbol-char? (-char-at text pos)))
        (prev (-doc-symbol-char? (-char-at text (- pos 1)))))
    (if (or here prev)
        (let ((start (-scan-back text pos -doc-symbol-char?))
              (end (-scan-forward text pos -doc-symbol-char?)))
          (if (= start end) nil (substring text start end)))
        nil)))

(define (symbol-at-point)
  "The Lisp symbol straddling the cursor in the current buffer, or
   `nil`. Used by `describe-symbol-at-point` and the hover
   tooltip."
  (symbol-at-offset (buffer-text) (point)))

(define (doc-summary-for name)
  "A small tuple describing what documentation is available for NAME,
   used by the hover tooltip. Returns:
     (\"manifest\" NAME)            — a pre-built doc page
     (\"live\"     NAME SOURCE)      — only a docstring
   or `nil` when NAME has no documentation. The list shape keeps the
   JS side simple: a `listToArray` is enough to unpack."
  (cond
    ((doc-known? name) (list "manifest" name))
    (else
      (let ((source (doc-source-for-name name)))
        (if (string? source)
            (list "live" name source)
            nil)))))

(defcommand describe-symbol-at-point ()
  "Open the documentation for the Lisp symbol under the cursor.
   Routes through `open-doc`, so the static manifest is tried
   first and the live docstring is rendered as a fallback. Bound
   to `C-h .`."
  (let ((name (symbol-at-point)))
    (cond
      ((nil? name) (println "no symbol at point"))
      (else (open-doc name)))))

(defcommand apropos-doc ()
  "Fuzzy-search the documentation manifest in the minibuffer; open
   the matching doc page in the doc-view. Bound to `C-h a`."
  (start-doc-search!))

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

(defcommand open-manual ()
  "Open the manual at its top — the table-of-contents root — in the
   doc-view. Unlike `open-doc`, which prompts for a particular page, this
   opens the manual's Top node so you can browse from the sidebar and the
   Next/Prev/Up navigation. Bound to `C-h d`."
  (open-manual!))
