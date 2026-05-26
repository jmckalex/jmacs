/**
 * @file C++ — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * Sublime-Text-style coverage: keywords (C plus C++ extensions:
 * `class` / `template` / `namespace` / `using` / `new` / `delete` /
 * `try` / `catch` / `throw` / access specifiers / `co_*` coroutines /
 * `constexpr` family), strings (incl. raw `R"…(…)…"`), numbers,
 * arithmetic / comparison / bitwise / pointer operators plus C++
 * extras (`::`, `->*`, `.*`), punctuation, function declarations and
 * call sites (incl. qualified, template, method, field call sites),
 * and types.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string_literal) @string
  (raw_string_literal) @string
  (system_lib_string) @string
  (char_literal) @number
  (number_literal) @number

  ; --- keywords --------------------------------------------------------
  ; C inherited keywords.
  [
    "break" "case" "const" "continue" "default" "do" "else" "enum"
    "extern" "for" "goto" "if" "inline" "register" "restrict" "return"
    "sizeof" "static" "struct" "switch" "typedef" "union" "volatile"
    "while"
  ] @keyword
  ; The 'auto' keyword is a named node in this version of
  ; tree-sitter-cpp (no anonymous "auto" token exists), so query
  ; via the named form to keep the keyword face on it.
  (auto) @keyword

  ; C++ extensions.
  [
    "catch" "class" "co_await" "co_return" "co_yield" "constexpr"
    "constinit" "consteval" "delete" "explicit" "final" "friend"
    "mutable" "namespace" "noexcept" "new" "override" "private"
    "protected" "public" "template" "throw" "try" "typename" "using"
    "concept" "requires" "virtual" "decltype" "operator" "thread_local"
    "static_assert"
  ] @keyword

  ; Preprocessor directives.
  [ "#define" "#elif" "#else" "#endif" "#if" "#ifdef" "#ifndef" "#include" ] @keyword
  (preproc_directive) @keyword

  ; --- literal constants -----------------------------------------------
  [ (true) (false) (null) ] @constant
  ; \`nullptr\` shows up as an anonymous token inside (null …) — capture it too.
  (null "nullptr" @constant)
  (this) @keyword

  ; --- operators -------------------------------------------------------
  [
    "=" "+=" "-=" "*=" "/=" "%="
    "<<=" ">>=" "&=" "|=" "^="
    "+" "-" "*" "/" "%" "++" "--"
    "==" "!=" "<" ">" "<=" ">="
    "&&" "||" "!"
    "&" "|" "^" "~" "<<" ">>"
    "->" "?" "::" ".*" "->*"
  ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren

  ; --- functions -------------------------------------------------------
  (function_declarator declarator: (identifier) @function)
  (function_declarator declarator: (field_identifier) @function)
  (function_declarator
    declarator: (qualified_identifier name: (identifier) @function))
  (call_expression function: (identifier) @function)
  (call_expression
    function: (field_expression field: (field_identifier) @function))
  (call_expression
    function: (qualified_identifier name: (identifier) @function))
  (template_function name: (identifier) @function)
  (template_method name: (field_identifier) @function)

  ; --- types -----------------------------------------------------------
  (type_identifier) @type
  (primitive_type) @type
  (sized_type_specifier) @type
  ((namespace_identifier) @type
   (#match? @type "^[A-Z]"))
`;

registerLanguage({
  tag: 'cpp',
  grammar: 'tree-sitter-cpp.wasm',
  query: QUERY,
  suffixes: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.c++', '.h++'],
  aliases: ['c++'],
});
