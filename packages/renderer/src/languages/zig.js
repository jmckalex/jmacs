/**
 * @file Zig — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Sublime-Text-style coverage: keywords (control flow + `fn` /
 * `const` / `var` / `struct` / `enum` / `union` / `error` /
 * `comptime` / `defer` / `errdefer` / `unreachable`), strings (incl.
 * multiline `\\\\…`), char + float + integer literals, boolean +
 * null + undefined as constants, operators, builtin call expressions
 * (`@import` / `@TypeOf` / …) as functions, and call sites.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (line_comment) @comment
  (doc_comment) @comment
  (string_literal) @string
  (multiline_string_literal) @string
  (char_literal) @string
  (integer_literal) @number
  (float_literal) @number

  ; --- literal constants -----------------------------------------------
  (boolean_literal) @constant
  (null_literal) @constant
  (undefined_literal) @constant

  ; --- keywords --------------------------------------------------------
  [
    "fn" "const" "var" "struct" "enum" "union" "error" "opaque"
    "comptime" "defer" "errdefer" "return" "break" "continue"
    "if" "else" "switch" "while" "for" "and" "or" "orelse" "catch"
    "try" "async" "await" "suspend" "resume" "nosuspend" "noasync"
    "test" "pub" "extern" "export" "inline" "noinline" "callconv"
    "anyframe" "anytype" "allowzero" "packed" "linksection" "threadlocal"
    "usingnamespace" "asm" "volatile" "align" "unreachable"
  ] @keyword

  ; --- operators -------------------------------------------------------
  (assignment_operator) @operator
  [
    "=" "+" "-" "*" "/" "%" "++" "**"
    "==" "!=" "<" ">" "<=" ">="
    "&" "|" "^" "~" "<<" ">>"
    "&&" "||" "!"
    "?" ".." "..."
    "=>" "->" ".*" ".?"
  ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren

  ; --- functions -------------------------------------------------------
  (build_in_call_expr) @function
  (call_expression function: (identifier) @function)

  ; --- types -----------------------------------------------------------
  (custom_number_type) @type
  ; Capitalised identifiers — common Zig type convention.
  ((identifier) @type
   (#match? @type "^[A-Z]"))
`;

registerLanguage({
  tag: 'zig',
  grammar: 'tree-sitter-zig.wasm',
  query: QUERY,
  suffixes: ['.zig', '.zon'],
});
