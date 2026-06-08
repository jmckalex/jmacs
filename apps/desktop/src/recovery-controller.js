/**
 * @file The renderer-side autosave / crash-recovery controller — the
 * write side of §4c.
 *
 * Mirrors `session.js`'s `createSession`: a debounced `save()` plus an
 * immediate `flush()` over the host's recovery IPC, so the rest of the
 * app just signals "something changed" and lets the controller pace the
 * writes. Where the session controller persists *structure* (the pane
 * tree + file paths), this persists *content* — a full-text snapshot of
 * every dirty buffer, so a crash with unsaved edits can be recovered on
 * the next launch.
 *
 * Snapshots are written to `<userData>/recovery/` by the main process
 * (see recovery.js + the files.js handlers). Each is keyed per buffer:
 * a file-backed buffer by `file:<absPath>` (so the same file overwrites
 * one snapshot across sessions), a path-less buffer by an in-session
 * `buf:<n>`. The key is cached per buffer (a WeakMap) so it never
 * changes mid-life — `forget()` on save deletes the exact file that was
 * written, even for a buffer that has since gained a path.
 *
 * The host bridge and clock are injected so the controller is unit-
 * testable without Electron.
 */

import { hashText } from './recovery.js';

/** A buffer's stable recovery key: `file:<path>` for a file-backed
 *  buffer, `buf:<n>` for a path-less one. Cached on first use. */
function makeKeyer() {
  const keys = new WeakMap();
  let counter = 0;
  return (buffer) => {
    let key = keys.get(buffer);
    if (key === undefined) {
      const path =
        typeof buffer.filePath === 'string' && buffer.filePath !== ''
          ? buffer.filePath
          : null;
      key = path ? `file:${path}` : `buf:${(counter += 1)}`;
      keys.set(buffer, key);
    }
    return key;
  };
}

/**
 * Build the renderer recovery controller.
 *
 * @param {object} options
 * @param {() => Iterable<*>} options.getDirtyBuffers - Returns the live
 *   set of buffers with unsaved edits (e.g. `() => dirtyBuffers`).
 * @param {{
 *   writeRecovery: (record: object) => Promise<*>,
 *   deleteRecovery: (key: string) => Promise<*>,
 *   clearRecovery: () => Promise<*>,
 * }} options.host - The recovery IPC bridge (usually `window.host`).
 * @param {() => number} [options.now] - Clock for the snapshot timestamp;
 *   defaults to `Date.now`. Injected for tests.
 * @param {number} [options.debounceMs=1000] - Autosave debounce.
 * @returns {{
 *   save: () => void,
 *   flush: () => Promise<void>,
 *   forget: (buffer: *) => Promise<void>,
 *   clear: () => Promise<void>,
 * }}
 */
export function createRecovery({
  getDirtyBuffers,
  host,
  now = () => Date.now(),
  debounceMs = 1000,
}) {
  const keyFor = makeKeyer();
  let timer = null;

  /** The recovery record for one buffer. */
  function recordFor(buffer) {
    const text = typeof buffer.text === 'string' ? buffer.text : '';
    const path =
      typeof buffer.filePath === 'string' && buffer.filePath !== ''
        ? buffer.filePath
        : null;
    return {
      key: keyFor(buffer),
      path,
      name: typeof buffer.name === 'string' ? buffer.name : '',
      text,
      savedAt: now(),
      hash: hashText(text),
    };
  }

  /** Snapshot every dirty buffer. Per-buffer failures are non-fatal —
   *  the next tick (or flush) retries. */
  async function writeAll() {
    timer = null;
    for (const buffer of [...getDirtyBuffers()]) {
      try {
        await host.writeRecovery(recordFor(buffer));
      } catch {
        // A failed snapshot write must never break editing.
      }
    }
  }

  /** Schedule a debounced snapshot of all dirty buffers. */
  function save() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(writeAll, debounceMs);
  }

  /** Snapshot all dirty buffers now (on blur / before a reload). */
  async function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await writeAll();
  }

  /** Drop one buffer's snapshot (on a successful save). `keyFor` returns
   *  the cached key, so this deletes the exact file written even for a
   *  buffer that has since gained or changed its path. For a buffer that
   *  was never snapshotted, deleting its would-be file is harmless. */
  async function forget(buffer) {
    try {
      await host.deleteRecovery(keyFor(buffer));
    } catch {
      // Non-fatal: a leftover snapshot is offered (and cleaned) at startup.
    }
  }

  /** Remove every snapshot (on a clean confirmed quit — no crash, so
   *  nothing to recover). Cancels any pending debounced write first. */
  async function clear() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      await host.clearRecovery();
    } catch {
      // Non-fatal.
    }
  }

  return { save, flush, forget, clear };
}
