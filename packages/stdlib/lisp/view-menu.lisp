;;; view-menu.lisp — Emacs-style *Buffer List* view (renamed; the
;;; *Buffer List* name is kept for backward muscle-memory; the in-
;;; editor command is now `buffer-menu` still — the menu still lists
;;; views, but for users `*Buffer List*` is the canonical label).
;;;
;;; `C-x C-b` opens a *Buffer List* view with one row per open view.
;;; From inside the list:
;;;
;;;   RET   switch to the view on the current line, closing the menu
;;;   d / k mark the current line's view for delete
;;;   u     unmark the current line
;;;   x     kill every marked view, then refresh
;;;   g     refresh the list (re-read the view list)
;;;   q     leave the menu, returning to the view that was current
;;;         when the menu opened
;;;
;;; The list is plain text in a text-kind view with `buffer-menu-mode`
;;; set, so cursor movement, search and so on use the standard editor
;;; commands. Loaded after modes.lisp and keymap.lisp; it fills in
;;; buffer-menu-mode-map.
;;;
;;; The current-row marker `>` from Emacs is intentionally omitted —
;;; hooking point-move to repaint the column would need a host-side
;;; signal; the regular text cursor already shows the active row.

;; --- layout ------------------------------------------------------------
;;
;; The columns are fixed-width so any row can be parsed by character
;; offsets: column 0 is the mark flag, columns 1..3 are reserved (a
;; cosmetic gap), column 4 is the start of the buffer name, etc. The
;; widths below are picked to fit the longest realistic name without
;; pushing the line past 80 columns.

(define *buffer-menu-name-col* 4)
(define *buffer-menu-name-width* 28)
(define *buffer-menu-mode-width* 10)
(define *buffer-menu-lines-width* 6)
(define *buffer-menu-pane-width* 14)

(define *buffer-menu-buffer-name* "*Buffer List*")

;; The buffer that was current when `buffer-menu` opened; `q` switches
;; back to it. Nil before the menu has ever opened.
(define *buffer-menu-previous-buffer* nil)

;; --- string helpers ----------------------------------------------------

(define (pad-right s width)
  "S right-padded with spaces to WIDTH characters; truncated if longer."
  (let ((len (string-length s)))
    (cond
      ((>= len width) (substring s 0 width))
      (else (str s (make-spaces (- width len)))))))

(define (pad-left s width)
  "S left-padded with spaces to WIDTH characters; truncated if longer."
  (let ((len (string-length s)))
    (cond
      ((>= len width) (substring s 0 width))
      (else (str (make-spaces (- width len)) s)))))

(define (string-trim-right s)
  "S with trailing spaces removed."
  (cond
    ((= (string-length s) 0) s)
    ((string-suffix? " " s)
     (string-trim-right (substring s 0 (- (string-length s) 1))))
    (else s)))

(define (string-trim-left s)
  "S with leading spaces removed."
  (cond
    ((= (string-length s) 0) s)
    ((string-prefix? " " s) (string-trim-left (substring s 1)))
    (else s)))

(define (string-trim s)
  "S with leading and trailing spaces removed."
  (string-trim-left (string-trim-right s)))

;; --- record accessors --------------------------------------------------

