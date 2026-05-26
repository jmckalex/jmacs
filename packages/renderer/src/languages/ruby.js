/**
 * @file Ruby — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * Sublime-Text-style coverage: keywords (control + `class` / `module`
 * / `def` / `begin` / `rescue` / `ensure` / `alias` / boolean `and`
 * `or` / access words `private`/`protected`/`public`), strings (incl.
 * heredoc parts and subshell), symbol literals (faced as strings),
 * regexes (faced as strings), numbers, operators, punctuation,
 * method definitions and call sites (including singleton methods),
 * and constants (faced as types — Ruby uses capitalised identifiers
 * for class names).
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string) @string
  (bare_string) @string
  (subshell) @string
  (heredoc_body) @string
  (heredoc_beginning) @string
  (simple_symbol) @string
  (delimited_symbol) @string
  (hash_key_symbol) @string
  (bare_symbol) @string
  (regex) @string
  (escape_sequence) @string
  (integer) @number
  (float) @number

  ; --- keywords --------------------------------------------------------
  [
    "alias" "and" "begin" "break" "case" "class" "def" "do" "else"
    "elsif" "end" "ensure" "for" "if" "in" "module" "next" "or"
    "rescue" "retry" "return" "then" "unless" "until" "when" "while"
    "yield" "not" "BEGIN" "END" "lambda"
  ] @keyword

  (self) @keyword
  (super) @keyword

  ; Access-control words — \`private\`/\`protected\`/\`public\` are
  ; identifiers, not anonymous tokens. Capture via #match.
  ((identifier) @keyword
   (#match? @keyword "^(private|protected|public)$"))

  ; --- literal constants -----------------------------------------------
  [ (nil) (true) (false) ] @constant

  ; --- operators -------------------------------------------------------
  [ "=" "=>" "->" "+" "-" "*" "/" "%" "**"
    "==" "!=" "<" ">" "<=" ">=" "<=>"
    "&&" "||" "!" "&" "|" "^" "~" "<<" ">>"
    "..." ".." "?"
  ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" "%w(" "%i(" ] @paren

  ; --- functions -------------------------------------------------------
  (method name: [ (identifier) (constant) ] @function)
  (singleton_method name: [ (identifier) (constant) ] @function)
  (alias (identifier) @function)
  (setter (identifier) @function)
  (call method: [ (identifier) (constant) ] @function)

  ; --- types -----------------------------------------------------------
  ; Capitalised constants are how Ruby names classes / modules; face
  ; them as types so \`String.new\`, \`Foo::Bar\` etc. read like Java
  ; type references.
  (constant) @type
`;

registerLanguage({
  tag: 'ruby',
  grammar: 'tree-sitter-ruby.wasm',
  query: QUERY,
  suffixes: ['.rb', '.rbw', '.rake', '.gemspec'],
  aliases: ['rb'],
});
