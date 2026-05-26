import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSession,
  deserialise,
  isEphemeral,
  serialise,
} from '../src/session.js';

/**
 * Build a minimal view-shaped fixture for the session tests. The session
 * controller now consumes views directly (phase 2 of plans/PANES.md);
 * before phase 1 the same tests passed buffer-record shapes — the
 * one-line fields-shape change is the only thing that differs.
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

// --- serialise ---------------------------------------------------------

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

// --- deserialise -------------------------------------------------------

test('deserialise: null or missing input yields an empty session', () => {
  assert.deepEqual(deserialise(null), { buffers: [], currentPath: null });
  assert.deepEqual(deserialise(undefined), { buffers: [], currentPath: null });
  assert.deepEqual(deserialise(42), { buffers: [], currentPath: null });
});

test('deserialise: parses a well-shaped payload', () => {
  const out = deserialise({
    buffers: [
      { path: '/a', point: 1, mark: null },
      { path: '/b', point: 0, mark: 4 },
    ],
    currentPath: '/b',
  });
  assert.equal(out.buffers.length, 2);
  assert.equal(out.buffers[0].path, '/a');
  assert.equal(out.buffers[1].mark, 4);
  assert.equal(out.currentPath, '/b');
});

test('deserialise: filters out entries with no path', () => {
  const out = deserialise({
    buffers: [
      { path: '/a' },
      { path: '' },
      { path: null },
      { point: 0 }, // no path at all
      { path: '/c' },
    ],
  });
  assert.equal(out.buffers.length, 2);
  assert.equal(out.buffers[0].path, '/a');
  assert.equal(out.buffers[1].path, '/c');
});

test('deserialise: a serialise → deserialise round-trip is lossless', () => {
  const views = [
    makeView({ name: 'foo.txt', filePath: '/tmp/foo.txt', point: 12, mark: null }),
    makeView({ name: 'bar.lisp', filePath: '/tmp/bar.lisp', point: 0, mark: 5 }),
  ];
  const json = serialise(views, 1);
  const back = deserialise(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(back, json);
});

// --- createSession (restore loop) --------------------------------------

test('createSession.restore: re-opens each file and restores point/mark', async () => {
  const opens = [];
  let switched = -1;

  // A fake view list the openByPath callback grows.
  const views = [makeView({ name: '*scratch*' })];

  const controller = createSession({
    getViews: () => views,
    getCurrentIndex: () => 0,
    openByPath: async (path, entry) => {
      opens.push({ path, point: entry.point, mark: entry.mark });
      views.push(
        makeView({
          name: path.split('/').pop(),
          filePath: path,
          point: entry.point,
          mark: entry.mark,
        })
      );
      return entry;
    },
    switchToView: (index) => {
      switched = index;
    },
    host: {
      readSession: async () => ({
        buffers: [
          { path: '/tmp/a.txt', point: 3, mark: null },
          { path: '/tmp/b.txt', point: 7, mark: 2 },
        ],
        currentPath: '/tmp/b.txt',
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
  // Switched onto b — the previously-current view.
  assert.equal(switched, 2);
});

test('createSession.restore: a file that fails to open is skipped', async () => {
  const views = [];
  const opens = [];
  const controller = createSession({
    getViews: () => views,
    getCurrentIndex: () => 0,
    openByPath: async (path, entry) => {
      opens.push(path);
      if (path === '/missing') return null;
      views.push(makeView({ name: 'ok', filePath: path }));
      return entry;
    },
    switchToView: () => {},
    host: {
      readSession: async () => ({
        buffers: [
          { path: '/missing', point: 0, mark: null },
          { path: '/present', point: 0, mark: null },
        ],
        currentPath: '/present',
      }),
      writeSession: async () => {},
    },
  });
  await controller.restore();
  assert.equal(opens.length, 2);
  assert.equal(views.length, 1);
});

test('createSession.restore: an absent session.json is a clean no-op', async () => {
  let switched = false;
  const controller = createSession({
    getViews: () => [],
    getCurrentIndex: () => 0,
    openByPath: async () => {
      throw new Error('should not be called');
    },
    switchToView: () => {
      switched = true;
    },
    host: {
      readSession: async () => null,
      writeSession: async () => {},
    },
  });
  await controller.restore();
  assert.equal(switched, false);
});

test('createSession.flush writes the session synchronously', async () => {
  const writes = [];
  const views = [
    makeView({ name: 'foo.txt', filePath: '/tmp/foo.txt', point: 5, mark: null }),
  ];
  const controller = createSession({
    getViews: () => views,
    getCurrentIndex: () => 0,
    openByPath: async () => null,
    switchToView: () => {},
    host: {
      readSession: async () => null,
      writeSession: async (data) => {
        writes.push(data);
      },
    },
  });
  await controller.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].currentPath, '/tmp/foo.txt');
  assert.equal(writes[0].buffers.length, 1);
});

test('createSession.save debounces writes', async () => {
  const writes = [];
  const views = [
    makeView({ name: 'foo.txt', filePath: '/tmp/foo.txt', point: 0, mark: null }),
  ];
  const controller = createSession({
    getViews: () => views,
    getCurrentIndex: () => 0,
    openByPath: async () => null,
    switchToView: () => {},
    host: {
      readSession: async () => null,
      writeSession: async (data) => {
        writes.push(data);
      },
    },
    debounceMs: 20,
  });
  // Three rapid saves coalesce into one write after the debounce.
  controller.save();
  controller.save();
  controller.save();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(writes.length, 1);
});
