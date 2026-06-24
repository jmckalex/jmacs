/**
 * @file Tests for the Model-B command spine (spine.js). These run the REAL
 * command machinery — the real buffer primitives, the real
 * commands.lisp/editing.lisp, the real run-command/interactive gatherer —
 * server-side, with no Electron and no DOM. They prove the command surface
 * works *through the spine*: self-insert, motion, editing, M-x, find-file,
 * and the minibuffer round-trip.
 *
 * Part of the existing `node --test` suite, so the desktop suite stays
 * green and the spine is verified without a screen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpine } from './spine.js';
import { wireLeaves, wireFocusedLeafId } from './protocol.js';

/** A spine with recording effects, for assertions. */
function makeSpine(initialText = '', name = 'scratch.txt', extra = {}) {
  const log = {
    status: [], minibufferOpens: [], minibufferCloses: 0, scrolls: [], saves: [],
    // Each open generic-picker request (the G0b channel), as the server sees it.
    pickerOpens: [],
    // Each new-window request (the C-x 5 2 effect, G4).
    newWindows: 0,
  };
  const spine = createSpine(
    { initialText, name },
    {
      onStatus: (s) => log.status.push(s),
      onMinibufferOpen: (p) => log.minibufferOpens.push(p),
      onMinibufferClose: () => { log.minibufferCloses += 1; },
      onScroll: (r) => log.scrolls.push(r),
      onPicker: (req) => log.pickerOpens.push(req),
      onNewWindow: () => { log.newWindows += 1; },
      openFile: extra.openFile,
      // A recording save: capture the {path, text} the spine would write, and
      // return success unless the test injects a failure. Lets save-buffer /
      // write-file be exercised without real disk I/O.
      saveFile: extra.saveFile ?? ((req) => { log.saves.push(req); return { ok: true }; }),
    }
  );
  return { spine, log };
}

test('self-insert: a bare printable key inserts text at point', () => {
  const { spine } = makeSpine('');
  for (const ch of 'hello') spine.handleKey(ch);
  assert.equal(spine.buffer.text, 'hello');
  assert.equal(spine.buffer.point, 5);
});

test('enter runs the real newline command (server-side)', () => {
  const { spine } = makeSpine('');
  for (const ch of 'ab') spine.handleKey(ch);
  spine.handleKey('enter');
  spine.handleKey('c');
  assert.equal(spine.buffer.text, 'ab\nc');
});

test('backspace runs the real delete-backward command', () => {
  const { spine } = makeSpine('abc');
  spine.buffer.moveTo(3);
  spine.handleKey('backspace');
  assert.equal(spine.buffer.text, 'ab');
  assert.equal(spine.buffer.point, 2);
});

test('motion: arrows + C-a/C-e move point through the real commands', () => {
  const { spine } = makeSpine('line one\nline two');
  spine.buffer.moveTo(0);
  spine.handleKey('down'); // next-line → into "line two"
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 1);
  spine.handleKey('C-e'); // move-end-of-line
  assert.equal(spine.buffer.point, spine.buffer.text.length);
  spine.handleKey('C-a'); // move-beginning-of-line
  assert.equal(spine.buffer.positionAt(spine.buffer.point).column, 0);
});

test('M-< / M-> jump to buffer start/end via real commands', () => {
  const { spine } = makeSpine('abcdef');
  spine.handleKey('M-greater');
  assert.equal(spine.buffer.point, 6);
  spine.handleKey('M-less');
  assert.equal(spine.buffer.point, 0);
});

test('a prefix chord (C-x C-s) resolves to a command, not self-insert', () => {
  // On a PATH-LESS buffer C-x C-s falls back to write-file (opens a prompt),
  // exactly like Emacs's C-x C-s on a new buffer.
  const { spine, log } = makeSpine('');
  const handled1 = spine.handleKey('C-x');
  assert.equal(handled1, true);
  assert.equal(spine.buffer.text, ''); // C-x did not insert
  const handled2 = spine.handleKey('C-s'); // save-buffer → write-file prompt
  assert.equal(handled2, true);
  assert.ok(
    log.minibufferOpens.includes('Write file: '),
    `expected the write-file prompt, got ${JSON.stringify(log.minibufferOpens)}`
  );
});

test('an unbound key mid-chord aborts the chord cleanly', () => {
  const { spine } = makeSpine('');
  spine.handleKey('C-x');
  const handled = spine.handleKey('z'); // nothing bound under C-x z
  assert.equal(handled, true); // consumed as a failed chord
  assert.equal(spine.buffer.text, ''); // not self-inserted
  // Back at rest: a printable now self-inserts again.
  spine.handleKey('q');
  assert.equal(spine.buffer.text, 'q');
});

test('command-names comes from the REAL registry', () => {
  const { spine } = makeSpine('');
  const names = spine.commandNames();
  assert.ok(names.includes('forward-char'), 'forward-char registered');
  assert.ok(names.includes('newline'), 'newline registered');
  assert.ok(names.includes('execute-extended-command'), 'M-x registered');
  assert.ok(names.includes('find-file'), 'find-file registered');
});

test('set-mark-command starts a selection that motion extends', () => {
  const { spine } = makeSpine('hello world');
  spine.buffer.moveTo(0);
  spine.handleKey('C-space'); // set-mark-command
  assert.equal(spine.buffer.mark, 0);
  spine.handleKey('right');
  spine.handleKey('right');
  // mark stays put, point moved → an active selection of 2 chars
  assert.equal(spine.buffer.mark, 0);
  assert.equal(spine.buffer.point, 2);
});

test('the minibuffer round-trip: a command prompts, then resumes on submit', () => {
  // goto-line is interactive (number "Goto line: "). Running it opens the
  // minibuffer; delivering "3" resumes the command and jumps point.
  const { spine, log } = makeSpine('one\ntwo\nthree\nfour');
  spine.runCommand('goto-line');
  assert.deepEqual(log.minibufferOpens, ['Goto line: ']);
  // Point hasn't moved yet — the command is suspended in the gatherer.
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 0);
  spine.deliverMinibuffer('3');
  assert.equal(log.minibufferCloses, 1);
  // goto-line is 1-based → line index 2 ("three").
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 2);
});

test('cancelling the minibuffer does not run the command body', () => {
  const { spine, log } = makeSpine('one\ntwo\nthree');
  const before = spine.buffer.point;
  spine.runCommand('goto-line');
  spine.deliverMinibuffer(null); // C-g / Esc
  assert.equal(log.minibufferCloses, 1);
  assert.equal(spine.buffer.point, before); // unchanged
});

test('replace-string: a two-prompt interactive command chains prompts', () => {
  const { spine, log } = makeSpine('a cat sat on a cat');
  spine.runCommand('replace-string');
  assert.deepEqual(log.minibufferOpens, ['Replace: ']);
  spine.deliverMinibuffer('cat'); // first arg
  assert.deepEqual(log.minibufferOpens, ['Replace: ', 'Replace with: ']);
  spine.deliverMinibuffer('dog'); // second arg → runs
  assert.equal(spine.buffer.text, 'a dog sat on a dog');
});

test('recenter! emits a down-channel scroll request with the target line', () => {
  const { spine, log } = makeSpine('l0\nl1\nl2\nl3\nl4');
  spine.buffer.moveTo(spine.buffer.offsetAt(3, 0)); // line index 3
  spine.handleKey('C-l'); // recenter
  assert.equal(log.scrolls.length, 1);
  assert.equal(log.scrolls[0].kind, 'recenter');
  assert.equal(log.scrolls[0].line, 3);
});

// --- screenful scroll (C-v / M-v) — the VIEWPORT-sized page step ----------

/** A buffer with N short lines "l0".."l{N-1}", for scroll tests. */
function linesBuffer(n) {
  return Array.from({ length: n }, (_, i) => `l${i}`).join('\n');
}

test('setViewport records the client viewport; viewportOf reads it back', () => {
  const { spine } = makeSpine('');
  assert.equal(spine.viewportOf(0), 0); // unmeasured at boot
  spine.setViewport(0, 40);
  assert.equal(spine.viewportOf(0), 40);
  // A non-positive / non-finite report is ignored (keeps the last good value).
  spine.setViewport(0, 0);
  spine.setViewport(0, -5);
  spine.setViewport(0, NaN);
  assert.equal(spine.viewportOf(0), 40);
});

test('C-v (scroll-up) moves point DOWN by ~one screenful (viewport - context)', () => {
  const { spine } = makeSpine(linesBuffer(100));
  spine.setViewport(0, 40); // 40 visible lines → step = 40 - 2 = 38
  spine.buffer.moveTo(0); // line 0
  spine.handleKey('C-v');
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 38);
  spine.handleKey('C-v');
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 76);
});

test('M-v (scroll-down) moves point UP by ~one screenful', () => {
  const { spine } = makeSpine(linesBuffer(100));
  spine.setViewport(0, 40); // step = 38
  spine.buffer.moveTo(spine.buffer.offsetAt(76, 0));
  spine.handleKey('M-v');
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 38);
  spine.handleKey('M-v');
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 0);
});

