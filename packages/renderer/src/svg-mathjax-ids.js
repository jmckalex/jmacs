/**
 * @file Pure helper: de-collide MathJax glyph/defs ids when embedding
 * several typeset math boxes into one SVG document.
 *
 * MathJax's SVG output with `fontCache: 'local'` (the editor's global
 * config) emits, per `tex2svg` call, a `<defs>` block of glyph paths with
 * ids like `MJX-1-TEX-N-71` referenced by `<use xlink:href="#MJX-1-...">`
 * (and plain `href` in newer builds). The per-call counter restarts each
 * render, so two math boxes in the same document collide: the second
 * box's `<use>` would resolve to the first box's glyph `<defs>`, drawing
 * the wrong character (or nothing).
 *
 * The fix is to namespace every id in a box's markup with a per-box
 * prefix and rewrite the references to match. This module does exactly
 * that as a pure string transform so it can be unit-tested in Node
 * without a DOM, and so the round-trip (save → reopen in a browser /
 * Inkscape) keeps working: the rewritten ids are still internally
 * consistent and self-contained.
 *
 * We rewrite, within one math box's serialised SVG markup:
 *   - every `id="X"`                     → `id="<prefix>X"`
 *   - every `href="#X"` / `xlink:href="#X"` → `href="#<prefix>X"`
 *   - every `url(#X)` (gradients/clips/markers) inside attributes/styles
 *
 * Only same-document fragment references (`#X`) are touched; external or
 * absolute URLs are left alone.
 */

/**
 * Produce a stable, DOM-safe id prefix for a math box. The box id is
 * sanitised to id-safe characters and suffixed with a separator so the
 * rewritten ids read as `<boxId>-MJX-1-...`.
 * @param {string} boxId - the box's `data-godot-id` (or any unique key).
 * @returns {string} a prefix ending in `-`.
 */
export function mathIdPrefix(boxId) {
  const safe = String(boxId).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${safe}-`;
}

/**
 * Collect every value of an `id="..."` attribute in the markup.
 * @param {string} svgMarkup
 * @returns {string[]} the ids in document order (may contain duplicates
 *   if the input itself is malformed; callers normally just need the set).
 */
export function collectIds(svgMarkup) {
  const ids = [];
  const re = /\bid\s*=\s*(["'])(.*?)\1/g;
  let m;
  while ((m = re.exec(svgMarkup)) !== null) {
    ids.push(m[2]);
  }
  return ids;
}

/**
 * Rewrite all ids and same-document references in one math box's SVG
 * markup so they are namespaced by `prefix`. Pure string transform.
 *
 * Implementation note: we only rewrite references whose target is an id
 * that actually appears in this markup (collected first). This avoids
 * mangling unrelated `url(#...)` references and keeps the transform a
 * no-op when there is nothing to collide.
 *
 * @param {string} svgMarkup - serialised SVG of a single typeset box.
 * @param {string} prefix - the per-box id prefix (see {@link mathIdPrefix}).
 * @returns {string} the markup with namespaced ids and references.
 */
export function prefixMathIds(svgMarkup, prefix) {
  if (typeof svgMarkup !== 'string' || !prefix) return svgMarkup;

  const localIds = new Set(collectIds(svgMarkup));
  if (localIds.size === 0) return svgMarkup;

  let out = svgMarkup;

  // 1. Rewrite the id="..." declarations themselves.
  out = out.replace(/\bid\s*=\s*(["'])(.*?)\1/g, (full, q, id) => {
    if (!localIds.has(id)) return full;
    return `id=${q}${prefix}${id}${q}`;
  });

  // 2. Rewrite href="#X" and xlink:href="#X" fragment references.
  out = out.replace(
    /\b((?:xlink:)?href)\s*=\s*(["'])#(.*?)\2/g,
    (full, attr, q, id) => {
      if (!localIds.has(id)) return full;
      return `${attr}=${q}#${prefix}${id}${q}`;
    }
  );

  // 3. Rewrite url(#X) references (fill/stroke/clip-path/marker/filter),
  //    whether in presentation attributes or inline style declarations.
  out = out.replace(/url\(\s*(['"]?)#(.*?)\1\s*\)/g, (full, q, id) => {
    if (!localIds.has(id)) return full;
    return `url(${q}#${prefix}${id}${q})`;
  });

  return out;
}

/**
 * Convenience: rewrite a box's markup using a prefix derived from its id.
 * @param {string} svgMarkup
 * @param {string} boxId
 * @returns {string}
 */
export function namespaceMathBox(svgMarkup, boxId) {
  return prefixMathIds(svgMarkup, mathIdPrefix(boxId));
}
