/**
 * @file Main-process shell-buffer support — spawn one long-lived child
 * process per shell buffer, stream its stdout/stderr back to the
 * renderer over async IPC, send the renderer's writes to the process's
 * stdin, and kill the process cleanly when its buffer is closed.
 *
 * The renderer is sandboxed and cannot run subprocesses directly, so
 * everything funnels through `ipcMain.handle` (write/spawn/kill) and
 * `webContents.send` (stdout/stderr/exit).
 *
 * ## v2 backing
 *
 * The shell is run under a real pty so interactive shells emit their
 * prompt, `ls --color=auto` and friends emit ANSI colour escapes, and
 * programs that ask the controlling terminal what it is get a sensible
 * answer.
 *
 * The brief originally suggested `script(1)` for the pty wrapper. BSD
 * `script` on macOS calls `tcgetattr` on its own stdin at startup, to
 * clone the parent's terminal modes onto the child's pty; when stdin
 * is a Node pipe (no tty) it fails with `tcgetattr/ioctl: Operation
 * not supported on socket`. There is no flag to disable that clone.
 * util-linux `script` works (it doesn't touch the parent's termios),
 * but we want the feature to behave identically across platforms.
 *
 * So instead of `script(1)`, we shell out to a tiny inline Python
 * script that calls `pty.spawn` from stdlib. `/usr/bin/python3` is
 * present on every modern macOS (Apple ships it as a system tool) and
 * standard on every Linux distro; the `pty` module is in stdlib, no
 * extra install needed. `pty.spawn(['/bin/zsh', '-i'])` forks,
 * allocates a pty, and proxies between the pty and the python
 * process's own stdio. Behaves identically on macOS and Linux. See
 * `architect-notes.md` for the full reasoning.
 *
 * If `python3` isn't on PATH (or we're on Windows, where the model
 * doesn't apply) we fall back to v1's plain-pipe spawn — the session
 * remembers which backing it got so the view can surface it in the
 * modeline.
 *
 * No native addons. No `node-pty`. The whole point of this approach.
 *
 * ## What v2 still doesn't handle
 *
 *   - cursor-movement codes (CSI cursor positioning, erase-in-line for
 *     repaint) are dropped by the renderer's ANSI parser, not replayed
 *     onto a redrawn transcript. Curses TUIs (`vi`, `htop`, full-screen
 *     `less`) will be unhappy — their output still arrives, but the
 *     transcript model is line-oriented and doesn't redraw.
 *   - SIGWINCH-based resize. The pty is opened at python's default
 *     size (80x24-ish) and never resized.
 *
 * ## Session bookkeeping
 *
 * Sessions are tracked in `sessions: Map<sessionId, { child, ... }>`.
 * The renderer must hand back its `BrowserWindow.webContents.id`
 * indirectly — `ipcMain.handle` exposes `event.sender` which we keep
 * so a later window-close cleans up its orphaned processes.
 */
import { ipcMain } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { homedir, platform } from 'node:os';

/**
 * Active shell sessions, keyed by a session id the renderer hands us.
 * Each entry carries the child process plus the webContents we stream
 * its output to. `pty` records whether the session got a real pty
 * backing (via the python helper) or fell back to v1's pipes.
 *
 * @type {Map<string, {
 *   child: import('node:child_process').ChildProcess,
 *   sender: Electron.WebContents,
 *   pty: boolean,
 * }>}
 */
const sessions = new Map();

/**
 * Pick the user's default shell. Honours `$SHELL` (typical on Unix);
 * falls back to `/bin/zsh` on macOS/Linux and `cmd.exe` on Windows so
 * the feature degrades gracefully if `$SHELL` is unset.
 *
 * @returns {string}
 */
