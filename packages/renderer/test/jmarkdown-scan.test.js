/**
 * @file Tests for the JMarkdown dialect scanner — the port of the
 * architect's JMarkdown.sublime-syntax state machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanJmarkdown } from '../src/jmarkdown-scan.js';

/** The innermost face painted at `pos`, or null. */
function faceAt(captures, pos) {
  let best = null;
  for (const c of captures) {
    if (c.start <= pos && pos < c.end) {
      if (!best || c.end - c.start < best.end - best.start) best = c;
    }
  }
  return best ? best.face : null;
}

/** The innermost face at the first occurrence of `frag`. */
function faceOf(scan, text, frag, skip = 0) {
  let at = -1;
  for (let n = 0; n <= skip; n += 1) at = text.indexOf(frag, at + 1);
  assert.notEqual(at, -1, `fragment ${JSON.stringify(frag)} not found`);
  return faceAt(scan.captures, at);
}

/** True when some owned region covers `pos`. */
function owned(scan, text, frag) {
  const at = text.indexOf(frag);
  assert.notEqual(at, -1);
  return scan.regions.some((r) => r.start <= at && at < r.end);
}

test('empty input scans to nothing', () => {
  const scan = scanJmarkdown('');
  assert.deepEqual(scan, { captures: [], regions: [], folds: [], injections: [] });
});

/* ── metadata header ─────────────────────────────────────────────────── */

test('fenced metadata header: bold keys, owned lines, fences', () => {
  const text = '---\nTitle: My Book\nBibliography style: harvard1\n---\n\n# Heading\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, '---'), 'jmd-meta-fence');
  assert.equal(faceOf(scan, text, 'Title'), 'jmd-meta-key');
  assert.equal(faceOf(scan, text, 'Bibliography style'), 'jmd-meta-key');
  // The value is not captured, but the line is owned (no grammar bleed).
  assert.equal(faceOf(scan, text, 'My Book'), null);
  assert.ok(owned(scan, text, 'My Book'));
  // The body is not owned.
  assert.ok(!owned(scan, text, '# Heading'));
});

test('legacy header (no opening fence) is detected from the first line', () => {
  const text = 'Title: Notes\nDate: today\n---\nProse.\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, 'Title'), 'jmd-meta-key');
  assert.equal(faceOf(scan, text, 'Date'), 'jmd-meta-key');
  assert.ok(!owned(scan, text, 'Prose.'));
});

test('a document with no header starts scanning at line one', () => {
  const text = '# Just markdown\n\nWith /italics/ here.\n';
  const scan = scanJmarkdown(text);
  assert.ok(!owned(scan, text, '# Just markdown'));
  assert.equal(faceOf(scan, text, 'italics'), 'jmd-italic');
});

test('Extension key: regex spec values get their faces', () => {
  const text = 'Extension smiley: /:-\\)/ /:-\\)/ true 0\n---\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, 'Extension smiley'), 'jmd-meta-key');
  assert.equal(faceOf(scan, text, '/:-\\)/'), 'jmd-meta-regex');
  assert.equal(faceOf(scan, text, 'true'), 'jmd-meta-bool');
  assert.equal(faceAt(scan.captures, text.indexOf(' 0') + 1), 'jmd-meta-number');
});

test('Extension key: delimiter spec and indented HTML body injection', () => {
  const text =
    'Extension box: <<< >>> [true, false] 2\n' +
    '    <div class="box">\n' +
    '    </div>\n' +
    '---\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, '<<<'), 'jmd-meta-delim');
  assert.equal(faceOf(scan, text, '[true, false]'), 'jmd-meta-bool');
  const html = scan.injections.find((i) => i.language === 'html');
  assert.ok(html, 'an html injection for the indented body');
  assert.ok(text.slice(html.start, html.end).includes('<div class="box">'));
  // The body is not owned (the injection must show through).
  assert.ok(!owned(scan, text, '<div'));
});

