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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSpine } from './spine.js';
import { wireLeaves, wireFocusedLeafId } from './protocol.js';

/** A spine with recording effects, for assertions. */
function makeSpine(initialText = '', name = 'scratch.txt', extra = {}) {
  const log = {
    status: [], minibufferOpens: [], minibufferCloses: 0, scrolls: [], saves: [],
    // The initial-value seed for each minibuffer open (find-file / find-project
    // start at a sensible directory), parallel to minibufferOpens.
    minibufferSeeds: [],
    // Each open generic-picker request (the G0b channel), as the server sees it.
    pickerOpens: [],
    // Each new-window request (the C-x 5 2 effect, G4).
    newWindows: 0,
    // Each open-project-window request (B4 project): the parked { root } config.
    projectWindows: [],
    // Each close-project request (B4): { root, files, active, windowId }.
    projectCloses: [],
    // Each client directive raised (the multi-window round-trip): { ids, name, args }.
    directives: [],
  };
  const spine = createSpine(
    { initialText, name, initialPath: extra.initialPath },
    {
      onStatus: (s) => log.status.push(s),
      onMinibufferOpen: (p, initial) => { log.minibufferOpens.push(p); log.minibufferSeeds.push(initial ?? ''); },
      onMinibufferClose: () => { log.minibufferCloses += 1; },
      onScroll: (r) => log.scrolls.push(r),
      onPicker: (req) => log.pickerOpens.push(req),
      onNewWindow: () => { log.newWindows += 1; },
      onOpenProjectWindow: (cfg) => log.projectWindows.push(cfg),
      onCloseProject: (c) => log.projectCloses.push(c),
      onClientDirective: (ids, name, args) => log.directives.push({ ids, name, args }),
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
  spine.handleKey('M-S-period');
  assert.equal(spine.buffer.point, 6);
  spine.handleKey('M-S-comma');
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
  assert.ok(names.includes('execute-command'), 'M-x registered');
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
  // execute-command opens the "M-x " prompt. The host (server)
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

// --- client directives: the multi-window round-trip (P2) ----------------

test('emit-client-directive! to all-window-ids targets every window', () => {
  const { spine, log } = makeSpine('x');
  const idx2 = spine.addClientView(); // a 2nd window
  spine.setActiveClient(0);
  spine.interpreter.evaluate("(emit-client-directive! (all-window-ids) 'close-window)");
  assert.equal(log.directives.length, 1);
  assert.deepEqual([...log.directives[0].ids].sort(), [0, idx2].sort());
  assert.equal(log.directives[0].name, 'close-window');
  assert.deepEqual(log.directives[0].args, []);
});

test('emit-client-directive! to other-window-ids targets every window but the active one', () => {
  const { spine, log } = makeSpine('x');
  const idx2 = spine.addClientView();
  spine.setActiveClient(idx2);
  spine.interpreter.evaluate("(emit-client-directive! (other-window-ids) 'close-window)");
  assert.deepEqual(log.directives[0].ids, [0]);
  assert.equal(log.directives[0].name, 'close-window');
});

test('emit-client-directive! to (this-window-id) targets only the active window, with args', () => {
  const { spine, log } = makeSpine('x');
  spine.addClientView();
  spine.setActiveClient(0);
  spine.interpreter.evaluate(
    "(emit-client-directive! (list (this-window-id)) 'reload-theme \"nova\")"
  );
  assert.deepEqual(log.directives[0].ids, [0]);
  assert.equal(log.directives[0].name, 'reload-theme');
  assert.deepEqual(log.directives[0].args, ['nova']);
});

test('C-x 5 0 close-window directs a close to this window only', () => {
  const { spine, log } = makeSpine('x');
  const idx2 = spine.addClientView();
  spine.setActiveClient(idx2);
  spine.handleKey('C-x');
  spine.handleKey('5');
  spine.handleKey('0');
  assert.equal(log.directives.length, 1);
  assert.deepEqual(log.directives[0].ids, [idx2]);
  assert.equal(log.directives[0].name, 'close-window');
});

test('C-x 5 1 close-other-windows directs a close to every other window', () => {
  const { spine, log } = makeSpine('x');
  spine.addClientView();        // idx 1
  const idx3 = spine.addClientView(); // idx 2
  spine.setActiveClient(1);
  spine.handleKey('C-x');
  spine.handleKey('5');
  spine.handleKey('1');
  assert.equal(log.directives.length, 1);
  assert.deepEqual([...log.directives[0].ids].sort(), [0, idx3].sort());
  assert.equal(log.directives[0].name, 'close-window');
});

// --- quit-editor: the cross-window save-some-buffers walk (P2c) ----------

test('quit-editor with nothing unsaved emits a quit directive straight away', () => {
  const { spine, log } = makeSpine('clean', 'scratch.txt');
  spine.runCommand('quit-editor');
  assert.deepEqual(log.directives, [{ ids: [0], name: 'quit', args: [] }]);
});

test('quit-editor on an unsaved path-less buffer goes to the net; y quits', () => {
  const { spine, log } = makeSpine('', 'scratch.txt');
  spine.handleKey('x'); // dirty the path-less buffer (can't be saved in the walk)
  spine.runCommand('quit-editor');
  assert.equal(log.directives.length, 0, 'no per-buffer prompt; the net is pending');
  spine.handleKey('y'); // quit anyway
  assert.deepEqual(log.directives, [{ ids: [0], name: 'quit', args: [] }]);
});

test('quit-editor saves a path-backed buffer on y, then quits', () => {
  const { spine, log } = makeSpine('seed', 'scratch.txt', {
    openFile: (path) => ({ text: 'disk', name: 'doc.txt', path }),
  });
  spine.visitFile('/tmp/doc.txt'); // a path-backed buffer, now active
  spine.handleKey('Z'); // dirty it
  spine.runCommand('quit-editor');
  assert.equal(log.directives.length, 0, 'prompting Save doc.txt?, not quit yet');
  spine.handleKey('y'); // save it
  assert.ok(log.saves.some((s) => s.path === '/tmp/doc.txt'), 'doc.txt was saved');
  assert.deepEqual(log.directives, [{ ids: [0], name: 'quit', args: [] }]);
});

test('quit-editor: n skips the save, the net fires, and n aborts the quit', () => {
  const { spine, log } = makeSpine('seed', 'scratch.txt', {
    openFile: (path) => ({ text: 'disk', name: 'doc.txt', path }),
  });
  spine.visitFile('/tmp/doc.txt');
  spine.handleKey('Z');
  spine.runCommand('quit-editor');
  spine.handleKey('n'); // skip saving doc.txt
  assert.equal(log.saves.length, 0, 'nothing saved');
  assert.equal(log.directives.length, 0, 'doc.txt still dirty → the net is pending');
  spine.handleKey('n'); // do NOT quit
  assert.equal(log.directives.length, 0, 'quit aborted');
});

test('quit-editor: C-g aborts cleanly so a fresh C-x C-c restarts the SAVE walk', () => {
  // Regression: an aborted quit used to strand a pending key-reader (the else
  // branch re-armed it), so the next C-x C-c was eaten by it and landed back in
  // the net instead of re-prompting the save walk.
  const { spine, log } = makeSpine('seed', 'scratch.txt', {
    openFile: (path) => ({ text: 'disk', name: 'doc.txt', path }),
  });
  spine.visitFile('/tmp/doc.txt');
  spine.handleKey('Z'); // dirty (path-backed) → the walk will prompt to save it
  spine.runCommand('quit-editor'); // "Save doc.txt?"
  spine.handleKey('q'); // stop saving → the net
  spine.handleKey('C-g'); // abort the net — must leave NO pending reader
  assert.equal(log.directives.length, 0, 'aborted: nothing quit');
  // A fresh quit via the keys must reach quit-editor (not a stale reader) and
  // restart the SAVE walk from the first buffer.
  spine.handleKey('C-x');
  spine.handleKey('C-c');
  const segs = spine.viewState().statusSegments;
  assert.ok(
    Array.isArray(segs) && segs[0].text === 'Save ',
    'a fresh quit restarts the save walk, not the net'
  );
});

test('quit-editor save prompt is styled (red text, bold filename)', () => {
  const { spine } = makeSpine('seed', 'scratch.txt', {
    openFile: (path) => ({ text: 'disk', name: 'doc.txt', path }),
  });
  spine.visitFile('/tmp/doc.txt');
  spine.handleKey('Z'); // dirty the path-backed buffer
  spine.runCommand('quit-editor'); // prompts "Save doc.txt?"
  const segs = spine.viewState().statusSegments;
  assert.ok(Array.isArray(segs) && segs.length === 3, 'styled 3-segment prompt');
  assert.equal(segs[0].text, 'Save ', 'frame ends with a space before the filename');
  assert.equal(segs[1].bold, true, 'the filename segment is bold');
  assert.ok(segs[1].color, 'the filename segment has a colour');
  assert.ok(
    segs[1].text.startsWith('"') && segs[1].text.endsWith('"'),
    'the filename is wrapped in double-quotes'
  );
  assert.ok(segs[2].text.includes('?'), 'the trailing prompt is present');
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

test('viewState carries the 1-based cursorLine (Markdown-preview forward search)', () => {
  const { spine } = makeSpine('line one\nline two\nline three', 'doc.md');
  assert.equal(spine.viewState().cursorLine, 1, 'point at start → line 1');
  assert.equal(spine.viewStateOf(0).cursorLine, 1, 'viewStateOf agrees');
  spine.buffer.moveTo(spine.buffer.offsetAt(2, 0)); // 0-based line 2 → 1-based line 3
  assert.equal(spine.viewState().cursorLine, 3);
  assert.equal(spine.viewStateOf(0).cursorLine, 3);
});

test('gotoLine is a quiet move (no scroll / no flash) and reports whether it moved', () => {
  const { spine, log } = makeSpine('aaa\nbbb\nccc\nddd', 'doc.md');
  assert.equal(spine.gotoLine(3), true, 'reports it moved');
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 2, '1-based 3 → 0-based line 2');
  assert.equal(spine.buffer.positionAt(spine.buffer.point).column, 0, 'lands at column 0');
  assert.equal(spine.gotoLine(999), true); // clamped to the last line
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 3);
  const before = spine.buffer.point;
  assert.equal(spine.gotoLine(0), false, 'non-positive → no move');
  assert.equal(spine.buffer.point, before);
  assert.ok(!log.scrolls.some((s) => s.kind === 'recenter'), 'gotoLine does not recenter');
  assert.ok(!log.directives.some((d) => d.name === 'flash-current-line'), 'gotoLine does not flash');
});

test('gotoLineReveal moves AND reveals: recenter scroll + flash-current-line directive', () => {
  const { spine, log } = makeSpine('aaa\nbbb\nccc\nddd', 'doc.md');
  spine.gotoLineReveal(3);
  assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 2, 'moved to the line');
  const recenter = log.scrolls.find((s) => s.kind === 'recenter');
  assert.ok(recenter, 'a recenter scroll was emitted');
  assert.equal(recenter.line, 2, 'recenter targets the landed (0-based) line');
  assert.ok(
    log.directives.some((d) => d.name === 'flash-current-line' && d.ids.includes(0)),
    'a flash-current-line directive went to the active window'
  );
  // A no-op reveals nothing.
  log.scrolls.length = 0; log.directives.length = 0;
  spine.gotoLineReveal(0);
  assert.equal(log.scrolls.length, 0);
  assert.equal(log.directives.length, 0);
});

// --- multi-buffer: the registry, switching, kill-view ----------------

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

test('close-tab KILLS the view by default; *close-tab-kills-view* #f un-curates', () => {
  const files = {
    '/a.md': { text: 'A\n', name: 'a.md', path: '/a.md' },
    '/b.md': { text: 'B\n', name: 'b.md', path: '/b.md' },
  };
  const { spine } = makeSpine('seed', 'scratch.txt', { openFile: (p) => files[p] ?? null });
  const aId = spine.visitFile('/a.md');
  const bId = spine.visitFile('/b.md');
  // Window 0's focused leaf is a tabline of [a, b], active = b.
  spine.seedClientTabline(0, [aId, bId], bId);
  assert.equal(spine.bufferCount, 3, 'scratch + a + b');

  // DEFAULT (#t): closing a's tab KILLS it — gone from the registry/buffer list.
  assert.ok(spine.applyPaneIntent(0, { op: 'close-tab', bufferId: aId }));
  assert.ok(
    !spine.bufferListRecords(0).some((r) => r.id === aId),
    'killed buffer is off the buffer list'
  );
  assert.equal(spine.bufferCount, 2, 'scratch + b remain');

  // OPT-OUT (#f): closing a tab only un-curates — the buffer survives the pool.
  spine.interpreter.evaluate('(set! *close-tab-kills-view* #f)');
  const scratchId = spine.bufferListRecords(0).find((r) => r.name === 'scratch.txt').id;
  spine.seedClientTabline(0, [scratchId, bId], bId);
  assert.ok(spine.applyPaneIntent(0, { op: 'close-tab', bufferId: bId }));
  assert.ok(
    spine.bufferListRecords(0).some((r) => r.id === bId),
    'un-curated buffer survives in the buffer list'
  );
  assert.equal(spine.bufferCount, 2, 'nothing killed under the opt-out');
});

test('closing the LAST tab collapses the tabline to a bare *scratch* leaf', () => {
  const files = { '/a.md': { text: 'A\n', name: 'a.md', path: '/a.md' } };
  const { spine } = makeSpine('seed', 'doc.txt', { openFile: (p) => files[p] ?? null });
  const aId = spine.visitFile('/a.md');
  spine.seedClientTabline(0, [aId], aId); // a tabline with a SINGLE tab
  assert.equal(wireLeaves(spine.paneSnapshot(0))[0].tabline, true, 'starts as a tabline');

  // Close the last tab → collapse to a bare *scratch* leaf; a is killed.
  assert.ok(spine.applyPaneIntent(0, { op: 'close-tab', bufferId: aId }));
  const leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.ok(!leaf.tabline, 'the tabline is gone (a bare leaf)');
  assert.equal(
    spine.bufferListRecords(0).find((r) => r.current).name, '*scratch*',
    'the bare leaf shows *scratch*'
  );
  assert.ok(!spine.bufferListRecords(0).some((r) => r.id === aId), 'the closed view was killed');
});

test('markdown-preview directive carries the active buffer SAVED path', () => {
  const { spine, log } = makeSpine('# hi\n', 'doc.md', { initialPath: '/docs/doc.md' });
  spine.runCommand('markdown-preview'); // the command body calls markdown-preview!
  const d = log.directives.find((x) => x.name === 'markdown-preview');
  assert.ok(d && d.ids.includes(0), 'a markdown-preview directive went to the active window');
  assert.deepEqual(d.args, ['/docs/doc.md'], 'the saved path travels as the sole directive arg');
});

test('markdown-preview sends an empty path for an unsaved buffer', () => {
  // No initialPath → a path-less buffer; the renderer then says "save first".
  const { spine, log } = makeSpine('# hi\n', 'doc.md');
  spine.runCommand('markdown-preview');
  const d = log.directives.find((x) => x.name === 'markdown-preview');
  assert.deepEqual(d.args, [''], 'an unsaved buffer sends an empty path');
});

test('markdown-preview on a NON-markdown buffer emits no directive (mode guarded server-side)', () => {
  // A .txt buffer is Fundamental mode, not Markdown — the server guards the
  // mode (the renderer can't see it reliably) and reports a status instead.
  const { spine, log } = makeSpine('plain text\n', 'notes.txt', { initialPath: '/notes.txt' });
  spine.runCommand('markdown-preview');
  assert.ok(
    !log.directives.some((x) => x.name === 'markdown-preview'),
    'no markdown-preview directive for a non-markdown buffer'
  );
  assert.ok(
    log.status.some((s) => /not in Markdown mode/i.test(s)),
    'a "not in Markdown mode" status was shown'
  );
});

test('markdown-preview-sync (C-c C-v) emits a directive with the 1-based cursor line', () => {
  const { spine, log } = makeSpine('# h\nline two\nline three\n', 'doc.md');
  spine.buffer.moveTo(spine.buffer.offsetAt(2, 0)); // 0-based line 2 → 1-based line 3
  spine.runCommand('markdown-preview-sync');
  const d = log.directives.find((x) => x.name === 'markdown-preview-sync');
  assert.ok(d && d.ids.includes(0), 'a markdown-preview-sync directive went to the active window');
  assert.deepEqual(d.args, [3], 'carries the 1-based cursor line');
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

test('M-x shell mints a server-owned shell data-source leaf (full Lisp path)', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  // The REAL chain: shell.lisp's (shell) defcommand → (open-shell-buffer!) host
  // primitive → openShell. Proves shell.lisp loaded in SPINE_STDLIB + resolves.
  spine.runCommand('shell');
  assert.equal(spine.bufferCount, 1, 'a shell did NOT add a text buffer');
  const leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.match(leaf.bufferId, /^ds\d+$/, 'a data-source id, not a buffer id');
  assert.equal(leaf.viewKind, 'shell');
  assert.equal(leaf.name, '*shell*');
  // sessionId is server-minted + tied to the (unique) source id, so the renderer
  // can key MAIN's pty IPC by it; the server itself never touches the process.
  assert.equal(leaf.state.sessionId, leaf.bufferId, 'sessionId is the source id');
  // A path-less active buffer → empty cwd (MAIN falls back to $HOME).
  assert.equal(leaf.state.cwd, '', 'no cwd for a path-less active buffer');
  assert.equal(leaf.text, undefined, 'a shell leaf carries no text');
  // It joins the window buffer list (View List / session record / C-x b).
  const rec = spine.bufferListRecords(0).find((r) => r.id === leaf.bufferId);
  assert.ok(rec && rec.viewKind === 'shell', 'the shell is in the window buffer list');
});

test('M-x shell resolves cwd to the active document directory (server-side)', () => {
  const files = { '/proj/src/main.js': { text: 'x', name: 'main.js' } };
  const { spine } = makeSpine('seed', 'scratch.txt', { openFile: (p) => files[p] ?? null });
  spine.visitFile('/proj/src/main.js');
  spine.runCommand('shell');
  const leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.equal(leaf.viewKind, 'shell');
  assert.equal(leaf.state.cwd, '/proj/src', 'shell opens in the active document directory');
});

test('each M-x shell mints a FRESH shell (no dedup), with distinct sessionIds', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  spine.runCommand('shell');
  const first = wireLeaves(spine.paneSnapshot(0))[0].bufferId;
  spine.runCommand('shell');
  const second = wireLeaves(spine.paneSnapshot(0))[0].bufferId;
  assert.notEqual(first, second, 'a second (shell) is a NEW source, not a reuse');
  const shells = spine.bufferListRecords(0).filter((r) => r.viewKind === 'shell');
  assert.equal(shells.length, 2, 'both shells are live in the buffer list (one pty each)');
  // The source id IS the sessionId, so distinct ids == distinct pty sessions.
  assert.equal(new Set(shells.map((r) => r.id)).size, 2, 'distinct sessionIds');
});

test('liveProcessSessionsOf lists open shells; kill-view reaps the focused one', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  spine.runCommand('shell');
  const shellId = wireLeaves(spine.paneSnapshot(0))[0].bufferId;
  // Fanned to the client per PANE_TREE so it knows which process sessions are live.
  assert.deepEqual(spine.liveProcessSessionsOf(0), [shellId], 'the open shell is in the live set');
  // C-x k on the focused shell removes the SOURCE (not just a registry buffer):
  // it leaves the open-set, so the client reaps its pty.
  spine.runCommand('kill-view');
  assert.deepEqual(spine.liveProcessSessionsOf(0), [], 'the killed shell left the live set');
  assert.equal(spine.isDataSource(shellId), false, 'the shell data-source is gone');
  // The focused leaf re-homed onto a surviving text buffer, not the dead source.
  assert.notEqual(wireLeaves(spine.paneSnapshot(0))[0].bufferId, shellId);
});

test('kill-view on a shell bypasses the "only buffer" guard (data-source path)', () => {
  // Even with a single TEXT buffer (scratch), killing a shell succeeds — the
  // registry-count guard only governs registry buffers, not data-sources.
  const { spine } = makeSpine('seed', 'scratch.txt');
  assert.equal(spine.bufferCount, 1, 'one text buffer (scratch)');
  spine.runCommand('shell');
  spine.runCommand('kill-view');
  assert.equal(spine.liveProcessSessionsOf(0).length, 0, 'the shell was reaped, not refused');
  assert.equal(spine.bufferCount, 1, 'the text buffer survived');
});

test('M-x gnuplot mints a server-owned gnuplot data-source leaf (full Lisp path)', () => {
  // The same shape as M-x shell: gnuplot.lisp (gnuplot) → (open-gnuplot-buffer!)
  // → openProcessView('gnuplot'). Proves gnuplot.lisp loaded in SPINE_STDLIB.
  const { spine } = makeSpine('seed', 'scratch.txt');
  spine.runCommand('gnuplot');
  assert.equal(spine.bufferCount, 1, 'a gnuplot did NOT add a text buffer');
  const leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.match(leaf.bufferId, /^ds\d+$/, 'a data-source id');
  assert.equal(leaf.viewKind, 'gnuplot');
  assert.equal(leaf.name, '*gnuplot*');
  assert.equal(leaf.state.sessionId, leaf.bufferId, 'sessionId is the source id');
  // Tracked as a live process, and reaped on kill-view.
  assert.deepEqual(spine.liveProcessSessionsOf(0), [leaf.bufferId]);
  spine.runCommand('kill-view');
  assert.equal(spine.liveProcessSessionsOf(0).length, 0, 'the gnuplot was reaped');
});

test('serializeWindow/loadWindowLayout round-trips a gnuplot as a FRESH source', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  spine.runCommand('gnuplot');
  const before = wireLeaves(spine.paneSnapshot(0)).find((l) => l.viewKind === 'gnuplot');
  assert.ok(before, 'a gnuplot leaf exists before save');
  const blob = spine.serializeWindow(0);
  assert.equal(spine.loadWindowLayout(0, blob), true);
  const after = wireLeaves(spine.paneSnapshot(0)).find((l) => l.viewKind === 'gnuplot');
  assert.ok(after, 'restored as a gnuplot (not text, not dropped)');
  assert.notEqual(after.bufferId, before.bufferId, 'a FRESH gnuplot source on restore');
  assert.equal(after.state.sessionId, after.bufferId, 'fresh sessionId tied to the new source');
});

