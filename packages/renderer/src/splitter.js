/**
 * @file A drag-resizable splitter — a thin hit area between two panels
 * that, on pointer drag, writes a CSS custom property on the document
 * root. The caller's stylesheet references the variable to size the
 * resizable side; everything else (clamping, persistence) is the
 * splitter's business.
 *
 * The splitter is layout-agnostic: it does not know whether the panel
 * it sizes lives in a grid track, a flex item, or something else. All
 * it knows is the CSS variable and the desired range — keeping the
 * coupling to the surrounding layout to a single string.
 */

/**
 * Create a splitter on `element`.
 *
 * On pointer-down inside `element`, the splitter captures the pointer,
 * and on each subsequent pointer-move computes a new size from the
 * pointer's coordinates relative to `target`. The size is clamped to
 * [`min`, `max`] (where `max` is either a number or a function that
 * returns one — useful when the upper bound depends on the surrounding
 * geometry), and written to the document root as `cssVar`'s value
 * (with a `px` unit). When the drag ends, `onResize` fires with the
 * final value so the caller can persist it.
 *
 * For a horizontal splitter (`orientation: 'horizontal'`) the size
 * tracked is the width of the panel to the right of `element`, sourced
 * from `target.getBoundingClientRect().right - event.clientX`. For a
 * vertical splitter the height of the panel below `element` is
 * tracked, sourced from `target.getBoundingClientRect().bottom -
 * event.clientY`.
 *
 * @param {object} options
 * @param {'horizontal' | 'vertical'} options.orientation
 * @param {HTMLElement} options.element - The splitter DOM node; the
 *   pointer handlers are attached here.
 * @param {HTMLElement} options.target - The element whose geometry the
 *   new size is measured against. Typically the workspace (for the
 *   horizontal splitter) or the document/viewport host (for the
 *   vertical one).
 * @param {string} options.cssVar - The CSS custom property the splitter
 *   sets on the document root (must start with `--`).
 * @param {number} options.min - The lowest size in pixels.
 * @param {number | (() => number)} options.max - The highest size in
 *   pixels, or a function returning it (recomputed on each move so the
 *   bound can depend on live viewport / target geometry).
 * @param {(value: number) => void} [options.onResize] - Called once
 *   with the final size after the drag ends.
 * @returns {{
 *   element: HTMLElement,
 *   set: (value: number) => number,
 *   destroy: () => void,
 * }}
 */
export function createSplitter(options) {
  const {
    orientation,
    element,
    target,
    cssVar,
    min,
    onResize,
  } = options;
  if (orientation !== 'horizontal' && orientation !== 'vertical') {
    throw new Error(`splitter: bad orientation: ${orientation}`);
  }
  if (typeof cssVar !== 'string' || !cssVar.startsWith('--')) {
    throw new Error(`splitter: cssVar must start with "--", got ${cssVar}`);
  }

  const doc = element.ownerDocument ?? globalThis.document;
  const root = doc?.documentElement ?? null;

  /** Resolve the current maximum size in px. */
  function currentMax() {
    return typeof options.max === 'function' ? options.max() : options.max;
  }

  /** Clamp `value` into [min, max]. */
  function clamp(value) {
    const upper = currentMax();
    if (value < min) return min;
    if (value > upper) return upper;
    return value;
  }

  /** Write `value` (already clamped) to the CSS variable. */
  function writeVar(value) {
    if (root && root.style && typeof root.style.setProperty === 'function') {
      root.style.setProperty(cssVar, `${value}px`);
    }
  }

  /**
   * Set the splitter's size programmatically. Returns the actual value
   * written (after clamping), so callers restoring from storage can see
   * what was applied.
   *
   * @param {number} value
   * @returns {number}
   */
  function set(value) {
    const clamped = clamp(value);
    writeVar(clamped);
    return clamped;
  }

  /** Compute the new size for a pointer event. */
  function sizeFromEvent(event) {
    const rect = target.getBoundingClientRect();
    return orientation === 'horizontal'
      ? rect.right - event.clientX
      : rect.bottom - event.clientY;
  }

  /** The most recent value committed during the live drag. */
  let dragValue = null;
  /** The active pointer id, or null when no drag is in progress. */
  let activePointer = null;

  function onPointerMove(event) {
    if (activePointer === null || event.pointerId !== activePointer) return;
    const raw = sizeFromEvent(event);
    if (!Number.isFinite(raw)) return;
    dragValue = clamp(raw);
    writeVar(dragValue);
    event.preventDefault();
  }

  function onPointerUp(event) {
    if (activePointer === null || event.pointerId !== activePointer) return;
    const id = activePointer;
    activePointer = null;
    try {
      if (typeof element.releasePointerCapture === 'function') {
        element.releasePointerCapture(id);
      }
    } catch {
      // Pointer may already have been released — that is fine.
    }
    element.removeEventListener('pointermove', onPointerMove);
    element.removeEventListener('pointerup', onPointerUp);
    element.removeEventListener('pointercancel', onPointerUp);
    if (dragValue !== null && typeof onResize === 'function') {
      onResize(dragValue);
    }
    dragValue = null;
  }

  function onPointerDown(event) {
    // Primary button only — secondary clicks must not start a drag.
    if (event.button !== undefined && event.button !== 0) return;
    activePointer = event.pointerId ?? 1;
    dragValue = null;
    try {
      if (typeof element.setPointerCapture === 'function') {
        element.setPointerCapture(activePointer);
      }
    } catch {
      // Some test environments don't support pointer capture — we
      // still want the rest of the drag handling to work.
    }
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
    event.preventDefault();
  }

  element.addEventListener('pointerdown', onPointerDown);

  /** Remove the splitter's listeners — used when the host is torn down. */
  function destroy() {
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointermove', onPointerMove);
    element.removeEventListener('pointerup', onPointerUp);
    element.removeEventListener('pointercancel', onPointerUp);
    activePointer = null;
  }

  return { element, set, destroy };
}
