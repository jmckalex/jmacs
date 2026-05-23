/**
 * @file Markdown rendering — a thin wrapper around the vendored
 * marked.js library.
 *
 * Used by:
 *   - sticky notes (when `*markdown-interpreter*` is the magic value
 *     "marked"), to render note bodies without shelling out;
 *   - the doc-view's live-docstring path (`renderDocstringPage`),
 *     so a user-defined function's docstring renders with the same
 *     typography as the pre-built reference pages.
 *
 * The renderer is sandboxed and has no bundler, so marked.js itself
 * is vendored alongside the tree-sitter grammars (see
 * `../vendor/README.md`). Marked is configured for sensible defaults
 * (GFM tables and line breaks); no syntax-highlighting hook is wired
 * up here, so fenced code blocks render as plain `<pre><code>`.
 */

import { Marked } from '../vendor/marked.esm.js';

// A fresh Marked instance avoids leaking state into the global
// `marked` singleton if a future feature wires extensions on the
// renderer side and the host side wants the defaults.
const marked = new Marked({
  gfm: true,
  breaks: false,
});

/**
 * Render a Markdown source string to an HTML fragment. Synchronous.
 *
 * @param {string} source - Markdown text.
 * @returns {string} HTML.
 */
export function renderMarkdown(source) {
  if (typeof source !== 'string' || source === '') return '';
  return marked.parse(source);
}