test('Custom element key: the element name face', () => {
  const text = 'Custom element: my-element\n---\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, 'Custom element'), 'jmd-meta-key');
  assert.equal(faceOf(scan, text, 'my-element'), 'jmd-meta-element');
});

/* ── block directives ────────────────────────────────────────────────── */

test('block directive: punctuation, name, attributes, fold, owned lines', () => {
  const text = 'Intro.\n\n:::note[A title]{.fancy #n1 author="me"}\nBody text.\n:::\n\nAfter.\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, ':::'), 'jmd-directive-punct');
  assert.equal(faceOf(scan, text, 'note'), 'jmd-directive-name');
  assert.equal(faceOf(scan, text, 'A title'), 'jmd-directive-bracket');
  assert.equal(faceOf(scan, text, 'fancy'), 'jmd-attr-class');
  assert.equal(faceOf(scan, text, 'n1'), 'jmd-attr-id');
  assert.equal(faceOf(scan, text, 'author'), 'jmd-attr-name');
  assert.equal(faceOf(scan, text, '"me"'), 'jmd-string');
  // Opener and closer lines are owned; the body is not.
  assert.ok(owned(scan, text, ':::note'));
  assert.ok(!owned(scan, text, 'Body text.'));
  // One fold spanning opener to closer.
  assert.equal(scan.folds.length, 1);
  assert.equal(scan.folds[0].start, text.indexOf(':::note'));
});

test('nested directives fold by colon count', () => {
  const text = '::::aside\nOuter.\n:::note\nInner.\n:::\n::::\n';
  const scan = scanJmarkdown(text);
  assert.equal(scan.folds.length, 2);
  const sorted = scan.folds.slice().sort((a, b) => a.start - b.start);
  assert.equal(sorted[0].start, text.indexOf('::::aside'));
  assert.equal(sorted[1].start, text.indexOf(':::note'));
  assert.ok(sorted[0].end > sorted[1].end);
});

test(':::TiKZ bodies inject latex; :::mermaid bodies get mermaid captures', () => {
  const text =
    ':::TiKZ\n\\draw (0,0) -- (1,1);\n:::\n\n' +
    ':::mermaid\ngraph LR\nA --> B\n:::\n';
  const scan = scanJmarkdown(text);
  const latex = scan.injections.find((i) => i.language === 'latex');
  assert.ok(latex);
  assert.ok(text.slice(latex.start, latex.end).includes('\\draw'));
  assert.equal(faceOf(scan, text, 'graph'), 'keyword');
  assert.equal(faceOf(scan, text, '-->'), 'operator');
  assert.ok(owned(scan, text, 'graph LR'), 'mermaid body is owned');
  assert.equal(scan.folds.length, 2);
});

test('an unclosed :::TiKZ body runs to end of file, like the Sublime context', () => {
  const text = ':::TiKZ\n\\draw (0,0);\nstill latex\n';
  const scan = scanJmarkdown(text);
  const latex = scan.injections.find((i) => i.language === 'latex');
  assert.ok(latex);
  assert.equal(latex.end, text.length);
  assert.equal(scan.folds.length, 0);
});

/* ── @begin/@end environments ────────────────────────────────────────── */

test('@begin/@end: keyword, parens, name zones and a fold', () => {
  const text = '@begin(theorem)[Euclid]{.numbered}\nThere are infinitely many primes.\n@end(theorem)\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, '@begin'), 'jmd-env-keyword');
  assert.equal(faceOf(scan, text, 'theorem'), 'jmd-env-name');
  assert.equal(faceOf(scan, text, 'Euclid'), 'jmd-directive-bracket');
  assert.equal(faceOf(scan, text, 'numbered'), 'jmd-attr-class');
  assert.equal(faceOf(scan, text, '@end'), 'jmd-env-keyword');
  assert.equal(faceOf(scan, text, 'theorem', 1), 'jmd-env-name');
  // Markdown body is neither owned nor blanked.
  assert.ok(!owned(scan, text, 'infinitely'));
  assert.equal(scan.folds.length, 1);
  // A block fold: collapsing keeps both @begin and @end lines (a vertical
  // ellipsis between them), rather than swallowing the closing line.
  assert.equal(scan.folds[0].block, true);
});

