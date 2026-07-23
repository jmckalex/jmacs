/**
 * @file Per-buffer viewport memory — Emacs's window-start, factored out of
 * `view.js` so it is unit-testable without the inner editor's real-DOM
 * machinery (the follow-cursor.js precedent).
 *
 * One editor instance can show many buffers over its lifetime: the server
 * tabline shows every tab through one shared element, `C-x b` swaps buffers
 * in place, and a pane-focus change swaps a leaf between its static buffer
 * and the live mirror. The element's `scrollTop` is shared state across all
 * of them — switching to a short buffer clamps it to 0, and without a
 * memory the long buffer comes back at the top of the file.
 *
 * The memory is keyed by the buffer's *stable identity*, not the object:
 * server mirrors are REBUILT on every switch (a SNAPSHOT makes a fresh
 * ClientBuffer), so object identity never matches across a round trip. The
 * server-assigned buffer `id` is preferred; a plain L2 buffer (tests, local
 * paths) falls back to its `name`. A buffer with neither is not remembered.
 */

/**
 * Create a scroll memory. One per editor-view instance, so the recall is
 * per (editor instance x buffer) — exactly Emacs's per (window x buffer)
 * window-start.
 *
 * @returns {{
 *   save: (buffer: *, scrollTop: number) => void,
 *   saved: (buffer: *) => number | null,
 * }}
 */
export function createScrollMemory() {
  /** @type {Map<string, number>} */
  const memory = new Map();

  /** The stable identity to remember BUFFER by, or null for "don't". */
  function keyOf(buffer) {
    if (!buffer) return null;
    if (typeof buffer.id === 'string' && buffer.id) return `id:${buffer.id}`;
    if (typeof buffer.name === 'string' && buffer.name) return `name:${buffer.name}`;
    return null;
  }

  return {
    /** Record BUFFER's viewport position (called when switching away). */
    save(buffer, scrollTop) {
      const key = keyOf(buffer);
      if (key !== null && Number.isFinite(scrollTop)) memory.set(key, scrollTop);
    },

    /** The remembered viewport position for BUFFER, or null when it has
     *  never been shown here (first visit → the caller follows the caret
     *  as before). `0` is a real memory — a buffer left at the top comes
     *  back at the top. */
    saved(buffer) {
      const key = keyOf(buffer);
      const value = key !== null ? memory.get(key) : undefined;
      return typeof value === 'number' ? value : null;
    },
  };
}
