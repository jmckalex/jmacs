;;; latex-compile.lisp — AUCTeX's compile / view loop for latex-mode.
;;;
;;; This is Phase 1 of plans/AUCTeX.md: `TeX-command-master` brought to
;;; jmacs. It adds three commands to the `C-c` prefix map that latex.lisp
;;; installed:
;;;
;;;   C-c C-c  latex-compile        — save + run the LaTeX toolchain
;;;   C-c C-v  latex-view           — open / reload the built PDF
;;;   C-c `    latex-next-error     — jump to the next parsed diagnostic
;;;
;;; The build runs the configured `*latex-command*` (a *list* of program
;;; + flags — `run-process!` takes no shell, so the command is a token
;;; list, never a string) in the source file's directory. Output is
;;; buffered (no streaming): the whole log lands in a `*TeX output*` view
;;; at exit, is parsed by `parse-latex-log` (the pure JS parser exposed
;;; in latex-primitives.js), and the diagnostics populate a `*TeX errors*`
;;; view that `latex-next-error` walks.
;;;
;;; Loaded AFTER latex.lisp (it extends `latex-c-c-map`). All of it is
;;; Lisp on top of the host primitives `run-process!`, `view-file-path`,
;;; `view-directory`, `pdf-reload!`, `file-exists?`, `parse-latex-log`,
;;; `open-file-path!`, `goto-line!`, plus the view-list primitives.

;; --- user-facing settings ---------------------------------------------

(defgroup 'latex 'jmacs "LaTeX authoring: the compile / view loop.")

;; The build command is a LIST of strings: program followed by flags.
;; `run-process!` spawns with NO shell, so this must be a token list, not
;; a single shell string. The .tex filename is appended by the build
;; command at run time. latexmk subsumes the multi-pass bibtex/rerun
;; dance itself, so a single invocation suffices.
(defcustom *latex-command*
  '("latexmk" "-pdf" "-synctex=1" "-interaction=nonstopmode")
  :list
  :group 'latex
  :doc "The LaTeX build command as a list of strings (program + flags).
   The source .tex filename is appended at build time. Default is
   latexmk, which handles the multi-pass rerun/bibtex dance itself; when
   latexmk is not on PATH, `latex-compile` falls back to a single
   pdflatex pass. `run-process!` takes no shell — this is a token list,
   never a shell string.")

;; The bibliography command, also a token list. Reserved for an explicit
;; bibtex/biber step; v1's latexmk default runs bibtex itself, so this is
;; the seam for a manual `latex-bibtex` command (not yet a binding).
(defcustom *latex-bibtex-command* '("bibtex")
  :list
  :group 'latex
  :doc "The bibliography command as a list of strings (program + flags).
   latexmk runs bibtex/biber itself, so this is unused by the default
   build; it is the seam for an explicit bibliography pass and for a
   pdflatex-fallback workflow that needs a manual bibtex run.")

;; Which viewer `latex-view` uses. v1 always uses the in-app pdf-view;
;; this is the seam for external viewers (Skim, evince, …) later, which
;; would spawn via `run-process!` instead of `open-file-path!`.
(defcustom *latex-view* 'pdf-view
  :symbol
  :group 'latex
  :doc "The PDF viewer `latex-view` uses. v1 supports only the built-in
   'pdf-view (open / reload in a split beside the source). The seam for
   external viewers (Skim, evince) later — those would spawn via
   run-process! rather than open the in-app pdf-view.")

;; Whether the PDF `latex-view` opens should survive a relaunch. The
;; latexed output of a document is usually worth restoring (reopen the
;; editor, the source|PDF split is back); set this to #f to make even the
;; latex-output PDF transient (matching the global *pdf-restore-default*).
;; When on, `latex-view` passes the persist flag through
;; `open-file-in-split!` so the host marks the new pdf view persistent.
(defcustom *latex-pdf-restore* #t :boolean
  :group 'latex
  :doc "Whether the PDF `latex-view` opens persists across a relaunch.
   #t (the default) restores the latexed-output PDF beside its source on
   relaunch; #f makes it transient like a generic PDF. Independent of the
   global *pdf-restore-default* (which governs all OTHER PDFs).")

;; Auxiliary file extensions a `latex-clean` removes. These are the
;; siblings latexmk / pdflatex leave beside the .tex.
(defcustom *latex-clean*
  '(".aux" ".log" ".out" ".synctex.gz" ".fdb_latexmk" ".fls" ".toc"
    ".bbl" ".blg")
  :list
  :group 'latex
  :doc "Auxiliary file extensions `latex-clean` deletes — the build
   by-products latexmk / pdflatex leave beside the source .tex.")

;; --- compile state ----------------------------------------------------
;; The parsed diagnostics from the last build and a cursor into them,
;; walked by `latex-next-error` / `latex-previous-error`. The index is
;; -1 before the first `next-error` (so the first call lands on entry 0).

(define *latex-error-list* '())
(define *latex-error-index* -1)

;; --- the master file seam (R1 extends this) ---------------------------
;; AUCTeX compiles the *master* file, not necessarily the current buffer
;; (a chapter `\input` into a book's main.tex builds main.tex). Detecting
;; the master across a multi-file document is RefTeX's R1 — a separate
;; task. For Phase 1 this returns the current view's file unchanged.
;;
;;   R1 NOTE: redefine / extend `latex-master-file` to consult a
;;   master-detection hook (a `% !TEX root = …` magic comment, a
;;   buffer-local *master* setting, or the RefTeX document model). Its
;;   contract is fixed: () -> a .tex path string, or nil when the current
;;   view has no associated .tex file. `latex-compile` and `latex-view`
;;   both route through it, so extending it here lights up both.

(define (latex-master-file)
  "The .tex file the build should compile. Phase 1: the current view's
   own file. R1 will extend this with master-file detection — its
   contract (() -> path-string-or-nil) stays fixed so both callers
   follow automatically."
  (view-file-path (current-view)))

;; --- helpers ----------------------------------------------------------

(define (-latex-tex-file? path)
  "Whether PATH names a .tex file."
  (and (string? path) (string-suffix? ".tex" path)))

(define (-latex-pdf-path tex)
  "TEX with its `.tex` extension swapped for `.pdf` (same directory)."
  (str (substring tex 0 (- (string-length tex) 4)) ".pdf"))

(define (-latex-find-view-by-file path)
  "The open view whose file path equals PATH, or nil. Used to decide
   whether the PDF is already on screen (reload) or must be opened."
  (-latex-find-view-by-file/loop (view-list) path))

(define (-latex-find-view-by-file/loop views path)
  (cond ((nil? views) nil)
        ((equal? (view-file-path (car views)) path) (car views))
        (else (-latex-find-view-by-file/loop (cdr views) path))))

(define (-latex-write-view name text)
  "Find-or-create the view called NAME, replace its whole buffer with
   TEXT, and return focus to the view that was current on entry. So the
   *TeX output* / *TeX errors* views update in place without stealing
   focus or accumulating duplicates."
  (let ((origin (current-view))
        (existing (find-view name)))
    (if (nil? existing)
        (begin (new-view! name) (set-buffer-text! text))
        (begin (switch-to-view! existing) (set-buffer-text! text)))
    (when (not (nil? origin))
      (switch-to-view! origin))))

;; --- the log → *TeX output* / *TeX errors* views ----------------------

(define (-latex-diag-line diag)
  "Render one diagnostic hash-map as an occur-style `FILE:LINE: MESSAGE`
   row. A nil file shows as `?`; a nil line is omitted."
  (let ((file (get diag :file nil))
        (line (get diag :line nil))
        (msg  (get diag :message ""))
        (kind (get diag :kind :error)))
    (str (if (nil? file) "?" file)
         ":"
         (if (nil? line) "" (number->string line))
         ": "
         (if (eq? kind :warning) "warning: " "")
         msg)))

(define (-latex-errors-text diags)
  "The full text for the *TeX errors* view: a header line and one
   `FILE:LINE: MESSAGE` row per diagnostic. An empty list reports
   success in words."
  (if (nil? diags)
      "No LaTeX errors or warnings.\n"
      (let ((count (length diags)))
        (str count " diagnostic" (if (= count 1) "" "s") ":\n\n"
             (-latex-format-diags diags)))))

(define (-latex-format-diags diags)
  (if (nil? diags)
      ""
      (str (-latex-diag-line (car diags)) "\n"
           (-latex-format-diags (cdr diags)))))

(define (-latex-count-errors diags)
  "How many of DIAGS are errors (kind :error), not warnings."
  (length (filter (lambda (d) (eq? (get d :kind :error) :error)) diags)))

;; --- the build callback -----------------------------------------------

(define (-latex-reload-pdf-if-open pdf)
  "Reload the PDF at path PDF in place when it is currently open in a
   view; a no-op otherwise. Shared by the compile success path (auto-
   refresh after a build) and by `latex-view`."
  (when (not (nil? (-latex-find-view-by-file pdf)))
    (pdf-reload! pdf)))

(define (-latex-on-exit result tex)
  "Handle a finished build: RESULT is `{:stdout :stderr :code}`, TEX the
   source that was built. Write the combined log to *TeX output*, parse
   it, store the diagnostics, refresh *TeX errors*, echo a status summary,
   and — on a build with no errors — reload the output PDF if it is open,
   so an on-screen preview refreshes without a manual C-c C-v."
  (let* ((out (get result :stdout ""))
         (err (get result :stderr ""))
         (log (str out (if (equal? err "") "" (str "\n" err))))
         (diags (parse-latex-log log)))
    (-latex-write-view "*TeX output*" log)
    (set! *latex-error-list* diags)
    (set! *latex-error-index* -1)
    (-latex-write-view "*TeX errors*" (-latex-errors-text diags))
    (let ((errors (-latex-count-errors diags)))
      (cond
        ((> errors 0)
         (show-status! (str "LaTeX: " errors " error"
                            (if (= errors 1) "" "s")
                            " — C-c ` to visit")))
        ((not (nil? diags))
         (show-status! (str "LaTeX: success (" (length diags)
                            " warning" (if (= (length diags) 1) "" "s")
                            ")")))
        (else (show-status! "LaTeX: success")))
      ;; A no-error build (re)produced the PDF — refresh an open preview
      ;; in place so the user need not re-run C-c C-v after every compile.
      (when (= errors 0)
        (-latex-reload-pdf-if-open (-latex-pdf-path tex))))))

