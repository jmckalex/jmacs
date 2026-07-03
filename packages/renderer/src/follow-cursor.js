/**
 * @file The editor's follow-the-caret decision, factored out of `view.js` so
 * it can be unit-tested without the inner editor's real-DOM machinery (there
 * is no jsdom in this repo; the surrounding scroll plumbing is exercised live
 * / by the smoke arm).
 *
 * The rule, straight from `view.js`'s long-standing comment: a render keeps
 * the caret on screen only when the caret *may have moved*. A render that
 * merely repaints — an overlay refresh, a redundant server view/cursor
 * reconcile, a status tick, a mode toggle — must NOT scroll the caret into
 * view: doing so yanks a viewport the user deliberately scrolled away from
 * back to the caret's line (the "autosave scrolls my editor" bug). Because
 * `scrollIntoView({block:'nearest'})` is already a no-op when the caret is on
 * screen, the *only* observable effect of an over-eager follow is exactly that
 * unwanted yank — so gating it is safe.
 *
 * The tracker distinguishes three follow triggers:
 *   - a REAL text edit (`forceOnce()`), which follows unconditionally — Emacs
 *     keeps the caret visible on self-insert / delete even when the edit did
 *     not advance the offset (e.g. forward-delete);
 *   - a switch / reveal to another view (`forceOnce()` likewise), whose caret
 *     may sit at the same numeric offset yet be off-screen;
 *   - anything else, which follows only when the caret's offset ACTUALLY
 *     changed since the last follow.
 */

/**
 * Create a follow-the-caret tracker. Stateful (it remembers the last offset it
 * followed to and a one-shot force flag); one per editor-view instance.
 *
 * @returns {{
 *   forceOnce: () => void,
 *   shouldScroll: (point: number) => boolean,
 *   recentered: (point: number) => void,
 * }}
 */
export function createFollowTracker() {
  // The caret offset the viewport last followed to. `-1` never equals a real
  // offset, so the first follow always scrolls.
  let lastFollowedPoint = -1;
  // A one-shot: the next follow scrolls regardless of offset. Set by a real
  // edit or a switch/reveal; cleared the next time a follow is considered.
  let forceNext = false;

  return {
    /** Force the next follow to scroll regardless of offset (a real edit, or a
     *  switch / reveal). */
    forceOnce() {
      forceNext = true;
    },

    /**
     * Whether a follow render whose caret is at `point` should scroll it into
     * view, and record `point` as the last followed offset (so an immediately
     * following repaint at the same offset is a no-op). A non-finite offset is
     * treated as "no scroll" and does not disturb the recorded offset.
     *
     * @param {number} point - The caret's current offset.
     * @returns {boolean}
     */
    shouldScroll(point) {
      if (!Number.isFinite(point)) return false;
      const scroll = forceNext || point !== lastFollowedPoint;
      forceNext = false;
      lastFollowedPoint = point;
      return scroll;
    },

    /**
     * Sync the tracker after a recenter (C-l), which always scrolls on its own:
     * record the offset and drop any pending force so the next plain repaint at
     * that offset stays put.
     *
     * @param {number} point - The caret's offset after the recenter.
     */
    recentered(point) {
      forceNext = false;
      if (Number.isFinite(point)) lastFollowedPoint = point;
    },
  };
}
