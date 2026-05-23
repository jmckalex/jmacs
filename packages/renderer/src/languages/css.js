/**
 * @file CSS — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  (comment) @comment
  (string_value) @string
  (integer_value) @number
  (float_value) @number
  (unit) @number
  (plain_value) @constant
  (color_value) @constant
  (property_name) @keyword
  (tag_name) @tag
  (class_name) @type
  (id_name) @type
  (function_name) @function
  (important) @operator
  (at_keyword) @keyword
`;

registerLanguage({
  tag: 'css',
  grammar: 'tree-sitter-css.wasm',
  query: QUERY,
  suffixes: ['.css'],
});
