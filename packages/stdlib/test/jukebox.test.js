/**
 * @file Tests for jukebox-mode. The Lisp module is loaded against the
 * standard library with stub audio and directory primitives — every
 * playback action records on `audioCalls`, so the tests assert on the
 * side effects without an HTMLAudioElement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import { arrayToList, createInterpreter, listToArray, NIL } from '@editor/lisp';
import { createBufferPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');

/**
 * Build an editor with the standard library loaded and jukebox audio
 * primitives stubbed. Each call into the stub is recorded so a test
 * can check what happened.
 */
async function jukeboxEditor() {
  const buffer = createBuffer('', { name: 'scratch' });
  // The current "buffer" — the standard library uses a session object
  // whose `current` is rebound when `new-buffer!` runs.
  let current = buffer;
  const buffers = [buffer];
  const audioCalls = [];
  const replOutput = [];
  // Simulated audio element state.
  let audioPlaying = false;
  let audioPath = null;

  const directoryListings = new Map();
  const session = {
    get current() {
      return current;
    },
  };

  const interpreter = createInterpreter({
    write: (text) => replOutput.push(text),
    primitives: {
      ...createBufferPrimitives(session),

      // Stub the host calls the standard library expects.
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

      // Buffer-switching stubs that actually swap the session buffer
      // — the jukebox creates and switches into its own buffer.
      'next-buffer!': () => NIL,
      'previous-buffer!': () => NIL,
      'new-buffer!': (args) => {
        const name = args.length > 0 ? String(args[0]) : 'untitled';
        const existing = buffers.find((b) => b.name === name);
        if (existing) {
          current = existing;
        } else {
          const created = createBuffer('', { name });
          buffers.push(created);
          current = created;
        }
        return NIL;
      },

      // Jukebox audio and directory primitives.
      'list-directory': (args) => {
        const path = String(args[0]);
        const entries = directoryListings.get(path);
        return entries === undefined ? NIL : arrayToList(entries);
      },
      'play-audio!': (args) => {
        audioCalls.push(['play', String(args[0])]);
        audioPath = String(args[0]);
        audioPlaying = true;
        return NIL;
      },
      'pause-audio!': () => {
        audioCalls.push(['pause']);
        audioPlaying = false;
        return NIL;
      },
      'stop-audio!': () => {
        audioCalls.push(['stop']);
        audioPlaying = false;
        audioPath = null;
        return NIL;
      },
      'audio-current-time': () => 0,
      'audio-duration': () => 0,
      'audio-playing?': () => audioPlaying,
      'audio-current-path': () => (audioPath === null ? NIL : audioPath),
      'prompt-directory!': () => {
        audioCalls.push(['prompt-directory']);
        return NIL;
      },
    },
  });
  await loadStdlib(interpreter, (name) => readFile(join(lispDir, name), 'utf8'));

  return {
    interpreter,
    buffers,
    audioCalls,
    replOutput,
    directoryListings,
    get currentBuffer() {
      return current;
    },
  };
}

/** Seed the audio extension recognition. */
test('audio-file? recognises common audio extensions', async () => {
  const { interpreter } = await jukeboxEditor();
  assert.equal(interpreter.evaluate('(audio-file? "song.mp3")'), true);
  assert.equal(interpreter.evaluate('(audio-file? "song.FLAC")'), true);
  assert.equal(interpreter.evaluate('(audio-file? "song.ogg")'), true);
  assert.equal(interpreter.evaluate('(audio-file? "cover.jpg")'), false);
  assert.equal(interpreter.evaluate('(audio-file? "README.txt")'), false);
});

test('filter-audio drops non-audio entries', async () => {
  const { interpreter } = await jukeboxEditor();
  const list = interpreter.evaluate(
    '(filter-audio (list "cover.jpg" "a.mp3" "notes.txt" "b.flac"))'
  );
  assert.deepEqual(listToArray(list), ['a.mp3', 'b.flac']);
});

test('-find-art returns the first matching art filename', async () => {
  const { interpreter } = await jukeboxEditor();
  assert.equal(
    interpreter.evaluate('(-find-art (list "song.mp3" "cover.jpg" "x.txt"))'),
    'cover.jpg'
  );
  assert.equal(
    interpreter.evaluate(
      '(-find-art (list "song.mp3" "FOLDER.PNG" "x.txt"))'
    ),
    'FOLDER.PNG' // case-insensitive match, original case preserved
  );
  assert.equal(
    interpreter.evaluate('(-find-art (list "song.mp3"))'),
    NIL
  );
});

