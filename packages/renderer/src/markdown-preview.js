/**
 * @file The Markdown preview pane — a toggleable pane that shows the
 * current `markdown-mode` buffer rendered to HTML, inside an **isolated
 * iframe**.
 *
 * The iframe gives the rendered output its own document: the editor's
 * CSS no longer cascades in, the user's stylesheet (a book's CSS, via
 * `*markdown-preview-css*`) no longer leaks out, and a custom
 * `*markdown-interpreter*` that emits a full HTML page renders verbatim.
 * The host supplies the `<head>` (a `<base>`, the built-in + user
 * stylesheets, and MathJax) as a string and a `typeset` hook that runs
 * MathJax *inside* the iframe; the component owns the iframe lifecycle.
 *
 * Per the project's no-DOM-library convention, the iframe path is
 * verified live; the pure pieces here (the head/document builders, the
 * scheduling) are unit-tested — the latter via an injectable `commit`.
 */

/** The debounce interval, in milliseconds, between an edit and a
 *  re-render. The spec asks for ~250ms. */
export const PREVIEW_DEBOUNCE_MS = 250;

/** Escape a string for an HTML attribute value (double-quoted). */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape text for HTML body content. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * `<link rel="stylesheet">` tags for each URL, in order. Non-string /
 * empty entries are dropped.
 *
 * @param {string[]} urls
 * @returns {string}
 */
export function cssLinkTags(urls) {
  if (!Array.isArray(urls)) return '';
  return urls
    .filter((u) => typeof u === 'string' && u !== '')
    .map((u) => `<link rel="stylesheet" href="${escapeAttr(u)}">`)
    .join('\n');
}

/**
 * The `<head>` inner HTML for the preview document: a `<base>` (so a
 * source file's relative assets resolve), then the built-in stylesheet,
 * then the user's stylesheets (last, so they win the cascade), then the
 * MathJax config + script. Every field is optional.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.baseUrl]
 * @param {string[]} [opts.cssUrls]
 * @param {string|null} [opts.defaultCssUrl]
 * @param {string|null} [opts.mathjaxSrc]
 * @param {object} [opts.mathjaxConfig]
 * @returns {string}
 */
export function buildPreviewHead(opts = {}) {
  const parts = ['<meta charset="utf-8">'];
  if (opts.baseUrl) parts.push(`<base href="${escapeAttr(opts.baseUrl)}">`);
  if (opts.defaultCssUrl) {
    parts.push(`<link rel="stylesheet" href="${escapeAttr(opts.defaultCssUrl)}">`);
  }
  const userCss = cssLinkTags(opts.cssUrls);
  if (userCss) parts.push(userCss);
  if (opts.mathjaxSrc) {
    parts.push(`<script>window.MathJax=${JSON.stringify(opts.mathjaxConfig ?? {})};</script>`);
    parts.push(`<script src="${escapeAttr(opts.mathjaxSrc)}"></script>`);
  }
  return parts.join('\n');
}

/**
 * Wrap a head and body into a full HTML document string.
 *
 * @param {string} headHtml
 * @param {string} bodyHtml
 * @returns {string}
 */
export function buildPreviewDocument(headHtml, bodyHtml) {
  return `<!doctype html>\n<html>\n<head>\n${headHtml}\n</head>\n<body>${bodyHtml}</body>\n</html>`;
}

/**
 * Whether HTML already looks like a complete document — an engine that
 * emits a full page (its own `<head>` / styles). Then the preview uses
 * it verbatim instead of wrapping it in our template.
 *
 * @param {string} html
 * @returns {boolean}
 */
export function isFullDocument(html) {
  return /^\s*(?:<!doctype|<html[\s>])/i.test(String(html));
}

/** The error fragment shown when a render fails. */
function previewErrorHtml(error) {
  const message = error && error.message ? error.message : String(error);
  return `<p class="markdown-preview-error">Preview unavailable: ${escapeHtml(message)}</p>`;
}

