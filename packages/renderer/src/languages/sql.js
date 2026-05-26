/**
 * @file SQL — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Sublime-Text-style coverage. The @derekstride grammar models each
 * SQL keyword as a *separate* named node (e.g. `(keyword_select)`,
 * `(keyword_from)`, …). Listing every one would be hundreds of lines;
 * we capture the common shapes via the high-level keyword-statement
 * nodes plus a few categories.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings / numbers ------------------------------------
  (comment) @comment
  (marginalia) @comment
  (literal) @string
  ((literal) @number (#match? @number "^[-+]?[0-9]+$"))
  ((literal) @number (#match? @number "^[-+]?[0-9]*\\\\.[0-9]*$"))

  ; --- literal constants -----------------------------------------------
  [ (keyword_true) (keyword_false) ] @constant

  ; --- keywords --------------------------------------------------------
  ; Each SQL keyword is its own named node — list the common ones.
  [
    (keyword_select) (keyword_from) (keyword_where) (keyword_group)
    (keyword_having) (keyword_order) (keyword_by) (keyword_limit)
    (keyword_offset) (keyword_join) (keyword_inner) (keyword_left)
    (keyword_right) (keyword_full) (keyword_outer) (keyword_cross)
    (keyword_on) (keyword_using) (keyword_as) (keyword_and) (keyword_or)
    (keyword_not) (keyword_in) (keyword_is) (keyword_null) (keyword_like)
    (keyword_between) (keyword_exists) (keyword_distinct) (keyword_all)
    (keyword_any) (keyword_union) (keyword_intersect) (keyword_except)
    (keyword_with) (keyword_recursive) (keyword_case) (keyword_when)
    (keyword_then) (keyword_else) (keyword_end) (keyword_insert)
    (keyword_into) (keyword_values) (keyword_update) (keyword_set)
    (keyword_delete) (keyword_create) (keyword_drop) (keyword_alter)
    (keyword_add) (keyword_table) (keyword_column) (keyword_index)
    (keyword_view) (keyword_database) (keyword_schema) (keyword_primary)
    (keyword_key) (keyword_foreign) (keyword_references) (keyword_default)
    (keyword_unique) (keyword_check) (keyword_constraint) (keyword_if)
    (keyword_replace) (keyword_truncate) (keyword_begin) (keyword_commit)
    (keyword_rollback) (keyword_transaction) (keyword_grant) (keyword_revoke)
    (keyword_to) (keyword_for) (keyword_function) (keyword_procedure)
    (keyword_returns) (keyword_return) (keyword_declare) (keyword_cast)
    (keyword_asc) (keyword_desc) (keyword_temp) (keyword_temporary)
  ] @keyword

  ; --- types -----------------------------------------------------------
  (object_reference name: (identifier) @type)

  ; --- functions -------------------------------------------------------
  (invocation (object_reference name: (identifier) @function))

  ; --- punctuation -----------------------------------------------------
  [ "(" ")" "," ";" ] @paren
  [ "=" "+" "-" "*" "/" "<" ">" "<=" ">=" "<>" "!=" ] @operator
`;

registerLanguage({
  tag: 'sql',
  grammar: 'tree-sitter-sql.wasm',
  query: QUERY,
  suffixes: ['.sql'],
});
