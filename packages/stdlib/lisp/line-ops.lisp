;;; line-ops.lisp — whole-line editing commands.
;;;
;;; Four commands that act on lines rather than characters:
;;; `move-line-up` / `move-line-down` swap the current line with its
;;; neighbour; `duplicate-line` copies it below; `join-line` pulls the
;;; next line onto the end of the current one. All are ordinary Lisp
;;; built on the buffer primitives — no host change.

;; --- line geometry helpers ---------------------------------------------

(define (current-line-text)
  "The text of the line the cursor is on, without its newline."
  (buffer-substring (line-start) (line-end)))

(define (line-column)
  "The cursor's offset within its line (0 at the line start)."
  (- (point) (line-start)))

(define (last-line?)
  "True when the cursor's line is the buffer's final line — there is
   no newline after `line-end`."
  (>= (line-end) (buffer-length)))

(define (first-line?)
  "True when the cursor's line is the buffer's first line."
  (= (line-start) 0))

(define (drop-leading-blanks s)
  "S with any leading spaces and tabs removed."
  (cond
    ((= (string-length s) 0) s)
    ((or (string-prefix? " " s) (string-prefix? "\t" s))
     (drop-leading-blanks (substring s 1)))
    (else s)))

;; --- moving a line up or down ------------------------------------------
;;
;; Both commands work by deleting the current line together with one
;; bounding newline, then re-inserting it on the other side of the
;; neighbour. The cursor is restored to the same column on the moved
;; line so it travels with the text.

(defcommand move-line-up ()
  "Move the current line up one, swapping it with the line above.
   The cursor keeps its column and travels with the line."
  (when (not (first-line?))
    (let ((col (line-column))
          (text (current-line-text))
          (start (line-start))
          (end (line-end)))
      (atomic-change-group
        ;; Remove the line and the newline that precedes it.
        (delete-region! (- start 1) end)
        ;; The cursor is now on what was the previous line; its start is
        ;; where the moved line must be re-inserted.
        (let ((above (line-start)))
          (goto! above)
          (insert! (str text "\n"))
          (goto! (+ above col)))))))

(defcommand move-line-down ()
  "Move the current line down one, swapping it with the line below.
   The cursor keeps its column and travels with the line."
  (when (not (last-line?))
    (let ((col (line-column))
          (text (current-line-text))
          (start (line-start))
          (end (line-end)))
      (atomic-change-group
        ;; Remove the line and the newline that follows it.
        (delete-region! start (+ end 1))
        ;; The cursor now sits at the start of what was the next line;
        ;; step to that line's end and re-insert below it.
        (goto! start)
        (let ((below-end (line-end)))
          (goto! below-end)
          (insert! (str "\n" text))
          (goto! (+ (line-start) col)))))))

;; --- duplicating a line ------------------------------------------------

(defcommand duplicate-line ()
  "Insert a copy of the current line immediately below it. The cursor
   moves to the copy, keeping its column."
  (let ((col (line-column))
        (text (current-line-text))
        (end (line-end)))
    (goto! end)
    (insert! (str "\n" text))
    (goto! (+ (line-start) col))))

;; --- transposing lines ---------------------------------------------------

(defcommand transpose-lines ()
  "Exchange the current line with the one above, leaving the cursor
   after both (C-x C-t) — repeated presses drag a line downward."
  (when (not (first-line?))
    (let ((cur-start (line-start))
          (cur-end (line-end))
          (cur-text (current-line-text)))
      (goto! (- cur-start 1))
      (let ((prev-start (line-start))
            (prev-text (current-line-text)))
        (atomic-change-group
          (delete-region! prev-start cur-end)
          (insert! (str cur-text "\n" prev-text))
          ;; After both: the start of the following line when there is
          ;; one, else the end of the buffer.
          (goto! (min (+ cur-end 1) (buffer-length))))))))

;; --- joining lines -----------------------------------------------------

(defcommand join-line ()
  "Join the next line onto the end of the current one: the intervening
   newline and the next line's leading whitespace collapse to a single
   space (Emacs-style). The cursor lands at the join."
  (when (not (last-line?))
    (let ((end (line-end)))
      (goto! end)
      ;; From the line end, the next line starts after one newline.
      (let* ((next-start (+ end 1))
             (rest (buffer-substring next-start (buffer-length)))
             (trimmed (drop-leading-blanks rest))
             (consumed (- (string-length rest) (string-length trimmed))))
        ;; Replace the newline and the leading blanks with one space.
        (atomic-change-group
          (delete-region! end (+ next-start consumed))
          (insert! " ")
          (goto! end))))))

