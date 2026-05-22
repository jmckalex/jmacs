/**
 * @file JMarkdown rendering — main process.
 *
 * jmacs bundles no markdown engine. A sticky note's JMarkdown source is
 * rendered by a *user-configured shell command*: the command receives
 * the source on stdin, and its stdout is taken as the note's HTML. The
 * renderer process is sandboxed, so the spawn happens here, in the main
 * process, reached over the `jmarkdown:render` IPC channel.
 *
 * The source is only ever passed on stdin — never interpolated into the
 * command — so note content cannot inject shell. The command itself is
 * the user's own configuration and trusted as such.
 */

import { spawn } from 'node:child_process';

/** A render that outruns this is killed and reported as a failure. */
const TIMEOUT_MS = 5000;

/**
 * Render JMarkdown `source` to HTML by running `command` (a shell
 * command string). Never rejects — resolves `{ html }` on success or
 * `{ error }` on a missing command, spawn failure, non-zero exit, or
 * timeout, so the caller can fall back cleanly.
 *
 * @param {string} command
 * @param {string} source
 * @returns {Promise<{html: string} | {error: string}>}
 */
export function renderJMarkdown(command, source) {
  return new Promise((resolve) => {
    if (typeof command !== 'string' || command.trim() === '') {
      resolve({ error: 'no JMarkdown command configured' });
      return;
    }

    let child;
    try {
      child = spawn(command, { shell: true });
    } catch (error) {
      resolve({ error: String(error?.message ?? error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ error: 'JMarkdown render timed out' });
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => done({ error: String(error?.message ?? error) }));
    child.on('close', (code) => {
      if (code === 0) done({ html: stdout });
      else done({ error: stderr.trim() || `render command exited (${code})` });
    });

    // The child may exit before reading all of stdin — ignore the EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(source);
  });
}
