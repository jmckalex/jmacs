/**
 * @file The Markdown preview pane — a toggleable pane that shows the
 * current `markdown-mode` buffer rendered to HTML.
 *
 * Like the REPL view, this is a plain DOM component decoupled from the
 * Lisp runtime and from the JMarkdown pipeline: it is handed source
 * text and a `render` function (the host's JMarkdown bridge), debounces
 * refreshes, and drops the rendered HTML into its scroll area. The host
 * decides when the pane is visible and which buffer it tracks.
 */

/** The debounce interval, in milliseconds, between an edit and a
 *  re-render. The spec asks for ~250ms. */
export const PREVIEW_DEBOUNCE_MS = 250;

/**
 * Mount a Markdown preview pane inside a container.
 *
 * @param {HTMLElement} container - Where to mount the pane.
 * @param {object} options
 * @param {(source: string) => Promise<string>} options.render - Renders
 *   Markdown source to an HTML string. Rejecting (the render command
 *   failed) shows an error message in the pane.
 * @param {(element: HTMLElement) => void} [options.typeset] - Optional
 *   hook to typeset mathematics in the rendered HTML (e.g. MathJax).
 * @param {number} [options.debounceMs] - Override the debounce interval.
 * @returns {{
 *   element: HTMLElement,
 *   update: (source: string) => void,
 *   refreshNow: (source: string) => Promise<void>,
 *   clear: () => void,
 * }}
 */
export function createMarkdownPreview(container, options) {
  const doc = container.ownerDocument;
  const render = options.render;
  const typeset =
    typeof options.typeset === 'function' ? options.typeset : null;
  const debounceMs =
    typeof options.debounceMs === 'number'
      ? options.debounceMs
      : PREVIEW_DEBOUNCE_MS;

  const root = doc.createElement('div');
  root.className = 'markdown-preview';

  const header = doc.createElement('div');
  header.className = 'markdown-preview-header';
  header.textContent = 'Preview';

  const body = doc.createElement('div');
  body.className = 'markdown-preview-body';

  root.append(header, body);
  container.append(root);

  /** A token that identifies the most recent render request, so a slow
   *  render that finishes after a newer one cannot overwrite it. */
  let renderToken = 0;
  /** The pending debounce timer. */
  let timer = null;

  /**
   * Render `source` and show the result, unless a newer render has
   * started in the meantime.
   *
   * @param {string} source
   * @returns {Promise<void>}
   */
  async function refreshNow(source) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const token = (renderToken += 1);
    try {
      const html = await render(source);
      if (token !== renderToken) return;
      body.innerHTML = html;
      if (typeset) typeset(body);
    } catch (error) {
      if (token !== renderToken) return;
      const message = error && error.message ? error.message : String(error);
      body.textContent = `Preview unavailable: ${message}`;
    }
  }

  /**
   * Schedule a debounced refresh for `source`. Repeated calls within
   * the debounce window collapse into a single render of the last
   * source given.
   *
   * @param {string} source
   */
  function update(source) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      refreshNow(source);
    }, debounceMs);
  }

  /** Clear the pane and cancel any pending render. */
  function clear() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    renderToken += 1;
    body.innerHTML = '';
  }

  return { element: root, update, refreshNow, clear };
}
