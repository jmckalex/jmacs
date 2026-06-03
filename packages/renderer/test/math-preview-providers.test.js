/**
 * @file Unit tests for the math-preview provider registry — selecting a
 * scanner by major-mode name, and what each mode's provider recognises.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MATH_PREVIEW_CONFIGS,
  providerForConfig,
  mathPreviewProviderForMode,
} from '../src/math-preview-providers.js';
import {
  LATEX_MATH_CONFIG,
  MARKDOWN_MATH_CONFIG,
} from '../src/math-segments.js';

test('the registry maps LaTeX and Markdown to their configs', () => {
  assert.equal(MATH_PREVIEW_CONFIGS.LaTeX, LATEX_MATH_CONFIG);
  assert.equal(MATH_PREVIEW_CONFIGS.Markdown, MARKDOWN_MATH_CONFIG);
});

test('mathPreviewProviderForMode selects the LaTeX provider', () => {
  const provider = mathPreviewProviderForMode('LaTeX');
  assert.ok(provider);
  assert.equal(provider.config, LATEX_MATH_CONFIG);
  // The LaTeX provider recognises \begin…\end environments.
  const segs = provider.scan('\\begin{align}x=1\\end{align}');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'block');
});

test('mathPreviewProviderForMode selects the Markdown provider', () => {
  const provider = mathPreviewProviderForMode('Markdown');
  assert.ok(provider);
  assert.equal(provider.config, MARKDOWN_MATH_CONFIG);
  // The Markdown provider scans $…$ but NOT \begin…\end.
  assert.equal(provider.scan('$z$').length, 1);
  assert.equal(provider.scan('\\begin{align}x=1\\end{align}').length, 0);
});

test('a mode with no provider yields null (no preview)', () => {
  assert.equal(mathPreviewProviderForMode('Fundamental'), null);
  assert.equal(mathPreviewProviderForMode('Lisp'), null);
  assert.equal(mathPreviewProviderForMode('Shell'), null);
});

test('mathPreviewProviderForMode tolerates a non-string mode name', () => {
  assert.equal(mathPreviewProviderForMode(null), null);
  assert.equal(mathPreviewProviderForMode(undefined), null);
  assert.equal(mathPreviewProviderForMode(42), null);
});

test('the provider for a mode is a stable object across calls', () => {
  assert.equal(
    mathPreviewProviderForMode('LaTeX'),
    mathPreviewProviderForMode('LaTeX')
  );
});

test('providerForConfig builds a scan bound to the config', () => {
  // Restricting environments to none gives the common behaviour.
  const provider = providerForConfig({ environments: false });
  assert.equal(provider.scan('\\begin{align}x\\end{align}').length, 0);
  assert.equal(provider.scan('$y$').length, 1);
});