;; --- indenting / outdenting lines (M-] / M-[) ---------------------------
;;
;; Sublime-style block indentation: every line the region touches (or
;; just the cursor's line) shifts by one indent level. A level is a
;; literal tab when the mode pins tabs (`-indent-tabs-effective`,
;; e.g. Makefiles), otherwise `*tab-width*` spaces (default 4; see
;; indent.lisp). The selection survives the shift, so repeated presses
;; keep indenting the same block.

(define (-split-lines text)
  "TEXT split on newlines, as a list (a trailing empty piece included)."
  (let ((idx (string-index-of text "\n" 0)))
    (if (< idx 0)
        (list text)
        (cons (substring text 0 idx)
              (-split-lines (substring text (+ idx 1)))))))

(define (-blank-line? line)
  "True when LINE is empty or only spaces and tabs."
  (equal? (drop-leading-blanks line) ""))

(define (-leading-spaces line limit i)
  "How many leading spaces LINE has, capped at LIMIT."
  (if (and (< i limit)
           (< i (string-length line))
           (string-prefix? " " (substring line i)))
      (-leading-spaces line limit (+ i 1))
      i))

(define (-indent-one line)
  "LINE shifted in one level. Returns (new-line . delta); blank lines
   are left alone."
  (cond
    ((-blank-line? line) (cons line 0))
    ((-indent-tabs-effective) (cons (str "\t" line) 1))
    (else
      (let ((n (-tab-width-effective)))
        (cons (str (string-repeat " " n) line) n)))))

(define (-outdent-one line)
  "LINE shifted out one level — a leading tab, or up to the effective
   tab width in spaces. Returns (new-line . delta), delta <= 0."
  (cond
    ((string-prefix? "\t" line) (cons (substring line 1) -1))
    (else
      (let ((k (-leading-spaces line (-tab-width-effective) 0)))
        (cons (substring line k) (- 0 k))))))

(define (-transform-lines lines offset transform)
  "Apply TRANSFORM (line -> (new-line . delta)) to each of LINES, the
   first starting at buffer offset OFFSET. Returns (new-text . edits)
   where edits lists (original-line-start . delta) for changed lines."
  (if (nil? lines)
      (cons "" (list))
      (let* ((shifted (transform (car lines)))
             (new-line (car shifted))
             (delta (cdr shifted))
             (rest (-transform-lines (cdr lines)
                                     (+ offset (string-length (car lines)) 1)
                                     transform))
             (text (if (nil? (cdr lines))
                       new-line
                       (str new-line "\n" (car rest))))
             (edits (if (= delta 0)
                        (cdr rest)
                        (cons (cons offset delta) (cdr rest)))))
        (cons text edits))))

(define (-shift-offset o edits acc)
  "O adjusted for EDITS — leading-whitespace insertions (delta > 0) and
   removals (delta < 0) at original line starts. An offset at a line
   start stays put; one inside a removed prefix clamps to it."
  (if (nil? edits)
      (+ o acc)
      (let* ((edit (car edits))
             (l (car edit))
             (d (cdr edit)))
        (-shift-offset o (cdr edits)
          (+ acc (cond
                   ((<= o l) 0)
                   ((> d 0) d)
                   (else (- 0 (min (- 0 d) (- o l))))))))))

(define (-shift-region-lines transform)
  "Replace every line the region (or the cursor) touches with TRANSFORM
   applied to it, then restore point — and the active region — shifted
   to keep their place in the text."
  (let* ((had-region (region-active?))
         (p (point))
         (m (if had-region (mark) p))
         (lo (min p m))
         (hi (max p m)))
    (goto! lo)
    (let ((span-start (line-start)))
      ;; A region ending at column 0 does not touch that line (Sublime's
      ;; rule) — step back onto the previous line's end.
      (goto! hi)
      (when (and had-region (> hi lo) (= hi (line-start)))
        (goto! (- hi 1)))
      (let* ((span-end (line-end))
             (old (buffer-substring span-start span-end))
             (result (-transform-lines (-split-lines old) span-start transform))
             (new-text (car result))
             (edits (cdr result)))
        (unless (nil? edits)
          (atomic-change-group
            (delete-region! span-start span-end)
            (goto! span-start)
            (insert! new-text)
            (when had-region (set-mark! (-shift-offset m edits 0)))
            (goto! (-shift-offset p edits 0))))))))

(defcommand indent-region ()
  "Indent the lines the region touches (or the current line) by one
   level — a tab where the mode pins tabs, else `*tab-width*` spaces
   (M-]). Blank lines are left alone; the selection survives."
  (-shift-region-lines -indent-one))

