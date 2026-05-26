import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSession,
  deserialise,
  isEphemeral,
  serialise,
} from '../src/session.js';

// --- isEphemeral -------------------------------------------------------

test('isEphemeral: a non-text buffer (kind set) is ephemeral', () => {
  assert.equal(isEphemeral({ kind: 'doc', name: 'whatever' }), true);
  assert.equal(isEphemeral({ kind: 'image', name: 'photo.png' }), true);
  assert.equal(isEphemeral({ kind: 'customize', name: '*Customize*' }), true);
});

test('isEphemeral: a text buffer with no file path is ephemeral', () => {
  assert.equal(isEphemeral({ name: 'untitled' }), true);
  assert.equal(isEphemeral({ name: 'foo', filePath: '' }), true);
});

test('isEphemeral: a *…* utility-name buffer is ephemeral', () => {
  assert.equal(isEphemeral({ name: '*scratch*', filePath: '/x' }), true);
  assert.equal(isEphemeral({ name: '*Buffer List*', filePath: '/x' }), true);
  assert.equal(isEphemeral({ name: '*Jukebox: ~/Music*', filePath: '/x' }), true);
  assert.equal(isEphemeral({ name: '*Eval log*', filePath: '/x' }), true);
});

test('isEphemeral: a file-backed text buffer with a real name is kept', () => {
  assert.equal(isEphemeral({ name: 'foo.txt', filePath: '/tmp/foo.txt' }), false);
});

// --- serialise ---------------------------------------------------------

test('serialise: keeps only file-backed text buffers', () => {
  const buffers = [
    { name: '*scratch*' },
    { name: 'foo.txt', filePath: '/tmp/foo.txt', point: 12, mark: null },
    { kind: 'doc', name: '*Doc: forward-char*' },
    { name: 'bar.lisp', filePath: '/tmp/bar.lisp', point: 0, mark: 5 },
  ];
  const out = serialise(buffers, 1);
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

test('serialise: currentPath is null when the current buffer is ephemeral', () => {
  const buffers = [
    { name: 'foo.txt', filePath: '/tmp/foo.txt', point: 3, mark: null },
    { name: '*scratch*' },
  ];
  const out = serialise(buffers, 1);
  assert.equal(out.currentPath, null);
  assert.equal(out.buffers.length, 1);
});

test('serialise: defaults a missing point to 0 and missing mark to null', () => {
  const buffers = [{ name: 'foo.txt', filePath: '/tmp/foo.txt' }];
  const out = serialise(buffers, 0);
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
  const buffers = [
    { name: 'foo.txt', filePath: '/tmp/foo.txt', point: 12, mark: null },
    { name: 'bar.lisp', filePath: '/tmp/bar.lisp', point: 0, mark: 5 },
  ];
  const json = serialise(buffers, 1);
  const back = deserialise(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(back, json);
});

// --- createSession (restore loop) --------------------------------------

test('createSession.restore: re-opens each file and restores point/mark', async () => {
  const writes = [];
  const opens = [];
  let switched = -1;

  // A fake buffer list the openByPath callback grows.
  const buffers = [{ name: '*scratch*' }];

  const controller = createSession({
    getBuffers: () => buffers,
    getCurrentIndex: () => 0,
    openByPath: async (path, entry) => {
      opens.push({ path, point: entry.point, mark: entry.mark });
      buffers.push({
        name: path.split('/').pop(),
        filePath: path,
        point: entry.point,
        mark: entry.mark,
      });
      return entry;
    },
    switchToBuffer: (index) => {
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
      writeSession: async (data) => {
        writes.push(data);
      },
    },
  });

  await controller.restore();
  assert.equal(opens.length, 2);
  assert.equal(opens[0].path, '/tmp/a.txt');
  assert.equal(opens[1].path, '/tmp/b.txt');
  assert.equal(opens[1].point, 7);
  assert.equal(opens[1].mark, 2);
  // Switched onto b — the previously-current buffer.
  assert.equal(switched, 2);
});

test('createSession.restore: a file that fails to open is skipped', async () => {
  const buffers = [];
  const opens = [];
  const controller = createSession({
    getBuffers: () => buffers,
    getCurrentIndex: () => 0,
    openByPath: async (path, entry) => {
      opens.push(path);
      if (path === '/missing') return null;
      buffers.push({ name: 'ok', filePath: path });
      return entry;
    },
    switchToBuffer: () => {},
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
  assert.equal(buffers.length, 1);
});

test('createSession.restore: an absent session.json is a clean no-op', async () => {
  let switched = false;
  const controller = createSession({
    getBuffers: () => [],
    getCurrentIndex: () => 0,
    openByPath: async () => {
      throw new Error('should not be called');
    },
    switchToBuffer: () => {
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
  const buffers = [
    { name: 'foo.txt', filePath: '/tmp/foo.txt', point: 5, mark: null },
  ];
  const controller = createSession({
    getBuffers: () => buffers,
    getCurrentIndex: () => 0,
    openByPath: async () => null,
    switchToBuffer: () => {},
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
  const buffers = [
    { name: 'foo.txt', filePath: '/tmp/foo.txt', point: 0, mark: null },
  ];
  const controller = createSession({
    getBuffers: () => buffers,
    getCurrentIndex: () => 0,
    openByPath: async () => null,
    switchToBuffer: () => {},
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
