import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSession,
  deserialise,
  isEphemeral,
  serialise,
  serialiseTree,
} from '../src/session.js';

/**
 * Build a minimal view-shaped fixture for the session tests.
 *
 * @param {object} opts
 * @returns {object}
 */
function makeView(opts = {}) {
  const kind = opts.kind ?? 'text';
  const view = {
    kind,
    name: opts.name ?? '',
  };
  if (kind === 'text') {
    view.buffer = {
      filePath: opts.filePath ?? null,
      point: typeof opts.point === 'number' ? opts.point : 0,
      mark: typeof opts.mark === 'number' ? opts.mark : null,
    };
  } else if (typeof opts.filePath === 'string') {
    view.filePath = opts.filePath;
  }
  return view;
}

/** Build a minimal text-view handle with point/mark on the view (not
 *  the buffer), as the real desktop code does after phase-2's
 *  per-view-point split. */
function makeTextView(path, opts = {}) {
  return {
    kind: 'text',
    name: path.split('/').pop(),
    buffer: { filePath: path, point: 0, mark: null },
    point: opts.point ?? 0,
    mark: opts.mark ?? null,
  };
}

/** Build a leaf-pane blob the test exercises against the runtime
 *  shape (handles, not blob records). */
function makeLeaf(id, view) {
  return { kind: 'leaf', id, view };
}

function makeSplit(id, orientation, ratio, first, second) {
  return { kind: 'split', id, orientation, ratio, first, second };
}

function makeTabline(tabs, opts = {}) {
  const view = {
    kind: 'tabline',
    tabs,
    active: opts.active ?? 0,
    edge: opts.edge ?? 'top',
  };
  if (typeof opts.width === 'number') view.width = opts.width;
  return view;
}

/** A file-backed non-text view (image/audio/video). Carries the
 *  `filePath` that the serialiser reads. */
function makeMediaView(kind, path) {
  return { kind, name: path.split('/').pop(), buffer: null, filePath: path };
}

/** A pdf-view handle. PERSIST controls whether the session should
 *  restore it across a relaunch (false by default, matching a fresh
 *  generic / texdoc PDF; latex-view's output sets it true). */
function makePdfView(path, persist = false) {
  return { kind: 'pdf', name: path.split('/').pop(), buffer: null, filePath: path, persist };
}

// --- isEphemeral -------------------------------------------------------

test('isEphemeral: a non-text view is ephemeral', () => {
  assert.equal(isEphemeral(makeView({ kind: 'doc', name: 'whatever' })), true);
  assert.equal(
    isEphemeral(makeView({ kind: 'image', name: 'photo.png' })),
    true
  );
  assert.equal(
    isEphemeral(makeView({ kind: 'customize', name: '*Customize*' })),
    true
  );
});

test('isEphemeral: a text view with no file path is ephemeral', () => {
  assert.equal(isEphemeral(makeView({ name: 'untitled' })), true);
  assert.equal(isEphemeral(makeView({ name: 'foo', filePath: '' })), true);
});

test('isEphemeral: a *…* utility-name view is ephemeral', () => {
  assert.equal(
    isEphemeral(makeView({ name: '*scratch*', filePath: '/x' })),
    true
  );
  assert.equal(
    isEphemeral(makeView({ name: '*Buffer List*', filePath: '/x' })),
    true
  );
  assert.equal(
    isEphemeral(makeView({ name: '*Jukebox: ~/Music*', filePath: '/x' })),
    true
  );
  assert.equal(
    isEphemeral(makeView({ name: '*Eval log*', filePath: '/x' })),
    true
  );
});

test('isEphemeral: a file-backed text view with a real name is kept', () => {
  assert.equal(
    isEphemeral(makeView({ name: 'foo.txt', filePath: '/tmp/foo.txt' })),
    false
  );
});

// --- serialise (legacy v1 emitter, kept for the flat-view tests) -------

test('serialise: keeps only file-backed text views', () => {
  const views = [
    makeView({ name: '*scratch*' }),
    makeView({ name: 'foo.txt', filePath: '/tmp/foo.txt', point: 12, mark: null }),
    makeView({ kind: 'doc', name: '*Doc: forward-char*' }),
    makeView({ name: 'bar.lisp', filePath: '/tmp/bar.lisp', point: 0, mark: 5 }),
  ];
  const out = serialise(views, 1);
  assert.equal(out.buffers.length, 2);
  assert.deepEqual(out.buffers[0], {
    path: '/tmp/foo.txt',
    point: 12,
    mark: null,
  });
  assert.deepEqual(out.buffers[1], {
    path: '/tmp/bar.lisp',
    point: 0,
    mark: 5,
  });
  assert.equal(out.currentPath, '/tmp/foo.txt');
});

