;;; regex-search.lisp — regexp-driven search and replace commands.
;;;
;;; Three commands live here. Each is a thin Lisp shell over the host
;;; primitives `find-regexp-forward`, `find-regexp-backward`,
;;; `replace-regexp-all!`, `find-string-forward` and `replace-range!`.
;;;
;;;   isearch-regexp-forward / isearch-regexp-backward  (C-M-s / C-M-r)
;;;     — incremental regexp search: the minibuffer flow is identical
;;;       to plain isearch, but the query is a JS RegExp source. An
;;;       invalid regexp mid-typing yields no matches (no error).
;;;
;;;   replace-regexp                                    (C-M-S-5, i.e. C-M-%)
;;;     — prompt for a regexp PATTERN and a REPLACEMENT, then replace
;;;       every match in the current buffer. REPLACEMENT supports the
;;;       standard JS String.replace back-references:
;;;
;;;         $1, $2, …  — the Nth capture group
;;;         $&         — the entire match
;;;         $$         — a literal `$`
;;;
;;;       (This is JS regex idiom, not Emacs's `\1`/`\&`.)
;;;
;;;   query-replace                                     (M-S-5, i.e. M-%)
;;;     — prompt for a plain FROM and TO string (no regex), then walk
;;;       forward from point. For each match, jump to it, highlight it,
;;;       and read one key:
;;;
;;;         y, RET, space   replace and advance to the next match
;;;         n               skip and advance
;;;         q, escape       quit
;;;         !               replace this and every remaining match

;; --- regex isearch -----------------------------------------------------

(defcommand isearch-regexp-forward ()
  "Begin an incremental forward regexp search (C-M-s)."
  (start-regexp-search!))

(defcommand isearch-regexp-backward ()
  "Begin an incremental backward regexp search (C-M-r)."
  (start-regexp-search-backward!))

;; --- replace-regexp ----------------------------------------------------

(defcommand replace-regexp (pattern replacement)
  "Replace every regexp match of PATTERN with REPLACEMENT in the
   current buffer (C-M-%). REPLACEMENT supports JS RegExp back-
   references: `$1`/`$2`/… for capture groups, `$&` for the whole
   match, `$$` for a literal `$`."
  (interactive (string "Regexp: ")
               (string "Replace with: "))
  (replace-regexp-all! pattern replacement))

;; --- query-replace -----------------------------------------------------
;;
;; Query-replace is a small state machine. Each step:
;;   1. find the next match of FROM at or after `pos`;
;;   2. select it (so the editor highlights it);
;;   3. show a one-key prompt in the minibuffer;
;;   4. read a key, and from it derive the next state.
;;
;; The state is just three pieces of data, threaded through the steps as
;; explicit arguments — no mutable globals beyond what `read-next-key`
;; already needs.

(define (query-replace-prompt-text from to)
  "The minibuffer prompt for query-replace's per-match decision."
  (str "Query replacing " from " with " to ": (y/n/q/! RET)"))

(define (query-replace-finish from count)
  "Tidy up at the end of a query-replace pass."
  (clear-status!)
  (clear-mark!)
  (println (str "query-replace " from ": " count
                (if (= count 1) " replacement" " replacements"))))

(define (query-replace-step from to pos count)
  "Find the next match of FROM at or after POS. When found, highlight
   it and ask the user what to do; when not, finish."
  (let ((match (find-string-forward from pos)))
    (if (nil? match)
        (query-replace-finish from count)
        (begin
          ;; Set the mark first, then move point — `goto!` extends an
          ;; active region, so this selects (car match) .. (cdr match)
          ;; in the conventional sense (mark at the start, point at the
          ;; end).
          (clear-mark!)
          (goto! (car match))
          (set-mark! (car match))
          (goto! (cdr match))
          (show-status! (query-replace-prompt-text from to))
          (read-next-key
            (lambda (key)
              (query-replace-handle-key key from to match count)))))))

(define (query-replace-handle-key key from to match count)
  "Dispatch one keystroke during query-replace."
  (cond
    ;; Replace this match and advance.
    ((or (eq? key "y") (eq? key "enter") (eq? key "space"))
     (replace-range! (car match) (cdr match) to)
     ;; After the swap, the next search starts past the inserted text.
     (query-replace-step from to
                         (+ (car match) (string-length to))
                         (+ count 1)))
    ;; Skip this match, keep going.
    ((eq? key "n")
     (query-replace-step from to (cdr match) count))
    ;; Quit — leave the rest alone.
    ((or (eq? key "q") (eq? key "escape"))
     (query-replace-finish from count))
    ;; Replace this and every remaining match, then quit.
    ((eq? key "!")
     (query-replace-replace-rest from to match count))
    ;; Anything else: re-ask. The selection is still in place.
    (else
      (show-status! (str "(use y, n, q, !, RET — got "
                         key
                         ") "
                         (query-replace-prompt-text from to)))
      (read-next-key
        (lambda (k) (query-replace-handle-key k from to match count))))))

(define (query-replace-replace-rest from to match count)
  "Replace the current match and every subsequent one with TO, then
   finish. Implemented as a loop using `find-string-forward` so the
   per-step behaviour stays observable in tests."
  (replace-range! (car match) (cdr match) to)
  (query-replace-replace-rest-loop
    from to
    (+ (car match) (string-length to))
    (+ count 1)))

(define (query-replace-replace-rest-loop from to pos count)
  (let ((match (find-string-forward from pos)))
    (if (nil? match)
        (query-replace-finish from count)
        (begin
          (replace-range! (car match) (cdr match) to)
          (query-replace-replace-rest-loop
            from to
            (+ (car match) (string-length to))
            (+ count 1))))))

(defcommand query-replace (from to)
  "Walk forward from point, asking what to do for each plain match of
   FROM. For each: y/RET/space replaces and advances, n skips and
   advances, q/escape quits, ! replaces this and all remaining (M-%)."
  (interactive (string "Query replace: ")
               (string "Query replace with: "))
  (query-replace-step from to (point) 0))
