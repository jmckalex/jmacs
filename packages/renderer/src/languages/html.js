/**
 * @file HTML — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * HTML *also* declares an injection query: the body of every
 * `<script>` element is injected as JavaScript and the body of every
 * `<style>` element as CSS. When the JS or CSS highlighter is missing
 * (an unavoidable load failure), the inner range falls back to the
 * outer HTML face — see `../treesitter.js`.
 *
 * Sublime-Text-style coverage: comments, character entities, doctype,
 * tag names (with the erroneous-end-tag variant so a `</wrong>` still
 * paints), attribute names / values, and the structural punctuation
 * `<`, `</`, `<!`, `>`, `/>` plus the `=` between an attribute name
 * and its value.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / text-level -------------------------------------------
  (comment) @comment
  (entity) @constant

  ; --- tag names -------------------------------------------------------
  (tag_name) @tag
  (erroneous_end_tag_name) @tag

  ; --- doctype ---------------------------------------------------------
  (doctype) @keyword

  ; --- attributes ------------------------------------------------------
  (attribute_name) @constant
  (attribute_value) @string
  (quoted_attribute_value) @string

  ; --- structural punctuation -----------------------------------------
  [ "<" ">" "</" "/>" "<!" ] @paren
  "=" @operator
`;

const INJECTION_QUERY = `
  ((script_element (raw_text) @injection.content)
   (#set! injection.language "javascript"))
  ((style_element (raw_text) @injection.content)
   (#set! injection.language "css"))
`;

// Foldable scopes: an element only counts when it has BOTH a start
// tag and an end tag. HTML void elements like `<meta>`, `<br>`, `<img>`
// and `<link>` parse as `element` nodes without an end_tag — the
// pattern below excludes them so the gutter doesn't grow a fold
// chevron next to every `<meta charset=...>` line. Same logic
// applies to `script_element` and `style_element` (always paired in
// practice, but the explicit child match keeps the query
// self-documenting and robust to grammar updates).
// `@fold.inner` (not `@fold`) opts these tag-delimited elements into
// column-aware folding: a folded `<p>This is text…\n…well.</p>` collapses
// to `<p>…</p>` instead of leaving the start-tag line's content visible.
// The opening `(start_tag)` and closing `(end_tag)` are the node's first
// and last children, which the fold pipeline reads as the cut columns.
const FOLD_QUERY = `
  (element (start_tag) (end_tag)) @fold.inner
  (script_element (start_tag) (end_tag)) @fold.inner
  (style_element (start_tag) (end_tag)) @fold.inner
`;

registerLanguage({
  tag: 'html',
  grammar: 'tree-sitter-html.wasm',
  query: QUERY,
  foldQuery: FOLD_QUERY,
  suffixes: ['.html', '.htm'],
  injectionQuery: INJECTION_QUERY,
});