test('serialise: currentPath is null when the current view is ephemeral', () => {
  const views = [
    makeView({ name: 'foo.txt', filePath: '/tmp/foo.txt', point: 3, mark: null }),
    makeView({ name: '*scratch*' }),
  ];
  const out = serialise(views, 1);
  assert.equal(out.currentPath, null);
  assert.equal(out.buffers.length, 1);
});

test('serialise: defaults a missing point to 0 and missing mark to null', () => {
  // A text view whose buffer carries no point/mark fields.
  const view = {
    kind: 'text',
    name: 'foo.txt',
    buffer: { filePath: '/tmp/foo.txt' },
  };
  const out = serialise([view], 0);
  assert.equal(out.buffers[0].point, 0);
  assert.equal(out.buffers[0].mark, null);
});

// --- serialiseTree (v2 writer) -----------------------------------------

test('serialiseTree: a single text leaf becomes a v2 root', () => {
  const tree = makeLeaf('pane-leaf-1', makeTextView('/tmp/a.txt', { point: 4 }));
  const out = serialiseTree(tree, 'pane-leaf-1');
  assert.equal(out.version, 2);
  assert.equal(out.currentPaneId, 'pane-leaf-1');
  assert.deepEqual(out.rootPane, {
    kind: 'leaf',
    id: 'pane-leaf-1',
    view: { kind: 'text', path: '/tmp/a.txt', point: 4, mark: null },
  });
});

test('serialiseTree: a leaf with a tabline-view serialises every tab', () => {
  const tabline = makeTabline(
    [
      makeTextView('/tmp/a.txt', { point: 1 }),
      makeTextView('/tmp/b.txt', { point: 2, mark: 5 }),
    ],
    { active: 1, edge: 'right' }
  );
  const tree = makeLeaf('pane-leaf-7', tabline);
  const out = serialiseTree(tree, 'pane-leaf-7');
  assert.equal(out.rootPane.view.kind, 'tabline');
  assert.equal(out.rootPane.view.edge, 'right');
  assert.equal(out.rootPane.view.active, 1);
  assert.equal(out.rootPane.view.tabs.length, 2);
  assert.deepEqual(out.rootPane.view.tabs[1], {
    kind: 'text', path: '/tmp/b.txt', point: 2, mark: 5,
  });
});

test('serialiseTree: a tabline-view persists a user-set width', () => {
  const tabline = makeTabline(
    [makeTextView('/tmp/a.txt')],
    { edge: 'left', width: 220 }
  );
  const out = serialiseTree(makeLeaf('pane-leaf-9', tabline), 'pane-leaf-9');
  assert.equal(out.rootPane.view.width, 220);
});

test('serialiseTree: a tabline-view with no width omits the field', () => {
  const tabline = makeTabline([makeTextView('/tmp/a.txt')], { edge: 'top' });
  const out = serialiseTree(makeLeaf('pane-leaf-10', tabline), 'pane-leaf-10');
  assert.equal('width' in out.rootPane.view, false);
});

test('serialiseTree: a split-pane is serialised recursively', () => {
  const tree = makeSplit(
    'pane-split-3', 'horizontal', 0.4,
    makeLeaf('pane-leaf-1', makeTextView('/tmp/a.txt')),
    makeLeaf('pane-leaf-2', makeTextView('/tmp/b.txt'))
  );
  const out = serialiseTree(tree, 'pane-leaf-2');
  assert.equal(out.rootPane.kind, 'split');
  assert.equal(out.rootPane.orientation, 'horizontal');
  assert.equal(out.rootPane.ratio, 0.4);
  assert.equal(out.rootPane.first.id, 'pane-leaf-1');
  assert.equal(out.rootPane.second.id, 'pane-leaf-2');
  assert.equal(out.currentPaneId, 'pane-leaf-2');
});

test('serialiseTree: non-text leaf views serialise as null', () => {
  const tree = makeLeaf('pane-leaf-9', {
    kind: 'image', name: 'photo.png',
  });
  const out = serialiseTree(tree, 'pane-leaf-9');
  assert.equal(out.rootPane.view, null);
});

test('isEphemeral: a placeholder chooser view is ephemeral', () => {
  assert.equal(
    isEphemeral({ kind: 'placeholder', name: '(choose a view)' }),
    true
  );
});

