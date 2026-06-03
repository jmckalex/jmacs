;;; latex-synctex.lisp — AUCTeX Phase 6: SyncTeX forward & inverse search.
;;;
;;; Two-way sync between the .tex source and the in-app PDF viewer, via
;;; the `synctex` CLI (TeX Live) over `run-process!`. The compile emits
;;; `-synctex=1` (latex-compile.lisp), so `<master>.synctex.gz` sits next
;;; to the PDF.
;;;
;;;   Forward (source -> PDF)  — folded into C-c C-v (`latex-view`): after
;;;     it opens/reloads the PDF, `latex-forward-search` runs
;;;     `synctex view -i LINE:COL:srcfile -o master.pdf` and the pdf-view
;;;     scrolls to the reported page and flashes a transient highlight.
;;;
;;;   Inverse (PDF -> source)  — Option-click in the pdf-view fires
;;;     `latex-synctex-inverse`, which runs
;;;     `synctex edit -o PAGE:X:Y:master.pdf`, parses `Input:`/`Line:`,
;;;     and jumps the editor there (`open-file-path!` + `goto-line!`).
;;;
;;; Loaded AFTER latex-compile.lisp (it redefines that file's `latex-view`
;;; command) and after reftex.lisp (so `latex-master-file` is the
;;; master-detecting R1 version). All Lisp on top of the host primitives
;;; `run-process!`, `parse-synctex-view`, `parse-synctex-edit`,
;;; `point-line-col`, `pdf-synctex-show!`, `pdf-current-path`,
;;; `open-file-path!`, `goto-line!`, plus latex-compile.lisp's helpers.

;; --- user-facing settings ---------------------------------------------

