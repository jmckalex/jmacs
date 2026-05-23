/**
 * @file Markdown (block grammar) — tree-sitter language registration.
 *
 * The block grammar parses headings, lists, blockquotes, code blocks,
 * paragraphs, and the like; the *inline* grammar (sibling module
 * `./markdown-inline.js`) parses what's inside paragraphs and list
 * items. The two are wired together by this file's injection query:
 *
 *   1. A fenced code block injects its body into the language named by
 *      its info string (` ```lisp ` → the lisp highlighter renders the
 *      body). Buffers with no info string fall through — the outer
 *      `code` face on the body survives.
 *   2. Every paragraph's content is injected into the `markdown_inline`
 *      grammar so emphasis / strong / code / links highlight correctly.
 *
 * The `.wasm` binaries are produced by `scripts/build-grammars.sh`
 * (unlike the other tree-sitter grammars, which ship prebuilt wasm on
 * npm). See `../../vendor/README.md`.
 */

import { registerLanguage } from '../language-registry.js';

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
  ((paragraph) @injection.content (#set! injection.language "markdown_inline"))
`;

registerLanguage({
  tag: 'markdown',
  grammar: 'tree-sitter-markdown.wasm',
  query: QUERY,
  suffixes: ['.md', '.markdown'],
  aliases: ['md'],
  injectionQuery: INJECTION_QUERY,
});
