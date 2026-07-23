/**
 * @file Markdown (inline grammar) — tree-sitter language registration.
 *
 * The inline grammar handles what lives inside a paragraph or list
 * item: emphasis, strong, inline code, links, autolinks, escapes. It's
 * registered with **no suffixes** because no file extension picks it
 * directly — the block grammar (`./markdown.js`) injects every
 * paragraph's content into it.
 *
 * The wasm binary is produced by `scripts/build-grammars.sh` alongside
 * `tree-sitter-markdown.wasm`.
 *
 * LaTeX math: the grammar parses `$…$`/`$$…$$` as `latex_block` but not
 * `\(…\)`, `\[…\]` or `\begin{…}` environments, so rather than capture
 * the grammar's nodes we use a code-driven `injectionProvider`
 * (`markdownMathInjections`) that finds every MathJax notation and
 * injects the `latex` grammar into it — accurate math highlighting
 * without forking the markdown grammar. See plans/MD-MATH-AND-PREVIEW.md.
 */

import { registerLanguage } from '../language-registry.js';
import { markdownMathInjections } from '../highlight.js';

const QUERY = `
  (emphasis) @emphasis
  (strong_emphasis) @strong
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

// Inline HTML: inject the html grammar over each raw `html_tag` node
// so tag names, attributes and values highlight in prose. A lone
// closing tag needs a synthetic `<x>` opener to parse (mirrors
// languages/jmarkdown-inline.js, where the full story is told).
const INJECTION_QUERY = `
  ((html_tag) @injection.content
   (#not-match? @injection.content "^</")
   (#set! injection.language "html"))
  ((html_tag) @injection.content
   (#match? @injection.content "^</")
   (#set! injection.language "html")
   (#set! injection.wrapPrefix "<x>"))
`;

registerLanguage({
  tag: 'markdown_inline',
  grammar: 'tree-sitter-markdown-inline.wasm',
  query: QUERY,
  suffixes: [],
  injectionQuery: INJECTION_QUERY,
  injectionProvider: markdownMathInjections,
});