test('screenful scroll clamps at the buffer ends (no overshoot)', () => {
  const { spine } = makeSpine(linesBuffer(20));
  spine.setViewport(0, 40); // step 38 > buffer → clamps
  spine.buffer.moveTo(0);
  spine.handleKey('C-v');
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 19); // last line
  spine.handleKey('M-v');
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 0); // first line
});

test('screenful scroll without a VIEWPORT report falls back to a one-line step', () => {
  const { spine } = makeSpine(linesBuffer(10));
  // No setViewport → unmeasured → page-lines is the 1-line fallback.
  spine.buffer.moveTo(0);
  spine.handleKey('C-v');
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 1);
});

test('find-file: visitFile ADDS a buffer and switches the active client to it', () => {
  const files = { '/tmp/x.js': { text: 'const x = 1;\n', name: 'x.js' } };
  const { spine } = makeSpine('scratch', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  assert.equal(spine.bufferCount, 1);
  const id = spine.visitFile('/tmp/x.js');
  // Multi-buffer: find-file no longer replaces — it adds a 2nd buffer and
  // switches the active client onto it (returns the new buffer's id).
  assert.equal(typeof id, 'string');
  assert.equal(spine.bufferCount, 2);
  assert.equal(spine.buffer.text, 'const x = 1;\n');
  assert.equal(spine.buffer.name, 'x.js');
  assert.equal(spine.buffer.point, 0);
  // The original scratch buffer is still in the registry, switchable back.
  assert.ok(spine.bufferIdByName('scratch.txt'));
});

test('find-file on a missing file reports and keeps the current buffer', () => {
  const { spine, log } = makeSpine('keep me', 'scratch.txt', {
    openFile: () => null,
  });
  const id = spine.visitFile('/nope');
  assert.equal(id, null); // failure → no new buffer
  assert.equal(spine.bufferCount, 1);
  assert.equal(spine.buffer.text, 'keep me'); // unchanged
  assert.ok(log.status.some((s) => s.includes('cannot open')));
});

test('M-x flow: open the prompt, abort it, then host-run the chosen command', () => {
  // execute-extended-command opens the "M-x " prompt. The host (server)
  // recognises that prompt, aborts the placeholder command, then runs the
  // chosen command itself — here, end-of-buffer.
  const { spine } = makeSpine('abcdef');
  spine.handleKey('M-x');
  assert.equal(spine.activePrompt, 'M-x ');
  spine.abortMinibuffer();
  assert.equal(spine.activePrompt, null);
  spine.runCommand('end-of-buffer');
  assert.equal(spine.buffer.point, 6);
});

test('abortMinibuffer drops the continuation so a later deliver is inert', () => {
  const { spine } = makeSpine('one\ntwo\nthree');
  const before = spine.buffer.point;
  spine.runCommand('goto-line'); // opens "Goto line: "
  spine.abortMinibuffer();
  spine.deliverMinibuffer('3'); // should NOT resume goto-line
  assert.equal(spine.buffer.point, before);
});

test('activePrompt tracks the current prompt and clears on submit', () => {
  const { spine } = makeSpine('a\nb\nc');
  assert.equal(spine.activePrompt, null);
  spine.runCommand('goto-line');
  assert.equal(spine.activePrompt, 'Goto line: ');
  spine.deliverMinibuffer('2');
  assert.equal(spine.activePrompt, null);
});

// --- multi-client: shared buffer, per-client cursor (the Model-B payoff) -

test('two clients share the buffer text but keep separate cursors', () => {
  const { spine } = makeSpine('hello world');
  const c1 = spine.addClientView(); // client 1 (client 0 is the default)
  assert.equal(spine.clientCount, 2);

  // Client 0 moves to offset 0 and types.
  spine.setActiveClient(0);
  spine.buffer.moveTo(0);
  spine.handleKey('X');
  assert.equal(spine.buffer.text, 'Xhello world');

  // Client 1's cursor is independent — it was at 0, and an insert before it
  // by client 0 shifts it (marker semantics), but its identity is its own.
  spine.setActiveClient(c1);
  const c1State = spine.viewStateOf(c1);
  const c0State = spine.viewStateOf(0);
  // Both see the SAME shared text.
  assert.equal(c1State.name, c0State.name);
  assert.equal(spine.buffer.text, 'Xhello world');
  // The cursors are distinct objects: client 0's point advanced past 'X'.
  assert.equal(c0State.point, 1);
});

test('an edit in one client is visible to the other (one buffer, N views)', () => {
  const { spine } = makeSpine('abc');
  spine.addClientView();

  spine.setActiveClient(0);
  spine.buffer.moveTo(3);
  for (const ch of 'DEF') spine.handleKey(ch);

  // Client 1 reads the same shared buffer — it sees client 0's edit.
  spine.setActiveClient(1);
  assert.equal(spine.viewStateOf(1).name, 'scratch.txt');
  assert.equal(spine.buffer.text, 'abcDEF');
});

// --- multi-client: detach (G4 — a window closes) -----------------------

test('removeClientView drops a client and never reuses its index', () => {
  const { spine } = makeSpine('hi');
  const c1 = spine.addClientView(); // 1
  const c2 = spine.addClientView(); // 2
  assert.equal(spine.clientCount, 3);
  assert.equal(c1, 1);
  assert.equal(c2, 2);

  // Detach the MIDDLE client. The count drops and its pane model is gone.
  spine.removeClientView(c1);
  assert.equal(spine.clientCount, 2);
  assert.equal(spine.paneModelOf(c1), null);

  // The next client gets a FRESH index (3) — NOT the freed 1, which a
  // size-based allocator would have re-minted as the still-live 2's neighbour.
  const c3 = spine.addClientView();
  assert.equal(c3, 3);
  assert.notEqual(c3, c1);
  assert.equal(spine.clientCount, 3);
});

test('removing the active (or bootstrap) client leaves the spine usable', () => {
  const { spine } = makeSpine('seed');
  const c1 = spine.addClientView();

  // Make the bootstrap client active, then detach IT. The active index must
  // fall back to a survivor and the spine must still serve the other client.
  spine.setActiveClient(0);
  spine.removeClientView(0);
  assert.equal(spine.clientCount, 1);
  assert.equal(spine.paneModelOf(0), null);

  // The surviving client still edits the shared buffer.
  spine.setActiveClient(c1);
  spine.buffer.moveTo(spine.buffer.text.length);
  spine.handleKey('!');
  assert.equal(spine.buffer.text, 'seed!');
});

test('C-x 5 2 resolves to new-window and raises the onNewWindow effect', () => {
  const { spine, log } = makeSpine('hello');

  spine.handleKey('C-x'); // the C-x prefix
  spine.handleKey('5');   // C-x 5 — a sub-prefix (no effect yet)
  assert.equal(log.newWindows, 0, 'no window opens mid-chord');
  spine.handleKey('2');   // C-x 5 2 — new-window
  assert.equal(log.newWindows, 1, 'the new-window command fired the effect');

  // The chord did not disturb the buffer text (it is window lifecycle).
  assert.equal(spine.buffer.text, 'hello');

  // C-x 2 (split) is still reachable at the C-x level — the 5 sub-map does
  // not shadow it. (Drive it and assert it did NOT open a window.)
  spine.handleKey('C-x');
  spine.handleKey('2');
  assert.equal(log.newWindows, 1, 'C-x 2 is split-vertical, not new-window');
});

test('a fresh window opens on its own private *scratch* (hidden from window 1)', () => {
  const { spine } = makeSpine('the session file', 'session.txt');
  const before = spine.bufferCount;

  // A fresh window (G4 Step 1): its own empty *scratch*, NOT the shared buffer.
  const c1 = spine.addClientView({ freshScratch: true });
  assert.equal(spine.bufferCount, before + 1, 'a new scratch buffer was created');
  assert.equal(spine.viewStateOf(c1).name, '*scratch*', 'the fresh window is on it');

  // The scratch is PRIVATE: window 1's tab list excludes it; the fresh window's
  // includes it. (The deny-list hides only FOREIGN scratches.)
  const w0 = spine.bufferListRecords(0).map((r) => r.name);
  const wFresh = spine.bufferListRecords(c1).map((r) => r.name);
  assert.ok(!w0.includes('*scratch*'), 'window 1 does NOT see the fresh scratch');
  assert.ok(w0.includes('session.txt'), 'window 1 still sees its own buffers');
  assert.ok(wFresh.includes('*scratch*'), 'the fresh window sees its own scratch');

  // Detaching the fresh window reaps its (still-empty) scratch from the pool.
  spine.removeClientView(c1);
  assert.equal(spine.bufferCount, before, 'the empty scratch is reaped on detach');
});

test('each client moves its own point without disturbing the other', () => {
  const { spine } = makeSpine('one\ntwo\nthree');
  spine.addClientView();

  spine.setActiveClient(0);
  spine.buffer.moveTo(0);
  spine.handleKey('down'); // client 0 → line 1

  spine.setActiveClient(1);
  spine.buffer.moveTo(0); // client 1 stays on line 0

  assert.equal(spine.buffer.positionAt(spine.viewStateOf(0).point).line, 1);
  assert.equal(spine.buffer.positionAt(spine.viewStateOf(1).point).line, 0);
});

test('viewState reports point, mark, name, modeline and modified flag', () => {
  const { spine } = makeSpine('hi', 'note.txt');
  let vs = spine.viewState();
  assert.equal(vs.point, 0);
  assert.equal(vs.mark, null);
  assert.equal(vs.name, 'note.txt');
  assert.equal(vs.modified, false);
  assert.match(vs.modeline, /^–\s+note\.txt/);
  spine.handleKey('x'); // edit → modified
  vs = spine.viewState();
  assert.equal(vs.modified, true);
  assert.match(vs.modeline, /^●/);
});

// --- multi-buffer: the registry, switching, kill-buffer ----------------

test('the server starts with one buffer; find-file adds a second', () => {
  const files = { '/a/b.md': { text: '# heading\n', name: 'b.md' } };
  const { spine } = makeSpine('seed', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  assert.equal(spine.bufferCount, 1);
  const id = spine.visitFile('/a/b.md');
  assert.equal(spine.bufferCount, 2);
  // The active client is now on the new buffer; the old one is still held.
  assert.equal(spine.currentBufferIdOf(0), id);
  assert.equal(spine.buffer.name, 'b.md');
  assert.ok(spine.bufferIdByName('scratch.txt'));
});

test('find-file of a MEDIA file creates a data-source leaf (no garbage text buffer)', () => {
  // The openFile effect returns a media descriptor for media suffixes (the real
  // server's readFileForVisit does this via media-kinds); a text file returns text.
  const files = {
    '/clip.mp4': { media: true, kind: 'video', name: 'clip.mp4', path: '/clip.mp4' },
    '/notes.md': { text: '# hi\n', name: 'notes.md', path: '/notes.md' },
  };
  const { spine } = makeSpine('seed', 'scratch.txt', { openFile: (p) => files[p] ?? null });

  const vid = spine.visitFile('/clip.mp4');
  assert.match(vid, /^ds\d+$/, 'a data-source id, not a buffer id');
  // No garbage text buffer was added (only the seed buffer exists).
  assert.equal(spine.bufferCount, 1, 'media did NOT add a text buffer');
  // The focused leaf shows the media source, and the PANE_TREE carries its
  // descriptor (viewKind + filePath), no text.
  const leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.equal(leaf.bufferId, vid);
  assert.equal(leaf.viewKind, 'video');
  assert.equal(leaf.filePath, '/clip.mp4');
  assert.equal(leaf.text, undefined, 'a media leaf carries no text');

  // Re-visiting the same media file REUSES the source (no duplicate).
  assert.equal(spine.visitFile('/clip.mp4'), vid, 'media find-file reuse');

  // The media source joins the window's buffer list (View List / C-x C-b /
  // session record) — with its kind + path, no line count, never modified.
  const rec = spine.bufferListRecords(0).find((r) => r.id === vid);
  assert.ok(rec, 'media is in the window buffer list');
  assert.equal(rec.viewKind, 'video');
  assert.equal(rec.filePath, '/clip.mp4');
  assert.equal(rec.modified, false);
  assert.equal(rec.current, true);

  // The modeline shows the media name + kind (not the fallback text buffer).
  const vs = spine.viewStateOf(0);
  assert.equal(vs.name, 'clip.mp4');
  assert.equal(vs.modified, false);
  assert.match(vs.modeline, /clip\.mp4/);
});

test('find-file of a DIRECTORY creates a directory-tree data-source leaf', () => {
  // The openFile effect marks a directory (the real server's readFileForVisit
  // statSyncs the path); a directory carries `directory:true` + a default kind.
  const files = {
    '/proj/src': { directory: true, kind: 'directory-tree', name: 'src', path: '/proj/src' },
    '/proj/readme.md': { text: '# hi\n', name: 'readme.md', path: '/proj/readme.md' },
  };
  const { spine } = makeSpine('seed', 'scratch.txt', { openFile: (p) => files[p] ?? null });

  const id = spine.visitFile('/proj/src');
  assert.match(id, /^ds\d+$/, 'a data-source id, not a buffer id');
  assert.equal(spine.bufferCount, 1, 'a directory did NOT add a text buffer');
  const leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.equal(leaf.bufferId, id);
  assert.equal(leaf.viewKind, 'directory-tree');
  assert.equal(leaf.filePath, '/proj/src');
  assert.equal(leaf.text, undefined, 'a directory leaf carries no text');
  // It joins the window buffer list (View List / session record) by path + kind.
  const rec = spine.bufferListRecords(0).find((r) => r.id === id);
  assert.ok(rec, 'directory is in the window buffer list');
  assert.equal(rec.viewKind, 'directory-tree');
  assert.equal(rec.filePath, '/proj/src');
});

test('visitDirectory opens an EXPLICIT kind and dedups by path+kind', () => {
  const files = {
    '/proj/src': { directory: true, kind: 'directory-tree', name: 'src', path: '/proj/src' },
    '/proj/f.txt': { text: 'x', name: 'f.txt', path: '/proj/f.txt' },
  };
  const { spine } = makeSpine('seed', 'scratch.txt', { openFile: (p) => files[p] ?? null });

  // The directory-columns command forces the columns kind regardless of the
  // host's default.
  const cols = spine.visitDirectory('/proj/src', 'directory-columns');
  assert.match(cols, /^ds\d+$/);
  assert.equal(wireLeaves(spine.paneSnapshot(0))[0].viewKind, 'directory-columns');

  // Same path + same kind REUSES; same path + a DIFFERENT kind mints a new one
  // (tree and columns are distinct views of the directory).
  assert.equal(spine.visitDirectory('/proj/src', 'directory-columns'), cols, 'reuse path+kind');
  const tree = spine.visitDirectory('/proj/src', 'directory-tree');
  assert.notEqual(tree, cols, 'a different kind mints a new source');

  // A NON-directory path is a no-op (null), not a crash.
  assert.equal(spine.visitDirectory('/proj/f.txt', 'directory-tree'), null);
});

test('openElementSource holds a renderer-computed element spec as a data-source', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  const spec = {
    name: 'Atari 2600', tag: 'stella-emulator', moduleUrl: 'app://x/stella.js',
    attrs: [['controls', true], ['src', 'app://x/oystron.bin']],
    fit: 'center', keyboard: 'grab', noFocus: false,
  };
  const id = spine.openElementSource(spec);
  assert.match(id, /^ds\d+$/, 'a data-source id, not a buffer id');
  assert.equal(spine.bufferCount, 1, 'an element-view did NOT add a text buffer');
  const leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.equal(leaf.bufferId, id);
  assert.equal(leaf.viewKind, 'element');
  assert.equal(leaf.name, 'Atari 2600');
  assert.equal(leaf.state.tag, 'stella-emulator');
  assert.deepEqual(leaf.state.attrs, [['controls', true], ['src', 'app://x/oystron.bin']]);
  assert.equal(leaf.text, undefined, 'an element leaf carries no text');
  // It joins the window buffer list (View List / session record).
  const rec = spine.bufferListRecords(0).find((r) => r.id === id);
  assert.ok(rec && rec.viewKind === 'element', 'element is in the window buffer list');
});

test('openJukebox holds a server-scanned listing as a data-source', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  const id = spine.openJukebox({ dir: '/music/album', tracks: ['01.mp3', '02.flac'], art: 'cover.jpg' });
  assert.match(id, /^ds\d+$/, 'a data-source id, not a buffer id');
  assert.equal(spine.bufferCount, 1, 'a jukebox did NOT add a text buffer');
  const leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.equal(leaf.bufferId, id);
  assert.equal(leaf.viewKind, 'jukebox');
  assert.equal(leaf.state.dir, '/music/album');
  assert.deepEqual(leaf.state.tracks, ['01.mp3', '02.flac']);
  assert.equal(leaf.state.art, 'cover.jpg');
  assert.equal(leaf.text, undefined, 'a jukebox leaf carries no text');
  // Reuse by directory; a tag-less / dir-less spec is a no-op.
  assert.equal(spine.openJukebox({ dir: '/music/album' }), id, 're-opening the same dir reveals it');
  assert.equal(spine.openJukebox({ tracks: [] }), null, 'a dir-less spec is a no-op');
  const rec = spine.bufferListRecords(0).find((r) => r.id === id);
  assert.ok(rec && rec.viewKind === 'jukebox', 'jukebox is in the window buffer list');
});