test('serializeWindow/loadWindowLayout round-trips a shell as a FRESH source', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  spine.runCommand('shell');
  const before = wireLeaves(spine.paneSnapshot(0)).find((l) => l.viewKind === 'shell');
  assert.ok(before, 'a shell leaf exists before save');
  const blob = spine.serializeWindow(0);
  assert.equal(spine.loadWindowLayout(0, blob), true, 'layout restored');
  const after = wireLeaves(spine.paneSnapshot(0)).find((l) => l.viewKind === 'shell');
  assert.ok(after, 'restored as a shell (not text, not dropped)');
  // A workspace saves the ARRANGEMENT, not the live process: a NEW source + pty.
  assert.notEqual(after.bufferId, before.bufferId, 'a fresh shell source on restore');
  assert.equal(after.state.sessionId, after.bufferId, 'fresh sessionId tied to the new source');
});

test('a restored shell keeps its cwd (fresh process, same dir)', () => {
  const files = { '/proj/x.js': { text: 'x', name: 'x.js' } };
  const { spine } = makeSpine('seed', 'scratch.txt', { openFile: (p) => files[p] ?? null });
  spine.visitFile('/proj/x.js');
  spine.runCommand('shell'); // cwd resolves to the doc dir
  assert.equal(wireLeaves(spine.paneSnapshot(0))[0].state.cwd, '/proj');
  const blob = spine.serializeWindow(0);
  assert.equal(spine.loadWindowLayout(0, blob), true);
  const after = wireLeaves(spine.paneSnapshot(0)).find((l) => l.viewKind === 'shell');
  assert.ok(after, 'a shell leaf restored');
  assert.equal(after.state.cwd, '/proj', 'restored shell starts in the saved cwd');
});

