#!/usr/bin/env bash
# build-grammars.sh — build the Markdown tree-sitter wasm files from
# C source into packages/renderer/vendor/.
#
# Most of our tree-sitter grammars ship a prebuilt .wasm on npm; we copy
# them verbatim out of node_modules. The Markdown grammar package
# (@tree-sitter-grammars/tree-sitter-markdown) ships only C source plus
# native Node bindings — no .wasm — so we build them ourselves with
# `tree-sitter build --wasm`.
#
# Requirements:
#   - pnpm install has been run (so the grammar source is on disk under
#     node_modules and the tree-sitter CLI binary is in
#     node_modules/.pnpm/node_modules/.bin/)
#   - Docker is running (the CLI uses the official emscripten image
#     under --docker, so the host needs no local emscripten setup)
#
# This is a one-time build run when the markdown grammar version
# changes. The produced .wasm files are committed alongside the other
# vendored grammars; developers do not run this per-checkout.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="${ROOT}/packages/renderer/vendor"
SRC_BASE="${ROOT}/node_modules/.pnpm/@tree-sitter-grammars+tree-sitter-markdown@0.3.2/node_modules/@tree-sitter-grammars/tree-sitter-markdown"
TREE_SITTER="${ROOT}/node_modules/.pnpm/node_modules/.bin/tree-sitter"

if [[ ! -x "${TREE_SITTER}" ]]; then
  echo "tree-sitter CLI not found at ${TREE_SITTER}" >&2
  echo "Run \`pnpm install\` first." >&2
  exit 1
fi

if [[ ! -d "${SRC_BASE}" ]]; then
  echo "markdown grammar source not found at ${SRC_BASE}" >&2
  echo "Run \`pnpm install\` first." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running; the wasm build needs the emscripten image." >&2
  exit 1
fi

WORK="$(mktemp -d -t md-build.XXXXXX)"
trap 'rm -rf "${WORK}"' EXIT

build_one() {
  local subdir="$1"   # tree-sitter-markdown | tree-sitter-markdown-inline
  local name="$2"     # markdown          | markdown_inline
  local out="$3"      # tree-sitter-markdown.wasm | tree-sitter-markdown-inline.wasm

  local stage="${WORK}/${subdir}"
  cp -R "${SRC_BASE}/${subdir}" "${stage}"

  # The grammar subdirectories in the npm package have no
  # tree-sitter.json manifest of their own (the package manifest at the
  # parent level lists both grammars). `tree-sitter build --wasm`
  # requires a manifest in the directory it's given. Write a minimal
  # one — the CLI only needs `grammars[0].name`, `scope`, and `path`.
  cat >"${stage}/tree-sitter.json" <<EOF
{ "grammars": [{ "name": "${name}", "scope": "source.gfm", "path": "." }] }
EOF

  echo "Building ${out} from ${subdir}/ ..."
  "${TREE_SITTER}" build --wasm --docker -o "${VENDOR}/${out}" "${stage}"
}

build_one tree-sitter-markdown        markdown        tree-sitter-markdown.wasm
build_one tree-sitter-markdown-inline markdown_inline tree-sitter-markdown-inline.wasm

echo "Done. Vendored:"
ls -l "${VENDOR}/tree-sitter-markdown.wasm" "${VENDOR}/tree-sitter-markdown-inline.wasm"
