;;; jmarkdown-compile.lisp — the compile / view loop for jmarkdown-mode.
;;;
;;; "AUCTeX C-c C-c", for JMarkdown. It adds a build/view loop mirroring
;;; latex-compile.lisp, over the `jmarkdown` CLI:
;;;
;;;   C-c C-c  jmarkdown-compile      — save + build (HTML / LaTeX / PDF)
;;;   C-c C-o  jmarkdown-view-output  — open / reload the built artifact
;;;   C-c `    jmarkdown-next-error   — walk the parsed warnings
;;;   C-c C-w  jmarkdown-show-output  — bring the build-output dock forward
;;;
;;; The build runs `jmarkdown process <file> [--to latex]` (a *token list*
;;; — `run-process!` takes no shell) in the source file's directory. HTML
;;; and LaTeX are one CLI call each; PDF is HTML-then-headless-Chrome (the
;;; zero-dependency `init -m` route). Output is buffered: the whole log
;;; lands in a "jmd-output" dock tab at exit, warnings populate a
;;; "jmd-errors" tab, and `jmarkdown-next-error` walks them. The live
;;; watch-preview (C-c v, markdown.lisp) is the separate rendered-HTML view;
;;; this loop is the one-shot export + PDF.
;;;
;;; A TOP-LEVEL stdlib file (loaded before the languages/ glob): it defines
;;; commands + defcustoms only, and does NOT touch jmarkdown-mode-map — the
;;; keybindings are wired in languages/jmarkdown.lisp (loaded last), where
;;; the mode map exists. All of it is Lisp over the host primitives
;;; `run-process!`, `save-buffer!`, `view-file-path`, `view-directory`,
;;; `file-exists?`, `open-file-in-split!`, `pdf-reload!`, `utility-output-set`
;;; / `utility-panel-activate!`, `open-file-path!`, `goto-line!`.

;; --- user-facing settings ---------------------------------------------

(defgroup 'jmarkdown 'godot "JMarkdown authoring: compile / view / references.")

;; The build command as a LIST of strings (program + flags). The source
;; filename is appended at build time. `run-process!` spawns with NO shell,
;; so this must be a token list, never a shell string. `--to latex` is added
;; for a LaTeX build.
(defcustom *jmarkdown-command* '("jmarkdown" "process")
  :list
  :group 'jmarkdown
  :doc "The JMarkdown build command as a list of strings (program + flags).
   The source filename is appended at build time; `--to latex` is added for
   a LaTeX build. Default `jmarkdown process`. `run-process!` takes no shell
   — a token list, never a shell string. Under a Finder-launched app
   `jmarkdown` may not be on PATH; launch from a terminal or give an
   absolute path here.")

;; The default output format for `jmarkdown-compile` (C-c C-c). A prefix
;; argument (C-u) prompts for the format instead.
(defcustom *jmarkdown-compile-format* 'html
  :choice
  :options '(html latex pdf)
  :group 'jmarkdown
  :doc "The default format `jmarkdown-compile` (C-c C-c) builds: 'html,
   'latex, or 'pdf. PDF is produced by building HTML then printing it with
   headless Chrome (`*jmarkdown-chrome*`). A prefix argument (C-u C-c C-c)
   prompts for the format for one build instead.")

;; The Chrome/Chromium binary used for the HTML->PDF print step (the
;; zero-dependency PDF route from `jmarkdown init -m`).
(defcustom *jmarkdown-chrome*
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  :string
  :group 'jmarkdown
  :doc "The Chrome / Chromium executable `jmarkdown-compile` uses to print
   the built HTML to PDF (`--headless --print-to-pdf`). Point it at your
   browser if it lives elsewhere; when it is not found the PDF build fails
   with a clear status and the HTML is still produced.")

;; Whether the artifact `jmarkdown-view-output` opens should survive a
;; relaunch (threaded through open-file-in-split!, like *latex-pdf-restore*).
(defcustom *jmarkdown-view-restore* #t :boolean
  :group 'jmarkdown
  :doc "Whether the built artifact `jmarkdown-view-output` opens persists
   across a relaunch (mainly relevant for a PDF beside its source).")

;; --- compile state ----------------------------------------------------

(define *jmarkdown-error-list* '())
(define *jmarkdown-error-index* -1)
(define *jmarkdown-output-ready?* #f)
;; The format of the last successful build, so view-output knows which
;; artifact to open when the default format is ambiguous.
(define *jmarkdown-last-format* 'html)

;; --- source + artifact paths ------------------------------------------

(define (-jmd-source-file)
  "The file `jmarkdown-compile` builds: the current view's own file, or nil
   when the view has no file."
  (view-file-path (current-view)))

(define (-jmd-last-dot text)
  "The index of the last `.` in TEXT, or -1. Pure — a backward scan (there
   is no host lastIndexOf for a single char here)."
  (-jmd-last-dot-loop text (- (string-length text) 1)))

(define (-jmd-last-dot-loop text i)
  (cond
    ((< i 0) -1)
    ((equal? (substring text i (+ i 1)) "/") -1) ; a dot must be in the basename
    ((equal? (substring text i (+ i 1)) ".")
     ;; A leading dot (index 0, or right after a `/`) is a dotfile prefix, not
     ;; an extension separator — `.bashrc` has no extension.
     (if (or (= i 0) (equal? (substring text (- i 1) i) "/")) -1 i))
    (else (-jmd-last-dot-loop text (- i 1)))))

(define (-jmd-swap-ext path ext)
  "PATH with its final extension replaced by EXT (e.g. \".html\"). When PATH
   has no extension, EXT is appended. Pure."
  (let ((dot (-jmd-last-dot path)))
    (if (< dot 0)
        (str path ext)
        (str (substring path 0 dot) ext))))

(define (-jmd-artifact-path src format)
  "The output path a build of SRC in FORMAT produces (same directory)."
  (cond
    ((eq? format 'latex) (-jmd-swap-ext src ".tex"))
    ((eq? format 'pdf) (-jmd-swap-ext src ".pdf"))
    (else (-jmd-swap-ext src ".html"))))

;; --- log → dock output/errors -----------------------------------------
;; JMarkdown signals failure by a non-zero exit code (and a stack trace /
;; message on stderr); non-fatal build warnings (unresolved :refs, duplicate
;; labels, orphan index marks) are printed as an end-of-run stderr summary.
;; We show the whole log, and parse stderr lines into diagnostics for
;; navigation: a `path:line: message` shape becomes a jumpable diagnostic,
;; anything else a message-only one.

(define (-jmd-blank-line? s)
  (string=? (-jmd-trim s) ""))

(define (-jmd-trim s)
  (-jmd-trim-trailing (-jmd-trim-leading s)))

(define (-jmd-trim-leading s)
  (cond
    ((string=? s "") s)
    ((-jmd-ws1? (substring s 0 1)) (-jmd-trim-leading (substring s 1 (string-length s))))
    (else s)))

(define (-jmd-trim-trailing s)
  (let ((n (string-length s)))
    (cond
      ((= n 0) s)
      ((-jmd-ws1? (substring s (- n 1) n)) (-jmd-trim-trailing (substring s 0 (- n 1))))
      (else s))))

(define (-jmd-ws1? c) (or (equal? c " ") (equal? c "\t") (equal? c "\r")))

(define (-jmd-diag-kind line)
  "Classify a log LINE: :error when it mentions error/exception, else
   :warning."
  (cond
    ((-jmd-contains-ci? line "error") :error)
    ((-jmd-contains-ci? line "exception") :error)
    (else :warning)))

(define (-jmd-contains-ci? haystack needle)
  "Case-insensitive substring test (lowercases both)."
  (string-contains? (-jmd-downcase haystack) (-jmd-downcase needle)))

(define (-jmd-downcase s)
  "S lowercased (ASCII)."
  (-jmd-downcase-loop s 0 ""))

(define *jmd-upper* "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
(define *jmd-lower* "abcdefghijklmnopqrstuvwxyz")

(define (-jmd-downcase-loop s i acc)
  (if (>= i (string-length s))
      acc
      (let* ((c (substring s i (+ i 1)))
             (u (string-index-of *jmd-upper* c)))
        (-jmd-downcase-loop s (+ i 1)
                            (str acc (if (< u 0) c (substring *jmd-lower* u (+ u 1))))))))

(define (-jmd-log-diags log failed?)
  "Parse LOG (combined stdout+stderr) into a diagnostics list. Non-blank
   lines that look like a warning/error become {:file :line :message :kind}
   entries. When FAILED? (non-zero exit) and nothing parsed, the whole log
   is one error diagnostic. Pure."
  (let ((lines (filter (lambda (l) (not (-jmd-blank-line? l)))
                       (string-split log "\n"))))
    (let ((diags (filter (lambda (d) (not (nil? d)))
                         (map -jmd-line->diag lines))))
      (cond
        ((not (nil? diags)) diags)
        (failed? (list (hash-map :file nil :line nil
                                 :message (if (-jmd-blank-line? log)
                                              "Build failed (no output)."
                                              (-jmd-trim log))
                                 :kind :error)))
        (else '())))))

(define (-jmd-digit-run s i)
  "The index past the run of decimal digits in S starting at I. Pure."
  (if (and (< i (string-length s))
           (>= (string-index-of "0123456789" (substring s i (+ i 1))) 0))
      (-jmd-digit-run s (+ i 1)) i))

(define (-jmd-parse-location line)
  "If LINE begins `path:line: message`, a jumpable diagnostic hash-map
   (:file :line :message :kind), else nil. Requires a colon at >0, then one or
   more digits, then another colon — so `Warning: …` (no digits) is not a hit.
   Pure."
  (let ((c1 (string-index-of line ":")))
    (if (< c1 1)
        nil
        (let* ((after (+ c1 1))
               (dend (-jmd-digit-run line after)))
          (if (and (> dend after)
                   (< dend (string-length line))
                   (equal? (substring line dend (+ dend 1)) ":"))
              (hash-map :file (substring line 0 c1)
                        :line (string->number (substring line after dend))
                        :message (-jmd-trim (substring line (+ dend 1) (string-length line)))
                        :kind :error)
              nil)))))

(define (-jmd-line->diag line)
  "A log LINE → a diagnostic hash-map, or nil when it is ordinary output.
   Recognises a leading `path:line:` for a jumpable diagnostic; otherwise a
   line mentioning warning/error/unresolved/duplicate becomes a message-only
   diagnostic. Pure."
  (let ((loc (-jmd-parse-location (-jmd-trim line))))
    (cond
      ((not (nil? loc)) loc)
      ((-jmd-contains-ci? line "warning") (-jmd-classify line))
      ((-jmd-contains-ci? line "error") (-jmd-classify line))
      ((-jmd-contains-ci? line "unresolved") (hash-map :file nil :line nil
                                                       :message (-jmd-trim line) :kind :warning))
      ((-jmd-contains-ci? line "duplicate") (hash-map :file nil :line nil
                                                      :message (-jmd-trim line) :kind :warning))
      (else nil))))

(define (-jmd-classify line)
  (hash-map :file nil :line nil :message (-jmd-trim line) :kind (-jmd-diag-kind line)))

(define (-jmd-diag-line diag)
  "One diagnostic as a `[warning] MESSAGE` row."
  (let ((kind (get diag :kind :error))
        (msg (get diag :message "")))
    (str (if (eq? kind :warning) "warning: " "error: ") msg)))

(define (-jmd-errors-text diags)
  "The text for the jmd-errors dock tab."
  (if (nil? diags)
      "No JMarkdown warnings or errors.\n"
      (str (length diags) " diagnostic"
           (if (= (length diags) 1) "" "s") ":\n\n"
           (string-join (map -jmd-diag-line diags) "\n") "\n")))

(define (-jmd-count-errors diags)
  (length (filter (lambda (d) (eq? (get d :kind :error) :error)) diags)))

;; --- the artifact reload helper ---------------------------------------

(define (-jmd-find-view-by-file path)
  (-jmd-find-view-by-file/loop (view-list) path))

(define (-jmd-find-view-by-file/loop views path)
  (cond ((nil? views) nil)
        ((equal? (view-file-path (car views)) path) (car views))
        (else (-jmd-find-view-by-file/loop (cdr views) path))))

(define (-jmd-reload-artifact-if-open artifact)
  "Reload a PDF artifact in place when it is open (pdf-reload!). HTML/TeX
   artifacts have no in-place reload primitive, so they are left for a manual
   view-output."
  (when (and (string-suffix? ".pdf" artifact)
             (not (nil? (-jmd-find-view-by-file artifact))))
    (pdf-reload! artifact)))

;; --- the build callback -----------------------------------------------

(define (-jmd-on-exit result src format)
  "Handle a finished build: RESULT is {:stdout :stderr :code}. Write the log
   to jmd-output, parse diagnostics into jmd-errors + the error list, echo a
   status summary, and on success reload an open artifact."
  (let* ((out (get result :stdout ""))
         (err (get result :stderr ""))
         (code (get result :code nil))
         (failed? (or (nil? code) (not (= code 0))))
         (log (str out (if (equal? err "") "" (str "\n" err))))
         (diags (-jmd-log-diags log failed?)))
    (utility-output-set "jmd-output" "JMarkdown output"
                        (if (equal? (-jmd-trim log) "")
                            (str "Built " (path-basename (-jmd-artifact-path src format)) ".\n")
                            log))
    (set! *jmarkdown-error-list* diags)
    (set! *jmarkdown-error-index* -1)
    (utility-output-set "jmd-errors" "JMarkdown errors" (-jmd-errors-text diags))
    (set! *jmarkdown-output-ready?* #t)
    (let ((errors (-jmd-count-errors diags)))
      (cond
        (failed?
         (show-status! (str "JMarkdown: build FAILED"
                            (if (> errors 0) (str " (" errors " error"
                                                   (if (= errors 1) "" "s") ")") "")
                            " — C-c C-w for output")))
        ((not (nil? diags))
         (show-status! (str "JMarkdown: built " (path-basename (-jmd-artifact-path src format))
                            " (" (length diags) " warning"
                            (if (= (length diags) 1) "" "s") ")")))
        (else
         (show-status! (str "JMarkdown: built "
                            (path-basename (-jmd-artifact-path src format))))))
      (when (not failed?)
        (set! *jmarkdown-last-format* format)
        (-jmd-reload-artifact-if-open (-jmd-artifact-path src format))))))

(define (-jmd-merge-results a b)
  "Combine two process results — A's log (the HTML build's warnings) then B's
   (the Chrome print), keeping B's exit code as the final status."
  (hash-map :stdout (str (get a :stdout "") (get b :stdout ""))
            :stderr (str (get a :stderr "")
                         (if (equal? (get b :stderr "") "") "" (str "\n" (get b :stderr ""))))
            :code (get b :code nil)))

(define (-jmd-spawn-failed? result)
  "Whether RESULT indicates the program was never found (ENOENT / not found)."
  (and (nil? (get result :code nil))
       (let ((err (get result :stderr "")))
         (or (string-contains? err "ENOENT")
             (string-contains? err "not found")
             (string-contains? err "No such file")))))

;; --- running the CLI --------------------------------------------------

(define (-jmd-run-cli src dir format on-exit)
  "Run `jmarkdown process <basename> [--to latex]` on SRC in DIR, calling
   ON-EXIT with the result hash-map."
  (let* ((program (car *jmarkdown-command*))
         (flags (cdr *jmarkdown-command*))
         (fmt-flags (if (eq? format 'latex) (list "--to" "latex") '()))
         (args (append flags (append fmt-flags (list (path-basename src))))))
    (run-process! program args dir on-exit)))

(define (-jmd-run-chrome-pdf html pdf dir on-exit)
  "Print the built HTML to PDF with headless Chrome, calling ON-EXIT."
  (run-process! *jmarkdown-chrome*
                (list "--headless" (str "--print-to-pdf=" (path-basename pdf))
                      "--no-pdf-header-footer" (path-basename html))
                dir on-exit))

;; --- commands ---------------------------------------------------------

(define (-jmd-do-compile src format)
  "Save + build SRC in FORMAT (html/latex/pdf), then run the on-exit
   handler. For PDF: build HTML first, then Chrome-print it."
  (save-buffer!)
  (let ((dir (view-directory (current-view))))
    (show-status! (str "JMarkdown: building " (path-basename src)
                       " (" (symbol->string format) ") …"))
    (if (eq? format 'pdf)
        ;; Two-step: HTML build, then (on success) headless-Chrome print.
        (-jmd-run-cli
         src dir 'html
         (lambda (html-result)
           (let ((code (get html-result :code nil)))
             (if (or (nil? code) (not (= code 0)))
                 (-jmd-on-exit html-result src 'html) ; HTML build failed → report it
                 (let ((html (-jmd-artifact-path src 'html))
                       (pdf (-jmd-artifact-path src 'pdf)))
                   (show-status! (str "JMarkdown: printing " (path-basename pdf) " …"))
                   (-jmd-run-chrome-pdf
                    html pdf dir
                    (lambda (pdf-result)
                      (if (-jmd-spawn-failed? pdf-result)
                          (show-status!
                           (str "JMarkdown: Chrome not found (" *jmarkdown-chrome*
                                ") — set *jmarkdown-chrome*; HTML built"))
                          ;; Merge so the HTML step's JMarkdown warnings are not
                          ;; lost behind Chrome's (near-empty) output.
                          (-jmd-on-exit (-jmd-merge-results html-result pdf-result)
                                        src 'pdf)))))))))
        ;; HTML or LaTeX: one CLI call.
        (-jmd-run-cli
         src dir format
         (lambda (result)
           (if (-jmd-spawn-failed? result)
               (show-status! (str "JMarkdown: " (car *jmarkdown-command*)
                                  " not found — is it on PATH?"))
               (-jmd-on-exit result src format)))))))

(defcommand jmarkdown-compile ()
  "Save the buffer and build the JMarkdown document, routing the log to a
   JMarkdown-output dock tab and parsed warnings to JMarkdown-errors. The
   format is `*jmarkdown-compile-format*` (html/latex/pdf); with a prefix
   argument (C-u C-c C-c) you are prompted for it. HTML and LaTeX run the
   `jmarkdown` CLI; PDF builds HTML then prints it with headless Chrome. View
   the result with C-c C-o (jmarkdown-view-output). Bound to C-c C-c."
  (let ((src (-jmd-source-file)))
    (cond
      ((nil? src)
       (show-status! "jmarkdown-compile: this view has no file to build"))
      ((not (nil? *prefix-arg*))
       ;; C-u: prompt for the format (html / latex / pdf — short enough to type).
       (open-completing-minibuffer! "Compile format (html/latex/pdf): "
                                    (symbol->string *jmarkdown-compile-format*))
       (set! *minibuffer-reader*
             (lambda (fmt)
               (unless (or (nil? fmt) (string=? fmt ""))
                 (-jmd-do-compile src (-jmd-format-symbol fmt))))))
      (else (-jmd-do-compile src *jmarkdown-compile-format*)))))

(define (-jmd-format-symbol s)
  "Coerce a format string to a symbol, defaulting to 'html."
  (cond ((string=? s "latex") 'latex)
        ((string=? s "pdf") 'pdf)
        (else 'html)))

(defcommand jmarkdown-compile-html ()
  "Build the current JMarkdown document to HTML (jmarkdown process)."
  (let ((src (-jmd-source-file)))
    (if (nil? src) (show-status! "jmarkdown-compile-html: no file")
        (-jmd-do-compile src 'html))))

(defcommand jmarkdown-compile-latex ()
  "Build the current JMarkdown document to LaTeX (jmarkdown process --to latex)."
  (let ((src (-jmd-source-file)))
    (if (nil? src) (show-status! "jmarkdown-compile-latex: no file")
        (-jmd-do-compile src 'latex))))

(defcommand jmarkdown-compile-pdf ()
  "Build the current JMarkdown document to PDF (HTML then headless Chrome)."
  (let ((src (-jmd-source-file)))
    (if (nil? src) (show-status! "jmarkdown-compile-pdf: no file")
        (-jmd-do-compile src 'pdf))))

(defcommand jmarkdown-view-output ()
  "Open the built artifact for the current file beside the source, or reload
   it if already open. The artifact matches the last build's format (or
   `*jmarkdown-compile-format*`): a PDF renders in the pdf-view, an HTML/TeX
   file opens as text. Build first with C-c C-c. Bound to C-c C-o."
  (let ((src (-jmd-source-file)))
    (cond
      ((nil? src) (show-status! "jmarkdown-view-output: no file"))
      (else
       (let* ((format (if *jmarkdown-output-ready?* *jmarkdown-last-format*
                          *jmarkdown-compile-format*))
              (artifact (-jmd-artifact-path src format)))
         (cond
           ((not (file-exists? artifact))
            (show-status! (str "jmarkdown-view-output: no "
                               (path-basename artifact) " yet — build with C-c C-c")))
           ((not (nil? (-jmd-find-view-by-file artifact)))
            (when (string-suffix? ".pdf" artifact) (pdf-reload! artifact))
            (show-status! (str "Showing " (path-basename artifact))))
           (else
            (open-file-in-split! artifact 'horizontal 'after *jmarkdown-view-restore*)
            (show-status! (str "Opened " (path-basename artifact))))))))))

;; --- error navigation -------------------------------------------------

(define (-jmd-resolve-diag-file file)
  "Resolve a diagnostic FILE to an absolute path: an absolute path unchanged,
   a relative one against the current file's directory, nil stays nil."
  (cond
    ((nil? file) nil)
    ((string-prefix? "/" file) file)
    (else (let ((src (view-file-path (current-view))))
            (if (nil? src) file (path-resolve (path-dirname src) file))))))

(define (-jmd-visit-diag diag)
  "Echo DIAG's message, jumping to its file:line when it carries one (the file
   resolved against the current document's directory)."
  (let ((file (-jmd-resolve-diag-file (get diag :file nil)))
        (line (get diag :line nil)))
    (when (and (not (nil? file)) (file-exists? file))
      (open-file-path! file)
      (when (not (nil? line)) (goto-line! line)))
    (show-status! (-jmd-diag-line diag))))

(defcommand jmarkdown-next-error ()
  "Visit the next JMarkdown diagnostic from the last build, echoing its
   message (and jumping to its file:line when it has one). Bound to C-c `."
  (cond
    ((nil? *jmarkdown-error-list*)
     (show-status! "No JMarkdown diagnostics — build with C-c C-c"))
    ((>= (+ *jmarkdown-error-index* 1) (length *jmarkdown-error-list*))
     (show-status! "No more JMarkdown diagnostics"))
    (else
     (set! *jmarkdown-error-index* (+ *jmarkdown-error-index* 1))
     (-jmd-visit-diag (nth *jmarkdown-error-list* *jmarkdown-error-index*)))))

(defcommand jmarkdown-previous-error ()
  "Visit the previous JMarkdown diagnostic from the last build."
  (cond
    ((nil? *jmarkdown-error-list*)
     (show-status! "No JMarkdown diagnostics — build with C-c C-c"))
    ((<= *jmarkdown-error-index* 0)
     (set! *jmarkdown-error-index* 0)
     (show-status! "At first JMarkdown diagnostic"))
    (else
     (set! *jmarkdown-error-index* (- *jmarkdown-error-index* 1))
     (-jmd-visit-diag (nth *jmarkdown-error-list* *jmarkdown-error-index*)))))

(defcommand jmarkdown-show-output ()
  "Bring the JMarkdown-output dock tab forward with the last build's log."
  (if *jmarkdown-output-ready?*
      (utility-panel-activate! "jmd-output")
      (show-status! "No JMarkdown output yet — build with C-c C-c")))
