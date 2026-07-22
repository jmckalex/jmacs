/**
 * @file JMarkdown dialect scanner — the code-driven source behind the
 * `jmarkdown` language's `captureProvider`, `foldProvider`, and (in
 * part) `injectionProvider`.
 *
 * The `jmarkdown` language reuses the stock tree-sitter markdown
 * grammars, which know nothing about the dialect's extensions. This
 * scanner is a port of the architect's `JMarkdown.sublime-syntax`
 * state machine, covering what that file highlights over stock
 * Markdown:
 *
 *   - the metadata header (bold keys; `Extension N:` value specs;
 *     `Custom element:` names; indented HTML bodies → html injection)
 *   - block directives `:::name` … `:::` (3–8 colons, nesting by
 *     count), with `:::TiKZ` bodies → latex and `:::mermaid` bodies →
 *     the Mermaid scanner; all foldable per colon level
 *   - `@begin(name)`…`@end(name)` environments, with TeX/equation/
 *     align/… bodies → latex and mermaid bodies → the Mermaid scanner;
 *     foldable on a name-agnostic stack
 *   - inline directives `:name[content]{.class #id attr="v"}`
 *   - `@name[text]{attrs}` directives (inline) and `@name+[text]{attrs}`
 *     (block), with an optional `<name>` angle form: the `[text]` group
 *     is injected into `jmarkdown_inline` (and its interior left unclaimed,
 *     so the scanner's own inline passes also paint over it); the `{attrs}`
 *     group is injected into html (wrapped so its attributes highlight),
 *     and a `style="…"` value inside it is further injected into css
 *   - `{{mustache}}` variables, `==highlight==` spans, `/italic/`
 *     spans (with `\/` escapes and the mid-word-slash abort)
 *   - embedded JavaScript chains `ident(...).prop(...)` → javascript
 *     injection (the real grammar, in place of Sublime's hand-rolled
 *     tokenizer)
 *   - `<script>` / `<style>` blocks → html injection (raw-text close);
 *     block-level HTML (known block tags + dashed custom elements) →
 *     html injection through the first blank line
 *
 * Plus three small dialect constructs Sublime leaves plain, approved
 * in the feature plan: `\cite{…}` family commands, `[^label:`/`[fn:`
 * footnote openers, and `[[file]]` inclusion lines. (Alignment
 * `>> … <<` and description lists are deliberately *not* scanned —
 * Sublime renders those through stock Markdown, and so do we.)
 *
 * The scan works on a masked copy of the text: fenced code, inline
 * code spans, and math segments are blanked first (the grammar and the
 * math injection own those), and each pass blanks what it consumes so
 * later passes cannot match inside it. Length is always preserved, so
 * every offset refers to the original text.
 *
 * Pure and DOM-free; tested on its own. The language module
 * (`./languages/jmarkdown.js`) memoises the result per text.
 */

import {
  scanMathSegments,
  maskMarkdownCode,
  MARKDOWN_MATH_CONFIG,
} from './math-segments.js';
import { scanMermaid } from './mermaid-scan.js';

/** @typedef {{ start: number, end: number, face: string }} CaptureRange */

/**
 * @typedef {object} JmarkdownScan
 * @property {CaptureRange[]} captures - Dialect captures to paint.
 * @property {{ start: number, end: number }[]} regions - Spans the
 *   dialect owns; grammar/injected captures are clipped out of them.
 * @property {{ start: number, end: number }[]} folds - Foldable spans
 *   (directive blocks, `@begin/@end` environments).
 * @property {{ start: number, end: number, language: string,
 *   wrapPrefix?: string, wrapSuffix?: string }[]} injections -
 *   Code-driven language injections (latex, javascript, html, …). An
 *   entry may carry `wrapPrefix`/`wrapSuffix` to be highlighted inside a
 *   synthetic context — a directive's `{…}` attribute list injected into
 *   html as `<x … />`; see `treesitter.js#spliceInjections`.
 */

/** LaTeX-bodied `@begin(…)` environment names (the Sublime list). */
const LATEX_ENVIRONMENTS =
  /^(?:TeX|equation\*?|align\*?|gather\*?|multline\*?|tikzpicture|TiKZ|tikz)$/;

/** Block-level HTML tag names (CommonMark's type-6 list plus the media
 *  and embedded-content elements), case-insensitive. A line opening one
 *  of these — or any dashed custom element — starts an HTML block. */
const HTML_BLOCK_TAGS = new RegExp(
  '^(?:address|article|aside|audio|blockquote|body|canvas|caption|center|col|' +
  'colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|' +
  'form|frame|frameset|h[1-6]|head|header|hr|html|iframe|img|legend|li|link|' +
  'main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|picture|pre|' +
  'section|source|summary|svg|table|tbody|td|template|tfoot|th|thead|title|' +
  'tr|track|ul|video)$',
  'i'
);

/**
 * Scan a JMarkdown document.
 *
 * @param {string} text
 * @returns {JmarkdownScan}
 */
export function scanJmarkdown(text) {
  /** @type {JmarkdownScan} */
  const out = { captures: [], regions: [], folds: [], injections: [] };
  if (typeof text !== 'string' || text.length === 0) return out;

  // The masked working copy: code first (fences + inline spans), then
  // math segments — both length-preserving, so offsets into the copy
  // are offsets into the original.
  const buf = maskMarkdownCode(text).split('');
  for (const seg of scanMathSegments(buf.join(''), MARKDOWN_MATH_CONFIG)) {
    blank(buf, seg.start, seg.end);
  }

  const lineStarts = computeLineStarts(text);
  const ctx = {
    text,
    buf,
    lineStarts,
    lineCount: lineStarts.length,
    out,
    /** Spans already claimed by an inline construct. @type {{s:number,e:number}[]} */
    claimed: [],
  };

  const afterHeader = scanHeader(ctx);
  scanBlocks(ctx, afterHeader);
  scanInlines(ctx);
  return out;
}

