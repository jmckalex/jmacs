/**
 * @file Lua — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * Sublime-Text-style coverage: keywords (control flow + `function` /
 * `local` / `return` / boolean `and` / `or` / `not`), strings (incl.
 * the `[[ … ]]` long-bracket form), numbers, operators (the named
 * `binary_expression` / `unary_expression` operator children), punctuation,
 * function declarations (incl. method `:` form and dot-indexed) and call
 * sites, and capitalised identifiers faced as constants.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string) @string
  (escape_sequence) @string
  (number) @number

  ; --- keywords --------------------------------------------------------
  [
    "and" "break" "do" "else" "elseif" "end" "false" "for" "function"
    "goto" "if" "in" "local" "nil" "not" "or" "repeat" "return" "then"
    "true" "until" "while"
  ] @keyword

  ; --- literal constants -----------------------------------------------
  [ (true) (false) (nil) ] @constant
  (vararg_expression) @constant

  ; --- operators -------------------------------------------------------
  ; Lua's grammar exposes binary/unary operator children as the
  ; anonymous tokens — the simple alternation below is what tree-sitter
  ; matches. (The grammar's own scm uses operator: _ which we can't
  ; replicate with named captures only.)
  [
    "+" "-" "*" "/" "//" "%" "^"
    "==" "~=" "<" ">" "<=" ">="
    ".." "#" "="
  ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren

  ; --- functions -------------------------------------------------------
  (function_declaration
    name: [
      (identifier) @function
      (dot_index_expression field: (identifier) @function)
      (method_index_expression method: (identifier) @function)
    ])
  (function_call
    name: [
      (identifier) @function
      (dot_index_expression field: (identifier) @function)
      (method_index_expression method: (identifier) @function)
    ])

  ; Variable bound to a function literal — \`local foo = function () … end\`.
  (assignment_statement
    (variable_list .
      name: [
        (identifier) @function
        (dot_index_expression field: (identifier) @function)
      ])
    (expression_list .
      value: (function_definition)))

  ; --- types / constants ----------------------------------------------
  ; All-caps identifiers as constants (idiomatic Lua); table fields as
  ; constants so dot-keys read as data.
  ((identifier) @constant
    (#match? @constant "^[A-Z][A-Z_0-9]*$"))
  (dot_index_expression field: (identifier) @constant)
`;

registerLanguage({
  tag: 'lua',
  grammar: 'tree-sitter-lua.wasm',
  query: QUERY,
  suffixes: ['.lua'],
});
