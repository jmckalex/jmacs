/**
 * @file C# — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * Sublime-Text-style coverage: keywords (incl. modifiers via the
 * `(modifier)` named node, contextual keywords like `var` /
 * `record` / `init`, plus LINQ keywords `from` / `where` / `select`),
 * strings (incl. raw, verbatim, and interpolated forms), numbers,
 * arithmetic / comparison / bitwise / null-coalescing operators,
 * punctuation, method declarations / call sites, constructors,
 * attributes (`[Required]`) as functions, and types (interface /
 * class / enum / struct / record / namespace / generic / parameter /
 * predefined).
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string_literal) @string
  (raw_string_literal) @string
  (verbatim_string_literal) @string
  (character_literal) @string
  (interpolated_string_expression) @string
  (escape_sequence) @string
  (integer_literal) @number
  (real_literal) @number

  ; --- keywords --------------------------------------------------------
  (modifier) @keyword
  (implicit_type) @keyword
  [
    "add" "alias" "as" "base" "break" "case" "catch" "checked" "class"
    "continue" "default" "delegate" "do" "else" "enum" "event"
    "explicit" "extern" "finally" "for" "foreach" "global" "goto" "if"
    "implicit" "interface" "is" "lock" "namespace" "notnull" "operator"
    "params" "return" "remove" "sizeof" "stackalloc" "static" "struct"
    "switch" "this" "throw" "try" "typeof" "unchecked" "using" "while"
    "new" "await" "in" "yield" "get" "set" "when" "out" "ref" "from"
    "where" "select" "record" "init" "with" "let"
  ] @keyword

  ; --- literal constants -----------------------------------------------
  [ (boolean_literal) (null_literal) ] @constant

  ; --- operators -------------------------------------------------------
  [
    "=" "+=" "-=" "*=" "/=" "%="
    "<<=" ">>=" ">>>=" "&=" "|=" "^=" "??="
    "+" "-" "*" "/" "%" "++" "--"
    "==" "!=" "<" ">" "<=" ">="
    "&&" "||" "!" "??"
    "&" "|" "^" "~" "<<" ">>" ">>>"
    "=>" "?" ".."
  ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren

  ; --- functions -------------------------------------------------------
  (method_declaration name: (identifier) @function)
  (local_function_statement name: (identifier) @function)
  (constructor_declaration name: (identifier) @function)
  (destructor_declaration name: (identifier) @function)
  (invocation_expression
    (member_access_expression name: (identifier) @function))
  (invocation_expression function: (identifier) @function)

  ; Attributes — \`[Serializable]\` etc.
  (attribute name: (identifier) @function)

  ; --- types -----------------------------------------------------------
  (predefined_type) @type
  (interface_declaration name: (identifier) @type)
  (class_declaration name: (identifier) @type)
  (enum_declaration name: (identifier) @type)
  (struct_declaration (identifier) @type)
  (record_declaration (identifier) @type)
  (generic_name (identifier) @type)
  (type_argument_list (identifier) @type)
  (base_list (identifier) @type)
`;

registerLanguage({
  tag: 'csharp',
  grammar: 'tree-sitter-csharp.wasm',
  query: QUERY,
  suffixes: ['.cs', '.csx'],
  aliases: ['cs', 'c#'],
});
