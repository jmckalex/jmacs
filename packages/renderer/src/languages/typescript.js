/**
 * @file TypeScript — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for the
 * step-by-step.
 *
 * Built on the TypeScript grammar in `tree-sitter-typescript`; the
 * tsx grammar is *not* registered (a `.tsx` file would need its own
 * registration). The highlight query is a superset of the JavaScript
 * one — TS shares JS's structure, plus interface / type / enum and
 * the modifier keywords (public / private / protected / readonly / ...).
 *
 * Sublime-Text-style coverage: keywords, numbers, strings (with the
 * `${…}` interpolation punctuation faced separately), operators,
 * punctuation, function declarations and call sites (including methods
 * and private methods), object property keys, shorthand properties,
 * and types in class / new / extends / interface / type alias / enum
 * positions.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string) @string
  (template_string) @string
  (regex) @string
  (number) @number

  ; Template-literal interpolation punctuation reads as operator.
  (template_substitution "\${" @operator)
  (template_substitution "}" @operator)

  ; --- keywords --------------------------------------------------------
  [
    "const" "let" "var" "function" "return" "if" "else" "for" "while"
    "do" "class" "extends" "implements" "new" "import" "export" "from" "as"
    "default" "typeof" "instanceof" "in" "of" "void" "delete" "await"
    "async" "yield" "throw" "try" "catch" "finally" "switch" "case"
    "break" "continue" "static" "get" "set" "public" "private" "protected"
    "readonly" "abstract" "override" "type" "interface" "enum" "namespace"
    "module" "declare" "is" "keyof" "infer" "satisfies" "asserts"
  ] @keyword

  (this) @keyword
  (super) @keyword

  ; --- literal constants -----------------------------------------------
  [ (true) (false) (null) (undefined) ] @constant

  ; --- operators -------------------------------------------------------
  [
    "=" "+=" "-=" "*=" "/=" "%=" "**="
    "<<=" ">>=" ">>>=" "&=" "|=" "^=" "&&=" "||=" "??="
    "+" "-" "*" "/" "%" "**" "++" "--"
    "==" "===" "!=" "!==" "<" ">" "<=" ">="
    "&&" "||" "!" "??"
    "&" "|" "^" "~" "<<" ">>" ">>>"
    "=>" "?" "..."
  ] @operator
  (optional_chain) @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren

  ; --- functions -------------------------------------------------------
  (function_declaration name: (identifier) @function)
  (function_expression name: (identifier) @function)
  (method_definition name: (property_identifier) @function)
  (method_definition name: (private_property_identifier) @function)
  (call_expression function: (identifier) @function)
  (call_expression
    function: (member_expression property: (property_identifier) @function))
  (call_expression
    function: (member_expression property: (private_property_identifier) @function))

  ; Variables bound directly to a function value get the function face.
  (variable_declarator
    name: (identifier) @function
    value: [(arrow_function) (function_expression)])

  ; --- types -----------------------------------------------------------
  (class_declaration name: (type_identifier) @type)
  (interface_declaration name: (type_identifier) @type)
  (type_alias_declaration name: (type_identifier) @type)
  (enum_declaration name: (identifier) @type)
  (new_expression constructor: (identifier) @type)
  (type_identifier) @type
  (predefined_type) @type

  ; --- object literal property keys -----------------------------------
  (pair key: (property_identifier) @constant)
  (pair key: (string) @string)
  (pair key: (number) @number)
  (shorthand_property_identifier) @constant
  (shorthand_property_identifier_pattern) @constant
`;

// Foldable scopes: same as JavaScript, plus interface and enum bodies.
const FOLD_QUERY = `
  (statement_block) @fold
  (class_body) @fold
  (object) @fold
  (array) @fold
  (switch_body) @fold
  (interface_body) @fold
  (enum_body) @fold
  (object_type) @fold
`;

registerLanguage({
  tag: 'typescript',
  grammar: 'tree-sitter-typescript.wasm',
  query: QUERY,
  foldQuery: FOLD_QUERY,
  suffixes: ['.ts'],
  aliases: ['ts'],
});
