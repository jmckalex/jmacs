/**
 * @file Model-B SERVER-SIDE autosave + crash recovery.
 *
 * In Model B the unsaved state of every buffer lives in the server's memory
 * (the buffer registry), shared across all client windows. A server crash
 * must therefore not lose work — the data-safety requirement the shared model
 * raises (plan §7.1: a server crash kills only the server, but its buffers
 * must be recoverable). This module periodically snapshots every DIRTY buffer
 * to a recovery directory on disk, and on startup scans that directory for
 * snapshots worth recovering.
 *
 * It mirrors the real app's autosave / `*Recover*` flow (the renderer
 * `recovery-controller.js` + the `recovery:list` IPC handler in files.js),
 * but the server is a Node child, so it does the file I/O DIRECTLY — no IPC.
 * The pure pieces (the recovery filename mapping, the snapshot record shape,
 * the parse) are reused VERBATIM from production's `apps/desktop/src/
 * recovery.js`; only the disk plumbing is local here.
 *
 * The two key decisions are pure and unit-tested:
 *   - `recoveryKey(snapshot)` — a buffer's stable recovery identity: its
 *     absolute path (so re-editing the same file overwrites one snapshot)
 *     or, for a path-less buffer, a per-buffer id. This keys the file.
 *   - `selectRecoverable(records, now)` — which snapshots to offer on
 *     startup: one whose on-disk file is older than it (unsaved edits were
 *     lost) or that has no on-disk file at all (a path-less / deleted
 *     buffer). This is the exact predicate `app.js scanForRecovery` uses.
 */