test('@begin(equation*) bodies inject latex', () => {
  const text = '@begin(equation*)\nE = mc^2\n@end(equation*)\n';
  const scan = scanJmarkdown(text);
  const latex = scan.injections.find((i) => i.language === 'latex');
  assert.ok(latex);
  assert.ok(text.slice(latex.start, latex.end).includes('E = mc^2'));
  assert.equal(scan.folds.length, 1);
});

test('@begin(mermaid) bodies get mermaid captures', () => {
  const text = '@begin(mermaid)\nsequenceDiagram\n@end(mermaid)\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, 'sequenceDiagram'), 'keyword');
});

test('name sigils .name and <name> stay generic environments', () => {
  const text = '@begin(.TeX)\nThis is a CLASS, not LaTeX.\n@end(TeX)\n';
  const scan = scanJmarkdown(text);
  assert.equal(scan.injections.filter((i) => i.language === 'latex').length, 0);
  assert.equal(faceOf(scan, text, 'TeX'), 'jmd-env-name');
});

test('@begin/@end environments nest on a stack', () => {
  const text = '@begin(a)\n@begin(b)\nx\n@end(b)\n@end(a)\n';
  const scan = scanJmarkdown(text);
  assert.equal(scan.folds.length, 2);
  const sorted = scan.folds.slice().sort((a, b) => a.start - b.start);
  assert.ok(sorted[0].end > sorted[1].end, 'outer fold wraps inner');
});

/* ── inline constructs ───────────────────────────────────────────────── */

test('mustache variables', () => {
  const text = 'Hello {{name}}, welcome.\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, 'name'), 'jmd-mustache');
  assert.equal(faceOf(scan, text, '{{'), 'jmd-punct');
});

test('inline directives with content and attributes', () => {
  const text = 'See :ref[sec-intro] and :TeX[\\noindent]{.x} here.\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, 'ref'), 'jmd-directive-name');
  assert.equal(faceOf(scan, text, 'sec-intro'), 'jmd-directive-bracket');
  assert.equal(faceOf(scan, text, 'TeX'), 'jmd-directive-name');
  assert.ok(owned(scan, text, 'sec-intro'), 'bracket content owned (no link mis-parse)');
});

test('prose colons, times, ratios, and URLs never match as directives', () => {
  const text = 'At 3:30 the ratio a:b appeared: see http://example.com now.\n';
  const scan = scanJmarkdown(text);
  assert.equal(scan.captures.filter((c) => c.face === 'jmd-directive-punct').length, 0);
});

test('==highlight== spans are owned and faced', () => {
  const text = 'This is ==really important== text.\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, 'really important'), 'jmd-highlight');
  assert.ok(owned(scan, text, 'really important'));
});

test('an unclosed ==highlight ends at the blank line', () => {
  const text = 'Some ==half typed\nspan here\n\nNext paragraph.\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, 'half typed'), 'jmd-highlight');
  assert.equal(faceOf(scan, text, 'span here'), 'jmd-highlight');
  assert.equal(faceOf(scan, text, 'Next paragraph.'), null);
});

test('/italic/ spans close before whitespace or trailing punctuation', () => {
  const text = 'Some /italic words/, then /more/.\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, 'italic words'), 'jmd-italic');
  assert.equal(faceOf(scan, text, 'more'), 'jmd-italic');
});

test('mid-word slashes abort: /usr/bin is never italic', () => {
  const text = 'Look in /usr/bin and /etc/hosts for it.\n';
  const scan = scanJmarkdown(text);
  assert.equal(scan.captures.filter((c) => c.face === 'jmd-italic').length, 0);
});

test('escaped slashes stay inside an italic span', () => {
  const text = 'An /italic with \\/escaped\\/ slashes/ here.\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, 'escaped'), 'jmd-italic');
  assert.equal(faceOf(scan, text, 'slashes'), 'jmd-italic');
});

