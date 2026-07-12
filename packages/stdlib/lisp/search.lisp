;;; search.lisp — incremental search (isearch, C-s / C-r).
;;;
;;; A server-side incremental search, modeled on regex-search.lisp's
;;; query-replace: `isearch-forward`/`isearch-backward` begin the loop, which
;;; owns the keyboard via `read-next-key` (so each subsequent keystroke routes
;;; to the search dispatcher, not self-insert). The state — the query, the
;;; direction, the origin point (for C-g), and the current match start (for
;;; repeats) — is threaded through the steps as explicit arguments; no mutable
;;; globals beyond what read-next-key already needs.
;;;
;;; Keys, the Emacs essentials:
;;;   a printable      extend the query; re-search from the origin
;;;   C-s / C-r        repeat forward / backward (wrapping past the ends)
;;;   backspace        shrink the query; re-search from the origin
;;;   C-g              abort, restoring the origin point
;;;   enter / escape   exit at the current match, releasing the keyboard
;;; Forward lands point at the match END; backward at the match START.
;;;
;;; The per-keystroke match + highlight loop used to be render-side; this is
;;; its Model-B port (see PRIMITIVE-SPLIT.md "Search"). It runs entirely in
;;; the spine over the host primitives `find-string-forward` /
;;; `find-string-backward` / `point` / `goto!` / `show-status!`.

(define (-isearch-prompt dir query)
  (str "I-search" (if (eq? dir 'backward) " backward" "") ": " query))

;; The match for QUERY in DIR scanning from BASE — (start . end), or #f on a
;; miss (the absence convention `if`/`not` test directly).
(define (-isearch-find query dir base)
  (if (eq? dir 'backward)
      (find-string-backward query base)
      (find-string-forward query base)))

;; Place point for MATCH: forward → its end, backward → its start.
(define (-isearch-goto match dir)
  (if (eq? dir 'backward)
      (goto! (car match))
      (goto! (cdr match))))

;; After a query CHANGE (extend / backspace): re-search from the ORIGIN.
;; Returns the new current-match start, or nil when there is no match.
(define (-isearch-research query dir origin)
  (if (= (string-length query) 0)
      (begin (goto! origin) nil)        ; empty query → back at the origin
      (let ((match (-isearch-find query dir origin)))
        (if (not match)
            nil                          ; failing search: leave point as-is
            (begin (-isearch-goto match dir) (car match))))))

;; REPEAT in DIR from the current match CUR (or the origin), wrapping past the
;; ends. Returns the new current-match start.
(define (-isearch-repeat query dir origin cur)
  (if (= (string-length query) 0)
      cur                                ; nothing typed yet — nothing to repeat
      (let* ((base (if (nil? cur)
                       origin
                       (if (eq? dir 'backward) (- cur 1) (+ cur 1))))
             (match (-isearch-find query dir base)))
        (if match
            (begin (-isearch-goto match dir) (car match))
            ;; No match ahead — wrap: forward from 0, backward from the end.
            (let ((wrapped (-isearch-find query dir
                             (if (eq? dir 'backward) (point-max) 0))))
              (if wrapped
                  (begin (-isearch-goto wrapped dir) (car wrapped))
                  cur))))))

;; Show the prompt and arm read-next-key for the next keystroke.
(define (-isearch-step query dir origin cur)
  (show-status! (-isearch-prompt dir query))
  (read-next-key
    (lambda (key) (-isearch-handle-key key query dir origin cur))))

;; Refresh the match highlight for the new state, then prompt + read the next
;; key. The highlight is host-side (isearch-highlight!): the CURRENT match (the
;; match starting at CUR) is lit IMMEDIATELY with the bright `isearch` face,
;; while the LAZY matches (the rest, face `search-match`) are rebuilt DEBOUNCED
;; and WINDOWED to the viewport — so typing in / repeating through a long buffer
;; stays smooth and C-s doesn't flicker the whole set. Kept distinct from
;; -isearch-start's bare -isearch-step so the loop-START path — which the stdlib
;; harness exercises WITHOUT the overlay primitives — never touches overlays;
;; only typing / repeating / exiting does.
(define (-isearch-continue query dir origin cur)
  (isearch-highlight! query (if (number? cur) cur -1))
  (-isearch-step query dir origin cur))

(define (-isearch-handle-key key query dir origin cur)
  (cond
    ;; Exit at the current match — release the keyboard (no re-arm).
    ((or (eq? key "enter") (eq? key "escape"))
     (isearch-highlight-clear!)
     (clear-status!))
    ;; Abort — restore the origin point.
    ((eq? key "C-g")
     (goto! origin)
     (isearch-highlight-clear!)
     (clear-status!))
    ;; Repeat forward / backward (switching direction if needed).
    ((eq? key "C-s")
     (-isearch-continue query 'forward origin
                        (-isearch-repeat query 'forward origin cur)))
    ((eq? key "C-r")
     (-isearch-continue query 'backward origin
                        (-isearch-repeat query 'backward origin cur)))
    ;; Backspace — shrink the query, re-search from the origin.
    ((eq? key "backspace")
     (let ((q2 (if (> (string-length query) 0)
                   (substring query 0 (- (string-length query) 1))
                   query)))
       (-isearch-continue q2 dir origin (-isearch-research q2 dir origin))))
    ;; Space — a literal space in the query.
    ((eq? key "space")
     (let ((q2 (str query " ")))
       (-isearch-continue q2 dir origin (-isearch-research q2 dir origin))))
    ;; A printable character — extend the query, re-search from the origin.
    ((= (string-length key) 1)
     (let ((q2 (str query key)))
       (-isearch-continue q2 dir origin (-isearch-research q2 dir origin))))
    ;; Any other key ends the search at the current match.
    (else
      (isearch-highlight-clear!)
      (clear-status!))))

(define (-isearch-start dir)
  "Begin an incremental search in DIR ('forward | 'backward) from point."
  (-isearch-step "" dir (point) nil))

(defcommand isearch-forward ()
  "Begin an incremental forward search in the current buffer (C-s).

   Type to extend the query (point jumps to the match end); C-s repeats
   forward and C-r backward, both wrapping; backspace shrinks the query;
   C-g aborts to where you started; enter or escape exits at the match."
  (-isearch-start 'forward))

(defcommand isearch-backward ()
  "Begin an incremental backward search in the current buffer (C-r).
   Point lands at the match start; see `isearch-forward` for the keys."
  (-isearch-start 'backward))
