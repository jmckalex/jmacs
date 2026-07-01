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
   *  different construct resets `lastValid` and the frozen horizontal. */
  let currentKey = null;
  /** The horizontal position (px), frozen on entering a construct so typing
   *  never drags the tooltip sideways. Null until the first placement. */
  let frozenLeft = null;
  /** Whether the tooltip sits below the construct (flipped when there was no
   *  room above at entry). Frozen alongside `frozenLeft`. */
  let below = false;

  function mountInto(parent, node) {
    if (typeof parent.replaceChildren === 'function') parent.replaceChildren();
    else while (parent.firstChild) parent.removeChild(parent.firstChild);
    if (!node) return;
    const el = typeof node.cloneNode === 'function' ? node.cloneNode(true) : node;
    parent.appendChild(el);
  }

  /**
   * Position the tooltip for ANCHORRECT (the caret's client rect). The
   * horizontal placement and the above/below choice are frozen on the FIRST
   * call for a construct — so typing doesn't drag the tooltip sideways — but the
   * VERTICAL position tracks ANCHORRECT on every call, so the tooltip follows
   * the editor as it scrolls (off-screen if the construct scrolls out of view;
   * there is deliberately no vertical clamping). Called on each content update
   * and, continuously, from the host's scroll/track loop.
   *
   * @param {{left:number,top:number,right:number,bottom:number,width?:number}|null} anchorRect
   */
  function reposition(anchorRect) {
    if (!anchorRect) return;
    const view = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    const viewport = {
      width: (view && view.innerWidth) || 1024,
      height: (view && view.innerHeight) || 768,
    };
    const r = tip.getBoundingClientRect ? tip.getBoundingClientRect() : { width: 0, height: 0 };
    const size = { width: r.width || 220, height: r.height || 64 };
    if (frozenLeft === null) {
      // First placement: freeze the horizontal centre and the above/below flip.
      const p = placeAbove(anchorRect, size, viewport);
      frozenLeft = p.left;
      below = p.below;
    }
    const gap = 8;
    const top = below ? anchorRect.bottom + gap : anchorRect.top - size.height - gap;
    tip.style.left = `${frozenLeft}px`;
    tip.style.top = `${top}px`;
    tip.classList.toggle('math-tooltip-below', below);
  }

  /** Show/hide the tooltip via `visibility` WITHOUT resetting it — used to make
   *  it vanish while the construct is scrolled out of the editor's view. */
  function setVisible(visible) {
    tip.style.visibility = visible ? '' : 'hidden';
  }

  function update({ node, key, display = false, anchorRect = null, scale }) {
    const isNewConstruct = key !== currentKey;
    if (isNewConstruct) {
      currentKey = key;
      lastValid = null;
      frozenLeft = null;
      below = false;
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
    tip.style.visibility = '';
    tip.style.display = '';
    reposition(anchorRect);
  }

  function hide() {
    tip.style.display = 'none';
    tip.style.visibility = '';
    currentKey = null;
    lastValid = null;
    frozenLeft = null;
    below = false;
  }

  function dispose() {
    if (tip.parentNode) tip.parentNode.removeChild(tip);
  }

  return { element: tip, update, reposition, setVisible, hide, dispose };
}
