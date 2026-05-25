/**
 * @file YAML — tree-sitter language registration. See `./javascript.js`
 * for the template and `./README.md` for "how to add a language".
 *
 * Sublime-Text-style coverage: comments, string scalars (the three
 * scalar forms plus block scalars), numeric scalars, booleans / null
 * as constants, tags faced as types, anchors / aliases as keywords,
 * and mapping keys faced as functions so a key-value file reads like
 * a property list at a glance.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (double_quote_scalar) @string
  (single_quote_scalar) @string
  (block_scalar) @string
  (string_scalar) @string
  (integer_scalar) @number
  (float_scalar) @number

  ; --- literal constants -----------------------------------------------
  (boolean_scalar) @constant
  (null_scalar) @constant

  ; --- keywords / types -----------------------------------------------
  ; Anchors and aliases (\`&foo\` / \`*foo\`) get the keyword face so
  ; references stand out from raw scalars.
  (anchor_name) @keyword
  (alias_name) @keyword
  (tag) @type

  ; --- functions (mapping keys) ---------------------------------------
  ; Treat keys as @function so the property names jump out.
  (block_mapping_pair
    key: (flow_node
      [ (double_quote_scalar) (single_quote_scalar) ] @function))
  (block_mapping_pair
    key: (flow_node (plain_scalar (string_scalar) @function)))
  (flow_mapping
    (_ key: (flow_node
      [ (double_quote_scalar) (single_quote_scalar) ] @function)))
  (flow_mapping
    (_ key: (flow_node (plain_scalar (string_scalar) @function))))

  ; --- punctuation -----------------------------------------------------
  [ "[" "]" "{" "}" ] @paren
  [ "," "-" ":" ">" "?" "|" "*" "&" "---" "..." ] @operator
`;

registerLanguage({
  tag: 'yaml',
  grammar: 'tree-sitter-yaml.wasm',
  query: QUERY,
  suffixes: ['.yaml', '.yml'],
  aliases: ['yml'],
});
