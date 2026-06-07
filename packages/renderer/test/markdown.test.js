/**
 * @file Tests for renderMarkdown — the vendored-marked wrapper that
 * protects LaTeX math (and `\$`) from CommonMark's escaping / emphasis /
 * code-span handling, so MathJax receives intact delimiters.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown } from '../src/markdown.js';

/** The placeholder marker must never leak into the output. */
const MARK = String.fromCharCode(0xfffc);

test('renders ordinary markdown (headings, lists)', () => {
  const out = renderMarkdown('# Title\n\n- a\n- b');
  assert.match(out, /<h1>Title<\/h1>/);
  assert.match(out, /<ul>/);
  assert.match(out, /<li>a<\/li>/);
});

test('preserves $$…$$ display math verbatim', () => {
  assert.ok(renderMarkdown('$$ a+b $$').includes('$$ a+b $$'));
});

test('preserves \\[…\\] display math — backslashes survive', () => {
  // The bug this guards: marked turned \[ … \] into [ … ].
  assert.ok(renderMarkdown('\\[ ds^2 = x \\]').includes('\\[ ds^2 = x \\]'));
});

test('preserves \\(…\\) inline math', () => {
  assert.ok(renderMarkdown('see \\(y\\) here').includes('\\(y\\)'));
});

test('preserves $…$ inline math with underscores (no emphasis)', () => {
  const out = renderMarkdown('the $a_1 + b_2$ term');
  assert.ok(out.includes('$a_1 + b_2$'));
  assert.ok(!out.includes('<em>'));
});

test('preserves a \\begin{…} environment; & escaped, \\\\ kept', () => {
  const out = renderMarkdown('\\begin{align} a &= b \\\\ c &= d \\end{align}');
  assert.ok(out.includes('\\begin{align}'));
  assert.ok(out.includes('\\end{align}'));
  assert.ok(out.includes('&amp;=')); // & escaped for the DOM (MathJax decodes)
  assert.ok(out.includes('\\\\')); //  LaTeX row break kept (not collapsed)
});

test('math inside an inline code span is NOT extracted', () => {
  // Screenshot bug #1: `$…$` / `$$…$$` inside `code` was pulled out as math.
  const out = renderMarkdown('pairs `$x$` and `$$y$$` here');
  assert.ok(out.includes('<code>$x$</code>'));
  assert.ok(out.includes('<code>$$y$$</code>'));
  assert.ok(!out.includes(MARK)); // no placeholder leaked
});

test('math inside a fenced code block stays literal', () => {
  const out = renderMarkdown('```\n$x$ and \\[y\\]\n```');
  assert.ok(out.includes('<pre>'));
  assert.ok(out.includes('$x$ and \\[y\\]'));
  assert.ok(!out.includes(MARK));
});

test('an escaped \\$ stays a literal \\$ (currency, not math)', () => {
  // Screenshot bug #2: \$45 … \$30 got paired into one math span.
  const out = renderMarkdown('it costs \\$45, on sale for \\$30');
  assert.ok(out.includes('\\$45'));
  assert.ok(out.includes('\\$30'));
  assert.ok(!out.includes('<em>'));
  assert.ok(!out.includes(MARK));
});

test('\\\\$ (escaped backslash) leaves a live $ for the math scan', () => {
  // a\\$z$  →  literal backslash, then $z$ is math.
  const out = renderMarkdown('a\\\\$z$');
  assert.ok(out.includes('$z$'));
});

test('math does not stop ordinary markdown around it', () => {
  const out = renderMarkdown('see \\[x\\] then:\n\n- one\n- two');
  assert.ok(out.includes('\\[x\\]'));
  assert.match(out, /<ul>/);
});

test('empty / non-string input is empty', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(undefined), '');
});
