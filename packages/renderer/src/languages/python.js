/**
 * @file Python — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * Sublime-Text-style coverage: keywords (including the soft `match`/`case`
 * keywords), constants (`None`/`True`/`False`), arithmetic / comparison /
 * bitwise / augmented operators plus `->` / `:=` / `...`, punctuation
 * `(){}[]`, function declarations / calls / method calls, decorators,
 * and class / type-annotation positions.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string) @string
  (integer) @number
  (float) @number

  ; --- keywords --------------------------------------------------------
  [
    "as" "assert" "async" "await" "break" "class" "continue" "def" "del"
    "elif" "else" "except" "finally" "for" "from" "global" "if" "import"
    "lambda" "nonlocal" "pass" "raise" "return" "try" "while" "with"
    "yield" "match" "case"
  ] @keyword
  [ "and" "in" "is" "not" "or" ] @keyword

  ; --- literal constants -----------------------------------------------
  [ (none) (true) (false) ] @constant

  ; --- operators -------------------------------------------------------
  [
    "=" "+=" "-=" "*=" "/=" "//=" "%=" "**="
    "<<=" ">>=" "&=" "|=" "^=" "@="
    "+" "-" "*" "/" "//" "%" "**" "@"
    "==" "!=" "<" ">" "<=" ">="
    "&" "|" "^" "~" "<<" ">>"
    "->" ":="
  ] @operator
  (ellipsis) @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren

  ; --- member properties / parameters (Nova-style densification) ------
  ; obj.attr / self.x → @property; def parameters (positional, default,
  ; typed, *args/**kwargs) → @variable. Placed BEFORE the call rules so a
  ; method call (obj.method()) resolves to @function: equal-span ties go
  ; to the LATER query pattern (see runs.js flattenInnermost).
  (attribute attribute: (identifier) @property)
  (parameters (identifier) @variable)
  (parameters (default_parameter name: (identifier) @variable))
  (parameters (typed_parameter (identifier) @variable))
  (parameters (typed_default_parameter name: (identifier) @variable))
  (parameters (list_splat_pattern (identifier) @variable))
  (parameters (dictionary_splat_pattern (identifier) @variable))

  ; --- functions -------------------------------------------------------
  (function_definition name: (identifier) @function)
  (call function: (identifier) @function)
  (call function: (attribute attribute: (identifier) @function))

  ; --- decorators ------------------------------------------------------
  ; Whole decorator line reads as a function reference; the inner
  ; identifier nodes will still receive the @function face on their own
  ; from the call pattern above when the decorator is invoked.
  (decorator) @function

  ; --- types -----------------------------------------------------------
  (class_definition name: (identifier) @type)
  (type (identifier) @type)
`;

// Python folds at indented blocks — every `def`, `class`, `if`, `for`,
// `while`, `try`, `with`, `match` opens a `block` child. Capturing the
// block keeps the header line ("def foo():") visible.
const FOLD_QUERY = `
  (block) @fold
`;

registerLanguage({
  tag: 'python',
  grammar: 'tree-sitter-python.wasm',
  query: QUERY,
  foldQuery: FOLD_QUERY,
  suffixes: ['.py'],
  aliases: ['py', 'python3'],
});
