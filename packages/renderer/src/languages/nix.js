/**
 * @file Nix — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Sublime-Text-style coverage: keywords (`let` / `in` / `if` / `then`
 * / `else` / `rec` / `with` / `assert` / `inherit` / `or`), strings
 * (regular + indented), path-like and URI literals as strings,
 * numbers, function call sites, and attribute paths faced as
 * functions so a `pkgs.lib.makeOverridable` chain reads at a glance.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string_expression) @string
  (indented_string_expression) @string
  (path_expression) @string
  (hpath_expression) @string
  (spath_expression) @string
  (uri_expression) @string
  (escape_sequence) @string
  (dollar_escape) @string
  (integer_expression) @number
  (float_expression) @number

  ; --- keywords --------------------------------------------------------
  [ "if" "then" "else" "let" "inherit" "in" "rec" "with" "assert" "or" ] @keyword

  ; --- literal constants -----------------------------------------------
  ((identifier) @constant
   (#match? @constant "^(true|false|null|builtins)$"))

  ; --- operators -------------------------------------------------------
  [ "=" "?" "==" "!=" "&&" "||" "->" "//" "++" "+" "-" "*" "/" "<" ">" "<=" ">=" "!" ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" "@" ] @paren

  ; --- functions -------------------------------------------------------
  (apply_expression
    function: [
      (variable_expression (identifier)) @function
      (select_expression
        attrpath: (attrpath
          attr: (identifier) @function .))
    ])
`;

registerLanguage({
  tag: 'nix',
  grammar: 'tree-sitter-nix.wasm',
  query: QUERY,
  suffixes: ['.nix'],
});