test('serialiseTree: a placeholder leaf serialises as null (no residue)', () => {
  const tree = makeLeaf('pane-leaf-ph', {
    kind: 'placeholder', name: '(choose a view)',
  });
  const out = serialiseTree(tree, 'pane-leaf-ph');
  assert.equal(out.rootPane.view, null);
});

test('serialiseTree: file-backed media views (image/audio/video) persist their path', () => {
  for (const kind of ['image', 'audio', 'video']) {
    const tree = makeLeaf(`pane-leaf-${kind}`, makeMediaView(kind, `/tmp/x.${kind}`));
    const out = serialiseTree(tree, `pane-leaf-${kind}`);
    assert.deepEqual(out.rootPane.view, { kind, path: `/tmp/x.${kind}` });
  }
});

test('serialiseTree: a media view with no filePath still serialises as null', () => {
  const tree = makeLeaf('pane-leaf-floating', {
    kind: 'image', name: 'in-memory.png', buffer: null,
  });
  const out = serialiseTree(tree, 'pane-leaf-floating');
  assert.equal(out.rootPane.view, null);
});

test('serialiseTree: a bookmark outline persists its source file path', () => {
  const tree = makeLeaf('pane-leaf-bmk', {
    kind: 'bookmark',
    name: '*Bookmarks: notes.md*',
    buffer: null,
    sourceBuffer: { filePath: '/tmp/notes.md', name: 'notes.md' },
  });
  const out = serialiseTree(tree, 'pane-leaf-bmk');
  assert.deepEqual(out.rootPane.view, { kind: 'bookmark', path: '/tmp/notes.md' });
});

test('serialiseTree: a bookmark outline with no source persists a null path', () => {
  const tree = makeLeaf('pane-leaf-bmk2', {
    kind: 'bookmark', name: '*Bookmarks*', buffer: null, sourceBuffer: null,
  });
  const out = serialiseTree(tree, 'pane-leaf-bmk2');
  assert.deepEqual(out.rootPane.view, { kind: 'bookmark', path: null });
});

test('deserialise: a bookmark blob round-trips (path preserved)', () => {
  const tree = makeLeaf('pane-leaf-bmk', {
    kind: 'bookmark',
    name: '*Bookmarks: notes.md*',
    buffer: null,
    sourceBuffer: { filePath: '/tmp/notes.md', name: 'notes.md' },
  });
  const written = serialiseTree(tree, 'pane-leaf-bmk');
  const back = deserialise(JSON.parse(JSON.stringify(written)));
  assert.deepEqual(back.rootPane.view, { kind: 'bookmark', path: '/tmp/notes.md' });
});

test('serialiseTree: media tabs alongside text in a tabline persist together', () => {
  const tabline = makeTabline(
    [
      makeTextView('/tmp/a.txt', { point: 3 }),
      makeMediaView('video', '/tmp/clip.mp4'),
      makeMediaView('audio', '/tmp/song.mp3'),
    ],
    { active: 1 }
  );
  const tree = makeLeaf('pane-leaf-mix', tabline);
  const out = serialiseTree(tree, 'pane-leaf-mix');
  assert.equal(out.rootPane.view.tabs.length, 3);
  assert.equal(out.rootPane.view.tabs[1].kind, 'video');
  assert.equal(out.rootPane.view.tabs[1].path, '/tmp/clip.mp4');
  assert.equal(out.rootPane.view.tabs[2].kind, 'audio');
  assert.equal(out.rootPane.view.active, 1);
});

test('deserialise: a v2 payload with media views round-trips through serialiseTree', () => {
  const tree = makeLeaf('pane-leaf-rt', makeTabline([
    makeTextView('/x.txt'),
    makeMediaView('video', '/y.mp4'),
    makeMediaView('image', '/z.png'),
  ], { active: 1 }));
  const written = serialiseTree(tree, 'pane-leaf-rt');
  const back = deserialise(JSON.parse(JSON.stringify(written)));
  assert.deepEqual(back, written);
});

// --- pdf persistence ---------------------------------------------------

test('serialiseTree: a pdf view flagged persist serialises its path', () => {
  const tree = makeLeaf('pane-leaf-pdf', makePdfView('/tmp/doc.pdf', true));
  const out = serialiseTree(tree, 'pane-leaf-pdf');
  assert.deepEqual(out.rootPane.view, { kind: 'pdf', path: '/tmp/doc.pdf' });
});