test('M-x browser-view mints a server-owned browser data-source at the typed URL', () => {
  // The full Lisp path: browser.lisp (browser-view) prompts for a URL →
  // (open-browser-view! url) → openBrowserSource. Proves browser.lisp loaded in
  // SPINE_STDLIB and the interactive prompt round-trips server-side.
  const { spine, log } = makeSpine('seed', 'scratch.txt');
  spine.runCommand('browser-view');
  assert.deepEqual(log.minibufferOpens, ['Browse URL: '], 'prompts for a URL');
  spine.deliverMinibuffer('example.com');
  assert.equal(spine.bufferCount, 1, 'a browser did NOT add a text buffer');
  const leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.match(leaf.bufferId, /^ds\d+$/, 'a data-source id');
  assert.equal(leaf.viewKind, 'browser');
  assert.equal(leaf.state.url, 'example.com', 'carries the typed URL on the wire state');
});

test('browser-view with an empty URL opens the home page (about:blank)', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  spine.runCommand('browser-view');
  spine.deliverMinibuffer(''); // submit empty → home page
  const leaf = wireLeaves(spine.paneSnapshot(0))[0];
  assert.equal(leaf.viewKind, 'browser');
  assert.equal(leaf.state.url, 'about:blank', 'empty URL falls back to the home page');
});

