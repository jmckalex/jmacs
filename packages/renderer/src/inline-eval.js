/**
 * @file Inline evaluation — show a Lisp form's result as a coloured
 * pill beside the form. CIDER-style.
 *
 * The pill lives on the editor's overlay layer (the same layer the
 * sticky notes use), positioned at the (line, column) of the form's
 * end. One pill at a time per editor — a new eval replaces the
 * previous pill, and any buffer mutation hides the old one.
 *
 * The module is presentation only — the host (`apps/desktop/src/app.js`)
 * does the actual eval and tells this module what to show.
 */

const FADE_AFTER_MS = 5000;

/**
 * @param {object} options
 * @param {HTMLElement} options.overlayLayer - The editor's overlay
 *   layer; the pill is appended here.
 * @param {() => object} options.getBuffer - Returns the current text
 *   buffer (for `positionAt` / change subscriptions).
 * @returns {{
 *   showResult: (anchor: number, label: string) => void,
 *   showError:  (anchor: number, label: string) => void,
 *   hide:       () => void,
 *   destroy:    () => void,
 * }}
 */
export function createInlineEval(options) {
  // Mutable: per-pane editor views each own an overlay layer, and the
  // pill must render into the ACTIVE pane's layer (see
  // `setOverlayLayer` below), not whichever layer existed at boot.
  let overlayLayer = options.overlayLayer;
  const getBuffer = options.getBuffer;

  /** @type {HTMLElement | null} */
  let pill = null;
  /** Anchor offset in the current buffer, used to keep the pill in
   *  the right place when text shifts above it. */
  let anchorOffset = -1;
  /** The buffer the current pill is anchored in. */
  let anchorBuffer = null;
  let anchorBufferText = '';
  let fadeTimer = null;
  /** The buffer's change-subscription teardown, if any. */
  let unsubscribe = null;

  function clearFadeTimer() {
    if (fadeTimer !== null) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
  }

  function dropSubscription() {
    if (typeof unsubscribe === 'function') {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
    }
    unsubscribe = null;
  }

  function hide() {
    clearFadeTimer();
    dropSubscription();
    if (pill !== null) {
      pill.remove();
      pill = null;
    }
    anchorOffset = -1;
    anchorBuffer = null;
    anchorBufferText = '';
  }

  function position(buffer, offset) {
    const { line, column } = buffer.positionAt(offset);
    if (pill === null) return;
    pill.style.top = `calc(${line} * 1lh)`;
    // 1em sits the pill just past the form; +6pt of breathing room so it doesn't
    // crowd the close bracket / cursor.
    pill.style.left = `calc(${column} * 1ch + 1em + 6pt)`;
  }

  function watchBufferForChange(buffer) {
    dropSubscription();
    if (typeof buffer.subscribe !== 'function') return;
    unsubscribe = buffer.subscribe(() => {
      // Any buffer mutation hides the pill: the anchor offset is
      // no longer trustworthy and the user's already moved on.
      if (buffer.text !== anchorBufferText) hide();
    });
  }

  /** Create or reuse the pill, applying `cls` and `label`. */
  function showPill(anchor, label, cls) {
    hide();
    if (!overlayLayer) return;
    const buffer = getBuffer();
    if (!buffer || typeof buffer.positionAt !== 'function') return;
    const doc = overlayLayer.ownerDocument;
    pill = doc.createElement('div');
    pill.className = `inline-eval ${cls}`;
    pill.textContent = label;
    overlayLayer.append(pill);
    anchorOffset = anchor;
    anchorBuffer = buffer;
    anchorBufferText = buffer.text;
    position(buffer, anchor);
    watchBufferForChange(buffer);
    clearFadeTimer();
    fadeTimer = setTimeout(() => {
      if (pill !== null) pill.classList.add('is-fading');
      fadeTimer = setTimeout(hide, 500);
    }, FADE_AFTER_MS);
  }

  return {
    showResult(anchor, label) {
      showPill(anchor, label, 'is-result');
    },
    showError(anchor, label) {
      showPill(anchor, label, 'is-error');
    },
    /** Re-point the pill at another editor instance's overlay layer —
     *  the same dance the host does for sticky notes when pane focus
     *  moves. Any visible pill is hidden first: its anchor belonged
     *  to the previous pane's buffer. */
    setOverlayLayer(layer) {
      if (layer === overlayLayer) return;
      hide();
      overlayLayer = layer ?? null;
    },
    hide,
    destroy: hide,
  };
}
