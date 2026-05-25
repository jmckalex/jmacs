/**
 * @file TOML — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * Sublime-Text-style coverage: comments, strings, numbers, booleans,
 * dates (faced as strings — special-typed literals), table headers
 * (the bare/dotted keys at the top of `[section]`) faced as types,
 * key=value keys faced as functions so the form reads like a property
 * list, punctuation, and `=` as an operator.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string) @string
  (integer) @number
  (float) @number

  ; --- literal constants -----------------------------------------------
  (boolean) @constant

  ; Dates / times — face as strings so they aren't unstyled.
  (offset_date_time) @string
  (local_date_time) @string
  (local_date) @string
  (local_time) @string

  ; --- keys / table headers --------------------------------------------
  (bare_key) @type
  (quoted_key) @string
  (pair (bare_key) @function)
  (pair (dotted_key (bare_key) @function))

  ; --- punctuation -----------------------------------------------------
  [ "[" "]" "[[" "]]" "{" "}" ] @paren
  "=" @operator
`;

registerLanguage({
  tag: 'toml',
  grammar: 'tree-sitter-toml.wasm',
  query: QUERY,
  suffixes: ['.toml'],
});
