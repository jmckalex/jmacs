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
  [
    "query" "mutation" "subscription" "fragment" "on" "type" "input"
    "interface" "union" "enum" "schema" "scalar" "extend" "implements"
    "directive" "repeatable" "true" "false" "null"
  ] @keyword

  ; --- types -----------------------------------------------------------
  (NamedType (Name) @type)
  (FragmentName) @type
  (Variable) @type

  ; --- functions -------------------------------------------------------
  ; Field selection — the name of the selected field. Argument names
  ; also read as functions so a query reads as call-shape.
  (Field name: (Name) @function)
  (Field alias: (Alias (Name) @function))
  (Argument (Name) @function)

  ; Directives — \`@include\` / \`@skip\` / etc.
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
