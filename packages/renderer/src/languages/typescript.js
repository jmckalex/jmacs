/**
 * @file TypeScript — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for the
 * step-by-step.
 *
 * Built on the TypeScript grammar in `tree-sitter-typescript`; the
 * tsx grammar is *not* registered (a `.tsx` file would need its own
 * registration). The highlight query is a superset of the JavaScript
 * one — TS shares JS's structure, plus interface / type / enum.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  (comment) @comment
  (string) @string
  (template_string) @string
  (regex) @string
  (number) @number
  [
    "const" "let" "var" "function" "return" "if" "else" "for" "while"
    "do" "class" "extends" "implements" "new" "import" "export" "from" "as"
    "default" "typeof" "instanceof" "in" "of" "void" "delete" "await"
    "async" "yield" "throw" "try" "catch" "finally" "switch" "case"
    "break" "continue" "static" "get" "set" "public" "private" "protected"
    "readonly" "abstract" "override" "type" "interface" "enum" "namespace"
    "module" "declare" "is" "keyof" "infer"
  ] @keyword
  [ (true) (false) (null) (undefined) ] @constant
  (function_declaration name: (identifier) @function)
  (method_definition name: (property_identifier) @function)
  (call_expression function: (identifier) @function)
  (call_expression
    function: (member_expression property: (property_identifier) @function))
  (class_declaration name: (type_identifier) @type)
  (interface_declaration name: (type_identifier) @type)
  (type_alias_declaration name: (type_identifier) @type)
  (enum_declaration name: (identifier) @type)
  (new_expression constructor: (identifier) @type)
  (type_identifier) @type
  (predefined_type) @type
`;

registerLanguage({
  tag: 'typescript',
  grammar: 'tree-sitter-typescript.wasm',
  query: QUERY,
  suffixes: ['.ts'],
});
