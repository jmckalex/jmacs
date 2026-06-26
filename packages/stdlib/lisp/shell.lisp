;;; shell.lisp — the `(shell)` command.
;;;
;;; Opens a shell buffer: a child process running the user's default
;;; shell ($SHELL, falling back to /bin/zsh) inside a REAL pty, shown
;;; through a full xterm.js terminal grid. Each call creates a fresh
;;; buffer with its own long-lived shell process — to revisit an
;;; existing shell, switch to it by name with `C-x b`.
;;;
;;; This is a real `M-x shell`: a proper terminal. Curses applications
;;; (`vi`, `top`, `less`), 256-colour output, window-resize reflow and
;;; full-screen TUIs all work — the backend runs the shell under a
;;; `pty.fork` (main process; no native addon — see
;;; `apps/desktop/src/shell.js`). The view itself lives in
;;; `packages/renderer/src/shell-view.js`; this file is just the Lisp
;;; surface for invoking it. Under `GODOT_SERVER=1` the same command
;;; runs on the server, which owns the shell VIEW as a data-source (the
;;; pty stays in main); `open-shell-buffer!` is the host primitive.

(defcommand shell ()
  "Open a fresh shell buffer running the user's default shell.

   The buffer that appears is shown through the L4 shell view (not the
   text editor view). Type a command at the input line and press Enter
   to run it; output streams into the transcript above. Press C-c to
   send SIGINT to a running command; press C-d at an empty input line
   to end the shell session and dismiss the buffer.

   Each call to `shell` creates a new buffer — switch back to an open
   one by name with `C-x b`."
  (open-shell-buffer!))
