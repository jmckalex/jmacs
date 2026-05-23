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
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  (comment) @comment
  (string) @string
  (template_string) @string
  (regex) @string
  (number) @number
  [
    "const" "let" "var" "function" "return" "if" "else" "for" "while"
    "do" "class" "extends" "new" "import" "export" "from" "as" "default"
    "typeof" "instanceof" "in" "of" "void" "delete" "await" "async"
    "yield" "throw" "try" "catch" "finally" "switch" "case" "break"
    "continue" "static" "get" "set"
  ] @keyword
  [ (true) (false) (null) (undefined) ] @constant
  (function_declaration name: (identifier) @function)
  (method_definition name: (property_identifier) @function)
  (call_expression function: (identifier) @function)
  (call_expression
    function: (member_expression property: (property_identifier) @function))
  (class_declaration name: (identifier) @type)
  (new_expression constructor: (identifier) @type)
`;

registerLanguage({
  tag: 'javascript',
  grammar: 'tree-sitter-javascript.wasm',
  query: QUERY,
  suffixes: ['.js', '.mjs'],
  aliases: ['js', 'mjs', 'node'],
});
