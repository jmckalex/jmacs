/**
 * @file JMarkdown (inline grammar) — tree-sitter language registration.
 *
 * Reuses the stock markdown *inline* grammar (the `jmarkdown` block
 * module injects every paragraph here) with the dialect's emphasis
 * remapping, resolved by `#match?` on the delimiter character:
 *
 *   `*x*`  → strong   (JMarkdown bold; vanilla markdown calls it emphasis)
 *   `**x**`→ intense  (bold italic)
 *   `__x__`→ underline
 *   `_x_`  → emphasis (unchanged — Sublime leaves `_…_` italic too)
 *
 * `/italic/` and `==highlight==` are not grammar nodes; the block
 * language's capture provider paints those. Math gets the same
 * code-driven latex injection markdown uses.
 */

import { registerLanguage } from '../language-registry.js';
import { markdownMathInjections } from '../highlight.js';

const QUERY = `
  ((emphasis) @jmd-strong (#match? @jmd-strong "^[*]"))
  ((emphasis) @emphasis (#match? @emphasis "^_"))
  ((strong_emphasis) @jmd-intense (#match? @jmd-intense "^[*][*]"))
  ((strong_emphasis) @jmd-underline (#match? @jmd-underline "^__"))
  (code_span) @code
  (code_span_delimiter) @paren
  (emphasis_delimiter) @paren

  (link_destination) @link
  (link_label) @link
  (link_text) @link
  (uri_autolink) @link

  (image_description) @link

  (backslash_escape) @constant
  (hard_line_break) @constant
`;

// Inline HTML: each raw tag in prose (`… <span class="x">…</span> …`)
// is its own `html_tag` node; inject the html grammar over it so tag
// names, attributes and values highlight (tree-sitter-html parses a
// lone open or close tag as a fragment without complaint).
const INJECTION_QUERY = `
  ((html_tag) @injection.content (#set! injection.language "html"))
`;

registerLanguage({
  tag: 'jmarkdown_inline',
  grammar: 'tree-sitter-markdown-inline.wasm',
  query: QUERY,
  suffixes: [],
  injectionQuery: INJECTION_QUERY,
  injectionProvider: markdownMathInjections,
});