test('serialiseTree: a pdf view NOT flagged persist serialises as null', () => {
  const tree = makeLeaf('pane-leaf-pdf', makePdfView('/tmp/texdoc.pdf', false));
  const out = serialiseTree(tree, 'pane-leaf-pdf');
  assert.equal(out.rootPane.view, null);
});

test('serialiseTree: a persist-flagged pdf with no filePath still serialises as null', () => {
  const tree = makeLeaf('pane-leaf-pdf', {
    kind: 'pdf', name: 'in-memory.pdf', buffer: null, persist: true,
  });
  const out = serialiseTree(tree, 'pane-leaf-pdf');
  assert.equal(out.rootPane.view, null);
});

test('serialiseTree: a persistent pdf tab alongside a transient one keeps only the persistent', () => {
  const tabline = makeTabline(
    [
      makeTextView('/tmp/main.tex', { point: 0 }),
      makePdfView('/tmp/main.pdf', true),
      makePdfView('/tmp/texdoc.pdf', false),
    ],
    { active: 1 }
  );
  const tree = makeLeaf('pane-leaf-mix', tabline);
  const out = serialiseTree(tree, 'pane-leaf-mix');
  // The transient pdf drops out; the text + persistent pdf survive.
  assert.equal(out.rootPane.view.tabs.length, 2);
  assert.equal(out.rootPane.view.tabs[1].kind, 'pdf');
  assert.equal(out.rootPane.view.tabs[1].path, '/tmp/main.pdf');
});

test('deserialise: a v2 persistent-pdf payload round-trips through serialiseTree', () => {
  const tree = makeLeaf('pane-leaf-rt', makeTabline([
    makeTextView('/main.tex'),
    makePdfView('/main.pdf', true),
  ], { active: 0 }));
  const written = serialiseTree(tree, 'pane-leaf-rt');
  const back = deserialise(JSON.parse(JSON.stringify(written)));
  assert.deepEqual(back, written);
});

test('deserialise: a v2 media view with no path is dropped', () => {
  const out = deserialise({
    version: 2,
    rootPane: {
      kind: 'leaf', id: 'pane-leaf-bp',
      view: { kind: 'video' /* no path */ },
    },
    currentPaneId: 'pane-leaf-bp',
  });
  assert.equal(out.rootPane.view, null);
});

test('serialiseTree: non-text tabs inside a tabline are dropped', () => {
  const tabline = makeTabline(
    [
      makeTextView('/tmp/a.txt'),
      { kind: 'image', name: 'photo.png' },
      makeTextView('/tmp/b.txt'),
    ],
    { active: 2 }
  );
  const tree = makeLeaf('pane-leaf-1', tabline);
  const out = serialiseTree(tree, 'pane-leaf-1');
  assert.equal(out.rootPane.view.tabs.length, 2);
  // active was 2 — the third tab — but the second tab dropped out, so
  // active should clamp to 1 (the surviving last tab).
  assert.equal(out.rootPane.view.active, 1);
  assert.equal(out.rootPane.view.tabs[0].path, '/tmp/a.txt');
  assert.equal(out.rootPane.view.tabs[1].path, '/tmp/b.txt');
});

// --- deserialise (v1 migration + v2 round-trip) ------------------------

test('deserialise: null or missing input yields an empty v2 session', () => {
  assert.deepEqual(deserialise(null), {
    version: 2, rootPane: null, currentPaneId: null,
  });
  assert.deepEqual(deserialise(undefined), {
    version: 2, rootPane: null, currentPaneId: null,
  });
  assert.deepEqual(deserialise(42), {
    version: 2, rootPane: null, currentPaneId: null,
  });
});

test('deserialise: a v1 payload migrates into a root tabline-view', () => {
  const out = deserialise({
    buffers: [
      { path: '/a', point: 1, mark: null },
      { path: '/b', point: 0, mark: 4 },
    ],
    currentPath: '/b',
  });
  assert.equal(out.version, 2);
  assert.equal(out.currentPaneId, 'pane-leaf-restored');
  assert.equal(out.rootPane.kind, 'leaf');
  assert.equal(out.rootPane.id, 'pane-leaf-restored');
  assert.equal(out.rootPane.view.kind, 'tabline');
  assert.equal(out.rootPane.view.edge, 'top');
  assert.equal(out.rootPane.view.tabs.length, 2);
  // currentPath /b → active 1.
  assert.equal(out.rootPane.view.active, 1);
  assert.equal(out.rootPane.view.tabs[1].path, '/b');
  assert.equal(out.rootPane.view.tabs[1].mark, 4);
});

