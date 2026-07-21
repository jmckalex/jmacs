/**
 * @file Main-process gnuplot-buffer support — spawn one long-lived
 * `gnuplot` child per gnuplot view, drive it as an interactive notebook
 * REPL, and stream per-submission results (an inline SVG plot plus any
 * text/error output) back to the renderer over async IPC.
 *
 * This mirrors `shell.js`'s session bookkeeping (a `sessions` Map keyed
 * by a renderer-generated id, `webContents.send` for output, `ipcMain.
 * handle` for spawn/write/kill, a window-close reaping the orphans) but
 * the interaction model is different. The shell streams raw pty bytes; a
 * gnuplot view is a notebook: each submitted command produces ONE result
 * (a plot, or text, or an error). So instead of forwarding raw chunks we
 * frame each submission with a preamble/epilogue (see
 * `gnuplot-protocol.js`) that routes the plot to a temp SVG file and
 * emits stdout/stderr sentinels; the host reads the SVG back, packages
 * `{ svg, text, error }`, and sends one `gnuplot:result` per submission.
 *
 * ## Graceful degradation (load-bearing)
 *
 * gnuplot is frequently not installed. `spawn('gnuplot', …)` does not
 * throw synchronously for a missing binary — it emits an async `error`
 * event with `code === 'ENOENT'`. We turn that into a distinct
 * `gnuplot:exit` event carrying `notInstalled: true` and a friendly
 * `brew install gnuplot` message, so the view renders an install card
 * rather than a transcript error. The spawn handler still returns
 * `{ ok: true }` immediately; the not-installed signal arrives a tick
 * later.
 *
 * ## No native addons, no PTY
 *
 * gnuplot in pipe mode reads commands from stdin and writes `print`
 * output to stdout, errors to stderr. No terminal, no resize, no signal
 * sidechannel — plain `stdio: ['pipe','pipe','pipe']`.
 */
import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, statSync, readFileSync, unlink, rm } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  buildSubmission,
  sentinelsFor,
  svgHasPlot,
  SubmissionDemux,
  DEFAULT_THEME,
} from './gnuplot-protocol.js';

/**
 * Active gnuplot sessions, keyed by a session id the renderer hands us.
 *
 * @type {Map<string, {
 *   child: import('node:child_process').ChildProcess,
 *   sender: Electron.WebContents,
 *   demux: import('./gnuplot-protocol.js').SubmissionDemux,
 *   queue: Array<{ id: number, userText: string }>,
 *   counter: number,
 *   active: { id: number, tmpFile: string } | null,
 *   tmpDir: string,
 *   dead: boolean,
 * }>}
 */
const sessions = new Map();

/** The friendly message shown when gnuplot isn't on PATH. */
const NOT_INSTALLED_MESSAGE =
  'gnuplot is not installed.\n\n' +
  'Install it, then reopen this view:\n' +
  '  macOS:          brew install gnuplot\n' +
  '  Debian/Ubuntu:  sudo apt install gnuplot';

/**
 * Kill a session's child process, drop its temp dir, and forget the
 * session. The renderer's exit notification is fired naturally by the
 * child's `exit` handler in `spawnSession` (or by `error` on ENOENT).
 *
 * @param {string} sessionId
 */
function terminateSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  sessions.delete(sessionId);
  entry.dead = true;
  try {
    if (!entry.child.killed) entry.child.kill('SIGTERM');
  } catch {
    // Already exited; nothing to do.
  }
  // Best-effort cleanup of the session's temp SVGs.
  if (entry.tmpDir) {
    rm(entry.tmpDir, { recursive: true, force: true }, () => {});
  }
}

/**
 * Generate a fresh random nonce for sentinels / temp-file names.
 * @returns {string}
 */
function nonce() {
  return randomBytes(6).toString('hex');
}

/**
 * Begin the next queued submission for a session, if the demux is idle.
 * Frames the submission, sets the demux's per-submission completion
 * callback (which reads the temp SVG and sends the result), and writes
 * the program to gnuplot's stdin.
 *
 * @param {string} sessionId
 */
