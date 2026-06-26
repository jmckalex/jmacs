/**
 * @file Pure helpers for the SVG editor's document model.
 *
 * The SVG DOM *is* the model (see plans/SVG-EDITOR.md): the live tree the
 * view holds is the same thing that gets written to disk. These helpers
 * are the side-effect-free, DOM-free parts of that model so they can be
 * unit-tested in Node:
 *
 *  - building the markup for a fresh document and for each shape kind,
 *  - allocating stable ids,
 *  - the save-time serialisation that strips editor-only `data-godot-*`
 *    attributes (and the selection/overlay layer) so the saved file is
 *    clean, portable SVG.
 *
 * The live `<svg-editor-view>` parses these strings into real
 * `SVGElement`s and mutates them; on save it serialises the tree and runs
 * it through {@link stripGodotAttributes}.
 */

export const SVG_NS = 'http://www.w3.org/2000/svg';

/** Default canvas size in user-space units. */
export const DEFAULT_WIDTH = 800;
export const DEFAULT_HEIGHT = 600;

/**
 * Escape a string for safe inclusion in an XML attribute value.
 * @param {string} s
 * @returns {string}
 */
export function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escape text content for inclusion between XML tags.
 * @param {string} s
 * @returns {string}
 */
export function escapeText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Allocate the next free `g<N>` id given the ids already present in the
 * document. Foreign files may use other id schemes; we only need a value
 * that does not collide with any existing id.
 * @param {Iterable<string>} existingIds
 * @returns {string}
 */
export function nextId(existingIds) {
  const set = existingIds instanceof Set ? existingIds : new Set(existingIds);
  let n = 1;
  while (set.has(`g${n}`)) n += 1;
  return `g${n}`;
}

/**
 * Markup for a blank document: a root `<svg>` with a `viewBox`, a `defs`
 * block, and a single `main` layer `<g>`. The view parses this on a fresh
 * `M-x svg-editor`.
 * @param {object} [opts]
 * @param {number} [opts.width=DEFAULT_WIDTH]
 * @param {number} [opts.height=DEFAULT_HEIGHT]
 * @returns {string}
 */
export function blankDocument(opts = {}) {
  const w = opts.width ?? DEFAULT_WIDTH;
  const h = opts.height ?? DEFAULT_HEIGHT;
  return (
    `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<defs></defs>` +
    `<g class="layer" data-godot-layer="main"></g>` +
    `</svg>`
  );
}

/**
 * @typedef {object} ShapeStyle
 * @property {string} [fill]
 * @property {string} [stroke]
 * @property {number} [strokeWidth]
 */

/** Build the common style attributes shared by shapes. */
function styleAttrs(style = {}) {
  const fill = style.fill ?? '#cccccc';
  const stroke = style.stroke ?? '#222222';
  const sw = style.strokeWidth ?? 1;
  return `fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${sw}"`;
}

/**
 * Markup for a `<rect>` element.
 * @param {{id:string,x:number,y:number,width:number,height:number,rx?:number,style?:ShapeStyle}} spec
 * @returns {string}
 */
export function rectMarkup(spec) {
  const rx = spec.rx ? ` rx="${spec.rx}"` : '';
  return (
    `<rect id="${escapeAttr(spec.id)}" data-godot-shape="rect" ` +
    `x="${spec.x}" y="${spec.y}" width="${spec.width}" height="${spec.height}"${rx} ` +
    `${styleAttrs(spec.style)}/>`
  );
}

/**
 * Markup for an `<ellipse>` element from a bounding rect.
 * @param {{id:string,x:number,y:number,width:number,height:number,style?:ShapeStyle}} spec
 * @returns {string}
 */
export function ellipseMarkup(spec) {
  const cx = spec.x + spec.width / 2;
  const cy = spec.y + spec.height / 2;
  const rx = spec.width / 2;
  const ry = spec.height / 2;
  return (
    `<ellipse id="${escapeAttr(spec.id)}" data-godot-shape="ellipse" ` +
    `cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" ` +
    `${styleAttrs(spec.style)}/>`
  );
}

/**
 * Markup for a `<line>` element.
 * @param {{id:string,x1:number,y1:number,x2:number,y2:number,style?:ShapeStyle}} spec
 * @returns {string}
 */
export function lineMarkup(spec) {
  const stroke = spec.style?.stroke ?? '#222222';
  const sw = spec.style?.strokeWidth ?? 2;
  return (
    `<line id="${escapeAttr(spec.id)}" data-godot-shape="line" ` +
    `x1="${spec.x1}" y1="${spec.y1}" x2="${spec.x2}" y2="${spec.y2}" ` +
    `stroke="${escapeAttr(stroke)}" stroke-width="${sw}"/>`
  );
}

/**
 * Markup for a plain `<text>` element (not a math box).
 * @param {{id:string,x:number,y:number,text:string,fontSize?:number,fill?:string}} spec
 * @returns {string}
 */
export function textMarkup(spec) {
  const fs = spec.fontSize ?? 16;
  const fill = spec.fill ?? '#222222';
  return (
    `<text id="${escapeAttr(spec.id)}" data-godot-shape="text" ` +
    `x="${spec.x}" y="${spec.y}" font-size="${fs}" fill="${escapeAttr(fill)}">` +
    `${escapeText(spec.text)}</text>`
  );
}

/**
 * Remove editor-only `data-godot-*` attributes from a serialised SVG
 * string, for the "export clean SVG" / save path. Removing the
 * attributes (rather than rewriting the tree) keeps this a pure string
 * transform; the geometry and references are untouched.
 *
 * Note: `data-godot-latex` is intentionally *kept* by default because it
 * is the source of truth for re-editing a math box; pass
 * `{ stripLatex: true }` for a truly clean export.
 *
 * @param {string} svgMarkup
 * @param {object} [opts]
 * @param {boolean} [opts.stripLatex=false] - also drop data-godot-latex.
 * @returns {string}
 */
export function stripGodotAttributes(svgMarkup, opts = {}) {
  if (typeof svgMarkup !== 'string') return svgMarkup;
  const keepLatex = !opts.stripLatex;
  return svgMarkup.replace(
    /\s+data-godot-([a-z-]+)\s*=\s*(["']).*?\2/g,
    (full, name) => {
      if (keepLatex && name === 'latex') return full;
      return '';
    }
  );
}

/**
 * Wrap serialised inner markup in an XML prologue for writing to disk.
 * @param {string} svgMarkup - a serialised `<svg>…</svg>` string.
 * @returns {string}
 */
export function withXmlProlog(svgMarkup) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svgMarkup}\n`;
}