;; --- spawn detection (latexmk -> pdflatex fallback) -------------------

(define (-latex-spawn-failed? result)
  "Whether RESULT (a finished-process hash-map) indicates the program
   was never found: :code nil AND the :stderr mentions ENOENT / not
   found. (A signal-kill is also :code nil but won't match the text.)"
  (and (nil? (get result :code nil))
       (let ((err (get result :stderr "")))
         (or (string-contains? err "ENOENT")
             (string-contains? err "not found")
             (string-contains? err "No such file")))))

(define (-latex-run command tex dir on-exit)
  "Run COMMAND (a list: program + flags) on TEX in DIR, calling ON-EXIT
   with the result hash-map. The .tex basename is appended to the flags."
  (let ((program (car command))
        (args (append (cdr command) (list (path-basename tex)))))
    (run-process! program args dir on-exit)))

;; --- commands ---------------------------------------------------------

(defcommand latex-compile ()
  "Save the buffer and build the LaTeX document with `*latex-command*`,
   routing the log into a *TeX output* view and the parsed diagnostics
   into *TeX errors*. On a clean build, view the PDF with C-c C-v; on
   errors, visit them with C-c ` (latex-next-error). Bound to C-c C-c.

   The file built is `(latex-master-file)` — for now the current file;
   R1's master detection will redirect both this and `latex-view`."
  (let ((tex (latex-master-file)))
    (cond
      ((nil? tex)
       (show-status! "latex-compile: this view has no file to compile"))
      ((not (-latex-tex-file? tex))
       (show-status! "latex-compile: not a .tex file"))
      (else
       ;; Save first so the on-disk file is current before the build.
       (save-buffer!)
       (let ((dir (view-directory (current-view))))
         (show-status! (str "LaTeX: compiling " (path-basename tex) " …"))
         ;; First attempt: the configured command (latexmk by default).
         ;; If the program isn't on PATH (spawn ENOENT), retry ONCE with
         ;; a single pdflatex pass. The pdflatex fallback is one pass
         ;; only (no auto-rerun for refs/bibtex) — a v1 limitation; set
         ;; *latex-command* to pdflatex explicitly for full control.
         (-latex-run
          *latex-command* tex dir
          (lambda (result)
            (if (-latex-spawn-failed? result)
                (begin
                  (show-status!
                   (str "LaTeX: " (car *latex-command*)
                        " not found — trying pdflatex …"))
                  (-latex-run
                   '("pdflatex" "-synctex=1" "-interaction=nonstopmode")
                   tex dir
                   (lambda (r) (-latex-on-exit r tex))))
                (-latex-on-exit result tex)))))))))

(defcommand latex-view ()
  "Open the built PDF for `(latex-master-file)` beside the source, or
   reload it if already open. The PDF path is the .tex with its
   extension swapped to .pdf, in the same directory. Run `latex-compile`
   (C-c C-c) first if the PDF does not exist yet. Bound to C-c C-v."
  (let ((tex (latex-master-file)))
    (cond
      ((not (-latex-tex-file? tex))
       (show-status! "latex-view: not a .tex file"))
      (else
       (let ((pdf (-latex-pdf-path tex)))
         (cond
           ((not (file-exists? pdf))
            (show-status! "latex-view: no PDF yet — compile with C-c C-c"))
           ((not (nil? (-latex-find-view-by-file pdf)))
            ;; Already on screen: refresh its bytes in place.
            (pdf-reload! pdf)
            (show-status! (str "Reloaded " (path-basename pdf))))
           (else
            ;; Not open: split the source pane to the right and open the
            ;; PDF in the new pane directly, so source and PDF sit side by
            ;; side. `open-file-in-split!` is the programmatic split — it
            ;; fills the new pane with the PDF straight away, leaving no
            ;; placeholder chooser and no stray pane (the user-facing
            ;; `split-horizontal!` shows a chooser, which is wrong here).
            ;; The 4th arg flags the PDF session-persistent when
            ;; *latex-pdf-restore* is on, so the latexed output is back
            ;; beside its source after a relaunch (threaded through the
            ;; open so we don't race the async open for the handle).
            (open-file-in-split! pdf 'horizontal 'after *latex-pdf-restore*)
            (show-status! (str "Opened " (path-basename pdf))))))))))

;; --- error navigation -------------------------------------------------

(define (-latex-visit-diag diag)
  "Open DIAG's file and jump to its line, echoing the message. A diag
   with no file or no line is reported but not jumped to."
  (let ((file (get diag :file nil))
        (line (get diag :line nil))
        (msg (get diag :message "")))
    (when (and (not (nil? file)) (file-exists? file))
      (open-file-path! file)
      (when (not (nil? line))
        (goto-line! line)))
    (show-status! (-latex-diag-line diag))))

(defcommand latex-next-error ()
  "Visit the next LaTeX diagnostic from the last build: open its file,
   jump to its line, and echo the message. Clamps at the end with a
   `no more errors` message. Run `latex-compile` (C-c C-c) first to
   populate the list. Bound to C-c `."
  (cond
    ((nil? *latex-error-list*)
     (show-status! "No LaTeX errors — compile with C-c C-c"))
    ((>= (+ *latex-error-index* 1) (length *latex-error-list*))
     (show-status! "No more LaTeX errors"))
    (else
     (set! *latex-error-index* (+ *latex-error-index* 1))
     (-latex-visit-diag (nth *latex-error-list* *latex-error-index*)))))

(defcommand latex-previous-error ()
  "Visit the previous LaTeX diagnostic from the last build. Clamps at
   the start. The companion to `latex-next-error` (C-c `)."
  (cond
    ((nil? *latex-error-list*)
     (show-status! "No LaTeX errors — compile with C-c C-c"))
    ((<= *latex-error-index* 0)
     (set! *latex-error-index* 0)
     (show-status! "At first LaTeX error"))
    (else
     (set! *latex-error-index* (- *latex-error-index* 1))
     (-latex-visit-diag (nth *latex-error-list* *latex-error-index*)))))

(defcommand latex-show-output ()
  "Pop up the *TeX output* view with the last build's full log, if any.
   A convenience for inspecting the raw toolchain output."
  (let ((v (find-view "*TeX output*")))
    (if (nil? v)
        (show-status! "No *TeX output* yet — compile with C-c C-c")
        (switch-to-view! v))))

;; --- latex-clean ------------------------------------------------------
;; The `*latex-clean*` defcustom (above) lists the by-product extensions
;; a clean would remove. The command itself is deferred: the host exposes
;; no Lisp-callable file-deletion primitive yet (`window.host` has no
;; unlink/trash bridge). When a `delete-file!` / `trash-file!` primitive
;; lands (app.js territory), `latex-clean` is a five-line loop over
;; `*latex-clean*` deleting each existing `<stem><ext>` sibling of the
;; .tex. Until then the setting documents the intent.

;; --- keybindings ------------------------------------------------------
;; Extend the C-c prefix map latex.lisp built (`latex-c-c-map`). The
;; existing b/i/e/m/M/s/S/l/n/C-p entries are left untouched; we add the
;; compile-loop chords. `assoc` on the map returns a new map, so we
;; rebuild it and re-install it under "C-c" in latex-mode-map.

(set! latex-c-c-map
  (assoc (assoc (assoc latex-c-c-map "C-c" 'latex-compile)
                "C-v" 'latex-view)
         "`" 'latex-next-error))

(set! latex-mode-map {"C-c" latex-c-c-map})
