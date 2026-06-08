import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMarkdownPreview,
  PREVIEW_DEBOUNCE_MS,
  buildPreviewHead,
  buildPreviewDocument,
  cssLinkTags,
  isFullDocument,
  previewMathSpans,
  makePreviewKeyer,
  hashMathBody,
} from '../src/markdown-preview.js';

/**
 * A minimal DOM stand-in. The component's scheduling/error/clear logic
 * only needs `createElement`/`className`/`append`; the iframe path itself
 * is exercised live (real DOM), so these tests inject a recording
 * `commit` instead of touching the iframe.
 */
function fakeDocument() {
  function makeElement() {
    const node = {
      className: '',
      textContent: '',
      innerHTML: '',
      children: [],
      append(...kids) {
        node.children.push(...kids);
      },
    };
    node.ownerDocument = doc;
    return node;
  }
  const doc = { createElement: () => makeElement() };
  return doc;
}
const fakeContainer = () => fakeDocument().createElement('div');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- pure: head / document builders -----------------------------------

test('cssLinkTags emits a <link> per URL, dropping empties', () => {
  assert.equal(
    cssLinkTags(['a.css', 'b.css']),
    '<link rel="stylesheet" href="a.css">\n<link rel="stylesheet" href="b.css">'
  );
  assert.equal(cssLinkTags([]), '');
  assert.equal(cssLinkTags(['x.css', '', null]), '<link rel="stylesheet" href="x.css">');
});

test('buildPreviewHead orders base, default CSS, user CSS, then MathJax', () => {
  const head = buildPreviewHead({
    baseUrl: 'app://editor/__host__/d/',
    defaultCssUrl: 'app://editor/apps/desktop/markdown-preview.css',
    cssUrls: ['app://editor/__host__/book.css'],
    mathjaxSrc: 'app://editor/mj.js',
    mathjaxConfig: { tex: {} },
  });
  const iBase = head.indexOf('<base');
  const iDefault = head.indexOf('markdown-preview.css');
  const iUser = head.indexOf('book.css');
  const iMj = head.indexOf('mj.js');
  assert.ok(iBase >= 0 && iBase < iDefault && iDefault < iUser && iUser < iMj);
  assert.ok(head.includes('window.MathJax={"tex":{}}'));
});

test('buildPreviewHead omits the pieces it is not given', () => {
  const head = buildPreviewHead({});
  assert.ok(!head.includes('<base'));
  assert.ok(!head.includes('<link'));
  assert.ok(!head.includes('MathJax'));
});

test('buildPreviewHead escapes attribute values', () => {
  const head = buildPreviewHead({ baseUrl: 'x"><script>bad' });
  assert.ok(!head.includes('"><script>'));
  assert.ok(head.includes('&quot;'));
});

test('buildPreviewDocument wraps head + body in a full document', () => {
  const d = buildPreviewDocument('<base>', '<p>hi</p>');
  assert.ok(d.startsWith('<!doctype html>'));
  assert.ok(d.includes('<head>\n<base>\n</head>'));
  assert.ok(d.includes('<body><p>hi</p></body>'));
});

test('isFullDocument detects a complete page vs a fragment', () => {
  assert.equal(isFullDocument('<!doctype html><html>'), true);
  assert.equal(isFullDocument('  <html lang="en">'), true);
  assert.equal(isFullDocument('<h1>frag</h1>'), false);
  assert.equal(isFullDocument('<p>$x$</p>'), false);
});

// --- scheduling via an injected commit --------------------------------

test('createMarkdownPreview mounts a pane into its container', () => {
  const container = fakeContainer();
  const preview = createMarkdownPreview(container, { render: async () => '' });
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0], preview.element);
  assert.equal(preview.element.className, 'markdown-preview');
});

test('refreshNow renders and commits the html plus the head', async () => {
  const container = fakeContainer();
  const commits = [];
  const preview = createMarkdownPreview(container, {
    render: async (s) => `<h1>${s}</h1>`,
    buildHead: () => 'HEAD',
    commit: (html, head) => commits.push([html, head]),
  });
  await preview.refreshNow('Hi');
  assert.deepEqual(commits, [['<h1>Hi</h1>', 'HEAD']]);
});

