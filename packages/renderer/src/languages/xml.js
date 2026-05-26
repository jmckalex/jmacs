/**
 * @file XML — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Sublime-Text-style coverage: comments, attribute values (strings),
 * tag names + attribute names faced as tags / functions, character +
 * entity references as constants, CData / character data, and the
 * declaration angle brackets as operators. The XML grammar uses
 * XML-canonical PascalCase node names (`STag`, `ETag`, `Attribute`,
 * `AttValue`, etc.).
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments -------------------------------------------------------
  (Comment) @comment

  ; --- attribute values are strings -----------------------------------
  (AttValue) @string
  (SystemLiteral) @string
  (PubidLiteral) @string

  ; --- character data, CDATA ------------------------------------------
  (CData) @string

  ; --- entity / character references ----------------------------------
  (EntityRef) @constant
  (CharRef) @constant
  (PEReference) @constant

  ; --- tags -----------------------------------------------------------
  (STag (Name) @tag)
  (ETag (Name) @tag)
  (EmptyElemTag (Name) @tag)

  ; --- attribute names -------------------------------------------------
  (Attribute (Name) @function)

  ; --- declarations ---------------------------------------------------
  (XMLDecl) @keyword
  (doctypedecl) @keyword
  (PI) @keyword

  ; --- operators (the angle / equals tokens) ---------------------------
  [ "<" ">" "</" "/>" "=" ] @operator
  ; The vendored tree-sitter-xml emits "<![CDATA" (no trailing "[")
  ; as the open token and pairs it with no anonymous close — the
  ; (CData) node match above faces the whole section. Drop the
  ; explicit brackets here so the query parses.
  [ "<?" "?>" "<!--" "-->" ] @operator
`;

registerLanguage({
  tag: 'xml',
  grammar: 'tree-sitter-xml.wasm',
  query: QUERY,
  suffixes: ['.xml', '.xsd', '.xsl', '.xslt', '.svg', '.rss', '.atom', '.plist'],
});