function pump(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry || entry.dead) return;
  if (entry.demux.busy || entry.queue.length === 0) return;

  const job = entry.queue.shift();
  const tag = nonce();
  const tmpFile = join(entry.tmpDir, `cell-${job.id}-${tag}.svg`);
  const { stdout: sentinelOut, stderr: sentinelErr } = sentinelsFor(
    job.id,
    tag
  );
  entry.active = { id: job.id, tmpFile };

  entry.demux.begin({
    sentinelOut,
    sentinelErr,
    onComplete: ({ stdout, stderr }) => {
      finishSubmission(sessionId, job.id, tmpFile, stdout, stderr);
    },
  });

  const program = buildSubmission({
    userText: job.userText,
    tmpFile,
    sentinelOut,
    sentinelErr,
    theme: entry.theme,
  });

  try {
    if (!entry.child.stdin.destroyed) entry.child.stdin.write(program);
  } catch {
    // Process died mid-write; the exit handler will surface it.
  }
}

/**
 * Both sentinels have arrived for submission `id`. Read the temp SVG (if
 * it's a real plot), package the result, send it to the renderer, then
 * delete the temp file and pump the next queued submission.
 *
 * @param {string} sessionId
 * @param {number} id
 * @param {string} tmpFile
 * @param {string} stdout
 * @param {string} stderr
 */
function finishSubmission(sessionId, id, tmpFile, stdout, stderr) {
  const entry = sessions.get(sessionId);

  let svg = null;
  try {
    const st = statSync(tmpFile);
    const text = readFileSync(tmpFile, 'utf8');
    if (svgHasPlot(st, text)) {
      // Strip any <script> gnuplot's svg terminal might emit, as
      // defence-in-depth before the renderer inlines the markup.
      svg = stripScripts(text);
    }
  } catch {
    // No file -> no plot. Leave svg null.
  }
  // Read-and-delete: the SVG bytes now live in the result payload.
  unlink(tmpFile, () => {});

  if (entry) entry.active = null;

  if (entry && !entry.sender.isDestroyed()) {
    entry.sender.send('gnuplot:result', {
      sessionId,
      id,
      svg,
      text: stdout,
      error: stderr,
    });
  }

  pump(sessionId);
}

/**
 * Remove `<script>…</script>` blocks from SVG markup. gnuplot's svg
 * terminal can emit a mousing `<script>` referencing external JS; we
 * strip it before the trusted-local SVG is inlined.
 *
 * @param {string} svg
 * @returns {string}
 */
