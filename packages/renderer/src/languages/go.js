/**
 * @file Go — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  (comment) @comment
  (interpreted_string_literal) @string
  (raw_string_literal) @string
  (rune_literal) @string
  (int_literal) @number
  (float_literal) @number
  [
    "break" "case" "chan" "const" "continue" "default" "defer" "else"
    "fallthrough" "for" "func" "go" "goto" "if" "import" "interface"
    "map" "package" "range" "return" "select" "struct" "switch" "type"
    "var"
  ] @keyword
  [ (true) (false) (nil) (iota) ] @constant
  (function_declaration name: (identifier) @function)
  (method_declaration name: (field_identifier) @function)
  (call_expression function: (identifier) @function)
  (call_expression function: (selector_expression field: (field_identifier) @function))
  (type_spec name: (type_identifier) @type)
  (type_identifier) @type
`;

// Foldable scopes: braced blocks (function bodies, control flow) and
// struct/interface bodies. The body's opening `{` shares the header
// line, which stays visible.
const FOLD_QUERY = `
  (block) @fold
  (field_declaration_list) @fold
  (interface_type) @fold
`;

registerLanguage({
  tag: 'go',
  grammar: 'tree-sitter-go.wasm',
  query: QUERY,
  foldQuery: FOLD_QUERY,
  suffixes: ['.go'],
});
