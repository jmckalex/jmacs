/**
 * @file Pure predicate for the in-renderer global key-router's server-mode
 * stand-down. Behind `GODOT_SERVER=1` (Model B) a real `<text-view>` mounts
 * as a self-contained overlay and routes every keystroke to the server's
 * keymap; the server owns dispatch. The legacy window-level global router
 * (app.js) still listens, and historically only stood down when a deeper
 * listener had already `preventDefault`'d the key — a focus-dependent guard.
 * When DOM focus drifts to <body> (after a minibuffer/picker closes, a
 * programmatic refocus, a DOM rebuild) the overlay's keydown listener never
 * fires, so the global router runs too: the same `C-/` undo is dispatched
 * server-side AND re-run against the idle in-renderer buffer (ringing its
 * bell on an empty buffer). This predicate makes the stand-down explicit and
 * focus-independent: in server-mode, once the server view is mounted, the
 * global router defers unconditionally — the server is the sole dispatcher.
 *
 * Kept dependency-free for direct unit testing.
 */

/**
 * Whether the in-renderer global key-router should defer (stand down and
 * route nothing) for the current keystroke.
 *
 * The router defers precisely when Model B owns dispatch: server-mode is on
 * AND the server-driven view is mounted. The flag-off path (the shipping
 * default) never defers — `serverMode` is false, so this is always `false`
 * and the router runs exactly as today.
 *
 * Native text-entry controls (the minibuffer/REPL/url-bar) that own their own
 * keys are handled by the router's existing `targetOwnsKeys` early-return,
 * before this predicate; the server-driven minibuffer/picker likewise routes
 * through those native inputs, so this predicate does not need to special-case
 * them.
 *
 * @param {boolean} serverMode - `window.host.serverMode` (the Model B gate;
 *   false by default).
 * @param {boolean} serverViewMounted - Whether the server-view client has a
 *   mounted view driving the window (the server owns dispatch once it does).
 * @returns {boolean} `true` if the global router should return early.
 */
export function shouldGlobalRouterDefer(serverMode, serverViewMounted) {
  return serverMode === true && serverViewMounted === true;
}