test('openElementSource with noFocus opens BESIDE the document, keeping focus', () => {
  const { spine } = makeSpine('document text', 'paper.tex');
  const docId = spine.currentBufferIdOf(0);
  const id = spine.openElementSource({
    name: 'Bibliography', tag: 'bib-search', moduleUrl: 'u',
    attrs: [['src', 'app://x/sample.bib']], noFocus: true,
  });
  const snap = spine.paneSnapshot(0);
  const leaves = wireLeaves(snap);
  assert.equal(leaves.length, 2, 'a no-focus panel splits beside the doc (2 leaves)');
  const panel = leaves.find((l) => l.viewKind === 'element');
  const doc = leaves.find((l) => l.bufferId === docId);
  assert.ok(panel && panel.state.noFocus, 'the panel leaf carries the element + noFocus');
  assert.ok(doc, 'the document leaf is still present');
  // Focus stays on the DOCUMENT (the panel is a helper acting on it).
  assert.equal(wireFocusedLeafId(snap), doc.id, 'focus stays on the document');
  assert.equal(spine.currentBufferIdOf(0), docId, 'the active buffer stays the document');
  // Re-running while open does NOT split again.
  spine.openElementSource({ name: 'Bibliography', tag: 'bib-search', moduleUrl: 'u', noFocus: true });
  assert.equal(wireLeaves(spine.paneSnapshot(0)).length, 2, 'no duplicate split on re-run');
});

