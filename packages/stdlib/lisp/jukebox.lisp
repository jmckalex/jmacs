;;; jukebox.lisp — a jukebox buffer mode.
;;;
;;; A jukebox buffer is an ordinary text buffer whose major mode is
;;; jukebox-mode. The body is regenerated from a state record after
;;; every command; the user reads the panel, drives playback through
;;; the mode keymap (SPC, RET, n, p, s, R, j, k, q, g, M-RET).
;;;
;;; State lives in a host-side hash-map keyed by the buffer's name —
;;; one entry per jukebox buffer. Switching to a jukebox buffer and
;;; back keeps its playlist, current track and shuffle flag.
;;;
;;; The progress bar is refreshed on user interaction; a periodic
;;; redraw was considered but rejected for v1 — the host has no Lisp
;;; timer primitive, and the brief invited the simpler choice.
;;;
;;; Album-art ID3/MP4 extraction is out of scope: only an art file
;;; that already sits in the directory (cover.jpg, folder.png, ...)
;;; is reported. M-RET opens the art file as an image buffer via the
;;; host `open-image-file!` primitive.
;;;
;;; q stops playback and then kills the jukebox buffer via the Lisp
;;; `kill-buffer` command (`C-x k`), keeping the buffer list tidy.

;; --- audio extensions and album-art filenames -------------------------

(define *audio-extensions*
  (list ".mp3" ".wav" ".flac" ".ogg" ".m4a" ".aac" ".opus"))

(define *art-filenames*
  (list "cover.jpg" "cover.jpeg" "cover.png" "cover.webp"
        "folder.jpg" "folder.png"
        "album.jpg" "album.png"))

(define (-any-suffix? suffixes name)
  "True when NAME ends in any of SUFFIXES (case-sensitive)."
  (cond
    ((nil? suffixes) false)
    ((string-suffix? (car suffixes) (string-downcase name)) true)
    (else (-any-suffix? (cdr suffixes) name))))

(define (audio-file? name)
  "True when NAME has a recognised audio extension."
  (-any-suffix? *audio-extensions* name))

(define (-find-art entries)
  "The first member of ENTRIES whose lowercased name matches an art
   filename, or nil. The match is case-insensitive."
  (cond
    ((nil? entries) nil)
    ((member (string-downcase (car entries)) *art-filenames*)
     (car entries))
    (else (-find-art (cdr entries)))))

;; --- per-buffer state -------------------------------------------------

;; Every jukebox buffer's state — keyed by buffer name. A state is a
;; hash-map with keys :dir :tracks :index :shuffle :art.
(define *jukebox-buffers* {})

(define (jukebox-state-for name)
  "The state map for the jukebox buffer NAMEd, or nil."
  (get *jukebox-buffers* name nil))

(define (jukebox-state)
  "The state map for the current buffer."
  (jukebox-state-for (buffer-name)))

(define (set-jukebox-state! name state)
  "Store STATE as the jukebox state for buffer NAME."
  (set! *jukebox-buffers* (assoc *jukebox-buffers* name state)))

(define (update-jukebox-state! key value)
  "Set KEY to VALUE in the current buffer's jukebox state."
  (let ((state (jukebox-state)))
    (when (map? state)
      (set-jukebox-state! (buffer-name) (assoc state key value)))))

;; --- pure helpers — playlist manipulation -----------------------------

(define (jukebox-buffer-name dir)
  "The buffer name a jukebox for DIR should use."
  (str "*Jukebox: " dir "*"))

(define (filter-audio entries)
  "From ENTRIES (a list of filenames) keep only audio files."
  (filter audio-file? entries))

(define (-swap-at items i j)
  "ITEMS with elements at indices I and J exchanged."
  (let ((vec (list->vector items)))
    (vector->list
      (list->vector
        (map (lambda (k)
               (cond ((= k i) (vector-ref vec j))
                     ((= k j) (vector-ref vec i))
                     (else    (vector-ref vec k))))
             (range (length items)))))))

(define (swap-tracks tracks i j)
  "TRACKS with positions I and J swapped, or TRACKS unchanged when
   either index is out of range."
  (if (or (< i 0) (< j 0)
          (>= i (length tracks)) (>= j (length tracks)))
      tracks
      (-swap-at tracks i j)))

(define (-pluck lst i)
  "(value . rest) where VALUE is (nth lst i) and REST is LST without it."
  (let ((items (if (vector? lst) (vector->list lst) lst)))
    (cons (nth items i)
          (append (-take items i) (-drop items (+ i 1))))))

(define (-take items n)
  "The first N elements of ITEMS."
  (if (or (= n 0) (nil? items))
      (list)
      (cons (car items) (-take (cdr items) (- n 1)))))

