;;; shell.lisp — the `(shell)` command.
;;;
;;; Opens a shell buffer: a child process running the user's default
;;; shell ($SHELL, falling back to /bin/zsh) with a transcript above
;;; an input line. Each call creates a fresh buffer with its own
;;; long-lived shell process — to revisit an existing shell, switch
;;; to it by name with `C-x b`.
;;;
;;; This is a deliberately minimal `M-x shell`: line-oriented commands
;;; like `ls`, `git status`, `npm test`, `echo $PATH` work; curses
;;; applications (`vi`, `top`, `less`) will misbehave because there is
;;; no PTY. The view itself lives in
;;; `packages/renderer/src/shell-view.js`; this file is just the Lisp
;;; surface for invoking it.

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
