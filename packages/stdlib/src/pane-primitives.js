/**
 * @file Pane primitives — the Lisp surface for addressing panes.
 *
 * Phase 2 of plans/PANES.md introduces the pane abstraction: a
 * rectangular tile in the editor area that holds one view. With one
 * pane this phase the primitives are nearly trivial; the surface is
 * worth shipping anyway so phase 3's split commands have a place to
 * compose against.
 *
 * The host (the desktop app) supplies a `paneHost` shape with:
 *
 *   - `currentPane()` — the focused pane handle (a leaf), or null.
 *
 * `(current-view)`, defined in view-primitives.js, now resolves
 * through `(current-pane)` → `pane.view`. The two-step resolution is
 * identical to the one-step "look up the focused view" with one leaf,
 * but it's the right path once splits arrive: a view is "current" by
 * virtue of being in the focused pane, not by being top of a list.
 *
 * Per Q15, pane-creating commands return handles. None of the
 * primitives here construct panes — phase 3 lands the split
 * constructors — so the only handle that flows out is the focused
 * pane (or `nil` when nothing is focused).
 */

import { NIL } from '@editor/lisp';

/**
 * Build the pane primitives for a pane-host.
 *
 * @param {PaneHost} paneHost
 * @returns {Record<string, (args: *[]) => *>}
 */
export function createPanePrimitives(paneHost) {
  return {
    // `(current-pane)` — the focused leaf pane's handle. `nil` when no
    // pane has focus (vanishingly rare; the editor area always has at
    // least one leaf).
    'current-pane': () => {
      const pane = paneHost.currentPane();
      return pane ?? NIL;
    },
    // `(pane-kind pane)` — the pane's kind as a string. Either `"leaf"`
    // or `"split"` for a well-formed handle.
    'pane-kind': (args) => {
      const pane = args[0];
      if (pane === null || pane === undefined || pane === NIL) return NIL;
      if (typeof pane !== 'object') return NIL;
      return typeof pane.kind === 'string' ? pane.kind : NIL;
    },
    // `(pane-view pane)` — the view a leaf pane holds, or `nil` for a
    // split pane (which holds no view directly) or a malformed handle.
    'pane-view': (args) => {
      const pane = args[0];
      if (pane === null || pane === undefined || pane === NIL) return NIL;
      if (typeof pane !== 'object') return NIL;
      if (pane.kind !== 'leaf') return NIL;
      return pane.view ?? NIL;
    },
  };
}

/**
 * @typedef {import('@editor/pane').Pane} Pane
 *
 * @typedef {object} PaneHost
 * @property {() => (Pane | null)} currentPane - The currently-focused
 *   pane handle (a leaf), or null.
 */
