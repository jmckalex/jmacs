/**
 * @file Markdown rendering — a thin wrapper around the vendored
 * marked.js library.
 *
 * Used by:
 *   - sticky notes (when `*markdown-interpreter*` is the magic value
 *     "marked"), to render note bodies without shelling out;
 *   - the doc-view's live-docstring path (`renderDocstringPage`),
 *     so a user-defined function's docstring renders with the same
 *     typography as the pre-built reference pages.
 *
 * The renderer is sandboxed and has no bundler, so marked.js itself
 * is vendored alongside the tree-sitter grammars (see
 * `../vendor/README.md`). Marked is configured for sensible defaults
 * (GFM tables and line breaks); no syntax-highlighting hook is wired
 * up here, so fenced code blocks render as plain `<pre><code>`.
 */

import { Marked } from '../vendor/marked.esm.js';
import {
  scanMathSegments,
  maskMarkdownCode,
  MARKDOWN_MATH_CONFIG,
} from './math-segments.js';

/** HTML-escape `<`, `&`, `>` so a math body's characters survive into the
 *  DOM as text (the browser decodes them; MathJax reads the decoded
 *  textContent). Backslashes and delimiters are left intact. */
function escapeMathHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** True when offset `i` falls within any `[start, end)` span. */
function withinAny(i, spans) {
  for (const s of spans) if (i >= s.start && i < s.end) return true;
  return false;
}

/**
 * The `\$` escaped-dollar spans outside the math spans. A backslash
 * consumes the next character (so `\\$` leaves a live `$` for the math
 * scan, while `\$` is a literal dollar). Returned as `[start, end)` of
 * each two-character `\$`.
 */
function escapedDollarSpans(text, mathSpans) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      if (text[i + 1] === '$' && !withinAny(i, mathSpans)) {
        out.push({ start: i, end: i + 2 });
      }
      i += 2; // consume the escaped pair
      continue;
    }
    i += 1;
  }
  return out;
}

/** Placeholder marker (U+FFFC OBJECT REPLACEMENT CHARACTER) — never in
 *  prose and never markdown-special, so it rides through marked untouched. */
const MARK = String.fromCharCode(0xfffc);
const PLACEHOLDER_RE = /￼(\d+)￼/g;

// A fresh Marked instance avoids leaking state into the global `marked`
// singleton. No math extension: CommonMark mangles LaTeX (`\[` → `[`,
// `&` → entity, `_`/`*` → emphasis) and a marked extension can't see
// markdown's own escaping or code spans — so renderMarkdown protects
// math (and `\$`) *before* marked using the code-aware scanner.
const marked = new Marked({
  gfm: true,
  breaks: false,
});

/**
 * Render a Markdown source string to an HTML fragment. Synchronous.
 *
 * LaTeX math is protected from CommonMark: each math region (found by the
 * code-aware, escape-aware `scanMathSegments` — so a `$` inside code or a
 * `\$` escape is never math), plus each literal `\$`, is swapped for a
 * placeholder before marked runs and restored after. Math is restored
 * verbatim (HTML-escaped) so MathJax gets intact delimiters; `\$` is
 * restored as `\$` so MathJax's `processEscapes` shows a literal dollar
 * without starting math.
 *
 * @param {string} source - Markdown text.
 * @returns {string} HTML.
 */
export function renderMarkdown(source) {
  if (typeof source !== 'string' || source === '') return '';
  const masked = maskMarkdownCode(source);
  const mathSpans = scanMathSegments(masked, MARKDOWN_MATH_CONFIG);
  const dollarSpans = escapedDollarSpans(masked, mathSpans);
  const spans = [...mathSpans, ...dollarSpans].sort((a, b) => a.start - b.start);
  if (spans.length === 0) return marked.parse(source);

  /** @type {string[]} */
  const slots = [];
  let protectedSrc = '';
  let pos = 0;
  for (const span of spans) {
    if (span.start < pos) continue; // never overlap a span already taken
    protectedSrc += source.slice(pos, span.start);
    const raw = source.slice(span.start, span.end);
    // A math span carries `kind` (from scanMathSegments); a `\$` span
    // does not. Math → verbatim (HTML-escaped); `\$` → a literal `\$`.
    const id = slots.push(span.kind ? escapeMathHtml(raw) : '\\$') - 1;
    protectedSrc += MARK + id + MARK;
    pos = span.end;
  }
  protectedSrc += source.slice(pos);

  return marked
    .parse(protectedSrc)
    .replace(PLACEHOLDER_RE, (_match, id) => slots[Number(id)]);
}
