/**
 * @file Unit tests for the math-preview controller — the pure segment
 * plan, the point enter/leave detection, the cache reuse, and the range
 * production behind MathJax / DOM stubs.
 *
 * The controller's behaviour is mode-agnostic and unchanged by the
 * generalisation; these tests drive it through `createMathPreview` (the
 * LaTeX scanner is its default `scan`). The back-compat alias
 * `createLatexMathPreview` is checked in one extra assertion below.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planSegments,
  detectLeave,
  createMathPreview,
  createLatexMathPreview,
} from '../src/math-preview.js';

/** A MathJax stub returning a clonable marker node per call. */
function stubMathJax(throwOn) {
  const calls = [];
  return {
    calls,
    tex2svg(latex, opts) {
      calls.push({ latex, display: opts && opts.display });
      if (throwOn && throwOn(latex)) throw new Error('bad');
      const node = {
        latex,
        display: opts && opts.display,
        cloneNode() {
          return { ...node, cloned: true };
        },
      };
      return node;
    },
  };
}

/** A tiny DOM stub for invalidNode(). */
function stubDoc() {
  return {
    createElement(tag) {
      return { tag, className: '', textContent: '', children: [] };
    },
  };
}

// --- planSegments (pure) -----------------------------------------------

test('planSegments classifies a valid segment as widget', () => {
  const plan = planSegments('a $x+1$ b', [0]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].disposition, 'widget');
  assert.equal(plan[0].body, 'x+1');
  assert.equal(plan[0].kind, 'inline');
});

test('planSegments marks a cursor-inside segment as revealed', () => {
  const plan = planSegments('a $x+1$ b', [4]); // inside
  assert.equal(plan[0].disposition, 'revealed');
});

test('planSegments: boundary cursor keeps the widget (exclusive)', () => {
  // "a $x+1$ b": segment is [2,7); cursor at 2 or 7 is on the edge.
  assert.equal(planSegments('a $x+1$ b', [2])[0].disposition, 'widget');
  assert.equal(planSegments('a $x+1$ b', [7])[0].disposition, 'widget');
});

test('planSegments marks an empty/whitespace body as invalid', () => {
  assert.equal(planSegments('a $ $ b', [0])[0].disposition, 'invalid');
  assert.equal(planSegments('x $$$$ y', [0])[0].disposition, 'invalid');
});

test('planSegments handles display math', () => {
  const plan = planSegments('p $$E=mc^2$$ q', [0]);
  assert.equal(plan[0].kind, 'block');
  assert.equal(plan[0].disposition, 'widget');
});

test('planSegments with a custom scanner', () => {
  const scan = () => [{ start: 0, end: 3, kind: 'inline', body: 'q' }];
  const plan = planSegments('ignored', [], { scan });
  assert.equal(plan[0].body, 'q');
});

// --- detectLeave (pure) ------------------------------------------------

test('detectLeave returns the segment when point has left it', () => {
  const seg = { start: 2, end: 7, kind: 'inline', body: 'x' };
  assert.equal(detectLeave(seg, [9]), seg); // moved out
  assert.equal(detectLeave(seg, [2]), seg); // on the edge counts as out
});

test('detectLeave returns null while point is still inside', () => {
  const seg = { start: 2, end: 7, kind: 'inline', body: 'x' };
  assert.equal(detectLeave(seg, [4]), null);
});

test('detectLeave with no previous segment is null', () => {
  assert.equal(detectLeave(null, [4]), null);
});

// --- the controller: cache + ranges ------------------------------------

test('createLatexMathPreview is a back-compat alias of createMathPreview', () => {
  assert.equal(createLatexMathPreview, createMathPreview);
});

test('ranges() produces a widget range per valid non-revealed segment', () => {
  const mj = stubMathJax();
  let text = '$a$ x $$b$$';
  const ctrl = createMathPreview({
    getText: () => text,
    getPoints: () => [],
    doc: stubDoc(),
    mathjax: mj,
  });
  const ranges = ctrl.ranges();
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].kind, 'inline');
  assert.equal(ranges[1].kind, 'block');
  // el() returns a (cloned) node.
  const node = ranges[0].el();
  assert.equal(node.cloned, true);
  assert.equal(node.latex, 'a');
});

