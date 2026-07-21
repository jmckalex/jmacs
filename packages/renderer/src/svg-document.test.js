/**
 * @file Unit tests for the SVG document-model pure helpers: shape markup,
 * id allocation, and the save-time `data-godot-*` strip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeAttr,
  escapeText,
  nextId,
  blankDocument,
  rectMarkup,
  ellipseMarkup,
  lineMarkup,
  textMarkup,
  stripGodotAttributes,
  withXmlProlog,
} from './svg-document.js';

test('escapeAttr / escapeText escape XML metacharacters', () => {
  assert.equal(escapeAttr('a & b < c > "d"'), 'a &amp; b &lt; c &gt; &quot;d&quot;');
  assert.equal(escapeText('x & y < z'), 'x &amp; y &lt; z');
});

test('nextId skips ids already in use', () => {
  assert.equal(nextId([]), 'g1');
  assert.equal(nextId(['g1', 'g2']), 'g3');
  assert.equal(nextId(new Set(['g1', 'g3'])), 'g2');
});

test('blankDocument has a viewBox, defs and a main layer', () => {
  const doc = blankDocument({ width: 400, height: 300 });
  assert.match(doc, /viewBox="0 0 400 300"/);
  assert.match(doc, /<defs><\/defs>/);
  assert.match(doc, /data-godot-layer="main"/);
});

test('rectMarkup produces a rect with shape metadata and geometry', () => {
  const m = rectMarkup({ id: 'g1', x: 10, y: 20, width: 30, height: 40, rx: 4 });
  assert.match(m, /<rect id="g1"/);
  assert.match(m, /data-godot-shape="rect"/);
  assert.match(m, /x="10" y="20" width="30" height="40"/);
  assert.match(m, /rx="4"/);
});

test('ellipseMarkup converts a bounding rect to cx/cy/rx/ry', () => {
  const m = ellipseMarkup({ id: 'g2', x: 0, y: 0, width: 20, height: 10 });
  assert.match(m, /cx="10" cy="5" rx="10" ry="5"/);
  assert.match(m, /data-godot-shape="ellipse"/);
});

test('lineMarkup carries endpoints and stroke', () => {
  const m = lineMarkup({ id: 'g3', x1: 1, y1: 2, x2: 3, y2: 4 });
  assert.match(m, /x1="1" y1="2" x2="3" y2="4"/);
  assert.match(m, /data-godot-shape="line"/);
});

test('textMarkup escapes its content', () => {
  const m = textMarkup({ id: 'g4', x: 5, y: 6, text: 'a < b & c' });
  assert.match(m, /<text id="g4"/);
  assert.match(m, />a &lt; b &amp; c</);
});

test('stripGodotAttributes removes data-godot-* but keeps latex by default', () => {
  const dirty =
    '<rect id="g1" data-godot-shape="rect" x="0"/>' +
    '<g data-godot-latex="q_0" data-godot-id="g2"></g>';
  const clean = stripGodotAttributes(dirty);
  assert.ok(!/data-godot-shape/.test(clean), 'shape removed');
  assert.ok(!/data-godot-id/.test(clean), 'id meta removed');
  assert.match(clean, /data-godot-latex="q_0"/, 'latex source kept');
  // real geometry untouched
  assert.match(clean, /id="g1"/);
  assert.match(clean, /x="0"/);
});

test('stripGodotAttributes with stripLatex removes the latex source too', () => {
  const dirty = '<g data-godot-latex="q_0"></g>';
  const clean = stripGodotAttributes(dirty, { stripLatex: true });
  assert.ok(!/data-godot-latex/.test(clean));
});

test('withXmlProlog prepends the XML declaration', () => {
  const out = withXmlProlog('<svg></svg>');
  assert.match(out, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg>/);
});
