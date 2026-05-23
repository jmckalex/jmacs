/**
 * @file Bash — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  (comment) @comment
  (string) @string
  (raw_string) @string
  (heredoc_body) @string
  (number) @number
  [
    "if" "then" "else" "elif" "fi"
    "case" "esac" "in"
    "for" "while" "do" "done" "until"
    "function" "select"
  ] @keyword
  (function_definition name: (word) @function)
  (command_name (word) @function)
  (variable_name) @type
  (simple_expansion (variable_name) @type)
  (expansion (variable_name) @type)
`;

registerLanguage({
  tag: 'bash',
  grammar: 'tree-sitter-bash.wasm',
  query: QUERY,
  suffixes: ['.sh', '.bash'],
});
