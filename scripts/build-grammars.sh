#!/usr/bin/env bash
# build-grammars.sh — build tree-sitter wasm files from C source into
# packages/renderer/vendor/.
#
# Most of our tree-sitter grammars ship a prebuilt .wasm on npm; we copy
# them verbatim out of node_modules. A handful of packages ship only C
# source plus native Node bindings — no .wasm — so we build them
# ourselves with `tree-sitter build --wasm`.
#
# Requirements:
#   - pnpm install has been run (so the grammar source is on disk under
#     node_modules and the tree-sitter CLI binary is in
#     node_modules/.pnpm/node_modules/.bin/)
#   - Docker is running (the CLI uses the official emscripten image
#     under --docker, so the host needs no local emscripten setup)
#
# This is a one-time build run when a grammar package version changes.
# The produced .wasm files are committed alongside the other vendored
# grammars; developers do not run this per-checkout.
#
# Usage:
#   ./build-grammars.sh                  — rebuild every grammar.
#   ./build-grammars.sh markdown clojure — rebuild only the listed ones.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="${ROOT}/packages/renderer/vendor"
TREE_SITTER="${ROOT}/node_modules/.pnpm/node_modules/.bin/tree-sitter"
PNPM_STORE="${ROOT}/node_modules/.pnpm"

if [[ ! -x "${TREE_SITTER}" ]]; then
  echo "tree-sitter CLI not found at ${TREE_SITTER}" >&2
  echo "Run \`pnpm install\` first." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running; the wasm build needs the emscripten image." >&2
  exit 1
fi

WORK="$(mktemp -d -t ts-build.XXXXXX)"
trap 'rm -rf "${WORK}"' EXIT

# Build one grammar from an arbitrary source directory. Stages the
# directory so we can drop a tree-sitter.json manifest in it (most
# packages don't ship one), then runs `tree-sitter build --wasm
# --docker`. The CLI emits the .wasm to the requested -o path.
#
# Args: src_dir grammar_name scope out_filename
build_grammar() {
  local src="$1" name="$2" scope="$3" out="$4"
  if [[ ! -d "${src}" ]]; then
    echo "source not found: ${src}" >&2
    echo "Run \`pnpm install\` first." >&2
    return 1
  fi
  local stage="${WORK}/${out%.wasm}"
  rm -rf "${stage}"
  cp -R "${src}" "${stage}"
  cat >"${stage}/tree-sitter.json" <<EOF
{
  "grammars": [
    { "name": "${name}", "camelcase": "${name}", "scope": "${scope}", "path": "." }
  ],
  "metadata": {
    "version": "0.0.0",
    "license": "MIT",
    "description": "vendored ${name} grammar"
  },
  "bindings": { "c": true, "node": true }
}
EOF
  echo "Building ${out} from ${src} ..."
  "${TREE_SITTER}" build --wasm --docker -o "${VENDOR}/${out}" "${stage}"
}

# --- per-grammar builders -------------------------------------------------
# Each function knows where its source lives in the pnpm store and what
# to call its output. Add a new grammar by writing one of these and
# adding its name to the dispatcher below.

build_markdown() {
  local base="${PNPM_STORE}/@tree-sitter-grammars+tree-sitter-markdown@0.3.2/node_modules/@tree-sitter-grammars/tree-sitter-markdown"
  build_grammar "${base}/tree-sitter-markdown" markdown source.gfm tree-sitter-markdown.wasm
  build_grammar "${base}/tree-sitter-markdown-inline" markdown_inline source.gfm tree-sitter-markdown-inline.wasm
}

build_latex() {
  build_grammar \
    "${PNPM_STORE}/@pfoerster+tree-sitter-latex@0.6.0/node_modules/@pfoerster/tree-sitter-latex" \
    latex text.tex.latex tree-sitter-latex.wasm
}

build_clojure() {
  build_grammar \
    "${PNPM_STORE}/tree-sitter-clojure@0.4.0/node_modules/tree-sitter-clojure" \
    clojure source.clojure tree-sitter-clojure.wasm
}

build_scheme() {
  build_grammar \
    "${PNPM_STORE}/@6cdh+tree-sitter-scheme@0.24.7-1/node_modules/@6cdh/tree-sitter-scheme" \
    scheme source.scheme tree-sitter-scheme.wasm
}

build_sql() {
  build_grammar \
    "${PNPM_STORE}/@derekstride+tree-sitter-sql@0.3.11/node_modules/@derekstride/tree-sitter-sql" \
    sql source.sql tree-sitter-sql.wasm
}

