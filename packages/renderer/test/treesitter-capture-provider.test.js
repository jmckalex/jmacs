/**
 * @file Unit tests for the capture-provider merge — the pure half of
 * the `captureProvider` language-spec option.
 *
 * `applyCaptureProvider` is to `captureProvider` what `spliceInjections`
 * is to the injection queries: the algorithm extracted from the
 * grammar-bound highlighter so it can be tested with hand-built data.
 * End-to-end coverage (a real grammar + a real provider) lives in the
 * desktop smoke test, like the injection pipeline's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyCaptureProvider, normalizeProviderFold } from '../src/treesitter.js';
import { flattenInnermost } from '../src/runs.js';

test('normalizeProviderFold preserves block + inner-fold flags, not just start/end', () => {
  // The seam where a scanner's fold flavours used to be dropped on the way to
  // the view (jmarkdown @begin/@end folded, but the @end line vanished).
  assert.deepEqual(
    normalizeProviderFold({ start: 0, end: 40, block: true }),
    { start: 0, end: 40, block: true }
  );
  assert.deepEqual(
    normalizeProviderFold({ start: 0, end: 20, innerStart: 3, innerEnd: 16 }),
    { start: 0, end: 20, innerStart: 3, innerEnd: 16 }
  );
  // A plain fold stays plain (no spurious flags).
  assert.deepEqual(normalizeProviderFold({ start: 5, end: 9 }), { start: 5, end: 9 });
});

test('no provider output passes ranges through unchanged', () => {
  const ranges = [{ start: 0, end: 5, face: 'a' }];
  assert.deepEqual(applyCaptureProvider(ranges, undefined), ranges);
  assert.deepEqual(applyCaptureProvider(ranges, null), ranges);
  assert.deepEqual(
    applyCaptureProvider(ranges, { captures: [], regions: [] }),
    ranges
  );
});

test('provider captures are appended after the existing ranges', () => {
  const ranges = [{ start: 0, end: 5, face: 'a' }];
  const provided = { captures: [{ start: 10, end: 12, face: 'b' }] };
  assert.deepEqual(applyCaptureProvider(ranges, provided), [
    { start: 0, end: 5, face: 'a' },
    { start: 10, end: 12, face: 'b' },
  ]);
});

test('regions clip existing ranges exactly as injections do', () => {
  // A grammar capture [0, 30) crosses an owned region [10, 20): the
  // surviving pieces are [0,10) and [20,30); the provider's capture
  // owns the middle.
  const ranges = [{ start: 0, end: 30, face: 'heading' }];
  const provided = {
    regions: [{ start: 10, end: 20 }],
    captures: [{ start: 10, end: 20, face: 'jmd-directive' }],
  };
  const result = applyCaptureProvider(ranges, provided);
  assert.deepEqual(result, [
    { start: 0, end: 10, face: 'heading' },
    { start: 20, end: 30, face: 'heading' },
    { start: 10, end: 20, face: 'jmd-directive' },
  ]);
});

test('a grammar capture fully inside an owned region is dropped', () => {
  // The classic mis-parse: a metadata header's `---` line read as a
  // setext-heading underline. The provider owns the whole header.
  const ranges = [{ start: 5, end: 9, face: 'heading' }];
  const provided = {
    regions: [{ start: 0, end: 20 }],
    captures: [{ start: 0, end: 5, face: 'jmd-meta-key' }],
  };
  const result = applyCaptureProvider(ranges, provided);
  assert.ok(!result.some((r) => r.face === 'heading'));
  assert.ok(result.some((r) => r.face === 'jmd-meta-key'));
});

test('regions without captures still occlude', () => {
  const ranges = [{ start: 0, end: 10, face: 'a' }];
  const result = applyCaptureProvider(ranges, {
    captures: [],
    regions: [{ start: 0, end: 10 }],
  });
  assert.deepEqual(result, []);
});

test('provider captures win exact-span ties downstream (later input wins)', () => {
  // The provider does not occlude here — it relies on flattenInnermost's
  // tie-break: equal spans resolve to the later input range, and the
  // provider's captures are appended last.
  const merged = applyCaptureProvider(
    [{ start: 0, end: 6, face: 'emphasis' }],
    { captures: [{ start: 0, end: 6, face: 'jmd-underline' }] }
  );
  const flat = flattenInnermost(merged);
  assert.deepEqual(flat, [{ start: 0, end: 6, face: 'jmd-underline' }]);
});

test('a smaller provider capture shows inside a larger grammar capture', () => {
  // `/italic/` inside a paragraph-level capture: innermost wins.
  const merged = applyCaptureProvider(
    [{ start: 0, end: 40, face: 'paragraph' }],
    { captures: [{ start: 10, end: 18, face: 'jmd-italic' }] }
  );
  const flat = flattenInnermost(merged);
  assert.deepEqual(flat, [
    { start: 0, end: 10, face: 'paragraph' },
    { start: 10, end: 18, face: 'jmd-italic' },
    { start: 18, end: 40, face: 'paragraph' },
  ]);
});