/* ── small shared helpers ────────────────────────────────────────────── */

/** Blank `[start, end)` in the char buffer, preserving newlines. */
function blank(buf, start, end) {
  for (let i = start; i < end; i += 1) {
    if (buf[i] !== '\n') buf[i] = ' ';
  }
}

/** Offsets of every line's first character. */
function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** The line's content (from the masked buffer), without its newline. */
function lineAt(ctx, i) {
  return ctx.buf.slice(ctx.lineStarts[i], lineEnd(ctx, i)).join('');
}

/** Offset one past the line's last character (its newline's offset). */
function lineEnd(ctx, i) {
  return i + 1 < ctx.lineCount
    ? ctx.lineStarts[i + 1] - 1
    : ctx.text.length;
}

/** Push a capture. */
function cap(ctx, start, end, face) {
  if (end > start) ctx.out.captures.push({ start, end, face });
}

/** Push an owned region, merging with the previous one when adjacent. */
function region(ctx, start, end) {
  if (end <= start) return;
  const last = ctx.out.regions[ctx.out.regions.length - 1];
  if (last && start <= last.end + 1 && start >= last.start) {
    if (end > last.end) last.end = end;
    return;
  }
  ctx.out.regions.push({ start, end });
}

/** Consume a whole line: own it, and blank it in the working copy. */
function consumeLine(ctx, i) {
  region(ctx, ctx.lineStarts[i], lineEnd(ctx, i));
  blank(ctx.buf, ctx.lineStarts[i], lineEnd(ctx, i));
}

/** Mark an inline span as claimed so later matchers skip it. */
function claim(ctx, s, e) {
  ctx.claimed.push({ s, e });
}

/** Is the offset inside a claimed span? */
function isClaimed(ctx, pos) {
  return ctx.claimed.some((c) => c.s <= pos && pos < c.e);
}

/* ── the metadata header ─────────────────────────────────────────────── */

/**
 * Scan the metadata header, when the document opens with one: a
 * `---` fence, or (legacy) a first line shaped like `Key: value` —
 * detected with the processor's own key pattern, `[-A-Za-z0-9 ]+:`,
 * which is stricter than Sublime's lookahead (a `# Heading: x` first
 * line is not a header).
 *
 * @param {object} ctx
 * @returns {number} The line index after the header (0 = no header).
 */
function scanHeader(ctx) {
  if (ctx.lineCount === 0) return 0;
  let i = 0;
  const first = lineAt(ctx, 0);
  if (/^-{3,}$/.test(first)) {
    cap(ctx, ctx.lineStarts[0], lineEnd(ctx, 0), 'jmd-meta-fence');
    consumeLine(ctx, 0);
    i = 1;
  } else if (/^[-A-Za-z0-9 ]+:/.test(first) && legacyHeaderTerminated(ctx)) {
    i = 0;
  } else {
    return 0;
  }

  while (i < ctx.lineCount) {
    const ls = ctx.lineStarts[i];
    const line = lineAt(ctx, i);
    let m;

    if (/^-{3,}$/.test(line)) {
      cap(ctx, ls, lineEnd(ctx, i), 'jmd-meta-fence');
      consumeLine(ctx, i);
      return i + 1;
    }

    if ((m = /^(Custom element):\s*(\S.*)?$/.exec(line))) {
      cap(ctx, ls, ls + m[1].length, 'jmd-meta-key');
      if (m[2]) {
        const at = line.lastIndexOf(m[2]);
        cap(ctx, ls + at, ls + at + m[2].length, 'jmd-meta-element');
      }
      consumeLine(ctx, i);
      i = headerBody(ctx, i + 1);
      continue;
    }

    if ((m = /^(Extension[ \t]+\S[^:]*):(.*)$/.exec(line))) {
      cap(ctx, ls, ls + m[1].length, 'jmd-meta-key');
      extensionValue(ctx, m[2], ls + m[1].length + 1);
      consumeLine(ctx, i);
      i = headerBody(ctx, i + 1);
      continue;
    }

    if ((m = /^(\S[^:]*):/.exec(line))) {
      cap(ctx, ls, ls + m[1].length, 'jmd-meta-key');
    }
    // Continuation/blank lines carry no captures but are still owned.
    consumeLine(ctx, i);
    i += 1;
  }
  // No closing fence: like Sublime, the header runs to end of file.
  return ctx.lineCount;
}

/**
 * A fence-less (legacy) header is accepted only when its terminating
 * `---` line arrives before the first blank line. Sublime's lookahead
 * (`^(?=\S[^:]*:)`) treats *any* colon-bearing first line as a header
 * — "See :ref[x] for…" would swallow the whole document — which is far
 * too eager for an editor. Real legacy headers are a contiguous block
 * of key lines closed by `---`, which is exactly what this checks.
 *
 * @param {object} ctx
 * @returns {boolean}
 */
function legacyHeaderTerminated(ctx) {
  for (let i = 1; i < ctx.lineCount; i += 1) {
    const line = lineAt(ctx, i);
    if (/^-{3,}$/.test(line)) return true;
    if (/^[ \t]*$/.test(line)) return false;
  }
  return false;
}

/**
 * The `Extension N:` value line — either two `/regex/` tokens or two
 * bare delimiter tokens, then the parse-flags boolean (or list) and
 * the argument count.
 *
 * @param {object} ctx
 * @param {string} rest - The text after the colon.
 * @param {number} base - Absolute offset of `rest[0]`.
 */
