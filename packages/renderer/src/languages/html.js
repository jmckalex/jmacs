/**
 * @file HTML — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
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

registerLanguage({
  tag: 'html',
  grammar: 'tree-sitter-html.wasm',
  query: QUERY,
  suffixes: ['.html', '.htm'],
});
