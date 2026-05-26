/**
 * @file Java — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * Sublime-Text-style coverage: keywords (incl. module-system tokens
 * `module` / `requires` / `exports` / `opens` and the post-Java-14
 * `record` / `sealed` / `permits`), strings + character literals,
 * numeric literals (decimal / hex / octal / float / hex-float),
 * operators, punctuation, method declarations and call sites,
 * annotations (`@Override` etc.) as functions, and types (declared +
 * referenced + the built-in primitive type categories).
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (line_comment) @comment
  (block_comment) @comment
  (string_literal) @string
  (character_literal) @string
  (escape_sequence) @string
  [
    (hex_integer_literal)
    (decimal_integer_literal)
    (octal_integer_literal)
    (binary_integer_literal)
    (decimal_floating_point_literal)
    (hex_floating_point_literal)
  ] @number

  ; --- keywords --------------------------------------------------------
  [
    "abstract" "assert" "break" "case" "catch" "class" "continue"
    "default" "do" "else" "enum" "exports" "extends" "final" "finally"
    "for" "if" "implements" "import" "instanceof" "interface" "module"
    "native" "new" "non-sealed" "open" "opens" "package" "permits"
    "private" "protected" "provides" "public" "requires" "record"
    "return" "sealed" "static" "strictfp" "switch" "synchronized"
    "throw" "throws" "to" "transient" "transitive" "try" "uses"
    "volatile" "when" "while" "with" "yield"
  ] @keyword

  (this) @keyword
  (super) @keyword

  ; --- literal constants -----------------------------------------------
  [ (true) (false) (null_literal) ] @constant

  ; --- operators -------------------------------------------------------
  [
    "=" "+=" "-=" "*=" "/=" "%="
    "<<=" ">>=" ">>>=" "&=" "|=" "^="
    "+" "-" "*" "/" "%" "++" "--"
    "==" "!=" "<" ">" "<=" ">="
    "&&" "||" "!"
    "&" "|" "^" "~" "<<" ">>" ">>>"
    "?" "->" "::" "@"
  ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren

  ; --- functions -------------------------------------------------------
  (method_declaration name: (identifier) @function)
  (method_invocation name: (identifier) @function)
  (constructor_declaration name: (identifier) @function)

  ; Annotations — face the annotation name as a function so \`@Override\`
  ; stands out from a bare identifier.
  (annotation name: (identifier) @function)
  (marker_annotation name: (identifier) @function)

  ; --- types -----------------------------------------------------------
  (type_identifier) @type
  (interface_declaration name: (identifier) @type)
  (class_declaration name: (identifier) @type)
  (enum_declaration name: (identifier) @type)
  [
    (boolean_type)
    (integral_type)
    (floating_point_type)
    (void_type)
  ] @type
`;

registerLanguage({
  tag: 'java',
  grammar: 'tree-sitter-java.wasm',
  query: QUERY,
  suffixes: ['.java'],
});
