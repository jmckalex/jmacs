/**
 * @file Window-geometry reconciliation for session restore (Model B).
 *
 * A saved session records each window's frame (`bounds`) plus the display it
 * sat on (`display.workArea`). On restore the display configuration may have
 * changed — an external monitor unplugged, a different resolution, a move from
 * desk to laptop. `reconcileBounds` maps a saved frame onto the *current*
 * displays:
 *
 *   - **Unchanged config** (the saved display is still present and the frame
 *     still fits it) → return the frame verbatim (clamped to sane bounds). The
 *     common case is pixel-perfect.
 *   - **Changed config** → RESCALE: express the saved frame as fractions of its
 *     saved work-area, then map those fractions onto a chosen current display's
 *     work-area. This preserves the window's *relative size and position*, the
 *     architect's "rescaling of the unachievable configuration."
 *
 * Pane proportions need no help here — the pane model stores splits as
 * fractional ratios, so they re-derive correctly at whatever size the window
 * lands (see pane-model.js). This module only handles the window FRAME.
 *
 * Pure + DOM/Electron-free (it takes plain display descriptors, the shape of
 * Electron's `screen.getAllDisplays()` entries), so it is unit-testable under
 * `node --test` (window-geometry.test.js). The main process builds the
 * descriptors from `screen` and applies the result to a `BrowserWindow`.
 */

/**
 * @typedef {object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 *
 * @typedef {object} DisplayDescriptor
 * @property {number} id - The display's stable id (Electron `display.id`).
 * @property {Rect} workArea - The usable area (minus menu bar / dock).
 * @property {number} [scaleFactor]
 *
 * @typedef {object} SavedGeometry
 * @property {Rect} bounds - The window frame at save time.
 * @property {DisplayDescriptor} display - The display it sat on at save time.
 */

const DEFAULT_MIN_WIDTH = 480;
const DEFAULT_MIN_HEIGHT = 520;
const CASCADE_STEP = 24;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Is rect B fully inside work-area WA? */
function fullyContained(b, wa) {
  return (
    b.x >= wa.x &&
    b.y >= wa.y &&
    b.x + b.width <= wa.x + wa.width &&
    b.y + b.height <= wa.y + wa.height
  );
}

/** The overlap area (px²) between rect B and work-area WA (0 when disjoint). */
function overlapArea(b, wa) {
  const ix = Math.max(0, Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x));
  const iy = Math.max(0, Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y));
  return ix * iy;
}

/** Round a rect's fields to whole pixels. */
function roundRect(r) {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

/**
 * Clamp a frame to sit fully within WORKAREA, honouring the minimum size. Width
 * and height are capped at the work-area; the origin is then nudged so the whole
 * frame is on-screen. A CASCADE offset (for several windows landing on the same
 * display) is applied before the final clamp so stacked windows don't overlap
 * perfectly.
 */
function clampOnto(frame, workArea, { minWidth, minHeight, cascade }) {
  const width = clamp(frame.width, minWidth, workArea.width);
  const height = clamp(frame.height, minHeight, workArea.height);
  const off = (cascade || 0) * CASCADE_STEP;
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;
  const x = clamp(frame.x + off, workArea.x, Math.max(workArea.x, maxX));
  const y = clamp(frame.y + off, workArea.y, Math.max(workArea.y, maxY));
  return roundRect({ x, y, width, height });
}

/** Pick the current display to land the window on: the same id if present, else
 *  the one whose work-area most overlaps the saved frame, else the first. */
function pickTarget(saved, currentDisplays) {
  const byId = currentDisplays.find((d) => d.id === saved.display?.id);
  if (byId) return byId;
  let best = null;
  let bestArea = -1;
  for (const d of currentDisplays) {
    const a = overlapArea(saved.bounds, d.workArea);
    if (a > bestArea) { bestArea = a; best = d; }
  }
  return best ?? currentDisplays[0];
}

/**
 * Reconcile a saved window frame against the current display configuration.
 *
 * @param {SavedGeometry} saved - The window's saved bounds + display.
 * @param {DisplayDescriptor[]} currentDisplays - `screen.getAllDisplays()`-shaped.
 * @param {{minWidth?: number, minHeight?: number, cascade?: number}} [opts]
 *   `cascade` offsets the result (×24px) so several restored windows landing on
 *   the same display don't stack perfectly.
 * @returns {Rect|null} The reconciled frame, or null when there's nothing usable
 *   to reconcile (the caller should fall back to a default-placed window).
 */
export function reconcileBounds(saved, currentDisplays, opts = {}) {
  const minWidth = Number.isFinite(opts.minWidth) ? opts.minWidth : DEFAULT_MIN_WIDTH;
  const minHeight = Number.isFinite(opts.minHeight) ? opts.minHeight : DEFAULT_MIN_HEIGHT;
  const cascade = Number.isFinite(opts.cascade) ? opts.cascade : 0;
  if (!saved || !saved.bounds || !Array.isArray(currentDisplays) || currentDisplays.length === 0) {
    return null;
  }
  const b = saved.bounds;
  if (![b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))) return null;

  const settings = { minWidth, minHeight, cascade };
  const savedWA = saved.display?.workArea;

  // Unchanged config: the saved display still exists AND the frame still fits it
  // → keep the exact frame (only a safety clamp + any cascade offset).
  const idMatch = currentDisplays.find((d) => d.id === saved.display?.id);
  if (idMatch && fullyContained(b, idMatch.workArea)) {
    return clampOnto(b, idMatch.workArea, settings);
  }

  // Changed config: rescale the frame's RELATIVE size + position from its saved
  // work-area onto the chosen target's work-area.
  const target = pickTarget(saved, currentDisplays);
  const tWA = target.workArea;
  if (!savedWA || !(savedWA.width > 0) || !(savedWA.height > 0)) {
    // No usable saved work-area to take fractions from — centre a sanely-sized
    // window on the target instead of guessing.
    const width = clamp(b.width, minWidth, tWA.width);
    const height = clamp(b.height, minHeight, tWA.height);
    return clampOnto(
      { x: tWA.x + (tWA.width - width) / 2, y: tWA.y + (tWA.height - height) / 2, width, height },
      tWA,
      settings
    );
  }
  const fw = clamp(b.width / savedWA.width, 0, 1);
  const fh = clamp(b.height / savedWA.height, 0, 1);
  const fx = (b.x - savedWA.x) / savedWA.width;
  const fy = (b.y - savedWA.y) / savedWA.height;
  const frame = {
    width: fw * tWA.width,
    height: fh * tWA.height,
    x: tWA.x + fx * tWA.width,
    y: tWA.y + fy * tWA.height,
  };
  return clampOnto(frame, tWA, settings);
}
