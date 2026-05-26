/**
 * @file Swift — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Sublime-Text-style coverage: keywords (control flow + `func` /
 * `let` / `var` / `class` / `struct` / `enum` / `protocol` /
 * `extension` / `typealias` / `init` / `deinit` plus modifier-node
 * families and `async` / `await` / `try` / `throw`), strings,
 * numbers, function declarations and call sites (incl. dot-chain),
 * type identifiers, and `@PropertyWrapper` attributes as functions.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (multiline_comment) @comment
  (line_str_text) @string
  (multi_line_str_text) @string
  (raw_str_part) @string
  (integer_literal) @number
  (hex_literal) @number
  (oct_literal) @number
  (bin_literal) @number
  (real_literal) @number

  ; --- keywords --------------------------------------------------------
  [ "func" "deinit" "init" ] @keyword
  [
    (visibility_modifier) (member_modifier) (function_modifier)
    (property_modifier) (parameter_modifier) (inheritance_modifier)
    (mutation_modifier)
  ] @keyword
  [
    "protocol" "extension" "indirect" "nonisolated" "override"
    "convenience" "required" "some" "any" "weak" "unowned"
    "didSet" "willSet" "subscript" "let" "var"
    "enum" "struct" "class" "typealias"
    "async" "await"
    "import" "if" "guard" "switch" "for" "in" "while" "repeat"
    "continue" "break" "return" "do" "case" "fallthrough"
  ] @keyword
  (throws) @keyword
  (where_keyword) @keyword
  (getter_specifier) @keyword
  (setter_specifier) @keyword
  (modify_specifier) @keyword
  (else) @keyword
  (as_operator) @keyword
  (try_operator) @keyword
  (throw_keyword) @keyword
  (catch_keyword) @keyword
  (default_keyword) @keyword
  (directive) @keyword
  (shebang_line) @keyword

  ; --- literal constants -----------------------------------------------
  (boolean_literal) @constant
  (nil) @constant
  (special_literal) @constant
  [ (self_expression) (super_expression) ] @keyword

  ; --- functions -------------------------------------------------------
  (function_declaration (simple_identifier) @function)
  (protocol_function_declaration name: (simple_identifier) @function)
  (call_expression (simple_identifier) @function)
  (call_expression
    (navigation_expression
      (navigation_suffix (simple_identifier) @function)))
  (call_expression
    (prefix_expression (simple_identifier) @function))

  ; --- attributes (\`@objc\`, \`@available\`, custom property wrappers) ---
  (modifiers (attribute "@" (user_type (type_identifier) @function)))

  ; --- types -----------------------------------------------------------
  (type_identifier) @type
  ((navigation_expression
    (simple_identifier) @type)
    (#match? @type "^[A-Z]"))

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren
`;

registerLanguage({
  tag: 'swift',
  grammar: 'tree-sitter-swift.wasm',
  query: QUERY,
  suffixes: ['.swift'],
});
