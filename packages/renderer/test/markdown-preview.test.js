import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMarkdownPreview,
  PREVIEW_DEBOUNCE_MS,
} from '../src/markdown-preview.js';

/**
 * A minimal DOM stand-in — the preview component only needs
 * `createElement`, `className`, `textContent`, `innerHTML` and
 * `append`. Keeping it tiny avoids pulling in a DOM library.
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

/** A container element to mount the preview into. */
function fakeContainer() {
  const doc = fakeDocument();
  return doc.createElement('div');
}

/** Resolve after `ms` milliseconds. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('createMarkdownPreview mounts a pane into its container', () => {
  const container = fakeContainer();
  const preview = createMarkdownPreview(container, {
    render: async () => '',
  });
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0], preview.element);
  assert.equal(preview.element.className, 'markdown-preview');
});

test('refreshNow renders the source and shows the HTML', async () => {
  const container = fakeContainer();
  const preview = createMarkdownPreview(container, {
    render: async (source) => `<h1>${source}</h1>`,
  });
  await preview.refreshNow('Hello');
  const body = preview.element.children[1];
  assert.equal(body.innerHTML, '<h1>Hello</h1>');
});

test('refreshNow shows an error message when the render fails', async () => {
  const container = fakeContainer();
  const preview = createMarkdownPreview(container, {
    render: async () => {
      throw new Error('command not found');
    },
  });
  await preview.refreshNow('# anything');
  const body = preview.element.children[1];
  assert.match(body.textContent, /Preview unavailable: command not found/);
});

test('update debounces — only the last source is rendered', async () => {
  const container = fakeContainer();
  const rendered = [];
  const preview = createMarkdownPreview(container, {
    debounceMs: 20,
    render: async (source) => {
      rendered.push(source);
      return source;
    },
  });
  preview.update('one');
  preview.update('two');
  preview.update('three');
  await wait(60);
  assert.deepEqual(rendered, ['three']);
  assert.equal(preview.element.children[1].innerHTML, 'three');
});

test('a stale slow render cannot overwrite a newer one', async () => {
  const container = fakeContainer();
  let call = 0;
  const preview = createMarkdownPreview(container, {
    render: async (source) => {
      call += 1;
      // The first render is slow; the second is immediate.
      if (call === 1) await wait(40);
      return source;
    },
  });
  const slow = preview.refreshNow('stale');
  const fast = preview.refreshNow('fresh');
  await Promise.all([slow, fast]);
  assert.equal(preview.element.children[1].innerHTML, 'fresh');
});

test('typeset hook runs on the body after a successful render', async () => {
  const container = fakeContainer();
  let typesetTarget = null;
  const preview = createMarkdownPreview(container, {
    render: async () => '<p>math</p>',
    typeset: (element) => {
      typesetTarget = element;
    },
  });
  await preview.refreshNow('math');
  assert.equal(typesetTarget, preview.element.children[1]);
});

test('clear empties the body and cancels a pending render', async () => {
  const container = fakeContainer();
  const rendered = [];
  const preview = createMarkdownPreview(container, {
    debounceMs: 20,
    render: async (source) => {
      rendered.push(source);
      return source;
    },
  });
  await preview.refreshNow('content');
  assert.equal(preview.element.children[1].innerHTML, 'content');
  preview.update('pending');
  preview.clear();
  await wait(60);
  assert.equal(preview.element.children[1].innerHTML, '');
  assert.deepEqual(rendered, ['content']);
});

test('PREVIEW_DEBOUNCE_MS is the documented ~250ms default', () => {
  assert.equal(PREVIEW_DEBOUNCE_MS, 250);
});
