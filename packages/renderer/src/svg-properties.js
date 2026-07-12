/**
 * @file Pure property schema for the SVG editor's properties panel.
 *
 * For each selectable kind of object the schema lists property
 * descriptors; each descriptor reads its value from a plain
 * attribute map (`{ attrName: string }`) and writes a patch
 * (`{ attrName: string|null }`, null = remove) — no DOM here, so the
 * mapping logic is unit-testable. The live panel builds inputs from the
 * descriptors, and `<svg-editor-view>` adapts elements ⇄ attribute maps
 * and applies patches.
 *
 * A descriptor's `target` names which element of a compound object the
 * attribute map belongs to:
 *   - `'self'`    — the selected element itself (plain shapes),
 *   - `'border'`  — a node's fitted border child,
 *   - `'content'` — a node's label (`<text>` or the math group).
 *
 * Some keys have side effects beyond the attribute patch (a node's
 * border refits when padding changes; math re-renders when font-size
 * changes). The view special-cases those by key — the schema still
 * declares them so the panel stays generic.
 */

import { NODE_BORDER_SHAPES } from './svg-node.js';

/** Dash presets. `null` = solid (remove the attribute). */
export const DASH_PRESETS = {
  solid: null,
  dashed: '8 5',
  dotted: '2 4',
};

/** Classify a stroke-dasharray value into a preset name (or 'custom'). */
export function dashKindFromValue(value) {
  if (value == null || value === '' || value === 'none') return 'solid';
  const norm = String(value).trim().replace(/[,\s]+/g, ' ');
  for (const [kind, preset] of Object.entries(DASH_PRESETS)) {
    if (preset !== null && preset === norm) return kind;
  }
  return 'custom';
}

/**
 * The editor kind of an element, from its `data-godot-shape` attribute
 * and tag name. Foreign elements (opened files made elsewhere) have no
 * data-godot-shape: leaf shapes stay style-editable, groups get opacity
 * only, and a foreign `<path>` is a `path` (node-editable when its `d`
 * parses).
 * @param {string|null} shapeAttr
 * @param {string} tagName - lower-case tag name.
 * @returns {string}
 */
export function kindOfShape(shapeAttr, tagName) {
  if (shapeAttr) return shapeAttr;
  const tag = String(tagName || '').toLowerCase();
  if (tag === 'path') return 'path';
  if (['rect', 'ellipse', 'circle', 'line', 'polygon', 'polyline', 'text'].includes(tag)) {
    return 'shape';
  }
  return 'opaque';
}

// --- descriptor builders ---------------------------------------------------

/** A colour attribute that may be `none` (fill / stroke). */
function colorProp(key, label, attr, target, { allowNone = true, dflt = '#000000' } = {}) {
  return {
    key,
    label,
    type: 'color',
    target,
    allowNone,
    get: (attrs) => attrs[attr] ?? dflt,
    set: (value) => ({ [attr]: value === '' ? null : value }),
  };
}

/** A numeric attribute. */
function numberProp(key, label, attr, target, { min = 0, max = 100, step = 1, dflt = 0 } = {}) {
  return {
    key,
    label,
    type: 'number',
    target,
    min,
    max,
    step,
    get: (attrs) => {
      const n = Number(attrs[attr]);
      return Number.isFinite(n) ? n : dflt;
    },
    set: (value) => ({ [attr]: Number.isFinite(Number(value)) ? String(value) : null }),
  };
}

/** Opacity: a 0..1 range that removes the attribute at 1. */
function opacityProp(target) {
  return {
    key: 'opacity',
    label: 'Opacity',
    type: 'range',
    target,
    min: 0,
    max: 1,
    step: 0.05,
    get: (attrs) => {
      const n = Number(attrs.opacity);
      return Number.isFinite(n) ? n : 1;
    },
    set: (value) => ({ opacity: Number(value) >= 1 ? null : String(value) }),
  };
}

/** Dash style select over the presets. */
function dashProp(target) {
  return {
    key: 'dash',
    label: 'Dash',
    type: 'select',
    target,
    options: ['solid', 'dashed', 'dotted'],
    get: (attrs) => dashKindFromValue(attrs['stroke-dasharray']),
    set: (value) => ({
      'stroke-dasharray': DASH_PRESETS[value] ?? null,
    }),
  };
}

/**
 * Arrowhead checkboxes. The patch value `'auto'` is a sentinel: the view
 * replaces it with a `url(#…)` reference to a find-or-created marker in
 * the document's defs (colour-matched to the stroke).
 */