function extensionValue(ctx, rest, base) {
  const BOOLS = '(\\[(?:true|false)(?:\\s*,\\s*(?:true|false))*\\]|true|false)';
  let m = new RegExp(
    `^\\s*(\\/\\S+\\/)\\s+(\\/\\S+\\/)\\s+${BOOLS}\\s+(\\d+)\\s*$`
  ).exec(rest);
  let faces = ['jmd-meta-regex', 'jmd-meta-regex'];
  if (!m) {
    m = new RegExp(`^\\s*(\\S+)\\s+(\\S+)\\s+${BOOLS}\\s+(\\d+)\\s*$`).exec(
      rest
    );
    faces = ['jmd-meta-delim', 'jmd-meta-delim'];
  }
  if (!m) return;
  let at = 0;
  const groups = [m[1], m[2], m[3], m[4]];
  const groupFaces = [...faces, 'jmd-meta-bool', 'jmd-meta-number'];
  for (let g = 0; g < groups.length; g += 1) {
    at = rest.indexOf(groups[g], at);
    cap(ctx, base + at, base + at + groups[g].length, groupFaces[g]);
    at += groups[g].length;
  }
}

/**
 * The indented HTML body under an `Extension`/`Custom element` key:
 * lines until the next non-indented line or the closing fence. The
 * body is injected into the html grammar (Sublime includes
 * `text.html.basic`) and blanked, but *not* owned — the injection's
 * captures must survive.
 *
 * @param {object} ctx
 * @param {number} from - First candidate body line.
 * @returns {number} The line index after the body.
 */
function headerBody(ctx, from) {
  let j = from;
  while (
    j < ctx.lineCount &&
    !/^\S/.test(lineAt(ctx, j)) &&
    !/^-{3,}$/.test(lineAt(ctx, j))
  ) {
    j += 1;
  }
  if (j > from) {
    const start = ctx.lineStarts[from];
    const end = lineEnd(ctx, j - 1);
    if (ctx.text.slice(start, end).trim() !== '') {
      ctx.out.injections.push({ start, end, language: 'html' });
    }
    blank(ctx.buf, start, end);
  }
  return j;
}

/* ── block constructs ────────────────────────────────────────────────── */

/**
 * Scan block directives, `@begin/@end` environments, `<script>`
 * blocks, and `[[file]]` inclusion lines, maintaining the two nesting
 * stacks. Consumed lines are blanked so the inline pass skips them.
 *
 * @param {object} ctx
 * @param {number} from - First line after the header.
 */
function scanBlocks(ctx, from) {
  /** @type {{ colons: number, start: number }[]} */
  const dirStack = [];
  /** @type {number[]} */
  const envStack = [];
  let k = from;

  while (k < ctx.lineCount) {
    const ls = ctx.lineStarts[k];
    const line = lineAt(ctx, k);
    let m;

    // --- :::TiKZ / :::mermaid (exactly three colons, like Sublime) ---
    if ((m = /^(:::)(?!:)(TiKZ|tikz|mermaid)\b/.exec(line))) {
      k = verbatimDirective(ctx, k, m[2] === 'mermaid' ? 'mermaid' : 'latex', m);
      continue;
    }

    // --- generic block directives, openers and closers ---
    if ((m = /^(:{3,})([A-Za-z][A-Za-z0-9-]*)?/.exec(line))) {
      const colons = m[1].length;
      const top = dirStack[dirStack.length - 1];
      if (!m[2] && /^:{3,}\s*$/.test(line) && top && top.colons === colons) {
        cap(ctx, ls, ls + colons, 'jmd-directive-punct');
        ctx.out.folds.push({ start: top.start, end: lineEnd(ctx, k) });
        dirStack.pop();
      } else {
        cap(ctx, ls, ls + colons, 'jmd-directive-punct');
        if (m[2]) {
          cap(ctx, ls + colons, ls + m[0].length, 'jmd-directive-name');
        }
        afterName(ctx, line, m[0].length, ls);
        dirStack.push({ colons, start: ls });
      }
      consumeLine(ctx, k);
      k += 1;
      continue;
    }

    // --- @begin(…) environments ---
    if ((m = /^[ \t]*(@begin)(\()(\.|<)?([A-Za-z][\w-]*\*?)(>)?(\))/.exec(line))) {
      if (LATEX_ENVIRONMENTS.test(m[4]) && !m[3]) {
        k = verbatimEnvironment(ctx, k, 'latex', m);
        continue;
      }
      if (m[4] === 'mermaid' && !m[3]) {
        k = verbatimEnvironment(ctx, k, 'mermaid', m);
        continue;
      }
      const end = environmentZones(ctx, k, m);
      envStack.push(ls);
      region(ctx, ls, end);
      blank(ctx.buf, ls, end);
      k += 1;
      continue;
    }

    // --- @end(…) ---
    if ((m = /^[ \t]*(@end)(\()([^)]*)(\))/.exec(line))) {
      const end = environmentZones(ctx, k, m);
      const open = envStack.pop();
      if (open !== undefined) {
        // A *block* fold: collapsing keeps both the `@begin(…)` and the
        // `@end(…)` lines visible, with a vertical ellipsis between them —
        // rather than swallowing the closing line (`@end(…)` is not a
        // structural close the line-based preview would re-show). See
        // folding.js / view.js.
        ctx.out.folds.push({ start: open, end: lineEnd(ctx, k), block: true });
      }
      region(ctx, ls, end);
      blank(ctx.buf, ls, end);
      k += 1;
      continue;
    }

    // --- <script> blocks → the html grammar ---
    if (/^\s*<script\b/.test(line)) {
      let c = k;
      while (c < ctx.lineCount && !/<\/script>/.test(lineAt(ctx, c))) c += 1;
      const last = Math.min(c, ctx.lineCount - 1);
      ctx.out.injections.push({
        start: ls,
        end: lineEnd(ctx, last),
        language: 'html',
      });
      blank(ctx.buf, ls, lineEnd(ctx, last));
      k = last + 1;
      continue;
    }

    // --- <style> blocks → the html grammar (css nests via html.js) ---
    // Raw-text semantics like <script>: the block runs to the closing
    // tag regardless of blank lines. tree-sitter-html injects the body
    // into css, so the sheet highlights properly — and blanking stops
    // the inline pass reading `div.center` as an expression chain.
    if (/^\s{0,3}<style\b/.test(line)) {
      let c = k;
      while (c < ctx.lineCount && !/<\/style>/.test(lineAt(ctx, c))) c += 1;
      const last = Math.min(c, ctx.lineCount - 1);
      ctx.out.injections.push({
        start: ls,
        end: lineEnd(ctx, last),
        language: 'html',
      });
      blank(ctx.buf, ls, lineEnd(ctx, last));
      k = last + 1;
      continue;
    }

    // --- block-level HTML → the html grammar --------------------------
    // A line opening (or closing) a KNOWN block-level tag — or a custom
    // element (any dashed name, e.g. <dissertation-feedback>) — at up to
    // three spaces of indent starts an HTML block, CommonMark-style: it
    // runs to the first blank line. The whole run is injected into the
    // html grammar and blanked. Inline HTML *within* a prose paragraph
    // is deliberately not consumed here — the inline grammar injects
    // each html_tag on its own (see languages/jmarkdown-inline.js).
    if ((m = /^\s{0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(line)) &&
        (HTML_BLOCK_TAGS.test(m[1]) || m[1].includes('-'))) {
      let c = k;
      while (c + 1 < ctx.lineCount && lineAt(ctx, c + 1).trim() !== '') c += 1;
      ctx.out.injections.push({
        start: ls,
        end: lineEnd(ctx, c),
        language: 'html',
      });
      blank(ctx.buf, ls, lineEnd(ctx, c));
      k = c + 1;
      continue;
    }

    // --- [[file]] inclusion lines ---
    if ((m = /^(\[\[)([^\]]+)(\]\])\s*$/.exec(line))) {
      cap(ctx, ls, ls + 2, 'jmd-punct');
      cap(ctx, ls + 2, ls + 2 + m[2].length, 'jmd-include');
      cap(ctx, ls + 2 + m[2].length, ls + m[0].length, 'jmd-punct');
      consumeLine(ctx, k);
      k += 1;
      continue;
    }

    k += 1;
  }
}

