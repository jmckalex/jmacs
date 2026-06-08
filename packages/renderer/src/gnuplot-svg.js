/**
 * @file Make an exported gnuplot SVG self-describing. gnuplot's `dynamic`
 * svg terminal emits a `viewBox` but no `width`/`height` — ideal for
 * scaling to its container when shown inline, but it leaves the file with
 * no intrinsic size, which standalone SVG viewers (e.g. Gapplin) rely on
 * for their zoom / fit controls. When saving or copying a plot we inject
 * explicit pixel width/height taken from the viewBox, so the file is a
 * proper, self-contained image. Pure (no DOM) — unit-tested directly.
 */

/**
 * Return SVG with explicit pixel `width`/`height` on its root element,
 * derived from the `viewBox` when they're absent. A no-op when the SVG
 * already carries both, or has no usable viewBox.
 *
 * @param {string} svg
 * @returns {string}
 */
export function svgWithIntrinsicSize(svg) {
  if (typeof svg !== 'string') return svg;
  const open = svg.match(/<svg\b[^>]*>/i);
  if (!open) return svg;
  const tag = open[0];
  if (/\bwidth\s*=/i.test(tag) && /\bheight\s*=/i.test(tag)) return svg;
  const vb = tag.match(
    /viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i
  );
  if (!vb) return svg;
  const sized = tag.replace(/<svg\b/i, `<svg width="${vb[1]}" height="${vb[2]}"`);
  return svg.replace(tag, sized);
}
