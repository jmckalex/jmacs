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
 * Same-head re-renders (the keystroke case) go through **morphdom** — a
 * DOM diff against the iframe's live body — rather than overwriting its
 * `innerHTML`. So an edit touches only the nodes that actually changed:
 * scroll position survives, there is no flicker, and — crucially —
 * unchanged mathematics is left typeset rather than re-rendered. Each
 * math region is wrapped in a keyed `class="math" data-math-key=…`
 * element (a block `<div>` for display math, an inline `<span>` for
 * inline) and only those whose key is *new* this render are handed to
 * the typeset hook. A head change / full-document engine output still
 * rebuilds the iframe via `srcdoc`. See plans/MD-MATH-AND-PREVIEW.md.
 *
 * Per the project's no-DOM-library convention, the iframe + morphdom
 * path is verified live; the pure pieces here (the head/document
 * builders, the math detection + key generation, the scheduling) are
 * unit-tested — the scheduling via an injectable `commit`.
 */

import morphdom from '../vendor/morphdom.esm.js';
import { scanMathSegments, MARKDOWN_MATH_CONFIG } from './math-segments.js';

/** The debounce interval, in milliseconds, between an edit and a
 *  re-render. The spec asks for ~250ms. */
export const PREVIEW_DEBOUNCE_MS = 250;

/** Tag names whose text content is never mathematics (mirrors MathJax's
 *  default `skipHtmlTags`), so we neither wrap nor typeset inside them. */
const MATH_SKIP_TAGS = new Set([
  'SCRIPT',
  'NOSCRIPT',
  'STYLE',
  'TEXTAREA',
  'PRE',
  'CODE',
]);

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

// --- keyed math spans (the morphdom diff's stable identity) -----------

/**
 * A small, stable, non-cryptographic hash (djb2) of a math body, used
 * as the bulk of a span's key. Same body → same hash, so an unchanged
 * formula keeps its key across renders and morphdom leaves it alone.
 *
 * @param {string} body
 * @returns {string}
 */
