/**
 * @file Tree-sitter syntax highlighting for JavaScript. Loads the
 * web-tree-sitter WebAssembly runtime and the prebuilt
 * tree-sitter-javascript grammar (both vendored in `../vendor/`),
 * parses a buffer into a real syntax tree, and turns highlight-query
 * captures into per-line runs.
 *
 * Tree-sitter is used only for JavaScript — it has a real, maintained
 * grammar. The editor's own Lisp dialect is custom and still evolving;
 * it has no grammar and keeps the tokenizer in `highlight.js`.
 */

import { Language, Parser, Query } from '../vendor/web-tree-sitter.js';
import { splitIntoLineRuns } from './runs.js';

/** Where the vendored WebAssembly files are served. */
const VENDOR = 'app://editor/packages/renderer/vendor';

/**
 * The highlight query: which JavaScript nodes get which face. Limited
 * to leaf nodes, so captures never overlap.
 */
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
`;

/**
 * @typedef {object} JavaScriptHighlighter
 * @property {(text: string) => import('./highlight.js').Run[][]} highlight -
 *   Highlight JavaScript source into one array of runs per line.
 */

/**
 * Create a tree-sitter JavaScript highlighter. Asynchronous: it loads
 * the WebAssembly runtime and the grammar.
 *
 * @returns {Promise<JavaScriptHighlighter>}
 */
export async function createJavaScriptHighlighter() {
  await Parser.init({ locateFile: (name) => `${VENDOR}/${name}` });

  const response = await fetch(`${VENDOR}/tree-sitter-javascript.wasm`);
  const language = await Language.load(
    new Uint8Array(await response.arrayBuffer())
  );

  const parser = new Parser();
  parser.setLanguage(language);
  const query = new Query(language, JS_QUERY);

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