test('a failed render commits an error fragment instead of throwing', async () => {
  const container = fakeContainer();
  let committed = null;
  const preview = createMarkdownPreview(container, {
    render: async () => {
      throw new Error('boom');
    },
    commit: (html) => {
      committed = html;
    },
  });
  await preview.refreshNow('x');
  assert.match(committed, /Preview unavailable: boom/);
});

test('update debounces to a single commit of the last source', async () => {
  const container = fakeContainer();
  const commits = [];
  const preview = createMarkdownPreview(container, {
    debounceMs: 20,
    render: async (s) => s,
    commit: (html) => commits.push(html),
  });
  preview.update('one');
  preview.update('two');
  preview.update('three');
  await wait(60);
  assert.deepEqual(commits, ['three']);
});

test('a stale slow render cannot overwrite a newer one', async () => {
  const container = fakeContainer();
  let call = 0;
  const commits = [];
  const preview = createMarkdownPreview(container, {
    render: async (s) => {
      call += 1;
      if (call === 1) await wait(40);
      return s;
    },
    commit: (html) => commits.push(html),
  });
  const slow = preview.refreshNow('stale');
  const fast = preview.refreshNow('fresh');
  await Promise.all([slow, fast]);
  assert.deepEqual(commits, ['fresh']);
});

test('clear cancels a pending render', async () => {
  const container = fakeContainer();
  const commits = [];
  const preview = createMarkdownPreview(container, {
    debounceMs: 20,
    render: async (s) => s,
    commit: (html) => commits.push(html),
  });
  preview.update('pending');
  preview.clear();
  await wait(60);
  assert.deepEqual(commits, []);
});

test('PREVIEW_DEBOUNCE_MS is the documented 250ms default', () => {
  assert.equal(PREVIEW_DEBOUNCE_MS, 250);
});

// --- Math detection (pure) — the morphdom diff's keyed spans ----------

test('previewMathSpans finds inline and display dollar math', () => {
  const spans = previewMathSpans('a $x$ and $$y$$ b');
  assert.equal(spans.length, 2);
  assert.equal(spans[0].display, false);
  assert.equal(spans[0].body, 'x');
  assert.equal(spans[1].display, true);
  assert.equal(spans[1].body, 'y');
});

test('previewMathSpans recognises \\(…\\) and \\[…\\]', () => {
  const spans = previewMathSpans('\\(a\\) and \\[b\\]');
  assert.deepEqual(spans.map((s) => s.display), [false, true]);
  assert.deepEqual(spans.map((s) => s.body), ['a', 'b']);
});

test('previewMathSpans ignores an escaped \\$', () => {
  assert.deepEqual(previewMathSpans('it cost \\$5 and \\$10'), []);
});

// --- Key generation (pure) -------------------------------------------

test('hashMathBody is deterministic and content-sensitive', () => {
  assert.equal(hashMathBody('a+b'), hashMathBody('a+b'));
  assert.notEqual(hashMathBody('a+b'), hashMathBody('a-b'));
});

test('makePreviewKeyer gives the same body the same key across renders', () => {
  const render1 = makePreviewKeyer();
  const render2 = makePreviewKeyer();
  assert.equal(render1(false, 'x^2'), render2(false, 'x^2'));
});

test('makePreviewKeyer disambiguates repeated identical formulas', () => {
  const k = makePreviewKeyer();
  const a = k(false, 'x');
  const b = k(false, 'x');
  assert.notEqual(a, b);
  assert.match(a, /#0$/);
  assert.match(b, /#1$/);
});

test('makePreviewKeyer separates display from inline and distinct bodies', () => {
  const k = makePreviewKeyer();
  assert.notEqual(k(false, 'x'), k(true, 'x'));
  const k2 = makePreviewKeyer();
  assert.notEqual(k2(false, 'x'), k2(false, 'y'));
});

test('the Nth identical formula keeps its key across renders', () => {
  const seq = (keyer) => ['x', 'y', 'x'].map((b) => keyer(false, b));
  assert.deepEqual(seq(makePreviewKeyer()), seq(makePreviewKeyer()));
});