(defcommand outdent-region ()
  "Outdent the lines the region touches (or the current line) by one
   level — a leading tab, or up to `*tab-width*` spaces (M-[). The
   selection survives."
  (-shift-region-lines -outdent-one))

;; --- tabify / untabify (convert leading indentation) --------------------
;;
;; Re-express each line's LEADING whitespace between tabs and spaces,
;; honouring the effective tab width. `tabify` packs every `*tab-width*`
;; columns of indentation into one tab (any leftover columns stay as
;; spaces); `untabify` expands every leading tab to spaces. Only the
;; leading run is touched — interior alignment (tables, trailing
;; comments) is left exactly as it is. The `-buffer` variants convert the
;; whole buffer; the `-region` variants convert the lines the region (or
;; the cursor's line) touches. Use `tabify-buffer` to retab a file that
;; was indented with spaces after turning `*indent-tabs-mode*` on.

(define (-leading-ws line)
  "LINE's leading run of spaces and tabs, as a string."
  (substring line 0 (- (string-length line)
                       (string-length (drop-leading-blanks line)))))

(define (-ws-columns ws tw i col)
  "Visual column width of whitespace string WS, each tab advancing to the
   next multiple of TW. Pure."
  (if (>= i (string-length ws))
      col
      (-ws-columns ws tw (+ i 1)
        (if (string-prefix? "\t" (substring ws i))
            (+ col (- tw (remainder col tw)))
            (+ col 1)))))

(define (-retab-line line to-tabs?)
  "LINE with its leading whitespace re-expressed: packed into tabs plus a
   spaces remainder when TO-TABS?, else all spaces. Returns
   (new-line . delta), delta the change in the leading length. Blank
   lines (whitespace only) are left untouched."
  (if (-blank-line? line)
      (cons line 0)
      (let* ((ws (-leading-ws line))
             (rest (substring line (string-length ws)))
             (tw (-tab-width-effective))
             (cols (-ws-columns ws tw 0 0))
             (new-ws (if to-tabs?
                         (str (string-repeat "\t" (quotient cols tw))
                              (string-repeat " " (remainder cols tw)))
                         (string-repeat " " cols))))
        (cons (str new-ws rest)
              (- (string-length new-ws) (string-length ws))))))

(define (-tabify-one line) (-retab-line line #t))
(define (-untabify-one line) (-retab-line line #f))

(define (-retab-whole-buffer transform)
  "Apply TRANSFORM (line -> (new-line . delta)) to every line in the
   buffer in one atomic change, keeping point on its character."
  (let* ((old (buffer-text))
         (p (point))
         (result (-transform-lines (-split-lines old) 0 transform))
         (new-text (car result))
         (edits (cdr result)))
    (unless (nil? edits)
      (atomic-change-group
        (delete-region! 0 (buffer-length))
        (goto! 0)
        (insert! new-text)
        (goto! (-shift-offset p edits 0))))))

(defcommand tabify-region ()
  "Convert leading-whitespace indentation to tabs on the lines the region
   touches (or the current line): every `*tab-width*` columns of indent
   becomes one tab, any remainder stays as spaces. Interior spaces are
   left alone; the selection survives."
  (-shift-region-lines -tabify-one))

(defcommand untabify-region ()
  "Convert leading-whitespace indentation to spaces on the lines the
   region touches (or the current line): each leading tab expands to the
   next `*tab-width*` stop. The selection survives."
  (-shift-region-lines -untabify-one))

(defcommand tabify-buffer ()
  "Convert all leading-whitespace indentation in the buffer to tabs (see
   `tabify-region`). Use this to retab a spaces-indented file after
   turning `*indent-tabs-mode*` on."
  (-retab-whole-buffer -tabify-one))

(defcommand untabify-buffer ()
  "Convert all leading-whitespace indentation in the buffer to spaces
   (see `untabify-region`)."
  (-retab-whole-buffer -untabify-one))

;; --- sorting lines -------------------------------------------------------

(defcommand sort-lines (start end)
  "Sort the lines in [START, END) into ascending order. The range is
   snapped outward to whole lines — START back to its line start, END
   forward to its line end, except that an END at column 0 does not
   pull in that line (the indent-region rule). Point lands at the start
   of the sorted block. Unbound; reach it via M-x."
  (interactive region)
  (goto! start)
  (let ((span-start (line-start)))
    (goto! end)
    ;; A region ending at column 0 does not touch that line — step back
    ;; onto the previous line's end.
    (when (and (> end start) (= end (line-start)))
      (goto! (- end 1)))
    (let* ((span-end (line-end))
           (old (buffer-substring span-start span-end))
           (new-text (string-join (sort (-split-lines old)) "\n")))
      (if (equal? new-text old)
          (goto! span-start)            ; already sorted — no edit, no undo step
          (atomic-change-group
            (delete-region! span-start span-end)
            (goto! span-start)
            (insert! new-text)
            (goto! span-start))))))