test('openElementSource reuses by tag and rejects a tag-less spec', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  const atari = spine.openElementSource({ name: 'Atari', tag: 'stella-emulator', moduleUrl: 'u' });
  assert.equal(
    spine.openElementSource({ name: 'Atari', tag: 'stella-emulator', moduleUrl: 'u' }),
    atari,
    're-running the same tag reveals the existing source (no duplicate)',
  );
  const bib = spine.openElementSource({ name: 'Bib', tag: 'bib-search', moduleUrl: 'u', noFocus: true });
  assert.notEqual(bib, atari, 'a different tag mints a new source');
  assert.equal(spine.openElementSource({ name: 'x' }), null, 'a tag-less spec is a no-op');
});

test('find-file of an already-open file REUSES its buffer (no name<2>; shared across windows)', () => {
  const files = { '/a/b.md': { text: '# heading\n', name: 'b.md' } };
  const { spine } = makeSpine('seed', 'scratch.txt', { openFile: (p) => files[p] ?? null });

  // Window 0 opens the file.
  const firstId = spine.visitFile('/a/b.md');
  assert.equal(spine.bufferCount, 2);

  // A SECOND window (on its own scratch) visits the SAME path → reuses the
  // existing buffer rather than adding a `b.md<2>` duplicate. The clean name
  // matters: the client keys syntax highlighting off the extension, so a
  // `<2>` suffix would silently disable it.
  spine.addClientView({ freshScratch: true }); // client 1, on its own *scratch*
  spine.setActiveClient(1);
  const before = spine.bufferCount;
  const secondId = spine.visitFile('/a/b.md');
  assert.equal(secondId, firstId, 'the same buffer is SHARED, not duplicated');
  assert.equal(spine.bufferCount, before, 'no duplicate buffer was added');
  assert.equal(spine.currentBufferIdOf(1), firstId, 'the second window shows the shared buffer');
});

