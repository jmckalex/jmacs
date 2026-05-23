/**
 * @file HTML — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * HTML *also* declares an injection query: the body of every
 * `<script>` element is injected as JavaScript and the body of every
 * `<style>` element as CSS. When the JS or CSS highlighter is missing
 * (an unavoidable load failure), the inner range falls back to the
 * outer HTML face — see `../treesitter.js`.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  (tag_name) @tag
  (erroneous_end_tag_name) @tag
  (doctype) @keyword
  (attribute_name) @constant
  (attribute_value) @string
  (comment) @comment
  [ "<" ">" "</" "/>" ] @paren
`;

const INJECTION_QUERY = `
  ((script_element (raw_text) @injection.content)
   (#set! injection.language "javascript"))
  ((style_element (raw_text) @injection.content)
   (#set! injection.language "css"))
`;

registerLanguage({
  tag: 'html',
  grammar: 'tree-sitter-html.wasm',
  query: QUERY,
  suffixes: ['.html', '.htm'],
  injectionQuery: INJECTION_QUERY,
});