/**
 * A `:::TiKZ` / `:::mermaid` directive: opener zones, a verbatim body
 * (latex injection or the Mermaid scanner), the `:::` closer, and a
 * fold. An unclosed body runs to end of file, exactly like the Sublime
 * context.
 *
 * @param {object} ctx
 * @param {number} k - The opener's line index.
 * @param {'latex'|'mermaid'} kind
 * @param {RegExpExecArray} m - The opener match.
 * @returns {number} The next line index to scan.
 */
function verbatimDirective(ctx, k, kind, m) {
  const ls = ctx.lineStarts[k];
  cap(ctx, ls, ls + 3, 'jmd-directive-punct');
  cap(ctx, ls + 3, ls + m[0].length, 'jmd-directive-name');
  afterName(ctx, lineAt(ctx, k), m[0].length, ls);
  consumeLine(ctx, k);

  let c = k + 1;
  while (c < ctx.lineCount && !/^:::\s*$/.test(lineAt(ctx, c))) c += 1;
  verbatimBody(ctx, k, c, kind);
  if (c < ctx.lineCount) {
    cap(ctx, ctx.lineStarts[c], ctx.lineStarts[c] + 3, 'jmd-directive-punct');
    ctx.out.folds.push({ start: ls, end: lineEnd(ctx, c) });
    consumeLine(ctx, c);
  }
  return c + 1;
}

/**
 * A `@begin(TeX|…|mermaid)` environment: opener/closer zones, the
 * verbatim body, and a fold.
 *
 * @param {object} ctx
 * @param {number} k - The opener's line index.
 * @param {'latex'|'mermaid'} kind
 * @param {RegExpExecArray} m - The opener match.
 * @returns {number} The next line index to scan.
 */
function verbatimEnvironment(ctx, k, kind, m) {
  const ls = ctx.lineStarts[k];
  environmentZones(ctx, k, m);
  consumeLine(ctx, k);

  let c = k + 1;
  while (c < ctx.lineCount && !/^[ \t]*@end\(/.test(lineAt(ctx, c))) c += 1;
  verbatimBody(ctx, k, c, kind);
  if (c < ctx.lineCount) {
    const em = /^[ \t]*(@end)(\()([^)]*)(\))/.exec(lineAt(ctx, c));
    if (em) environmentZones(ctx, c, em);
    ctx.out.folds.push({ start: ls, end: lineEnd(ctx, c) });
    consumeLine(ctx, c);
  }
  return c + 1;
}

/**
 * The body between opener line `k` and closer line `c` (exclusive):
 * latex bodies become injections; mermaid bodies get scanned captures
 * plus an owned region (no grammar bleed-through). Both are blanked.
 *
 * @param {object} ctx
 * @param {number} k - Opener line index.
 * @param {number} c - Closer line index (may be `lineCount`).
 * @param {'latex'|'mermaid'} kind
 */
function verbatimBody(ctx, k, c, kind) {
  if (c <= k + 1) return;
  const start = ctx.lineStarts[k + 1];
  const end = c < ctx.lineCount ? ctx.lineStarts[c] - 1 : ctx.text.length;
  if (end <= start) return;
  if (kind === 'latex') {
    ctx.out.injections.push({ start, end, language: 'latex' });
  } else {
    region(ctx, start, end);
    ctx.out.captures.push(...scanMermaid(ctx.text.slice(start, end), start));
  }
  blank(ctx.buf, start, end);
}

