/**
 * @file Main-process JMarkdown live-preview watcher.
 *
 * The preview pane (C-c v) shows the current Markdown / JMarkdown *file*
 * rendered by the REAL `jmarkdown watch <file> --port N` server — the same
 * pipeline the book build uses — live-reloading (morphdom DOM-diffing) on
 * every save. The renderer is sandboxed and can't spawn, so the subprocess
 * lives here and is reached over the `jmarkdown:watch:*` IPC channels.
 *
 * One watcher per window, keyed by the requesting window's `webContents.id`.
 * Starting a watcher for a window replaces that window's previous one (a
 * buffer switch re-points the preview at the new file), and a window's child
 * is reaped on window close and on app quit. Modelled on shell.js's spawn +
 * SIGTERM/SIGKILL reaping.
 */

import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';

import { buildWatchArgs, watchEnv } from './jmarkdown-watch-args.js';

/** webContents id -> { child, port }. One live watcher per window. */
const watchers = new Map();

/** How long to wait for the watch server to start accepting connections
 *  before giving up (it builds the document before it serves). */
const READY_TIMEOUT_MS = 10000;
/** Poll interval while waiting for the server to come up. */
const READY_POLL_MS = 150;
/** SIGKILL backstop delay after a SIGTERM that didn't reap the child. */
const KILL_BACKSTOP_MS = 250;

/** Resolve to a free TCP port by binding 127.0.0.1:0 and reading back the
 *  OS-assigned port, then closing the probe socket. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Poll `port` until something accepts a connection, the child exits, or the
 * caller aborts / we time out. Resolves true once the server is up, false
 * otherwise. Output-agnostic (we don't parse jmarkdown's stdout).
 *
 * @param {number} port
 * @param {import('node:child_process').ChildProcess} child
 * @param {() => boolean} isAborted - True once the spawn has failed.
 * @returns {Promise<boolean>}
 */
function waitForPort(port, child, isAborted) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  return new Promise((resolve) => {
    const tryOnce = () => {
      if (isAborted() || child.exitCode !== null || child.signalCode !== null) {
        resolve(false);
        return;
      }
      const sock = connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(tryOnce, READY_POLL_MS);
      });
    };
    tryOnce();
  });
}

/**
 * Kill a window's watcher child (SIGTERM, then a SIGKILL backstop if it
 * lingers) and forget it. Mirrors shell.js's terminateSession.
 *
 * @param {number} wcId
 */
function killWatcher(wcId) {
  const entry = watchers.get(wcId);
  if (!entry) return;
  watchers.delete(wcId);
  const { child } = entry;
  try { child.kill('SIGTERM'); } catch { /* already exited */ }
  setTimeout(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    } catch { /* already exited */ }
  }, KILL_BACKSTOP_MS);
}

/**
 * Start (or restart) the watcher for window `wcId` on `filePath`. Resolves
 * `{ port }` once the preview server is accepting connections, or `{ error }`
 * on an empty path / missing binary / spawn failure / startup timeout. Never
 * rejects, so the renderer can surface the message cleanly.
 *
 * @param {number} wcId
 * @param {string} filePath
 * @returns {Promise<{port: number} | {error: string}>}
 */
async function startWatcher(wcId, filePath) {
  if (typeof filePath !== 'string' || filePath === '') {
    return { error: 'no file to preview (save the file first)' };
  }
  killWatcher(wcId); // one watcher per window — drop the previous file's server

  let port;
  try {
    port = await freePort();
  } catch (error) {
    return { error: `could not allocate a preview port: ${error.message}` };
  }

  let child;
  try {
    child = spawn('jmarkdown', buildWatchArgs(filePath, port), {
      env: watchEnv(process.env),
      // Forward the watch server's build log to the editor's own stdout/stderr
      // (visible in the launching terminal) — useful while iterating; an
      // inherited fd never blocks the child the way an undrained pipe would.
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: false,
    });
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }

  // Claim the window's slot, reaping any watcher that appeared while we were
  // allocating the port / spawning — a concurrent restart (rapid buffer
  // switches) could have set one. Killing by the slot's identity here, then
  // only ever touching OUR `child` by reference below, means neither call can
  // reap the other's process: no orphaned `jmarkdown watch` servers.
  killWatcher(wcId);
  watchers.set(wcId, { child, port });
  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });
  child.once('exit', () => {
    // Forget the child if it dies on its own; a later stop is then a no-op.
    if (watchers.get(wcId)?.child === child) watchers.delete(wcId);
  });

  const ready = await waitForPort(port, child, () => spawnError !== null);

  if (!ready) {
    // Drop our slot (only if still ours — a newer start may already own it)
    // and make sure our own child is gone.
    if (watchers.get(wcId)?.child === child) watchers.delete(wcId);
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
    setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      } catch { /* already exited */ }
    }, KILL_BACKSTOP_MS);
    return {
      error: spawnError
        ? (spawnError.code === 'ENOENT'
            ? 'jmarkdown not found on PATH'
            : String(spawnError.message ?? spawnError))
        : 'the jmarkdown preview server did not start',
    };
  }
  return { port };
}

/**
 * Register the `jmarkdown:watch:*` IPC handlers. Call once at app startup.
 */
export function registerJmarkdownWatchHandlers() {
  ipcMain.handle('jmarkdown:watch:start', (event, payload) =>
    startWatcher(event.sender.id, String(payload?.path ?? ''))
  );
  ipcMain.handle('jmarkdown:watch:stop', (event) => {
    killWatcher(event.sender.id);
    return { ok: true };
  });
}

/** Reap a specific window's watcher — called from a window's `closed`. */
export function stopJmarkdownWatch(wcId) {
  killWatcher(wcId);
}

/** The live watch server port for window `wcId`, or null if it has no watcher.
 *  (The pop-out reads it to decide whether there is anything to detach.) */
export function watcherPort(wcId) {
  const entry = watchers.get(wcId);
  return entry ? entry.port : null;
}

/** Transfer a window's watcher to a different window (the pop-out): the watch
 *  process now lives and dies with `newWcId`, not the editor window. Returns
 *  the port (so the caller can load the URL), or null if there was no watcher. */
export function transferWatcherTo(fromWcId, newWcId) {
  const entry = watchers.get(fromWcId);
  if (!entry) return null;
  watchers.delete(fromWcId);
  watchers.set(newWcId, entry);
  return entry.port;
}

/** Reap every watcher — called on app quit. */
export function reapJmarkdownWatchers() {
  for (const wcId of [...watchers.keys()]) killWatcher(wcId);
}

/** For tests — the webContents ids with a live watcher. */
export function activeWatchers() {
  return [...watchers.keys()];
}
