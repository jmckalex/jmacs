/**
 * @file Rust — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * Sublime-Text-style coverage: keywords (incl. `mut` / `self` / `super`
 * / `crate` as named-node captures — they are NOT anonymous tokens, so
 * the architect-notes warning applies; placing them in the keyword
 * alternation throws "Bad node name"), arithmetic / comparison /
 * bitwise / range operators, punctuation, function declarations and
 * call sites (incl. methods, scoped calls, generic functions, macro
 * invocations), type declarations and uses, and `#[…]` attributes.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (line_comment) @comment
  (block_comment) @comment
  (string_literal) @string
  (raw_string_literal) @string
  (char_literal) @string
  (integer_literal) @number
  (float_literal) @number

  ; --- keywords --------------------------------------------------------
  [
    "fn" "let" "const" "static" "struct" "enum" "trait" "impl" "union"
    "for" "while" "loop" "if" "else" "match" "return" "break" "continue"
    "use" "mod" "pub" "extern" "as" "where"
    "in" "ref" "move" "async" "await" "dyn" "type" "unsafe" "yield"
  ] @keyword

  ; These are NAMED nodes in tree-sitter-rust, not anonymous tokens; put
  ; them inside the alternation and the Query constructor throws
  ; "Bad node name". They each need their own capture pattern.
  (mutable_specifier) @keyword
  (self) @keyword
  (super) @keyword
  (crate) @keyword

  ; --- literal constants -----------------------------------------------
  (boolean_literal) @constant

  ; --- operators -------------------------------------------------------
  [
    "=" "+=" "-=" "*=" "/=" "%="
    "<<=" ">>=" "&=" "|=" "^="
    "+" "-" "*" "/" "%"
    "==" "!=" "<" ">" "<=" ">="
    "&&" "||" "!"
    "&" "|" "^" "<<" ">>"
    "=>" "->" ".." "..=" "..." "?"
  ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren

  ; --- functions -------------------------------------------------------
  (function_item name: (identifier) @function)
  (function_signature_item name: (identifier) @function)
  (call_expression function: (identifier) @function)
  (call_expression
    function: (field_expression field: (field_identifier) @function))
  (call_expression
    function: (scoped_identifier name: (identifier) @function))
  (generic_function function: (identifier) @function)
  (generic_function
    function: (field_expression field: (field_identifier) @function))
  (generic_function
    function: (scoped_identifier name: (identifier) @function))

  ; Macro invocations — \`println!\`, \`vec!\`, \`derive\`, etc.
  (macro_invocation macro: (identifier) @function)
  (macro_invocation macro: (scoped_identifier name: (identifier) @function))

  ; --- types -----------------------------------------------------------
  (struct_item name: (type_identifier) @type)
  (enum_item name: (type_identifier) @type)
  (union_item name: (type_identifier) @type)
  (trait_item name: (type_identifier) @type)
  (type_item name: (type_identifier) @type)
  (type_identifier) @type
  (primitive_type) @type
  (scoped_type_identifier name: (type_identifier) @type)

  ; --- attributes (#[derive(...)]) ------------------------------------
  (attribute_item) @function
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
