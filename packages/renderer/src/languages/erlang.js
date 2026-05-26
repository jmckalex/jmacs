/**
 * @file Erlang — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Sublime-Text-style coverage: keywords (control flow + module / spec
 * / record / type / preprocessor `define` / `ifdef` etc.), strings,
 * atoms faced as strings (Erlang atoms read like quoted symbols),
 * numbers + char literals, operators (`!` / `->` / `<-` / `::` / `==`
 * / `=:=` / `++` / `--` etc. plus boolean `andalso` / `orelse`),
 * punctuation, function definitions and call sites, types via record
 * declarations, and macro calls as constants / keywords.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string) @string
  (atom) @string
  (char) @number
  (integer) @number
  (float) @number

  ; --- keywords --------------------------------------------------------
  [
    "after" "and" "band" "begin" "behavior" "behaviour" "bnot" "bor"
    "bsl" "bsr" "bxor" "callback" "case" "catch" "compile" "define"
    "div" "elif" "else" "end" "endif" "export" "export_type" "file"
    "fun" "if" "ifdef" "ifndef" "import" "include" "include_lib"
    "module" "of" "opaque" "optional_callbacks" "or" "receive" "record"
    "spec" "try" "type" "undef" "unit" "when" "xor"
    "andalso" "orelse" "not" "rem"
  ] @keyword

  ; --- operators -------------------------------------------------------
  [
    "!" "->" "<-" "#" "::" ":>" "|" ":" "=" "||"
    "+" "-" "*" "/" "++" "--"
    "==" "/=" "=<" "<" ">=" ">" "=:=" "=/="
  ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "{" "}" "[" "]" "<<" ">>" ] @paren

  ; --- functions -------------------------------------------------------
  (function_clause name: (atom) @function)
  (call expr: (atom) @function)
  (fa fun: (atom) @function)
  (internal_fun fun: (atom) @function)
  (remote fun: (atom) @function)
  (type_name name: (atom) @function)
  (spec fun: (atom) @function)
  (callback fun: (atom) @function)

  ; --- types / modules -------------------------------------------------
  (record_decl name: (atom) @type)
  (record_name name: (atom) @type)
  (remote_module module: (atom) @type)
  (module_attribute name: (atom) @type)
  (import_attribute module: (atom) @type)

  ; --- constants / macros ---------------------------------------------
  (macro_call_expr name: (var) @constant)
  (macro_call_expr name: (atom) @constant)
  (var) @type
`;

registerLanguage({
  tag: 'erlang',
  grammar: 'tree-sitter-erlang.wasm',
  query: QUERY,
  suffixes: ['.erl', '.hrl', '.escript'],
});