export function hashMathBody(body) {
  let h = 5381;
  for (let i = 0; i < body.length; i += 1) {
    h = ((h << 5) + h + body.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * A keyer: turns a `(display, body)` pair into a key that is unique
 * within one render but stable across renders. Two *identical* formulas
 * are disambiguated by occurrence index (`#0`, `#1`, …) so they don't
 * collide as morphdom node keys, while the Nth occurrence of a given
 * formula keeps the same key from render to render.
 *
 * @returns {(display: boolean, body: string) => string}
 */
export function makePreviewKeyer() {
  const counts = new Map();
  return (display, body) => {
    const base = `${display ? 1 : 0}:${hashMathBody(body)}`;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    return `${base}#${n}`;
  };
}

/**
 * @typedef {object} PreviewMathSpan
 * @property {number} start - Offset of the opening delimiter.
 * @property {number} end - Offset one past the closing delimiter.
 * @property {boolean} display - Display (block) math vs inline.
 * @property {string} body - The source between the delimiters.
 */

/**
 * The math regions in a string, in document order, using the markdown
 * math config (the four delimiter pairs plus `\begin…\end`). Pure: this
 * is the detection the DOM wrap applies per text node.
 *
 * @param {string} text
 * @returns {PreviewMathSpan[]}
 */
export function previewMathSpans(text) {
  return scanMathSegments(text, MARKDOWN_MATH_CONFIG).map((seg) => ({
    start: seg.start,
    end: seg.end,
    display: seg.kind === 'block',
    body: seg.body,
  }));
}

/** Collect candidate text nodes (those holding a `$` or `\`, outside
 *  skip tags) into `out`. */
function collectMathTextNodes(el, out) {
  for (let child = el.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3) {
      const value = child.nodeValue;
      if (value && (value.includes('$') || value.includes('\\'))) out.push(child);
    } else if (child.nodeType === 1 && !MATH_SKIP_TAGS.has(child.tagName)) {
      collectMathTextNodes(child, out);
    }
  }
}

/** Replace `node` with its text split around math regions, each region
 *  wrapped in a keyed element — a block `<div>` for display math, an
 *  inline `<span>` for inline math. A no-op when the node holds no math. */
function wrapMathInTextNode(node, doc, keyer) {
  const text = node.nodeValue;
  const spans = previewMathSpans(text);
  if (spans.length === 0) return;
  const frag = doc.createDocumentFragment();
  let pos = 0;
  for (const span of spans) {
    if (span.start > pos) {
      frag.appendChild(doc.createTextNode(text.slice(pos, span.start)));
    }
    const el = doc.createElement(span.display ? 'div' : 'span');
    el.className = 'math';
    el.setAttribute('data-math-key', keyer(span.display, span.body));
    el.setAttribute('data-math-display', span.display ? '1' : '0');
    el.textContent = text.slice(span.start, span.end);
    frag.appendChild(el);
    pos = span.end;
  }
  if (pos < text.length) frag.appendChild(doc.createTextNode(text.slice(pos)));
  node.parentNode.replaceChild(frag, node);
}

/**
 * Wrap each math region under `root` in a keyed `class="math"` element
 * (a `<div>` for display math, a `<span>` for inline), keeping the raw
 * delimiters inside so the typeset hook still recognises it. Text inside
 * code/pre/etc. is left untouched. One `keyer` is shared across the whole
 * tree so occurrence indices are document-global.
 *
 * @param {Element} root
 * @param {Document} doc - The document that owns `root` (the iframe's).
 */
function wrapMathInDom(root, doc) {
  const keyer = makePreviewKeyer();
  /** @type {Text[]} */
  const texts = [];
  collectMathTextNodes(root, texts);
  for (const node of texts) wrapMathInTextNode(node, doc, keyer);
}

/** morphdom node key: a math span keys on its body hash; anything else
 *  falls back to its id (morphdom's default). */
function previewNodeKey(node) {
  if (node.nodeType === 1) {
    const mathKey = node.getAttribute('data-math-key');
    if (mathKey) return `math:${mathKey}`;
    return node.id || '';
  }
  return '';
}

/** Don't descend into an already-typeset formula whose key is unchanged
 *  — keep the live (typeset) node exactly as it is. */
function previewBeforeElUpdated(fromEl, toEl) {
  if (
    fromEl.classList &&
    fromEl.classList.contains('math') &&
    toEl.classList &&
    toEl.classList.contains('math') &&
    fromEl.getAttribute('data-math-key') === toEl.getAttribute('data-math-key')
  ) {
    return false;
  }
  return true;
}

/** Mark `els` as typeset and hand them to the typeset hook. Marking
 *  first means a rapid re-render before MathJax finishes won't re-collect
 *  (and so double-process) them. A no-op for an empty list. */
function typesetFresh(win, els, typeset) {
  if (els.length === 0) return;
  for (const el of els) el.setAttribute('data-typeset', '');
  typeset(win, els);
}

/**
 * The default DOM-commit strategy: apply rendered HTML to the iframe.
 *
 * A full-document engine output, or any render whose `<head>` changed (a
 * buffer switch → new base dir, or a CSS-config change), rebuilds the
 * iframe via `srcdoc` (MathJax reloads); its math is wrapped in keyed
 * spans and the whole body is typeset. A same-head render takes the fast
 * path: the new HTML is parsed detached, its math wrapped in keyed
 * spans, and **morphdom** diffs it into the live body — unchanged nodes
 * (including already-typeset math, matched by `data-math-key`) are left
 * in place, and only the math spans that are new this render are
 * typeset. `typeset(win, els)` runs the iframe's MathJax over `els`.
 *
 * @param {HTMLIFrameElement} frame
 * @param {(frameWindow: Window, elements: Element[]) => void} typeset
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

  /** Typeset the whole freshly-loaded body. For a full-document engine
   *  output we typeset as-is; for our own template we first wrap math in
   *  keyed spans so the next fast-path diff can preserve it. */
  function typesetWholeBody(wrap) {
    try {
      const win = frame.contentWindow;
      const cdoc = frame.contentDocument;
      const body = cdoc && cdoc.body;
      if (!win || !body) return;
      if (wrap) {
        wrapMathInDom(body, cdoc);
        for (const el of body.querySelectorAll('.math')) {
          el.setAttribute('data-typeset', '');
        }
      }
      typeset(win, [body]);
    } catch {
      // The frame may not be ready / reachable yet; the next render retries.
    }
  }

  /** Diff `html` into the live body via morphdom, typesetting only the
   *  math spans morphdom brought in fresh this render. */
  function morphInto(html) {
    try {
      const win = frame.contentWindow;
      const cdoc = frame.contentDocument;
      const body = cdoc && cdoc.body;
      if (!win || !body) return;
      const next = cdoc.createElement('div');
      next.innerHTML = html;
      wrapMathInDom(next, cdoc);
      morphdom(body, next, {
        childrenOnly: true,
        getNodeKey: previewNodeKey,
        onBeforeElUpdated: previewBeforeElUpdated,
      });
      // Preserved (unchanged-key) math keeps its `data-typeset`; math
      // morphdom inserted fresh carries none — those are the ones to run.
      const fresh = Array.from(
        body.querySelectorAll('.math:not([data-typeset])')
      );
      typesetFresh(win, fresh, typeset);
    } catch {
      // The frame may not be ready / reachable yet; the next render retries.
    }
  }

  async function commit(html, head) {
    // A full-document engine output owns its own <head>; render as-is. We
    // can't key/diff a body whose head we don't control, so disable the
    // fast path until the next rebuild.
    if (isFullDocument(html)) {
      await loadDoc(html);
      lastHead = null; // a following fragment render must rebuild
      ready = false;
      typesetWholeBody(false);
      return;
    }
    const cdoc = frame.contentDocument;
    if (!ready || head !== lastHead || !cdoc || !cdoc.body) {
      await loadDoc(buildPreviewDocument(head, html));
      lastHead = head;
      ready = true;
      typesetWholeBody(true);
      return;
    }
    // Fast path: same head, frame already built — diff into the live body.
    morphInto(html);
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
 * @param {(frameWindow: Window, elements: Element[]) => void}
 *   [options.typeset] - Runs the iframe's MathJax over `elements`: the
 *   whole body `[body]` after a rebuild, or just the math spans that are
 *   new this render on the fast path.
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
