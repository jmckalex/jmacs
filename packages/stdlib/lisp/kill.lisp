;;; kill.lisp — the kill ring (cut, copy, paste).
;;;
;;; The kill ring is ordinary Lisp state: a list of killed strings,
;;; most recent first. The commands are built on the buffer primitives.

(define *kill-ring* (list))

(define (kill-ring-add! text)
  "Push TEXT onto the kill ring AND mirror it to the system clipboard
   (Emacs's interprogram-cut), so every editor kill / copy can be pasted
   in another application (or with Cmd+V here). All cut/copy commands
   funnel through here, so this one hook covers the whole family."
  (set! *kill-ring* (cons text *kill-ring*))
  (clipboard-set-text! text))

(define (kill-ring-top)
  "The most recent kill, or an empty string when the ring is empty."
  (if (nil? *kill-ring*) "" (car *kill-ring*)))

(define (kill-ring-length)
  "The number of entries in the kill ring."
  (length *kill-ring*))

(define (kill-ring-ref index)
  "The kill at INDEX (0 is the most recent), or an empty string when the
   ring is empty. INDEX wraps around the ring."
  (if (nil? *kill-ring*)
      ""
      (nth *kill-ring* (mod index (kill-ring-length)))))

;; --- kill accumulation -------------------------------------------------
;;
;; Consecutive kill commands grow ONE kill-ring entry rather than each
;; pushing their own (Emacs's kill accumulation): C-k C-k C-y reinserts
;; both lines. "Consecutive" is judged by `*last-command*` — any other
;; command in between breaks the run. A forward kill appends its text to
;; the entry; a backward kill prepends.

(define *kill-command-names*
  '(kill-region kill-line kill-word kill-sentence backward-kill-word
    kill-whole-line zap-to-char))

(define (-kill-continues?)
  "True when the previous command was also a kill, so this kill joins
   the same kill-ring entry."
  (and (member *last-command* *kill-command-names*)
       (not (nil? *kill-ring*))))

(define (-kill-ring-replace-top! text)
  "Replace the most recent kill with TEXT, mirroring the clipboard."
  (set! *kill-ring* (cons text (cdr *kill-ring*)))
  (clipboard-set-text! text))

(define (kill-add-forward! text)
  "Record TEXT killed *forward*: appended to the previous kill when the
   last command was also a kill, else pushed as a fresh entry."
  (if (-kill-continues?)
      (-kill-ring-replace-top! (str (kill-ring-top) text))
      (kill-ring-add! text)))

(define (kill-add-backward! text)
  "Record TEXT killed *backward*: prepended to the previous kill when
   the last command was also a kill, else pushed as a fresh entry."
  (if (-kill-continues?)
      (-kill-ring-replace-top! (str text (kill-ring-top)))
      (kill-ring-add! text)))

;; --- yank state --------------------------------------------------------
;;
;; `yank` records where it inserted text so a following `yank-pop` can
;; find and replace it. `*yank-start*` is the offset of the inserted
;; text, `*yank-length*` its length, and `*yank-index*` which kill it
;; came from (0 = the most recent). The state is only meaningful when the
;; command just run was `yank` or `yank-pop` (see `yank-pop`).

(define *yank-start* 0)
(define *yank-length* 0)
(define *yank-index* 0)

(define (record-yank! start text index)
  "Remember that TEXT (from kill INDEX) was inserted at offset START, so
   a following `yank-pop` can replace it."
  (set! *yank-start* start)
  (set! *yank-length* (string-length text))
  (set! *yank-index* index))

(defcommand copy-region ()
  "Copy the selected text to the kill ring."
  (when (region-active?)
    (kill-ring-add! (region-text))
    (clear-mark!)))

(defcommand kill-region ()
  "Cut the selected text to the kill ring."
  (when (region-active?)
    (kill-add-forward! (region-text))
    (delete-backward!)))

(defcommand kill-line ()
  "Kill from the cursor to the end of the line; at a line's end, kill
   the newline. Consecutive kills grow one kill-ring entry."
  (let ((from (point))
        (to (line-end)))
    (when (> (buffer-length) from)
      (let ((end (if (< from to) to (+ from 1))))
        (kill-add-forward! (buffer-substring from end))
        (delete-region! from end)))))

(defcommand kill-whole-line ()
  "Kill the entire current line, its newline included (C-S-backspace)."
  (let ((start (line-start))
        (end (min (+ (line-end) 1) (buffer-length))))
    (when (< start end)
      (kill-add-forward! (buffer-substring start end))
      (delete-region! start end))))

(define (-yank-sync-clipboard!)
  "Pull the system clipboard onto the kill ring when it holds non-empty
   text the ring's top does not already have (Emacs's interprogram-paste).
   Pushed directly — it is already on the clipboard, so no write-back. So
   C-y pastes text copied in another app, and a fresh ring isn't empty."
  (let ((clip (clipboard-text)))
    (when (and (not (equal? clip ""))
               (not (equal? clip (kill-ring-top))))
      (set! *kill-ring* (cons clip *kill-ring*)))))

(defcommand yank ()
  "Insert the most recent kill at the cursor. First syncs in the system
   clipboard (so C-y also pastes text copied elsewhere), then inserts the
   ring's top. Records the insertion so a following `yank-pop` (M-y) can
   cycle through the kill ring. The recorded start is measured *after*
   the insert — over an active selection the text replaces it and lands
   at the selection start, not at point."
  (-yank-sync-clipboard!)
  (let ((text (kill-ring-top)))
    (insert! text)
    (record-yank! (- (point) (string-length text)) text 0)))

(defcommand kill-word ()
  "Kill forward to the end of the next word. Consecutive kills grow one
   kill-ring entry."
  (let ((from (point))
        (to (word-forward-offset)))
    (when (> to from)
      (kill-add-forward! (buffer-substring from to))
      (delete-region! from to))))

(defcommand kill-sentence ()
  "Kill forward to the end of the sentence. Consecutive kills grow one
   kill-ring entry."
  (let ((from (point))
        (to (sentence-forward-offset)))
    (when (> to from)
      (kill-add-forward! (buffer-substring from to))
      (delete-region! from to))))

(defcommand backward-kill-word ()
  "Kill backward to the start of the previous word. Consecutive kills
   grow one kill-ring entry (a backward kill prepends its text)."
  (let ((from (point))
        (to (word-backward-offset)))
    (when (< to from)
      (kill-add-backward! (buffer-substring to from))
      (delete-region! to from))))

(defcommand zap-to-char ()
  "Read a character, then kill from the cursor through the next
   occurrence of it. Unbound; reach it via M-x."
  (show-status! "Zap to char: ")
  (read-next-key
    (lambda (key)
      (clear-status!)
      (if (and (string? key) (= (string-length key) 1))
          (let ((idx (string-index-of
                       (buffer-substring (point) (buffer-length)) key 0)))
            (if (< idx 0)
                (show-status! (str "zap-to-char: no \"" key "\" found"))
                (let ((end (+ (point) idx 1)))
                  (kill-add-forward! (buffer-substring (point) end))
                  (delete-region! (point) end))))
          (show-status! "zap-to-char: quit")))))