function stripScripts(svg) {
  return svg.replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

/**
 * Spawn a fresh gnuplot child for `sessionId` and wire its streams to
 * `sender`. The renderer creates the session id; we just key off it.
 *
 * On ENOENT (gnuplot not installed) the child emits an async `error`
 * event, which we translate into a `gnuplot:exit` with `notInstalled:
 * true`. `spawn` itself does not throw for a missing binary, so this
 * function returns normally and the not-installed signal arrives a tick
 * later.
 *
 * @param {string} sessionId
 * @param {Electron.WebContents} sender
 * @param {object} [options]
 * @param {string} [options.cwd] - Optional working directory.
 * @returns {{ pid: number | null }}
 */
function spawnSession(sessionId, sender, options = {}) {
  if (sessions.has(sessionId)) terminateSession(sessionId);

  const cwd =
    typeof options.cwd === 'string' && options.cwd !== ''
      ? options.cwd
      : homedir();

  // Per-session temp dir for the cell SVGs; reaped on terminate / exit.
  const tmpDir = mkdtempSync(join(tmpdir(), 'godot-gp-'));

  // GNUTERM=unknown stops gnuplot trying to auto-select an interactive
  // terminal (qt/x11/wxt) at startup. We set the real `svg` terminal per
  // submission anyway.
  const env = { ...process.env, GNUTERM: 'unknown' };

  const child = spawn('gnuplot', [], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  });

  const entry = {
    child,
    sender,
    demux: new SubmissionDemux(),
    queue: [],
    counter: 0,
    active: null,
    tmpDir,
    theme: DEFAULT_THEME,
    dead: false,
  };
  sessions.set(sessionId, entry);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    entry.demux.pushStdout(chunk);
  });
  child.stderr.on('data', (chunk) => {
    entry.demux.pushStderr(chunk);
  });

  child.on('error', (error) => {
    entry.dead = true;
    sessions.delete(sessionId);
    rm(tmpDir, { recursive: true, force: true }, () => {});
    if (sender.isDestroyed()) return;
    if (error.code === 'ENOENT') {
      sender.send('gnuplot:exit', {
        sessionId,
        code: null,
        signal: null,
        notInstalled: true,
        message: NOT_INSTALLED_MESSAGE,
      });
      return;
    }
    sender.send('gnuplot:exit', {
      sessionId,
      code: null,
      signal: null,
      error: error.message,
      message: `gnuplot failed to start: ${error.message}`,
    });
  });

  child.on('exit', (code, signal) => {
    entry.dead = true;
    sessions.delete(sessionId);
    rm(tmpDir, { recursive: true, force: true }, () => {});
    if (sender.isDestroyed()) return;
    sender.send('gnuplot:exit', { sessionId, code, signal });
  });

  return { pid: child.pid ?? null };
}

/**
 * Queue a user command as a submission against the session and pump the
 * queue. Returns whether the session exists and accepted the work.
 *
 * @param {string} sessionId
 * @param {string} data - The user's gnuplot command line.
 * @returns {boolean}
 */
function writeToSession(sessionId, data) {
  const entry = sessions.get(sessionId);
  if (!entry || entry.dead) return false;
  entry.counter += 1;
  entry.queue.push({ id: entry.counter, userText: String(data) });
  pump(sessionId);
  return true;
}

/**
 * Send SIGINT to the session's child — interrupts a long-running plot.
 * The already-queued epilogue then runs and the cell completes.
 *
 * @param {string} sessionId
 * @returns {boolean}
 */
function signalSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry || entry.dead) return false;
  try {
    return entry.child.kill('SIGINT');
  } catch {
    return false;
  }
}

/**
 * Register the `gnuplot:*` IPC handlers. Call once at app startup.
 */
export function registerGnuplotHandlers() {
  ipcMain.handle('gnuplot:spawn', (event, payload) => {
    const sessionId = String(payload?.sessionId ?? '');
    if (sessionId === '') return { ok: false, error: 'no sessionId' };
    try {
      const info = spawnSession(sessionId, event.sender, {
        cwd: payload?.cwd,
      });
      return { ok: true, ...info };
    } catch (error) {
      // Synchronous failures only (e.g. a bad cwd, mkdtemp failure);
      // a missing binary surfaces async via the 'error' event above.
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('gnuplot:write', (_event, payload) => {
    const sessionId = String(payload?.sessionId ?? '');
    const data = String(payload?.data ?? '');
    return { ok: writeToSession(sessionId, data) };
  });

  ipcMain.handle('gnuplot:signal', (_event, payload) => {
    const sessionId = String(payload?.sessionId ?? '');
    return { ok: signalSession(sessionId) };
  });

  ipcMain.handle('gnuplot:kill', (_event, payload) => {
    const sessionId = String(payload?.sessionId ?? '');
    terminateSession(sessionId);
    return { ok: true };
  });

  // Set a session's plot theme (e.g. 'dark' | 'light'); subsequent
  // submissions render with it.
  ipcMain.handle('gnuplot:set-theme', (_event, payload) => {
    const entry = sessions.get(String(payload?.sessionId ?? ''));
    if (entry) entry.theme = String(payload?.theme ?? DEFAULT_THEME);
    return { ok: !!entry };
  });
}

/** For tests — read-only snapshot of active session ids. */
export function activeSessions() {
  return Array.from(sessions.keys());
}
