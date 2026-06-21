/**
 * @file Smoke tests for the Project Chooser modal (../src/project-chooser.js).
 *
 * There is no Electron and no real DOM here. As elsewhere in this suite
 * (see view-warehouse.test.js), we install a minimal `globalThis.document`
 * with just the API surface the module touches: createElement, append /
 * replaceChildren / remove with real parent tracking, a className/classList
 * pair that stay in sync (so querySelectorAll('.cls') finds elements set
 * either way), dataset/style/value, and add/removeEventListener with a way
 * to dispatch. That's enough to verify the module mounts, renders one card
 * per project, filters on search, opens on click, and tears down on Escape —
 * the things a typo would break. Pixel layout (offsetTop-based column count,
 * scrollIntoView) is stubbed and verified live.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openProjectChooser } from '../src/project-chooser.js';

// --- fake DOM ---------------------------------------------------------------

function makeElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    dataset: {},
    style: {},
    textContent: '',
    title: '',
    type: '',
    placeholder: '',
    value: '',
    tabIndex: 0,
    offsetTop: 0,
    _attrs: {},
    _listeners: {},
  };
  let classSet = new Set();
  Object.defineProperty(node, 'className', {
    get() {
      return [...classSet].join(' ');
    },
    set(v) {
      classSet = new Set(String(v).split(/\s+/).filter(Boolean));
    },
  });
  node.classList = {
    add: (c) => classSet.add(c),
    remove: (c) => classSet.delete(c),
    contains: (c) => classSet.has(c),
    toggle: (c, on) => {
      const want = on === undefined ? !classSet.has(c) : on;
      if (want) classSet.add(c);
      else classSet.delete(c);
      return want;
    },
  };
  node.setAttribute = (k, v) => {
    node._attrs[k] = v;
  };
  node.getAttribute = (k) => node._attrs[k];
  const detach = (child) => {
    if (child.parentNode) {
      const arr = child.parentNode.children;
      const i = arr.indexOf(child);
      if (i >= 0) arr.splice(i, 1);
    }
  };
  node.append = (...kids) => {
    for (const k of kids) {
      detach(k);
      k.parentNode = node;
      node.children.push(k);
    }
  };
  node.appendChild = (k) => {
    node.append(k);
    return k;
  };
  node.replaceChildren = (...kids) => {
    for (const c of node.children) c.parentNode = null;
    node.children = [];
    node.append(...kids);
  };
  node.remove = () => {
    detach(node);
    node.parentNode = null;
  };
  node.addEventListener = (type, fn) => {
    (node._listeners[type] ||= []).push(fn);
  };
  node.removeEventListener = (type, fn) => {
    const arr = node._listeners[type];
    if (arr) {
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
  };
  node.focus = () => {};
  node.scrollIntoView = () => {};
  node.querySelectorAll = (sel) => {
    const cls = sel.replace(/^\./, '');
    const out = [];
    (function walk(n) {
      for (const c of n.children) {
        if (c.classList.contains(cls)) out.push(c);
        walk(c);
      }
    })(node);
    return out;
  };
  return node;
}

function installFakeDom() {
  const docListeners = {};
  const body = makeElement('body');
  const document = {
    body,
    createElement: (tag) => makeElement(tag),
    addEventListener: (type, fn) => {
      (docListeners[type] ||= []).push(fn);
    },
    removeEventListener: (type, fn) => {
      const arr = docListeners[type];
      if (arr) {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      }
    },
  };
  const prior = globalThis.document;
  globalThis.document = document;
  return {
    document,
    body,
    dispatchDocKey: (key) => {
      for (const fn of [...(docListeners.keydown || [])]) {
        fn({ key, preventDefault() {}, stopPropagation() {} });
      }
    },
    restore: () => {
      globalThis.document = prior;
    },
  };
}

function find(root, cls) {
  const out = [];
  (function walk(n) {
    for (const c of n.children) {
      if (c.classList.contains(cls)) out.push(c);
      walk(c);
    }
  })(root);
  return out;
}

function fire(el, type, event = {}) {
  for (const fn of el._listeners[type] || []) {
    fn({ preventDefault() {}, stopPropagation() {}, ...event });
  }
}

const SAMPLE = [
  { path: '/src/jmacs', name: 'jmacs' },
  { path: '/src/btt', name: 'BTT toolkit' },
  { path: '/docs/notes', name: 'notes' },
];

// --- tests ------------------------------------------------------------------

test('chooser mounts an overlay and renders one card per project', () => {
  const dom = installFakeDom();
  try {
    openProjectChooser({ getProjects: () => SAMPLE, openProject: () => {} });
    const overlays = find(dom.body, 'project-chooser-overlay');
    assert.equal(overlays.length, 1);
    assert.equal(find(dom.body, 'project-chooser-card').length, 3);
  } finally {
    dom.restore();
  }
});

test('search filters the rendered cards', () => {
  const dom = installFakeDom();
  try {
    openProjectChooser({ getProjects: () => SAMPLE, openProject: () => {} });
    const [searchInput] = find(dom.body, 'project-chooser-search');
    searchInput.value = 'toolkit';
    fire(searchInput, 'input');
    const cards = find(dom.body, 'project-chooser-card');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].dataset.path, '/src/btt');
  } finally {
    dom.restore();
  }
});

test('clicking a card opens that project and closes the chooser', () => {
  const dom = installFakeDom();
  try {
    let opened = null;
    openProjectChooser({
      getProjects: () => SAMPLE,
      openProject: (path) => {
        opened = path;
      },
    });
    const cards = find(dom.body, 'project-chooser-card');
    fire(cards[1], 'click');
    assert.equal(opened, '/src/btt');
    // The overlay is torn down on open.
    assert.equal(find(dom.body, 'project-chooser-overlay').length, 0);
  } finally {
    dom.restore();
  }
});

test('Escape closes the chooser', () => {
  const dom = installFakeDom();
  try {
    openProjectChooser({ getProjects: () => SAMPLE, openProject: () => {} });
    assert.equal(find(dom.body, 'project-chooser-overlay').length, 1);
    dom.dispatchDocKey('Escape');
    assert.equal(find(dom.body, 'project-chooser-overlay').length, 0);
  } finally {
    dom.restore();
  }
});

test('Enter opens the keyboard-selected project (first by default)', () => {
  const dom = installFakeDom();
  try {
    let opened = null;
    openProjectChooser({
      getProjects: () => SAMPLE,
      openProject: (path) => {
        opened = path;
      },
    });
    dom.dispatchDocKey('Enter');
    assert.equal(opened, '/src/jmacs');
  } finally {
    dom.restore();
  }
});

test('opening a second chooser replaces the first (one overlay)', () => {
  const dom = installFakeDom();
  try {
    openProjectChooser({ getProjects: () => SAMPLE, openProject: () => {} });
    openProjectChooser({ getProjects: () => SAMPLE, openProject: () => {} });
    assert.equal(find(dom.body, 'project-chooser-overlay').length, 1);
  } finally {
    dom.restore();
  }
});

test('empty catalogue shows the empty state, no cards', () => {
  const dom = installFakeDom();
  try {
    openProjectChooser({ getProjects: () => [], openProject: () => {} });
    assert.equal(find(dom.body, 'project-chooser-card').length, 0);
    assert.equal(find(dom.body, 'project-chooser-empty').length, 1);
  } finally {
    dom.restore();
  }
});

test('dropping an image on a tile sets that project thumbnail via the host', () => {
  const dom = installFakeDom();
  try {
    const calls = [];
    let resolvedFile = null;
    openProjectChooser({
      getProjects: () => SAMPLE,
      openProject: () => {},
      getPathForFile: (file) => {
        resolvedFile = file;
        return '/img/' + file.name;
      },
      dropThumbnail: (root, imagePath) => {
        calls.push([root, imagePath]);
        return Promise.resolve(null);
      },
    });
    const tiles = find(dom.body, 'project-chooser-tile');
    const fakeFile = { name: 'pic.png' };
    fire(tiles[1], 'drop', { dataTransfer: { files: [fakeFile] } });
    assert.equal(resolvedFile, fakeFile);
    assert.deepEqual(calls, [['/src/btt', '/img/pic.png']]);
  } finally {
    dom.restore();
  }
});

test('tiles have no drop listener when drop is not wired (no throw)', () => {
  const dom = installFakeDom();
  try {
    openProjectChooser({ getProjects: () => SAMPLE, openProject: () => {} });
    const tiles = find(dom.body, 'project-chooser-tile');
    // No getPathForFile/dropThumbnail supplied → firing a drop is inert.
    assert.doesNotThrow(() =>
      fire(tiles[0], 'drop', { dataTransfer: { files: [{ name: 'x.png' }] } })
    );
  } finally {
    dom.restore();
  }
});