test('liveBrowserSourcesOf lists open browsers; kill-view reaps the focused one', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  const browserId = spine.openBrowserSource('https://example.com');
  // Fanned to the client per PANE_TREE so it reaps the <webview> on a real close
  // (not a switch-away — the source stays in the set then).
  assert.deepEqual(spine.liveBrowserSourcesOf(0), [browserId], 'the open browser is in the live set');
  spine.runCommand('kill-view');
  assert.deepEqual(spine.liveBrowserSourcesOf(0), [], 'the killed browser left the live set');
  assert.equal(spine.isDataSource(browserId), false, 'the browser data-source is gone');
});

test('kill-view on a browser bypasses the "only buffer" guard (data-source path)', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  assert.equal(spine.bufferCount, 1, 'one text buffer (scratch)');
  spine.openBrowserSource('https://example.com');
  spine.runCommand('kill-view');
  assert.equal(spine.liveBrowserSourcesOf(0).length, 0, 'the browser was reaped, not refused');
  assert.equal(spine.bufferCount, 1, 'the text buffer survived');
});

test('serializeWindow/loadWindowLayout round-trips a browser as a FRESH source at its URL', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  spine.openBrowserSource('https://example.com/page');
  const before = wireLeaves(spine.paneSnapshot(0)).find((l) => l.viewKind === 'browser');
  assert.ok(before, 'a browser leaf exists before save');
  const blob = spine.serializeWindow(0);
  assert.equal(spine.loadWindowLayout(0, blob), true, 'layout restored');
  const after = wireLeaves(spine.paneSnapshot(0)).find((l) => l.viewKind === 'browser');
  assert.ok(after, 'restored as a browser (not text, not dropped)');
  // A workspace saves the ARRANGEMENT: a fresh source, but at the same saved URL.
  assert.notEqual(after.bufferId, before.bufferId, 'a fresh browser source on restore');
  assert.equal(after.state.url, 'https://example.com/page', 'restored at the saved URL');
});

