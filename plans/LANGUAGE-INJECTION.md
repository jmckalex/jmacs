# Plan — tree-sitter language injection (Markdown, HTML, PHP)

**Status: planned, not started.** A detailed design for review.

## Context

Today the editor's tree-sitter pipeline (`packages/renderer/src/treesitter.js`)
gives each language one grammar + one highlight query, returning a flat
per-line set of runs. That model carried Track B (JS, HTML, Python, JSON,
CSS, TypeScript, Rust, Go, Bash) but breaks down on the *embedded*
languages every real editor handles:

- **Markdown** fenced ```` ```lisp ```` blocks render as one opaque
  string colour rather than properly-highlighted Lisp.
- **HTML** `<script>` and `<style>` bodies render as opaque tag content
  instead of JavaScript and CSS.
- **PHP** isn't supported at all, and PHP files are inherently
  mixed-mode (HTML + `<?php … ?>`).

The architect's call: parity with Sublime Text / VS Code on these three
file types is essential, not optional. The pipeline gains
tree-sitter *language injection* — when a grammar marks a node as
containing source in another language, the inner highlighter runs on
that range and its tokens replace the outer one — and we add the three
grammars (plus the markdown inline grammar that the block one depends
on) under the existing T0 drop-in mechanism.

A real, maintained `@tree-sitter-grammars/tree-sitter-markdown@0.3.2`
exists; the earlier project assumption "no tree-sitter grammar for
Markdown" was an old guess, not research. Fixing that here.

## What changes

```
packages/renderer/vendor/                 (one .wasm per grammar)
  tree-sitter-markdown.wasm                 — block grammar (new)
  tree-sitter-markdown-inline.wasm          — inline grammar (new)
  tree-sitter-php.wasm                      — mixed HTML+PHP (new)
  tree-sitter-php_only.wasm                 — pure PHP (new)
  tree-sitter-html.wasm                     — existing, unchanged binary

packages/renderer/src/
  treesitter.js                             — extended for injections
  language-registry.js                      — two-phase load; injection bridge
  runs.js                                   — handles nested ranges
  languages/
    markdown.js                             — new, with injection query
    markdown-inline.js                      — new (no suffixes; reached via injection)
    php.js                                  — new (mixed grammar)
    php-only.js                             — new (.phps fallback)
    html.js                                 — extended with injections

packages/stdlib/lisp/languages/
  markdown.lisp                             — new (mode + suffix mapping)
  php.lisp                                  — new
```

## The injection mechanism

### Highlighter contract — extend, don't replace

`treesitter.js` exports `createTreeSitterHighlighter(grammarFile,
querySource, options?)`. `options` gains two fields:

```
{
  injectionQuery?: string,   // a second .scm query in the standard
                             // tree-sitter shape:
                             //   (node) @injection.content
                             //   (#set! injection.language "tag")
  getHighlighter?: (tag) => Highlighter | undefined,
}
```

The returned `Highlighter` keeps today's shape plus one extra
internal method:

```
{
  highlight(text) -> Run[][]        // unchanged for callers
  captures(text)  -> Range[]        // raw, absolute-offset ranges
}
```

`captures` is what the injection pipeline uses recursively;
`highlight` just calls `captures` then `splitIntoLineRuns`.

### The injection algorithm

In one parse + two queries pass per highlighter:

1. **Parse the outer text.** `parser.parse(text)` once.
2. **Run the highlight query.** As today — `outerRanges` is the list
   of `{start, end, face}` from `query.captures(rootNode)`.
3. **Run the injection query (if any).** Each match gives a pair —
   the *content* node (the body of the embedded language) and the
   *language* tag (a string capture or `#set!` directive). Collect
   into `injections = [{ start, end, language }, …]`.
