/**
 * @file Tree-sitter syntax highlighting. Loads the web-tree-sitter
 * WebAssembly runtime and a prebuilt grammar (both vendored in
 * `../vendor/`), parses a buffer into a real syntax tree, and turns
 * highlight-query captures into per-line runs.
 *
 * Used for JavaScript, HTML and Python — languages with real, maintained
 * grammars. The editor's own Lisp dialect is custom and still evolving;
 * it has no grammar and keeps its tokenizer in `highlight.js`, which is
 * also the fallback for any language whose grammar fails to load.
 *
 * Highlight queries capture leaf nodes (tokens and identifiers) onto the
 * faces the theme styles. Where a capture nests inside another — a call
 * inside an f-string, say — `splitIntoLineRuns` keeps the outer one.
 */

import { Language, Parser, Query } from '../vendor/web-tree-sitter.js';
import { splitIntoLineRuns } from './runs.js';

/** Where the vendored WebAssembly files are served. */
const VENDOR = 'app://editor/packages/renderer/vendor';

/** JavaScript: which nodes get which face. */
const JS_QUERY = `
  (comment) @comment
  (string) @string
  (template_string) @string
  (regex) @string
  (number) @number
  [
    "const" "let" "var" "function" "return" "if" "else" "for" "while"
    "do" "class" "extends" "new" "import" "export" "from" "as" "default"
    "typeof" "instanceof" "in" "of" "void" "delete" "await" "async"
    "yield" "throw" "try" "catch" "finally" "switch" "case" "break"
    "continue" "static" "get" "set"
  ] @keyword
  [ (true) (false) (null) (undefined) ] @constant
  (function_declaration name: (identifier) @function)
  (method_definition name: (property_identifier) @function)
  (call_expression function: (identifier) @function)
  (call_expression
    function: (member_expression property: (property_identifier) @function))
  (class_declaration name: (identifier) @type)
  (new_expression constructor: (identifier) @type)
`;

/** HTML: tags, attributes, comments. */
const HTML_QUERY = `
  (tag_name) @tag
  (erroneous_end_tag_name) @tag
  (doctype) @keyword
  (attribute_name) @constant
  (attribute_value) @string
  (comment) @comment
  [ "<" ">" "</" "/>" ] @paren
`;

/** Python: which nodes get which face. */
const PYTHON_QUERY = `
  (comment) @comment
  (string) @string
  (integer) @number
  (float) @number
  [
    "as" "assert" "async" "await" "break" "class" "continue" "def" "del"
    "elif" "else" "except" "finally" "for" "from" "global" "if" "import"
    "lambda" "nonlocal" "pass" "raise" "return" "try" "while" "with"
    "yield" "match" "case"
  ] @keyword
  [ "and" "in" "is" "not" "or" ] @keyword
  [ (none) (true) (false) ] @constant
  (function_definition name: (identifier) @function)
  (call function: (identifier) @function)
  (call function: (attribute attribute: (identifier) @function))
  (decorator (identifier) @function)
  (type (identifier) @type)
`;

/**
 * @typedef {object} Highlighter
 * @property {(text: string) => import('./highlight.js').Run[][]} highlight -
 *   Highlight source into one array of runs per line.
 */

/** The web-tree-sitter runtime is initialised once, lazily. */
let runtimeReady = null;
function initRuntime() {
  if (runtimeReady === null) {
    runtimeReady = Parser.init({ locateFile: (name) => `${VENDOR}/${name}` });
  }
  return runtimeReady;
}

/**
 * Create a tree-sitter highlighter from a vendored grammar and a query.
 * Asynchronous: it loads the runtime and the grammar.
 *
 * @param {string} grammarFile - A `.wasm` file name in `../vendor/`.
 * @param {string} querySource - The highlight query.
 * @returns {Promise<Highlighter>}
 */
async function createHighlighter(grammarFile, querySource) {
  await initRuntime();

  const response = await fetch(`${VENDOR}/${grammarFile}`);
  const language = await Language.load(
    new Uint8Array(await response.arrayBuffer())
  );

  const parser = new Parser();
  parser.setLanguage(language);
  const query = new Query(language, querySource);

  return {
    highlight(text) {
      const tree = parser.parse(text);
      // Extract plain data before freeing the tree.
      const ranges = query.captures(tree.rootNode).map((capture) => ({
        start: capture.node.startIndex,
        end: capture.node.endIndex,
        face: capture.name,
      }));
      tree.delete();
      return splitIntoLineRuns(text, ranges);
    },
  };
}

/** A tree-sitter highlighter for JavaScript. */
export function createJavaScriptHighlighter() {
  return createHighlighter('tree-sitter-javascript.wasm', JS_QUERY);
}

/** A tree-sitter highlighter for HTML. */
export function createHtmlHighlighter() {
  return createHighlighter('tree-sitter-html.wasm', HTML_QUERY);
}

/** A tree-sitter highlighter for Python. */
export function createPythonHighlighter() {
  return createHighlighter('tree-sitter-python.wasm', PYTHON_QUERY);
}
