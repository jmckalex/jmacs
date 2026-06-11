/**
 * @file Tests for the main-process JMarkdown renderer
 * (../src/jmarkdown.js). `renderJMarkdown(command, source)` spawns the
 * user-configured shell command, feeds `source` on stdin, and resolves
 * `{ html }` from stdout on a clean exit or `{ error }` otherwise. It
 * never rejects.
 *
 * No Electron is involved — the module imports only `node:child_process`.
 * The tests drive it with small, harmless real commands (`cat`, `tr`,
 * shell `exit`) so we observe true spawn/stdin/exit behaviour rather than
 * a mock. The source is only ever written to stdin, never interpolated
 * into the command, which is the security property worth pinning.
 *
 * The 5s timeout path is intentionally not exercised here — the limit is a
 * fixed internal constant (not injectable), so a real test of it would have
 * to wait the full timeout. See architect-notes.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderJMarkdown } from '../src/jmarkdown.js';

// --- success paths ----------------------------------------------------------

test('a command that echoes stdin returns it verbatim as html', async () => {
  const result = await renderJMarkdown('cat', 'hello **world**');
  assert.deepEqual(result, { html: 'hello **world**' });
});

test('the source is delivered on stdin, transformed by the command', async () => {
  // `tr a-z A-Z` only sees the source via stdin.
  const result = await renderJMarkdown('tr a-z A-Z', 'abc');
  assert.deepEqual(result, { html: 'ABC' });
});

test('a shell pipeline is honoured (shell: true)', async () => {
  const result = await renderJMarkdown('cat | tr a-z A-Z', 'abc');
  assert.deepEqual(result, { html: 'ABC' });
});

test('an empty source still resolves with empty html', async () => {
  const result = await renderJMarkdown('cat', '');
  assert.deepEqual(result, { html: '' });
});

test('a command that exits 0 before reading all stdin ignores EPIPE', async () => {
  // `head -c 3` closes its stdin early; the writer must swallow the EPIPE
  // rather than crash or reject.
  const result = await renderJMarkdown('head -c 3', 'abcdefghijklmnop');
  assert.deepEqual(result, { html: 'abc' });
});

// --- the security property --------------------------------------------------

test('the source is NOT interpolated into the command (no shell injection)', async () => {
  // If the source were spliced into the command, `$(echo PWNED)` would be
  // expanded by the shell. Because it only reaches the command on stdin,
  // `cat` hands it straight back, untouched.
  const result = await renderJMarkdown('cat', '$(echo PWNED)');
  assert.deepEqual(result, { html: '$(echo PWNED)' });
});

test('source containing shell metacharacters round-trips untouched', async () => {
  const nasty = '; rm -rf / && echo `whoami` | tee $HOME';
  const result = await renderJMarkdown('cat', nasty);
  assert.deepEqual(result, { html: nasty });
});

// --- no-command guard -------------------------------------------------------

test('an empty command string resolves with a configuration error (no spawn)', async () => {
  const result = await renderJMarkdown('', 'x');
  assert.deepEqual(result, { error: 'no JMarkdown command configured' });
});

test('a whitespace-only command is treated as no command', async () => {
  const result = await renderJMarkdown('   \t  ', 'x');
  assert.deepEqual(result, { error: 'no JMarkdown command configured' });
});

test('a non-string command resolves with the configuration error', async () => {
  for (const command of [null, undefined, 42, {}, []]) {
    const result = await renderJMarkdown(command, 'x');
    assert.deepEqual(
      result,
      { error: 'no JMarkdown command configured' },
      `command ${JSON.stringify(command)} should be rejected pre-spawn`
    );
  }
});

// --- failure paths ----------------------------------------------------------

test('a non-zero exit with stderr reports the trimmed stderr', async () => {
  const result = await renderJMarkdown('echo boom 1>&2; exit 3', 'x');
  assert.deepEqual(result, { error: 'boom' });
});

test('a non-zero exit with no stderr reports the exit code', async () => {
  const result = await renderJMarkdown('exit 7', 'x');
  assert.deepEqual(result, { error: 'render command exited (7)' });
});

test('an unknown command surfaces the shell error and never rejects', async () => {
  // Under `shell: true` a missing command makes the shell exit non-zero
  // with a "command not found" message on stderr, rather than emitting a
  // spawn 'error' event. We assert the stable substring, since the exact
  // prefix (e.g. "/bin/sh: ") is platform-dependent.
  const result = await renderJMarkdown('this-command-should-not-exist-xyz', 'x');
  assert.ok('error' in result, 'resolves with an error, does not reject');
  assert.match(result.error, /command not found/i);
});

test('renderJMarkdown always resolves, never rejects', async () => {
  // Drive both the success and failure shapes through Promise.allSettled to
  // assert nothing rejects.
  const settled = await Promise.allSettled([
    renderJMarkdown('cat', 'ok'),
    renderJMarkdown('exit 1', 'x'),
    renderJMarkdown('', 'x'),
    renderJMarkdown('no-such-command-zzz', 'x'),
  ]);
  for (const s of settled) {
    assert.equal(s.status, 'fulfilled');
  }
});
