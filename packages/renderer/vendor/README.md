# vendor/

Vendored WebAssembly assets for tree-sitter syntax highlighting.

The editor has no bundler, so these are committed rather than resolved
from `node_modules` at runtime. They are loaded over the `app://` scheme
by `src/treesitter.js`.

| File | Source | Purpose |
|------|--------|---------|
| `web-tree-sitter.js` | `web-tree-sitter@0.26.9` | the tree-sitter runtime (ESM) |
| `web-tree-sitter.wasm` | `web-tree-sitter@0.26.9` | the runtime's WebAssembly |
| `tree-sitter-javascript.wasm` | `tree-sitter-javascript@0.25.0` | the JavaScript grammar |
| `tree-sitter-html.wasm` | `tree-sitter-html@0.23.2` | the HTML grammar |
| `tree-sitter-python.wasm` | `tree-sitter-python@0.25.0` | the Python grammar |
| `tree-sitter-json.wasm` | `tree-sitter-json@0.24.8` | the JSON grammar |
| `tree-sitter-css.wasm` | `tree-sitter-css@0.25.0` | the CSS grammar |

The source packages are devDependencies of this package; to refresh
these files, copy them from `node_modules` after updating those.

Tree-sitter is used for JavaScript, HTML and Python. The editor's Lisp
dialect is custom and still evolving — it has no grammar, and keeps its
tokenizer in `src/highlight.js`, which is also the fallback for any
language whose grammar fails to load.
