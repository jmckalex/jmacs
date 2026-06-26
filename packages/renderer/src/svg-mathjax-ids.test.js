/**
 * @file Unit tests for the MathJax defs id de-collision helper.
 *
 * These verify the pure string transform that namespaces glyph/defs ids
 * (and their references) per math box so two typeset boxes embedded in
 * one SVG document don't collide. The sample markup mirrors what
 * MathJax SVG output with `fontCache: 'local'` emits: a `<defs>` of
 * `<path id="MJX-...">` glyphs referenced by `<use xlink:href="#MJX-...">`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mathIdPrefix,
  collectIds,
  prefixMathIds,
  namespaceMathBox,
} from './svg-mathjax-ids.js';

const SAMPLE = `<svg>
  <defs>
    <path id="MJX-1-TEX-N-71" d="M1 2 3"></path>
    <path id="MJX-1-TEX-N-30" d="M4 5 6"></path>
  </defs>
  <g>
    <use xlink:href="#MJX-1-TEX-N-71"></use>
    <use href="#MJX-1-TEX-N-30"></use>
  </g>
</svg>`;

test('mathIdPrefix sanitises and suffixes with a dash', () => {
  assert.equal(mathIdPrefix('g7'), 'g7-');
  assert.equal(mathIdPrefix('box 1!'), 'box_1_-');
});

test('collectIds finds every id in document order', () => {
  assert.deepEqual(collectIds(SAMPLE), ['MJX-1-TEX-N-71', 'MJX-1-TEX-N-30']);
  assert.deepEqual(collectIds('<svg></svg>'), []);
});

test('prefixMathIds namespaces id declarations', () => {
  const out = prefixMathIds(SAMPLE, 'g7-');
  assert.match(out, /id="g7-MJX-1-TEX-N-71"/);
  assert.match(out, /id="g7-MJX-1-TEX-N-30"/);
  assert.ok(!/id="MJX-1-TEX-N-71"/.test(out), 'no bare id left');
});

test('prefixMathIds rewrites xlink:href and href references', () => {
  const out = prefixMathIds(SAMPLE, 'g7-');
  assert.match(out, /xlink:href="#g7-MJX-1-TEX-N-71"/);
  assert.match(out, /href="#g7-MJX-1-TEX-N-30"/);
});

test('two boxes get distinct, internally-consistent id namespaces', () => {
  const a = namespaceMathBox(SAMPLE, 'g1');
  const b = namespaceMathBox(SAMPLE, 'g2');
  // a's <use> targets a's <defs>, b's targets b's — no cross-talk.
  assert.match(a, /id="g1-MJX-1-TEX-N-71"/);
  assert.match(a, /href="#g1-MJX-1-TEX-N-71"/);
  assert.match(b, /id="g2-MJX-1-TEX-N-71"/);
  assert.match(b, /href="#g2-MJX-1-TEX-N-71"/);
  // The two namespaces never share an id.
  assert.ok(!a.includes('g2-'), 'box a has no box b ids');
  assert.ok(!b.includes('g1-'), 'box b has no box a ids');
});

test('rewritten markup is self-consistent: every href resolves to an id', () => {
  const out = namespaceMathBox(SAMPLE, 'box');
  const ids = new Set(collectIds(out));
  const refRe = /(?:xlink:)?href="#(.*?)"/g;
  let m;
  let refs = 0;
  while ((m = refRe.exec(out)) !== null) {
    refs += 1;
    assert.ok(ids.has(m[1]), `href #${m[1]} resolves to a declared id`);
  }
  assert.equal(refs, 2);
});

test('url(#X) references are namespaced (gradients/clips/markers)', () => {
  const markup =
    '<svg><defs><linearGradient id="grad"/></defs>' +
    '<rect fill="url(#grad)" style="stroke:url(#grad)"/></svg>';
  const out = prefixMathIds(markup, 'b-');
  assert.match(out, /id="b-grad"/);
  assert.match(out, /fill="url\(#b-grad\)"/);
  assert.match(out, /stroke:url\(#b-grad\)/);
});

test('references to ids not declared locally are left untouched', () => {
  const markup = '<svg><use href="#external"/></svg>';
  // no local ids → no-op
  assert.equal(prefixMathIds(markup, 'b-'), markup);
});

test('prefixMathIds is a no-op for empty prefix or non-string input', () => {
  assert.equal(prefixMathIds(SAMPLE, ''), SAMPLE);
  assert.equal(prefixMathIds(null, 'b-'), null);
});
