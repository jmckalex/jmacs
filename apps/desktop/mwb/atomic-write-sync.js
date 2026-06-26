/**
 * @file Crash-safe file writing — the SYNCHRONOUS variant for the Model-B
 * server.
 *
 * This mirrors production's `apps/desktop/src/atomic-write.js` (temp file +
 * fsync + atomic rename) but with synchronous `node:fs` calls, because the
 * Model-B server applies a `save-buffer` command synchronously inside the
 * Lisp interpreter: the command body calls the `saveFile` host effect and
 * reads `{ ok }` immediately. The production writer is Promise-based and
 * would need the command to suspend on disk I/O — a needless complication
 * for a Node child that does file I/O directly.
 *
 * The crash-safety contract is identical: write to a sibling temp file (so
 * the rename stays on one filesystem and is atomic on POSIX), flush it to
 * physical storage, then rename it over the target. The destination is
 * therefore *always* either the complete old contents or the complete new
 * ones — never a torn half-write.
 *
 * Kept under `mwb/` (not added to the production module) so production stays
 * untouched per the Model-B isolation rule.
 */

import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Atomically write `content` to `target` (synchronous). The temp file is a
 * sibling of the target (same directory) so the rename stays on one
 * filesystem — a cross-device rename is not atomic and would fail with EXDEV.
 *
 * On any error the temp file is removed and the original target is left
 * untouched; the error is re-thrown so the caller can report the failed save.
 *
 * @param {string} target - Destination path.
 * @param {string} content - Data to write (UTF-8).
 * @returns {void}
 */
export function atomicWriteSync(target, content) {
  const tmp = join(
    dirname(target),
    `.${basename(target)}.tmp-${process.pid}-${Date.now()}`
  );
  let fd = null;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, String(content ?? ''), null, 'utf8');
    // Flush the data to physical storage before the rename, so a power loss
    // right after the rename can't surface an empty/partial file.
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, target);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already failing; the close error is not the interesting one.
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    throw error;
  }
}