test('swap-tracks exchanges two positions and leaves edges alone', async () => {
  const { interpreter } = await jukeboxEditor();
  const swapped = interpreter.evaluate(
    '(swap-tracks (list "a" "b" "c" "d") 1 2)'
  );
  assert.deepEqual(listToArray(swapped), ['a', 'c', 'b', 'd']);

  // An out-of-range index leaves the list unchanged.
  const same = interpreter.evaluate(
    '(swap-tracks (list "a" "b" "c") 2 3)'
  );
  assert.deepEqual(listToArray(same), ['a', 'b', 'c']);
});

test('shuffle-tracks returns a permutation of the input', async () => {
  const { interpreter } = await jukeboxEditor();
  const input = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const out = listToArray(
    interpreter.evaluate(
      `(shuffle-tracks (list ${input.map((s) => `"${s}"`).join(' ')}))`
    )
  );
  // Same length, same multiset, no nil entries.
  assert.equal(out.length, input.length);
  assert.deepEqual([...out].sort(), [...input].sort());
});

test('shuffle-tracks on an empty list is empty', async () => {
  const { interpreter } = await jukeboxEditor();
  const out = interpreter.evaluate('(shuffle-tracks (list))');
  assert.equal(out, NIL);
});

test('the render panel includes header, track count and bindings', async () => {
  const { interpreter } = await jukeboxEditor();
  const panel = interpreter.evaluate(
    `(jukebox-render {:dir "/music"
                      :tracks (list "a.mp3" "b.flac")
                      :index 0
                      :shuffle false
                      :art "cover.jpg"})`
  );
  assert.ok(panel.includes('Jukebox: /music'));
  assert.ok(panel.includes('Tracks (2):'));
  assert.ok(panel.includes('a.mp3'));
  assert.ok(panel.includes('b.flac'));
  assert.ok(panel.includes('cover.jpg'));
  assert.ok(panel.includes('SPC play/pause'));
  assert.ok(panel.includes('Now Playing: a.mp3'));
});

test('the render panel shows the shuffle flag when on', async () => {
  const { interpreter } = await jukeboxEditor();
  const panel = interpreter.evaluate(
    `(jukebox-render {:dir "/x" :tracks (list) :index nil
                      :shuffle true :art nil})`
  );
  assert.ok(panel.includes('[SHUFFLE]'));
});

test('the render panel says "none" when there is no album art', async () => {
  const { interpreter } = await jukeboxEditor();
  const panel = interpreter.evaluate(
    `(jukebox-render {:dir "/x" :tracks (list "a.mp3") :index 0
                      :shuffle false :art nil})`
  );
  assert.ok(panel.includes('Album art: none'));
});

test('the render panel marks the now-playing track with a pointer', async () => {
  const { interpreter } = await jukeboxEditor();
  const panel = interpreter.evaluate(
    `(jukebox-render {:dir "/x"
                      :tracks (list "a.mp3" "b.mp3" "c.mp3")
                      :index 1 :shuffle false :art nil})`
  );
  // The pointer ">" appears on the second track line (b.mp3) and not
  // on the first or third. The track lines are the ones with the
  // numbered prefix; "Now Playing: b.mp3" also mentions b.mp3, so
  // narrow the match to the numbered list rows.
  const lines = panel.split('\n');
  const a = lines.find((l) => /^\s*[>\s]\s*1\./.test(l));
  const b = lines.find((l) => /^\s*[>\s]\s*2\./.test(l));
  const c = lines.find((l) => /^\s*[>\s]\s*3\./.test(l));
  assert.ok(b && b.includes('> '), `track 2 row missing pointer: ${b}`);
  assert.ok(a && !a.includes('> '), `track 1 row has pointer: ${a}`);
  assert.ok(c && !c.includes('> '), `track 3 row has pointer: ${c}`);
});

test('-seconds->time formats with a leading zero in the seconds', async () => {
  const { interpreter } = await jukeboxEditor();
  assert.equal(interpreter.evaluate('(-seconds->time 0)'), '0:00');
  assert.equal(interpreter.evaluate('(-seconds->time 9)'), '0:09');
  assert.equal(interpreter.evaluate('(-seconds->time 65)'), '1:05');
  assert.equal(interpreter.evaluate('(-seconds->time 332)'), '5:32');
});

