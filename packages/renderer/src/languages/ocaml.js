/**
 * @file OCaml — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Sublime-Text-style coverage: keywords (the full ML surface — `let`
 * / `rec` / `in` / `module` / `functor` / `struct` / `sig` / `match`
 * / `with` / `function` / `fun` / `type` / `val` / `class` / `object`
 * etc.), strings (incl. quoted strings, characters, conversion
 * specifications), numbers, the family of named operator nodes
 * (`prefix_operator` / `add_operator` / `mult_operator` / …),
 * punctuation, `let` bindings as functions, application-position
 * function names, type constructors and class names as types, and
 * variants / constructors as constants.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  [(comment) (line_number_directive) (directive) (shebang)] @comment
  (string) @string
  (character) @string
  (escape_sequence) @string
  (conversion_specification) @string
  (number) @number
  (signed_number) @number

  ; --- keywords --------------------------------------------------------
  [
    "and" "as" "assert" "begin" "class" "constraint" "do" "done" "downto"
    "effect" "else" "end" "exception" "external" "for" "fun" "function"
    "functor" "if" "in" "include" "inherit" "initializer" "lazy" "let"
    "match" "method" "module" "mutable" "new" "nonrec" "object" "of"
    "open" "private" "rec" "sig" "struct" "then" "to" "try" "type"
    "val" "virtual" "when" "while" "with"
  ] @keyword

  ; --- literal constants -----------------------------------------------
  (boolean) @constant
  ; Variants / data constructors as constants — e.g. \`Some\` / \`None\`.
  (constructor_name) @constant
  (tag) @constant

  ; --- operators -------------------------------------------------------
  [
    (prefix_operator) (sign_operator) (pow_operator) (mult_operator)
    (add_operator) (concat_operator) (rel_operator) (and_operator)
    (or_operator) (assign_operator) (hash_operator) (indexing_operator)
    (let_operator) (let_and_operator) (match_operator)
  ] @operator

  [ "*" "#" "::" "<-" "->" ";;" ":>" "+=" ":=" ".." "=" "|" "?" "~" ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" "[|" "|]" "[<" "[>" ] @paren

  ; --- functions -------------------------------------------------------
  (let_binding pattern: (value_name) @function (parameter))
  (let_binding
    pattern: (value_name) @function
    body: [ (fun_expression) (function_expression) ])
  (value_specification (value_name) @function)
  (external (value_name) @function)
  (method_name) @function
  (application_expression function: (value_path (value_name) @function))

  ; --- types -----------------------------------------------------------
  (class_name) @type
  (class_type_name) @type
  (type_constructor) @type
  (module_name) @type
  (module_type_name) @type
`;

registerLanguage({
  tag: 'ocaml',
  grammar: 'tree-sitter-ocaml.wasm',
  query: QUERY,
  suffixes: ['.ml', '.mli'],
});
