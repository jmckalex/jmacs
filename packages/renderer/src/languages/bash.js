/**
 * @file Bash — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * Sublime-Text-style coverage: keywords (control flow + `declare`,
 * `export`, `local`, `readonly`, `typeset`, `unset` — all now
 * anonymous tokens in tree-sitter-bash 0.25.1, so the alternation
 * works directly without the named-node detour), strings (incl.
 * heredoc bodies and the rare `$'...'` ANSI-C string), numbers,
 * arithmetic / comparison / logical / bitwise operators plus
 * redirections, punctuation including the shell-specific `((` `))`
 * `[[` `]]` `$(` `${` `$((`, function definitions, command
 * positions, and `$var` / `${var}` expansion targets.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string) @string
  (raw_string) @string
  (ansi_c_string) @string
  (translated_string) @string
  (heredoc_body) @string
  (heredoc_start) @string
  (heredoc_end) @string
  (number) @number

  ; --- keywords --------------------------------------------------------
  [
    "if" "then" "else" "elif" "fi"
    "case" "esac" "in"
    "for" "while" "do" "done" "until"
    "function" "select"
    "declare" "export" "local" "readonly" "typeset" "unset" "unsetenv"
  ] @keyword

  ; --- operators -------------------------------------------------------
  [
    "=" "+=" "-=" "*=" "/=" "%="
    "<<=" ">>=" "&=" "|=" "^="
    "==" "!=" "<" ">" "<=" ">=" "=~"
    "&&" "||" "!"
    "&" "|" "^" "<<" ">>" "**"
    "++" "--" "+" "-" "*" "/" "%"
  ] @operator

  ; Redirection forms — read as operators too.
  [ "<" ">" "<&" ">&" "<&-" ">&-" "<<<" ">|" "&>" "&>>" ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" "((" "))" "[[" "]]" "$(" "\${" "$((" ] @paren

  ; --- functions -------------------------------------------------------
  (function_definition name: (word) @function)
  (command_name (word) @function)

  ; --- variables -------------------------------------------------------
  (variable_name) @type
  (simple_expansion (variable_name) @type)
  (expansion (variable_name) @type)
`;

registerLanguage({
  tag: 'bash',
  grammar: 'tree-sitter-bash.wasm',
  query: QUERY,
  suffixes: ['.sh', '.bash'],
  aliases: ['sh', 'shell', 'zsh'],
});
