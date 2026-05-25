# vendor/

Vendored WebAssembly assets for tree-sitter syntax highlighting.

The editor has no bundler, so these are committed rather than resolved
from `node_modules` at runtime. They are loaded over the `app://` scheme
by `src/treesitter.js`.

| File | Source | Purpose |
|------|--------|---------|
| `web-tree-sitter.js` | `web-tree-sitter@0.26.9` | the tree-sitter runtime (ESM) |
| `web-tree-sitter.wasm` | `web-tree-sitter@0.26.9` | the runtime's WebAssembly |
| `marked.esm.js` | `marked@18.0.4` | Markdown parser (CommonMark + GFM) |
| `tree-sitter-javascript.wasm` | `tree-sitter-javascript@0.25.0` | the JavaScript grammar |
| `tree-sitter-html.wasm` | `tree-sitter-html@0.23.2` | the HTML grammar |
| `tree-sitter-python.wasm` | `tree-sitter-python@0.25.0` | the Python grammar |
| `tree-sitter-json.wasm` | `tree-sitter-json@0.24.8` | the JSON grammar |
| `tree-sitter-css.wasm` | `tree-sitter-css@0.25.0` | the CSS grammar |
| `tree-sitter-typescript.wasm` | `tree-sitter-typescript@0.23.2` | the TypeScript grammar |
| `tree-sitter-rust.wasm` | `tree-sitter-rust@0.24.0` | the Rust grammar |
| `tree-sitter-go.wasm` | `tree-sitter-go@0.25.0` | the Go grammar |
| `tree-sitter-bash.wasm` | `tree-sitter-bash@0.25.1` | the Bash grammar |
| `tree-sitter-php.wasm` | `tree-sitter-php@0.24.2` | the PHP grammar (mixed HTML + `<?php … ?>`) |
| `tree-sitter-php_only.wasm` | `tree-sitter-php@0.24.2` | the pure-PHP grammar (no surrounding HTML) |
| `tree-sitter-markdown.wasm` | `@tree-sitter-grammars/tree-sitter-markdown@0.3.2` | the Markdown block grammar (built locally — see below) |
| `tree-sitter-markdown-inline.wasm` | `@tree-sitter-grammars/tree-sitter-markdown@0.3.2` | the Markdown inline grammar (built locally — see below) |
| `tree-sitter-c.wasm` | `tree-sitter-c@0.24.1` | the C grammar |
| `tree-sitter-cpp.wasm` | `tree-sitter-cpp@0.23.4` | the C++ grammar |
| `tree-sitter-java.wasm` | `tree-sitter-java@0.23.5` | the Java grammar |
| `tree-sitter-csharp.wasm` | `tree-sitter-c-sharp@0.23.5` | the C# grammar (renamed from `tree-sitter-c_sharp.wasm`) |
| `tree-sitter-ruby.wasm` | `tree-sitter-ruby@0.23.1` | the Ruby grammar |
| `tree-sitter-lua.wasm` | `@tree-sitter-grammars/tree-sitter-lua@0.4.1` | the Lua grammar |
| `tree-sitter-yaml.wasm` | `@tree-sitter-grammars/tree-sitter-yaml@0.7.1` | the YAML grammar |
| `tree-sitter-toml.wasm` | `@tree-sitter-grammars/tree-sitter-toml@0.7.0` | the TOML grammar |

The source packages are devDependencies of this package; to refresh
these files, copy them from `node_modules` after updating those.

Most grammars ship a prebuilt `.wasm` on npm; the two Markdown
grammars do not — `@tree-sitter-grammars/tree-sitter-markdown@0.3.2`
ships only C source plus native Node bindings. They are built locally
from that source by `scripts/build-grammars.sh` at the repo root,
which shells out to `tree-sitter build --wasm --docker` (the
`tree-sitter-cli` dev dependency provides the binary; Docker provides
the Emscripten toolchain). The build is a one-time step run when the
markdown grammar version changes — the produced `.wasm` is committed
alongside the others.

Tree-sitter is used for JavaScript, HTML and Python. The editor's Lisp
dialect is custom and still evolving — it has no grammar, and keeps its
tokenizer in `src/highlight.js`, which is also the fallback for any
language whose grammar fails to load.
