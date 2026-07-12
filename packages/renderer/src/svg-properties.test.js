/**
 * @file Unit tests for the properties-panel schema: kind classification,
 * descriptor get/set over plain attribute maps, dash presets, arrowhead
 * sentinels, and the arrow-marker markup helpers from svg-document.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DASH_PRESETS,
  dashKindFromValue,
  kindOfShape,
  propertiesForKind,
  NODE_REBUILD_KEYS,
} from './svg-properties.js';
import { colorSlug, arrowMarkerId, arrowMarkerMarkup } from './svg-document.js';

/** Find a descriptor by key. */
function prop(kind, key) {
  const d = propertiesForKind(kind).find((p) => p.key === key);
  assert.ok(d, `${kind} has no descriptor ${key}`);
  return d;
}

// --- kind classification -----------------------------------------------------

test('kindOfShape prefers the data-godot-shape attribute', () => {
  assert.equal(kindOfShape('node', 'g'), 'node');
  assert.equal(kindOfShape('math', 'g'), 'math');
  assert.equal(kindOfShape('rect', 'rect'), 'rect');
});

test('foreign elements: path stays path, leaf shapes are shape, groups opaque', () => {
  assert.equal(kindOfShape(null, 'path'), 'path');
  assert.equal(kindOfShape(null, 'circle'), 'shape');
  assert.equal(kindOfShape(null, 'polygon'), 'shape');
  assert.equal(kindOfShape(null, 'g'), 'opaque');
  assert.equal(kindOfShape(null, 'image'), 'opaque');
});

// --- descriptors ----------------------------------------------------------------

test('every kind yields descriptors; unknown kinds yield none', () => {
  for (const kind of ['rect', 'ellipse', 'line', 'path', 'text', 'math', 'node', 'shape', 'opaque']) {
    assert.ok(propertiesForKind(kind).length > 0, kind);
  }
  assert.deepEqual(propertiesForKind('mystery'), []);
});

test('fill descriptor reads the map and patches the attribute', () => {
  const fill = prop('rect', 'fill');
  assert.equal(fill.get({ fill: '#123456' }), '#123456');
  assert.equal(fill.get({}), '#cccccc'); // the shape default
  assert.deepEqual(fill.set('none'), { fill: 'none' });
});

test('stroke-width parses numbers and defaults sanely', () => {
  const sw = prop('rect', 'stroke-width');
  assert.equal(sw.get({ 'stroke-width': '2.5' }), 2.5);
  assert.equal(sw.get({}), 1);
  assert.deepEqual(sw.set(3), { 'stroke-width': '3' });
});

test('opacity removes the attribute at 1, sets it below', () => {
  const op = prop('ellipse', 'opacity');
  assert.deepEqual(op.set(1), { opacity: null });
  assert.deepEqual(op.set(0.4), { opacity: '0.4' });
  assert.equal(op.get({}), 1);
  assert.equal(op.get({ opacity: '0.25' }), 0.25);
});

test('dash select maps presets both ways', () => {
  const dash = prop('rect', 'dash');
  assert.equal(dash.get({}), 'solid');
  assert.equal(dash.get({ 'stroke-dasharray': '8 5' }), 'dashed');
  assert.equal(dash.get({ 'stroke-dasharray': '8,5' }), 'dashed'); // comma form
  assert.equal(dash.get({ 'stroke-dasharray': '1 9 1' }), 'custom');
  assert.deepEqual(dash.set('dotted'), { 'stroke-dasharray': DASH_PRESETS.dotted });
  assert.deepEqual(dash.set('solid'), { 'stroke-dasharray': null });
});

test('line arrowheads: checkbox reads marker attrs, sets the auto sentinel', () => {
  const end = prop('line', 'arrow-end');
  assert.equal(end.get({}), false);
  assert.equal(end.get({ 'marker-end': 'url(#godot-arrow-222222)' }), true);
  assert.deepEqual(end.set(true), { 'marker-end': 'auto' });
  assert.deepEqual(end.set(false), { 'marker-end': null });
});

test('node descriptors: border-shape and padding target the group, paints target parts', () => {
  const shape = prop('node', 'border-shape');
  assert.equal(shape.target, 'self');
  assert.equal(shape.get({}), 'rect');
  assert.deepEqual(shape.set('circle'), { 'data-godot-node-shape': 'circle' });

  const borderFill = prop('node', 'fill');
  assert.equal(borderFill.target, 'border');
  const textColor = prop('node', 'color');
  assert.equal(textColor.target, 'content');
});

test('NODE_REBUILD_KEYS names the view-rebuild triggers', () => {
  assert.ok(NODE_REBUILD_KEYS.has('border-shape'));
  assert.ok(NODE_REBUILD_KEYS.has('padding'));
  assert.ok(NODE_REBUILD_KEYS.has('font-size'));
  assert.ok(!NODE_REBUILD_KEYS.has('fill'));
});

test('math font-size lives in data-godot-font-size (re-render trigger)', () => {
  const fs = prop('math', 'font-size');
  assert.deepEqual(fs.set(24), { 'data-godot-font-size': '24' });
  assert.equal(fs.get({ 'data-godot-font-size': '24' }), 24);
  assert.equal(fs.get({}), 16);
});

// --- arrow markers ------------------------------------------------------------------

test('colorSlug flattens colours to id-safe slugs', () => {
  assert.equal(colorSlug('#FF0000'), 'ff0000');
  assert.equal(colorSlug('rgb(1, 2, 3)'), 'rgb123');
  assert.equal(colorSlug('red'), 'red');
});

test('arrowMarkerMarkup builds a per-colour, both-ends marker, tip on the endpoint', () => {
  const m = arrowMarkerMarkup('#222222');
  assert.ok(m.includes(`id="${arrowMarkerId('#222222')}"`));
  assert.ok(m.includes('orient="auto-start-reverse"'));
  assert.ok(m.includes('fill="#222222"'));
  assert.ok(!m.includes('context-stroke'));
  // refX = the tip x of the arrow path: the tip sits exactly on the path
  // endpoint (which connectors place exactly on the node border).
  assert.ok(m.includes('refX="10"'));
});

test('node font + text-width descriptors read and patch data attrs', () => {
  const font = prop('node', 'font');
  assert.equal(font.get({}), 'sans-serif');
  assert.deepEqual(font.set('Georgia'), { 'data-godot-font': 'Georgia' });
  assert.deepEqual(font.set('sans-serif'), { 'data-godot-font': null });
  const tw = prop('node', 'text-width');
  assert.equal(tw.get({}), 0);
  assert.equal(tw.get({ 'data-godot-wrap-width': '140' }), 140);
  assert.deepEqual(tw.set(120), { 'data-godot-wrap-width': '120' });
  assert.deepEqual(tw.set(0), { 'data-godot-wrap-width': null });
  assert.ok(NODE_REBUILD_KEYS.has('font'));
  assert.ok(NODE_REBUILD_KEYS.has('text-width'));
});
