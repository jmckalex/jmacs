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
 * @param {(offset: number) => string | null} options.symbolAtOffset -
 *   The Lisp symbol straddling a buffer offset, or null.
 * @param {(symbol: string) => HoverDocSummary | null} options.summarise -
 *   What the tooltip should show, or null when there's no doc.
 * @param {(name: string) => void} options.openDoc - Called on click.
 * @returns {{ destroy(): void, hide(): void }}
 */
export function createHoverDoc(editorEl, options) {
  const doc = editorEl.ownerDocument;
  const offsetFromPoint = options.offsetFromPoint;
  const symbolAtOffset = options.symbolAtOffset;
  const summarise = options.summarise;
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

  /** Move the tooltip out of the way when the user clicks/scrolls. */
  editorEl.addEventListener('mousedown', hide);
  editorEl.addEventListener('wheel', hide, { passive: true });
  editorEl.addEventListener('scroll', hide, { passive: true });
  editorEl.addEventListener('mouseleave', hide);

  editorEl.addEventListener('mousemove', (event) => {
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
    showTimer = setTimeout(() => {
      showTimer = null;
      const offset = offsetFromPoint(lastClientX, lastClientY);
      if (offset === null) {
        hide();
        return;
      }
      const symbol = symbolAtOffset(offset);
      if (!symbol) {
        hide();
        return;
      }
      if (symbol === currentSymbol && tooltip.style.display !== 'none') {
        positionAt(lastClientX, lastClientY);
        return;
      }
      let summary;
      try {
        summary = summarise(symbol);
      } catch {
        summary = null;
      }
      if (!summary) {
        hide();
        return;
      }
      currentSymbol = symbol;
      show(summary, lastClientX, lastClientY);
    }, HOVER_DELAY_MS);
  });

  return {
    hide,
    destroy() {
      hide();
      tooltip.remove();
    },
  };
}