(define (record-name rec)   (get rec :name ""))
(define (record-kind rec)   (get rec :kind "text"))
(define (record-mode rec)   (get rec :mode nil))
(define (record-lines rec)  (get rec :line-count 0))
(define (record-file rec)   (get rec :file nil))
(define (record-modified? rec) (get rec :modified #f))
;; Phase 3b (Q12): a view's :pane is the id of the leaf pane where
;; the view is currently visible (either as the leaf's direct view
;; or as the active tab of the leaf's tabline-view). Nil when the
;; view is in no pane at all (a buried tab, or only in the global
;; view list).
(define (record-pane rec)   (get rec :pane nil))

(define (mode-label rec)
  "The display string for REC's mode column."
  (let ((kind (record-kind rec))
        (mode (record-mode rec)))
    (cond
      ((not (nil? mode)) mode)
      ((equal? kind "doc") "Doc")
      ((equal? kind "image") "Image")
      ((equal? kind "customize") "Customize")
      (else "Fund"))))

(define (file-label rec)
  "The display string for REC's file column (empty when unknown)."
  (let ((f (record-file rec)))
    (if (nil? f) "" f)))

(define (pane-label rec)
  "The display string for REC's pane column (empty when the view is
   in no pane). Phase 3b (Q12)."
  (let ((p (record-pane rec)))
    (if (nil? p) "" p)))

(define (flag-string rec)
  "The single-character flag for REC: `*` modified, `.` otherwise. The
   mark column is rendered separately by `format-menu-row`."
  (if (record-modified? rec) "*" "."))

;; --- header and row formatting -----------------------------------------

(define *buffer-menu-header*
  (str
    ;; Two reserved columns (current-row, mark), then the name field.
    "  M  "
    (pad-right "Name" (- *buffer-menu-name-width* 1))
    " "
    (pad-right "Mode" *buffer-menu-mode-width*)
    " "
    (pad-left  "Lines" *buffer-menu-lines-width*)
    "  "
    (pad-right "Pane" *buffer-menu-pane-width*)
    "  "
    "File"))

(define (buffer-menu-separator)
  "A separator line of dashes the same width as the header."
  (str
    "-- "
    (pad-right "" (- *buffer-menu-name-width* 1) )))

(define (format-menu-row mark rec)
  "Render REC as one *Buffer List* row, with MARK as the action flag
   (`.` for unmarked, `D` for marked-for-delete)."
  (str
    ;; Two columns: action mark, then the modified-state flag.
    mark "  "
    (flag-string rec) "  "
    (pad-right (record-name rec) (- *buffer-menu-name-width* 1)) " "
    (pad-right (mode-label rec) *buffer-menu-mode-width*) " "
    (pad-left (number->string (record-lines rec))
              *buffer-menu-lines-width*) "  "
    (pad-right (pane-label rec) *buffer-menu-pane-width*) "  "
    (file-label rec)))

(define (buffer-menu-render records)
  "The full text of the *Buffer List* buffer for RECORDS, ending with a
   trailing newline so the cursor can rest on a row without overflowing."
  (let ((body (-buffer-menu-rows records '())))
    (str *buffer-menu-header* "\n"
         body)))

(define (-buffer-menu-rows records acc)
  (cond
    ((nil? records) (-buffer-menu-join (reverse acc)))
    (else
      (-buffer-menu-rows
        (cdr records)
        (cons (format-menu-row "." (car records)) acc)))))

(define (-buffer-menu-join lines)
  (cond
    ((nil? lines) "")
    (else (str (car lines) "\n" (-buffer-menu-join (cdr lines))))))

;; --- name extraction from a rendered row -------------------------------

(define (buffer-menu-name-on-line line)
  "Extract the buffer name from a rendered row LINE. The name lives in
   a fixed-width column starting at *buffer-menu-name-col*."
  (let ((len (string-length line)))
    (cond
      ((<= len *buffer-menu-name-col*) "")
      (else
        (let* ((from *buffer-menu-name-col*)
               (to (min len (+ from (- *buffer-menu-name-width* 1)))))
          (string-trim (substring line from to)))))))

(define (buffer-menu-mark-on-line line)
  "The action mark in column 0 of LINE (a single-character string)."
  (cond
    ((= (string-length line) 0) " ")
    (else (substring line 0 1))))

;; --- the menu buffer ---------------------------------------------------

(define (in-buffer-menu?)
  "True when the current view is the *Buffer List* view."
  (equal? (view-name) *buffer-menu-buffer-name*))

(define (-replace-buffer-text! text)
  "Clear the current buffer and insert TEXT, leaving the cursor at the
   first row of the list (just past the header)."
  (delete-region! 0 (buffer-length))
  (insert! text)
  (goto! 0)
  ;; Step over the header line to land on the first row.
  (cursor-down! #f)
  (cursor-line-start! #f))

(defcommand buffer-menu-refresh ()
  "Re-read the view list and re-render *Buffer List*. Pending marks
   are not preserved — the snapshot is fresh."
  (when (in-buffer-menu?)
    (-replace-buffer-text! (buffer-menu-render (list-views)))))

(defcommand buffer-menu ()
  "Open the *Buffer List* — one row per open view, with bindings for
   selecting (RET), marking for delete (d/k), unmarking (u), executing
   the marks (x), refreshing (g) and quitting (q). Bound to `C-x C-b`."
  ;; Remember where we came from, but don't overwrite if the menu is
  ;; already showing — `q` should jump back further than the menu itself.
  (unless (in-buffer-menu?)
    (set! *buffer-menu-previous-buffer* (view-name)))
  ;; Switch to (or create) the *Buffer List* view, set its mode, and
  ;; render the rows. The snapshot is taken *after* the menu view
  ;; exists so the menu lists itself, matching Emacs.
  (if (nil? (switch-to-view! *buffer-menu-buffer-name*))
      (new-view! *buffer-menu-buffer-name*)
      nil)
  (set-major-mode! buffer-menu-mode)
  (-replace-buffer-text! (buffer-menu-render (list-views))))

;; --- row-level commands ------------------------------------------------

(define (-current-row-name)
  "The buffer name on the current row, or `\"\"` for the header / a blank
   line / a row that has been emptied."
  (buffer-menu-name-on-line (current-line-text)))

(define (-set-mark-on-current-line! mark)
  "Replace column 0 of the current line with MARK (a one-character
   string), leaving the cursor at the start of the next line so a
   sequence of `d` keystrokes marks consecutive rows."
  (when (in-buffer-menu?)
    (let ((start (line-start))
          (end (line-end)))
      ;; Only rewrite rows — not the header — to avoid mangling it.
      (when (and (> (string-length (-current-row-name)) 0)
                 (< start end))
        (let ((tail (buffer-substring (+ start 1) end)))
          (delete-region! start end)
          (goto! start)
          (insert! (str mark tail))))
      (goto! (line-end))
      (unless (last-line?)
        (cursor-down! #f)
        (cursor-line-start! #f)))))

(defcommand buffer-menu-mark-delete ()
  "Mark the current row's buffer for deletion. Bound to `d` and `k` in
   buffer-menu-mode."
  (-set-mark-on-current-line! "D"))

(defcommand buffer-menu-unmark ()
  "Clear the action mark on the current row. Bound to `u`."
  (-set-mark-on-current-line! "."))

(defcommand buffer-menu-select ()
  "Switch to the view on the current row, closing the menu. Bound to
   `RET`."
  (when (in-buffer-menu?)
    (let ((name (-current-row-name)))
      (unless (= (string-length name) 0)
        ;; Clear `previous-buffer` so a subsequent `q` from a normal
        ;; view does the right thing if the user then opens the menu
        ;; from there.
        (switch-to-view! name)))))

(defcommand buffer-menu-execute ()
  "Kill every view marked for deletion, then refresh. Bound to `x`."
  (when (in-buffer-menu?)
    (let ((targets (-collect-marked-rows)))
      (for-each (lambda (name) (kill-view! name)) targets)
      ;; Killing views may have triggered a switch — restore the menu.
      (when (nil? (switch-to-view! *buffer-menu-buffer-name*))
        (new-view! *buffer-menu-buffer-name*)
        (set-major-mode! buffer-menu-mode))
      (-replace-buffer-text! (buffer-menu-render (list-views))))))

(define (-collect-marked-rows)
  "Walk the lines of the menu buffer; return the names whose action
   mark is `D`."
  (let ((lines (string-split (buffer-text) "\n")))
    (-collect-marked-walk lines '())))

(define (-collect-marked-walk lines acc)
  (cond
    ((nil? lines) (reverse acc))
    ((equal? (buffer-menu-mark-on-line (car lines)) "D")
     (let ((name (buffer-menu-name-on-line (car lines))))
       (if (= (string-length name) 0)
           (-collect-marked-walk (cdr lines) acc)
           (-collect-marked-walk (cdr lines) (cons name acc)))))
    (else (-collect-marked-walk (cdr lines) acc))))

(defcommand buffer-menu-quit ()
  "Leave the menu, returning to the view that was current when the
   menu opened. Bound to `q`."
  (let ((prev *buffer-menu-previous-buffer*))
    (cond
      ((nil? prev) nil)
      ((equal? prev *buffer-menu-buffer-name*) nil)
      (else (switch-to-view! prev)))))

;; --- the mode keymap ---------------------------------------------------

(set! buffer-menu-mode-map
  {"enter" 'buffer-menu-select
   "d"     'buffer-menu-mark-delete
   "k"     'buffer-menu-mark-delete
   "u"     'buffer-menu-unmark
   "x"     'buffer-menu-execute
   "g"     'buffer-menu-refresh
   "q"     'buffer-menu-quit})