test('switch-to-buffer moves the active client between buffers, keeping cursor', () => {
  const files = { '/x.js': { text: 'const x = 1;\n', name: 'x.js' } };
  const { spine } = makeSpine('alpha beta', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  const seedId = spine.currentBufferIdOf(0);
  spine.buffer.moveTo(5); // a cursor in the seed buffer
  const xId = spine.visitFile('/x.js'); // switches to x.js
  assert.equal(spine.buffer.name, 'x.js');
  // Switch back to the seed buffer by id → its content + cursor return.
  assert.equal(spine.switchClientToBuffer(0, seedId), true);
  assert.equal(spine.buffer.text, 'alpha beta');
  assert.equal(spine.buffer.point, 5); // the seed cursor was preserved
  // …and forward to x.js again.
  assert.equal(spine.switchClientToBuffer(0, xId), true);
  assert.equal(spine.buffer.text, 'const x = 1;\n');
});

test('bufferListRecords is per-window: a window shows only its OWN buffers', () => {
  const files = { '/x.js': { text: 'x', name: 'x.js' } };
  const { spine } = makeSpine('seed', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  spine.addClientView(); // client 1, on the seed buffer
  const xId = spine.visitFile('/x.js'); // active client (0) opens + switches to x.js
  const recs0 = spine.bufferListRecords(0);
  const recs1 = spine.bufferListRecords(1);
  // Client 0 OPENED x.js → its list has both, with x.js current.
  assert.equal(recs0.length, 2);
  assert.equal(recs0.find((r) => r.id === xId).current, true);
  // Client 1 never opened x.js → it is NOT in client 1's tabline (G4 per-window
  // subset: opening a file in one window doesn't leak into another's tabs).
  assert.equal(recs1.find((r) => r.id === xId), undefined);
  assert.equal(recs1.length, 1);
  assert.ok(recs1.find((r) => r.name === 'scratch.txt').current);
});

// --- the generic PICKER channel (G0b) ---------------------------------
//
// The buffer-list picker is the FIRST consumer of the reusable channel. These
// cases drive the SAME suspend/resume the minibuffer round-trip uses: a
// command opens a picker (the spine suspends in picker-read), the host sees a
// PICKER request, a simulated choice resumes the command, and the window's
// buffer switches. A cancel resumes with nil and leaves the window put. The
// channel itself is provider-agnostic — these prove it on buffers, and the
// stale-id guard proves the round-trip is robust to a superseded picker.

test('list-buffers opens a generic PICKER over the open buffers', () => {
  const files = { '/x.js': { text: 'const x = 1;\n', name: 'x.js' } };
  const { spine, log } = makeSpine('alpha', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  spine.visitFile('/x.js'); // now two buffers; active client on x.js
  spine.runCommand('list-buffers');
  // The command suspended on a PICKER (not the minibuffer): one open request.
  assert.equal(log.pickerOpens.length, 1);
  assert.equal(log.minibufferOpens.length, 0);
  const req = log.pickerOpens[0];
  assert.equal(req.title, 'Buffer list');
  assert.ok(typeof req.id === 'string' && req.id.startsWith('picker-'));
  // The rows are the open buffers, value = id, current marks the active one.
  const labels = req.rows.map((r) => r.label).sort();
  assert.deepEqual(labels, ['scratch.txt', 'x.js']);
  assert.ok(req.rows.every((r) => typeof r.value === 'string'));
  const cur = req.rows.find((r) => r.current);
  assert.equal(cur.label, 'x.js'); // the active client is on x.js
  // The spine exposes the open request to the server for reply-matching.
  assert.equal(spine.activePicker.id, req.id);
});

test('PICKER round-trip: choosing a buffer row switches the window to it', () => {
  const files = { '/x.js': { text: 'XBODY\n', name: 'x.js' } };
  const { spine, log } = makeSpine('SEED', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  const seedId = spine.currentBufferIdOf(0);
  spine.visitFile('/x.js'); // active client now on x.js
  assert.equal(spine.buffer.name, 'x.js');
  // Open the picker, then deliver a choice of the SEED buffer's id.
  spine.runCommand('list-buffers');
  const req = log.pickerOpens[0];
  const seedRow = req.rows.find((r) => r.value === seedId);
  assert.ok(seedRow, 'the seed buffer is a row');
  const applied = spine.deliverPicker(seedRow.value, req.id);
  assert.equal(applied, true);
  // The window switched to the chosen buffer.
  assert.equal(spine.buffer.name, 'scratch.txt');
  assert.equal(spine.buffer.text, 'SEED');
  // The picker is closed (a second delivery is a no-op).
  assert.equal(spine.activePicker, null);
  assert.equal(spine.deliverPicker(seedRow.value, req.id), false);
});

test('PICKER cancel resumes the command with nil and leaves the window put', () => {
  const files = { '/x.js': { text: 'XBODY\n', name: 'x.js' } };
  const { spine, log } = makeSpine('SEED', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  spine.visitFile('/x.js');
  assert.equal(spine.buffer.name, 'x.js');
  spine.runCommand('list-buffers');
  const req = log.pickerOpens[0];
  const cancelled = spine.cancelPicker(req.id);
  assert.equal(cancelled, true);
  // The window did NOT change buffer (the cond's else only fires on a choice).
  assert.equal(spine.buffer.name, 'x.js');
  assert.equal(spine.activePicker, null);
});

test('a stale PICKER reply (wrong id) is dropped, not resumed', () => {
  const files = { '/x.js': { text: 'XBODY\n', name: 'x.js' } };
  const { spine, log } = makeSpine('SEED', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  const seedId = spine.currentBufferIdOf(0);
  spine.visitFile('/x.js');
  spine.runCommand('list-buffers');
  const req = log.pickerOpens[0];
  // A reply tagged with a DIFFERENT (stale) picker id must be ignored.
  assert.equal(spine.deliverPicker(seedId, 'picker-999'), false);
  assert.equal(spine.buffer.name, 'x.js', 'stale reply did not switch');
  assert.equal(spine.activePicker.id, req.id, 'the real picker is still open');
  // The correctly-tagged reply still works.
  assert.equal(spine.deliverPicker(seedId, req.id), true);
  assert.equal(spine.buffer.name, 'scratch.txt');
});

test('C-x C-b dispatches the buffer-list picker through the real keymap', () => {
  const files = { '/x.js': { text: 'XBODY\n', name: 'x.js' } };
  const { spine, log } = makeSpine('SEED', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  spine.visitFile('/x.js');
  // The chord (not runCommand) — proving the binding resolves to the picker.
  spine.handleKey('C-x');
  spine.handleKey('C-b');
  assert.equal(log.pickerOpens.length, 1);
  assert.equal(log.pickerOpens[0].title, 'Buffer list');
});

test('two clients can view different buffers independently', () => {
  const files = { '/x.js': { text: 'XBUF', name: 'x.js' } };
  const { spine } = makeSpine('SEEDBUF', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  spine.addClientView(); // client 1
  // Client 0 visits x.js; client 1 stays on the seed.
  spine.setActiveClient(0);
  const xId = spine.visitFile('/x.js');
  // Each client's view-state reflects ITS OWN buffer.
  spine.setActiveClient(1);
  assert.equal(spine.viewStateOf(0).name, 'x.js');
  assert.equal(spine.viewStateOf(1).name, 'scratch.txt');
  // An edit by client 1 to the seed must NOT touch x.js.
  spine.buffer.moveTo(0);
  spine.handleKey('Z');
  assert.equal(spine.viewStateOf(1).name, 'scratch.txt');
  // x.js content is untouched by the seed edit. Make client 0 active so
  // spine.buffer reads ITS buffer (still x.js), then assert.
  spine.setActiveClient(0);
  assert.equal(spine.currentBufferIdOf(0), xId);
  assert.equal(spine.buffer.text, 'XBUF');
});

test('two clients on different buffers report different modeline modes', () => {
  const files = { '/note.md': { text: '# h\n', name: 'note.md' } };
  const { spine } = makeSpine('let a = 1;\n', 'code.js', {
    openFile: (p) => files[p] ?? null,
  });
  spine.addClientView(); // client 1, on code.js
  spine.setActiveClient(0);
  spine.visitFile('/note.md'); // client 0 → markdown
  // Client 0's modeline carries Markdown; client 1's carries the .js mode.
  assert.match(spine.viewStateOf(0).modeline, /Markdown/);
  assert.doesNotMatch(spine.viewStateOf(1).modeline, /Markdown/);
});

test('kill-buffer removes the active buffer and re-homes the client', () => {
  const files = { '/x.js': { text: 'x', name: 'x.js' } };
  const { spine } = makeSpine('seed', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  spine.visitFile('/x.js'); // now on x.js, 2 buffers
  assert.equal(spine.bufferCount, 2);
  spine.setActiveClient(0);
  spine.killActiveBuffer(); // kill x.js → switch to the survivor (seed)
  assert.equal(spine.bufferCount, 1);
  assert.equal(spine.buffer.name, 'scratch.txt');
});

test('kill-buffer refuses to kill the only buffer', () => {
  const { spine } = makeSpine('only', 'scratch.txt');
  spine.setActiveClient(0);
  spine.killActiveBuffer();
  assert.equal(spine.bufferCount, 1);
  assert.equal(spine.buffer.name, 'scratch.txt');
});

test('switching one client buffer leaves the other client put', () => {
  const files = { '/x.js': { text: 'x', name: 'x.js' } };
  const { spine } = makeSpine('seed', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  const c1 = spine.addClientView();
  const seedId = spine.currentBufferIdOf(c1);
  spine.setActiveClient(0);
  spine.visitFile('/x.js'); // only client 0 switches
  // Client 1 is undisturbed — still on the seed buffer.
  assert.equal(spine.currentBufferIdOf(c1), seedId);
  assert.equal(spine.currentBufferIdOf(0) !== seedId, true);
});

// --- the richer server-side stdlib slice (PRIMITIVE-SPLIT.md) -----------
//
// These prove that the model-heavy stdlib files loaded by the spine
// (kill.lisp, yank-pop.lisp, line-ops.lisp, modes.lisp, markdown.lisp,
// search.lisp, custom.lisp, indent.lisp) run real, server-side, through
// the real command machinery — kill/yank, line operations, a mode's
// bindings dispatching via the mode-keymap chain, and the stubbed/loaded
// search commands.

test('the model-heavy stdlib loaded: its commands are in the REAL registry', () => {
  const { spine } = makeSpine('');
  const names = spine.commandNames();
  for (const name of [
    'kill-region', 'copy-region', 'kill-line', 'yank', 'yank-pop',
    'kill-word', 'backward-kill-word', 'move-line-up', 'move-line-down',
    'duplicate-line', 'join-line', 'indent-region', 'outdent-region',
    'sort-lines', 'markdown-bold', 'markdown-heading-1', 'isearch-forward',
    'toggle-math-mode', 'customize',
  ]) {
    assert.ok(names.includes(name), `${name} registered server-side`);
  }
});

// --- kill ring / yank ---------------------------------------------------

test('copy-region + yank: M-w copies the region, C-y yanks it at point', () => {
  const { spine } = makeSpine('hello world');
  spine.buffer.moveTo(0);
  spine.handleKey('C-space'); // set mark
  for (let i = 0; i < 5; i += 1) spine.handleKey('right'); // select "hello"
  spine.handleKey('M-w'); // copy-region
  spine.buffer.moveTo(spine.buffer.text.length);
  spine.handleKey('C-y'); // yank
  assert.equal(spine.buffer.text, 'hello worldhello');
});

test('kill-region: C-w cuts the selection to the ring', () => {
  const { spine } = makeSpine('abcdef');
  spine.buffer.moveTo(0);
  spine.handleKey('C-space');
  for (let i = 0; i < 3; i += 1) spine.handleKey('right'); // select "abc"
  spine.handleKey('C-w'); // kill-region
  assert.equal(spine.buffer.text, 'def');
  // The cut text yanks back.
  spine.buffer.moveTo(spine.buffer.text.length);
  spine.handleKey('C-y');
  assert.equal(spine.buffer.text, 'defabc');
});

test('kill-line: C-k kills to end of line', () => {
  const { spine } = makeSpine('abc def\nxyz');
  spine.buffer.moveTo(0);
  spine.handleKey('C-k');
  assert.equal(spine.buffer.text, '\nxyz');
});

test('yank-pop: M-y after a yank cycles to the previous kill', () => {
  const { spine } = makeSpine('AAA BBB');
  // Copy AAA then BBB (BBB ends up most-recent on the ring).
  spine.buffer.moveTo(0);
  spine.handleKey('C-space');
  for (let i = 0; i < 3; i += 1) spine.handleKey('right');
  spine.handleKey('M-w'); // copy AAA
  spine.buffer.moveTo(4);
  spine.handleKey('C-space');
  for (let i = 0; i < 3; i += 1) spine.handleKey('right');
  spine.handleKey('M-w'); // copy BBB
  spine.buffer.moveTo(spine.buffer.text.length);
  spine.handleKey('C-y'); // yank BBB
  assert.equal(spine.buffer.text, 'AAA BBBBBB');
  spine.handleKey('M-y'); // yank-pop → AAA
  assert.equal(spine.buffer.text, 'AAA BBBAAA');
});

test('yank-pop is rejected when the previous command was not a yank', () => {
  // The *last-command* subtlety: typing must invalidate a pending yank.
  const { spine } = makeSpine('seed');
  spine.handleKey('z'); // self-insert → *last-command* = self-insert
  const before = spine.buffer.text;
  spine.handleKey('M-y'); // yank-pop after typing → no-op on the buffer
  assert.equal(spine.buffer.text, before);
});

// --- line operations ----------------------------------------------------

test('move-line-down: M-down swaps the line with the one below', () => {
  const { spine } = makeSpine('one\ntwo\nthree');
  spine.buffer.moveTo(0);
  spine.handleKey('M-down');
  assert.equal(spine.buffer.text, 'two\none\nthree');
});

test('duplicate-line: C-x C-d copies the current line below', () => {
  const { spine } = makeSpine('row');
  spine.buffer.moveTo(0);
  spine.handleKey('C-x');
  spine.handleKey('C-d');
  assert.equal(spine.buffer.text, 'row\nrow');
});

test('sort-lines: an interactive region command sorts the selected lines', () => {
  const { spine } = makeSpine('banana\napple\ncherry');
  spine.buffer.moveTo(0);
  spine.handleKey('C-space');
  spine.handleKey('M-greater'); // select to end of buffer
  spine.runCommand('sort-lines'); // interactive region → uses the selection
  assert.equal(spine.buffer.text, 'apple\nbanana\ncherry');
});

// --- a real major mode through the server (markdown.lisp) ---------------

test('a .md buffer gets markdown-mode server-side', () => {
  const { spine } = makeSpine('text', 'doc.md');
  assert.equal(spine.interpreter.call('major-mode-name'), 'Markdown');
});

test('Markdown C-c b dispatches markdown-bold via the mode-keymap chain', () => {
  const { spine } = makeSpine('word', 'doc.md');
  spine.buffer.moveTo(0);
  spine.handleKey('C-space');
  for (let i = 0; i < 4; i += 1) spine.handleKey('right'); // select "word"
  spine.handleKey('C-c'); // markdown prefix (a mode-chord)
  spine.handleKey('b'); // markdown-bold
  assert.equal(spine.buffer.text, '*word*');
});

test('Markdown C-c 1 makes the line a level-1 heading', () => {
  const { spine } = makeSpine('Title', 'doc.md');
  spine.buffer.moveTo(2);
  spine.handleKey('C-c');
  spine.handleKey('1');
  assert.equal(spine.buffer.text, '# Title');
});

test('a fundamental-mode buffer: C-c is the global multi-cursor prefix', () => {
  // In a plain .txt buffer C-c is the global prefix carrying C-c d / C-c D
  // (multi-cursor, like production's c-c-keymap). An UNBOUND chord key
  // (C-c z) must abort cleanly — it does NOT self-insert, matching Emacs:
  // a key after a live prefix that isn't bound is just unbound, not text.
  const { spine } = makeSpine('plain', 'note.txt');
  spine.buffer.moveTo(spine.buffer.text.length);
  spine.handleKey('C-c'); // global prefix
  spine.handleKey('z'); // unbound in the C-c map → chord aborts, no insert
  assert.equal(spine.buffer.text, 'plain');
  // And the abort is clean: the next bare key self-inserts normally.
  spine.handleKey('!');
  assert.equal(spine.buffer.text, 'plain!');
});

test('the math-symbol minor mode: C-c m on, ` then a key inserts a LaTeX symbol', () => {
  const { spine } = makeSpine('', 'doc.md');
  spine.handleKey('C-c');
  spine.handleKey('m'); // toggle-math-mode → math minor mode on
  spine.handleKey('`'); // math-insert-symbol reads the next key
  spine.handleKey('a'); // "a" → \alpha
  assert.equal(spine.buffer.text, '\\alpha');
});

test('the math-symbol minor mode: ` then an unmapped key inserts that key', () => {
  const { spine } = makeSpine('', 'doc.md');
  spine.handleKey('C-c');
  spine.handleKey('m');
  spine.handleKey('`');
  spine.handleKey('j'); // "j" is unmapped → literal j
  assert.equal(spine.buffer.text, 'j');
});

// --- search commands load + resolve (the loop is a documented stub) -----

test('isearch-forward resolves and surfaces a stub status (loop is host-side)', () => {
  const { spine, log } = makeSpine('find me', 'note.txt');
  spine.handleKey('C-s'); // isearch-forward
  assert.ok(
    log.status.some((s) => s.toLowerCase().includes('search')),
    `expected an I-search status, got ${JSON.stringify(log.status)}`
  );
  // The buffer is untouched — it's only the start of a (stubbed) search.
  assert.equal(spine.buffer.text, 'find me');
});

// --- customisation registry loaded server-side --------------------------

test('custom.lisp loaded: *tab-width* is a registered, readable setting', () => {
  const { spine } = makeSpine('');
  // The defcustom registered the setting AND defined the variable.
  assert.equal(
    spine.interpreter.evaluate("(custom-registered? '*tab-width*)"),
    true
  );
  assert.equal(Number(spine.interpreter.evaluate('*tab-width*')), 4);
});

// --- multi-cursor over the wire (multi-cursor.lisp, server-side) --------

test('multi-cursor.lisp loaded: add-cursor-next + select-all-matches exist', () => {
  const { spine } = makeSpine('foo', 'note.txt');
  const names = spine.commandNames();
  assert.ok(names.includes('add-cursor-next'), 'add-cursor-next bound');
  assert.ok(names.includes('select-all-matches'), 'select-all-matches bound');
});

test('C-c d selects the word at point, then adds a cursor at the next match', () => {
  const { spine } = makeSpine('foo bar foo baz foo', 'note.txt');
  spine.buffer.moveTo(0); // inside the first "foo"
  spine.handleKey('C-c');
  spine.handleKey('d'); // first press: select "foo" as the primary region
  assert.equal(spine.activeCursorCount(), 1);
  assert.deepEqual(spine.cursorsOf(0), [{ point: 3, mark: 0 }]);
  spine.handleKey('C-c');
  spine.handleKey('d'); // second press: add a cursor at the next "foo"
  assert.equal(spine.activeCursorCount(), 2);
  assert.deepEqual(spine.cursorsOf(0), [
    { point: 3, mark: 0 },
    { point: 11, mark: 8 },
  ]);
});

test('C-c D selects EVERY match at once (a cursor per occurrence)', () => {
  const { spine } = makeSpine('foo bar foo baz foo', 'note.txt');
  spine.buffer.moveTo(1);
  spine.handleKey('C-c');
  spine.handleKey('D'); // select-all-matches
  assert.equal(spine.activeCursorCount(), 3);
  assert.deepEqual(spine.cursorsOf(0).map((c) => c.point), [3, 11, 19]);
});

test('a multi-cursor self-insert edits at every caret (the real buffer path)', () => {
  const { spine } = makeSpine('foo bar foo baz foo', 'note.txt');
  spine.buffer.moveTo(1);
  spine.handleKey('C-c');
  spine.handleKey('D'); // 3 cursors, each selecting a "foo"
  // Type "X": each selected "foo" is replaced by "X" (multi-cursor insert).
  spine.handleKey('X');
  assert.equal(spine.buffer.text, 'X bar X baz X');
  assert.deepEqual(spine.cursorsOf(0).map((c) => c.point), [1, 7, 13]);
});

test('C-g (keyboard-quit) collapses the cursor set back to the primary', () => {
  const { spine } = makeSpine('foo bar foo foo', 'note.txt');
  spine.buffer.moveTo(1);
  spine.handleKey('C-c');
  spine.handleKey('D');
  assert.ok(spine.activeCursorCount() > 1, 'multi-cursor active');
  spine.handleKey('C-g'); // keyboard-quit (multi-cursor.lisp wraps it)
  assert.equal(spine.activeCursorCount(), 1);
});

test('cursorsOf falls back to a single-cursor list for a fresh buffer', () => {
  const { spine } = makeSpine('hello', 'note.txt');
  spine.buffer.moveTo(2);
  assert.deepEqual(spine.cursorsOf(0), [{ point: 2, mark: null }]);
});

// --- overlays over the wire (highlight-matches, server-side) ------------

test('highlight-matches overlays every occurrence of the word at point', () => {
  const { spine, log } = makeSpine('foo bar foo baz foo', 'note.txt');
  spine.buffer.moveTo(1); // inside the first "foo"
  spine.runCommand('highlight-matches');
  const ovs = spine.overlaySnapshot();
  assert.equal(ovs.length, 3);
  assert.deepEqual(ovs.map((o) => [o.start, o.end]), [[0, 3], [8, 11], [16, 19]]);
  assert.ok(ovs.every((o) => o.face === 'search-match' && o.kind === 'search'));
  assert.ok(
    log.status.some((s) => s.includes('Highlighted')),
    'a status reports the match count'
  );
});

test('highlight overlays ride edits (their endpoints are L2 markers)', () => {
  const { spine } = makeSpine('foo bar foo', 'note.txt');
  spine.buffer.moveTo(8); // inside the SECOND "foo"
  spine.runCommand('highlight-matches');
  // Insert text BEFORE the matches; the later overlay should shift right.
  spine.buffer.moveTo(0);
  spine.buffer.insert('AB');
  const ovs = spine.overlaySnapshot();
  // The second "foo" (was 8..11) rode +2 to 10..13.
  assert.ok(
    ovs.some((o) => o.start === 10 && o.end === 13),
    `expected an overlay at 10..13, got ${JSON.stringify(ovs)}`
  );
  assert.equal(spine.buffer.text, 'ABfoo bar foo');
});

test('unhighlight-all clears the search overlays', () => {
  const { spine } = makeSpine('foo foo foo', 'note.txt');
  spine.buffer.moveTo(1);
  spine.runCommand('highlight-matches');
  assert.ok(spine.overlaySnapshot().length > 0);
  spine.runCommand('unhighlight-all');
  assert.equal(spine.overlaySnapshot().length, 0);
});

test('overlays are per-buffer: a new find-file buffer shows none', () => {
  const file = { text: 'alpha beta gamma', name: 'other.txt' };
  const { spine } = makeSpine('foo foo', 'note.txt', {
    openFile: () => file,
  });
  spine.buffer.moveTo(1);
  spine.runCommand('highlight-matches');
  assert.ok(spine.overlaySnapshot().length > 0);
  const firstId = spine.currentBufferIdOf(0);
  spine.visitFile('other.txt'); // adds + switches to a new buffer
  assert.equal(spine.overlaySnapshot().length, 0); // new buffer has none
  assert.equal(spine.buffer.text, 'alpha beta gamma');
  // The original buffer KEEPS its overlays (per-buffer state): switching
  // back shows them again.
  spine.switchClientToBuffer(0, firstId);
  assert.ok(spine.overlaySnapshot().length > 0);
});

test('the onOverlays effect fires when overlays change', () => {
  let calls = 0;
  const spine = createSpine(
    { initialText: 'foo foo foo', name: 'note.txt' },
    { onOverlays: () => { calls += 1; } }
  );
  spine.buffer.moveTo(1);
  spine.runCommand('highlight-matches'); // clear (no-op) + 3 adds → ≥1 fire
  assert.ok(calls >= 1, `expected onOverlays to fire, got ${calls}`);
  const after = calls;
  spine.runCommand('unhighlight-all'); // clears the 3 → 1 more fire
  assert.ok(calls > after, 'unhighlight fires onOverlays too');
});

// --- the M-s h / M-s u keymap entry points ------------------------------

test('M-s h runs highlight-matches; M-s u clears', () => {
  const { spine } = makeSpine('foo foo foo', 'note.txt');
  spine.buffer.moveTo(1);
  spine.handleKey('M-s');
  spine.handleKey('h'); // highlight-matches
  assert.equal(spine.overlaySnapshot().length, 3);
  spine.handleKey('M-s');
  spine.handleKey('u'); // unhighlight-all
  assert.equal(spine.overlaySnapshot().length, 0);
});

// --- save-buffer / write-file (real disk write, atomic) -----------------

test('save-buffer on a path-backed buffer writes via saveFile and clears dirty', () => {
  const files = { '/a/note.txt': { text: 'hello\n', name: 'note.txt', path: '/a/note.txt' } };
  const { spine, log } = makeSpine('seed', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  // Visit a file so the active buffer has a path.
  spine.visitFile('/a/note.txt');
  assert.equal(spine.activeFilePath, '/a/note.txt');
  assert.equal(spine.activeModified, false);
  // Edit it → dirty.
  spine.handleKey('x');
  assert.equal(spine.activeModified, true);
  // C-x C-s saves to the existing path (no prompt) and re-baselines.
  spine.handleKey('C-x');
  spine.handleKey('C-s');
  assert.equal(log.saves.length, 1);
  assert.equal(log.saves[0].path, '/a/note.txt');
  assert.equal(log.saves[0].text, spine.buffer.text);
  assert.equal(spine.activeModified, false); // dirty flag cleared
  assert.match(spine.viewState().modeline, /^–/); // ● gone after save
});

test('write-file binds a new path and re-baselines; save targets it', () => {
  const { spine, log } = makeSpine('content', 'scratch.txt');
  assert.equal(spine.activeFilePath, null); // path-less
  // write-file to a new path.
  assert.equal(spine.writeActiveBufferTo('/new/out.txt'), 'ok');
  assert.equal(log.saves[0].path, '/new/out.txt');
  assert.equal(spine.activeFilePath, '/new/out.txt'); // path bound
  assert.equal(spine.activeModified, false);
  // A subsequent edit + save now targets the bound path (no prompt).
  spine.handleKey('z');
  assert.equal(spine.saveActiveBuffer(), 'ok');
  assert.equal(log.saves[1].path, '/new/out.txt');
});

test('save-buffer on a path-less buffer returns no-path (write-file fallback)', () => {
  const { spine } = makeSpine('x', 'scratch.txt');
  // The JS surface: a path-less buffer cannot save directly.
  assert.equal(spine.saveActiveBuffer(), 'no-path');
});

test('save reports an error and stays dirty when the disk write fails', () => {
  const { spine } = makeSpine('x', 'scratch.txt', {
    saveFile: () => ({ ok: false, error: 'EACCES' }),
  });
  assert.equal(spine.writeActiveBufferTo('/no/perm.txt'), 'error');
  assert.equal(spine.activeFilePath, null); // path not bound on failure
});

test('an empty path is rejected without calling saveFile', () => {
  const { spine, log } = makeSpine('x', 'scratch.txt');
  assert.equal(spine.writeActiveBufferTo('   '), 'error');
  assert.equal(log.saves.length, 0);
});

test('visitFile records the resolved absolute path for save-back', () => {
  const files = { '/a/b.md': { text: '# h\n', name: 'b.md', path: '/abs/a/b.md' } };
  const { spine } = makeSpine('seed', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  spine.visitFile('/a/b.md');
  assert.equal(spine.activeFilePath, '/abs/a/b.md');
});

// --- recover-on-startup -------------------------------------------------

test('recoverBuffer loads a buffer that is dirty relative to its disk baseline', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  const before = spine.bufferCount;
  const id = spine.recoverBuffer({
    name: 'lost.txt',
    filePath: '/a/lost.txt',
    text: 'edited but never saved\n',
    diskBaseline: 'original on disk\n',
  });
  assert.equal(spine.bufferCount, before + 1);
  // The recovered buffer is in the registry, path-bound, and DIRTY (its text
  // differs from the on-disk baseline by exactly the lost edits).
  const rec = spine.bufferListRecords(0).find((r) => r.id === id);
  assert.ok(rec);
  assert.equal(rec.filePath, '/a/lost.txt');
  assert.equal(rec.modified, true);
});

test('a recovered buffer with no disk baseline is conservatively dirty', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  const id = spine.recoverBuffer({ name: 'nopath', filePath: null, text: 'work\n' });
  const rec = spine.bufferListRecords(0).find((r) => r.id === id);
  assert.equal(rec.modified, true);
});

// --- undo / redo through the server (the real editing.lisp undo/redo) ----

test('C-/ undoes the last edit through the real command (text + point)', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  spine.handleKey('M-greater'); // end of buffer
  for (const ch of 'XY') spine.handleKey(ch);
  assert.equal(spine.buffer.text, 'seedXY');
  spine.handleKey('C-slash'); // C-/ → undo
  assert.equal(spine.buffer.text, 'seedX');
  // Point is restored to the changed region (just past the surviving edit).
  assert.equal(spine.buffer.point, 5);
});

test('C-x u is also bound to undo', () => {
  const { spine } = makeSpine('ab', 'scratch.txt');
  spine.handleKey('M-greater');
  spine.handleKey('c');
  assert.equal(spine.buffer.text, 'abc');
  spine.handleKey('C-x');
  spine.handleKey('u');
  assert.equal(spine.buffer.text, 'ab');
});

test('redo (C-S-/) reapplies an undone edit', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  spine.handleKey('M-greater');
  spine.handleKey('Z');
  spine.handleKey('C-slash'); // undo → 'seed'
  assert.equal(spine.buffer.text, 'seed');
  spine.handleKey('C-S-slash'); // redo → 'seedZ'
  assert.equal(spine.buffer.text, 'seedZ');
  assert.equal(spine.buffer.point, 5);
});

test('undo/redo set the history-op flag (consumeHistoryOp) for the server resync', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  spine.handleKey('M-greater');
  spine.handleKey('Q');
  // An ordinary self-insert is NOT a history op.
  assert.equal(spine.consumeHistoryOp(), false);
  spine.handleKey('C-slash'); // undo
  assert.equal(spine.consumeHistoryOp(), true);
  assert.equal(spine.consumeHistoryOp(), false, 'the flag is read-and-cleared');
  spine.handleKey('C-S-slash'); // redo
  assert.equal(spine.consumeHistoryOp(), true);
});

test('the ● dirty flag agrees with undo against the saved baseline', () => {
  // Baseline = the seed text (a path-less buffer baselines its initial text).
  const { spine } = makeSpine('seed', 'scratch.txt');
  assert.equal(spine.activeModified, false, 'clean at the start');
  spine.handleKey('M-greater');
  for (const ch of 'AB') spine.handleKey(ch); // 'seedAB' → dirty
  assert.equal(spine.activeModified, true);
  assert.ok(spine.viewState().modeline.startsWith('●'), 'dirty shows ●');
  spine.handleKey('C-slash'); // → 'seedA' (still dirty)
  assert.equal(spine.activeModified, true);
  spine.handleKey('C-slash'); // → 'seed' (back to baseline → CLEAN)
  assert.equal(spine.buffer.text, 'seed');
  assert.equal(spine.activeModified, false, 'undo to baseline clears ●');
  assert.ok(spine.viewState().modeline.startsWith('–'), 'clean drops ●');
  spine.handleKey('C-S-slash'); // redo past the baseline → dirty again
  assert.equal(spine.buffer.text, 'seedA');
  assert.equal(spine.activeModified, true, 'redo past baseline re-sets ●');
});

test('the ● flag tracks undo against a SAVED baseline (re-baseline on save)', () => {
  // Save mid-stream re-baselines; undoing back to the SAVED text is clean,
  // undoing further (before the save) is dirty — the saved-baseline logic.
  const { spine, log } = makeSpine('', 'scratch.txt');
  for (const ch of 'one') spine.handleKey(ch);
  spine.writeActiveBufferTo('/tmp/mwb-undo-baseline-test'); // baseline = 'one'
  assert.equal(spine.activeModified, false);
  for (const ch of 'two') spine.handleKey(ch); // 'onetwo' → dirty
  assert.equal(spine.activeModified, true);
  // Undo the three 'two' chars back to the saved 'one' → clean.
  spine.handleKey('C-slash');
  spine.handleKey('C-slash');
  spine.handleKey('C-slash');
  assert.equal(spine.buffer.text, 'one');
  assert.equal(spine.activeModified, false, 'undo to the SAVED baseline is clean');
  // Undo once more (before the save) → dirty again (text ≠ saved 'one').
  spine.handleKey('C-slash');
  assert.equal(spine.buffer.text, 'on');
  assert.equal(spine.activeModified, true, 'undo BEFORE the save is dirty');
  assert.ok(log.saves.length >= 1);
});

test('undo at the bottom of the stack is a no-op (and clears the history flag)', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  // Nothing edited yet: undo does nothing, but the flag still toggles+clears.
  spine.handleKey('C-slash');
  assert.equal(spine.buffer.text, 'seed');
  assert.equal(spine.consumeHistoryOp(), true, 'the command ran (flag set)…');
  spine.handleKey('right'); // a non-history intent
  assert.equal(spine.consumeHistoryOp(), false, '…and does not leak forward');
});

// --- Part 2: more of the keymap bound server-side ----------------------
// Each test drives the KEY through handleKey (the real keymap path), proving
// the BINDING resolves AND the bound command runs through the spine — not just
// that the command exists.

test('C-o (open-line) inserts a newline after point, leaving point before it', () => {
  const { spine } = makeSpine('abcd');
  spine.buffer.moveTo(2); // between "ab" and "cd"
  spine.handleKey('C-o');
  assert.equal(spine.buffer.text, 'ab\ncd', 'a line opened after point');
  assert.equal(spine.buffer.point, 2, 'point stayed before the new line');
});

test('C-t (transpose-chars) swaps the two characters before point', () => {
  const { spine } = makeSpine('ab');
  spine.buffer.moveTo(2);
  spine.handleKey('C-t');
  assert.equal(spine.buffer.text, 'ba');
});

test('M-m (back-to-indentation) moves to the first non-blank of the line', () => {
  const { spine } = makeSpine('    hello');
  spine.buffer.moveTo(9); // end of the line
  spine.handleKey('M-m');
  assert.equal(spine.buffer.point, 4, 'point at the first non-blank char');
});

test('M-a / M-e (backward/forward-sentence) move by sentence', () => {
  const { spine } = makeSpine('One. Two. Three.');
  spine.buffer.moveTo(0);
  spine.handleKey('M-e'); // forward to the end of the first sentence
  const afterFwd = spine.buffer.point;
  assert.ok(afterFwd > 0, 'forward-sentence advanced point');
  spine.handleKey('M-a'); // backward to the sentence start
  assert.ok(spine.buffer.point <= afterFwd, 'backward-sentence moved back');
});

test('M-k (kill-sentence) kills forward to the sentence end and rings it', () => {
  const { spine } = makeSpine('Hello there. Bye.');
  spine.buffer.moveTo(0);
  spine.handleKey('M-k');
  assert.ok(
    !spine.buffer.text.startsWith('Hello there.'),
    `the first sentence was killed, got ${JSON.stringify(spine.buffer.text)}`
  );
  // It went to the kill ring: C-y yanks it back.
  const afterKill = spine.buffer.text;
  spine.handleKey('C-y');
  assert.ok(spine.buffer.text.length > afterKill.length, 'the kill yanked back');
});

test('M-q (fill-paragraph) is bound and re-wraps without error', () => {
  // A long single-line paragraph; fill-paragraph! re-wraps to the fill column.
  const long = 'word '.repeat(40).trim();
  const { spine } = makeSpine(long);
  spine.buffer.moveTo(0);
  spine.handleKey('M-q');
  // It ran (the binding resolved): the text now contains a newline (wrapped)
  // and still holds all the words.
  assert.ok(spine.buffer.text.includes('\n'), 'the paragraph wrapped');
  assert.equal(
    spine.buffer.text.split(/\s+/).filter(Boolean).length, 40,
    'no words lost in the fill'
  );
});

test('M-g (goto-line) is bound: it opens the Goto-line prompt', () => {
  const { spine, log } = makeSpine('one\ntwo\nthree\nfour');
  spine.handleKey('M-g');
  assert.deepEqual(log.minibufferOpens, ['Goto line: ']);
  spine.deliverMinibuffer('3');
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 2, '1-based → line idx 2');
});

test('M-r (replace-string) is bound: it chains the two replace prompts', () => {
  const { spine, log } = makeSpine('a cat sat on a cat');
  spine.handleKey('M-r');
  assert.deepEqual(log.minibufferOpens, ['Replace: ']);
  spine.deliverMinibuffer('cat');
  spine.deliverMinibuffer('dog');
  assert.equal(spine.buffer.text, 'a dog sat on a dog');
});

test('C-= (expand-region) grows the selection from a word outward', () => {
  const { spine } = makeSpine('alpha beta gamma');
  spine.buffer.moveTo(7); // inside "beta"
  spine.handleKey('C-equal');
  assert.ok(spine.buffer.mark !== null, 'a region became active');
  const firstSpan = Math.abs(spine.buffer.point - spine.buffer.mark);
  assert.ok(firstSpan > 0, 'the word is selected');
  // A repeat grows it (the chain stays alive via *last-command*).
  spine.handleKey('C-equal');
  const secondSpan = Math.abs(spine.buffer.point - spine.buffer.mark);
  assert.ok(secondSpan >= firstSpan, 'a second press grows (or holds) the region');
});

test('C-x C-x (exchange-point-and-mark) swaps point and mark', () => {
  const { spine } = makeSpine('hello world');
  spine.buffer.moveTo(0);
  spine.handleKey('C-space'); // set mark at 0
  spine.handleKey('right');
  spine.handleKey('right'); // point at 2, mark at 0
  assert.equal(spine.buffer.point, 2);
  assert.equal(spine.buffer.mark, 0);
  spine.handleKey('C-x');
  spine.handleKey('C-x'); // exchange
  assert.equal(spine.buffer.point, 0, 'point moved to the old mark');
  assert.equal(spine.buffer.mark, 2, 'mark moved to the old point');
});

test('C-x h (mark-whole-buffer) selects the entire buffer', () => {
  const { spine } = makeSpine('abcde');
  spine.buffer.moveTo(0);
  spine.handleKey('C-x');
  spine.handleKey('h');
  // mark at 0, point at the end → the whole buffer is the region.
  assert.equal(spine.buffer.mark, 0);
  assert.equal(spine.buffer.point, 5);
});

test('C-x ; (comment-line) comments the current line with the mode prefix', () => {
  // A plain buffer's comment-prefix defaults to ";; " (modes.lisp). Toggling
  // again removes it — proving the binding + the command both run.
  const { spine } = makeSpine('code here');
  spine.buffer.moveTo(0);
  spine.handleKey('C-x');
  spine.handleKey(';');
  assert.ok(
    spine.buffer.text.startsWith(';; '),
    `the line was commented, got ${JSON.stringify(spine.buffer.text)}`
  );
  spine.handleKey('C-x');
  spine.handleKey(';');
  assert.equal(spine.buffer.text, 'code here', 'a second toggle uncomments');
});

// --- session persistence: serializeWindow / loadWindowLayout (spine glue) ---

test('serializeWindow/loadWindowLayout round-trips a window layout by path', () => {
  const files = {
    '/tmp/a.js': { text: 'const a = 1;\n', name: 'a.js' },
    '/tmp/b.js': { text: 'const b = 2;\n', name: 'b.js' },
  };
  const { spine } = makeSpine('scratch', 'scratch.txt', { openFile: (p) => files[p] ?? null });
  const idA = spine.visitFile('/tmp/a.js');
  const idB = spine.visitFile('/tmp/b.js');
  assert.ok(idA && idB);

  // Build  /a.js | /b.js  — a horizontal split, the right (focused) leaf on /b.js.
  spine.switchClientToBuffer(0, idA); // the single leaf shows /a.js
  const model = spine.paneModelOf(0);
  model.split('horizontal', 0.4, 'after'); // new leaf (focus), still /a.js
  spine.switchClientToBuffer(0, idB); // focused (new) leaf → /b.js

  const blob1 = spine.serializeWindow(0);
  // The blob is keyed by file PATH (not buffer id) + marks the focused leaf.
  assert.equal(blob1.kind, 'split');
  assert.equal(blob1.orientation, 'horizontal');
  assert.ok(Math.abs(blob1.ratio - 0.4) < 1e-9);
  assert.equal(blob1.first.view.path, '/tmp/a.js');
  assert.equal(blob1.second.view.path, '/tmp/b.js');
  assert.equal(blob1.second.focused, true, 'the /b.js leaf is focused');

  // Restore it back into the same window (the files are still open) → serialise
  // again → identical blob (no leaf ids leak; the round-trip is stable).
  assert.equal(spine.loadWindowLayout(0, blob1), true);
  const blob2 = spine.serializeWindow(0);
  assert.deepEqual(blob2, blob1, 'serialize ∘ load ∘ serialize is a fixed point');

  // And the LIVE model was rebuilt: two leaves on the right buffers, focus on b.
  const snap = spine.paneSnapshot(0);
  const leaves = wireLeaves(snap);
  assert.equal(leaves.length, 2);
  assert.equal(leaves[0].bufferId, idA);
  assert.equal(leaves[1].bufferId, idB);
  assert.equal(wireFocusedLeafId(snap), leaves[1].id, 'focus restored to /b.js');
});

test('loadWindowLayout resets the window open-set to exactly its restored buffers', () => {
  // A multi-window restore opens EVERY window's files up front; a window must
  // still show only ITS own restored buffers (not the whole session's files).
  const files = {
    '/tmp/a.js': { text: 'a', name: 'a.js' },
    '/tmp/b.js': { text: 'b', name: 'b.js' },
    '/tmp/c.js': { text: 'c', name: 'c.js' },
  };
  const { spine } = makeSpine('scratch', 'scratch.txt', { openFile: (p) => files[p] ?? null });
  const idA = spine.visitFile('/tmp/a.js');
  spine.visitFile('/tmp/b.js');
  spine.visitFile('/tmp/c.js'); // all three open + in window 0's open-set
  // Restore a layout that shows ONLY /a.js.
  spine.switchClientToBuffer(0, idA);
  const blob = spine.serializeWindow(0);
  assert.equal(spine.loadWindowLayout(0, blob), true);
  const shownPaths = spine.bufferListRecords(0).map((r) => r.filePath).filter(Boolean);
  assert.deepEqual(shownPaths, ['/tmp/a.js'], 'only the restored buffer remains in the open-set');
});