export function defaultShell() {
  const envShell = process.env.SHELL;
  if (typeof envShell === 'string' && envShell !== '') return envShell;
  if (platform() === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return '/bin/zsh';
}

/**
 * The python helper: a tiny inline script that runs `pty.spawn`. The
 * shell is passed as `sys.argv[1]`. Stdout/stderr/stdin of this python
 * process is what we wire to the renderer; pty.spawn proxies
 * everything between the pty (the inner shell) and its own stdio.
 *
 * Shell flags:
 *   - `-i` runs the user's rc files (so PATH and aliases match what
 *     they have in iTerm/Terminal.app).
 *   - For zsh: `+Z` disables ZLE (the line editor). We have our own
 *     in-buffer input, and ZLE's character-by-character echo (with
 *     embedded backspaces) is the wrong model for a transcript view.
 *     The prompt still renders; only the live editing layer is off.
 *   - For bash: `--noediting` does the equivalent — disables readline.
 *
 * Terminal flags (set on the slave side before exec):
 *   - ECHO off: the kernel's tty driver will *not* echo bytes written
 *     to the master back to stdout. We render typed input ourselves
 *     in the transcript on Enter, so without this we'd see every
 *     command twice (once from us, once echoed by the tty).
 *
 * Kept on one logical line so spawn doesn't need to deal with
 * multi-arg escaping inside `-c`.
 */
const PYTHON_PTY_SCRIPT =
  "import sys, os, pty, termios; sh = sys.argv[1]; " +
  "args = [sh, '-i'] + (['+Z'] if os.path.basename(sh) == 'zsh' else " +
  "(['--noediting'] if os.path.basename(sh) == 'bash' else [])); " +
  "pid, fd = pty.fork()\n" +
  "if pid == 0:\n" +
  "  os.execvp(args[0], args)\n" +
  // Parent: set ECHO off on the master fd immediately, BEFORE forwarding
  // any input. The slave shares termios with the master, so this lands
  // before the shell reads from stdin and the kernel never echoes the
  // first characters under the default (ECHO=on) settings.
  "a = termios.tcgetattr(fd); a[3] &= ~termios.ECHO; " +
  "termios.tcsetattr(fd, termios.TCSANOW, a)\n" +
  "import select\n" +
  "while True:\n" +
  "  try: r, _, _ = select.select([0, fd], [], [])\n" +
  "  except (OSError, KeyboardInterrupt): break\n" +
  "  if 0 in r:\n" +
  "    d = os.read(0, 4096)\n" +
  "    if not d: break\n" +
  "    os.write(fd, d)\n" +
  "  if fd in r:\n" +
  "    try: d = os.read(fd, 4096)\n" +
  "    except OSError: break\n" +
  "    if not d: break\n" +
  "    os.write(1, d)\n";

/**
 * Probe whether a usable `python3` with the `pty` module is available.
 * Cached after the first call — python doesn't appear or disappear
 * during the app's lifetime, and we don't want to run a subprocess
 * every spawn.
 *
 * On Windows we never use the pty helper (pty is a Unix concept); the
 * cache is primed to `false` so the spawn path goes straight to pipes.
 *
 * @returns {boolean}
 */
let ptyProbed = false;
let ptyAvailable = false;
export function hasPty() {
  if (ptyProbed) return ptyAvailable;
  ptyProbed = true;
  if (platform() === 'win32') {
    ptyAvailable = false;
    return false;
  }
  try {
    const result = spawnSync('python3', ['-c', 'import pty'], {
      stdio: 'ignore',
      timeout: 1500,
    });
    // A clean exit means python3 is on PATH and the pty module loaded.
    // Any error (ENOENT, ImportError, timeout) means we can't use it.
    ptyAvailable =
      !result.error && result.status === 0 && result.signal === null;
  } catch {
    ptyAvailable = false;
  }
  return ptyAvailable;
}

/**
 * For testing: reset the cached python probe. Production code doesn't
 * need this — the probe is idempotent and the binary doesn't move at
 * runtime.
 */
export function _resetPtyProbe() {
  ptyProbed = false;
  ptyAvailable = false;
}

/**
 * Build the spawn arguments for running `shell -i` under the python
 * pty helper. Same form on macOS and Linux:
 *
 *   python3 -c "<PYTHON_PTY_SCRIPT>" <shell>
 *
 * The python process becomes our immediate child; it forks a pty,
 * runs the shell inside it, and proxies between the pty and its own
 * stdio. Our writes to the python process's stdin reach the shell as
 * if typed at a terminal; the shell's output (including ANSI codes
 * from `ls`, `git`, etc.) streams back through python's stdout.
 *
 * Returns `null` on platforms where we don't use the pty helper
 * (Windows — and the caller falls back to pipes there).
 *
 * @param {string} shell
 * @returns {{ command: string, args: string[] } | null}
 */
function buildPtyInvocation(shell) {
  if (platform() === 'win32') return null;
  return { command: 'python3', args: ['-c', PYTHON_PTY_SCRIPT, shell] };
}

/**
 * Kill a session's child process and forget the session. Sends SIGTERM
 * first; a process that ignores it survives but is at least detached
 * from our bookkeeping. The renderer's `exit` notification is fired
 * naturally by the child's `exit` handler in `spawnSession`.
 *
 * @param {string} sessionId
 */
function terminateSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  sessions.delete(sessionId);
  try {
    if (!entry.child.killed) entry.child.kill('SIGTERM');
  } catch {
    // Already exited; nothing to do.
  }
}

