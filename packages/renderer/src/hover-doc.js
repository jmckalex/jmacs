/**
 * @file Hover-to-documentation — a tooltip that shows the doc for the
 * Lisp symbol under the mouse and opens the full page on click.
 *
 * The renderer owns the tooltip element and the mousemove plumbing;
 * the documentation lookup lives in Lisp (`doc-summary-for`) and the
 * symbol-at-offset extraction also (`symbol-at-offset`). This module
 * is just the UI shell.
 *
 * One tooltip element exists per editor; it floats over the editor
 * surface and is reused as the mouse moves between symbols.
 */

const HOVER_DELAY_MS = 250;
const TOOLTIP_OFFSET_PX = 12;
const PREVIEW_LIMIT = 240;

/**
 * @typedef {Object} HoverDocSummary
 * @property {string} name - The symbol whose docs to show.
 * @property {'manifest' | 'live'} kind - Source of the docs.
 * @property {string} [preview] - A short rendered HTML preview, used
 *   when `kind === 'live'`. The host renders the Markdown docstring.
 */

/**
 * @param {HTMLElement} editorEl - The editor root the tooltip floats
 *   over (mousemove is attached here).
 * @param {object} options
 * @param {(x: number, y: number) => number} options.offsetFromPoint -
 *   The buffer offset for a viewport pixel.
 * @param {(offset: number) => ({ symbol: string, summary: HoverDocSummary } | null
 *   | Promise<{ symbol: string, summary: HoverDocSummary } | null>)}
 *   options.resolveHover - The symbol straddling a buffer offset together with
 *   what the tooltip should show, or null when there's no documented symbol. May
 *   be async (server mode resolves it on the spine); the result is awaited and a
 *   stale reply — superseded by a newer hover — is dropped.
 * @param {(name: string) => void} options.openDoc - Called on click.
 * @returns {{ destroy(): void, hide(): void }}
 */
