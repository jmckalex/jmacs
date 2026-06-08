/**
 * @file Crash-safe file writing.
 *
 * A bare `writeFile` truncates the destination to zero and then streams
 * the new bytes in — so a crash (or power loss) part-way through leaves
 * the user's real file truncated or half-written. `atomicWrite` instead
 * writes to a sibling temp file, flushes it to disk, and atomically
 * `rename`s it over the target: on a POSIX filesystem the rename is
 * atomic, so the destination is *always* either the complete old
 * contents or the complete new ones — never a torn in-between.
 *
 * This is the same temp-then-rename pattern `audio-metadata-write.js`
 * already uses for tag writes, factored out so the main `file:save`
 * path (and any other writer of user data) can share it — and so it can
 * be unit-tested without Electron.
 */

import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Atomically write `content` to `target`. The temp file is a sibling of
 * the target (same directory) so the rename stays on one filesystem — a
 * cross-device rename is not atomic and would fail with EXDEV.
 *
 * On any error the temp file is removed and the original target is left
 * untouched; the error is re-thrown so the caller can report the failed
 * save.
 *
 * @param {string} target - Destination path.
 * @param {string | Uint8Array} content - Data to write.
 * @param {BufferEncoding} [encoding='utf8'] - Encoding for string content
 *   (ignored when `content` is binary).
 * @returns {Promise<void>}
 */
export async function atomicWrite(target, content, encoding = 'utf8') {
  const tmp = join(
    dirname(target),
    `.${basename(target)}.tmp-${process.pid}-${Date.now()}`
  );
  let handle = null;
  try {
    handle = await open(tmp, 'w');
    await handle.writeFile(content, encoding);
    // Flush the data to physical storage before the rename, so a power
    // loss right after the rename can't surface an empty/partial file.
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, target);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Already failing; the close error is not the interesting one.
      }
    }
    try {
      await unlink(tmp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    throw error;
  }
}
