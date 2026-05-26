/**
 * @file Clojure — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Sublime-Text-style coverage. The Clojure grammar is read-syntax-only
 * (no semantic distinction between special forms, macros, and
 * functions — every form is a `(list)` whose head is a `(symbol)`).
 * So we lean on the reader: `(symbol)` is faced as @function (the
 * head of a list is the common case), `:keywords` as @constant /
 * type, strings / numbers / chars / regexes as their tokens, and the
 * reader macros (`'`, `` ` ``, `~`, `~@`, `@`, `#'`) as operators.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string) @string
  (regex) @string
  (character) @string
  (number) @number

  ; --- literal constants -----------------------------------------------
  (nil) @constant
  (boolean) @constant
  ; \`:foo\`, \`:my/foo\` — read as constants.
  (keyword) @constant
  (symbolic_value) @constant

  ; --- symbols / function heads ---------------------------------------
  ; The head of a list is the function being called — face it as
  ; @function. Other symbols stay unfaced (Sublime-style); a
  ; downstream user query can promote them.
  (list (symbol) @function . _*)
  (interop) @function

  ; --- operators (reader macros) ---------------------------------------
  ; The reader-macro prefixes are part of their own named nodes; the
  ; punctuation tokens themselves are anonymous and don't appear in
  ; field positions. Face the wrapping form's outer punctuation by
  ; capturing the named node and letting the inner expression keep its
  ; own face.
  ["'" "\`" "~" "~@" "@" "#'" "#_"] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" "#{" ] @paren
`;

registerLanguage({
  tag: 'clojure',
  grammar: 'tree-sitter-clojure.wasm',
  query: QUERY,
  suffixes: ['.clj', '.cljs', '.cljc', '.edn'],
  aliases: ['clj', 'cljs', 'cljc'],
});
