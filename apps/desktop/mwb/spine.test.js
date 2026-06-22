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
  const log = { status: [], minibufferOpens: [], minibufferCloses: 0, scrolls: [] };
  const spine = createSpine(
    { initialText, name },
    {
      onStatus: (s) => log.status.push(s),
      onMinibufferOpen: (p) => log.minibufferOpens.push(p),
      onMinibufferClose: () => { log.minibufferCloses += 1; },
      onScroll: (r) => log.scrolls.push(r),
      openFile: extra.openFile,
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
  const { spine, log } = makeSpine('');
  const handled1 = spine.handleKey('C-x');
  assert.equal(handled1, true);
  assert.equal(spine.buffer.text, ''); // C-x did not insert
  const handled2 = spine.handleKey('C-s'); // save-buffer (spine stub)
  assert.equal(handled2, true);
  assert.ok(
    log.status.some((s) => s.includes('save-buffer')),
    `expected a save-buffer status, got ${JSON.stringify(log.status)}`
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

test('find-file: visitFile swaps the canonical buffer to the read file', () => {
  const files = { '/tmp/x.js': { text: 'const x = 1;\n', name: 'x.js' } };
  const { spine } = makeSpine('scratch', 'scratch.txt', {
    openFile: (p) => files[p] ?? null,
  });
  const ok = spine.visitFile('/tmp/x.js');
  assert.equal(ok, true);
  assert.equal(spine.buffer.text, 'const x = 1;\n');
  assert.equal(spine.buffer.name, 'x.js');
  assert.equal(spine.buffer.point, 0);
});

test('find-file on a missing file reports and keeps the old buffer', () => {
  const { spine, log } = makeSpine('keep me', 'scratch.txt', {
    openFile: () => null,
  });
  const ok = spine.visitFile('/nope');
  assert.equal(ok, false);
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

test('viewState reports point, mark, name, modeline and modified flag', () => {
  const { spine } = makeSpine('hi', 'note.txt');
  let vs = spine.viewState();
  assert.equal(vs.point, 0);
  assert.equal(vs.mark, null);
  assert.equal(vs.name, 'note.txt');
  assert.equal(vs.modified, false);
  assert.match(vs.modeline, /^--\s+note\.txt/);
  spine.handleKey('x'); // edit → modified
  vs = spine.viewState();
  assert.equal(vs.modified, true);
  assert.match(vs.modeline, /^\*\*/);
});
