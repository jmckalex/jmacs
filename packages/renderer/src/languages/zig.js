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
  ; The vendored tree-sitter-zig ships a grammar that exposes many
  ; Zig keywords only as named nodes -- no anonymous token form.
  ; The list below is the subset that DOES have anonymous tokens
  ; (verified against the regenerated parser). The rest face via
  ; their semantic faces (functions, types, etc.).
  [
    "fn" "const" "var" "struct" "enum" "union" "error"
    "comptime" "defer" "errdefer" "return" "break" "continue"
    "if" "else" "switch" "while" "for"
    "try" "await" "suspend" "resume"
    "test" "pub" "extern" "export" "inline"
    "allowzero" "usingnamespace" "volatile" "align"
  ] @keyword

  ; --- operators -------------------------------------------------------
  ; Most Zig binary / comparison / bitwise operators are exposed
  ; through named nodes only -- the regenerated parser folds them
  ; into binary_expression. The list here is the subset that DOES
  ; have anonymous tokens.
  (assignment_operator) @operator
  [
    "=" "-" "*" "&" "|" "~" "!" "?"
    ".." "..." "=>" ".*" ".?"
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
