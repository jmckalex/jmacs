/**
 * @file C — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * Sublime-Text-style coverage: keywords (control flow + storage classes
 * + `sizeof` + preprocessor directives faced as keywords), strings
 * (including `<header.h>` system-lib strings), numbers (incl. char
 * literals), arithmetic / comparison / bitwise / pointer operators,
 * punctuation, function declarations and call sites (incl. member
 * function calls via field_expression), preprocessor function-style
 * macro definitions, and type names (struct / enum / typedef / primitive
 * / sized type specifiers).
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string_literal) @string
  (system_lib_string) @string
  (char_literal) @number
  (number_literal) @number

  ; --- keywords --------------------------------------------------------
  [
    "break" "case" "const" "continue" "default" "do" "else" "enum"
    "extern" "for" "goto" "if" "inline" "register" "restrict" "return"
    "sizeof" "static" "struct" "switch" "typedef" "union" "volatile"
    "while" "auto" "_Atomic" "_Alignas" "_Alignof" "_Noreturn"
  ] @keyword

  ; Preprocessor directives — these are anonymous tokens.
  [ "#define" "#elif" "#else" "#endif" "#if" "#ifdef" "#ifndef" "#include" ] @keyword
  (preproc_directive) @keyword

  ; --- literal constants -----------------------------------------------
  [ (true) (false) (null) ] @constant

  ; --- operators -------------------------------------------------------
  [
    "=" "+=" "-=" "*=" "/=" "%="
    "<<=" ">>=" "&=" "|=" "^="
    "+" "-" "*" "/" "%" "++" "--"
    "==" "!=" "<" ">" "<=" ">="
    "&&" "||" "!"
    "&" "|" "^" "~" "<<" ">>"
    "->" "?"
  ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren

  ; --- functions -------------------------------------------------------
  (function_declarator declarator: (identifier) @function)
  (call_expression function: (identifier) @function)
  (call_expression
    function: (field_expression field: (field_identifier) @function))
  (preproc_function_def name: (identifier) @function)

  ; --- types -----------------------------------------------------------
  (type_identifier) @type
  (primitive_type) @type
  (sized_type_specifier) @type
`;

registerLanguage({
  tag: 'c',
  grammar: 'tree-sitter-c.wasm',
  query: QUERY,
  suffixes: ['.c', '.h'],
});