test('ranges() omits a revealed segment (cursor inside)', () => {
  const mj = stubMathJax();
  const text = 'a $x+1$ b';
  const ctrl = createMathPreview({
    getText: () => text,
    getPoints: () => [4], // inside
    doc: stubDoc(),
    mathjax: mj,
  });
  assert.equal(ctrl.ranges().length, 0);
});

test('ranges() emits an invalid (source) range for an empty body', () => {
  const mj = stubMathJax();
  const text = 'a $ $ b';
  const ctrl = createMathPreview({
    getText: () => text,
    getPoints: () => [],
    doc: stubDoc(),
    mathjax: mj,
  });
  const ranges = ctrl.ranges();
  assert.equal(ranges.length, 1);
  const node = ranges[0].el();
  assert.equal(node.className, 'math-invalid');
  assert.equal(node.textContent, '$ $'); // raw source, delimiters included
  // No typeset call for an invalid body.
  assert.equal(mj.calls.length, 0);
});

test('ranges() falls back to source span when MathJax throws', () => {
  const mj = stubMathJax((s) => s === 'oops');
  const text = 'a $oops$ b';
  const ctrl = createMathPreview({
    getText: () => text,
    getPoints: () => [],
    doc: stubDoc(),
    mathjax: mj,
  });
  const ranges = ctrl.ranges();
  assert.equal(ranges.length, 1);
  const node = ranges[0].el();
  assert.equal(node.className, 'math-invalid');
});

test('the cache typesets a repeated body once across el() calls', () => {
  const mj = stubMathJax();
  const text = '$a$ $a$'; // same body twice
  const ctrl = createMathPreview({
    getText: () => text,
    getPoints: () => [],
    doc: stubDoc(),
    mathjax: mj,
  });
  const ranges = ctrl.ranges();
  // Calling el() on both mounts cloned nodes but only one tex2svg.
  ranges.forEach((r) => r.el());
  ranges.forEach((r) => r.el());
  assert.equal(mj.calls.length, 1); // body 'a' typeset once, then cached
});

test('a changed body re-typesets (cache miss on new key)', () => {
  const mj = stubMathJax();
  let text = '$a$';
  const ctrl = createMathPreview({
    getText: () => text,
    getPoints: () => [],
    doc: stubDoc(),
    mathjax: mj,
  });
  ctrl.ranges()[0].el();
  assert.equal(mj.calls.length, 1);
  text = '$b$'; // edited
  ctrl.ranges()[0].el();
  assert.equal(mj.calls.length, 2); // new body typeset
  // Re-using 'a' again is still cached.
  text = '$a$';
  ctrl.ranges()[0].el();
  assert.equal(mj.calls.length, 2);
});

test('ranges() leaves valid segments as source until MathJax is ready', () => {
  let ready = false;
  let pendingCallback = null;
  const mathjaxWhenReady = {
    startup: { promise: { then: (cb) => { pendingCallback = cb; return { catch() {} }; } } },
  };
  let renders = 0;
  const text = '$a$';
  const ctrl = createMathPreview({
    getText: () => text,
    getPoints: () => [],
    doc: stubDoc(),
    requestRender: () => { renders += 1; },
    // No tex2svg yet → not ready.
    mathjax: mathjaxWhenReady,
  });
  ctrl.update();
  // Not ready: valid segment omitted (shown as source).
  assert.equal(ctrl.ranges().length, 0);
  // The one-shot ready re-render was armed via startup.promise.
  assert.ok(pendingCallback, 'a ready callback was scheduled');
});

test('currentSegment tracks the segment under point after update()', () => {
  const mj = stubMathJax();
  let points = [4];
  const text = 'a $x+1$ b';
  const ctrl = createMathPreview({
    getText: () => text,
    getPoints: () => points,
    doc: stubDoc(),
    mathjax: mj,
  });
  ctrl.update();
  assert.ok(ctrl.currentSegment());
  assert.equal(ctrl.currentSegment().body, 'x+1');
  points = [0]; // moved out
  ctrl.update();
  assert.equal(ctrl.currentSegment(), null);
});

test('invalidateAll clears the typeset cache', () => {
  const mj = stubMathJax();
  const text = '$a$';
  const ctrl = createMathPreview({
    getText: () => text,
    getPoints: () => [],
    doc: stubDoc(),
    mathjax: mj,
  });
  ctrl.ranges()[0].el();
  assert.equal(ctrl.cache.size, 1);
  ctrl.invalidateAll();
  assert.equal(ctrl.cache.size, 0);
});
