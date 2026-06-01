/**
 * @file Per-file companion metadata — path scheme + emptiness rule.
 *
 * Each text file may have a hidden JSON sidecar holding feature data that
 * rides alongside it: sticky notes, bookmarks, and whatever later wants a
 * per-file home. The file is `.NAME.godot-metadata` (leading dot ⇒ hidden
 * from the file browser), an extensible object keyed by feature:
 *
 *   { "version": 1, "notes": [...], "bookmarks": [...], ... }
 *
 * Each feature owns one top-level key; the writer serialises the union,
 * so sections never clobber one another. These helpers are pure (no
 * Electron, no fs) so they're unit-tested directly; files.js wraps them.
 */

import { basename, dirname, join } from 'node:path';

/** Schema version stamped into freshly written metadata files. */
export const METADATA_VERSION = 1;

/**
 * The hidden companion-metadata path for a text file.
 * `/foo/bar.txt` → `/foo/.bar.txt.godot-metadata`.
 * @param {string} filePath
 * @returns {string}
 */
export function metadataPath(filePath) {
  return join(dirname(filePath), `.${basename(filePath)}.godot-metadata`);
}

/**
 * The pre-rename companion path — a *visible* `NAME.jmacs-metadata`
 * sidecar. Read as a fallback and deleted once the new file is written,
 * to migrate existing sticky-note data.
 * @param {string} filePath
 * @returns {string}
 */
export function legacyMetadataPath(filePath) {
  return `${filePath}.jmacs-metadata`;
}

/**
 * True when DATA carries no content — every key other than `version` is
 * absent, an empty array, or an empty object. Such a file is removed
 * rather than left as a husk. Generic across sections, so a new feature
 * key needs no change here, and one feature emptying out never deletes
 * another feature's data (the bug the old notes-only check had).
 * @param {unknown} data
 * @returns {boolean}
 */
export function isEmptyMetadata(data) {
  if (data === null || typeof data !== 'object') return true;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'version') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) return false;
    } else if (value !== null && typeof value === 'object') {
      if (Object.keys(value).length > 0) return false;
    } else if (value !== undefined && value !== null) {
      return false; // a scalar non-version field counts as content
    }
  }
  return true;
}
