/**
 * @file PHP (pure) — tree-sitter language registration for files that
 * contain only PHP, with no surrounding HTML or opening `<?php` tag.
 *
 * The `.phps` extension — "PHP source", the traditional
 * syntax-highlighted-source form — picks this grammar. No injection:
 * the body is PHP all the way down.
 *
 * The mixed grammar (HTML + `<?php … ?>`) is in `./php.js`.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  (comment) @comment
  [ (string) (string_content) (encapsed_string)
    (heredoc_body) (nowdoc_body) ] @string
  (integer) @number
  (float) @number
  [ (boolean) (null) ] @constant
  [
    "and" "as" "break" "case" "catch" "class" "clone" "const" "continue"
    "declare" "default" "do" "echo" "else" "elseif" "enddeclare" "endfor"
    "endforeach" "endif" "endswitch" "endwhile" "enum" "exit" "extends"
    "finally" "fn" "for" "foreach" "function" "global" "goto" "if"
    "implements" "include" "include_once" "instanceof" "insteadof"
    "interface" "match" "namespace" "new" "or" "print" "require"
    "require_once" "return" "static" "switch" "throw" "trait" "try"
    "use" "while" "xor" "yield"
  ] @keyword
  (variable_name) @constant
  (function_definition name: (name) @function)
  (method_declaration name: (name) @function)
  (function_call_expression
    function: [ (name) (qualified_name (name)) ] @function)
  (member_call_expression name: (name) @function)
  (scoped_call_expression name: (name) @function)
  (primitive_type) @type
  (cast_type) @type
  (named_type (name) @type)
`;

// Foldable PHP scopes — same set as the mixed grammar (`./php.js`).
// Brace-delimited bodies collapse to `{…}`; the alternative-syntax
// control structures fold line-based via their `colon_block` body.
const FOLD_QUERY = `
  (compound_statement) @fold.inner
  (declaration_list) @fold.inner
  (enum_declaration_list) @fold.inner
  (match_block) @fold.inner
  (if_statement body: (colon_block)) @fold
  (foreach_statement body: (colon_block)) @fold
  (while_statement body: (colon_block)) @fold
  (switch_statement body: (switch_block)) @fold
`;

registerLanguage({
  tag: 'php_only',
  grammar: 'tree-sitter-php_only.wasm',
  query: QUERY,
  suffixes: ['.phps'],
  foldQuery: FOLD_QUERY,
});
