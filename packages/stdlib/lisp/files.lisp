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

;; --- find-file settings ------------------------------------------------

(defcustom *find-file-case-sensitive* #f :boolean
  :group 'godot
  :doc "When #t, find-file's TAB completion matches filenames with
        case taken into account; when #f (the default), the prefix
        matches regardless of case. Completion always uses the
        filename's on-disk case — typing 'rea' and TABbing into a
        directory with 'README.md' produces 'README.md'.")

;; --- find-file ------------------------------------------------------
;; The minibuffer's TAB calls back into this file's
;; `minibuffer-tab-complete`, which splits the path at its last "/",
;; lists the directory, finds the longest common prefix of matching
;; entries, and either:
;;   * completes inline (returns the new value), or
;;   * lists the candidates in a transient, scrollable utility-dock tab
;;     (`show-completions!`), leaving the value unchanged. The tab is
;;     removed once TAB makes progress or the command finishes — so a
;;     busy directory no longer crams the one-line status display.

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

(define (-chars-equal? c1 c2)
  "Compare single-character strings under the active find-file
   case-sensitivity setting."
  (if *find-file-case-sensitive*
      (equal? c1 c2)
      (equal? (string-downcase c1) (string-downcase c2))))

(define (-common-prefix/loop a b i)
  (if (or (>= i (string-length a))
          (>= i (string-length b))
          (not (-chars-equal? (substring a i (+ i 1))
                              (substring b i (+ i 1)))))
      (substring a 0 i)
      (-common-prefix/loop a b (+ i 1))))

(define (-common-prefix a b)
  "The longest leading run shared by strings A and B. Compares
   characters under the active case-sensitivity setting but returns
   characters from A — when case-insensitive, the result preserves
   the case of the first input (which, for filenames, is the actual
   on-disk case)."
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

(define (-prefix-match? prefix name)
  "Whether NAME starts with PREFIX, under the active find-file
   case-sensitivity setting."
  (if *find-file-case-sensitive*
      (string-prefix? prefix name)
      (string-prefix? (string-downcase prefix) (string-downcase name))))

(define (-matching-entries directory basename)
  "Names in DIRECTORY that begin with BASENAME, as a list of pairs
   (name . type). Returns nil when DIRECTORY can't be read."
  (let ((entries (list-directory-paths (-expand-tilde directory))))
    (if (nil? entries)
        nil
        (filter (lambda (entry)
                  (-prefix-match? basename (car entry)))
                entries))))

(define (-completion-names entries)
  "Display names for ENTRIES (a list of (name . type)), for the
   completions panel. Directories carry a trailing slash so the user
   sees the structure (and the panel renders a folder icon)."
  (map (lambda (entry)
         (if (eq? (cdr entry) :directory)
             (str (car entry) "/")
             (car entry)))
       entries))

(define (minibuffer-tab-complete current)
  "Tab handler for the find-file minibuffer. Splits CURRENT at the
   last '/', lists the matching directory, and either returns a
   longer value (the longest common prefix of matching entries, with
   a trailing '/' when the result is a directory) or lists the
   candidates in the scrollable completions panel and returns CURRENT
   unchanged. Every branch that makes progress (or finds nothing)
   removes any open completions panel via `clear-completions!`, so the
   panel only lingers while the choice is genuinely ambiguous."
  (let* ((parts (-split-path current))
         (directory (car parts))
         (basename (cdr parts))
         (matches (-matching-entries
                    (if (equal? directory "") "." directory)
                    basename)))
    (cond
      ((nil? matches)
       (clear-completions!)
       (show-status! "(no matches)")
       current)
      ((nil? (cdr matches))
       ;; Exactly one match — complete to it; add '/' for directories
       ;; so the next Tab descends.
       (clear-status!)
       (clear-completions!)
       (let* ((entry (car matches))
              (name (car entry))
              (completed (str directory name)))
         (if (eq? (cdr entry) :directory)
             (str completed "/")
             completed)))
      (else
       ;; Many matches — extend to their longest common prefix, then
       ;; list the candidates in the completions panel if no progress
       ;; was made.
       (let* ((names (map car matches))
              (lcp (-fold-common-prefix names))
              (extended (str directory lcp)))
         (if (> (string-length extended) (string-length current))
             (begin (clear-status!) (clear-completions!) extended)
             (begin (clear-status!)
                    ;; DIRECTORY (the prefix up to the last '/') lets a
                    ;; click in the panel rebuild the full path.
                    (show-completions! (-completion-names matches) directory)
                    current)))))))

(define (-initial-find-file-value)
  "The path the find-file prompt starts with: the directory of the
   file the current buffer is visiting, falling back to the home
   directory — either way with a trailing '/', so the user can TAB
   immediately to see its entries."
  (let ((path (view-file-path (current-view))))
    (if (or (nil? path) (equal? path ""))
        (let ((home (home-directory)))
          (if (equal? home "") "" (str home "/")))
        (car (-split-path path)))))

(define (-find-file-deliver path)
  "The submit handler — open PATH if non-empty, after tilde expansion. A
   path that names no existing file opens an empty buffer visiting it
   (Emacs's find-file behaviour: the file is created on the first save),
   via `find-file-new!`."
  (cond ((nil? path) nil)
        ((equal? path "") nil)
        (else
         (let ((p (-expand-tilde path)))
           (if (file-exists? p)
               (open-file-path! p)
               (find-file-new! p))))))

(defcommand find-file ()
  "Open a file, choosing the path in the minibuffer with TAB
   completion against the filesystem. Bound to `C-x C-f`."
  (let ((seed (-initial-find-file-value)))
    (open-completing-minibuffer! "Find file: " seed)
    ;; Reuse the minibuffer-read continuation hook from commands.lisp.
    (set! *minibuffer-reader* -find-file-deliver)))
