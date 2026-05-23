/**
 * @file PHP (mixed) — tree-sitter language registration.
 *
 * Files of the kind tree-sitter calls *mixed* PHP begin in HTML and
 * drop into PHP between `<?php … ?>` markers. The grammar reflects
 * that: anything outside a `<?php` block is a single `(text)` node, and
 * the injection query routes those nodes through the HTML highlighter.
 * HTML in turn injects JavaScript and CSS inside `<script>` and
 * `<style>` — so a PHP buffer transparently produces three-level
 * highlighting (PHP → HTML → JS/CSS), all under the depth cap in
 * `../treesitter.js`.
 *
 * The pure-PHP grammar (no surrounding HTML) lives in `./php-only.js`.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  (comment) @comment
  [ (string) (string_content) (encapsed_string)
    (heredoc_body) (nowdoc_body) ] @string
  (integer) @number
  (float) @number
  [ (boolean) (null) ] @constant
  [ (php_tag) (php_end_tag) ] @tag
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

const INJECTION_QUERY = `
  ((text) @injection.content (#set! injection.language "html"))
`;

registerLanguage({
  tag: 'php',
  grammar: 'tree-sitter-php.wasm',
  query: QUERY,
  suffixes: ['.php', '.phtml'],
  injectionQuery: INJECTION_QUERY,
});