(define (-drop items n)
  "ITEMS with the first N elements removed."
  (cond
    ((= n 0) items)
    ((nil? items) items)
    (else (-drop (cdr items) (- n 1)))))

(define (shuffle-tracks tracks)
  "A Fisher–Yates permutation of TRACKS. Repeatedly plucks a uniformly
   random element from the remaining pool and appends it to the output."
  (-shuffle tracks (list)))

(define (-shuffle pool acc)
  "Pluck a random element from POOL into ACC until POOL is empty."
  (if (nil? pool)
      acc
      (let* ((n (length pool))
             (i (random n))
             (picked (-pluck pool i)))
        (-shuffle (cdr picked) (cons (car picked) acc)))))

;; --- formatting helpers ----------------------------------------------

(define (-pad-left text width)
  "TEXT prefixed with spaces to reach WIDTH (or returned unchanged when
   it is already at least that long)."
  (let ((len (string-length text)))
    (if (>= len width)
        text
        (str (-spaces (- width len)) text))))

(define (-pad-right text width)
  (let ((len (string-length text)))
    (if (>= len width)
        text
        (str text (-spaces (- width len))))))

(define (-spaces n)
  "N spaces."
  (if (<= n 0) "" (str " " (-spaces (- n 1)))))

(define (-seconds->time secs)
  "SECS (a number) rendered as M:SS."
  (let* ((s (floor secs))
         (m (floor (/ s 60)))
         (rem (mod s 60)))
    (str (number->string m)
         ":"
         (if (< rem 10) "0" "")
         (number->string rem))))

(define (-progress-bar elapsed total width)
  "An ASCII progress bar, WIDTH chars wide, with a ● at the position."
  (let* ((ratio (if (and (> total 0) (>= elapsed 0))
                    (min 1 (/ elapsed total))
                    0))
         (filled (floor (* ratio (- width 1))))
         (remaining (- (- width 1) filled)))
    (str (-repeat "━" filled) "●" (-repeat "─" remaining))))

(define (-repeat s n)
  "S concatenated N times."
  (if (<= n 0) "" (str s (-repeat s (- n 1)))))

(define (-rule width)
  "A horizontal rule WIDTH chars wide."
  (-repeat "═" width))

;; --- panel rendering -------------------------------------------------

(define *jukebox-panel-width* 60)

(define (jukebox-render state)
  "Render STATE to a string — the buffer body."
  (let* ((dir       (get state :dir ""))
         (tracks    (get state :tracks (list)))
         (index     (get state :index nil))
         (shuffle?  (get state :shuffle false))
         (art       (get state :art nil))
         (current   (and (number? index)
                         (>= index 0)
                         (< index (length tracks))
                         (nth tracks index))))
    (str
      (-rule *jukebox-panel-width*) "\n"
      "  Jukebox: " dir
      (if shuffle? "    [SHUFFLE]" "") "\n"
      (-rule *jukebox-panel-width*) "\n"
      "\n"
      "  Now Playing: " (if current current "—") "\n"
      "  " (-render-progress state) "\n"
      "\n"
      (-render-art-line art) "\n"
      "\n"
      "  Tracks (" (number->string (length tracks)) "):\n"
      (-render-tracks tracks index) "\n"
      "\n"
      "  SPC play/pause   RET play at point   n next   p prev\n"
      "  s toggle shuffle    R randomise order    j/k move down/up\n"
      "  g refresh           M-RET open art       q kill buffer\n")))

(define (-render-progress state)
  "The play marker, progress bar, and time read-out."
  (let* ((elapsed (audio-current-time))
         (total   (audio-duration))
         (marker  (if (audio-playing?) "▶" "❚❚"))
         (bar     (-progress-bar elapsed total 24)))
    (str marker "  " bar "  "
         (-seconds->time elapsed) " / " (-seconds->time total))))

(define (-render-art-line art)
  "The album-art line, or a placeholder when there is no art file."
  (if (nil? art)
      "  [Album art: none in this directory]"
      (str "  [Album art: " art " — open it: M-RET]")))

(define (-render-tracks tracks current-index)
  "The track list with a > pointer on the current track."
  (if (nil? tracks)
      "  (no audio files in this directory)"
      (-render-track-lines tracks 0 current-index)))

(define (-render-track-lines tracks i current)
  "Each TRACK rendered as a numbered line."
  (if (nil? tracks)
      ""
      (str (-render-track-line (car tracks) i current)
           (if (nil? (cdr tracks)) "" "\n")
           (-render-track-lines (cdr tracks) (+ i 1) current))))

(define (-render-track-line track i current)
  "A single track line, with the pointer if I matches CURRENT."
  (let ((pointer (if (and (number? current) (= i current)) "> " "  "))
        (number  (-pad-left (number->string (+ i 1)) 3)))
    (str "  " pointer number ". " track)))

;; --- buffer refresh --------------------------------------------------

