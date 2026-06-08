/**
 * @file Main-process general process runner — spawn a one-shot child
 * process, buffer its stdout/stderr, and report the result back to the
 * renderer when it exits.
 *
 * This is the host half of the Lisp `(run-process! …)` primitive (the
 * Phase-0 foundation for the AUCTeX compile/view loop), but it is
 * deliberately *general*: it knows nothing about LaTeX. It spawns an
 * arbitrary program with an explicit argument vector, in an optional
 * working directory, and streams nothing — it buffers the full output
 * and fires one `process:exit` event when the child finishes.
 *
 * Unlike `shell.js`, there is no PTY and no long-lived session: each
 * run is a fresh child keyed by a renderer-generated `runId`.
 *
 * ## Safety: no shell interpretation
 *
 * The child is spawned with `spawn(program, args)` and **no
 * `shell: true`**. The argument vector is passed to the OS exec call
 * verbatim — there is no shell to interpret metacharacters, globs, or
 * `;`/`|`/`$()`. A LaTeX file named `foo; rm -rf ~.tex` is just an
 * argument string, never a command. This is a deliberate security
 * choice; callers that genuinely need shell semantics must build their
 * own argv.
 */
import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';

/**
 * Active runs, keyed by the renderer-generated `runId`. Each entry
 * holds the child process and the webContents we report the exit to.
 *
 * @type {Map<string, {
 *   child: import('node:child_process').ChildProcess,
 *   sender: Electron.WebContents,
 * }>}
 */
const runs = new Map();

/**
 * Register the `process:*` IPC handlers. Call once at app startup,
 * next to `registerShellHandlers()`.
 */
export function registerProcessHandlers() {
  // Spawn a one-shot child. Buffers stdout + stderr (utf8) and sends
  // one `process:exit` when the child exits. A spawn error (ENOENT,
  // EACCES) surfaces through the same channel with `code: null` and
  // the error text folded into stderr, so the renderer has a single
  // completion path to handle.
  ipcMain.handle('process:run', (event, payload) => {
    const runId = String(payload?.runId ?? '');
    const program = String(payload?.program ?? '');
    const args = Array.isArray(payload?.args)
      ? payload.args.map((a) => String(a))
      : [];
    const cwd =
      typeof payload?.cwd === 'string' && payload.cwd !== ''
        ? payload.cwd
        : undefined;

    if (runId === '' || program === '') {
      return { ok: false, error: 'runId and program are required' };
    }

    // NO `shell: true`: the argv is passed straight to exec, so no
    // shell metacharacter interpretation can happen. See the file
    // header for the rationale.
    let child;
    try {
      child = spawn(program, args, cwd ? { cwd } : {});
    } catch (error) {
      // spawn() can throw synchronously for an invalid cwd or bad
      // arguments; report it like an async error so the renderer's
      // exit handler still fires exactly once.
      if (!event.sender.isDestroyed()) {
        event.sender.send('process:exit', {
          runId,
          stdout: '',
          stderr: String(error?.message ?? error),
          code: null,
        });
      }
      return { ok: false, error: String(error?.message ?? error) };
    }

    const sender = event.sender;
    runs.set(runId, { child, sender });

    let stdout = '';
    let stderr = '';
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }

    // A spawn failure that arrives asynchronously (the common ENOENT
    // path: spawn doesn't throw, it emits 'error') is folded into
    // stderr with a null exit code, mirroring the sync-throw branch.
    let errored = false;
    child.on('error', (error) => {
      errored = true;
      runs.delete(runId);
      if (sender.isDestroyed()) return;
      sender.send('process:exit', {
        runId,
        stdout,
        stderr: stderr + String(error?.message ?? error),
        code: null,
      });
    });

    child.on('exit', (code, signal) => {
      // If 'error' already fired, the exit (if any) is a duplicate —
      // 'error' is the authoritative completion in that case.
      if (errored) return;
      runs.delete(runId);
      if (sender.isDestroyed()) return;
      // `code` is null when the process was killed by a signal; carry
      // that through verbatim so the Lisp side gets `:code nil`.
      sender.send('process:exit', {
        runId,
        stdout,
        stderr,
        code: signal !== null ? null : code,
      });
    });

    return { ok: true };
  });

  // Kill a running process by id. SIGTERM by default. The child's
  // 'exit' handler still fires and reports the result; the renderer's
  // on-exit callback runs with whatever output was buffered.
  ipcMain.handle('process:kill', (_event, payload) => {
    const runId = String(payload?.runId ?? '');
    const entry = runs.get(runId);
    if (!entry) return { ok: false };
    try {
      if (!entry.child.killed) entry.child.kill('SIGTERM');
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
}

/** For tests — a read-only snapshot of active run ids. */
export function activeRuns() {
  return Array.from(runs.keys());
}
