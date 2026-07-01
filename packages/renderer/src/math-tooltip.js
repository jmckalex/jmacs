/**
 * @file The live math tooltip for math-preview mode.
 *
 * When the cursor is inside a math construct (the segment is "revealed" so
 * its source is editable), this floats a small tooltip above the caret
 * showing the MathJax render of the current body, refreshed on every
 * keystroke. A parse error keeps the LAST VALID render on screen and raises
 * an error badge until the body typesets again; leaving the construct hides
 * it and the construct re-typesets inline (the existing reveal cycle).
 *
 * The two tricky bits — the keep-last-valid decision and the above-the-anchor
 * positioning — are pure and unit-tested. The actual SVG mount into the DOM
 * needs a live smoke test, like the rest of the math-preview renderer code.
 */

/**
 * Decide what to mount, given this render's typeset node and the last valid
 * one shown for the current construct. PURE.
 *
 *   - A non-null node renders and becomes the new last-valid.
 *   - A null node (parse error / empty body / MathJax not ready) keeps the
 *     last-valid node on screen and flags an error.
 *   - A null node with no last-valid yet shows nothing but still flags an
 *     error (e.g. a just-opened, still-empty `$$`).
 *
 * @param {object} args
 * @param {Node|null} args.node - This render's typeset node, or null.
 * @param {Node|null} args.lastValid - The last non-null node for the current
 *   construct (null right after entering a new one).
 * @returns {{ mount: Node|null, error: boolean, lastValid: Node|null }}
 */
export function chooseRender({ node, lastValid }) {
  if (node) return { mount: node, error: false, lastValid: node };
  if (lastValid) return { mount: lastValid, error: true, lastValid };
  return { mount: null, error: true, lastValid: null };
}

/**
 * Place a tooltip of size TIP centred above ANCHOR, clamped to VIEWPORT.
 * Flips to just below the anchor when there is not enough room above. PURE.
 * All measurements are viewport (client) pixels.
 *
 * @param {{left:number,top:number,right:number,bottom:number,width?:number}} anchor
 * @param {{width:number,height:number}} tip
 * @param {{width:number,height:number}} viewport
 * @param {number} [gap=8] - Pixels between the anchor and the tooltip.
 * @param {number} [margin=4] - Minimum gap from the viewport edges.
 * @returns {{ left:number, top:number, below:boolean }}
 */
export function placeAbove(anchor, tip, viewport, gap = 8, margin = 4) {
  const anchorWidth =
    typeof anchor.width === 'number' ? anchor.width : anchor.right - anchor.left;
  const center = anchor.left + anchorWidth / 2;
  let left = Math.round(center - tip.width / 2);
  left = Math.max(margin, Math.min(left, viewport.width - tip.width - margin));

  let top = anchor.top - tip.height - gap;
  let below = false;
  if (top < margin) {
    top = anchor.bottom + gap; // no room above → drop below the construct
    below = true;
  }
  top = Math.max(margin, Math.min(top, viewport.height - tip.height - margin));
  return { left, top, below };
}

/**
 * Create the math tooltip controller, appending its element to HOSTEL (a
 * stable container the tooltip floats over — e.g. the editor host — so it
 * survives view re-mounts).
 *
 * @param {HTMLElement} hostEl
 * @returns {{
 *   element: HTMLElement,
 *   update: (args: {
 *     node: Node|null,
 *     key: string|number,
 *     display?: boolean,
 *     anchorRect?: {left:number,top:number,right:number,bottom:number,width?:number}|null,
 *   }) => void,
 *   hide: () => void,
 *   dispose: () => void,
 * }}
 */
