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
  jmarkdownMathMacros,
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
  // The Markdown provider scans $…$ AND \begin…\end (matches MathJax).
  assert.equal(provider.scan('$z$').length, 1);
  const env = provider.scan('\\begin{align}x=1\\end{align}');
  assert.equal(env.length, 1);
  assert.equal(env[0].kind, 'block');
});

test('the Markdown provider previews \\begin{…} environments, but not in code', () => {
  const provider = mathPreviewProviderForMode('Markdown');
  const align = '\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}';
  const segs = provider.scan(align);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'block');
  assert.equal(segs[0].body, align); // whole environment is the typeset body
  // ...but an environment inside a fenced code block stays literal.
  assert.equal(provider.scan('```\n' + align + '\n```').length, 0);
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

test('the Markdown provider does not treat math inside code as math', () => {
  const provider = mathPreviewProviderForMode('Markdown');
  // The reported bug: a heading whose backtick span holds math — the
  // `$$…$$` previously became a block segment wedged in the heading line
  // and corrupted the preview. It must now be ignored.
  assert.equal(provider.scan('## Inline `$x$` here').length, 0);
  assert.equal(provider.scan('## Display `$$y$$` here').length, 0);
  assert.equal(provider.scan('```\n$z$\n```').length, 0);
  // Real math alongside masked code is still found, at correct offsets.
  const text = 'text `$x$` and $y$';
  const segs = provider.scan(text);
  assert.equal(segs.length, 1);
  assert.equal(text.slice(segs[0].start, segs[0].end), '$y$');
});

test('the LaTeX provider does NOT mask backticks (not code in .tex)', () => {
  const provider = mathPreviewProviderForMode('LaTeX');
  assert.equal(provider.scan('`$x$`').length, 1);
});

test('providerForConfig masks code only when asked', () => {
  assert.equal(providerForConfig(MARKDOWN_MATH_CONFIG, true).scan('`$x$`').length, 0);
  assert.equal(providerForConfig(MARKDOWN_MATH_CONFIG, false).scan('`$x$`').length, 1);
});

test('JMarkdown selects the markdown config with code masking', () => {
  const provider = mathPreviewProviderForMode('JMarkdown');
  assert.ok(provider, 'JMarkdown has a provider');
  assert.equal(provider.config, MARKDOWN_MATH_CONFIG);
  // Code masking: a $ inside an inline code span is not math.
  const segments = provider.scan('Code `$x$` but math $y$.');
  assert.deepEqual(segments.map((s) => s.body), ['y']);
});

// --- jmarkdownMathMacros: the `Math macros:` header harvest --------------

test('jmarkdownMathMacros harvests a fenced header key with continuations', () => {
  const text = [
    '---',
    'Title: Doc',
    'Math macros: \\newcommand{\\R}{\\mathbb{R}}',
    '    \\newcommand{\\E}{\\mathbb{E}}',
    '    \\DeclareMathOperator{\\Var}{Var}',
    'Author: Me',
    '---',
    '',
    'Body $\\R$.',
  ].join('\n');
  assert.equal(
    jmarkdownMathMacros(text),
    '\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\E}{\\mathbb{E}}\n\\DeclareMathOperator{\\Var}{Var}'
  );
});

test('jmarkdownMathMacros: continuation-only value (empty rest of key line)', () => {
  const text = '---\nMath macros:\n    \\newcommand{\\x}{y}\n---\n';
  assert.equal(jmarkdownMathMacros(text), '\\newcommand{\\x}{y}');
});

test('jmarkdownMathMacros works in a legacy (fence-less) header', () => {
  const text = 'Title: T\nMath macros: \\newcommand{\\a}{b}\n---\nBody.\n';
  assert.equal(jmarkdownMathMacros(text), '\\newcommand{\\a}{b}');
});

test('jmarkdownMathMacros finds nothing outside a header', () => {
  assert.equal(jmarkdownMathMacros('# Doc\n\nMath macros: \\newcommand{\\a}{b}\n'), '');
  assert.equal(jmarkdownMathMacros('---\nTitle: T\n---\nMath macros: nope\n'), '');
  assert.equal(jmarkdownMathMacros(''), '');
});

test('jmarkdownMathMacros matches the key case-insensitively on its first letter', () => {
  const text = '---\nmath macros: \\def\\x{1}\n---\n';
  assert.equal(jmarkdownMathMacros(text), '\\def\\x{1}');
});

test('the JMarkdown provider carries the macro harvester; LaTeX does not', () => {
  const jmd = mathPreviewProviderForMode('JMarkdown');
  assert.equal(
    jmd.preamble('---\nMath macros: \\newcommand{\\q}{r}\n---\n'),
    '\\newcommand{\\q}{r}'
  );
  const latex = mathPreviewProviderForMode('LaTeX');
  assert.equal(latex.preamble('\\newcommand{\\q}{r}'), '');
});
