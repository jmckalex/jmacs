/**
 * @file The single-live-view invariant for the G2 server-view container.
 *
 * Model B (`GODOT_SERVER=1`) mounts ONE real `<text-view>` into a dedicated
 * container (`#godot-server-view-host`) and re-mounts it on every server-pushed
 * buffer switch (find-file / `C-x b` / `kill-buffer`): the client tears down
 * the old view, then `app.js`'s `mountServerView` builds a fresh `<text-view>`
 * for the new buffer's mirror.
 *
 * The inner editor's `destroy()` removes its OWN root element but leaves the
 * host `<text-view>` custom element behind (the wrapper's `destroy()` only
 * nulls the inner editor). So without an explicit sweep, a dead empty
 * `<text-view>` accumulates in the container on every switch and steals layout
 * from the live view (the flex column stacks them). The prototype sidestepped
 * this by re-pointing ONE persistent container element; the custom-element
 * equivalent is to clear any stale `<text-view>` before appending the new one.
 *
 * This is the dependency-free core of that sweep, so it is unit-testable under
 * `node --test` with a minimal fake host (no Electron, no real DOM). `app.js`
 * calls it from `mountServerView` with the real container.
 *
 * ‼ FLAG-OFF: this module has no top-level effects and is only imported behind
 * the server-mode gate (`app.js`'s `window.host.serverMode` block). Flag-off it
 * is never reached.
 */

/**
 * Remove (and best-effort `destroy()`) every `<text-view>` already in HOSTEL,
 * enforcing the single-live-view invariant before a fresh view is appended.
 *
 * Safe to call when the host is empty (the initial mount): it removes nothing.
 * Idempotent and order-independent — a stale element whose inner editor was
 * already destroyed by the client (the switch path always destroys first) just
 * gets a no-op `destroy()` then is unlinked.
 *
 * @param {{
 *   querySelectorAll: (selector: string) => Iterable<{
 *     destroy?: () => void,
 *     remove: () => void,
 *   }>,
 * }} hostEl
 *   The container element (the real `#godot-server-view-host`, or a fake in a
 *   test). Only `querySelectorAll` is required; each returned element needs
 *   `remove()` and may expose `destroy()`.
 * @returns {number} How many stale `<text-view>` elements were swept (0 on the
 *   initial mount). Returned for the tests + a caller that wants to log it.
 */
export function clearStaleServerViews(hostEl) {
  if (!hostEl || typeof hostEl.querySelectorAll !== 'function') return 0;
  // Snapshot to an array first: removing while iterating a live NodeList skips
  // elements (the index shifts under you).
  const stale = [...hostEl.querySelectorAll('text-view')];
  for (const el of stale) {
    try {
      if (typeof el.destroy === 'function') el.destroy();
    } catch {
      /* a half-built element may throw on destroy; remove it anyway */
    }
    try {
      el.remove();
    } catch {
      /* detached already — nothing to do */
    }
  }
  return stale.length;
}
