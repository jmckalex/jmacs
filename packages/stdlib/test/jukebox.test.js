/**
 * @file Tests for the jukebox Lisp surface. The jukebox is now a custom
 * Layer-4 view (see packages/renderer/src/jukebox-view.js); the Lisp
 * side is a thin command that hands a directory path to a host
 * primitive (`open-jukebox-buffer!`) which builds the buffer.
 *
 * The view itself is DOM, so its behaviour is covered by the desktop
 * smoke test — there is no jsdom-based DOM test setup in this repo.
 * Here we cover only the Lisp-visible surface: the `(jukebox …)`
 * command dispatches to either the directory picker or the host
 * primitive, the host-to-Lisp callback on directory choice does the
 * right thing, and the key binding under `C-x j` is intact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import { createInterpreter, keyword, NIL } from '@editor/lisp';
import { createBufferPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/** Build a Lisp metadata map for the `audio-metadata` stub from a
 *  plain JS object — null fields become NIL, the rest map straight
 *  through under their keyword keys. */
function metadataMap(fields) {
  const m = new Map();
  for (const key of ['title', 'artist', 'album', 'track', 'year',
                     'genre', 'duration']) {
    const v = fields[key];
    m.set(keyword(key), v === null || v === undefined ? NIL : v);
  }
  return m;
}

/** Build a minimal editor with stubs for every host primitive the
 *  jukebox command path touches. Each call into a stub is recorded so
 *  a test can read what happened.
 *
 *  Pass `audioMetadata` (a `path → fields | null` function) to drive
 *  the metadata stub for tests of `format-track`. */
async function jukeboxEditor(options = {}) {
  const buffer = createBuffer('', { name: 'scratch' });
  const calls = [];
  const session = {
    get current() {
      return buffer;
    },
  };
  const audioMetadata = options.audioMetadata ?? (() => null);

  const interpreter = createInterpreter({
    write: () => {},
    primitives: {
      ...createBufferPrimitives(session),

      // The stdlib expects these regardless of test focus.
      'open-file!': () => NIL,
      'save-buffer!': () => NIL,
      'reload-stdlib!': () => NIL,
      'start-search!': () => NIL,
      'start-search-backward!': () => NIL,
      'start-command-palette!': () => NIL,
      'start-buffer-switcher!': () => NIL,
      'start-describe-command!': () => NIL,
      'start-goto-line!': () => NIL,
      'start-replace!': () => NIL,
      'recenter!': () => NIL,
      'page-lines': () => 3,
      'toggle-repl!': () => NIL,
      'quit-editor!': () => NIL,
      'note-create!': () => 'note-1',
      'note-edit!': () => NIL,
      'note-delete!': () => NIL,
      'note-at-point': () => 'note-1',
      'note-next!': () => NIL,
      'note-prev!': () => NIL,
      'notes-toggle!': () => NIL,
      'next-buffer!': () => NIL,
      'previous-buffer!': () => NIL,
      'new-buffer!': () => NIL,
      'kill-buffer!': () => NIL,

      // The jukebox primitives.
      'open-jukebox-buffer!': (args) => {
        calls.push(['open-jukebox-buffer', String(args[0])]);
        return NIL;
      },
      'prompt-directory!': () => {
        calls.push(['prompt-directory']);
        return NIL;
      },
      'refresh-jukebox-labels!': () => {
        calls.push(['refresh-jukebox-labels']);
        return NIL;
      },
      'audio-metadata': (args) => {
        const fields = audioMetadata(String(args[0]));
        return fields === null || fields === undefined
          ? NIL
          : metadataMap(fields);
      },
    },
  });
  await loadStdlib(interpreter, (name) =>
    readFile(join(lispDir, name), 'utf8')
  );
  return { interpreter, calls };
}

test('(jukebox <path>) hands the path to open-jukebox-buffer!', async () => {
  const { interpreter, calls } = await jukeboxEditor();
  interpreter.call('jukebox', '/music');
  assert.deepEqual(calls, [['open-jukebox-buffer', '/music']]);
});

test('(jukebox) with no argument opens the directory picker', async () => {
  const { interpreter, calls } = await jukeboxEditor();
  interpreter.evaluate('(jukebox)');
  assert.deepEqual(calls, [['prompt-directory']]);
});

test('jukebox-on-directory-chosen forwards the chosen path', async () => {
  const { interpreter, calls } = await jukeboxEditor();
  interpreter.call('jukebox-on-directory-chosen', '/picked');
  assert.deepEqual(calls, [['open-jukebox-buffer', '/picked']]);
});

test('C-x j is still bound to jukebox', async () => {
  const { interpreter } = await jukeboxEditor();
  assert.ok(
    interpreter.evaluate('(eq? (get c-x-keymap "j") (quote jukebox))')
  );
});

test('format-track renders metadata through the default template', async () => {
  const { interpreter } = await jukeboxEditor({
    audioMetadata: (path) =>
      path === '/m/song.mp3'
        ? { title: 'Cat People', artist: 'Bowie', album: "Let's Dance" }
        : null,
  });
  const result = interpreter.call('format-track', '/m/song.mp3');
  assert.equal(result, '"Cat People", Bowie, Let\'s Dance');
});

test('format-track falls back to the bare filename when metadata is missing', async () => {
  const { interpreter } = await jukeboxEditor();
  const result = interpreter.call('format-track', '/m/untagged.flac');
  assert.equal(result, 'untagged.flac');
});

test('format-track honours a customised *jukebox-track-format*', async () => {
  const { interpreter } = await jukeboxEditor({
    audioMetadata: () => ({
      title: 'Heroes', artist: 'Bowie', track: 3, year: 1977,
    }),
  });
  interpreter.evaluate(
    '(custom-apply! (quote *jukebox-track-format*) "{track}. {title} ({year})")'
  );
  const result = interpreter.call('format-track', '/m/whatever.mp3');
  assert.equal(result, '3. Heroes (1977)');
});

test('customising *jukebox-track-format* fires the refresh-jukebox-labels! hook', async () => {
  const { interpreter, calls } = await jukeboxEditor();
  interpreter.evaluate(
    '(custom-apply! (quote *jukebox-track-format*) "{title}")'
  );
  assert.ok(
    calls.some((c) => c[0] === 'refresh-jukebox-labels'),
    'refresh-jukebox-labels! should have been called by the on-change hook'
  );
});

test('the legacy jukebox-mode is gone — it was the wrong shape', async () => {
  // Regression guard. The text-buffer jukebox-mode is what carried the
  // panel-rendering keymap; it should no longer exist now that the
  // jukebox is a Layer-4 view rather than a major mode.
  const { interpreter } = await jukeboxEditor();
  let threw = false;
  try {
    interpreter.evaluate('jukebox-mode');
  } catch {
    threw = true;
  }
  assert.ok(threw, 'jukebox-mode should be unbound');
});
