/**
 * @file Python — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  (comment) @comment
  (string) @string
  (integer) @number
  (float) @number
  [
    "as" "assert" "async" "await" "break" "class" "continue" "def" "del"
    "elif" "else" "except" "finally" "for" "from" "global" "if" "import"
    "lambda" "nonlocal" "pass" "raise" "return" "try" "while" "with"
    "yield" "match" "case"
  ] @keyword
  [ "and" "in" "is" "not" "or" ] @keyword
  [ (none) (true) (false) ] @constant
  (function_definition name: (identifier) @function)
  (call function: (identifier) @function)
  (call function: (attribute attribute: (identifier) @function))
  (decorator (identifier) @function)
  (type (identifier) @type)
`;

registerLanguage({
  tag: 'python',
  grammar: 'tree-sitter-python.wasm',
  query: QUERY,
  suffixes: ['.py'],
  aliases: ['py', 'python3'],
});
