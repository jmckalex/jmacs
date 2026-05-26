/**
 * @file Elixir — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Sublime-Text-style coverage: keywords (`fn` / `do` / `end` / `when`
 * / boolean `and` / `or` / `not` / `in` / `catch` / `rescue` / `after`
 * / `else`), strings (incl. charlists and sigils), atoms / keywords as
 * strings, numbers, booleans / nil as constants, operators (named
 * `(operator_identifier)` plus per-expression operator children),
 * function calls (local + remote), and module aliases as types. The
 * grammar models `def` / `defmodule` / `defmacro` / etc. as ordinary
 * calls rather than reserved words, so they are captured via call
 * patterns with `#any-of?` against the target identifier — anyone
 * shadowing `def` will see it faced as a keyword too.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string) @string
  (charlist) @string
  (escape_sequence) @string
  (atom) @string
  (quoted_atom) @string
  (keyword) @string
  (quoted_keyword) @string
  (integer) @number
  (float) @number

  ; --- literal constants -----------------------------------------------
  [ (boolean) (nil) ] @constant
  (char) @constant
  ; Common builtin pseudo-constants.
  ((identifier) @constant
   (#any-of? @constant
    "__MODULE__" "__DIR__" "__ENV__" "__CALLER__" "__STACKTRACE__"))

  ; --- keywords --------------------------------------------------------
  [ "when" "and" "or" "not" "in" "not in" "fn" "do" "end" "catch"
    "rescue" "after" "else" ] @keyword

  ; \`def\` / \`defmodule\` / etc. are calls in this grammar; face the
  ; target identifier as a keyword. NOTE: A user macro named \`def\`
  ; would also be faced as keyword.
  (call target: (identifier) @keyword
   (#any-of? @keyword
    "def" "defdelegate" "defexception" "defguard" "defguardp"
    "defimpl" "defmacro" "defmacrop" "defmodule" "defn" "defnp"
    "defoverridable" "defp" "defprotocol" "defstruct"
    "alias" "case" "cond" "for" "if" "import" "quote" "raise"
    "receive" "require" "reraise" "super" "throw" "try" "unless"
    "unquote" "unquote_splicing" "use" "with"))

  ; --- operators -------------------------------------------------------
  (operator_identifier) @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" "<<" ">>" "%" ] @paren

  ; --- functions -------------------------------------------------------
  ; Local call: \`foo(…)\`
  (call target: (identifier) @function)
  ; Remote call: \`Mod.foo(…)\` — the right-hand identifier.
  (call target: (dot right: (identifier) @function))

  ; Function name in a def: \`def my_fn(…)\` — extract the name from the
  ; args of the def-call.
  (call
    target: (identifier) @_kw
    (arguments [
      (identifier) @function
      (call target: (identifier) @function)
      (binary_operator left: (call target: (identifier) @function) operator: "when")
      (binary_operator left: (identifier) @function operator: "when")
    ])
    (#any-of? @_kw
      "def" "defdelegate" "defguard" "defguardp" "defmacro" "defmacrop"
      "defn" "defnp" "defp"))

  ; --- types -----------------------------------------------------------
  ; Aliases — capitalised module identifiers like \`String\` / \`MyApp.Repo\`.
  (alias) @type
`;

registerLanguage({
  tag: 'elixir',
  grammar: 'tree-sitter-elixir.wasm',
  query: QUERY,
  suffixes: ['.ex', '.exs'],
  aliases: ['ex', 'exs'],
});
