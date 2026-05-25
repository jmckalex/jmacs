/**
 * @file CSS — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * Sublime-Text-style coverage: comments, strings, numeric values and
 * units, at-rules (`@import`, `@media`, `@keyframes` …), property
 * names, selectors (tag, class, id, attribute, pseudo-class /
 * pseudo-element, nesting, universal), color / plain values,
 * `!important`, function names (`rgba`, `var`, `calc` …), the
 * combinators / attribute-match operators, and the structural
 * punctuation `(){};,:::`.
 *
 * Caveats: `from` / `to` (the keyframe-step keywords) are NAMED
 * nodes in tree-sitter-css 0.25, so they each need their own capture
 * pattern — the alternation rejects them as anonymous tokens.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (string_value) @string
  (integer_value) @number
  (float_value) @number
  (unit) @number

  ; --- selectors -------------------------------------------------------
  (tag_name) @tag
  (nesting_selector) @tag
  (universal_selector) @tag
  (class_name) @type
  (id_name) @type
  (attribute_name) @constant
  (property_name) @keyword
  (feature_name) @keyword
  (namespace_name) @keyword
  (pseudo_class_selector (class_name) @function)
  (pseudo_element_selector (tag_name) @function)
  (keyframes_name) @function

  ; --- at-rules and contextual keywords -------------------------------
  [
    "@charset" "@import" "@keyframes" "@media" "@namespace" "@scope"
    "@supports"
  ] @keyword
  (at_keyword) @keyword
  [ "and" "not" "or" "only" "of" "selector" "to" ] @keyword
  ; \`from\` is a named node in this grammar, not an anonymous token —
  ; the alternation above can't reach it.
  (from) @keyword
  (to) @keyword

  ; --- values ----------------------------------------------------------
  (plain_value) @constant
  (color_value) @constant
  (important) @operator
  (function_name) @function

  ; --- combinators / match operators ----------------------------------
  [
    "=" "*=" "^=" "$=" "|=" "~=" "+" "-" "/" "*" ">" "~"
  ] @operator

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" "," ":" "::" ";" ] @paren
`;

// Foldable scopes: rule and @-rule bodies (`{ ... }`).
const FOLD_QUERY = `
  (block) @fold
`;

registerLanguage({
  tag: 'css',
  grammar: 'tree-sitter-css.wasm',
  query: QUERY,
  foldQuery: FOLD_QUERY,
  suffixes: ['.css'],
});
