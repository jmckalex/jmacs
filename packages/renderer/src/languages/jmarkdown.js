/**
 * @file JMarkdown (block grammar) — tree-sitter language registration.
 *
 * JMarkdown is the architect's Markdown dialect (`.jmd`): a metadata
 * header, `:::` directives, `@begin/@end` environments, remapped
 * emphasis, `{{mustache}}`, embedded JS, citations, and more — see
 * `../jmarkdown-scan.js` for the inventory. There is no JMarkdown
 * tree-sitter grammar; the language *reuses* the stock markdown block
 * grammar and layers the dialect on through the registry's code-driven
 * hooks:
 *
 *   - `injectionQuery` mirrors markdown's: fenced code by info string,
 *     every paragraph into the `jmarkdown_inline` grammar (the sibling
 *     module, which remaps `*strong*` / `**intense**` / `__underline__`
 *     and injects latex into math).
 *   - `injectionProvider` adds the scanner's regions: LaTeX into
 *     `:::TiKZ` and `@begin(TeX|equation|…)` bodies, javascript into
 *     embedded expression chains, html into `<script>` blocks and the
 *     header's `Extension`/`Custom element` bodies. Provider injections
 *     are appended after query matches, so they win where they overlap
 *     the paragraph injection (see `treesitter.js#spliceInjections`).
 *   - `captureProvider` paints the dialect constructs the grammar has
 *     no nodes for, and occludes its mis-parses (a header read as a
 *     setext heading, a directive's `[content]` read as a link).
 *   - `foldQuery` folds heading sections and fenced code;
 *     `foldProvider` adds `:::` directive blocks and `@begin/@end`
 *     environments, mirroring JMarkdown-Folding.tmPreferences.
 *
 * The three hooks all consume one scan, memoised here per buffer text
 * (each render calls all three).
 */

import { registerLanguage } from '../language-registry.js';
import { scanJmarkdown } from '../jmarkdown-scan.js';

let cachedText = null;
/** @type {import('../jmarkdown-scan.js').JmarkdownScan | null} */
let cachedScan = null;

/** One scan per text — captureProvider/foldProvider/injectionProvider share it. */
function scan(text) {
  if (text !== cachedText) {
    cachedScan = scanJmarkdown(text);
    cachedText = text;
  }
  return cachedScan;
}

// The block-level query is markdown's: headings, fences, list and
// quote markers, link targets. The dialect's own faces come from the
// capture provider.
const QUERY = `
  ; --- headings ---------------------------------------------------------
  (atx_heading) @heading
  (setext_heading) @heading

  ; --- fenced code blocks: delimiters, info string, body ---------------
  (fenced_code_block_delimiter) @paren
  (info_string (language) @keyword)
  (code_fence_content) @code
  (indented_code_block) @code

  ; --- list / quote markers --------------------------------------------
  (list_marker_plus) @keyword
  (list_marker_minus) @keyword
  (list_marker_star) @keyword
  (list_marker_dot) @keyword
  (list_marker_parenthesis) @keyword
  (block_quote_marker) @keyword
  (thematic_break) @keyword

  ; --- link / image reference targets ---------------------------------
  (link_destination) @link
  (link_label) @link
`;

const INJECTION_QUERY = `
  (fenced_code_block
    (info_string (language) @injection.language)
    (code_fence_content) @injection.content)
  ((paragraph) @injection.content (#set! injection.language "jmarkdown_inline"))
`;

// Heading sections and fenced code fold via the grammar; directives
// and @begin/@end environments fold via the scanner.
const FOLD_QUERY = `
  (section) @fold
  (fenced_code_block) @fold
`;

registerLanguage({
  tag: 'jmarkdown',
  grammar: 'tree-sitter-markdown.wasm',
  query: QUERY,
  suffixes: ['.jmd'],
  injectionQuery: INJECTION_QUERY,
  injectionProvider: (text) => scan(text).injections,
  captureProvider: (text) => ({
    captures: scan(text).captures,
    regions: scan(text).regions,
  }),
  foldQuery: FOLD_QUERY,
  foldProvider: (text) => scan(text).folds,
});