(define (jukebox-refresh-panel!)
  "Re-render the current buffer's panel from its jukebox state."
  (let ((state (jukebox-state)))
    (when (map? state)
      (set-buffer-text! (jukebox-render state))
      (jukebox-move-to-track! (get state :index nil)))))

;; --- track navigation in the buffer ----------------------------------
;; The panel's track lines sit at a fixed line number — the layout has
;; (in 0-indexed line numbers): 0 rule, 1 "Jukebox: ...", 2 rule,
;; 3 blank, 4 "Now Playing", 5 progress, 6 blank, 7 art, 8 blank,
;; 9 "Tracks (n):", 10 first track. Track INDEX therefore lives on
;; line 10 + INDEX.

(define *jukebox-first-track-line* 10)

(define (jukebox-move-to-track! index)
  "Place point at the start of the line for track INDEX (a number), or
   leave point alone when INDEX is nil."
  (when (number? index)
    (cursor-buffer-start!)
    (-walk-down-lines (+ *jukebox-first-track-line* index))))

(define (-walk-down-lines n)
  "Move down N lines."
  (when (and (number? n) (> n 0))
    (cursor-down!)
    (-walk-down-lines (- n 1))))

(define (jukebox-track-at-point)
  "The 0-indexed track number under point, or nil if point is not on
   a track line."
  (let* ((line (-current-line-number))
         (i (- line *jukebox-first-track-line*))
         (tracks (get (or (jukebox-state) {}) :tracks (list))))
    (if (and (>= i 0) (< i (length tracks)))
        i
        nil)))

(define (-current-line-number)
  "The 0-indexed line number of point."
  ;; The host exposes no positionAt — count newlines in the prefix.
  (-count-newlines (buffer-substring 0 (point)) 0))

(define (-count-newlines s acc)
  "How many \\n characters are in S."
  (if (= (string-length s) 0)
      acc
      (-count-newlines (substring s 1)
                       (+ acc (if (string=? (substring s 0 1) "\n") 1 0)))))

(define (string=? a b)
  "String equality."
  (and (string? a) (string? b) (equal? a b)))

;; --- path helpers ----------------------------------------------------

(define (-path-join dir name)
  "Join a directory path and a filename with /. The trailing / on DIR
   is normalised away first."
  (let ((d (if (string-suffix? "/" dir)
               (substring dir 0 (- (string-length dir) 1))
               dir)))
    (str d "/" name)))

;; --- the jukebox commands --------------------------------------------

(define (jukebox . args)
  "Open a jukebox panel for a directory full of audio files.

   With no argument, opens the directory picker. With a path argument,
   opens that directory directly."
  (if (nil? args)
      (prompt-directory!)
      (jukebox-open! (car args))))

(define (jukebox-on-directory-chosen path)
  "Called by the host when the user picks a directory."
  (jukebox-open! path))

(define (jukebox-open! dir)
  "Build or refresh the jukebox buffer for DIR and switch to it."
  (let* ((entries (or (list-directory dir) (list)))
         (tracks  (filter-audio entries))
         (art     (-find-art entries))
         (state   {:dir dir
                   :tracks tracks
                   :index (if (nil? tracks) nil 0)
                   :shuffle false
                   :art art})
         (name    (jukebox-buffer-name dir)))
    (set-jukebox-state! name state)
    (-ensure-jukebox-buffer! name)
    (jukebox-refresh-panel!)))

(define (-ensure-jukebox-buffer! name)
  "Switch to the buffer named NAME, creating it if it is not open
   already, and put it in jukebox-mode."
  (new-buffer! name)
  (set-buffer-name! name)
  (switch-major-mode jukebox-mode))

;; --- playback commands ------------------------------------------------

(define (jukebox-play-current)
  "Start playing the current track (the one at :index)."
  (let* ((state (jukebox-state))
         (index (and (map? state) (get state :index nil)))
         (tracks (if (map? state) (get state :tracks (list)) (list)))
         (dir (if (map? state) (get state :dir "") "")))
    (when (and (number? index)
               (>= index 0)
               (< index (length tracks)))
      (play-audio! (-path-join dir (nth tracks index)))
      (jukebox-refresh-panel!))))

(define (jukebox-toggle-play)
  "Pause playback if a track is playing, otherwise play the current
   track. Bound to SPC."
  (if (audio-playing?)
      (begin (pause-audio!) (jukebox-refresh-panel!))
      (jukebox-play-current)))

(define (jukebox-play-at-point)
  "Play the track on the line under point. Bound to RET."
  (let ((i (jukebox-track-at-point)))
    (when (number? i)
      (update-jukebox-state! :index i)
      (jukebox-play-current))))

(define (jukebox-next)
  "Advance to the next track and play it. Bound to n."
  (-jukebox-step 1))