/**
 * Spawn a fresh shell child for `sessionId` and wire its streams to
 * `sender`. The renderer creates the session id; we just key off it.
 *
 * Prefers a real pty (via the python helper); falls back to a plain
 * pipe if python3 isn't available. Returns `{ shell, pid, pty }` so
 * the caller can show the user what they got.
 *
 * @param {string} sessionId
 * @param {Electron.WebContents} sender
 * @param {object} [options]
 * @param {string} [options.cwd] - Optional working directory.
 * @returns {{ shell: string, pid: number | null, pty: boolean }}
 */
function spawnSession(sessionId, sender, options = {}) {
  // Replace any pre-existing session with the same id — the renderer
  // recreates a session on tab-restore, and we should not leak.
  if (sessions.has(sessionId)) terminateSession(sessionId);

  const shell = defaultShell();
  const cwd = typeof options.cwd === 'string' && options.cwd !== ''
    ? options.cwd
    : homedir();

  // Prefer a real pty via the python helper. If unavailable, fall back
  // to pipes — the user gets v1's "no prompt, no colours" experience
  // but the feature still works.
  const invocation = hasPty() ? buildPtyInvocation(shell) : null;
  const ptyBacking = invocation !== null;

  // v1 set TERM=dumb and NO_COLOR=1 to keep ANSI out; v2 wants colour,
  // so we set TERM=xterm-256color to advertise a real-terminal-ish
  // environment to whatever the shell launches. Tools that key off
  // NO_COLOR were the v1 workaround for the same problem — drop it.
  // Inherit everything else so $PATH, $HOME, aliases via rc files
  // match the user's normal terminal.
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
  };
  delete env.NO_COLOR;

  let command;
  let args;
  if (ptyBacking) {
    command = invocation.command;
    args = invocation.args;
  } else {
    command = shell;
    // `-i` asks zsh/bash for an interactive session. Without a pty most
    // shells skip the prompt, but interactive mode still loads rc files.
    args = ['-i'];
  }

  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // The child outlives no one — the parent (Electron main) is the
    // top-level. Detached would orphan the process on crash, which is
    // worse than the alternative.
    detached: false,
  });

  sessions.set(sessionId, { child, sender, pty: ptyBacking });

  // Stream stdout/stderr to the renderer. The pty backing folds
  // everything through stdout (the python helper's combined output),
  // but we still wire stderr in case the fallback path uses it or the
  // helper itself emits a diagnostic. The view runs each chunk through
  // its ANSI parser; we just pass bytes.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (sender.isDestroyed()) return;
    sender.send('shell:data', { sessionId, stream: 'stdout', data: chunk });
  });
  child.stderr.on('data', (chunk) => {
    if (sender.isDestroyed()) return;
    sender.send('shell:data', { sessionId, stream: 'stderr', data: chunk });
  });
  child.on('error', (error) => {
    if (sender.isDestroyed()) return;
    sender.send('shell:data', {
      sessionId,
      stream: 'stderr',
      data: `\n[shell error: ${error.message}]\n`,
    });
  });
  child.on('exit', (code, signal) => {
    sessions.delete(sessionId);
    if (sender.isDestroyed()) return;
    sender.send('shell:exit', { sessionId, code, signal });
  });

  return { shell, pid: child.pid ?? null, pty: ptyBacking };
}

