/**
 * @file Kotlin — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Sublime-Text-style coverage: keywords (control flow + `val` / `var`
 * / `fun` / `class` / `object` / `interface` / `enum` / `typealias`
 * + the family of modifier nodes), strings (regular + character +
 * escape), numbers (decimal / hex / bin / long / float), boolean +
 * null as constants, operators (incl. `?.` / `?:` / `!!` /
 * range `..` / `is` / `as` / `as?`), function declarations and call
 * sites (including method calls via `navigation_expression`), and
 * type identifiers.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  [ (line_comment) (multiline_comment) (shebang_line) ] @comment
  (string_literal) @string
  (character_literal) @string
  (character_escape_seq) @string
  [
    (integer_literal) (long_literal) (hex_literal) (bin_literal)
    (unsigned_literal) (real_literal)
  ] @number

  ; --- keywords --------------------------------------------------------
  [
    (class_modifier) (member_modifier) (function_modifier)
    (property_modifier) (platform_modifier) (variance_modifier)
    (parameter_modifier) (visibility_modifier) (reification_modifier)
    (inheritance_modifier)
  ] @keyword
  [
    "val" "var" "enum" "class" "object" "interface" "fun" "typealias"
    "if" "else" "when" "for" "do" "while" "try" "catch" "throw"
    "finally" "import" "package" "constructor" "init" "get" "set"
    "by" "where"
  ] @keyword
  (jump_expression) @keyword

  ; --- literal constants -----------------------------------------------
  [ (boolean_literal) "null" ] @constant
  (this_expression) @keyword
  (super_expression) @keyword

  ; --- operators -------------------------------------------------------
  [
    "!" "!=" "!==" "=" "==" "===" ">" ">=" "<" "<=" "||" "&&"
    "+" "++" "+=" "-" "--" "-=" "*" "*=" "/" "/=" "%" "%="
    "?." "?:" "!!" "is" "!is" "in" "!in" "as" "as?" ".." "->"
  ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren

  ; --- functions -------------------------------------------------------
  (function_declaration . (simple_identifier) @function)
  (call_expression . (simple_identifier) @function)
  (call_expression
    (navigation_expression
      (navigation_suffix (simple_identifier) @function) . ))

  ; Annotations.
  (annotation (user_type (type_identifier) @function))
  (annotation
    (constructor_invocation (user_type (type_identifier) @function)))

  ; --- types -----------------------------------------------------------
  (type_identifier) @type
`;

registerLanguage({
  tag: 'kotlin',
  grammar: 'tree-sitter-kotlin.wasm',
  query: QUERY,
  suffixes: ['.kt', '.kts'],
  aliases: ['kt'],
});