test('deserialise: a v1 payload with an empty buffer list becomes the empty session', () => {
  const out = deserialise({ buffers: [], currentPath: null });
  assert.equal(out.rootPane, null);
  assert.equal(out.currentPaneId, null);
});

test('deserialise: a v1 currentPath that no longer matches defaults to active 0', () => {
  const out = deserialise({
    buffers: [{ path: '/a' }, { path: '/b' }],
    currentPath: '/gone',
  });
  assert.equal(out.rootPane.view.active, 0);
});

test('deserialise: a v1 payload filters out entries with no path', () => {
  const out = deserialise({
    buffers: [
      { path: '/a' },
      { path: '' },
      { path: null },
      { point: 0 }, // no path at all
      { path: '/c' },
    ],
    currentPath: '/c',
  });
  assert.equal(out.rootPane.view.tabs.length, 2);
  assert.equal(out.rootPane.view.tabs[0].path, '/a');
  assert.equal(out.rootPane.view.tabs[1].path, '/c');
  assert.equal(out.rootPane.view.active, 1);
});

test('deserialise: a v2 payload round-trips through serialiseTree', () => {
  const tree = makeLeaf('pane-leaf-1', makeTabline([
    makeTextView('/x.txt', { point: 7 }),
    makeTextView('/y.txt', { point: 0, mark: 2 }),
  ], { active: 1 }));
  const written = serialiseTree(tree, 'pane-leaf-1');
  const back = deserialise(JSON.parse(JSON.stringify(written)));
  assert.deepEqual(back, written);
});

test('deserialise: a v2 tabline-view round-trips with its width', () => {
  const tree = makeLeaf('pane-leaf-w', makeTabline([
    makeTextView('/x.txt', { point: 0 }),
  ], { edge: 'left', width: 240 }));
  const written = serialiseTree(tree, 'pane-leaf-w');
  const back = deserialise(JSON.parse(JSON.stringify(written)));
  assert.deepEqual(back, written);
  assert.equal(back.rootPane.view.width, 240);
});

test('deserialise: a v2 tabline-view with a malformed width drops it', () => {
  const out = deserialise({
    version: 2,
    rootPane: {
      kind: 'leaf', id: 'pane-leaf-mw', view: {
        kind: 'tabline', edge: 'left', active: 0, tabs: [],
        width: -5,
      },
    },
    currentPaneId: 'pane-leaf-mw',
  });
  assert.equal('width' in out.rootPane.view, false);
});

test('deserialise: a v2 split tree round-trips', () => {
  const tree = makeSplit(
    'pane-split-5', 'vertical', 0.5,
    makeLeaf('pane-leaf-1', makeTabline([
      makeTextView('/a.txt', { point: 1 }),
    ])),
    makeLeaf('pane-leaf-2', makeTextView('/b.txt', { point: 3 }))
  );
  const written = serialiseTree(tree, 'pane-leaf-2');
  const back = deserialise(JSON.parse(JSON.stringify(written)));
  assert.deepEqual(back, written);
});

test('deserialise: a v2 payload with a malformed split drops it', () => {
  const out = deserialise({
    version: 2,
    rootPane: {
      kind: 'split', id: 'pane-split-1', orientation: 'horizontal', ratio: 0.5,
      first: { kind: 'leaf', id: 'pane-leaf-1', view: null },
      // second missing entirely
    },
    currentPaneId: 'pane-leaf-1',
  });
  // The split fails parsing (second missing); rootPane becomes null.
  assert.equal(out.rootPane, null);
});

test('deserialise: a v2 payload clamps an out-of-range tabline active', () => {
  const out = deserialise({
    version: 2,
    rootPane: {
      kind: 'leaf', id: 'pane-leaf-1',
      view: {
        kind: 'tabline', edge: 'top', active: 99,
        tabs: [
          { kind: 'text', path: '/a', point: 0, mark: null },
          { kind: 'text', path: '/b', point: 0, mark: null },
        ],
      },
    },
    currentPaneId: 'pane-leaf-1',
  });
  assert.equal(out.rootPane.view.active, 1);
});

// --- createSession (restore loop + writer) -----------------------------