/**
 * Write `data` to the session's stdin. Returns whether the write was
 * accepted (the process may have already exited).
 *
 * Under the pty backing, the immediate child is the python helper.
 * Writes to its stdin land in the pty's input and reach the shell
 * exactly as if the user had typed them. Under the pipe fallback,
 * writes go straight to the shell's stdin.
 *
 * @param {string} sessionId
 * @param {string} data
 * @returns {boolean}
 */
function writeToSession(sessionId, data) {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  if (entry.child.stdin.destroyed) return false;
  try {
    return entry.child.stdin.write(data);
  } catch {
    return false;
  }
}

/**
 * Send a signal (typically SIGINT for C-c) to the session's child.
 * Defaults to SIGINT.
 *
 * Under the pty backing, the immediate child is the python helper.
 * pty.spawn does not forward signals to the shell; the conventional
 * way to interrupt the program running inside the pty is to write the
 * literal Ctrl-C byte (`\x03`) to the master fd, which the kernel
 * delivers as SIGINT to the foreground process group of the inner
 * shell. We therefore special-case SIGINT under pty backing: write
 * `\x03` to stdin instead of `kill(SIGINT)` on the python parent.
 * Any other signal goes to python itself (which terminates the whole
 * pty).
 *
 * Under the pipe fallback, signals go straight to the shell.
 *
 * @param {string} sessionId
 * @param {string} [signal]
 * @returns {boolean}
 */
function signalSession(sessionId, signal = 'SIGINT') {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  try {
    if (entry.pty && signal === 'SIGINT') {
      if (entry.child.stdin.destroyed) return false;
      return entry.child.stdin.write('\x03');
    }
    return entry.child.kill(signal);
  } catch {
    return false;
  }
}

/**
 * Close the session's stdin without killing the process. Used for C-d
 * at an empty input line, which is the conventional way to end a
 * shell session — the shell sees EOF and exits, which fires our
 * `exit` handler and removes the session.
 *
 * Under the pty backing, writing the literal Ctrl-D byte (`\x04`) is
 * the conventional way to signal EOF through a tty — `stdin.end()`
 * would close the pty input on the python side, which doesn't
 * reliably propagate as EOF to the inner shell on macOS. So under
 * pty: write `\x04`; under pipes: end stdin the way v1 did.
 *
 * @param {string} sessionId
 */
function endSessionInput(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  try {
    if (entry.pty) {
      if (entry.child.stdin.destroyed) return false;
      return entry.child.stdin.write('\x04');
    }
    entry.child.stdin.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * Register the `shell:*` IPC handlers. Call once at app startup.
 */
export function registerShellHandlers() {
  ipcMain.handle('shell:spawn', (event, payload) => {
    const sessionId = String(payload?.sessionId ?? '');
    if (sessionId === '') return { ok: false, error: 'no sessionId' };
    try {
      const info = spawnSession(sessionId, event.sender, {
        cwd: payload?.cwd,
      });
      return { ok: true, ...info };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('shell:write', (_event, payload) => {
    const sessionId = String(payload?.sessionId ?? '');
    const data = String(payload?.data ?? '');
    return { ok: writeToSession(sessionId, data) };
  });

  ipcMain.handle('shell:signal', (_event, payload) => {
    const sessionId = String(payload?.sessionId ?? '');
    const signal = typeof payload?.signal === 'string'
      ? payload.signal
      : 'SIGINT';
    return { ok: signalSession(sessionId, signal) };
  });

  ipcMain.handle('shell:end-input', (_event, payload) => {
    const sessionId = String(payload?.sessionId ?? '');
    return { ok: endSessionInput(sessionId) };
  });

  ipcMain.handle('shell:kill', (_event, payload) => {
    const sessionId = String(payload?.sessionId ?? '');
    terminateSession(sessionId);
    return { ok: true };
  });
}

/** For tests — read-only snapshot of active session ids. */
export function activeSessions() {
  return Array.from(sessions.keys());
}