/**
 * The default DOM-commit strategy: apply rendered HTML to the iframe.
 * A full-document render, or any render whose `<head>` changed (a buffer
 * switch → new base dir, or a CSS-config change), rebuilds the iframe
 * via `srcdoc` (MathJax reloads); a same-head render takes the fast path
 * and only swaps the `<body>` (MathJax already live). `typeset` runs
 * MathJax inside the iframe after each apply.
 *
 * @param {HTMLIFrameElement} frame
 * @param {(frameWindow: Window, body: Element) => void} typeset
 */
function makeIframeCommit(frame, typeset) {
  let lastHead = null;
  let ready = false;

  function loadDoc(docHtml) {
    return new Promise((resolve) => {
      const onload = () => {
        frame.removeEventListener('load', onload);
        resolve();
      };
      frame.addEventListener('load', onload);
      frame.srcdoc = docHtml;
    });
  }

  function safeTypeset() {
    try {
      const win = frame.contentWindow;
      const body = frame.contentDocument && frame.contentDocument.body;
      if (win && body) typeset(win, body);
    } catch {
      // The frame may not be ready / reachable yet; the next render retries.
    }
  }

  async function commit(html, head) {
    // A full-document engine output owns its own <head>; render as-is.
    if (isFullDocument(html)) {
      await loadDoc(html);
      lastHead = null; // a following fragment render must rebuild
      ready = true;
      safeTypeset();
      return;
    }
    const cdoc = frame.contentDocument;
    if (!ready || head !== lastHead || !cdoc || !cdoc.body) {
      await loadDoc(buildPreviewDocument(head, html));
      lastHead = head;
      ready = true;
      safeTypeset();
      return;
    }
    // Fast path: same head, frame already built — swap only the body.
    cdoc.body.innerHTML = html;
    safeTypeset();
  }

  function reset() {
    lastHead = null;
    ready = false;
    try {
      frame.srcdoc = '';
    } catch {
      // ignore — nothing to clear
    }
  }

  return { commit, reset };
}

/**
 * Mount a Markdown preview pane (an iframe) inside a container.
 *
 * @param {HTMLElement} container - Where to mount the pane.
 * @param {object} options
 * @param {(source: string) => Promise<string>} options.render - Renders
 *   Markdown source to an HTML string (fragment or full document).
 *   Rejecting shows an error message in the pane.
 * @param {() => string} [options.buildHead] - Returns the `<head>` inner
 *   HTML for the iframe document (base + stylesheets + MathJax). Called
 *   each render; a changed result rebuilds the iframe.
 * @param {(frameWindow: Window, body: Element) => void} [options.typeset]
 *   - Runs MathJax inside the iframe after each apply.
 * @param {number} [options.debounceMs] - Override the debounce interval.
 * @param {(html: string, head: string) => (void|Promise<void>)}
 *   [options.commit] - The DOM-commit strategy; defaults to the iframe
 *   committer. Overridable for testing.
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
  const buildHead =
    typeof options.buildHead === 'function' ? options.buildHead : () => '';
  const typeset =
    typeof options.typeset === 'function' ? options.typeset : () => {};
  const debounceMs =
    typeof options.debounceMs === 'number'
      ? options.debounceMs
      : PREVIEW_DEBOUNCE_MS;

  const root = doc.createElement('div');
  root.className = 'markdown-preview';

  const header = doc.createElement('div');
  header.className = 'markdown-preview-header';
  header.textContent = 'Preview';

  const frame = doc.createElement('iframe');
  frame.className = 'markdown-preview-frame';

  root.append(header, frame);
  container.append(root);

  const committer =
    typeof options.commit === 'function'
      ? { commit: options.commit, reset: null }
      : makeIframeCommit(frame, typeset);

  /** Identifies the most recent render so a slow one can't overwrite a
   *  newer one. */
  let renderToken = 0;
  /** The pending debounce timer. */
  let timer = null;

  /**
   * Render `source` and apply it, unless a newer render has started.
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
    let html;
    try {
      html = await render(source);
    } catch (error) {
      html = previewErrorHtml(error);
    }
    if (token !== renderToken) return;
    await committer.commit(html, buildHead());
  }

  /**
   * Schedule a debounced refresh; repeated calls within the window
   * collapse to a single render of the last source.
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
    if (committer.reset) committer.reset();
  }

  return { element: root, update, refreshNow, clear };
}