(define (jukebox-prev)
  "Step back to the previous track and play it. Bound to p."
  (-jukebox-step -1))

(define (-jukebox-step delta)
  "Move :index by DELTA (wrapping) and play the new current track."
  (let* ((state (jukebox-state))
         (tracks (if (map? state) (get state :tracks (list)) (list)))
         (n (length tracks))
         (current (if (map? state) (get state :index 0) 0))
         (next (if (= n 0) nil (mod (+ current delta) n))))
    (when (number? next)
      (update-jukebox-state! :index next)
      (jukebox-play-current))))

(define (jukebox-track-ended)
  "The host calls this when the audio element finishes a track. Auto-
   advances when this is the current jukebox buffer."
  (let ((state (jukebox-state)))
    (when (map? state)
      (jukebox-next))))

(define (jukebox-toggle-shuffle)
  "Toggle the shuffle flag — a cosmetic mode marker for v1, since
   auto-advance is always linear; randomise (R) does the reshuffling."
  (let* ((state (jukebox-state))
         (current (if (map? state) (get state :shuffle false) false)))
    (update-jukebox-state! :shuffle (not current))
    (jukebox-refresh-panel!)))

(define (jukebox-randomise)
  "Replace the playlist with a Fisher–Yates random permutation, and
   reset :index to 0 if there are still tracks. Bound to R."
  (let* ((state (jukebox-state))
         (tracks (if (map? state) (get state :tracks (list)) (list)))
         (shuffled (shuffle-tracks tracks)))
    (update-jukebox-state! :tracks shuffled)
    (update-jukebox-state! :index (if (nil? shuffled) nil 0))
    (jukebox-refresh-panel!)))

(define (jukebox-move-track-down)
  "Swap the track under point with the one below it. Bound to j."
  (-jukebox-reorder 1))

(define (jukebox-move-track-up)
  "Swap the track under point with the one above it. Bound to k."
  (-jukebox-reorder -1))

(define (-jukebox-reorder delta)
  "Swap the track under point with its DELTA-neighbour and re-render."
  (let* ((i (jukebox-track-at-point))
         (state (jukebox-state))
         (tracks (if (map? state) (get state :tracks (list)) (list)))
         (current-index (if (map? state) (get state :index nil) nil)))
    (when (number? i)
      (let* ((j (+ i delta))
             (new-tracks (swap-tracks tracks i j))
             ;; If the user is moving the now-playing track, follow it.
             (new-index (cond
                          ((nil? current-index) nil)
                          ((= current-index i) j)
                          ((= current-index j) i)
                          (else current-index))))
        (when (and (>= j 0) (< j (length tracks)))
          (update-jukebox-state! :tracks new-tracks)
          (update-jukebox-state! :index new-index)
          (jukebox-refresh-panel!)
          ;; Re-point at the moved track so successive presses keep
          ;; shifting the same row.
          (jukebox-move-to-track! j))))))

(define (jukebox-refresh)
  "Re-read the directory and rebuild the playlist. Bound to g."
  (let ((state (jukebox-state)))
    (when (map? state)
      (jukebox-open! (get state :dir "")))))

(define (jukebox-quit)
  "Stop any playing audio and kill the jukebox buffer. Bound to q.

   Drops the buffer's jukebox state too — a future `(jukebox dir)`
   for the same directory rebuilds it fresh, so a stale entry would
   only waste memory."
  (stop-audio!)
  (set! *jukebox-buffers* (dissoc *jukebox-buffers* (buffer-name)))
  (kill-buffer))

(define (jukebox-open-art)
  "Open the album-art file as an image buffer. With no art file in the
   directory, prints a note to the REPL. Bound to M-RET."
  (let ((state (jukebox-state)))
    (when (map? state)
      (let ((art (get state :art nil))
            (dir (get state :dir "")))
        (if (nil? art)
            (println "Jukebox: no album-art file in this directory.")
            (open-image-file! (-path-join dir art)))))))

;; --- the keymap ------------------------------------------------------
;; jukebox-mode-map is declared empty in modes.lisp; fill it in here.

;; NB. The renderer's keymap.js returns unmodified printable keys as the
;; literal character — so SPC arrives as " ", not "space". Named-key
;; aliases (NAMED_KEYS) only resolve when a modifier is held: C-space,
;; M-space. Keep the binding as " " for the bare press.
(set! jukebox-mode-map
  {" "     'jukebox-toggle-play
   "enter" 'jukebox-play-at-point
   "n"     'jukebox-next
   "p"     'jukebox-prev
   "s"     'jukebox-toggle-shuffle
   "R"     'jukebox-randomise
   "j"     'jukebox-move-track-down
   "k"     'jukebox-move-track-up
   "g"     'jukebox-refresh
   "q"     'jukebox-quit
   "M-enter" 'jukebox-open-art})