;; The synctex program is a LIST of strings (program + flags), like
;; `*latex-command*`. `run-process!` spawns with NO shell, so this is a
;; token list. On a macOS GUI app the inherited PATH may lack
;; /Library/TeX/texbin; set this to a full path (e.g.
;; '("/Library/TeX/texbin/synctex")) if the bare name isn't found.
(defcustom *synctex-command* '("synctex")
  :list
  :group 'latex
  :doc "The SyncTeX program as a list of strings (program + flags). Used
   for both forward (`synctex view`) and inverse (`synctex edit`) search.
   `run-process!` takes no shell — a token list, never a shell string. On
   a macOS GUI launch the PATH may miss /Library/TeX/texbin; set this to a
   full path if the bare `synctex` is not found.")

;; --- shared helpers ---------------------------------------------------

(define (-synctex-not-found result)
  "Echo the synctex-not-found hint when RESULT shows the program was
   never spawned (reuses latex-compile.lisp's spawn-failure detector)."
  (when (-latex-spawn-failed? result)
    (show-status! "synctex not found — set *synctex-command*")))

(define (-synctex-run sub-args dir on-exit)
  "Run `*synctex-command*` with SUB-ARGS (a list of strings appended to
   the program + its configured flags) in DIR, calling ON-EXIT with the
   result hash-map. SUB-ARGS is the subcommand and its options, e.g.
   `(list \"view\" \"-i\" spec \"-o\" pdf)`."
  (let ((program (car *synctex-command*))
        (args (append (cdr *synctex-command*) sub-args)))
    (run-process! program args dir on-exit)))

;; --- forward search (source -> PDF) -----------------------------------

(define (-latex-forward-search/run line col srcfile pdf)
  "Run `synctex view -i LINE:COL:SRCFILE -o PDF` in PDF's directory; on
   exit, parse the box and flash it in the open PDF. Factored out so
   `latex-view` can call it after ensuring the PDF is shown."
  (let* ((spec (str (number->string line) ":"
                    (number->string col) ":" srcfile))
         (dir (path-dirname pdf)))
    (-synctex-run
     (list "view" "-i" spec "-o" pdf)
     dir
     (lambda (result)
       (if (-latex-spawn-failed? result)
           (-synctex-not-found result)
           (let ((box (parse-synctex-view (get result :stdout ""))))
             (if (nil? box)
                 (show-status! "SyncTeX: no forward match for this line")
                 (pdf-synctex-show! pdf
                                    (get box :page 1)
                                    (get box :h 0)
                                    (get box :v 0)
                                    (get box :W 0)
                                    (get box :H 0)))))))))

(define (latex-forward-search)
  "Forward SyncTeX from point: jump the open PDF to the typeset spot of
   the current source line and flash a highlight there. Computes the
   current .tex file (the current view's own file), the 1-based line and
   column at point, and the master PDF (from `(latex-master-file)`), then
   runs `synctex view`. A no-op with a status message when the current
   view has no .tex file or the PDF does not exist. Reusable: `latex-view`
   (C-c C-v) calls this after it ensures the PDF is shown; also a command."
  (let ((srcfile (view-file-path (current-view)))
        (tex (latex-master-file)))
    (cond
      ((or (nil? srcfile) (not (-latex-tex-file? srcfile)))
       (show-status! "SyncTeX: this view has no .tex file"))
      ((nil? tex)
       (show-status! "SyncTeX: no master .tex file"))
      (else
       (let ((pdf (-latex-pdf-path tex))
             (lc (point-line-col)))
         (cond
           ((not (file-exists? pdf))
            (show-status! "SyncTeX: no PDF yet — compile with C-c C-c"))
           ((nil? lc)
            (show-status! "SyncTeX: no cursor position"))
           (else
            (-latex-forward-search/run (car lc) (cdr lc) srcfile pdf))))))))

;; Register `latex-forward-search` as a command too (so M-x can run it
;; without going through the whole `latex-view` open-and-jump).
(register-command! 'latex-forward-search nil)

;; --- inverse search (PDF -> source) -----------------------------------

(define (latex-synctex-inverse page x y)
  "Inverse SyncTeX: given a PDF PAGE (1-based) and a PDF-point (X, Y) the
   user Option-clicked, run `synctex edit -o PAGE:X:Y:PDF` (PDF = the
   on-screen PDF's own path) and jump the editor to the resulting source
   `Input:`/`Line:`. `synctex edit` resolves the source file itself, so no
   master detection is needed here. A no-op with a status message when no
   PDF is open or SyncTeX reports no match."
  (let ((pdf (pdf-current-path)))
    (if (nil? pdf)
        (show-status! "SyncTeX: no PDF open")
        (let* ((spec (str (number->string page) ":"
                          (number->string x) ":"
                          (number->string y) ":" pdf))
               (dir (path-dirname pdf)))
          (-synctex-run
           (list "edit" "-o" spec)
           dir
           (lambda (result)
             (if (-latex-spawn-failed? result)
                 (-synctex-not-found result)
                 (let ((hit (parse-synctex-edit (get result :stdout ""))))
                   (if (nil? hit)
                       (show-status! "SyncTeX: no source for this spot")
                       (let ((file (get hit :file nil))
                             (line (get hit :line nil)))
                         (when (and (not (nil? file)) (file-exists? file))
                           (open-file-path! file)
                           (when (not (nil? line))
                             (goto-line! line))
                           (show-status!
                            (str "SyncTeX: " (path-basename file)
                                 ":" (number->string line))))))))))))))

;; --- extend latex-view with forward search ----------------------------
;; Redefine latex-compile.lisp's `latex-view` so C-c C-v ALSO forward-
;; searches to the current line after the PDF is shown. The keybinding in
;; `latex-c-c-map` is by symbol, so this redefinition takes effect without
;; re-binding. Order: ensure the PDF is open/reloaded (the original
;; behaviour), THEN run `latex-forward-search` — the synctex run is async,
;; so the highlight lands when it returns (the PDF is already on screen).

(define (latex-view)
  "Open the built PDF for `(latex-master-file)` beside the source (or
   reload it if already open), THEN forward-search to the current source
   line and flash a highlight there. The PDF path is the .tex with its
   extension swapped to .pdf, same directory. Run `latex-compile`
   (C-c C-c) first if the PDF does not exist yet. Bound to C-c C-v.

   Phase 6 extends latex-compile.lisp's open/reload `latex-view` with the
   forward-search jump; the open/reload half is unchanged."
  (let ((tex (latex-master-file)))
    (cond
      ((not (-latex-tex-file? tex))
       (show-status! "latex-view: not a .tex file"))
      (else
       (let ((pdf (-latex-pdf-path tex)))
         (cond
           ((not (file-exists? pdf))
            (show-status! "latex-view: no PDF yet — compile with C-c C-c"))
           (else
            ;; Open the PDF beside the source if it isn't already shown.
            ;; No reload here: the compile auto-reloads fresh bytes, and a
            ;; reload would re-render and fight the forward-search scroll.
            (when (nil? (-latex-find-view-by-file pdf))
              (open-file-in-split! pdf 'horizontal 'after *latex-pdf-restore*))
            ;; Jump/scroll the (shown) PDF to the current source line + flash.
            (latex-forward-search))))))))

(register-command! 'latex-view nil)
