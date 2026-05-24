;;; jukebox.lisp — open a jukebox view for a directory.
;;;
;;; The jukebox lives in Layer 4 (see packages/renderer/src/jukebox-view.js):
;;; cover art, an <audio> element, a real <ol> track list. This file is
;;; the thin Lisp surface — a single command, plus the host hand-off
;;; for the directory picker. The view owns playback state; the host
;;; primitive `open-jukebox-buffer!` creates the buffer and switches
;;; to it.
;;;
;;; The old jukebox was a text-buffer mode that re-painted an ASCII
;;; panel after every command. That fought the editor for SPC/RET and
;;; smuggled paint code through buffer text — see docs/CUSTOM-VIEWS.md
;;; for the post-mortem. The contents that file used to hold — track
;;; rendering, panel layout, the panel keymap, the shuffle helpers —
;;; are gone; their job moved into the view.

(define (jukebox . args)
  "Open a jukebox for a directory full of audio files.

   With no argument, opens the directory picker. With a path argument,
   opens that directory directly. The buffer that appears is shown
   through the L4 jukebox view (not the text editor view); use SPC to
   play/pause, RET to play the focused track, n/p to step, s for
   shuffle, R to randomise, g to refresh, q to quit, and M-RET to open
   the album-art file as an image buffer."
  (if (nil? args)
      (prompt-directory!)
      (open-jukebox-buffer! (car args))))

(define (jukebox-on-directory-chosen path)
  "Called by the host when the user picks a directory from the
   directory-picker dialog. Bridges the dialog's callback into the
   `open-jukebox-buffer!` primitive."
  (open-jukebox-buffer! path))