function arrowProp(key, label, attr, target) {
  return {
    key,
    label,
    type: 'checkbox',
    target,
    get: (attrs) => Boolean(attrs[attr] && attrs[attr] !== 'none'),
    set: (value) => ({ [attr]: value ? 'auto' : null }),
  };
}

/** The full paint set shared by filled shapes. */
function paintProps(target, { fillDefault = '#cccccc' } = {}) {
  return [
    colorProp('fill', 'Fill', 'fill', target, { dflt: fillDefault }),
    colorProp('stroke', 'Stroke', 'stroke', target, { dflt: '#222222' }),
    numberProp('stroke-width', 'Stroke width', 'stroke-width', target, {
      min: 0,
      max: 30,
      step: 0.5,
      dflt: 1,
    }),
    dashProp(target),
    opacityProp(target),
  ];
}

// --- the schema ------------------------------------------------------------

const RECT_PROPS = [
  ...paintProps('self'),
  numberProp('rx', 'Corner radius', 'rx', 'self', { min: 0, max: 200, step: 1 }),
];

const ELLIPSE_PROPS = [...paintProps('self')];

const LINE_PROPS = [
  colorProp('stroke', 'Stroke', 'stroke', 'self', { allowNone: false, dflt: '#222222' }),
  numberProp('stroke-width', 'Stroke width', 'stroke-width', 'self', {
    min: 0.5,
    max: 30,
    step: 0.5,
    dflt: 2,
  }),
  dashProp('self'),
  opacityProp('self'),
  arrowProp('arrow-start', 'Arrow start', 'marker-start', 'self'),
  arrowProp('arrow-end', 'Arrow end', 'marker-end', 'self'),
];

const PATH_PROPS = [
  ...paintProps('self', { fillDefault: 'none' }),
  arrowProp('arrow-start', 'Arrow start', 'marker-start', 'self'),
  arrowProp('arrow-end', 'Arrow end', 'marker-end', 'self'),
];

const TEXT_PROPS = [
  colorProp('fill', 'Colour', 'fill', 'self', { allowNone: false, dflt: '#222222' }),
  numberProp('font-size', 'Font size', 'font-size', 'self', {
    min: 4,
    max: 200,
    step: 1,
    dflt: 16,
  }),
];

const MATH_PROPS = [
  colorProp('fill', 'Colour', 'fill', 'self', { allowNone: false, dflt: '#222222' }),
  // font-size on a math box re-renders the embedded island (view-handled).
  numberProp('font-size', 'Font size', 'data-godot-font-size', 'self', {
    min: 4,
    max: 200,
    step: 1,
    dflt: 16,
  }),
];

const NODE_PROPS = [
  {
    key: 'border-shape',
    label: 'Border',
    type: 'select',
    target: 'self',
    options: [...NODE_BORDER_SHAPES],
    get: (attrs) => attrs['data-godot-node-shape'] ?? 'rect',
    set: (value) => ({ 'data-godot-node-shape': value }),
  },
  numberProp('padding', 'Padding', 'data-godot-padding', 'self', {
    min: 0,
    max: 60,
    step: 1,
    dflt: 6,
  }),
  numberProp('font-size', 'Font size', 'data-godot-font-size', 'self', {
    min: 4,
    max: 200,
    step: 1,
    dflt: 16,
  }),
  colorProp('color', 'Text colour', 'fill', 'content', { allowNone: false, dflt: '#222222' }),
  colorProp('fill', 'Border fill', 'fill', 'border', { dflt: '#ffffff' }),
  colorProp('stroke', 'Border stroke', 'stroke', 'border', { dflt: '#222222' }),
  numberProp('stroke-width', 'Border width', 'stroke-width', 'border', {
    min: 0,
    max: 30,
    step: 0.5,
    dflt: 1,
  }),
  dashProp('border'),
  opacityProp('self'),
];

const SHAPE_PROPS = [...paintProps('self')];

const OPAQUE_PROPS = [opacityProp('self')];

const SCHEMA = {
  rect: RECT_PROPS,
  ellipse: ELLIPSE_PROPS,
  line: LINE_PROPS,
  path: PATH_PROPS,
  text: TEXT_PROPS,
  math: MATH_PROPS,
  node: NODE_PROPS,
  shape: SHAPE_PROPS,
  opaque: OPAQUE_PROPS,
};

/**
 * The property descriptors for a kind (empty list for unknown kinds).
 * @param {string} kind
 * @returns {Array<object>}
 */
export function propertiesForKind(kind) {
  return SCHEMA[kind] ?? [];
}

/**
 * Keys whose change needs a view-side rebuild beyond the attribute
 * patch: a node refits its border / re-renders its content.
 */
export const NODE_REBUILD_KEYS = new Set([
  'border-shape',
  'padding',
  'font-size',
]);
