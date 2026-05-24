/**
 * @file Go — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * Sublime-Text-style coverage: keywords, numbers (int / float /
 * imaginary), strings (interpreted / raw / rune / escape sequences),
 * arithmetic / comparison / bitwise / channel operators plus the `:=`
 * short-variable declaration, punctuation, function declarations and
 * call sites (incl. methods via selector_expression), and type
 * declarations / aliases / uses.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (interpreted_string_literal) @string
  (raw_string_literal) @string
  (rune_literal) @string
  (escape_sequence) @string
  (int_literal) @number
  (float_literal) @number
  (imaginary_literal) @number

  ; --- keywords --------------------------------------------------------
  [
    "break" "case" "chan" "const" "continue" "default" "defer" "else"
    "fallthrough" "for" "func" "go" "goto" "if" "import" "interface"
    "map" "package" "range" "return" "select" "struct" "switch" "type"
    "var"
  ] @keyword

  ; --- literal constants -----------------------------------------------
  [ (true) (false) (nil) (iota) ] @constant

  ; --- operators -------------------------------------------------------
  [
    "=" ":=" "+=" "-=" "*=" "/=" "%="
    "<<=" ">>=" "&=" "|=" "^=" "&^="
    "+" "-" "*" "/" "%" "++" "--"
    "==" "!=" "<" ">" "<=" ">="
    "&&" "||" "!"
    "&" "|" "^" "<<" ">>" "&^"
    "<-" "..."
  ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren

  ; --- functions -------------------------------------------------------
  (function_declaration name: (identifier) @function)
  (method_declaration name: (field_identifier) @function)
  (call_expression function: (identifier) @function)
  (call_expression function: (selector_expression field: (field_identifier) @function))

  ; --- types -----------------------------------------------------------
  (type_spec name: (type_identifier) @type)
  (type_alias name: (type_identifier) @type)
  (type_identifier) @type
`;

registerLanguage({
  tag: 'go',
  grammar: 'tree-sitter-go.wasm',
  query: QUERY,
  suffixes: ['.go'],
});
