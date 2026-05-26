/**
 * @file Scheme — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Sublime-Text-style coverage. Like Clojure, the grammar models the
 * read syntax. Faces: strings / numbers / chars / booleans by their
 * literal node, comments (line / block / `#;` datum-comments), the
 * head symbol of a list as @function, and the standard R5/R7 special
 * forms / Scheme keywords as @keyword via #match on the head symbol.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  [ (comment) (block_comment) (directive) ] @comment
  (string) @string
  (escape_sequence) @string
  (character) @string
  (number) @number

  ; --- literal constants -----------------------------------------------
  (boolean) @constant

  ; --- function head ---------------------------------------------------
  ; The first symbol of a list is the operator. Face it as @function.
  ; A #match override below promotes recognised special-form names to
  ; @keyword.
  (list . (symbol) @function)

  ; --- keywords (special forms) ---------------------------------------
  (list . (symbol) @keyword
   (#match? @keyword
    "^(define|define-syntax|define-values|define-record-type|let|let\\\\*|letrec|letrec-syntax|let-values|let\\\\*-values|let-syntax|lambda|case|case-lambda|cond|if|when|unless|begin|do|and|or|quote|quasiquote|unquote|unquote-splicing|set!|delay|library|export|import|rename|only|except|prefix|else|=>|syntax-rules|syntax-case|assert)$"))

  ; --- operators (arithmetic / comparison symbols) --------------------
  ((symbol) @operator
   (#match? @operator "^(\\\\+|-|\\\\*|/|=|>|<|>=|<=)$"))

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren
`;

registerLanguage({
  tag: 'scheme',
  grammar: 'tree-sitter-scheme.wasm',
  query: QUERY,
  suffixes: ['.scm', '.ss', '.sld', '.sps', '.sls'],
});