/**
 * Capture the colour zones of one `@begin(name)` / `@end(name)` line —
 * the keyword, the parens (and `.`/`<`/`>` name sigils), the name —
 * then any `[label]{attrs}` tail.
 *
 * @param {object} ctx
 * @param {number} k - The line index.
 * @param {RegExpExecArray} m - A begin/end match for that line.
 * @returns {number} Absolute offset one past the construct (after any
 *   `[label]{attrs}` tail).
 */
function environmentZones(ctx, k, m) {
  const ls = ctx.lineStarts[k];
  let at = ls + m[0].indexOf(m[1]);
  cap(ctx, at, at + m[1].length, 'jmd-env-keyword');
  at += m[1].length;
  cap(ctx, at, at + 1, 'jmd-env-paren'); // (
  at += 1;
  // Optional sigil, the name, optional closing sigil — group layout
  // differs between the begin and end regexes, so re-parse the span.
  const inner = /^(\.|<)?([A-Za-z][\w-]*\*?)?(>)?/.exec(
    ctx.text.slice(at, ls + m[0].length - 1)
  );
  if (inner) {
    if (inner[1]) cap(ctx, at, at + 1, 'jmd-env-paren');
    if (inner[2]) {
      const s = at + (inner[1] ? 1 : 0);
      cap(ctx, s, s + inner[2].length, 'jmd-env-name');
    }
    if (inner[3]) {
      const s = at + inner[0].length - 1;
      cap(ctx, s, s + 1, 'jmd-env-paren');
    }
  }
  const close = ls + m[0].length - 1;
  cap(ctx, close, close + 1, 'jmd-env-paren'); // )
  return afterName(ctx, lineAt(ctx, k), m[0].length, ls);
}

/* ── the directive tail: [content]{.class #id attr="val"} ────────────── */

/**
 * Parse a directive's optional `[content]` and `{attributes}` tail on
 * one line, emitting captures. Mirrors Sublime's `directive-after-name`
 * chain (single-line; an unclosed bracket runs to end of line, the
 * Sublime context's bail-at-blank-line collapsed to one line).
 *
 * @param {object} ctx
 * @param {string} line - The line's text.
 * @param {number} col - Column where the tail may start.
 * @param {number} base - Absolute offset of `line[0]`.
 * @returns {number} Absolute offset one past the tail.
 */
