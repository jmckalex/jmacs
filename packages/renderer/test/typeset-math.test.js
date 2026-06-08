/**
 * @file Unit tests for the MathJax typesetting helper and the typeset
 * cache, behind a MathJax stub. The real SVG rendering needs the
 * browser library and is confirmed in a live smoke test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  typesetMath,
  isMathJaxReady,
  whenMathJaxReady,
  cacheKey,
  createMathCache,
  typesetCached,
} from '../src/typeset-math.js';

/** A MathJax stub that records its calls and returns a marker node. */
function stubMathJax(overrides = {}) {
  const calls = [];
  return {
    calls,
    tex2svg(latex, options) {
      calls.push({ latex, options });
      if (overrides.throwOn && overrides.throwOn(latex)) {
        throw new Error('parse error');
      }
      return { marker: 'svg', latex, display: options && options.display };
    },
    ...overrides.extra,
  };
}

test('typesetMath calls tex2svg with the display flag and returns its node', () => {
  const mj = stubMathJax();
  const node = typesetMath('x+1', { display: true }, mj);
  assert.deepEqual(mj.calls, [{ latex: 'x+1', options: { display: true } }]);
  assert.equal(node.marker, 'svg');
  assert.equal(node.display, true);
});

test('typesetMath defaults display to false', () => {
  const mj = stubMathJax();
  typesetMath('a', {}, mj);
  assert.equal(mj.calls[0].options.display, false);
});

test('typesetMath returns null when MathJax is absent', () => {
  assert.equal(typesetMath('x', {}, null), null);
  assert.equal(typesetMath('x', {}, {}), null);
});

test('typesetMath returns null on a non-string body', () => {
  const mj = stubMathJax();
  assert.equal(typesetMath(undefined, {}, mj), null);
  assert.equal(mj.calls.length, 0);
});

test('typesetMath returns null when tex2svg throws (invalid LaTeX)', () => {
  const mj = stubMathJax({ throwOn: (s) => s === 'bad' });
  assert.equal(typesetMath('bad', {}, mj), null);
  // A good one still works.
  assert.ok(typesetMath('good', {}, mj));
});

test('isMathJaxReady reflects tex2svg presence', () => {
  assert.equal(isMathJaxReady(null), false);
  assert.equal(isMathJaxReady({}), false);
  assert.equal(isMathJaxReady(stubMathJax()), true);
});

test('whenMathJaxReady runs immediately when tex2svg is present, no promise', () => {
  const mj = stubMathJax();
  let ran = false;
  const scheduled = whenMathJaxReady(() => { ran = true; }, mj);
  assert.equal(scheduled, true);
  assert.equal(ran, true);
});

test('whenMathJaxReady waits on startup.promise when present', async () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const mj = stubMathJax({ extra: { startup: { promise } } });
  let ran = false;
  const scheduled = whenMathJaxReady(() => { ran = true; }, mj);
  assert.equal(scheduled, true);
  assert.equal(ran, false); // not yet — promise unresolved
  resolve();
  await promise;
  await Promise.resolve(); // let the .then microtask flush
  assert.equal(ran, true);
});

test('whenMathJaxReady returns false when MathJax is absent', () => {
  let ran = false;
  assert.equal(whenMathJaxReady(() => { ran = true; }, null), false);
  assert.equal(ran, false);
});

// --- cache key ----------------------------------------------------------

test('cacheKey separates inline from display for the same body', () => {
  assert.notEqual(cacheKey('x', false), cacheKey('x', true));
  assert.equal(cacheKey('x', false), cacheKey('x', false));
});

// --- the cache ----------------------------------------------------------

test('createMathCache stores and retrieves by (body, display)', () => {
  const cache = createMathCache();
  assert.equal(cache.has('x', false), false);
  cache.set('x', false, { marker: 'inline-x' });
  cache.set('x', true, { marker: 'display-x' });
  assert.equal(cache.has('x', false), true);
  assert.deepEqual(cache.get('x', false), { marker: 'inline-x' });
  assert.deepEqual(cache.get('x', true), { marker: 'display-x' });
  assert.equal(cache.size, 2);
});

test('cache records a known-invalid body as a null entry', () => {
  const cache = createMathCache();
  cache.set('bad', false, null);
  assert.equal(cache.has('bad', false), true); // seen
  assert.equal(cache.get('bad', false), null); // invalid
});

test('cache delete and clear', () => {
  const cache = createMathCache();
  cache.set('a', false, {});
  cache.set('b', true, {});
  cache.delete('a', false);
  assert.equal(cache.has('a', false), false);
  assert.equal(cache.size, 1);
  cache.clear();
  assert.equal(cache.size, 0);
});

// --- typesetCached ------------------------------------------------------

test('typesetCached typesets once on a miss, then serves from cache', () => {
  const mj = stubMathJax();
  const cache = createMathCache();
  const a = typesetCached(cache, 'x', false, mj);
  const b = typesetCached(cache, 'x', false, mj);
  assert.equal(mj.calls.length, 1); // only one tex2svg call
  assert.equal(a, b); // same cached node
});

test('typesetCached caches a null (invalid) result and does not retry', () => {
  const mj = stubMathJax({ throwOn: () => true });
  const cache = createMathCache();
  assert.equal(typesetCached(cache, 'bad', false, mj), null);
  assert.equal(typesetCached(cache, 'bad', false, mj), null);
  assert.equal(mj.calls.length, 1); // the second call hit the cache
});

test('typesetCached keys inline and display separately', () => {
  const mj = stubMathJax();
  const cache = createMathCache();
  typesetCached(cache, 'x', false, mj);
  typesetCached(cache, 'x', true, mj);
  assert.equal(mj.calls.length, 2);
});
