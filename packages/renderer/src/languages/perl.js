/**
 * @file Perl — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * Covers the major Perl constructs: control-flow keywords (`if` /
 * `unless` / `while` / `until` / `for` / `foreach` / `last` / `next`
 * / `redo` / `goto` / `return`), declaration words (`my` / `our` /
 * `local` / `state` / `sub` / `package` / `use` / `no` / `require`),
 * string literals including interpolated forms, heredocs and the
 * various `q`/`qq`/`qw`/`qr` quoted forms, regex match / replacement /
 * transliteration bodies, sigil-led variables (faced as types so
 * `$scalar` / `@array` / `%hash` read like Java-style references),
 * and the built-in operators including the word operators (`eq`/`ne`/
 * `lt`/`gt`/`cmp`/`and`/`or`/`xor`/`not`/`isa`).
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / pod / data ------------------------------------------
  (comment) @comment
  (pod) @comment
  (data_section) @comment
  (eof_marker) @comment

  ; --- strings ---------------------------------------------------------
  (string_literal) @string
  (interpolated_string_literal) @string
  (quoted_word_list) @string
  (command_string) @string
  (heredoc_content) @string
  (heredoc_token) @string
  (heredoc_end) @string
  (command_heredoc_token) @string
  (replacement) @string
  (transliteration_content) @string
  (escape_sequence) @string
  (escaped_delimiter) @string
  (quoted_regexp) @string
  (match_regexp) @string
  (regexp_content) @string

  ; --- numbers ---------------------------------------------------------
  (number) @number
  (version) @number

  ; --- keywords --------------------------------------------------------
  [ "use" "no" "require" ] @keyword
  [ "if" "elsif" "unless" "else" ] @keyword
  [ "while" "until" "for" "foreach" ] @keyword
  [ "try" "catch" "finally" ] @keyword
  [ "sub" "method" "async" "extended" ] @keyword
  [ "package" "class" "role" ] @keyword
  "return" @keyword
  [
    "defer"
    "do" "eval"
    "my" "our" "local" "dynamically" "state" "field"
    "last" "next" "redo" "goto"
    "undef" "await"
  ] @keyword

  (yadayada) @keyword

  ; Phase markers (BEGIN / END / INIT / CHECK / UNITCHECK).
  (phaser_statement phase: _ @keyword)
  (class_phaser_statement phase: _ @keyword)

  ; --- operators -------------------------------------------------------
  (_ operator: _ @operator)
  "\\\\" @operator
  [
    "or" "xor" "and"
    "eq" "ne" "cmp" "lt" "le" "ge" "gt"
    "isa"
  ] @keyword

  ; --- types -----------------------------------------------------------
  ; Package names — \`package\` / \`use\` / \`require\` / \`class\` targets.
  (use_statement (package) @type)
  (package_statement (package) @type)
  (class_statement (package) @type)
  (require_expression (bareword) @type)
  (relational_expression operator: "isa" right: (bareword) @type)
  (method_call_expression invocant: (bareword) @type)

  ; --- functions -------------------------------------------------------
  (subroutine_declaration_statement name: (bareword) @function)
  (method_declaration_statement name: (bareword) @function)
  (function) @function
  (function_call_expression (function) @function)
  (method_call_expression (method) @function)
  (func0op_call_expression function: _ @function)
  (func1op_call_expression function: _ @function)
  (amper_deref_expression "&" @function)

  ; Builtins that read as functions in code: \`map\`, \`grep\`, \`sort\`,
  ; plus the long list of named-unary / list operators from the
  ; bundled query. Keep this short; the catch-all (function) above
  ; covers the rest.
  [ "map" "grep" "sort" ] @function

  ; --- variables (sigils + names) --------------------------------------
  ; Sigil-led variables read as types — the same convention the other
  ; capitalised-identifier-heavy languages use (Ruby constants, Java
  ; class names) to make them stand out.
  (scalar) @type
  (array) @type
  (arraylen) @type
  (hash) @type
  (glob) @type
  (varname) @type
  (filehandle) @type

  ; --- punctuation -----------------------------------------------------
  [ "[" "]" "{" "}" "(" ")" ] @paren
  [ "=>" "," ";" "->" ] @paren
`;

const FOLD_QUERY = `
  (block) @fold
  (subroutine_declaration_statement) @fold
  (method_declaration_statement) @fold
  (anonymous_subroutine_expression) @fold
  (package_statement) @fold
  (class_statement) @fold
`;

registerLanguage({
  tag: 'perl',
  grammar: 'tree-sitter-perl.wasm',
  query: QUERY,
  foldQuery: FOLD_QUERY,
  suffixes: ['.pl', '.pm', '.t', '.psgi', '.perl'],
  aliases: ['pl', 'pm'],
});
