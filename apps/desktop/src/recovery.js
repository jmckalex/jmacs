/**
 * @file Crash-recovery snapshot files — the electron-free core.
 *
 * The host writes one snapshot per dirty buffer into
 * `<userData>/recovery/`, holding the buffer's full current text plus
 * enough to identify it on the next launch (its source path, its name, a
 * save timestamp, and a content hash). On startup the recovery dir is
 * scanned: a snapshot newer than its on-disk file — or with no on-disk
 * file at all (an unsaved, path-less buffer) — is offered back to the
 * user. A snapshot is deleted when its buffer is saved, and the whole
 * dir is cleared on a clean confirmed quit; it is never deleted on a
 * crash, which is the whole point.
 *
 * These are the pure pieces — the filename mapping and the record shape
 * — factored out (no Electron import) so they can be unit-tested. The
 * IPC handlers in `files.js` (which need `app.getPath`) and the
 * renderer-side autosave controller build on them.
 */

/** The subdirectory of userData that holds recovery snapshots. */
export const RECOVERY_DIR_NAME = 'recovery';

/**
 * A small, stable djb2 hash (base36) of a string. Used to keep a
 * recovery filename unique when two keys sanitise alike, and by the
 * renderer controller as a snapshot's content hash.
 *
 * @param {string} text
 * @returns {string}
 */
export function hashText(text) {
  const str = String(text);
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Map an opaque recovery key (a buffer's stable identity — its absolute
 * path, or an id for a path-less buffer) to a safe, collision-resistant
 * single-segment filename. The readable part is a sanitised, length-
 * capped slug; a hash of the full key is appended so two distinct keys
 * never share a file even if their slugs coincide.
 *
 * @param {string} key
 * @returns {string} e.g. `_Users_me_notes.txt-1a2b3c.json`
 */
export function recoveryFileName(key) {
  const str = String(key);
  const slug = str.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
  return `${slug}-${hashText(str)}.json`;
}

/**
 * Validate a parsed recovery record. A usable record has a non-empty
 * string `key` and a string `text`; the rest is normalised with sane
 * defaults. Returns null when the input can't be a recovery snapshot, so
 * a stray or corrupt file in the recovery dir is simply skipped rather
 * than breaking the scan.
 *
 * @param {unknown} raw
 * @returns {{key: string, path: string|null, name: string, text: string,
 *   savedAt: number, hash: string} | null}
 */
export function parseRecoveryRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.key !== 'string' || raw.key === '') return null;
  if (typeof raw.text !== 'string') return null;
  return {
    key: raw.key,
    path: typeof raw.path === 'string' && raw.path !== '' ? raw.path : null,
    name: typeof raw.name === 'string' ? raw.name : '',
    text: raw.text,
    savedAt: Number.isFinite(raw.savedAt) ? Number(raw.savedAt) : 0,
    hash: typeof raw.hash === 'string' ? raw.hash : '',
  };
}