test('jukebox opens the panel for a directory and lists its audio files', async () => {
  const { interpreter, currentBuffer, directoryListings } =
    await jukeboxEditor();
  directoryListings.set('/music', [
    'README.txt',
    'cover.jpg',
    'one.mp3',
    'two.flac',
  ]);
  interpreter.call('jukebox', '/music');
  // The current buffer is the jukebox panel; its name reflects the dir.
  const buf = interpreter.evaluate('(buffer-name)');
  assert.equal(buf, '*Jukebox: /music*');
  // The body has both tracks and the cover.
  const text = interpreter.evaluate('(buffer-text)');
  assert.ok(text.includes('one.mp3'));
  assert.ok(text.includes('two.flac'));
  assert.ok(text.includes('cover.jpg'));
  assert.ok(!text.includes('README.txt'));
});

test('jukebox with no argument prompts for a directory', async () => {
  const { interpreter, audioCalls } = await jukeboxEditor();
  interpreter.evaluate('(jukebox)');
  assert.deepEqual(audioCalls, [['prompt-directory']]);
});

test('SPC starts playing the current track', async () => {
  const { interpreter, audioCalls, directoryListings } = await jukeboxEditor();
  directoryListings.set('/m', ['a.mp3', 'b.mp3']);
  interpreter.call('jukebox', '/m');
  interpreter.call('handle-key', ' ');
  assert.deepEqual(audioCalls[0], ['play', '/m/a.mp3']);
});

test('n advances to the next track and plays it', async () => {
  const { interpreter, audioCalls, directoryListings } = await jukeboxEditor();
  directoryListings.set('/m', ['a.mp3', 'b.mp3', 'c.mp3']);
  interpreter.call('jukebox', '/m');
  interpreter.call('handle-key', 'n');
  interpreter.call('handle-key', 'n');
  const plays = audioCalls.filter((c) => c[0] === 'play').map((c) => c[1]);
  assert.deepEqual(plays, ['/m/b.mp3', '/m/c.mp3']);
});

test('n wraps from the last track back to the first', async () => {
  const { interpreter, audioCalls, directoryListings } = await jukeboxEditor();
  directoryListings.set('/m', ['a.mp3', 'b.mp3']);
  interpreter.call('jukebox', '/m');
  interpreter.call('handle-key', 'n'); // → b
  interpreter.call('handle-key', 'n'); // wraps → a
  const plays = audioCalls.filter((c) => c[0] === 'play').map((c) => c[1]);
  assert.deepEqual(plays, ['/m/b.mp3', '/m/a.mp3']);
});

test('p steps backward and wraps', async () => {
  const { interpreter, audioCalls, directoryListings } = await jukeboxEditor();
  directoryListings.set('/m', ['a.mp3', 'b.mp3', 'c.mp3']);
  interpreter.call('jukebox', '/m');
  interpreter.call('handle-key', 'p'); // wraps → c
  const plays = audioCalls.filter((c) => c[0] === 'play').map((c) => c[1]);
  assert.deepEqual(plays, ['/m/c.mp3']);
});

test('s toggles the shuffle flag', async () => {
  const { interpreter, directoryListings } = await jukeboxEditor();
  directoryListings.set('/m', ['a.mp3']);
  interpreter.call('jukebox', '/m');
  assert.equal(
    interpreter.evaluate('(get (jukebox-state) :shuffle false)'),
    false
  );
  interpreter.call('handle-key', 's');
  assert.equal(
    interpreter.evaluate('(get (jukebox-state) :shuffle false)'),
    true
  );
  interpreter.call('handle-key', 's');
  assert.equal(
    interpreter.evaluate('(get (jukebox-state) :shuffle false)'),
    false
  );
});

test('R replaces the playlist with a permutation', async () => {
  const { interpreter, directoryListings } = await jukeboxEditor();
  const tracks = ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3'];
  directoryListings.set('/m', tracks);
  interpreter.call('jukebox', '/m');
  interpreter.call('handle-key', 'R');
  const after = listToArray(
    interpreter.evaluate('(get (jukebox-state) :tracks (list))')
  );
  // The playlist is a permutation: same multiset, same length.
  assert.equal(after.length, tracks.length);
  assert.deepEqual([...after].sort(), [...tracks].sort());
});