test('fractions like 1/2 never open an italic span', () => {
  const text = 'Buy 1/2 or 3/4 of it.\n';
  const scan = scanJmarkdown(text);
  assert.equal(scan.captures.filter((c) => c.face === 'jmd-italic').length, 0);
});

test('citations: command, pre/post notes, keys', () => {
  const text = 'As shown \\citep[see][p. 7]{smith2020} and \\cite{a, b}.\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, '\\citep'), 'jmd-cite');
  assert.equal(faceOf(scan, text, 'see'), 'jmd-string');
  assert.equal(faceOf(scan, text, 'smith2020'), 'jmd-cite-key');
  assert.equal(faceOf(scan, text, 'a, b'), 'jmd-cite-key');
});

test('footnote openers: labelled and anonymous', () => {
  const text = 'A claim.[^note1: The evidence.] And more.[fn: Anonymous.]\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, '[^note1:'), 'jmd-footnote');
  assert.equal(faceOf(scan, text, '[fn:'), 'jmd-footnote');
  assert.equal(faceOf(scan, text, 'The evidence.'), null);
});

test('[[file]] inclusion lines', () => {
  const text = 'Before.\n\n[[chapter-2.jmd]]\n\nAfter.\n';
  const scan = scanJmarkdown(text);
  assert.equal(faceOf(scan, text, 'chapter-2.jmd'), 'jmd-include');
  assert.ok(owned(scan, text, '[[chapter-2.jmd]]'));
});

/* ── embedded JavaScript chains ──────────────────────────────────────── */

test('a call chain becomes a javascript injection', () => {
  const text = 'The total is compute(3, 4).label here.\n';
  const scan = scanJmarkdown(text);
  const js = scan.injections.find((i) => i.language === 'javascript');
  assert.ok(js);
  assert.equal(text.slice(js.start, js.end), 'compute(3, 4).label');
});

test('e.g. and i.e. never start a chain; nor do sentence-final dots', () => {
  const text = 'This works, e.g. when used, i.e. carefully. The effect. ends here.\n';
  const scan = scanJmarkdown(text);
  assert.equal(scan.injections.filter((i) => i.language === 'javascript').length, 0);
});

test('chain arguments may contain strings with brackets', () => {
  const text = 'Run fmt("a ) tricky", [1, 2]).out now.\n';
  const scan = scanJmarkdown(text);
  const js = scan.injections.find((i) => i.language === 'javascript');
  assert.ok(js);
  assert.equal(text.slice(js.start, js.end), 'fmt("a ) tricky", [1, 2]).out');
});

/* ── masking ─────────────────────────────────────────────────────────── */

test('nothing matches inside fenced code, inline code, or math', () => {
  const text =
    '```\n/not italic/ ==nope== {{no}}\n```\n' +
    'Inline `/code/` and math $a/b/c$ stay plain.\n';
  const scan = scanJmarkdown(text);
  assert.equal(scan.captures.filter((c) => c.face === 'jmd-italic').length, 0);
  assert.equal(scan.captures.filter((c) => c.face === 'jmd-highlight').length, 0);
  assert.equal(scan.captures.filter((c) => c.face === 'jmd-mustache').length, 0);
});

test('<script> blocks inject html', () => {
  const text = 'Before.\n<script data-type="jmarkdown">\nlet x = 1;\n</script>\nAfter.\n';
  const scan = scanJmarkdown(text);
  const html = scan.injections.find((i) => i.language === 'html');
  assert.ok(html);
  assert.ok(text.slice(html.start, html.end).includes('let x = 1;'));
  assert.ok(text.slice(html.start, html.end).includes('</script>'));
});

test('a colon in an ordinary first line does not open a header', () => {
  // Sublime's lookahead would treat this whole document as metadata;
  // the scanner requires a terminating --- before the first blank line.
  const text = 'See here: the first line has a colon.\n\nMore prose.\n';
  const scan = scanJmarkdown(text);
  assert.equal(scan.captures.filter((c) => c.face === 'jmd-meta-key').length, 0);
  assert.ok(!owned(scan, text, 'See here'));
});
