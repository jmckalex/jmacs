/**
 * @file Math-segment scanning — the pure core of the math preview.
 *
 * A *math segment* is a stretch of buffer text that is either delimited
 * by one of the four LaTeX math delimiter pairs or a display-math
 * `\begin{…}…\end{…}` environment:
 *
 *   - `$ … $`   and `\( … \)`  → inline math   (`kind: 'inline'`)
 *   - `$$ … $$` and `\[ … \]`  → display math  (`kind: 'block'`, may span lines)
 *   - `\begin{align}…\end{align}` and friends (equation, gather, multline,
 *     alignat, flalign, eqnarray, displaymath; starred or not) → display
 *     math (`kind: 'block'`, usually spanning lines)
 *
 * Which of those constructs the scanner recognises is controlled by a
 * `config` argument (see `MathConfig`), so the same scanner serves every
 * major mode: `LATEX_MATH_CONFIG` recognises all of them (the LaTeX
 * default), while `MARKDOWN_MATH_CONFIG` recognises the four delimiter
 * pairs but **not** `\begin…\end` environments (the "common" config used
 * by markdown and, later, html/php). `scanMathSegments(text)` with no
 * config defaults to `LATEX_MATH_CONFIG`, so existing LaTeX callers are
 * unchanged.
 *
 * The scanner walks the text once and returns the segments it finds as
 * `{ start, end, kind, body }`:
 *
 *   - `start` is the offset of the opening delimiter's first character;
 *   - `end` is the offset one past the closing delimiter's last character;
 *   - `kind` is `'inline'` or `'block'`;
 *   - `body` is the source *between* the delimiters (delimiters stripped)
 *     — or, for a `\begin…\end` environment, the *full* environment source
 *     (MathJax processes the environment itself). It is the typeset input
 *     and the cache key.
 *
 * This module is pure and DOM-free, so it is tested on its own. The
 * minor-mode controller prefers the LaTeX tree-sitter parse when it is
 * available (see `segmentsFromNodeRanges`) and falls back to this raw
 * delimiter scanner when it is not.
 *
 * Escaping and verbatim/comment regions: the delimiter scanner respects
 * backslash escaping (`\$` is a literal dollar, never a math delimiter)
 * and skips `%` line comments. It does *not* understand `\verb` or
 * `verbatim` environments — that is the tree-sitter path's job; the raw
 * scanner is the best-effort fallback.
 */

/**
 * @typedef {object} MathSegment
 * @property {number} start - Offset of the opening delimiter's first char.
 * @property {number} end - Offset one past the closing delimiter's last char.
 * @property {'inline'|'block'} kind - Inline (`$…$`, `\(…\)`) or display
 *   (`$$…$$`, `\[…\]`).
 * @property {string} body - The source between the delimiters.
 */

/**
 * Which math constructs `scanMathSegments` recognises. Every flag
 * defaults to *on* when the field is absent, so an empty/partial config
 * still scans everything — pass `false` to turn a construct off.
 *
 * @typedef {object} MathConfig
 * @property {boolean} [inlineDollar] - Recognise `$…$` inline math.
 * @property {boolean} [displayDollar] - Recognise `$$…$$` display math.
 * @property {boolean} [parens] - Recognise `\(…\)` inline math.
 * @property {boolean} [brackets] - Recognise `\[…\]` display math.
 * @property {boolean|string[]} [environments] - Recognise display-math
 *   `\begin{…}…\end{…}` environments. `true`/absent → the built-in set
 *   (equation, align, …); `false` → none; an array → only those base
 *   environment names (the starred form is matched too).
 */

/**
 * The display-math `\begin{…}…\end{…}` environments MathJax typesets at
 * the top level (base names; the starred form is stripped before lookup).
 * Inner environments used *inside* math (matrix, cases, …) are not here —
 * they appear within another segment, not standalone.
 *
 * @type {readonly string[]}
 */
export const MATH_ENVIRONMENT_NAMES = Object.freeze([
  'equation',
  'align',
  'alignat',
  'gather',
  'multline',
  'flalign',
  'eqnarray',
  'displaymath',
]);

/**
 * The full LaTeX config: every delimiter pair plus `\begin…\end` math
 * environments. This is the historical (and default) behaviour, used by
 * `latex-mode`.
 *
 * @type {Readonly<MathConfig>}
 */