test('setBrowserSourceUrl tracks navigation so restore reopens the current page', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  const id = spine.openBrowserSource('https://example.com');
  // The user navigates within the page (a link / the URL bar): the view reports
  // the new URL up, and the source quietly tracks it (no fan-out / view emit).
  spine.setBrowserSourceUrl(id, 'https://example.com/deep/page');
  assert.equal(wireLeaves(spine.paneSnapshot(0))[0].state.url, 'https://example.com/deep/page',
    'the data-source now carries the navigated URL');
  // A saved workspace therefore restores the page the user is ON, not the opener.
  const blob = spine.serializeWindow(0);
  assert.equal(spine.loadWindowLayout(0, blob), true);
  const after = wireLeaves(spine.paneSnapshot(0)).find((l) => l.viewKind === 'browser');
  assert.equal(after.state.url, 'https://example.com/deep/page', 'restored at the navigated URL');
});

test('setBrowserSourceUrl ignores a bad id / non-browser source / empty url', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  const id = spine.openBrowserSource('https://example.com');
  spine.setBrowserSourceUrl('nope', 'https://evil.example'); // unknown id → no-op
  spine.setBrowserSourceUrl(id, '');                          // empty url → keep current
  assert.equal(wireLeaves(spine.paneSnapshot(0))[0].state.url, 'https://example.com',
    'a bad id / empty url leaves the URL untouched');
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

test('switch-view moves the active client between buffers, keeping cursor', () => {
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

test('list-views opens a generic PICKER over the open buffers', () => {
  const files = { '/x.js': { text: 'const x = 1;\n', name: 'x.js' } };
  const { spine, log } = makeSpine('alpha', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  spine.visitFile('/x.js'); // now two buffers; active client on x.js
  spine.runCommand('list-views');
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
  spine.runCommand('list-views');
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
  spine.runCommand('list-views');
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
  spine.runCommand('list-views');
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

test('viewState reports the major-mode name + math-preview-active flag', () => {
  // These ride the VIEW message so a GODOT_SERVER=1 client (whose own
  // interpreter is inert) can pick the math scanner + decide whether to typeset.
  const files = { '/note.md': { text: '$x$\n', name: 'note.md' } };
  const { spine } = makeSpine('let a = 1;\n', 'code.js', {
    openFile: (p) => files[p] ?? null,
  });
  spine.visitFile('/note.md'); // client 0 → Markdown
  assert.equal(spine.viewStateOf(0).majorModeName, 'Markdown');
  assert.equal(spine.viewStateOf(0).mathPreviewActive, false);

  // The mode MENU rides the VIEW too, computed server-side (the client's own
  // interpreter is inert) so the macOS app menu can follow the buffer's mode.
  const menu = spine.viewStateOf(0).modeMenu;
  assert.ok(menu, 'the server computes a mode menu for a text buffer');
  assert.equal(menu.label, 'Markdown', 'the menu is for the focused buffer mode');
  assert.ok(Array.isArray(menu.entries) && menu.entries.length > 0,
    'the menu carries the mode keymap entries');
  assert.ok(Array.isArray(menu.sections), 'and the structured sections');

  spine.runCommand('toggle-math-preview'); // enable on this buffer
  assert.equal(spine.viewStateOf(0).mathPreviewActive, true,
    'the server reports math-preview-mode on once toggled');

  spine.runCommand('toggle-math-preview'); // disable again
  assert.equal(spine.viewStateOf(0).mathPreviewActive, false);
});

test('kill-view removes the active buffer and re-homes the client', () => {
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

test('kill-view refuses to kill the only buffer', () => {
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
  spine.handleKey('M-S-period'); // select to end of buffer
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
  spine.handleKey('M-S-period'); // end of buffer
  for (const ch of 'XY') spine.handleKey(ch);
  assert.equal(spine.buffer.text, 'seedXY');
  spine.handleKey('C-slash'); // C-/ → undo
  assert.equal(spine.buffer.text, 'seedX');
  // Point is restored to the changed region (just past the surviving edit).
  assert.equal(spine.buffer.point, 5);
});

test('C-x u is also bound to undo', () => {
  const { spine } = makeSpine('ab', 'scratch.txt');
  spine.handleKey('M-S-period');
  spine.handleKey('c');
  assert.equal(spine.buffer.text, 'abc');
  spine.handleKey('C-x');
  spine.handleKey('u');
  assert.equal(spine.buffer.text, 'ab');
});

test('redo (C-S-/) reapplies an undone edit', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  spine.handleKey('M-S-period');
  spine.handleKey('Z');
  spine.handleKey('C-slash'); // undo → 'seed'
  assert.equal(spine.buffer.text, 'seed');
  spine.handleKey('C-S-slash'); // redo → 'seedZ'
  assert.equal(spine.buffer.text, 'seedZ');
  assert.equal(spine.buffer.point, 5);
});

test('undo/redo set the history-op flag (consumeHistoryOp) for the server resync', () => {
  const { spine } = makeSpine('seed', 'scratch.txt');
  spine.handleKey('M-S-period');
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
  spine.handleKey('M-S-period');
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

// --- JS notebook: server-side cell eval (M-x notebook-js) --------------------
// The renderer can't eval (CSP forbids unsafe-eval); cells run HERE in the
// spine's Node context and return a SERIALIZABLE result the client materializes.

test('runNotebookCell evaluates a value cell → ok + serializable descriptor', async () => {
  const { spine } = makeSpine('');
  const r = await spine.runNotebookCell('1 + 1');
  assert.equal(r.state, 'ok');
  assert.equal(r.error, null);
  // A number inspects to a text descriptor "2" (serializable — crosses the wire).
  assert.ok(r.descriptor && (r.descriptor.text === '2' || r.descriptor.value === 2),
    'descriptor represents the value 2');
});

test('runNotebookCell captures console output', async () => {
  const { spine } = makeSpine('');
  const r = await spine.runNotebookCell('console.log("hi"); 42');
  assert.equal(r.state, 'ok');
  assert.ok(r.logs.some((l) => String(l.text).includes('hi')), 'console.log captured');
});

test('runNotebookCell supports top-level await (AsyncFunction)', async () => {
  const { spine } = makeSpine('');
  const r = await spine.runNotebookCell('await Promise.resolve(7)');
  assert.equal(r.state, 'ok');
  assert.ok(r.descriptor.text === '7' || r.descriptor.value === 7);
});

test('runNotebookCell reports a thrown error instead of throwing', async () => {
  const { spine } = makeSpine('');
  const r = await spine.runNotebookCell('throw new Error("boom")');
  assert.equal(r.state, 'error');
  assert.equal(r.error.message, 'boom');
});

// --- cross-cell shared scope (Jupyter-style; the notebook-cells view) --------
// A sessionId gives a notebook a PERSISTENT scope: a cell's top-level
// declarations flow to later cells in the same session, and only that session.

const num = (d) => (d && (d.text != null ? String(d.text) : String(d.value)));

test('runNotebookCell: top-level const flows to a later cell in the same session', async () => {
  const { spine } = makeSpine('');
  const a = await spine.runNotebookCell('const total = 21;\ntotal', 'sessX');
  assert.equal(a.state, 'ok');
  const b = await spine.runNotebookCell('total * 2', 'sessX');
  assert.equal(b.state, 'ok');
  assert.equal(num(b.descriptor), '42');
});

test('runNotebookCell: a top-level function persists across cells', async () => {
  const { spine } = makeSpine('');
  await spine.runNotebookCell('function dbl(x) { return x * 2 }', 'sessF');
  const r = await spine.runNotebookCell('dbl(20) + 2', 'sessF');
  assert.equal(r.state, 'ok');
  assert.equal(num(r.descriptor), '42');
});

test('runNotebookCell: scopes are isolated across sessions', async () => {
  const { spine } = makeSpine('');
  await spine.runNotebookCell('const secret = 99;\nsecret', 'sessA');
  const r = await spine.runNotebookCell('typeof secret', 'sessB');
  assert.equal(r.state, 'ok');
  assert.match(num(r.descriptor), /undefined/);
});

test('runNotebookCell: with NO session id, cells stay isolated (no leak)', async () => {
  const { spine } = makeSpine('');
  await spine.runNotebookCell('const loose = 5;\nloose');
  const r = await spine.runNotebookCell('typeof loose');
  assert.equal(r.state, 'ok');
  assert.match(num(r.descriptor), /undefined/);
});

// --- B4: latex-compile port (run-process! + the compile/view loop) ---------
// The spine is a Node utilityProcess, so run-process! spawns build children
// directly and applies the on-exit Lisp procedure async; latex-compile.lisp
// rides that seam. These exercise the real spawn + the compile flow's dock
// directives + the latex-view pane split, all server-side.

/** Poll until PRED() is truthy or the budget runs out (async spawn waits). */
async function until(pred, ms = 4000, step = 20) {
  for (let waited = 0; waited < ms; waited += step) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return pred();
}

test('B4 run-process!: spawns a child and delivers {:stdout :stderr :code} to the Lisp on-exit', async () => {
  const { spine } = makeSpine('');
  spine.interpreter.evaluate('(define *rp* nil)');
  spine.interpreter.evaluate(
    `(run-process! "node" (list "-e" "process.stdout.write('OUT'); process.stderr.write('ERR'); process.exit(2)") nil (lambda (r) (set! *rp* r)))`
  );
  await until(() => spine.interpreter.evaluate('(nil? *rp*)') === false);
  assert.equal(spine.interpreter.evaluate('(get *rp* :stdout "")'), 'OUT');
  assert.equal(spine.interpreter.evaluate('(get *rp* :stderr "")'), 'ERR');
  assert.equal(spine.interpreter.evaluate('(get *rp* :code -1)'), 2);
});

test('B4 run-process!: a missing program reports :code nil + ENOENT in stderr (fallback trigger)', async () => {
  const { spine } = makeSpine('');
  spine.interpreter.evaluate('(define *rp2* nil)');
  spine.interpreter.evaluate(
    `(run-process! "no-such-program-zzz" (list) nil (lambda (r) (set! *rp2* r)))`
  );
  await until(() => spine.interpreter.evaluate('(nil? *rp2*)') === false);
  assert.equal(spine.interpreter.evaluate('(nil? (get *rp2* :code nil))'), true);
  assert.equal(spine.interpreter.evaluate('(-latex-spawn-failed? *rp2*)'), true);
});

test('B4 latex-compile: saves, runs the build, and writes *TeX output*/*TeX errors* dock tabs', async () => {
  const { spine, log } = makeSpine('\\documentclass{article}', 'paper.tex', {
    initialPath: '/tmp/paper.tex',
    openFile: (p) => (p.endsWith('.tex') ? { text: '% tex', name: 'paper.tex', path: p } : null),
  });
  // Use `node` as a deterministic stand-in for the LaTeX toolchain (no latexmk
  // needed in CI): it prints a line and exits 0; the .tex basename is appended
  // as an ignored extra arg. The compile flow still parses + tabs the output.
  spine.interpreter.evaluate(
    `(custom-apply! (quote *latex-command*) (list "node" "-e" "process.stdout.write('build ok')"))`
  );
  spine.interpreter.evaluate('(run-command (quote latex-compile))');
  const sawOutput = () =>
    log.directives.some((d) => d.name === 'utility-panel-set' && d.args[0] === 'tex-output');
  await until(sawOutput, 6000);
  assert.ok(log.saves.length >= 1, 'saved the buffer before building');
  assert.ok(
    log.directives.some((d) => d.name === 'utility-panel-open' && d.args[1] === 'tex-output'),
    'opened the *TeX output* dock tab'
  );
  assert.ok(sawOutput(), 'wrote the build log to *TeX output*');
  assert.ok(
    log.directives.some((d) => d.name === 'utility-panel-set' && d.args[0] === 'tex-errors'),
    'wrote diagnostics to *TeX errors*'
  );
});

test('B4 open-file-in-split!: splits the focused pane and opens the pdf in the new leaf', () => {
  const { spine } = makeSpine('% tex', 'paper.tex', {
    initialPath: '/tmp/paper.tex',
    openFile: (p) =>
      p.endsWith('.pdf') ? { media: true, kind: 'pdf', name: 'paper.pdf', path: p } : null,
  });
  spine.interpreter.evaluate('(open-file-in-split! "/tmp/paper.pdf" (quote horizontal) (quote after))');
  const snap = spine.paneSnapshot(0);
  assert.equal(snap.kind, 'split');
  assert.equal(snap.orientation, 'horizontal');
  // source on the left (unfocused), the freshly-opened pdf on the right (focused).
  assert.equal(snap.first.name, 'paper.tex');
  assert.equal(snap.second.viewKind, 'pdf');
  assert.equal(snap.second.focused, true);
});

test('B4 view-list: surfaces an open pdf data-source so latex-view can find it (reload vs split)', () => {
  const { spine } = makeSpine('% tex', 'paper.tex', {
    initialPath: '/tmp/paper.tex',
    openFile: (p) =>
      p.endsWith('.pdf') ? { media: true, kind: 'pdf', name: 'paper.pdf', path: p } : null,
  });
  // not open yet
  assert.equal(spine.interpreter.evaluate('(nil? (-latex-find-view-by-file "/tmp/paper.pdf"))'), true);
  spine.interpreter.evaluate('(open-file-in-split! "/tmp/paper.pdf" (quote horizontal) (quote after))');
  // now open: -latex-find-view-by-file matches it via view-list + view-file-path
  assert.equal(spine.interpreter.evaluate('(nil? (-latex-find-view-by-file "/tmp/paper.pdf"))'), false);
});

// --- B4: project port (find-project / open-project-at! -> a NEW window) -----
// Each project now opens in its OWN window (the old in-renderer path reconfigured
// the single window in place because it couldn't). open-project-at! validates the
// directory + raises onOpenProjectWindow; the server spawns a window and assembles
// the 3-column Nova layout (dir-tree | editing | bookmark) on its HELLO via
// spine.loadProjectWindow.

function projectSpine() {
  return makeSpine('', 'home.txt', {
    initialPath: '/home/home.txt',
    openFile: (path) => {
      if (path === '/proj/btt' || path === '/proj/btt/') {
        return { directory: true, kind: 'directory-tree', name: 'btt', path: '/proj/btt' };
      }
      if (path.endsWith('.txt')) return { text: 'hi', name: path.split('/').pop(), path };
      return null;
    },
  });
}

test('B4 project: commands registered + find-project minibuffer helpers resolve', () => {
  const { spine } = projectSpine();
  for (const c of ['find-project', 'open-project', 'close-project', 'project-chooser']) {
    assert.notEqual(spine.interpreter.evaluate(`(member "${c}" (registered-command-names))`), false);
  }
  assert.equal(typeof spine.interpreter.evaluate('(-initial-find-file-value)'), 'string');
  assert.equal(spine.interpreter.evaluate('(-expand-tilde "/proj/btt")'), '/proj/btt');
});

test('B4 project: open-project-at! validates the dir + raises onOpenProjectWindow', () => {
  const { spine, log } = projectSpine();
  spine.interpreter.evaluate('(open-project-at! "/proj/btt")');
  assert.equal(log.projectWindows.length, 1);
  assert.equal(log.projectWindows[0].root, '/proj/btt');
  // a non-directory is rejected — no window spawn
  spine.interpreter.evaluate('(open-project-at! "/home/home.txt")');
  assert.equal(log.projectWindows.length, 1);
});

test('B4 project: loadProjectWindow assembles the 3-column layout in a spawned window', () => {
  const { spine, log } = projectSpine();
  spine.interpreter.evaluate('(open-project-at! "/proj/btt")');
  const cfg = log.projectWindows[0];
  const idx = spine.addClientView(); // simulate the freshly-spawned window
  assert.equal(spine.loadProjectWindow(idx, cfg), true);
  const snap = spine.paneSnapshot(idx);
  assert.equal(snap.kind, 'split');
  assert.equal(snap.orientation, 'horizontal');
  assert.equal(snap.first.viewKind, 'directory-tree'); // left column
  assert.equal(snap.second.kind, 'split'); // right block = editing | bookmark
  const leaves = [];
  (function walk(n) { if (!n) return; if (n.kind === 'leaf') leaves.push(n); else { walk(n.first); walk(n.second); } })(snap);
  assert.equal(leaves.length, 3);
  assert.ok(leaves.some((l) => l.viewKind === 'directory-tree'), 'directory-tree leaf');
  assert.ok(leaves.some((l) => l.viewKind === 'bookmark'), 'bookmark outline leaf');
  const editing = leaves.find((l) => l.viewKind !== 'directory-tree' && l.viewKind !== 'bookmark');
  assert.ok(editing && editing.focused === true, 'the editing pane is focused');
});

// --- B4: project Stage 2 — restore saved files + close-project save/close ---

test('B4 project Stage 2: a project window restores its saved files into the middle tabline', () => {
  const { spine } = projectSpine();
  // mirror server.js: open the project's saved files, then assemble the window.
  const idx = spine.addClientView();
  spine.setActiveClient(idx);
  spine.visitFile('/proj/a.txt');
  spine.visitFile('/proj/b.txt');
  assert.equal(
    spine.loadProjectWindow(idx, { root: '/proj/btt', files: ['/proj/a.txt', '/proj/b.txt'], active: '/proj/b.txt' }),
    true
  );
  const snap = spine.paneSnapshot(idx);
  const leaves = [];
  (function walk(n) { if (!n) return; if (n.kind === 'leaf') leaves.push(n); else { walk(n.first); walk(n.second); } })(snap);
  const tab = leaves.find((l) => Array.isArray(l.tabs));
  assert.ok(tab, 'middle is a tabline');
  const names = tab.tabs.map((t) => t.name);
  assert.ok(names.includes('a.txt') && names.includes('b.txt'), `tabline holds both files: ${JSON.stringify(names)}`);
});

test('B4 project Stage 2: close-project! saves only the project files + closes the window', () => {
  const { spine, log } = projectSpine();
  const idx = spine.addClientView();
  spine.setActiveClient(idx);
  spine.visitFile('/proj/a.txt');
  spine.visitFile('/proj/b.txt');
  spine.loadProjectWindow(idx, { root: '/proj/btt', files: ['/proj/a.txt', '/proj/b.txt'], active: '/proj/b.txt' });
  spine.setActiveClient(idx);
  spine.interpreter.evaluate('(close-project!)');
  assert.equal(log.projectCloses.length, 1);
  const c = log.projectCloses[0];
  assert.equal(c.root, '/proj/btt');
  assert.equal(c.windowId, idx);
  // ONLY the project's files — the home seed buffer must NOT leak into project.json
  assert.deepEqual([...c.files].sort(), ['/proj/a.txt', '/proj/b.txt']);
  assert.ok(!c.files.includes('/home/home.txt'), 'home buffer did not leak into the project save');
});

test('B4 project Stage 2: close-project! in a non-project window is a no-op', () => {
  const { spine, log } = projectSpine();
  spine.setActiveClient(0); // the home window (not a project)
  spine.interpreter.evaluate('(close-project!)');
  assert.equal(log.projectCloses.length, 0);
});

// --- B4: project Stage 3 — open-project (dialog) + chooser route to a window -

test('B4 project Stage 3: open-project! / open-project-chooser! emit renderer directives', () => {
  const { spine, log } = projectSpine();
  spine.interpreter.evaluate('(open-project!)');
  assert.ok(log.directives.some((d) => d.name === 'open-project-dialog'), 'open-project! → open-project-dialog');
  log.directives.length = 0;
  spine.interpreter.evaluate('(open-project-chooser!)');
  assert.ok(log.directives.some((d) => d.name === 'open-project-chooser'), 'open-project-chooser! → open-project-chooser');
});

test('B4 project Stage 3: spine.openProjectAt (the PROJECT_OPEN path) opens a project window', () => {
  const { spine, log } = projectSpine();
  assert.equal(spine.openProjectAt('/proj/btt'), true);
  assert.equal(log.projectWindows.length, 1);
  assert.equal(log.projectWindows[0].root, '/proj/btt');
  // a non-directory path is rejected — no window
  assert.equal(spine.openProjectAt('/home/home.txt'), false);
  assert.equal(log.projectWindows.length, 1);
});

// --- B4: face-info (C-h F / C-h C-f) — the render-side tree-sitter round-trip --
// describe-face-at-point / highlight-construct-at-point fetch render-side
// tree-sitter data via with-tree-sitter-info (a tree-sitter-query directive →
// the renderer replies → deliverTreeSitterInfo resumes), then run server-side.

test('B4 face-info: describe-face-at-point suspends on a tree-sitter-query, then opens a doc page', () => {
  const { spine, log } = makeSpine('function foo() {}', 'test.js', { initialPath: '/t/test.js' });
  spine.buffer.moveTo(3); // inside `function`
  spine.interpreter.evaluate('(run-command (quote describe-face-at-point))');
  const q = log.directives.find((d) => d.name === 'tree-sitter-query');
  assert.ok(q, 'emits a tree-sitter-query directive');
  assert.equal(q.args[0], 3, 'carries point');
  // the renderer replies with a covering capture → a *Face at point* doc opens
  spine.deliverTreeSitterInfo({
    lang: 'javascript', captures: [[0, 8, 'keyword'], [9, 12, 'function']],
    node: null, colors: { keyword: '#c594c5' },
  });
  const snap = JSON.stringify(spine.paneSnapshot(0));
  assert.ok(snap.includes('"viewKind":"doc"'), 'a doc data-source leaf is shown');
  assert.ok(snap.includes('Face at point'), 'the doc page is named "Face at point"');
  // the resolved colour came from the renderer-provided stash
  assert.equal(spine.interpreter.evaluate('(face-color-for "keyword")'), '#c594c5');
});

test('B4 face-info: describe-face-at-point falls back to node info when no capture covers point', () => {
  const { spine, log } = makeSpine('abc def', 'test.js', { initialPath: '/t/test.js' });
  spine.buffer.moveTo(0);
  spine.interpreter.evaluate('(run-command (quote describe-face-at-point))');
  assert.ok(log.directives.some((d) => d.name === 'tree-sitter-query'));
  spine.deliverTreeSitterInfo({
    lang: 'javascript', captures: [[5, 9, 'keyword']], // doesn't cover 0
    node: { type: 'identifier', start: 0, end: 3, ancestors: ['program'] }, colors: {},
  });
  assert.ok(JSON.stringify(spine.paneSnapshot(0)).includes('Face at point'),
    'opens the no-capture fallback doc page from the node info');
});

test('B4 face-info: highlight-construct-at-point round-trips then prompts for a face', () => {
  const { spine, log } = makeSpine('abc', 'test.js', { initialPath: '/t/test.js' });
  spine.interpreter.evaluate('(run-command (quote highlight-construct-at-point))');
  assert.ok(log.directives.some((d) => d.name === 'tree-sitter-query'), 'C-h C-f emits tree-sitter-query');
  spine.deliverTreeSitterInfo({
    lang: 'javascript', captures: [],
    node: { type: 'identifier', start: 0, end: 3, ancestors: [] }, colors: {},
  });
  assert.ok(log.minibufferOpens.some((p) => p.includes('Face for `identifier`')),
    `prompts for the face (${JSON.stringify(log.minibufferOpens)})`);
});

test('B4 face-info: describe-face-at-point reports when there is no tree-sitter language', () => {
  const { spine, log } = makeSpine('plain text', 'notes.txt', { initialPath: '/t/notes.txt' });
  spine.interpreter.evaluate('(run-command (quote describe-face-at-point))');
  spine.deliverTreeSitterInfo({ lang: null, captures: [], node: null, colors: {} });
  // no doc page opened; the focused leaf is still the text buffer
  assert.ok(!JSON.stringify(spine.paneSnapshot(0)).includes('"viewKind":"doc"'),
    'no doc page when the buffer has no tree-sitter language');
});

// --- B4: latex error-nav resolves relative diagnostic paths (live-found bug) --
// TeX engines report file paths RELATIVE to the build dir (e.g. ./paper.tex);
// the spine's file-exists? statSyncs against its own cwd, so latex-next-error's
// guard failed and never jumped. -latex-resolve-diag-file resolves against the
// master file's directory.

test('B4 latex-next-error: resolves a relative diagnostic path + jumps to the line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tex-'));
  const file = join(dir, 'paper.tex');
  const text = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n');
  writeFileSync(file, text);
  try {
    const { spine } = makeSpine(text, 'paper.tex', {
      initialPath: file,
      openFile: (p) => (p === file ? { text, name: 'paper.tex', path: file } : null),
    });
    const ev = (s) => spine.interpreter.evaluate(s);
    // relative paths resolve against the master dir; absolute pass through
    assert.equal(ev('(-latex-resolve-diag-file "./paper.tex")'), file);
    assert.equal(ev(`(-latex-resolve-diag-file "${file}")`), file);
    assert.equal(ev('(nil? (-latex-resolve-diag-file nil))'), true); // a nil file stays nil
    // a relative-path diagnostic at line 10 → latex-next-error jumps there
    ev('(set! *latex-error-list* (list {:file "./paper.tex" :line 10 :message "oops"}))');
    ev('(set! *latex-error-index* -1)');
    spine.buffer.moveTo(0);
    ev('(latex-next-error)');
    assert.equal(spine.buffer.positionAt(spine.buffer.point).line, 9, 'jumped to line 10 (0-based 9)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- B4: find-file / find-project seed the prompt with a sensible directory ---
// (live-found) The minibuffer opens pre-filled at the current file's directory,
// or the home directory for a scratch — so TAB immediately lists somewhere
// useful. open-completing-minibuffer!'s 2nd arg is forwarded to the client via
// minibufferState.value.

test('B4 find-file: seeds the current file\'s directory', () => {
  const { spine, log } = makeSpine('x', 'paper.tex', { initialPath: '/Users/jalex/Articles/paper.tex' });
  spine.interpreter.evaluate('(run-command (quote find-file))');
  assert.equal(log.minibufferOpens[0], 'Find file: ');
  assert.equal(log.minibufferSeeds[0], '/Users/jalex/Articles/');
});

test('B4 find-file: seeds the home directory from a scratch buffer', () => {
  const { spine, log } = makeSpine('x', '*scratch*'); // no initialPath
  spine.interpreter.evaluate('(run-command (quote find-file))');
  const home = spine.interpreter.evaluate('(home-directory)');
  assert.equal(log.minibufferSeeds[0], `${home}/`);
});

test('B4 find-project: opens the "Open project: " prompt seeded at a sensible dir', () => {
  const { spine, log } = makeSpine('x', 'main.txt', { initialPath: '/Users/jalex/Source/proj/main.txt' });
  spine.interpreter.evaluate('(run-command (quote find-project))');
  assert.equal(log.minibufferOpens[0], 'Open project: ');
  assert.equal(log.minibufferSeeds[0], '/Users/jalex/Source/proj/');
});
