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
 * @param {number} [options.debounceMs=1000] - Autosave debounce (the
 *   default for `getDebounceMs`).
 * @param {() => boolean} [options.isEnabled] - Whether autosave is on
 *   (the `*autosave-recovery*` defcustom). When it returns false, no
 *   snapshots are written; `forget`/`clear` still run. Defaults to on.
 * @param {() => number} [options.getDebounceMs] - The live debounce (the
 *   `*autosave-recovery-interval*` defcustom). Read on each `save()` so a
 *   Lisp change takes effect immediately. Defaults to `debounceMs`.
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
  isEnabled = () => true,
  getDebounceMs = () => debounceMs,
}) {
  const keyFor = makeKeyer();
  let timer = null;
  // The tail of the snapshot-pass promise chain. `clear()` awaits it so it
  // never removes the recovery dir while an atomic write into that dir is
  // still mid-flight — the clear-vs-write race that left a torn `rename`
  // (ENOENT) on a clean quit. `closed` latches on `clear()`: a clean quit
  // discards snapshots, so no pass may write after it (and an in-flight
  // pass stops at its next buffer). `running` is true while a pass is
  // actually writing — it lets writeAll() run synchronously when idle
  // (so the leading-edge snapshot still hits disk in the same tick) yet
  // chain when a pass is already in flight.
  let inFlight = Promise.resolve();
  let closed = false;
  let running = false;

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

  /** Snapshot every dirty buffer once. A no-op when autosave is disabled
   *  or the controller is closed (a clean quit). Per-buffer failures are
   *  non-fatal — the next tick (or flush) retries. */
  async function snapshotDirty() {
    if (!isEnabled() || closed) return;
    running = true;
    try {
      for (const buffer of [...getDirtyBuffers()]) {
        // A clear() (clean quit) can land mid-loop: stop the moment it
        // does, so we never re-create a snapshot the quit is in the act of
        // discarding (which would resurface as a spurious *Recover* offer).
        if (closed) return;
        try {
          await host.writeRecovery(recordFor(buffer));
        } catch {
          // A failed snapshot write must never break editing.
        }
      }
    } finally {
      running = false;
    }
  }

  /** Run a snapshot pass and record it as the in-flight one (so `clear()`
   *  can await it). When idle, run synchronously — the leading-edge
   *  snapshot must reach the host in the same tick, before any crash. When
   *  a pass is already running, chain after it so passes never interleave
   *  and `clear()` only has to await this single tail. Returns that promise.
   *
   *  NB: timer management lives in save()/flush()/the trailing callback,
   *  NOT here — clearing `timer` here would clobber the timer a
   *  leading-edge save() just set, making every edit look like a new burst. */
  function writeAll() {
    inFlight = running
      ? inFlight.catch(() => {}).then(snapshotDirty)
      : snapshotDirty();
    return inFlight;
  }

  /** Note an edit. **Leading + trailing**: the first edit of a burst
   *  writes a snapshot immediately, so a crash a fraction of a second
   *  later still finds work to recover (a pure trailing debounce leaves
   *  a window where nothing is on disk yet — the gap behind the
   *  "edit, quit fast, nothing recovered" bug). Edits during the burst
   *  coalesce into one trailing write of the final state when it settles.
   *  A no-op when autosave is disabled. */
  function save() {
    if (!isEnabled() || closed) return;
    const burstStart = timer === null;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      writeAll();
    }, getDebounceMs());
    if (burstStart) writeAll();
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
   *  nothing to recover). Latches `closed` so no further (and no in-
   *  flight) snapshot pass writes after this, cancels any pending
   *  debounce, then **waits for any in-flight write to finish its atomic
   *  rename** before clearing — so `clearRecovery()`'s recursive `rm` can
   *  never delete the recovery dir out from under a live write (the
   *  quit-time ENOENT race). */
  async function clear() {
    closed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      await inFlight;
    } catch {
      // A failed in-flight write is non-fatal — we're discarding anyway.
    }
    try {
      await host.clearRecovery();
    } catch {
      // Non-fatal.
    }
  }

  return { save, flush, forget, clear };
}
