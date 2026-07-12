/**
 * @file Pure helpers for the SVG editor's TikZ-style nodes.
 *
 * A "node" is a label (plain text, or LaTeX typeset to vector glyphs)
 * with an optional fitted border shape around it — TikZ's
 * `\node[draw, circle] {$q_0$};`. These helpers are DOM-free so the
 * geometry and the LaTeX-vs-prose classification can be unit tested in
 * Node; the live `<svg-editor-view>` builds the actual elements.
 *
 * Conventions: a node group's origin is its CENTRE (the group carries a
 * `translate(cx cy)`), content is centred about that origin, and the
 * border is fitted around the content's centred bbox plus padding —
 * so moving / scaling the group keeps label and border together.
 */

/** The border shapes a node supports (TikZ: rectangle / rounded / circle / ellipse / diamond). */
export const NODE_BORDER_SHAPES = ['none', 'rect', 'rounded', 'circle', 'ellipse', 'diamond'];

/** Default inner padding between content and border, in user units. */
export const NODE_DEFAULT_PADDING = 6;

/**
 * Classify a node's source string:
 *  - `'math'`  — typeset the whole string as TeX math (`$…$`-wrapped
 *    entirely, or bare TeX like `\alpha \to \beta`).
 *  - `'mixed'` — prose containing inline `$…$` runs (TikZ label style:
 *    `accept $q_0$`); typeset as `\text{…}` so the prose stays upright.
 *  - `'text'`  — plain prose; rendered as a native `<text>` element.
 * @param {string} source
 * @returns {'math'|'mixed'|'text'}
 */
export function nodeContentKind(source) {
  const s = String(source ?? '').trim();
  if (s === '') return 'text';
  const fully = /^\$(?:[^$]|\\\$)+\$$/.test(s) || /^\\\((?:.|\n)*\\\)$/.test(s);
  if (fully) return 'math';
  // Any unescaped $ makes it mixed prose+math.
  if (/(?<!\\)\$/.test(s)) return 'mixed';
  // A TeX control sequence with no $ at all: treat the whole thing as math
  // (users type `\alpha` meaning the symbol, per TikZ habit).
  if (/\\[a-zA-Z]+/.test(s)) return 'math';
  return 'text';
}

/**
 * Escape the TeX specials that would derail a `\text{…}` wrap of prose:
 * unescaped `%` (comment — eats the rest of the source), `&` (alignment)
 * and `#` (macro parameter). `$`, braces and backslashes are left alone —
 * `$` delimits math runs and the rest is the author's TeX to keep.
 * @param {string} prose
 * @returns {string}
 */
export function escapeProseSpecials(prose) {
  return String(prose).replace(/(^|[^\\])([%&#])/g, '$1\\$2');
}

/**
 * The TeX source to hand MathJax for a node, per {@link nodeContentKind}:
 *  - math  → the bare math (fully-wrapped `$…$` / `\(…\)` stripped).
 *  - mixed → `\text{…}` around the whole string (prose specials escaped;
 *    the inline `$…$` runs re-enter math inside `\text`, which MathJax
 *    supports).
 *  - text  → `null` (render as a native `<text>`, not through MathJax).
 * @param {string} source
 * @returns {string|null}
 */
export function texForNodeContent(source) {
  const s = String(source ?? '').trim();
  const kind = nodeContentKind(s);
  if (kind === 'text') return null;
  if (kind === 'math') {
    const dollars = /^\$((?:[^$]|\\\$)+)\$$/.exec(s);
    if (dollars) return dollars[1].trim();
    const parens = /^\\\(((?:.|\n)*)\\\)$/.exec(s);
    if (parens) return parens[1].trim();
    return s;
  }
  return `\\text{${escapeProseSpecials(s)}}`;
}

/**
 * Fit a border shape around a CENTRED content bbox (centre at the
 * origin) with `padding` user units of inner clearance, TikZ-style:
 *
 *  - `rect` / `rounded` — the padded box (rounded adds an `rx`).
 *  - `circle`  — through the padded box's corner (TikZ `circle`):
 *                r = hypot(w/2 + p, h/2 + p).
 *  - `ellipse` — axis-aligned through the padded box's corner with the
 *                box's aspect (TikZ `ellipse`): rx = √2·(w/2 + p),
 *                ry = √2·(h/2 + p).
 *  - `diamond` — vertices on the axes such that the edges pass outside
 *                the padded box's corners: half-diagonals 2·(w/2 + p),
 *                2·(h/2 + p).
 *  - `none`    — `null`.
 *
 * @param {{width:number, height:number}} contentSize - the content bbox
 *   (centre assumed at the origin).
 * @param {object} [opts]
 * @param {string} [opts.shape='rect']
 * @param {number} [opts.padding=NODE_DEFAULT_PADDING]
 * @param {number} [opts.cornerRadius=6] - for `rounded`.
 * @returns {{tag:string, attrs:Record<string,number|string>}|null} the
 *   border element spec (tag + attributes, centred at the origin), or
 *   null for `none` / unknown shapes.
 */
export function fitNodeBorder(contentSize, opts = {}) {
  const shape = opts.shape ?? 'rect';
  const p = Number.isFinite(opts.padding) ? opts.padding : NODE_DEFAULT_PADDING;
  const hw = Math.max(0, contentSize.width / 2) + p;
  const hh = Math.max(0, contentSize.height / 2) + p;
  switch (shape) {
    case 'rect':
    case 'rounded': {
      const attrs = {
        x: -hw,
        y: -hh,
        width: 2 * hw,
        height: 2 * hh,
      };
      if (shape === 'rounded') attrs.rx = opts.cornerRadius ?? 6;
      return { tag: 'rect', attrs };
    }
    case 'circle': {
      const r = Math.hypot(hw, hh);
      return { tag: 'circle', attrs: { cx: 0, cy: 0, r } };
    }
    case 'ellipse': {
      const s = Math.SQRT2;
      return { tag: 'ellipse', attrs: { cx: 0, cy: 0, rx: s * hw, ry: s * hh } };
    }
    case 'diamond': {
      const dx = 2 * hw;
      const dy = 2 * hh;
      const points = `0,${-dy} ${dx},0 0,${dy} ${-dx},0`;
      return { tag: 'polygon', attrs: { points } };
    }
    default:
      return null;
  }
}

/**
 * Parse a MathJax `ex` length attribute (e.g. `"2.34ex"`) to its number.
 * @param {string} value
 * @returns {number|null}
 */
export function parseExLength(value) {
  const m = /^(-?[\d.]+)ex$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Place a MathJax-emitted inner `<svg>` (whose width/height are in `ex`)
 * as an embedded, absolutely-sized island centred at the node origin:
 * convert `ex` → user units via the node's font size (1ex ≈ half the font
 * size, the classic approximation), so the saved file carries absolute
 * units and renders identically outside the editor.
 *
 * @param {string} widthEx - the svg's `width` attribute (e.g. `"3.1ex"`).
 * @param {string} heightEx - the svg's `height` attribute.
 * @param {number} [fontSize=16] - node font size in user units.
 * @returns {{width:number, height:number, x:number, y:number}|null}
 *   pixel width/height plus the x/y that centre the island at the
 *   origin, or null when the attributes aren't `ex` lengths.
 */
export function mathSvgPlacement(widthEx, heightEx, fontSize = 16) {
  const wEx = parseExLength(widthEx);
  const hEx = parseExLength(heightEx);
  if (wEx == null || hEx == null) return null;
  const pxPerEx = fontSize / 2;
  const width = wEx * pxPerEx;
  const height = hEx * pxPerEx;
  return { width, height, x: -width / 2, y: -height / 2 };
}
