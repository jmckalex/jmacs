;;; auto-fill.lisp — wrap-as-you-type minor mode (Emacs's auto-fill-mode).
;;;
;;; When `auto-fill-minor-mode` is on in a buffer, typing a character that
;;; pushes the current line past the fill column breaks the line at the
;;; last word boundary at/before the column and indents the continuation.
;;; It is off by default; toggle it with `M-x auto-fill-mode`, or turn it
;;; on for a major mode from init.lisp, e.g.
;;;
;;;   (add-hook markdown-mode (lambda () (enable-minor-mode auto-fill-minor-mode)))
;;;
;;; The design (see plans/AUTO-FILL-MODE.md):
;;;
;;;   * The break fires from `*post-self-insert-hook*` (keymap.lisp) — the
;;;     general seam run after every self-insert. We register ONE hook fn
;;;     at load; it guards on the current buffer's mode membership, since
;;;     the hook is global while the mode is per-buffer.
;;;   * `-auto-fill-break-index` is the pure, tested core — given a line, a
;;;     column and the indent width, it decides *where* to break.
;;;   * The continuation line's indent is chosen by the MAJOR mode: if the
;;;     mode's map carries a `:fill-indent-function` (a procedure, or a
;;;     symbol naming one, resolved like `:keymap`) it is called with point
;;;     at the new line's start; otherwise the broken line's leading
;;;     indentation is reproduced (the prose fill-prefix default).
;;;
;;; Loaded right after keymap.lisp (it needs the post-self-insert seam at
;;; load time) and after modes.lisp / custom.lisp (define-mode, defcustom).

;; --- the fill column ---------------------------------------------------

