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

/** HTML-escape `<`, `&`, `>` so a math body's characters survive into the
 *  DOM as text (the browser decodes them; MathJax reads the decoded
 *  textContent). Backslashes and delimiters are left intact. */
function escapeMathHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Math extensions: CommonMark treats `\[`, `\(` as escaped punctuation
// (→ `[`, `(`), `_`/`*` as emphasis, and `&` as an entity — which
// destroys LaTeX before MathJax ever sees it. These tokenizers claim
// math spans first and emit them verbatim (escaped only for HTML
// safety), so `$…$`, `$$…$$`, `\(…\)`, `\[…\]` and `\begin{…}…\end{…}`
// reach MathJax intact. `$`/`$$` would survive marked anyway, but routing
// them here too protects `_`/`*` inside them from emphasis.
const inlineMath = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    const m = /\$(?!\$)|\\\(/.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    let m = /^\$(?!\$)((?:\\.|[^$\\\n])+?)\$/.exec(src); // $ … $
    if (!m) m = /^\\\(([\s\S]+?)\\\)/.exec(src); //          \( … \)
    if (m) return { type: 'inlineMath', raw: m[0], text: m[0] };
    return undefined;
  },
  renderer(token) {
    return escapeMathHtml(token.text);
  },
};

const blockMath = {
  name: 'blockMath',
  level: 'block',
  start(src) {
    const m = /\$\$|\\\[|\\begin\{/.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    let m = /^\$\$([\s\S]+?)\$\$/.exec(src); //                    $$ … $$
    if (!m) m = /^\\\[([\s\S]+?)\\\]/.exec(src); //               \[ … \]
    if (!m) m = /^\\begin\{([a-zA-Z*]+)\}[\s\S]+?\\end\{\1\}/.exec(src); // env
    if (m) return { type: 'blockMath', raw: m[0], text: m[0] };
    return undefined;
  },
  renderer(token) {
    return `<p>${escapeMathHtml(token.text)}</p>\n`;
  },
};

// A fresh Marked instance avoids leaking state into the global
// `marked` singleton if a future feature wires extensions on the
// renderer side and the host side wants the defaults.
const marked = new Marked({
  gfm: true,
  breaks: false,
});
marked.use({ extensions: [inlineMath, blockMath] });

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
