import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLatexMathPreviewActive } from '../src/latex-math-preview-host.js';

/** The Lisp nil value's shape only matters in that it is *not* a cons
 *  pair; any sentinel that lacks head/tail works as the list terminator. */
const NIL = { nil: true };

/** A cons pair the same shape `@editor/lisp` produces: the walker reads
 *  only `.head` and `.tail`. */
const cons = (head, tail) => ({ head, tail });

/** Build a Lisp-shaped proper list from an array, terminated by NIL. */
const list = (items) => items.reduceRight((tail, head) => cons(head, tail), NIL);

// Distinct mode-map stand-ins; identity is what membership compares.
const mathMode = { name: 'MathPreview' };
const otherMode = { name: 'Other' };

test('returns true when the mode is the only member', () => {
  const buffer = { minorModes: list([mathMode]) };
  assert.equal(isLatexMathPreviewActive(buffer, mathMode), true);
});

test('returns true when the mode is among several members', () => {
  const buffer = { minorModes: list([otherMode, mathMode]) };
  assert.equal(isLatexMathPreviewActive(buffer, mathMode), true);
});

test('returns false when the mode is absent from a non-empty list', () => {
  const buffer = { minorModes: list([otherMode]) };
  assert.equal(isLatexMathPreviewActive(buffer, mathMode), false);
});

test('returns false for an empty (nil) minor-mode list', () => {
  const buffer = { minorModes: NIL };
  assert.equal(isLatexMathPreviewActive(buffer, mathMode), false);
});

test('returns false when minorModes was never set (null)', () => {
  const buffer = { minorModes: null };
  assert.equal(isLatexMathPreviewActive(buffer, mathMode), false);
});

test('membership is by identity, not by shape', () => {
  const lookAlike = { name: 'MathPreview' }; // equal shape, different object
  const buffer = { minorModes: list([lookAlike]) };
  assert.equal(isLatexMathPreviewActive(buffer, mathMode), false);
});

test('tolerates a missing buffer', () => {
  assert.equal(isLatexMathPreviewActive(null, mathMode), false);
  assert.equal(isLatexMathPreviewActive(undefined, mathMode), false);
});

test('tolerates an unresolved (null/undefined) mode reference', () => {
  const buffer = { minorModes: list([mathMode]) };
  assert.equal(isLatexMathPreviewActive(buffer, null), false);
  assert.equal(isLatexMathPreviewActive(buffer, undefined), false);
});
