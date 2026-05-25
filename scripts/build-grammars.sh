#!/usr/bin/env bash
# build-grammars.sh — build tree-sitter wasm files from C source into
# packages/renderer/vendor/.
#
# Most of our tree-sitter grammars ship a prebuilt .wasm on npm; we copy
# them verbatim out of node_modules. A few grammar packages ship only C
# source plus native Node bindings — no .wasm — so we build them
# ourselves with `tree-sitter build --wasm`. Currently:
#
#   - @tree-sitter-grammars/tree-sitter-markdown (block + inline)
#   - @pfoerster/tree-sitter-latex
#
# Requirements:
#   - pnpm install has been run (so the grammar source is on disk under
#     node_modules and the tree-sitter CLI binary is in
#     node_modules/.pnpm/node_modules/.bin/)
#   - Docker is running (the CLI uses the official emscripten image
#     under --docker, so the host needs no local emscripten setup)
#
# This is a one-time build run when a grammar version changes. The
# produced .wasm files are committed alongside the other vendored
# grammars; developers do not run this per-checkout.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="${ROOT}/packages/renderer/vendor"
MARKDOWN_BASE="${ROOT}/node_modules/.pnpm/@tree-sitter-grammars+tree-sitter-markdown@0.3.2/node_modules/@tree-sitter-grammars/tree-sitter-markdown"
LATEX_BASE="${ROOT}/node_modules/.pnpm/@pfoerster+tree-sitter-latex@0.6.0/node_modules/@pfoerster/tree-sitter-latex"
TREE_SITTER="${ROOT}/node_modules/.pnpm/node_modules/.bin/tree-sitter"

if [[ ! -x "${TREE_SITTER}" ]]; then
  echo "tree-sitter CLI not found at ${TREE_SITTER}" >&2
  echo "Run \`pnpm install\` first." >&2
  exit 1
fi

if [[ ! -d "${MARKDOWN_BASE}" ]]; then
  echo "markdown grammar source not found at ${MARKDOWN_BASE}" >&2
  echo "Run \`pnpm install\` first." >&2
  exit 1
fi

if [[ ! -d "${LATEX_BASE}" ]]; then
  echo "latex grammar source not found at ${LATEX_BASE}" >&2
  echo "Run \`pnpm install\` first." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running; the wasm build needs the emscripten image." >&2
  exit 1
fi

WORK="$(mktemp -d -t ts-build.XXXXXX)"
trap 'rm -rf "${WORK}"' EXIT

# Build a wasm grammar from a directory on disk. The CLI requires a
# tree-sitter.json manifest in the directory it is given; we synthesize a
# minimal one (the CLI only needs `grammars[0].name`, `scope`, `path`).
#
#   $1 — source directory to copy and stage from
#   $2 — grammar name (must match the name in src/grammar.json)
#   $3 — scope (e.g. source.gfm, text.tex.latex) — informational only
#   $4 — output filename (e.g. tree-sitter-latex.wasm)
build_from_dir() {
  local src="$1"
  local name="$2"
  local scope="$3"
  local out="$4"

  local stage="${WORK}/${name}"
  cp -R "${src}" "${stage}"

  # The CLI requires `grammars[].name/scope/path` plus a `metadata`
  # object (the latter as of tree-sitter-cli ~0.25). Everything else is
  # optional. We supply just enough to satisfy the parser.
  cat >"${stage}/tree-sitter.json" <<EOF
{
  "grammars": [{ "name": "${name}", "scope": "${scope}", "path": "." }],
  "metadata": { "version": "0.0.0", "license": "MIT", "description": "${name}" }
}
EOF

  echo "Building ${out} from ${src} ..."
  "${TREE_SITTER}" build --wasm --docker -o "${VENDOR}/${out}" "${stage}"
}

# Markdown ships two grammars in subdirectories under the package root.
build_from_dir "${MARKDOWN_BASE}/tree-sitter-markdown"        markdown        source.gfm tree-sitter-markdown.wasm
build_from_dir "${MARKDOWN_BASE}/tree-sitter-markdown-inline" markdown_inline source.gfm tree-sitter-markdown-inline.wasm

# LaTeX is a single grammar at the package root.
build_from_dir "${LATEX_BASE}" latex text.tex.latex tree-sitter-latex.wasm

echo "Done. Vendored:"
ls -l "${VENDOR}/tree-sitter-markdown.wasm" \
      "${VENDOR}/tree-sitter-markdown-inline.wasm" \
      "${VENDOR}/tree-sitter-latex.wasm"
