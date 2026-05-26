/**
 * @file Haskell — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Sublime-Text-style coverage: keywords (control flow + `data` /
 * `newtype` / `class` / `instance` / `module` / `import` / `where` /
 * `let` / `in` / `do` / etc.), strings + char literals, numbers,
 * operators (named `(operator)` node plus the symbolic tokens),
 * pragmas, top-level function names, and constructors / type names
 * (capitalised `(name)`).
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (haddock) @comment
  (string) @string
  (char) @string
  (integer) @number
  (float) @number

  ; --- keywords --------------------------------------------------------
  [
    "if" "then" "else" "case" "of"
    "import" "qualified" "module"
    "where" "let" "in" "class" "instance" "pattern"
    "data" "newtype" "family" "type" "as" "hiding"
    "deriving" "via" "stock" "anyclass"
    "do" "mdo" "rec"
    "infix" "infixl" "infixr" "forall"
  ] @keyword

  (pragma) @keyword

  ; --- literal constants -----------------------------------------------
  (unit) @constant

  ; --- operators -------------------------------------------------------
  (operator) @operator
  (constructor_operator) @operator
  (all_names) @operator
  [ "." ".." "=" "|" "::" "=>" "->" "<-" "\\\\" "\`" "@" ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren

  ; --- functions -------------------------------------------------------
  (decl/function name: (variable) @function)
  (decl/signature name: (variable) @function)

  ; --- types -----------------------------------------------------------
  ; Type / constructor names — capitalised identifiers.
  (name) @type
  (module (module_id) @type)
`;

registerLanguage({
  tag: 'haskell',
  grammar: 'tree-sitter-haskell.wasm',
  query: QUERY,
  suffixes: ['.hs'],
  aliases: ['hs'],
});