function afterName(ctx, line, col, base) {
  let i = col;
  if (line[i] === '[') {
    cap(ctx, base + i, base + i + 1, 'jmd-punct');
    let depth = 1;
    let j = i + 1;
    while (j < line.length && depth > 0) {
      if (line[j] === '[') depth += 1;
      else if (line[j] === ']') depth -= 1;
      j += 1;
    }
    if (depth === 0) {
      cap(ctx, base + i + 1, base + j - 1, 'jmd-directive-bracket');
      cap(ctx, base + j - 1, base + j, 'jmd-punct');
      i = j;
    } else {
      cap(ctx, base + i + 1, base + line.length, 'jmd-directive-bracket');
      return base + line.length;
    }
  }
  if (line[i] === '{') {
    cap(ctx, base + i, base + i + 1, 'jmd-punct');
    let j = i + 1;
    while (j < line.length && line[j] !== '}') {
      const rest = line.slice(j);
      let m;
      if ((m = /^\.([-\w]+)/.exec(rest))) {
        cap(ctx, base + j, base + j + 1, 'jmd-punct');
        cap(ctx, base + j + 1, base + j + m[0].length, 'jmd-attr-class');
        j += m[0].length;
      } else if ((m = /^#([-\w]+)/.exec(rest))) {
        cap(ctx, base + j, base + j + 1, 'jmd-punct');
        cap(ctx, base + j + 1, base + j + m[0].length, 'jmd-attr-id');
        j += m[0].length;
      } else if ((m = /^([-\w]+)(=)(["'])/.exec(rest))) {
        cap(ctx, base + j, base + j + m[1].length, 'jmd-attr-name');
        cap(ctx, base + j + m[1].length, base + j + m[1].length + 1, 'jmd-punct');
        const quote = m[3];
        let q = j + m[0].length;
        while (q < line.length && line[q] !== quote) {
          q += line[q] === '\\' ? 2 : 1;
        }
        q = Math.min(q + 1, line.length);
        cap(ctx, base + j + m[1].length + 1, base + q, 'jmd-string');
        j = q;
      } else if ((m = /^[-\w]+/.exec(rest))) {
        cap(ctx, base + j, base + j + m[0].length, 'jmd-attr-name');
        j += m[0].length;
      } else {
        j += 1;
      }
    }
    if (line[j] === '}') {
      cap(ctx, base + j, base + j + 1, 'jmd-punct');
      j += 1;
    }
    i = j;
  }
  return base + i;
}

/* ── inline constructs ───────────────────────────────────────────────── */

/**
 * Scan the inline constructs over the masked, block-consumed text, in
 * the Sublime `inlines` order: mustache, directives, JS chains,
 * highlight, italic — then the plan's extras (citations, footnote
 * openers).
 *
 * @param {object} ctx
 */
function scanInlines(ctx) {
  const S = ctx.buf.join('');
  // `@name[…]{…}` directives stake out their sigils/brackets first so the
  // later passes still highlight the `[…]` text group (left ambient) while
  // skipping the sigils and the injected `{…}` attribute group.
  atDirectives(ctx, S);
  mustaches(ctx, S);
  inlineDirectives(ctx, S);
  jsChains(ctx, S);
  highlights(ctx, S);
  italics(ctx, S);
  citations(ctx, S);
  footnotes(ctx, S);
}

/** `{{variable}}` */
function mustaches(ctx, S) {
  const re = /(\{\{)([^}\n]+)(\}\})/g;
  let m;
  while ((m = re.exec(S))) {
    if (isClaimed(ctx, m.index)) continue;
    cap(ctx, m.index, m.index + 2, 'jmd-punct');
    cap(ctx, m.index + 2, m.index + 2 + m[2].length, 'jmd-mustache');
    cap(ctx, m.index + 2 + m[2].length, m.index + m[0].length, 'jmd-punct');
    claim(ctx, m.index, m.index + m[0].length);
  }
}

/**
 * Inline directives — `:{2,}name` (name optional, like Sublime) and
 * single-colon `:name` (a letter required, so prose colons, times, and
 * URLs never match). The whole construct, brackets and attributes
 * included, is owned: the grammar reads `[content]` as a link.
 */
function inlineDirectives(ctx, S) {
  for (const re of [
    /(^|\s)(:{2,8})([A-Za-z][A-Za-z0-9-]*)?/g,
    /(^|\s)(:)([A-Za-z][A-Za-z0-9-]*)/g,
  ]) {
    let m;
    while ((m = re.exec(S))) {
      const at = m.index + m[1].length;
      if (isClaimed(ctx, at)) continue;
      cap(ctx, at, at + m[2].length, 'jmd-directive-punct');
      let nameEnd = at + m[2].length;
      if (m[3]) {
        cap(ctx, nameEnd, nameEnd + m[3].length, 'jmd-directive-name');
        nameEnd += m[3].length;
      }
      // The tail parser is line-bound: hand it the rest of this line.
      const eol = S.indexOf('\n', nameEnd);
      const lineEndAt = eol === -1 ? S.length : eol;
      const lineStartAt = S.lastIndexOf('\n', at) + 1;
      const end = afterName(
        ctx,
        S.slice(lineStartAt, lineEndAt),
        nameEnd - lineStartAt,
        lineStartAt
      );
      region(ctx, at, end);
      claim(ctx, at, end);
      re.lastIndex = end;
    }
  }
}

/**
 * `@name[…]{…}` directives — JMarkdown's inline/block directive
 * extension. The opening is `@`, an optional `<`, a `[-A-Za-z0-9]+`
 * name, an optional matching `>` (a `<` obliges a `>`, and vice versa),
 * and — for a *block* directive — a trailing `+` outside the `>`. Then
 * an optional `[jmarkdown text]` group and an optional `{HTML attribute
 * list}` group; both are optional, and either may span lines but not a
 * blank line.
 *
 * The sigils (`@ < > +`) and the group delimiters (`[ ] { }`) are
 * painted and owned. The text group is *not* owned and *not* injected:
 * we are already in a JMarkdown context, so the surrounding
 * highlighting (the paragraph → `jmarkdown_inline` injection, plus the
 * later inline passes here — `==highlight==`, `/italic/`, `{{var}}`, …)
 * paints its interior. The attribute group is injected into the html
 * grammar, wrapped as `<x … />` so tree-sitter-html actually captures
 * the attributes (bare, tagless attributes are top-level text to it);
 * see `treesitter.js#spliceInjections`. The attribute interior is
 * claimed (not owned) so the injection survives the capture-provider
 * clip while the inline passes stay out of it.
 *
 * `@begin(…)` / `@end(…)` environments are consumed and blanked by the
 * block pass before this runs, so they never reach here; a bare `@begin`
 * with no `(` is just a directive named "begin".
 */
function atDirectives(ctx, S) {
  const re = /(^|\s)@(<)?([-A-Za-z0-9]+)(>)?(\+)?/g;
  let m;
  while ((m = re.exec(S))) {
    const at = m.index + m[1].length; // offset of '@'
    if (isClaimed(ctx, at)) continue;
    // Angle brackets come as a pair, or not at all.
    if (Boolean(m[2]) !== Boolean(m[4])) continue;

    // Paint the opening: '@', optional '<', name, optional '>', optional '+'.
    let p = at;
    cap(ctx, p, p + 1, 'jmd-directive-punct'); // @
    p += 1;
    if (m[2]) { cap(ctx, p, p + 1, 'jmd-directive-punct'); p += 1; } // <
    cap(ctx, p, p + m[3].length, 'jmd-directive-name'); // name
    p += m[3].length;
    if (m[4]) { cap(ctx, p, p + 1, 'jmd-directive-punct'); p += 1; } // >
    if (m[5]) { cap(ctx, p, p + 1, 'jmd-directive-punct'); p += 1; } // +
    const openEnd = p;
    region(ctx, at, openEnd);
    claim(ctx, at, openEnd);

    // Optional [jmarkdown text] group: paint/own the brackets, then
    // inject the bracket-free interior into the inline grammar. Injecting
    // the bare slice (rather than leaving the whole `[…]` to the ambient
    // paragraph injection) renders it as clean JMarkdown — bold, emphasis,
    // real links, math — without the shortcut-link mis-parse that a
    // surrounding `[…]` would trigger. The interior is deliberately left
    // *unclaimed*, so the scanner's own inline passes (==highlight==,
    // /italic/, {{var}}, citations, footnotes) still paint over it too.
    if (S[p] === '[') {
      const rb = matchGroup(S, p, '[', ']', false);
      if (rb !== -1) {
        cap(ctx, p, p + 1, 'jmd-punct'); // [
        cap(ctx, rb, rb + 1, 'jmd-punct'); // ]
        region(ctx, p, p + 1);
        region(ctx, rb, rb + 1);
        claim(ctx, p, p + 1);
        claim(ctx, rb, rb + 1);
        if (rb > p + 1) {
          ctx.out.injections.push({
            start: p + 1,
            end: rb,
            language: 'jmarkdown_inline',
          });
        }
        p = rb + 1;
      }
    }

    // Optional {HTML attribute list} group: own/paint the braces, inject
    // the interior into html (wrapped so its attributes are captured),
    // and claim (not own) the interior so the injection shows through.
    if (S[p] === '{') {
      const rc = matchGroup(S, p, '{', '}', true);
      if (rc !== -1) {
        cap(ctx, p, p + 1, 'jmd-punct'); // {
        cap(ctx, rc, rc + 1, 'jmd-punct'); // }
        region(ctx, p, p + 1);
        region(ctx, rc, rc + 1);
        if (rc > p + 1) {
          ctx.out.injections.push({
            start: p + 1,
            end: rc,
            language: 'html',
            wrapPrefix: '<x ',
            wrapSuffix: ' />',
          });
          // A `style="…"` value is CSS, not a bare string — inject each
          // one into the css grammar (pushed after the html injection so
          // it wins the value span). See `styleAttrInjections`.
          styleAttrInjections(ctx, S, p + 1, rc);
          claim(ctx, p + 1, rc);
        }
        claim(ctx, p, p + 1);
        claim(ctx, rc, rc + 1);
        p = rc + 1;
      }
    }
    re.lastIndex = p;
  }
}

/**
 * From an opener at `from` (where `S[from] === open`), return the offset
 * of its matching `close`, or -1 if a blank line or end of input arrives
 * first (JMarkdown forbids a blank line inside a directive group). Groups
 * nest by depth. When `quoteAware`, a `close` inside a `'…'` or `"…"`
 * run (with `\` escapes) does not count — so an attribute value like
 * `style='a}b'` does not close the `{…}` early.
 *
 * @param {string} S
 * @param {number} from
 * @param {string} open
 * @param {string} close
 * @param {boolean} quoteAware
 * @returns {number}
 */
function matchGroup(S, from, open, close, quoteAware) {
  let depth = 1;
  let i = from + 1;
  while (i < S.length) {
    const c = S[i];
    if (quoteAware && (c === '"' || c === "'")) {
      i += 1;
      while (i < S.length && S[i] !== c && S[i] !== '\n') {
        i += S[i] === '\\' ? 2 : 1;
      }
      if (S[i] !== c) continue; // unterminated at EOL/EOF — resume scanning
      i += 1;
      continue;
    }
    if (c === '\n') {
      // A blank (empty/whitespace-only) next line is not permitted.
      if (/^[ \t]*(\n|$)/.test(S.slice(i + 1))) return -1;
      i += 1;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Within a directive's `{…}` attribute list `[from, to)`, inject each
 * `style="…"` / `style='…'` value into the css grammar. tree-sitter-html
 * only injects css into `<style>` *elements*, so a style *attribute*
 * value would otherwise render as a plain string. The value is a
 * declaration list, not a whole stylesheet, so it is wrapped as a rule
 * body `*{…}` (see `treesitter.js#spliceInjections`); the synthetic
 * selector and braces fall outside the real span and are clipped away.
 * Pushed after the list's html injection so it wins the value span.
 *
 * @param {object} ctx
 * @param {string} S - The masked working copy (offsets are document offsets).
 * @param {number} from - Absolute start of the attribute interior.
 * @param {number} to - Absolute end of the attribute interior.
 */
function styleAttrInjections(ctx, S, from, to) {
  const re = /\bstyle\s*=\s*(['"])/g;
  const seg = S.slice(from, to);
  let m;
  while ((m = re.exec(seg))) {
    const quote = m[1];
    const valStart = from + m.index + m[0].length;
    let j = valStart;
    while (j < to && S[j] !== quote) j += S[j] === '\\' ? 2 : 1;
    const valEnd = Math.min(j, to);
    if (valEnd > valStart) {
      ctx.out.injections.push({
        start: valStart,
        end: valEnd,
        language: 'css',
        wrapPrefix: '*{',
        wrapSuffix: '}',
      });
    }
    re.lastIndex = valEnd - from + 1;
  }
}

/** Embedded JavaScript chains → the javascript grammar. */
function jsChains(ctx, S) {
  const re = /(^|\s)(?![eEiI]\.[gGeE]\.)([A-Za-z_]\w*)(?=\(|\.(?=[A-Za-z_]))/g;
  let m;
  while ((m = re.exec(S))) {
    const start = m.index + m[1].length;
    if (isClaimed(ctx, start)) continue;
    const end = walkChain(S, start + m[2].length);
    if (end > start + m[2].length) {
      ctx.out.injections.push({ start, end, language: 'javascript' });
      claim(ctx, start, end);
      re.lastIndex = end;
    }
  }
}

/**
 * Walk a JS expression chain from just past the identifier: `(…)`
 * argument lists (balanced, string-aware) and `.prop` accesses, ending
 * at the line end like Sublime's `js-arguments` (pop at `$`).
 *
 * @param {string} S
 * @param {number} i
 * @returns {number} Offset one past the chain.
 */
function walkChain(S, i) {
  for (;;) {
    if (S[i] === '(') {
      i = walkBalanced(S, i);
    } else if (S[i] === '.' && /[A-Za-z_]/.test(S[i + 1] ?? '')) {
      i += 2;
      while (i < S.length && /\w/.test(S[i])) i += 1;
    } else {
      return i;
    }
  }
}

/**
 * Walk past a balanced bracket run starting at an opener, skipping
 * string literals (with escapes). Bails at end of line — an unclosed
 * argument list ends the chain there.
 *
 * @param {string} S
 * @param {number} i - Offset of the opener.
 * @returns {number} Offset one past the matching closer (or the EOL).
 */
function walkBalanced(S, i) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[S[i]]];
  i += 1;
  while (i < S.length && stack.length > 0) {
    const c = S[i];
    if (c === '\n') return i;
    if (c === '"' || c === "'" || c === '`') {
      i += 1;
      while (i < S.length && S[i] !== c && S[i] !== '\n') {
        i += S[i] === '\\' ? 2 : 1;
      }
      if (S[i] === '\n') return i;
      i += 1;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) stack.pop();
    i += 1;
  }
  return i;
}

/** `==highlight==` spans — owned, so no grammar face bleeds through. */
function highlights(ctx, S) {
  const re = /==(?=\S)/g;
  let m;
  while ((m = re.exec(S))) {
    if (isClaimed(ctx, m.index)) continue;
    const open = m.index;
    const close = S.indexOf('==', open + 2);
    const blankAt = blankLineAfter(S, open + 2);
    if (close !== -1 && (blankAt === -1 || close < blankAt)) {
      cap(ctx, open, open + 2, 'jmd-punct');
      cap(ctx, open + 2, close, 'jmd-highlight');
      cap(ctx, close, close + 2, 'jmd-punct');
      region(ctx, open, close + 2);
      claim(ctx, open, close + 2);
      re.lastIndex = close + 2;
    } else if (blankAt !== -1) {
      cap(ctx, open, open + 2, 'jmd-punct');
      cap(ctx, open + 2, blankAt, 'jmd-highlight');
      region(ctx, open, blankAt);
      claim(ctx, open, blankAt);
      re.lastIndex = blankAt;
    }
    // No closer and no blank line: half-typed at end of file — leave it.
  }
}

/**
 * `/italic/` spans, with Sublime's three exits: a closing `/` before
 * whitespace or trailing punctuation; an *abort* on a mid-word or
 * space-then-word slash (`/usr/bin` never italicises); and a blank
 * line, which ends the span like the Sublime context's pop. `\/` is an
 * escaped slash. Not owned — a nested `*bold*` keeps its grammar face.
 */
function italics(ctx, S) {
  const re = /(^|\s)\/(?=[^\s/])/g;
  let m;
  while ((m = re.exec(S))) {
    const open = m.index + m[1].length;
    if (isClaimed(ctx, open)) continue;
    let j = open + 1;
    let closed = -1;
    let aborted = false;
    while (j < S.length) {
      const c = S[j];
      if (c === '\\' && S[j + 1] === '/') {
        j += 2;
        continue;
      }
      if (c === '/') {
        const next = S[j + 1];
        if (next === undefined || /[\s.,;:!?)]/.test(next)) {
          closed = j;
        } else {
          aborted = true;
        }
        break;
      }
      if (c === '\n') {
        const blankAt = /^[ \t]*(\n|$)/.test(S.slice(j + 1)) ? j : -1;
        if (blankAt !== -1) {
          closed = blankAt; // partial span, no closing punct
          break;
        }
      }
      j += 1;
    }
    if (aborted || closed === -1) continue;
    cap(ctx, open, open + 1, 'jmd-punct');
    cap(ctx, open + 1, closed, 'jmd-italic');
    if (S[closed] === '/') {
      cap(ctx, closed, closed + 1, 'jmd-punct');
      claim(ctx, open, closed + 1);
      re.lastIndex = closed + 1;
    } else {
      claim(ctx, open, closed);
      re.lastIndex = closed;
    }
  }
}

/** `\cite{…}` family — command, optional `[pre][post]`, the keys. */
function citations(ctx, S) {
  const re = /\\(?:full|no)?cite(?:author|year|t|p)?\*?(?=\s*[[{])/g;
  let m;
  while ((m = re.exec(S))) {
    if (isClaimed(ctx, m.index)) continue;
    const start = m.index;
    cap(ctx, start, start + m[0].length, 'jmd-cite');
    let i = start + m[0].length;
    while (S[i] === '[') {
      const close = S.indexOf(']', i + 1);
      const eol = S.indexOf('\n', i + 1);
      if (close === -1 || (eol !== -1 && eol < close)) break;
      cap(ctx, i, i + 1, 'jmd-punct');
      cap(ctx, i + 1, close, 'jmd-string');
      cap(ctx, close, close + 1, 'jmd-punct');
      i = close + 1;
    }
    if (S[i] === '{') {
      const close = S.indexOf('}', i + 1);
      const eol = S.indexOf('\n', i + 1);
      if (close !== -1 && (eol === -1 || close < eol)) {
        cap(ctx, i, i + 1, 'jmd-punct');
        cap(ctx, i + 1, close, 'jmd-cite-key');
        cap(ctx, close, close + 1, 'jmd-punct');
        i = close + 1;
      }
    }
    region(ctx, start, i);
    claim(ctx, start, i);
    re.lastIndex = i;
  }
}

/** Footnote openers: `[^label:` and `[fn:` (the body renders normally). */
function footnotes(ctx, S) {
  const re = /\[(\^[^\]\s:]+|fn):/g;
  let m;
  while ((m = re.exec(S))) {
    if (isClaimed(ctx, m.index)) continue;
    cap(ctx, m.index, m.index + m[0].length, 'jmd-footnote');
    region(ctx, m.index, m.index + m[0].length);
    claim(ctx, m.index, m.index + m[0].length);
  }
}

/**
 * The offset of the first blank line at or after `from` (the offset of
 * the newline that *precedes* the blank line), or -1.
 *
 * @param {string} S
 * @param {number} from
 * @returns {number}
 */
function blankLineAfter(S, from) {
  const m = /\n[ \t]*(?:\n|$)/.exec(S.slice(from));
  return m ? from + m.index : -1;
}