4. **For each injection, recursively highlight.** Look up the inner
   highlighter via `getHighlighter(injection.language)`. If missing,
   skip (the outer face on that range survives — a graceful
   degradation when the grammar isn't vendored). Otherwise call
   `inner.captures(text.slice(start, end))` and shift the resulting
   ranges by `+start` so they live in the outer coordinate space.
5. **Filter the outer ranges that fall inside an injection.** Any
   outer range whose `[start, end)` is fully contained by an
   injection's content range is dropped; the inner ranges take its
   place. Outer ranges *outside* the injection (the language-info
   `lisp` after the opening ``` fence, for example) survive
   untouched, so the fence itself still highlights.
6. **Concatenate** filtered outer + shifted inner → pass to
   `splitIntoLineRuns`.

The result is a flat `Range[]` with no overlap by construction —
the splitter's existing precondition is preserved.

### Recursion + depth cap

Injection is recursive: a PHP file injects HTML chunks, which inject
JavaScript inside `<script>` and CSS inside `<style>`. The architect's
call: **recursive, depth-capped at 4**. Each `captures` call carries
an implicit depth counter (a closure variable, incremented on entry);
when it would exceed 4 the recursion stops and the outer face wins for
that range. Four is comfortably more than any sensible legitimate
nesting (PHP → HTML → CSS or JS is 3) and protects against a
pathological grammar pair that injects each other.

### Two-phase loading in `language-registry.js`

The injection chain needs every highlighter to be able to look up
every other. The clean fix:

- `loadLanguageHighlighters(create)` is **unchanged in signature** but
  internally builds the map in two phases.
- Phase A: instantiate each language's *outer* highlighter (the
  highlight query alone). The map is populated.
- Phase B: for each language whose spec declares an `injectionQuery`,
  re-wrap the highlighter with the injection-aware version, threading
  in `getHighlighter: (tag) => map[tag]` — a closure that reads the
  fully-populated map.

The spec gets one new optional field:

```
{ tag, grammar, query, suffixes, injectionQuery? }
```

`registerLanguage` already accepts spread options — adding a field is
additive, existing language modules keep working.

### `runs.js` — small hardening

The current `splitIntoLineRuns` assumes non-overlapping ranges; the
injection algorithm guarantees that. As a safety net the splitter
gains a single warning in dev (`console.warn` if it observes an
overlap) plus deterministic "later range wins" tie-breaking — so a
bug in the injection layer degrades to wrong-but-stable output, not
a crash.

## The four new grammars

For each grammar: `pnpm add -D` the package; copy the prebuilt `.wasm`
into `packages/renderer/vendor/`; add a row to vendor README; set
`tree-sitter-X: false` in `pnpm-workspace.yaml`; write a tiny
`languages/<tag>.js` registration; write a tiny `languages/<tag>.lisp`
mode definition. The Track B template, repeated.

### Markdown (block + inline) — `@tree-sitter-grammars/tree-sitter-markdown@0.3.2`

The package ships **two grammars in subdirectories** (`tree-sitter-markdown`
and `tree-sitter-markdown-inline`), each producing its own
`tree-sitter-markdown.wasm` / `tree-sitter-markdown-inline.wasm`. Both
are vendored.

The **block** grammar is the file-level entry. Its highlight query
captures headings, fenced-block delimiters, list bullets, blockquote
markers, the language info-string. Its injection query:

```
(fenced_code_block
  (info_string (language) @injection.language)
  (code_fence_content) @injection.content)
((paragraph) @injection.content (#set! injection.language "markdown_inline"))
```

Two injections per block: the fenced block (language taken from the
info string), and every paragraph's content (into the inline grammar).
A user writing ` ```lisp ` gets Lisp tokens in the body and inline
emphasis/code/links in their prose. Buffers with no info string render
the block contents as plain text (no injection, outer face wins).

The **inline** grammar (`tag: 'markdown_inline'`) is registered as a
language with no suffixes — it isn't selected directly by any file
extension, it's only ever invoked via injection. The registry already
handles "no suffixes" fine (`languageForFilename` returns `null` for
any name; nothing else changes). Its highlight query covers
`*emphasis*`, `**strong**`, `` `code` ``, `[link](url)`, `<autolink>`,
escapes, references.

`markdown.lisp` registers `.md` (and `.markdown`) → `markdown-mode`
with `:highlight :markdown`. (`markdown-mode` is already defined in
`modes.lisp` with `:highlight :markdown`; no change there.)

The existing hand-tokenizer (`highlight.js#tokenizeMarkdown`) stays as
a fallback if the .wasm fails to load — same pattern as the original
JavaScript / HTML / Python languages.

### HTML — `tree-sitter-html` (already vendored)

Same `.wasm`, new `injectionQuery`:

```
((script_element (raw_text) @injection.content) (#set! injection.language "javascript"))
((style_element (raw_text) @injection.content) (#set! injection.language "css"))
```

The only change to `html.js`. The existing highlight query is
unchanged; existing HTML highlighting still works for buffers that
just have markup. Inside `<script>` and `<style>` the JS/CSS
highlighters run.

### PHP (mixed) — `tree-sitter-php@0.24.2`

The package ships two grammars: the **`php` (mixed)** grammar parses
files that begin in HTML and switch into PHP at `<?php`; the
**`php_only`** grammar parses pure-PHP files. Both vendored.

`languages/php.js` (mixed; suffixes `.php`, `.phtml`):

```
injectionQuery:
  ((text) @injection.content (#set! injection.language "html"))
```

So PHP outer parses the whole file, marking `<?php …?>` blocks as PHP
tokens and everything else as `(text)` nodes. The `(text)` nodes are
injected as HTML. The HTML grammar in turn injects JS and CSS in its
`<script>` and `<style>` blocks. Depth so far: 3 (PHP → HTML →
JS/CSS). Comfortably under the cap of 4.

`languages/php-only.js` (suffix `.phps`, the "PHP source" extension
sometimes used for syntax-highlighted PHP code). No injection.

`php.lisp` registers `php-mode` with `:highlight :php`, binds `.php`
and `.phtml` to it, and `.phps` to a `php-only-mode`.

## Hand-tokenizer fallbacks

`highlight.js` already provides per-line tokenizers for `markdown`,
`html`, `javascript`, `python`, etc. T0's pattern: when a grammar
fails to load, `loadLanguageHighlighters` removes that language from
the map and `view.js` falls back to `highlightLine`. That stays.

What *won't* fall back: the *inner* highlighting of an injected
range. If the markdown grammar loads but the lisp inner highlighter is
missing, the markdown-outer `code_fence_content` capture isn't
filtered (per step 5 of the algorithm — "if missing, skip"), so the
body shows in the outer face. No code path crashes.

## Tests

- `packages/renderer/test/treesitter-injection.test.js` — new. Cover:
  - A markdown source with a ```lisp fence produces runs where the
    fence body has Lisp keyword faces (not the outer string face).
  - HTML with `<script>console.log(1)</script>` highlights `console`
    and `log` as JS, not as HTML text.
  - A PHP file with mixed `<?php $x = "hi"; ?> <b>html</b>` shows
    PHP variable + string faces inside the tag, HTML tag faces
    outside.
  - Depth cap: a synthetic two-language cycle (or an unknown
    `getHighlighter` returning the outer one again) terminates.
  - Missing inner highlighter: the outer face is preserved on the
    range (no exception, no missing-runs gap).
- `packages/renderer/test/runs.test.js` — extend with an
  overlapping-ranges case to lock in the "later wins" tie-break.
- `packages/renderer/test/language-registry.test.js` — extend with a
  spec that includes `injectionQuery`; the two-phase loader exposes
  the right wrapped highlighter.
- `apps/desktop/scripts/smoke.js` — extend the `treesitter:` arm with
  `markdown`, `php`, and a check that `cssKeywords` appears inside an
  HTML buffer with a `<style>` block (proving HTML→CSS injection).

## Verification

End-to-end:

```
pnpm test                                    # unit + integration
pnpm --filter @editor/desktop smoke         # full editor smoke
pnpm --filter @editor/desktop dev           # open a .md, .html, .php
                                            # by hand and verify the
                                            # screenshots match
```

For the .md / .php cases, capture screenshots via the existing
`pnpm --filter @editor/desktop screenshot` helper to confirm fenced
lisp blocks and embedded HTML render with the expected per-language
palette.

## Critical files

- `packages/renderer/src/treesitter.js` — injection-aware Highlighter;
  the algorithm core.
- `packages/renderer/src/language-registry.js` — two-phase loader;
  `injectionQuery` field; `getHighlighter` closure.
- `packages/renderer/src/runs.js` — overlap-tolerant splitter (warn
  + later-wins tie-break).
- `packages/renderer/src/languages/{markdown,markdown-inline,php,php-only}.js` —
  new language modules with injection queries.
- `packages/renderer/src/languages/html.js` — extended with an
  injection query (binary unchanged).
- `packages/stdlib/lisp/languages/{markdown,php}.lisp` — new mode
  files (markdown reuses the existing mode defined in `modes.lisp`;
  php is fully new).
- `packages/renderer/vendor/` — four new `.wasm` files (markdown,
  markdown-inline, php, php_only).

## Phasing

One branch, three commits, in this order — each green on its own.
The worktree layout the architect mentioned makes these phases
parallelisable: the pipeline change in phase 1 must land first, but
the markdown and PHP work in phases 2 and 3 are largely independent
once the pipeline is in place.

1. **Pipeline.** `treesitter.js` + `language-registry.js` + `runs.js`
   changes, plus the HTML injection query (the smallest real-world
   user). Unit tests for the new injection path. HTML's
   `<script>`/`<style>` now highlight as JS/CSS.
2. **Markdown.** Vendor both wasm files, register block + inline,
   point at the inline grammar via injection. Markdown buffers now
   highlight properly including fenced ```lisp blocks. Smoke updated.
3. **PHP.** Vendor both wasm files, register mixed + only, mode
   definition. PHP buffers highlight: PHP inside `<?php`, HTML
   around, JS/CSS in `<script>`/`<style>` (three-level recursion).

## Risks / open at implementation time

- **The published .wasm files for `@tree-sitter-grammars/tree-sitter-markdown`
  may need to be built from source.** Some grammar packages ship only
  the C source plus a `tree-sitter generate` step; check on first
  install. If they don't ship prebuilt wasm, vendor a small build step
  in `scripts/build-grammars.sh` (one-time, run when refreshing the
  grammar version, not per-developer).
- **Injection-query syntax has minor variations** between tree-sitter
  versions. `web-tree-sitter@0.26.9` (already vendored) accepts the
  modern `#set! injection.language "name"` form; older grammars
  sometimes use a capture-name shorthand. Confirm against the
  vendored runtime's exact behaviour when wiring the first injection
  (HTML's `<script>`); fix any incompatibility there before adding
  the others.
- **Markdown's inline grammar requires the block grammar to feed it
  the right input.** The injection pattern `((paragraph)
  @injection.content (#set! injection.language "markdown_inline"))`
  passes the paragraph text. If the inline grammar expects something
  slightly different (e.g. trimmed leading whitespace) we adjust the
  injection query, not the inline grammar.
- **PHP's "mixed" grammar's `(text)` nodes** may not be exactly what
  we need to inject as HTML — some PHP grammar versions split `(text)`
  into `(text_interpolation)` or similar. Verify at vendor time;
  worst case the injection query needs one more alternation.
