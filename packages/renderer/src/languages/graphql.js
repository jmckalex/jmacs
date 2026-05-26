/**
 * @file GraphQL — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Sublime-Text-style coverage: comments, descriptions (faced as
 * comments — they read like docstrings), string / int / float /
 * boolean / null values, enum values + named types, field selections
 * as functions, fragment names as types, directives (`@include`) as
 * functions, variables (`$foo`) as types, and the operation keywords
 * (`query` / `mutation` / `subscription` etc.) — these are anonymous
 * tokens captured by name.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (Description) @comment
  (StringValue) @string
  (IntValue) @number
  (FloatValue) @number

  ; --- literal constants -----------------------------------------------
  (BooleanValue) @constant
  (NullValue) @constant
  (EnumValue) @constant

  ; --- keywords --------------------------------------------------------
  ; The vendored tree-sitter-graphql ships an older grammar that
  ; lacks anonymous tokens for 'repeatable' (added later) and
  ; 'null' (a value, not a keyword in this version).
  [
    "query" "mutation" "subscription" "fragment" "on" "type" "input"
    "interface" "union" "enum" "schema" "scalar" "extend" "implements"
    "directive" "true" "false"
  ] @keyword

  ; --- types -----------------------------------------------------------
  (NamedType (Name) @type)
  (FragmentName) @type
  (Variable) @type

  ; --- functions -------------------------------------------------------
  ; The vendored tree-sitter-graphql exposes no field names, so we
  ; can't restrict by 'name:' / 'alias:'. Face every Name inside
  ; a Field or Argument as @function -- a slightly broader face,
  ; same visual result for the common case.
  (Field (Name) @function)
  (Field (Alias (Name) @function))
  (Argument (Name) @function)

  ; Directives -- @include / @skip / etc.
  (Directive (Name) @function)

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "[" "]" "{" "}" ] @paren
  [ "=" ":" "!" "..." "|" "&" "@" "$" ] @operator
`;

registerLanguage({
  tag: 'graphql',
  grammar: 'tree-sitter-graphql.wasm',
  query: QUERY,
  suffixes: ['.graphql', '.gql'],
  aliases: ['gql'],
});