test('createSession.restore: re-opens each file in a v2 tree and installs', async () => {
  const opens = [];
  let installed = null;
  const controller = createSession({
    getRootPane: () => makeLeaf('pane-leaf-1', null),
    getCurrentPaneId: () => 'pane-leaf-1',
    openByPath: async (path, entry) => {
      opens.push({ path, point: entry.point, mark: entry.mark });
      return makeTextView(path, { point: entry.point, mark: entry.mark });
    },
    installRootPane: (root, currentPaneId) => {
      installed = { root, currentPaneId };
    },
    host: {
      readSession: async () => ({
        version: 2,
        rootPane: makeLeaf('pane-leaf-9', makeTabline([
          { kind: 'text', path: '/tmp/a.txt', point: 3, mark: null },
          { kind: 'text', path: '/tmp/b.txt', point: 7, mark: 2 },
        ], { active: 1 })),
        currentPaneId: 'pane-leaf-9',
      }),
      writeSession: async () => {},
    },
  });
  await controller.restore();
  assert.equal(opens.length, 2);
  assert.equal(opens[0].path, '/tmp/a.txt');
  assert.equal(opens[1].path, '/tmp/b.txt');
  assert.equal(opens[1].point, 7);
  assert.equal(opens[1].mark, 2);
  assert.ok(installed, 'installRootPane should be called');
  assert.equal(installed.currentPaneId, 'pane-leaf-9');
  assert.equal(installed.root.id, 'pane-leaf-9');
});

test('createSession.restore: a migrated v1 payload installs a single tabline leaf', async () => {
  let installed = null;
  const controller = createSession({
    getRootPane: () => makeLeaf('pane-leaf-1', null),
    getCurrentPaneId: () => 'pane-leaf-1',
    openByPath: async (path, entry) =>
      makeTextView(path, { point: entry.point, mark: entry.mark }),
    installRootPane: (root, currentPaneId) => {
      installed = { root, currentPaneId };
    },
    host: {
      readSession: async () => ({
        buffers: [
          { path: '/tmp/a.txt', point: 0, mark: null },
          { path: '/tmp/b.txt', point: 4, mark: null },
        ],
        currentPath: '/tmp/b.txt',
      }),
      writeSession: async () => {},
    },
  });
  await controller.restore();
  assert.equal(installed.currentPaneId, 'pane-leaf-restored');
  assert.equal(installed.root.id, 'pane-leaf-restored');
  assert.equal(installed.root.view.kind, 'tabline');
  assert.equal(installed.root.view.active, 1);
});

test('createSession.restore: a missing session.json is a clean no-op', async () => {
  let installed = false;
  const controller = createSession({
    getRootPane: () => makeLeaf('pane-leaf-1', null),
    getCurrentPaneId: () => 'pane-leaf-1',
    openByPath: async () => null,
    installRootPane: () => { installed = true; },
    host: {
      readSession: async () => null,
      writeSession: async () => {},
    },
  });
  await controller.restore();
  assert.equal(installed, false);
});

test('createSession.restore: an empty v1 buffer list is a clean no-op', async () => {
  let installed = false;
  const controller = createSession({
    getRootPane: () => makeLeaf('pane-leaf-1', null),
    getCurrentPaneId: () => 'pane-leaf-1',
    openByPath: async () => null,
    installRootPane: () => { installed = true; },
    host: {
      readSession: async () => ({ buffers: [], currentPath: null }),
      writeSession: async () => {},
    },
  });
  await controller.restore();
  assert.equal(installed, false);
});

test('createSession.flush writes a v2 snapshot synchronously', async () => {
  const writes = [];
  const tree = makeLeaf('pane-leaf-3', makeTextView('/tmp/foo.txt', { point: 5 }));
  const controller = createSession({
    getRootPane: () => tree,
    getCurrentPaneId: () => 'pane-leaf-3',
    openByPath: async () => null,
    installRootPane: () => {},
    host: {
      readSession: async () => null,
      writeSession: async (data) => { writes.push(data); },
    },
  });
  await controller.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].version, 2);
  assert.equal(writes[0].currentPaneId, 'pane-leaf-3');
  assert.equal(writes[0].rootPane.view.path, '/tmp/foo.txt');
});

test('createSession.save debounces writes', async () => {
  const writes = [];
  const tree = makeLeaf('pane-leaf-1', makeTextView('/tmp/foo.txt'));
  const controller = createSession({
    getRootPane: () => tree,
    getCurrentPaneId: () => 'pane-leaf-1',
    openByPath: async () => null,
    installRootPane: () => {},
    host: {
      readSession: async () => null,
      writeSession: async (data) => { writes.push(data); },
    },
    debounceMs: 20,
  });
  controller.save();
  controller.save();
  controller.save();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(writes.length, 1);
});
