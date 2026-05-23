/**
 * @file JSON — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  (string) @string
  (number) @number
  [ (true) (false) (null) ] @constant
  (pair key: (string) @keyword)
  (escape_sequence) @operator
`;

registerLanguage({
  tag: 'json',
  grammar: 'tree-sitter-json.wasm',
  query: QUERY,
  suffixes: ['.json'],
});