import {
  readdirSync,
  readFileSync,
  statSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

import { atomicWriteSync } from './atomic-write-sync.js';
import {
  hashText,
  recoveryFileName,
  parseRecoveryRecord,
} from '../src/recovery.js';

/**
 * A buffer's stable recovery key: `file:<absPath>` for a file-backed buffer
 * (so the same file overwrites one snapshot across edit sessions), `buf:<id>`
 * for a path-less buffer. Mirrors the renderer controller's `keyFor`.
 *
 * @param {{ id: string, filePath: string|null }} snapshot
 * @returns {string}
 */
export function recoveryKey(snapshot) {
  const path = typeof snapshot.filePath === 'string' && snapshot.filePath !== ''
    ? snapshot.filePath
    : null;
  return path ? `file:${path}` : `buf:${snapshot.id}`;
}

/**
 * Build a recovery RECORD (the JSON snapshot shape) for one dirty buffer.
 * The same shape `recovery-controller.js recordFor` produces, so the
 * production `parseRecoveryRecord` validates it and the real `*Recover*`
 * view could read it unchanged.
 *
 * @param {{ id:string, name:string, filePath:string|null, text:string }} snapshot
 * @param {number} now - Timestamp (ms) to stamp as `savedAt`.
 * @returns {{ key:string, path:string|null, name:string, text:string, savedAt:number, hash:string }}
 */
export function recoveryRecord(snapshot, now) {
  const text = typeof snapshot.text === 'string' ? snapshot.text : '';
  const path = typeof snapshot.filePath === 'string' && snapshot.filePath !== ''
    ? snapshot.filePath
    : null;
  return {
    key: recoveryKey(snapshot),
    path,
    name: typeof snapshot.name === 'string' ? snapshot.name : '',
    text,
    savedAt: now,
    hash: hashText(text),
  };
}

/**
 * From recovery RECORDS (each enriched with the state of its on-disk file —
 * `diskExists` + `diskModified` ms), pick the ones worth offering on startup:
 * a snapshot whose on-disk file is older than it (unsaved edits were lost),
 * or that has no on-disk file at all (a path-less or deleted buffer). This is
 * the exact predicate `app.js scanForRecovery` applies. Pure.
 *
 * @param {Array<{text?:string, diskExists?:boolean, diskModified?:number|null, savedAt?:number}>} records
 * @returns {Array} The subset worth recovering.
 */
export function selectRecoverable(records) {
  if (!Array.isArray(records)) return [];
  return records.filter(
    (r) =>
      r &&
      typeof r.text === 'string' &&
      (!r.diskExists ||
        (typeof r.diskModified === 'number' && r.savedAt > r.diskModified))
  );
}

/**
 * Create the server-side autosave controller.
 *
 * @param {object} options
 * @param {string} options.dir - The recovery directory (absolute). One JSON
 *   file per dirty buffer is written here atomically.
 * @param {() => Array<{id:string,name:string,filePath:string|null,text:string}>} options.getDirty
 *   - Returns the live set of dirty-buffer snapshots (the spine's
 *   `dirtyBufferSnapshots()`).
 * @param {number} [options.intervalMs=4000] - The snapshot cadence.
 * @param {() => number} [options.now=Date.now] - Clock (for tests).
 * @param {(msg: string) => void} [options.log] - A logger (defaults to a
 *   no-op; the server passes console.error).
 * @returns {{ start: () => void, stop: () => void, snapshotOnce: () => number,
 *   scanRecoverable: () => Array, clear: () => void }}
 */
export function createAutosave(options) {
  const {
    dir,
    getDirty,
    intervalMs = 4000,
    now = () => Date.now(),
    log = () => {},
  } = options;

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;

  /** Ensure the recovery directory exists (created lazily, never fatal). */
  function ensureDir() {
    try {
      mkdirSync(dir, { recursive: true });
      return true;
    } catch (error) {
      log(`[mwb-autosave] could not create ${dir}: ${error.message}`);
      return false;
    }
  }

  /**
   * Snapshot every dirty buffer once. Per-buffer failures are non-fatal (the
   * next tick retries). Returns how many snapshots were written. Never
   * throws — autosave must never crash the server (the guardrail).
   *
   * @returns {number}
   */
  function snapshotOnce() {
    let written = 0;
    try {
      const dirty = getDirty();
      if (!Array.isArray(dirty) || dirty.length === 0) return 0;
      if (!ensureDir()) return 0;
      const ts = now();
      for (const snapshot of dirty) {
        try {
          const record = recoveryRecord(snapshot, ts);
          const target = join(dir, recoveryFileName(record.key));
          atomicWriteSync(target, JSON.stringify(record, null, 2));
          written += 1;
        } catch (error) {
          log(`[mwb-autosave] snapshot failed for ${snapshot.name}: ${error.message}`);
        }
      }
      if (written > 0) log(`[mwb-autosave] snapshotted ${written} dirty buffer(s)`);
    } catch (error) {
      log(`[mwb-autosave] snapshot pass failed: ${error.message}`);
    }
    return written;
  }

  /** Start the periodic snapshot timer (idempotent). */
  function start() {
    if (timer) return;
    timer = setInterval(snapshotOnce, intervalMs);
    if (typeof timer.unref === 'function') timer.unref(); // don't keep the process alive
    log(`[mwb-autosave] autosaving every ${intervalMs}ms to ${dir}`);
  }

  /** Stop the timer (idempotent). */
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /**
   * Scan the recovery directory and return the records worth recovering on
   * startup, each enriched with its on-disk file state. Corrupt / stray
   * files are skipped; a missing dir yields []. Never throws.
   *
   * @returns {Array<{key:string,path:string|null,name:string,text:string,savedAt:number,hash:string,diskExists:boolean,diskModified:number|null}>}
   */
  function scanRecoverable() {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return []; // no recovery dir yet — nothing to recover.
    }
    const records = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let record;
      try {
        const text = readFileSync(join(dir, name), 'utf8');
        record = parseRecoveryRecord(JSON.parse(text));
      } catch {
        continue; // a stray/corrupt file: skip, never fatal.
      }
      if (!record) continue;
      if (record.path) {
        try {
          const info = statSync(record.path);
          record.diskExists = true;
          record.diskModified = info.mtimeMs;
        } catch {
          record.diskExists = false;
          record.diskModified = null;
        }
      } else {
        record.diskExists = false;
        record.diskModified = null;
      }
      records.push(record);
    }
    return selectRecoverable(records);
  }

  /** Remove the whole recovery directory (a clean confirmed quit). */
  function clear() {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      log(`[mwb-autosave] clear failed: ${error.message}`);
    }
  }

  return { start, stop, snapshotOnce, scanRecoverable, clear };
}
