/**
 * @file Detect when a file changed on disk behind the editor's back.
 *
 * The danger: you open `thesis.md`, another program (a `git merge`, a
 * formatter, a second editor) rewrites it on disk, and then you save —
 * silently clobbering that external change with your now-stale buffer.
 *
 * The guard: the editor records a file's `(mtimeMs, size)` each time it
 * reads or writes the file. Before overwriting on save, it compares the
 * current on-disk stat against that record. A mismatch means the file
 * changed underneath us, so the save is held for the user to resolve
 * (overwrite, or keep editing and reload) instead of blindly written.
 *
 * `(mtimeMs, size)` is a deliberately cheap signal — not a content hash.
 * It can theoretically miss a same-size edit that preserves mtime, but in
 * practice any real external write moves one or both, and the cost is a
 * single `stat`, not a full re-read on every save.
 *
 * The tracker is pure I/O with an injectable `statFn`, so the
 * decision logic is testable without touching a real filesystem.
 */

import { stat } from 'node:fs/promises';

/**
 * @typedef {object} ChangeTracker
 * @property {(path: string) => Promise<void>} note - Record a path's
 *   current on-disk stat as the known-good baseline (call after a read or
 *   a successful write). A path that cannot be stat'd is forgotten.
 * @property {(path: string) => void} forget - Drop a path's baseline.
 * @property {(path: string) => Promise<boolean>} changedSinceNoted -
 *   Whether the file at `path` differs on disk from its recorded baseline.
 */

/**
 * Create a change tracker.
 *
 * @param {{ statFn?: (path: string) => Promise<{mtimeMs: number, size: number}> }} [options]
 * @returns {ChangeTracker}
 */
export function createChangeTracker({ statFn = stat } = {}) {
  /** @type {Map<string, { mtimeMs: number, size: number }>} */
  const known = new Map();

  async function note(path) {
    try {
      const s = await statFn(path);
      known.set(path, { mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      // The file is gone or unreadable; drop any stale baseline so a
      // later recreate-then-save isn't wrongly flagged as a conflict.
      known.delete(path);
    }
  }

  function forget(path) {
    known.delete(path);
  }

  async function changedSinceNoted(path) {
    const prev = known.get(path);
    // No baseline → not a conflict. A first save or a save-as onto a path
    // we never read is the user's explicit choice, not a silent clobber.
    if (prev === undefined) return false;
    let s;
    try {
      s = await statFn(path);
    } catch {
      // The file no longer exists on disk: saving recreates it, which is
      // not a clobber of an external change.
      return false;
    }
    return s.mtimeMs !== prev.mtimeMs || s.size !== prev.size;
  }

  return { note, forget, changedSinceNoted };
}