export const LATEX_MATH_CONFIG = Object.freeze({
  inlineDollar: true,
  displayDollar: true,
  parens: true,
  brackets: true,
  environments: true,
});

/**
 * The "common" config: the four delimiter pairs but **no** `\begin…\end`
 * environments. Used by `markdown-mode` (and, when they land, html/php)
 * — prose modes where `\begin{equation}` is not display math the way it
 * is in a `.tex` file.
 *
 * @type {Readonly<MathConfig>}
 */
export const MARKDOWN_MATH_CONFIG = Object.freeze({
  inlineDollar: true,
  displayDollar: true,
  parens: true,
  brackets: true,
  environments: false,
});

/**
 * True when the character at `index` in `text` is escaped — preceded by
 * an odd number of consecutive backslashes. `\$` is escaped (one
 * backslash), `\\$` is not (two backslashes escape each other, leaving
 * the `$` live).
 *
 * @param {string} text
 * @param {number} index
 * @returns {boolean}
 */
function isEscaped(text, index) {
  let backslashes = 0;
  let i = index - 1;
  while (i >= 0 && text.charCodeAt(i) === 92 /* '\\' */) {
    backslashes += 1;
    i -= 1;
  }
  return (backslashes & 1) === 1;
}

/**
 * Scan LaTeX source for math segments, respecting backslash escaping and
 * `%` line comments. Returns the segments in document order, none
 * overlapping.
 *
 * The scan is delimiter-driven and forgiving: an opening delimiter with
 * no matching close (a half-typed `$`, or a `\[` with no `\]`) is *not*
 * reported — there is no complete segment yet, so nothing is replaced.
 * This is exactly the right behaviour while the user is authoring fresh
 * math.
 *
 * Precedence at a given position, longest delimiter first, so `$$`
 * beats `$`:
 *
 *   1. `$$ … $$`  (display)
 *   2. `\[ … \]`  (display)
 *   3. `\( … \)`  (inline)
 *   4. `$ … $`    (inline)
 *
 * @param {string} text - The buffer text.
 * @param {MathConfig} [config] - Which constructs to recognise. Defaults
 *   to `LATEX_MATH_CONFIG` (everything), so existing LaTeX callers that
 *   pass only `text` are unchanged.
 * @returns {MathSegment[]}
 */
