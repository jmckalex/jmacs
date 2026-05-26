/**
 * @file Main-process shell-buffer support — spawn one long-lived child
 * process per shell buffer, stream its stdout/stderr back to the
 * renderer over async IPC, send the renderer's writes to the process's
 * stdin, and kill the process cleanly when its buffer is closed.
 *
 * The renderer is sandboxed and cannot run subprocesses directly, so
 * everything funnels through `ipcMain.handle` (write/spawn/kill) and
 * `webContents.send` (stdout/stderr/exit). The shell process runs
 * `$SHELL` (or a `/bin/zsh` fallback) with plain stdio pipes — there
 * is deliberately no node-pty, no ANSI escape handling, no real TTY.
 * This is enough for a line-oriented `M-x shell`: `ls`, `git status`,
 * `echo`, `npm test`. Curses-style programs (`vi`, `top`, `less`) will
 * misbehave; that is documented as a v1 limit in the view.
 *
 * Sessions are tracked in `sessions: Map<sessionId, { child, webContents }>`.
 * The renderer must hand back its `BrowserWindow.webContents.id` indirectly
 * — `ipcMain.handle` exposes `event.sender` which we keep so a later
 * window-close cleans up its orphaned processes.
 */
import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { homedir, platform } from 'node:os';

/**
 * Active shell sessions, keyed by a session id the renderer hands us.
 * Each entry carries the child process plus the webContents we stream
 * its output to.
 * @type {Map<string, { child: import('node:child_process').ChildProcess,
 *                      sender: Electron.WebContents }>}
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
 * @param {string} sessionId
 * @param {Electron.WebContents} sender
 * @param {object} [options]
 * @param {string} [options.cwd] - Optional working directory.
 * @returns {{ shell: string, pid: number | null }}
 */
function spawnSession(sessionId, sender, options = {}) {
  // Replace any pre-existing session with the same id — the renderer
  // recreates a session on tab-restore, and we should not leak.
  if (sessions.has(sessionId)) terminateSession(sessionId);

  const shell = defaultShell();
  const cwd = typeof options.cwd === 'string' && options.cwd !== ''
    ? options.cwd
    : homedir();

  // `-i` asks zsh/bash for an interactive session, which makes them
  // emit their prompt to stdout even though stdin/stdout aren't TTYs.
  // It also reads the user's rc files, so `$PATH` and aliases match the
  // user's terminal. The trade-off is that some `bashrc`s emit ANSI
  // colour codes; the view strips them in v1.
  const args = ['-i'];

  const child = spawn(shell, args, {
    cwd,
    env: {
      ...process.env,
      // Disable colour output where possible — we don't parse ANSI.
      // A user who wants colours can re-enable them in init.lisp.
      TERM: 'dumb',
      // Make sure tools that respect this honour our non-TTY situation.
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    // The child outlives no one — the parent (Electron main) is the
    // top-level. Detached would orphan the process on crash, which is
    // worse than the alternative.
    detached: false,
  });

  sessions.set(sessionId, { child, sender });

  // Stream stdout/stderr to the renderer. Both are sent as raw text;
  // the view appends in arrival order. Carriage returns are stripped
  // by the view, not here, so the smoke harness can observe the raw
  // bytes when debugging.
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

  return { shell, pid: child.pid ?? null };
}

/**
 * Write `data` to the session's stdin. Returns whether the write was
 * accepted (the process may have already exited).
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
 * @param {string} sessionId
 * @param {string} [signal]
 * @returns {boolean}
 */
function signalSession(sessionId, signal = 'SIGINT') {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  try {
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
 * @param {string} sessionId
 */
function endSessionInput(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  try {
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