build_nix() {
  build_grammar \
    "${PNPM_STORE}/tree-sitter-nix@0.0.2/node_modules/tree-sitter-nix" \
    nix source.nix tree-sitter-nix.wasm
}

build_xml() {
  build_grammar \
    "${PNPM_STORE}/tree-sitter-xml@1.0.0/node_modules/tree-sitter-xml" \
    xml text.xml tree-sitter-xml.wasm
}

build_graphql() {
  build_grammar \
    "${PNPM_STORE}/tree-sitter-graphql@1.0.0/node_modules/tree-sitter-graphql" \
    graphql source.graphql tree-sitter-graphql.wasm
}

build_kotlin() {
  build_grammar \
    "${PNPM_STORE}/tree-sitter-kotlin@0.3.8/node_modules/tree-sitter-kotlin" \
    kotlin source.kotlin tree-sitter-kotlin.wasm
}

build_swift() {
  # Swift ships a tree-sitter.json — but we still stage so we control
  # the manifest layout uniformly.
  build_grammar \
    "${PNPM_STORE}/tree-sitter-swift@0.7.1/node_modules/tree-sitter-swift" \
    swift source.swift tree-sitter-swift.wasm
}

build_zig() {
  build_grammar \
    "${PNPM_STORE}/tree-sitter-zig@0.2.0/node_modules/tree-sitter-zig" \
    zig source.zig tree-sitter-zig.wasm
}

# Dockerfile — no maintained npm package (the canonical
# `tree-sitter-dockerfile` slot was hijacked to a security placeholder).
# Source is fetched from the upstream GitHub repo at a pinned tag into
# `${ROOT}/vendor-grammars/`. Refresh by bumping the tag below and
# re-running.
DOCKERFILE_REPO="https://github.com/camdencheek/tree-sitter-dockerfile.git"
DOCKERFILE_TAG="v0.2.0"
DOCKERFILE_SRC="${ROOT}/vendor-grammars/tree-sitter-dockerfile"

build_dockerfile() {
  if [[ ! -d "${DOCKERFILE_SRC}/src" ]]; then
    rm -rf "${DOCKERFILE_SRC}"
    mkdir -p "$(dirname "${DOCKERFILE_SRC}")"
    git clone --depth 1 --branch "${DOCKERFILE_TAG}" \
      "${DOCKERFILE_REPO}" "${DOCKERFILE_SRC}" >/dev/null 2>&1
  fi
  build_grammar "${DOCKERFILE_SRC}" dockerfile source.dockerfile tree-sitter-dockerfile.wasm
}

# Erlang — the npm slot `tree-sitter-erlang` was hijacked to a security
# placeholder. Source is fetched from WhatsApp's upstream repo at a
# pinned tag.
ERLANG_REPO="https://github.com/WhatsApp/tree-sitter-erlang.git"
ERLANG_TAG="0.18"
ERLANG_SRC="${ROOT}/vendor-grammars/tree-sitter-erlang"

build_erlang() {
  if [[ ! -d "${ERLANG_SRC}/src" ]]; then
    rm -rf "${ERLANG_SRC}"
    mkdir -p "$(dirname "${ERLANG_SRC}")"
    git clone --depth 1 --branch "${ERLANG_TAG}" \
      "${ERLANG_REPO}" "${ERLANG_SRC}" >/dev/null 2>&1
  fi
  build_grammar "${ERLANG_SRC}" erlang source.erlang tree-sitter-erlang.wasm
}

# --- dispatcher -----------------------------------------------------------
ALL_GRAMMARS=(markdown latex clojure scheme sql nix xml graphql kotlin swift zig dockerfile erlang)

if [[ $# -eq 0 ]]; then
  TO_BUILD=("${ALL_GRAMMARS[@]}")
else
  TO_BUILD=("$@")
fi

for name in "${TO_BUILD[@]}"; do
  case "${name}" in
    markdown)   build_markdown ;;
    latex)      build_latex ;;
    clojure)    build_clojure ;;
    scheme)     build_scheme ;;
    sql)        build_sql ;;
    nix)        build_nix ;;
    xml)        build_xml ;;
    graphql)    build_graphql ;;
    kotlin)     build_kotlin ;;
    swift)      build_swift ;;
    zig)        build_zig ;;
    dockerfile) build_dockerfile ;;
    erlang)     build_erlang ;;
    *) echo "unknown grammar: ${name}" >&2; exit 1 ;;
  esac
done

echo "Done."