export function createHoverDoc(editorEl, options) {
  const doc = editorEl.ownerDocument;
  const offsetFromPoint = options.offsetFromPoint;
  const resolveHover = options.resolveHover;
  const openDoc = options.openDoc;

  const tooltip = doc.createElement('div');
  tooltip.className = 'hover-doc-tooltip';
  tooltip.style.display = 'none';
  tooltip.setAttribute('role', 'tooltip');
  doc.body.append(tooltip);

  /** The symbol currently displayed in the tooltip, or null. */
  let currentSymbol = null;
  let showTimer = null;
  let lastClientX = 0;
  let lastClientY = 0;
  // Monotonic tag for the in-flight `resolveHover` (it may be async). A reply
  // whose seq is stale — a newer hover bumped it — is ignored.
  let resolveSeq = 0;

  function clearShowTimer() {
    if (showTimer !== null) {
      clearTimeout(showTimer);
      showTimer = null;
    }
  }

  function hide() {
    clearShowTimer();
    tooltip.style.display = 'none';
    currentSymbol = null;
  }

  function positionAt(x, y) {
    // Place below-right of the cursor; flip to above-left if it would
    // overflow the viewport.
    const box = tooltip.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    let left = x + TOOLTIP_OFFSET_PX;
    let top = y + TOOLTIP_OFFSET_PX;
    if (left + box.width > vw) left = Math.max(0, x - box.width - TOOLTIP_OFFSET_PX);
    if (top + box.height > vh) top = Math.max(0, y - box.height - TOOLTIP_OFFSET_PX);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function show(summary, x, y) {
    tooltip.replaceChildren();
    const name = doc.createElement('div');
    name.className = 'hover-doc-name';
    const code = doc.createElement('code');
    code.textContent = summary.name;
    name.append(code);
    tooltip.append(name);

    if (summary.kind === 'manifest') {
      const note = doc.createElement('div');
      note.className = 'hover-doc-source';
      note.textContent = 'reference page';
      tooltip.append(note);
    } else if (summary.kind === 'live') {
      const note = doc.createElement('div');
      note.className = 'hover-doc-source';
      note.textContent = 'live docstring';
      tooltip.append(note);
      if (typeof summary.preview === 'string' && summary.preview !== '') {
        const preview = doc.createElement('div');
        preview.className = 'hover-doc-preview';
        preview.innerHTML = summary.preview;
        tooltip.append(preview);
      }
    }

    const open = doc.createElement('div');
    open.className = 'hover-doc-open';
    open.textContent = 'click to open  ⏎';
    tooltip.append(open);

    tooltip.style.display = '';
    positionAt(x, y);
  }

  /** Click on the tooltip — open the full doc and hide. */
  tooltip.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (currentSymbol) openDoc(currentSymbol);
    hide();
  });

  /** Move the tooltip out of the way when the user clicks/scrolls.
   *  Note: we deliberately do NOT hide on `editorEl.mouseleave` —
   *  the tooltip lives on document.body, so the mouse leaves the
   *  editor the moment it enters the tooltip, and a `mouseleave`
   *  handler would close the tooltip just as the user reaches for
   *  the click-to-open link. Cancelling the pending show-timer is
   *  enough: a visible tooltip persists until the user clicks
   *  (anywhere) or scrolls. */
  const onHideEvent = () => hide();
  const onMouseLeave = () => clearShowTimer();
  const onMouseMove = (event) => {
    // Skip when the cursor is over a UI overlay (sticky notes etc.).
    // They live inside the editor element but carry their own
    // tooltips / handlers.
    if (event.target instanceof Element &&
        event.target.closest('.sticky-note, .minibuffer, .colour-picker')) {
      hide();
      return;
    }
    lastClientX = event.clientX;
    lastClientY = event.clientY;
    clearShowTimer();
    showTimer = setTimeout(async () => {
      showTimer = null;
      const offset = offsetFromPoint(lastClientX, lastClientY);
      if (offset === null) {
        hide();
        return;
      }
      // `resolveHover` may be async (server mode resolves on the spine). Tag this
      // request so a slow reply that a newer hover has superseded is dropped.
      const seq = ++resolveSeq;
      let result;
      try {
        result = await resolveHover(offset);
      } catch {
        result = null;
      }
      if (seq !== resolveSeq) return; // a newer hover started while we awaited
      if (!result || !result.symbol || !result.summary) {
        hide();
        return;
      }
      if (result.symbol === currentSymbol && tooltip.style.display !== 'none') {
        positionAt(lastClientX, lastClientY);
        return;
      }
      currentSymbol = result.symbol;
      show(result.summary, lastClientX, lastClientY);
    }, HOVER_DELAY_MS);
  };

  // The hover listeners live on the ACTIVE editor element. Under Model B the
  // visible editor is a per-leaf `<text-view>` that is swapped on a pane / buffer
  // switch (and the first server mount can land AFTER this component is created),
  // so the host re-points us at the live element via `setEditorEl` — exactly as
  // inline-eval is re-pointed via `setOverlayLayer`. Without this, the listeners
  // would stay on whatever element existed at construction and never fire.
  let boundEl = null;
  function setEditorEl(el) {
    if (!el || el === boundEl) return;
    if (boundEl) {
      boundEl.removeEventListener('mousedown', onHideEvent);
      boundEl.removeEventListener('wheel', onHideEvent);
      boundEl.removeEventListener('scroll', onHideEvent);
      boundEl.removeEventListener('mouseleave', onMouseLeave);
      boundEl.removeEventListener('mousemove', onMouseMove);
    }
    hide();
    boundEl = el;
    el.addEventListener('mousedown', onHideEvent);
    el.addEventListener('wheel', onHideEvent, { passive: true });
    el.addEventListener('scroll', onHideEvent, { passive: true });
    el.addEventListener('mouseleave', onMouseLeave);
    el.addEventListener('mousemove', onMouseMove);
  }
  setEditorEl(editorEl);

  return {
    hide,
    // Re-point the hover listeners at the now-active `<text-view>` (server-mode
    // pane / buffer switch). A no-op for the same element.
    setEditorEl,
    destroy() {
      hide();
      if (boundEl) {
        boundEl.removeEventListener('mousedown', onHideEvent);
        boundEl.removeEventListener('wheel', onHideEvent);
        boundEl.removeEventListener('scroll', onHideEvent);
        boundEl.removeEventListener('mouseleave', onMouseLeave);
        boundEl.removeEventListener('mousemove', onMouseMove);
        boundEl = null;
      }
      tooltip.remove();
    },
  };
}
