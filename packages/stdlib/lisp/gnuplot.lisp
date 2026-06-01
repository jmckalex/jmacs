;;; gnuplot.lisp — the `(gnuplot)` command.
;;;
;;; Opens a gnuplot buffer: a long-lived `gnuplot` child process shown
;;; through the L4 gnuplot view as a notebook REPL. Each command you type
;;; at the input line produces a cell holding the rendered plot (an
;;; inline SVG), text output, or an error. Each call creates a fresh
;;; buffer with its own gnuplot process — to revisit one, switch to it by
;;; name with `C-x b`.
;;;
;;; gnuplot must be installed (`brew install gnuplot`); when it is not,
;;; the view degrades gracefully to an install-instructions card. The
;;; view itself lives in `packages/renderer/src/gnuplot-view.js`; this
;;; file is just the Lisp surface for invoking it.

(defcommand gnuplot ()
  "Open a fresh gnuplot buffer.

   The buffer that appears is shown through the L4 gnuplot view (not the
   text editor view) — a notebook REPL. Type a gnuplot command at the
   input line and press Enter to run it; the plot (or text / error
   output) appears as a cell above. Use Up and Down to recall previous
   commands; press C-c to interrupt a long-running plot.

   Each call to `gnuplot` creates a new buffer — switch back to an open
   one by name with `C-x b`. If gnuplot is not installed, the view shows
   install instructions (`brew install gnuplot`)."
  (open-gnuplot-buffer!))
