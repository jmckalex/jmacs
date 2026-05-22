/**
 * @file Tree-sitter syntax highlighting. Loads the web-tree-sitter
 * WebAssembly runtime and a prebuilt grammar (both vendored in
 * `../vendor/`), parses a buffer into a real syntax tree, and turns
 * highlight-query captures into per-line runs.
 *
 * This module knows nothing about individual languages. The grammar
 * filenames and highlight queries live in `./languages/<name>.js`,
 * registered through `./language-registry.js`; adding a language never
 * touches this file. See `./languages/README.md`.
 *
 * Highlight queries capture leaf nodes (tokens and identifiers) onto
 * the faces the theme styles. Where a capture nests inside another —
 * a call inside an f-string, say — `splitIntoLineRuns` keeps the outer
 * one.
 */

import { Language, Parser, Query } from '../vendor/web-tree-sitter.js';
import { splitIntoLineRuns } from './runs.js';

/** Where the vendored WebAssembly files are served. */
const VENDOR = 'app://editor/packages/renderer/vendor';

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
export async function createTreeSitterHighlighter(grammarFile, querySource) {
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
