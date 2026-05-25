/**
 * @file JavaScript — tree-sitter language registration.
 *
 * This is the canonical example of "how to add a language", together
 * with `../../../stdlib/lisp/languages/javascript.lisp`. Three pieces:
 *
 *   1. A `.wasm` grammar in `packages/renderer/vendor/`.
 *   2. This JS module, which calls `registerLanguage` with the grammar
 *      filename, the highlight query (which tree-sitter node names map
 *      to which face), and the file suffixes that pick the language.
 *   3. A Lisp mode file in `packages/stdlib/lisp/languages/<tag>.lisp`
 *      that calls `define-mode` and `register-mode`.
 *
 * No other file is touched. See `../language-registry.js` for the API
 * and `./README.md` for the step-by-step.
 *
 * The highlight query targets Sublime-Text-style coverage: keywords,
 * numbers, strings (with the `${…}` interpolation punctuation faced
 * separately), operators, punctuation, function declarations and call
 * sites (including methods and private methods), object property keys,
 * shorthand properties, and types in class / new / extends positions.
 * Variables bound to a function or arrow are faced as functions so
 * `const foo = () => {}` reads at a glance.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string) @string
  (template_string) @string
  (regex) @string
  (number) @number

  ; Template-literal interpolation: the \${ … } punctuation reads as an
  ; operator so embedded expressions stand out from the string body.
  (template_substitution "\${" @operator)
  (template_substitution "}" @operator)

  ; --- keywords --------------------------------------------------------
  [
    "const" "let" "var" "function" "return" "if" "else" "for" "while"
    "do" "class" "extends" "new" "import" "export" "from" "as" "default"
    "typeof" "instanceof" "in" "of" "void" "delete" "await" "async"
    "yield" "throw" "try" "catch" "finally" "switch" "case" "break"
    "continue" "static" "get" "set" "debugger"
  ] @keyword

  ; this / super read as language-built-in variables; group with keywords.
  (this) @keyword
  (super) @keyword

  ; --- literal constants ----------------------------------------------
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
  ; Declarations and named expressions.
  (function_declaration name: (identifier) @function)
  (function_expression name: (identifier) @function)

  ; Class and object methods, including private (#-prefixed) methods.
  (method_definition name: (property_identifier) @function)
  (method_definition name: (private_property_identifier) @function)

  ; Call sites.
  (call_expression function: (identifier) @function)
  (call_expression
    function: (member_expression property: (property_identifier) @function))
  (call_expression
    function: (member_expression property: (private_property_identifier) @function))

  ; Variables bound directly to a function value — give the binding name
  ; the function face so \`const foo = () => …\` reads consistently with
  ; a function declaration.
  (variable_declarator
    name: (identifier) @function
    value: [(arrow_function) (function_expression)])

  ; --- variables -------------------------------------------------------
  ; Function/method/arrow parameters and catch bindings. Plain
  ; declarations only — references in the body stay unfaced
  ; (Sublime-style). Defaults, rest, and destructuring covered below.
  (formal_parameters (identifier) @variable)
  (formal_parameters (rest_pattern (identifier) @variable))
  (formal_parameters
    (assignment_pattern left: (identifier) @variable))
  (arrow_function parameter: (identifier) @variable)
  (catch_clause parameter: (identifier) @variable)

  ; --- types -----------------------------------------------------------
  (class_declaration name: (identifier) @type)
  (new_expression constructor: (identifier) @type)
  (class_heritage (identifier) @type)

  ; --- object literal property keys -----------------------------------
  (pair key: (property_identifier) @constant)
  (pair key: (string) @string)
  (pair key: (number) @number)
  (shorthand_property_identifier) @constant
  (shorthand_property_identifier_pattern) @constant
`;

// Foldable scopes: function/method/class bodies (captured via the
// containing `statement_block`), object and array literals, and
// `switch`. Capturing the body — not its parent — keeps the header
// line visible.
const FOLD_QUERY = `
  (statement_block) @fold
  (class_body) @fold
  (object) @fold
  (array) @fold
  (switch_body) @fold
`;

registerLanguage({
  tag: 'javascript',
  grammar: 'tree-sitter-javascript.wasm',
  query: QUERY,
  foldQuery: FOLD_QUERY,
  suffixes: ['.js', '.mjs'],
  aliases: ['js', 'mjs', 'node'],
});