(defcustom *fill-column* 70 :number
  :group 'editing
  :doc "The column auto-fill-mode wraps lines at: a line is broken when
        typing pushes it past this width. 70 is Emacs's default. A major
        mode may pin a mode-local value via a `:fill-column` key on its
        mode map (like `:tab-width` in indent.lisp), which wins over this
        global setting. Set it interactively with `C-x f`
        (set-fill-column). NB: the generic M-q fill-paragraph is a
        separate code path and does not read this variable.")

(define (-fill-column-effective)
  "The fill column in force right now: the current major mode's
   `:fill-column` if it sets one, otherwise the global `*fill-column*`."
  (let* ((m (buffer-major-mode))
         (mode-fc (if (nil? m) nil (get m :fill-column nil))))
    (if (nil? mode-fc) *fill-column* mode-fc)))

;; --- the minor mode ----------------------------------------------------
;; The mode VALUE is `auto-fill-minor-mode`; the toggle COMMAND is
;; `auto-fill-mode` (the Emacs name users type). They must differ —
;; commands and variables share one namespace, so a `defcommand
;; auto-fill-mode` would clobber a `define auto-fill-mode` mode map. The
;; mode carries no keymap; its membership is the only activeness test.
(define-mode auto-fill-minor-mode
  :name "Fill")

(define (auto-fill-active?)
  "True when auto-fill-minor-mode is on in the current buffer."
  (member auto-fill-minor-mode (minor-modes)))

;; --- deciding where to break (pure) ------------------------------------

(define (-auto-fill-ws-char? line i)
  "True when the character at index I of string LINE is a space or tab."
  (let ((c (substring line i (+ i 1))))
    (or (string=? c " ") (string=? c "\t"))))

(define (-auto-fill-content-in? line lo hi)
  "True when LINE has a non-whitespace character in the range [LO, HI)."
  (cond
    ((>= lo hi) #f)
    ((-auto-fill-ws-char? line lo) (-auto-fill-content-in? line (+ lo 1) hi))
    (else #t)))

(define (-auto-fill-scan-down line i lo)
  "Scanning DOWN from index I, the largest whitespace index in (LO, I]
   with non-whitespace content after LO and before it, or #f. LO is the
   leading-indent width — we never break inside the indentation, nor
   where the first line would carry no content."
  (cond
    ((<= i lo) #f)
    ((and (-auto-fill-ws-char? line i) (-auto-fill-content-in? line lo i)) i)
    (else (-auto-fill-scan-down line (- i 1) lo))))

(define (-auto-fill-scan-up line i hi lo)
  "Scanning UP from index I (exclusive upper bound HI), the smallest
   whitespace index with content after LO and before it, or #f. The
   fallback for an over-long word: break at the first boundary *after*
   the fill column so the line still eventually wraps."
  (cond
    ((>= i hi) #f)
    ((and (-auto-fill-ws-char? line i) (-auto-fill-content-in? line lo i)) i)
    (else (-auto-fill-scan-up line (+ i 1) hi lo))))

(define (-auto-fill-break-index line fill-column prefix-len)
  "The index in LINE of the whitespace character to break at, or #f when
   no break is warranted. Prefers the last breakpoint at/before
   FILL-COLUMN; falls back to the first breakpoint after it. Never breaks
   inside the leading indentation (PREFIX-LEN wide) or where it would
   leave the first line without content. This is the whole wrapping
   decision — pure, so it is unit-tested exhaustively."
  (let ((n (string-length line)))
    (if (<= n fill-column)
        #f
        (let ((down (-auto-fill-scan-down line fill-column prefix-len)))
          (if down
              down
              (-auto-fill-scan-up line (+ fill-column 1) n prefix-len))))))

;; --- performing the break (buffer glue) --------------------------------

(define (-auto-fill-ws-run-end from limit)
  "The offset just past the run of spaces/tabs starting at FROM in the
   current buffer, bounded by LIMIT — the whitespace collapsed into the
   line break."
  (cond
    ((>= from limit) from)
    ((let ((c (buffer-substring from (+ from 1))))
       (or (string=? c " ") (string=? c "\t")))
     (-auto-fill-ws-run-end (+ from 1) limit))
    (else from)))

(define (-auto-fill-mode-indent-function)
  "The current major mode's `:fill-indent-function` resolved to a
   procedure (a symbol names one, resolved like `:keymap`), or #f when the
   mode declares none."
  (let ((m (buffer-major-mode)))
    (if (nil? m)
        #f
        (let ((f (get m :fill-indent-function nil)))
          (cond
            ((nil? f) #f)
            ((symbol? f) (eval f))
            (else f))))))

(define (-auto-fill-indent-continuation prefix)
  "Indent the continuation line — point sits at its start. Call the major
   mode's `:fill-indent-function` if it defines one (so a language can
   indent per its own syntax); otherwise reproduce the broken line's
   leading indentation PREFIX (the prose fill-prefix)."
  (let ((fn (-auto-fill-mode-indent-function)))
    (if fn
        (fn)
        (unless (= (string-length prefix) 0)
          (insert! prefix)))))

(define (-auto-fill-do-break ls bi p prefix)
  "Break the current line: replace the whitespace run at LS+BI with a
   newline plus the continuation indent, keeping point (originally at
   offset P) on the character it was on. One undo step; a marker rides the
   edits so point lands correctly."
  (atomic-change-group
    (with-marker (m p)
      (let* ((ws-start (+ ls bi))
             (ws-end (-auto-fill-ws-run-end ws-start p)))
        (delete-region! ws-start ws-end)
        (goto! ws-start)
        (insert! "\n")
        (-auto-fill-indent-continuation prefix)
        (goto! (marker-position m))))))

(define (do-auto-fill)
  "Break the current line if it now exceeds the fill column, indenting the
   continuation per the major mode. Emacs's `do-auto-fill`, run from the
   post-self-insert hook when auto-fill-minor-mode is active. A no-op when
   the line still fits or no valid break point exists."
  (let* ((fc (-fill-column-effective))
         (ls (line-start))
         (p (point))
         (col (- p ls)))
    (when (and (>= fc 1) (> col fc))
      (let* ((line (buffer-substring ls p))
             (prefix (line-indent))
             (bi (-auto-fill-break-index line fc (string-length prefix))))
        (when bi
          (-auto-fill-do-break ls bi p prefix))))))

;; --- the post-self-insert hook -----------------------------------------
;; Registered ONCE, here at load. The fn guards on per-buffer mode
;; membership (the hook is global; the mode is per-buffer), so it must not
;; be added on enable / removed on disable — membership alone decides
;; whether a given buffer wraps.

(define (auto-fill-after-self-insert key)
  "Post-self-insert hook fn: wrap the current line when
   auto-fill-minor-mode is on in this buffer. KEY is the char just typed
   (unused — the break decision reads the buffer)."
  (when (auto-fill-active?)
    (do-auto-fill)))

(add-post-self-insert-hook auto-fill-after-self-insert)

;; --- commands ----------------------------------------------------------

(defcommand auto-fill-mode ()
  "Toggle automatic line wrapping in the current buffer (Emacs's
   auto-fill-mode). With it on, typing past the fill column
   (`*fill-column*`, default 70; set with C-x f) breaks the line at the
   previous word boundary and indents the continuation the way the major
   mode wants. Off by default."
  (if (auto-fill-active?)
      (begin
        (disable-minor-mode auto-fill-minor-mode)
        (show-status! "Auto-fill mode disabled"))
      (begin
        (enable-minor-mode auto-fill-minor-mode)
        (show-status! (str "Auto-fill mode enabled (column "
                           (-fill-column-effective) ")")))))

(defcommand set-fill-column (column)
  "Set the fill column auto-fill-mode wraps at (Emacs's C-x f). Updates
   `*fill-column*` for the session; a major mode's own `:fill-column`
   still wins in its buffers."
  (interactive (number "Set fill column: "))
  (custom-apply! '*fill-column* column)
  (show-status! (str "Fill column: " column)))
