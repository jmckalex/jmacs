/**
 * @file Pure builders for the SVG editor's fill styles — two-colour
 * linear / radial gradients and hatch / dot / checker patterns.
 *
 * Every style is a `<defs>` citizen referenced as `fill="url(#id)"`,
 * with a stable id derived from its parameters, so identical styles
 * share one def and the saved file stays clean, portable SVG (no CSS,
 * no editor-only constructs — gradients and patterns render anywhere).
 *
 * The element keeps its parameters in `data-godot-fill-style` /
 * `-fill-a` / `-fill-b` / `-fill-angle` so the properties panel can
 * re-populate and re-style; those attributes strip on clean export
 * while the def + url survive.
 */

import { escapeAttr, colorSlug } from './svg-document.js';

/** The fill styles the panel offers, in menu order. */
export const FILL_STYLES = [
  'solid',
  'linear',
  'radial',
  'hatch',
  'crosshatch',
  'dots',
  'checker',
];

/** Gradient angle presets (degrees, 0 = left→right, 90 = top→bottom). */
export const FILL_ANGLES = [0, 45, 90, 135];

/**
 * The stable def id for a fill style + parameters.
 * @param {string} style - a FILL_STYLES entry other than 'solid'.
 * @param {string} a - primary colour.
 * @param {string} b - secondary colour (gradients / checker).
 * @param {number} [angle=0] - linear gradient angle.
 * @returns {string}
 */
export function fillStyleId(style, a, b, angle = 0) {
  const sa = colorSlug(a);
  const sb = colorSlug(b);
  if (style === 'linear') return `godot-fill-l-${sa}-${sb}-${angle}`;
  if (style === 'radial') return `godot-fill-r-${sa}-${sb}`;
  if (style === 'checker') return `godot-fill-checker-${sa}-${sb}`;
  return `godot-fill-${style}-${sa}`;
}

/** Gradient endpoints for an angle (percent coordinates). */
function gradientVector(angle) {
  switch (((angle % 180) + 180) % 180) {
    case 45:
      return { x1: '0%', y1: '0%', x2: '100%', y2: '100%' };
    case 90:
      return { x1: '0%', y1: '0%', x2: '0%', y2: '100%' };
    case 135:
      return { x1: '100%', y1: '0%', x2: '0%', y2: '100%' };
    default:
      return { x1: '0%', y1: '0%', x2: '100%', y2: '0%' };
  }
}

/**
 * Markup for a fill-style def.
 * @param {string} style - a FILL_STYLES entry other than 'solid'.
 * @param {string} a - primary colour.
 * @param {string} b - secondary colour.
 * @param {number} [angle=0]
 * @returns {{id: string, markup: string}|null} null for 'solid' /
 *   unknown styles (no def needed).
 */
export function fillStyleDef(style, a, b, angle = 0) {
  const id = fillStyleId(style, a, b, angle);
  const ca = escapeAttr(a);
  const cb = escapeAttr(b);
  switch (style) {
    case 'linear': {
      const v = gradientVector(angle);
      return {
        id,
        markup:
          `<linearGradient id="${id}" x1="${v.x1}" y1="${v.y1}" x2="${v.x2}" y2="${v.y2}">` +
          `<stop offset="0%" stop-color="${ca}"/>` +
          `<stop offset="100%" stop-color="${cb}"/>` +
          `</linearGradient>`,
      };
    }
    case 'radial':
      return {
        id,
        markup:
          `<radialGradient id="${id}">` +
          `<stop offset="0%" stop-color="${ca}"/>` +
          `<stop offset="100%" stop-color="${cb}"/>` +
          `</radialGradient>`,
      };
    case 'hatch':
      return {
        id,
        markup:
          `<pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse">` +
          // The corner stubs keep the diagonal seamless across tiles.
          `<path d="M -2 2 L 2 -2 M 0 8 L 8 0 M 6 10 L 10 6" ` +
          `stroke="${ca}" stroke-width="1.2" fill="none"/>` +
          `</pattern>`,
      };
    case 'crosshatch':
      return {
        id,
        markup:
          `<pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse">` +
          `<path d="M -2 2 L 2 -2 M 0 8 L 8 0 M 6 10 L 10 6 ` +
          `M -2 6 L 2 10 M 0 0 L 8 8 M 6 -2 L 10 2" ` +
          `stroke="${ca}" stroke-width="1.2" fill="none"/>` +
          `</pattern>`,
      };
    case 'dots':
      return {
        id,
        markup:
          `<pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse">` +
          `<circle cx="4" cy="4" r="1.4" fill="${ca}"/>` +
          `</pattern>`,
      };
    case 'checker':
      return {
        id,
        markup:
          `<pattern id="${id}" width="12" height="12" patternUnits="userSpaceOnUse">` +
          `<rect width="12" height="12" fill="${cb}"/>` +
          `<rect width="6" height="6" fill="${ca}"/>` +
          `<rect x="6" y="6" width="6" height="6" fill="${ca}"/>` +
          `</pattern>`,
      };
    default:
      return null;
  }
}
