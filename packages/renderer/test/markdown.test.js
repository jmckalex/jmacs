/**
 * @file Tests for renderMarkdown — the vendored-marked wrapper, with the
 * math extension that protects LaTeX from CommonMark's escaping /
 * emphasis so MathJax receives intact delimiters.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown } from '../src/markdown.js';

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
  const out = renderMarkdown('\\[ ds^2 = x \\]');
  assert.ok(out.includes('\\[ ds^2 = x \\]'));
});

test('preserves \\(…\\) inline math', () => {
  assert.ok(renderMarkdown('see \\(y\\) here').includes('\\(y\\)'));
});

test('preserves $…$ inline math with underscores (no emphasis)', () => {
  const out = renderMarkdown('the $a_1 + b_2$ term');
  assert.ok(out.includes('$a_1 + b_2$'));
  assert.ok(!out.includes('<em>'));
});

test('preserves a \\begin{…} environment; & is escaped, \\\\ kept', () => {
  const out = renderMarkdown('\\begin{align} a &= b \\\\ c &= d \\end{align}');
  assert.ok(out.includes('\\begin{align}'));
  assert.ok(out.includes('\\end{align}'));
  assert.ok(out.includes('&amp;=')); // & escaped for HTML safety (MathJax decodes)
  assert.ok(out.includes('\\\\')); //  LaTeX row break preserved (not collapsed)
});

test('an escaped \\$ stays literal currency, not math', () => {
  const out = renderMarkdown('it costs \\$5 today');
  assert.ok(out.includes('$5'));
  assert.ok(!out.includes('<em>'));
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
