/**
 * @file Rust — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  (line_comment) @comment
  (block_comment) @comment
  (string_literal) @string
  (raw_string_literal) @string
  (char_literal) @string
  (integer_literal) @number
  (float_literal) @number
  [
    "fn" "let" "const" "static" "struct" "enum" "trait" "impl"
    "for" "while" "loop" "if" "else" "match" "return" "break" "continue"
    "use" "mod" "pub" "extern" "as" "where"
    "in" "ref" "move" "async" "await" "dyn" "type" "unsafe" "yield"
  ] @keyword
  (mutable_specifier) @keyword
  (self) @keyword
  (super) @keyword
  (crate) @keyword
  [ (boolean_literal) ] @constant
  (function_item name: (identifier) @function)
  (call_expression function: (identifier) @function)
  (call_expression
    function: (field_expression field: (field_identifier) @function))
  (struct_item name: (type_identifier) @type)
  (enum_item name: (type_identifier) @type)
  (trait_item name: (type_identifier) @type)
  (type_identifier) @type
  (primitive_type) @type
`;

// Foldable scopes: braced blocks, struct/enum/trait/impl/match bodies.
// All hang off a `{ ... }` whose opening brace sits on the header line.
const FOLD_QUERY = `
  (block) @fold
  (declaration_list) @fold
  (field_declaration_list) @fold
  (enum_variant_list) @fold
  (match_block) @fold
`;

registerLanguage({
  tag: 'rust',
  grammar: 'tree-sitter-rust.wasm',
  query: QUERY,
  foldQuery: FOLD_QUERY,
  suffixes: ['.rs'],
  aliases: ['rs'],
});
