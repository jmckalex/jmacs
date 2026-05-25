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

// Foldable scopes: any element with both an open and a close tag —
// `<div>...</div>`, `<script>...</script>`, `<style>...</style>`. The
// `element` node covers the whole pair; folding starts on its open-tag
// line and ends on its close-tag line.
const FOLD_QUERY = `
  (element) @fold
  (script_element) @fold
  (style_element) @fold
`;

registerLanguage({
  tag: 'html',
  grammar: 'tree-sitter-html.wasm',
  query: QUERY,
  foldQuery: FOLD_QUERY,
  suffixes: ['.html', '.htm'],
  injectionQuery: INJECTION_QUERY,
});
