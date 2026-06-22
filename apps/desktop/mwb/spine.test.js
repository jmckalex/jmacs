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

/** A spine with recording effects, for assertions. */
function makeSpine(initialText = '', name = 'scratch.txt', extra = {}) {
  const log = {
    status: [], minibufferOpens: [], minibufferCloses: 0, scrolls: [], saves: [],
  };
  const spine = createSpine(
    { initialText, name },
    {
      onStatus: (s) => log.status.push(s),
      onMinibufferOpen: (p) => log.minibufferOpens.push(p),
      onMinibufferClose: () => { log.minibufferCloses += 1; },
      onScroll: (r) => log.scrolls.push(r),
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

test('bufferListRecords flags the current buffer per client', () => {
  const files = { '/x.js': { text: 'x', name: 'x.js' } };
  const { spine } = makeSpine('seed', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  spine.addClientView(); // client 1, on the seed buffer
  const xId = spine.visitFile('/x.js'); // active client (0) switches to x.js
  const recs0 = spine.bufferListRecords(0);
  const recs1 = spine.bufferListRecords(1);
  assert.equal(recs0.length, 2);
  // Client 0's current buffer is x.js; client 1's is still the seed.
  assert.equal(recs0.find((r) => r.id === xId).current, true);
  assert.equal(recs1.find((r) => r.id === xId).current, false);
  assert.ok(recs1.find((r) => r.name === 'scratch.txt').current);
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
