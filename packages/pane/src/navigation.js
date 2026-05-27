/**
 * @file Spatial pane navigation.
 *
 * Given a map of pane ids to their laid-out rects (as produced by
 * `computeRects`) and the id of the currently focused pane, pick the
 * adjacent pane in a given direction. Adjacency is geometric: the
 * returned pane's bounding rect must touch the current pane's bounding
 * rect along the requested edge.
 *
 * When several panes touch the same edge (e.g. two stacked panes both
 * touch the right edge of a tall left pane), the candidate whose
 * perpendicular centerline is closest to the current pane's
 * perpendicular centerline wins. That mirrors Emacs's `windmove`
 * heuristic and matches what users expect: moving right from a tall
 * pane that abuts a vertically split pair lands you in the upper or
 * lower of the two depending on where the cursor pane's vertical centre
 * is.
 *
 * Returns `null` when no neighbour exists in the given direction (e.g.
 * the focused pane is already on the right edge and the direction is
 * `'right'`).
 */

/** A laid-out rectangle, as produced by `computeRects`. */
/** @typedef {{ left: number, top: number, width: number, height: number }} Rect */

const TOLERANCE = 1; // pixels; rounding slop on the shared edge.

/**
 * Return the id of the adjacent pane in DIRECTION, or `null` when there
 * is no neighbour on that side.
 *
 * @param {Map<string, Rect>} rects - The laid-out leaf rects, as
 *   produced by `computeRects(rootPane, hostRect)`.
 * @param {string} currentId - The id of the focused pane.
 * @param {'left' | 'right' | 'up' | 'down'} direction
 * @returns {string | null}
 */
export function paneInDirection(rects, currentId, direction) {
  const current = rects.get(currentId);
  if (!current) return null;
  if (
    direction !== 'left' &&
    direction !== 'right' &&
    direction !== 'up' &&
    direction !== 'down'
  ) {
    return null;
  }

  /** Right edge of A == left edge of B (within tolerance), and their
   *  vertical extents overlap by at least one pixel. */
  const horizAdjacent = (a, b) =>
    Math.abs(a.left + a.width - b.left) <= TOLERANCE &&
    Math.min(a.top + a.height, b.top + b.height) > Math.max(a.top, b.top);

  const vertAdjacent = (a, b) =>
    Math.abs(a.top + a.height - b.top) <= TOLERANCE &&
    Math.min(a.left + a.width, b.left + b.width) > Math.max(a.left, b.left);

  const candidates = [];
  for (const [id, rect] of rects) {
    if (id === currentId) continue;
    if (direction === 'right' && horizAdjacent(current, rect)) {
      candidates.push({ id, rect });
    } else if (direction === 'left' && horizAdjacent(rect, current)) {
      candidates.push({ id, rect });
    } else if (direction === 'down' && vertAdjacent(current, rect)) {
      candidates.push({ id, rect });
    } else if (direction === 'up' && vertAdjacent(rect, current)) {
      candidates.push({ id, rect });
    }
  }

  if (candidates.length === 0) return null;

  // Pick the candidate whose perpendicular centre is closest to ours.
  const isHorizontalMove = direction === 'left' || direction === 'right';
  const currentCentre = isHorizontalMove
    ? current.top + current.height / 2
    : current.left + current.width / 2;

  let best = candidates[0];
  let bestDistance = Infinity;
  for (const c of candidates) {
    const candidateCentre = isHorizontalMove
      ? c.rect.top + c.rect.height / 2
      : c.rect.left + c.rect.width / 2;
    const distance = Math.abs(currentCentre - candidateCentre);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = c;
    }
  }
  return best.id;
}