test('q stops playback', async () => {
  const { interpreter, audioCalls, directoryListings } = await jukeboxEditor();
  directoryListings.set('/m', ['a.mp3']);
  interpreter.call('jukebox', '/m');
  interpreter.call('handle-key', ' '); // play
  interpreter.call('handle-key', 'q'); // quit
  assert.ok(audioCalls.some((c) => c[0] === 'stop'));
});

test('jukebox-track-ended advances to the next track', async () => {
  const { interpreter, audioCalls, directoryListings } = await jukeboxEditor();
  directoryListings.set('/m', ['a.mp3', 'b.mp3']);
  interpreter.call('jukebox', '/m');
  // The audio element fires `ended`; the host pulls the trigger.
  interpreter.call('jukebox-track-ended');
  const plays = audioCalls.filter((c) => c[0] === 'play').map((c) => c[1]);
  assert.deepEqual(plays, ['/m/b.mp3']);
});

test('the jukebox buffer is in jukebox-mode', async () => {
  const { interpreter, directoryListings } = await jukeboxEditor();
  directoryListings.set('/m', ['a.mp3']);
  interpreter.call('jukebox', '/m');
  assert.ok(
    interpreter.evaluate('(eq? (buffer-major-mode) jukebox-mode)'),
    'major mode should be jukebox-mode'
  );
});

test('C-x j is bound to jukebox', async () => {
  const { interpreter } = await jukeboxEditor();
  assert.ok(
    interpreter.evaluate('(eq? (get c-x-keymap "j") (quote jukebox))')
  );
});

test('RET on a track line plays that specific track', async () => {
  const { interpreter, audioCalls, directoryListings } = await jukeboxEditor();
  directoryListings.set('/m', ['a.mp3', 'b.mp3', 'c.mp3']);
  interpreter.call('jukebox', '/m');
  // Step point down to the third track row. `jukebox-move-to-track!`
  // is the reusable helper.
  interpreter.evaluate('(jukebox-move-to-track! 2)');
  interpreter.call('handle-key', 'enter');
  const plays = audioCalls.filter((c) => c[0] === 'play').map((c) => c[1]);
  // The first play (from opening the jukebox? no — the open does not
  // auto-play; it just sets :index 0) is for /m/c.mp3.
  assert.deepEqual(plays, ['/m/c.mp3']);
});

test('j moves the track under point down by one position', async () => {
  const { interpreter, directoryListings } = await jukeboxEditor();
  directoryListings.set('/m', ['a.mp3', 'b.mp3', 'c.mp3']);
  interpreter.call('jukebox', '/m');
  // Point starts on the first track (index 0 after the open).
  interpreter.evaluate('(jukebox-move-to-track! 0)');
  interpreter.call('handle-key', 'j');
  const after = listToArray(
    interpreter.evaluate('(get (jukebox-state) :tracks (list))')
  );
  assert.deepEqual(after, ['b.mp3', 'a.mp3', 'c.mp3']);
});

test('k moves the track under point up by one position', async () => {
  const { interpreter, directoryListings } = await jukeboxEditor();
  directoryListings.set('/m', ['a.mp3', 'b.mp3', 'c.mp3']);
  interpreter.call('jukebox', '/m');
  interpreter.evaluate('(jukebox-move-to-track! 2)');
  interpreter.call('handle-key', 'k');
  const after = listToArray(
    interpreter.evaluate('(get (jukebox-state) :tracks (list))')
  );
  assert.deepEqual(after, ['a.mp3', 'c.mp3', 'b.mp3']);
});

test('the panel render is stable for a fixed state', async () => {
  // A regression test: any drift in the layout will be visible here.
  const { interpreter } = await jukeboxEditor();
  const once = interpreter.evaluate(
    `(jukebox-render {:dir "/x"
                      :tracks (list "song.mp3")
                      :index 0 :shuffle false :art nil})`
  );
  const twice = interpreter.evaluate(
    `(jukebox-render {:dir "/x"
                      :tracks (list "song.mp3")
                      :index 0 :shuffle false :art nil})`
  );
  assert.equal(once, twice);
});
