;;; files.lisp — file commands.
;;;
;;; `find-file` (C-x C-f) opens a path the user types in the minibuffer
;;; with TAB completion against the filesystem; `save-buffer` writes
;;; the current buffer to its file. The native open-file dialog lives
;;; behind a separate command (`open-file-dialog`) that the application
;;; menu's "File > Open File…" (Cmd+O) invokes — the keymap can't
;;; reach Cmd+O directly because the renderer normalises Cmd to "C-",
;;; and "C-o" is already `open-line`.

(defcommand save-buffer ()
  "Save the current buffer to its file."
  (save-buffer!))

(defcommand open-file-dialog ()
  "Open the native OS file dialog. Used by File > Open File… (Cmd+O)."
  (open-file!))

;; --- find-file ------------------------------------------------------
;; The minibuffer's TAB calls back into this file's
;; `minibuffer-tab-complete`, which splits the path at its last "/",
;; lists the directory, finds the longest common prefix of matching
;; entries, and either:
;;   * completes inline (returns the new value), or
;;   * shows the candidates as a transient status line, leaving the
;;     value unchanged.

(define (-last-index-of/loop text char-str i)
  (cond ((< i 0) -1)
        ((equal? (substring text i (+ i 1)) char-str) i)
        (else (-last-index-of/loop text char-str (- i 1)))))

(define (-last-index-of text char-str)
  "The 0-based index of the last CHAR-STR in TEXT, or -1 when absent."
  (-last-index-of/loop text char-str (- (string-length text) 1)))

(define (-split-path text)
  "Split TEXT at its last '/', as a pair (directory . basename).
   A path with no '/' produces ('' . text); a trailing '/' yields a
   basename of ''."
  (let ((i (-last-index-of text "/")))
    (if (< i 0)
        (cons "" text)
        (cons (substring text 0 (+ i 1)) (substring text (+ i 1))))))

(define (-common-prefix/loop a b i)
  (if (or (>= i (string-length a))
          (>= i (string-length b))
          (not (equal? (substring a i (+ i 1))
                       (substring b i (+ i 1)))))
      (substring a 0 i)
      (-common-prefix/loop a b (+ i 1))))

(define (-common-prefix a b)
  "The longest leading run shared by strings A and B."
  (-common-prefix/loop a b 0))

(define (-fold-common-prefix items)
  "Fold ITEMS (strings) to their longest common prefix."
  (cond ((nil? items) "")
        ((nil? (cdr items)) (car items))
        (else (-fold-common-prefix
                (cons (-common-prefix (car items) (cadr items))
                      (cddr items))))))

(define (-expand-tilde path)
  "Replace a leading '~' in PATH with `home-directory`."
  (cond ((equal? path "~") (home-directory))
        ((string-prefix? "~/" path)
         (str (home-directory) (substring path 1 (string-length path))))
        (else path)))

(define (-matching-entries directory basename)
  "Names in DIRECTORY that begin with BASENAME, as a list of pairs
   (name . type). Returns nil when DIRECTORY can't be read."
  (let ((entries (list-directory-paths (-expand-tilde directory))))
    (if (nil? entries)
        nil
        (filter (lambda (entry)
                  (string-prefix? basename (car entry)))
                entries))))

(define (-join strings sep)
  "Join STRINGS with SEP between them."
  (cond ((nil? strings) "")
        ((nil? (cdr strings)) (car strings))
        (else (str (car strings) sep (-join (cdr strings) sep)))))

(define (-format-candidates entries)
  "Render ENTRIES (a list of (name . type)) for the status line.
   Directories carry a trailing slash so the user sees the structure."
  (-join (map (lambda (entry)
                (if (eq? (cdr entry) :directory)
                    (str (car entry) "/")
                    (car entry)))
              entries)
         "  "))

(define (minibuffer-tab-complete current)
  "Tab handler for the find-file minibuffer. Splits CURRENT at the
   last '/', lists the matching directory, and either returns a
   longer value (the longest common prefix of matching entries, with
   a trailing '/' when the result is a directory) or shows the
   candidates in the status line and returns CURRENT unchanged."
  (let* ((parts (-split-path current))
         (directory (car parts))
         (basename (cdr parts))
         (matches (-matching-entries
                    (if (equal? directory "") "." directory)
                    basename)))
    (cond
      ((nil? matches)
       (show-status! "(no matches)")
       current)
      ((nil? (cdr matches))
       ;; Exactly one match — complete to it; add '/' for directories
       ;; so the next Tab descends.
       (clear-status!)
       (let* ((entry (car matches))
              (name (car entry))
              (completed (str directory name)))
         (if (eq? (cdr entry) :directory)
             (str completed "/")
             completed)))
      (else
       ;; Many matches — extend to their longest common prefix, then
       ;; show the candidates if no progress was made.
       (let* ((names (map car matches))
              (lcp (-fold-common-prefix names))
              (extended (str directory lcp)))
         (if (> (string-length extended) (string-length current))
             (begin (clear-status!) extended)
             (begin (show-status! (-format-candidates matches)) current)))))))

(define (-initial-find-file-value)
  "The path the find-file prompt starts with: the home directory with
   a trailing '/', so the user can TAB immediately to see its entries."
  (let ((home (home-directory)))
    (if (equal? home "") "" (str home "/"))))

(define (-find-file-deliver path)
  "The submit handler — open PATH if non-empty, after tilde expansion."
  (cond ((nil? path) nil)
        ((equal? path "") nil)
        (else (open-file-path! (-expand-tilde path)))))

(defcommand find-file ()
  "Open a file, choosing the path in the minibuffer with TAB
   completion against the filesystem. Bound to `C-x C-f`."
  (let ((seed (-initial-find-file-value)))
    (open-completing-minibuffer! "Find file: " seed)
    ;; Reuse the minibuffer-read continuation hook from commands.lisp.
    (set! *minibuffer-reader* -find-file-deliver)))