export function scanMathSegments(text, config = LATEX_MATH_CONFIG) {
  if (typeof text !== 'string' || text.length === 0) return [];
  // Resolve the config flags once. An absent flag defaults to *on*, so a
  // bare `{}` (or no config) scans everything.
  const inlineDollar = config.inlineDollar !== false;
  const displayDollar = config.displayDollar !== false;
  const parens = config.parens !== false;
  const brackets = config.brackets !== false;
  const environments = config.environments ?? true;
  /** @type {Set<string> | null} */
  const envNames = resolveEnvNames(environments);
  /** @type {MathSegment[]} */
  const segments = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text.charCodeAt(i);

    // Skip `%` line comments (unless the `%` is escaped — `\%`).
    if (ch === 37 /* '%' */ && !isEscaped(text, i)) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }

    // A backslash starts either an escape (`\$`, `\%`) or a delimiter
    // command (`\(`, `\[`). `\(` / `\[` are math openers; any other
    // `\x` consumes the following char so e.g. `\$` is never a `$`.
    if (ch === 92 /* '\\' */) {
      // `\begin{ENV}…\end{ENV}` math environments (align, equation,
      // gather, multline, alignat, flalign, eqnarray, displaymath — and
      // their starred forms). MathJax typesets the whole environment, so
      // the segment body is the *full* `\begin…\end` source (delimiters
      // are part of the math, not stripped). Always display (`block`).
      if (envNames && text.startsWith('\\begin{', i)) {
        const env = scanEnvironment(text, i, envNames);
        if (env) {
          segments.push(env);
          i = env.end;
          continue;
        }
        // Not a math environment (or no matching `\end`) — fall through
        // and treat the backslash as an ordinary command.
      }
      const next = text.charCodeAt(i + 1);
      if (parens && next === 40 /* '(' */) {
        const found = scanTo(text, i + 2, '\\)');
        if (found !== -1) {
          segments.push({
            start: i,
            end: found + 2,
            kind: 'inline',
            body: text.slice(i + 2, found),
          });
          i = found + 2;
          continue;
        }
        // No close — skip just the opener so a later `$…$` still scans.
        i += 2;
        continue;
      }
      if (brackets && next === 91 /* '[' */) {
        const found = scanTo(text, i + 2, '\\]');
        if (found !== -1) {
          segments.push({
            start: i,
            end: found + 2,
            kind: 'block',
            body: text.slice(i + 2, found),
          });
          i = found + 2;
          continue;
        }
        i += 2;
        continue;
      }
      // A plain escape (`\$`, `\%`, `\\`, …): consume the escaped char
      // so it can never be read as a delimiter.
      i += 2;
      continue;
    }

    if (ch === 36 /* '$' */) {
      const isDouble = text.charCodeAt(i + 1) === 36;
      if (isDouble) {
        if (displayDollar) {
          const found = scanToDollar(text, i + 2, true);
          if (found !== -1) {
            segments.push({
              start: i,
              end: found + 2,
              kind: 'block',
              body: text.slice(i + 2, found),
            });
            i = found + 2;
            continue;
          }
        }
        i += 2;
        continue;
      }
      if (inlineDollar) {
        const found = scanToDollar(text, i + 1, false);
        if (found !== -1) {
          segments.push({
            start: i,
            end: found + 1,
            kind: 'inline',
            body: text.slice(i + 1, found),
          });
          i = found + 1;
          continue;
        }
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  return segments;
}

/** The built-in math-environment names as a Set (lazy singleton). */
const MATH_ENVIRONMENTS = new Set(MATH_ENVIRONMENT_NAMES);

/**
 * Resolve the `environments` config flag to the set of base names to
 * recognise, or null when environments are off.
 *
 * @param {boolean|string[]} environments
 * @returns {Set<string> | null}
 */
function resolveEnvNames(environments) {
  if (environments === false) return null;
  if (Array.isArray(environments)) return new Set(environments);
  return MATH_ENVIRONMENTS;
}

/**
 * Parse a `\begin{ENV}…\end{ENV}` math environment whose `\begin` is at
 * `start` (the backslash). Returns a `block` segment whose `body` is the
 * *full* source (`\begin{ENV}` … `\end{ENV}` included — MathJax processes
 * the environment itself), or null when ENV isn't a recognised math
 * environment or there's no matching `\end`.
 *
 * @param {string} text
 * @param {number} start - Offset of the `\` in `\begin{`.
 * @param {Set<string>} envNames - The recognised base environment names.
 * @returns {MathSegment | null}
 */
function scanEnvironment(text, start, envNames) {
  const nameStart = start + '\\begin{'.length;
  const nameEnd = text.indexOf('}', nameStart);
  if (nameEnd === -1) return null;
  const name = text.slice(nameStart, nameEnd);
  const base = name.endsWith('*') ? name.slice(0, -1) : name;
  if (!envNames.has(base)) return null;
  // The matching close. These top-level environments don't nest the same
  // name, so the first `\end{NAME}` after the opener is the right one.
  const closer = `\\end{${name}}`;
  const closeAt = text.indexOf(closer, nameEnd + 1);
  if (closeAt === -1) return null;
  const end = closeAt + closer.length;
  return { start, end, kind: 'block', body: text.slice(start, end) };
}

/**
 * Find the offset of the next unescaped occurrence of the literal
 * `closer` (a `\)` or `\]`) at or after `from`. Returns the index of the
 * closer's first character, or -1 if none. `%` comments inside a display
 * block do *not* terminate it (math spans comments in TeX only loosely;
 * we keep the close-delimiter search literal, which is the common case).
 *
 * @param {string} text
 * @param {number} from
 * @param {string} closer - Either `'\\)'` or `'\\]'`.
 * @returns {number}
 */
function scanTo(text, from, closer) {
  const n = text.length;
  const closerChar = closer.charCodeAt(1); // ')' or ']'
  let i = from;
  while (i < n) {
    const ch = text.charCodeAt(i);
    if (ch === 92 /* '\\' */) {
      if (text.charCodeAt(i + 1) === closerChar) return i;
      // Any other escape consumes the next char (`\\`, `\$`, …).
      i += 2;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * Find the offset of the next unescaped `$` (single) or `$$` (double)
 * closer at or after `from`. Returns the index of the closing `$`'s
 * first character, or -1 if none.
 *
 * @param {string} text
 * @param {number} from
 * @param {boolean} wantDouble - When true, a single `$` does not close;
 *   only `$$` does.
 * @returns {number}
 */
function scanToDollar(text, from, wantDouble) {
  const n = text.length;
  let i = from;
  while (i < n) {
    const ch = text.charCodeAt(i);
    if (ch === 92 /* '\\' */) {
      // Escape: consume the escaped character (`\$` is literal).
      i += 2;
      continue;
    }
    if (ch === 36 /* '$' */) {
      const double = text.charCodeAt(i + 1) === 36;
      if (wantDouble) {
        if (double) return i;
        // A lone `$` inside `$$…$$` is unusual; treat it as ordinary.
        i += 1;
        continue;
      }
      // Single-dollar inline: a `$$` here would be the start of a new
      // display segment, not a close — but inside an inline `$…$` that
      // can't happen with well-formed input, so close on the first `$`.
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Adapt LaTeX tree-sitter math-node ranges into math segments. The
 * grammar marks `inline_formula` (`$…$`, `\(…\)`) and `displayed_equation`
 * (`$$…$$`, `\[…\]`) nodes; this turns those `{start, end, type}` records
 * into `{start, end, kind, body}` by stripping the outer delimiters.
 *
 * Delimiter widths are inferred from the source so the body is exact:
 * a node opening with `$$`/`\[` is a 2-char delimiter, `$`/`\(` is
 * inferred from whether the node opens with `$$` (display) or a single
 * `$` / `\(`.
 *
 * Nodes whose source doesn't begin with a recognised opener are skipped
 * (defensive — the grammar should never hand us one).
 *
 * @param {string} text
 * @param {{ start: number, end: number, type: string }[]} nodeRanges
 * @returns {MathSegment[]}
 */
export function segmentsFromNodeRanges(text, nodeRanges) {
  if (!Array.isArray(nodeRanges) || nodeRanges.length === 0) return [];
  /** @type {MathSegment[]} */
  const out = [];
  for (const node of nodeRanges) {
    const src = text.slice(node.start, node.end);
    const seg = segmentFromSource(node.start, src);
    if (seg) out.push(seg);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Build one segment from a node's absolute start and its source text,
 * stripping the matching delimiter pair. Returns null if the source
 * doesn't start with a recognised opener and end with its closer.
 *
 * @param {number} start
 * @param {string} src
 * @returns {MathSegment | null}
 */
function segmentFromSource(start, src) {
  // Display first (longest openers), then inline.
  if (src.startsWith('$$') && src.endsWith('$$') && src.length >= 4) {
    return {
      start,
      end: start + src.length,
      kind: 'block',
      body: src.slice(2, src.length - 2),
    };
  }
  if (src.startsWith('\\[') && src.endsWith('\\]') && src.length >= 4) {
    return {
      start,
      end: start + src.length,
      kind: 'block',
      body: src.slice(2, src.length - 2),
    };
  }
  if (src.startsWith('\\(') && src.endsWith('\\)') && src.length >= 4) {
    return {
      start,
      end: start + src.length,
      kind: 'inline',
      body: src.slice(2, src.length - 2),
    };
  }
  if (src.startsWith('$') && src.endsWith('$') && src.length >= 2) {
    return {
      start,
      end: start + src.length,
      kind: 'inline',
      body: src.slice(1, src.length - 1),
    };
  }
  return null;
}

/**
 * Is `point` strictly inside the segment `[start, end)` — i.e. does the
 * segment's source need revealing for editing?
 *
 * The reveal boundary is **exclusive at both ends** (`start < point <
 * end`): a cursor immediately before the opening delimiter or one past
 * the closing delimiter shows the typeset widget; a single step inward
 * reveals the source. This is the whole edit cycle expressed as one
 * predicate.
 *
 * @param {MathSegment} segment
 * @param {number} point
 * @returns {boolean}
 */
export function pointInsideSegment(segment, point) {
  return point > segment.start && point < segment.end;
}

/**
 * The segment in `segments` that contains `point` (strictly), or null.
 * Segments are assumed non-overlapping, so at most one matches.
 *
 * @param {MathSegment[]} segments
 * @param {number} point
 * @returns {MathSegment | null}
 */
export function segmentContainingPoint(segments, point) {
  for (const segment of segments) {
    if (pointInsideSegment(segment, point)) return segment;
  }
  return null;
}

/**
 * Whether a body is empty or whitespace-only — such a segment is treated
 * as *invalid* (rendered as source with a red wavy underline) rather
 * than typeset.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function isEmptyBody(body) {
  return typeof body !== 'string' || body.trim() === '';
}