export function createMathTooltip(hostEl) {
  const doc = hostEl.ownerDocument;
  const tip = doc.createElement('div');
  tip.className = 'math-tooltip';
  tip.style.display = 'none';

  const bodyEl = doc.createElement('div');
  bodyEl.className = 'math-tooltip-body';
  // The error indicator: a red circled-X above the words "syntax error",
  // centred BELOW the (kept) last-valid image. Shown only while the body fails
  // to typeset; the last good render stays visible above it.
  const errorEl = doc.createElement('div');
  errorEl.className = 'math-tooltip-error';
  errorEl.style.display = 'none';
  const errorIcon = doc.createElement('span');
  errorIcon.className = 'math-tooltip-error-icon';
  errorIcon.textContent = '✕';
  const errorText = doc.createElement('span');
  errorText.className = 'math-tooltip-error-text';
  errorText.textContent = 'syntax error';
  errorEl.appendChild(errorIcon);
  errorEl.appendChild(errorText);

  tip.appendChild(bodyEl);
  tip.appendChild(errorEl);
  hostEl.appendChild(tip);

  /** The last non-null node shown for the construct keyed by `currentKey`. */
  let lastValid = null;
  /** Identity of the construct currently shown (its start offset). Entering a
   *  different construct resets `lastValid` so a fresh error shows the badge
   *  alone, never a stale image from the previous construct. */
  let currentKey = null;
  /** Whether the tooltip has been positioned for the current construct. It is
   *  anchored ONCE on entry and then left put, so it doesn't jitter along with
   *  the caret while you edit within the same construct. */
  let positioned = false;
  /** The anchor rect frozen on entering the current construct. Re-used when the
   *  error indicator toggles (the height changes) so the tooltip re-anchors
   *  without following the caret. */
  let anchor = null;
  /** Whether the error indicator was shown on the previous update. */
  let lastErrorState = false;

  function mountInto(parent, node) {
    if (typeof parent.replaceChildren === 'function') parent.replaceChildren();
    else while (parent.firstChild) parent.removeChild(parent.firstChild);
    if (!node) return;
    const el = typeof node.cloneNode === 'function' ? node.cloneNode(true) : node;
    parent.appendChild(el);
  }

  function position(anchorRect) {
    if (!anchorRect) return;
    const view = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    const viewport = {
      width: (view && view.innerWidth) || 1024,
      height: (view && view.innerHeight) || 768,
    };
    const r = tip.getBoundingClientRect ? tip.getBoundingClientRect() : { width: 0, height: 0 };
    const size = { width: r.width || 220, height: r.height || 64 };
    const pos = placeAbove(anchorRect, size, viewport);
    tip.style.left = `${pos.left}px`;
    tip.style.top = `${pos.top}px`;
    tip.classList.toggle('math-tooltip-below', pos.below);
  }

  function update({ node, key, display = false, anchorRect = null, scale }) {
    const isNewConstruct = key !== currentKey;
    if (isNewConstruct) {
      currentKey = key;
      lastValid = null;
      positioned = false;
      anchor = null;
      lastErrorState = false;
    }
    const r = chooseRender({ node, lastValid });
    lastValid = r.lastValid;
    mountInto(bodyEl, r.mount);
    errorEl.style.display = r.error ? 'flex' : 'none';
    tip.classList.toggle('math-tooltip-display', Boolean(display));
    tip.classList.toggle('math-tooltip-empty', !r.mount);
    // The preview size is a defcustom (*math-tooltip-scale*), pushed via the
    // renderer config snapshot; the CSS reads --math-tooltip-scale.
    if (typeof scale === 'number' && scale > 0) {
      tip.style.setProperty('--math-tooltip-scale', String(scale));
    }
    tip.style.display = '';
    // Freeze the anchor on entry; reposition only on entry or when the error
    // indicator appears/disappears (its height changes) — never per keystroke,
    // so it doesn't jitter with the caret. Re-anchoring reuses the FROZEN rect,
    // and placeAbove pins the bottom above the construct so it grows upward.
    if (anchorRect && !anchor) anchor = anchorRect;
    const errorChanged = r.error !== lastErrorState;
    lastErrorState = r.error;
    if (anchor && (!positioned || errorChanged)) {
      position(anchor);
      positioned = true;
    }
  }

  function hide() {
    tip.style.display = 'none';
    currentKey = null;
    lastValid = null;
    positioned = false;
    anchor = null;
    lastErrorState = false;
  }

  function dispose() {
    if (tip.parentNode) tip.parentNode.removeChild(tip);
  }

  return { element: tip, update, hide, dispose };
}
