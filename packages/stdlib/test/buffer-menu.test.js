/**
 * @file Tests for the `*Buffer List*` (`buffer-menu`) feature. The host
 * is mocked: a small in-test buffer registry stands in for the desktop
 * app's list, and `list-buffers`, `switch-to-buffer!`, `new-buffer!`
 * and `kill-buffer!` are wired against it. The L2 buffer the tests
 * pass to `createBufferPrimitives` is repointed at the active buffer
 * through the shared session — exactly how the desktop app does it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import { arrayToList, createInterpreter, keyword, NIL } from '@editor/lisp';
import { createBufferPrimitives, loadStdlib } from '../src/index.js';

const lispDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lisp');
const languagesDir = join(lispDir, 'languages');

/**
 * Build an editor with the standard library loaded, a small in-test
 * buffer registry, and host primitives stubbed against it. Each test
 * gets a clean registry.
 *
 * @param {{name: string, kind?: string, mode?: string, lines?: number,
 *   file?: string|null, modified?: boolean, text?: string}[]} [seed]
 *   The buffers the registry starts with. The first entry is current.
 */
async function buildEditor(seed = [{ name: 'alpha.txt', text: 'alpha' }]) {
  const registry = seed.map((entry) => ({
    name: entry.name,
    kind: entry.kind ?? 'text',
    mode: entry.mode ?? null,
    lineCount: entry.lines ?? 1,
    file: entry.file ?? null,
    modified: entry.modified ?? false,
    // Each entry gets its own L2 buffer so switching is real.
    buffer: createBuffer(entry.text ?? '', { name: entry.name }),
  }));
  let currentIndex = 0;
  const session = {
    get current() {
      return registry[currentIndex].buffer;
    },
  };
  const switches = [];
  const kills = [];

  const recordFor = (entry) => {
    const m = new Map();
    m.set(keyword('name'), entry.name);
    m.set(keyword('kind'), entry.kind);
    m.set(keyword('mode'), entry.mode === null ? NIL : entry.mode);
    m.set(keyword('line-count'), entry.lineCount);
    m.set(keyword('file'), entry.file === null ? NIL : entry.file);
    m.set(keyword('modified'), entry.modified);
    return m;
  };
  const listFromRecords = (entries) => arrayToList(entries.map(recordFor));

  const interpreter = createInterpreter({
    primitives: {
      ...createBufferPrimitives(session),
      // The buffer-list snapshot.
      'list-buffers': () => listFromRecords(registry),
      // Switch to a buffer by name; returns #t when one matched, NIL
      // otherwise. The registry's current index is updated and the
      // session's `current` repoints automatically.
      'switch-to-buffer!': (args) => {
        const name = String(args[0] ?? '');
        const idx = registry.findIndex((e) => e.name === name);
        if (idx < 0) return NIL;
        currentIndex = idx;
        switches.push(name);
        return true;
      },
      // Create a fresh empty buffer (text kind) and switch to it.
      'new-buffer!': (args) => {
        const name =
          args.length > 0 ? String(args[0]) : `untitled-${registry.length + 1}`;
        registry.push({
          name,
          kind: 'text',
          mode: null,
          lineCount: 1,
          file: null,
          modified: false,
          buffer: createBuffer('', { name }),
        });
        currentIndex = registry.length - 1;
        switches.push(name);
        return NIL;
      },
      // Kill by name (or current). Replicates the app.js semantics
      // closely enough for the menu tests: removing the current
      // buffer steps to the next; an empty list creates a *scratch*.
      'kill-buffer!': (args) => {
        let target;
        if (args.length > 0) {
          target = registry.findIndex((e) => e.name === String(args[0]));
        } else {
          target = currentIndex;
        }
        if (target < 0) return NIL;
        kills.push(registry[target].name);
        const wasCurrent = target === currentIndex;
        registry.splice(target, 1);
        if (registry.length === 0) {
          registry.push({
            name: '*scratch*',
            kind: 'text',
            mode: null,
            lineCount: 1,
            file: null,
            modified: false,
            buffer: createBuffer('', { name: '*scratch*' }),
          });
          currentIndex = 0;
        } else if (wasCurrent) {
          currentIndex = Math.min(target, registry.length - 1);
        } else if (target < currentIndex) {
          currentIndex -= 1;
        }
        return NIL;
      },
      // Filler primitives so the rest of the standard library can load.
      'next-buffer!': () => NIL,
      'previous-buffer!': () => NIL,
      'start-buffer-switcher!': () => NIL,
      'open-file!': () => NIL,
      'save-buffer!': () => NIL,
      'reload-stdlib!': () => NIL,
      'start-search!': () => NIL,
      'start-search-backward!': () => NIL,
      'start-command-palette!': () => NIL,
      'start-describe-command!': () => NIL,
      'open-minibuffer!': () => NIL,
      'goto-line!': () => NIL,
      'replace-all!': () => NIL,
      'recenter!': () => NIL,
      'page-lines': () => 3,
      'toggle-repl!': () => NIL,
      'markdown-preview!': () => NIL,
      'quit-editor!': () => NIL,
      'note-create!': () => 'note-1',
      'note-edit!': () => NIL,
      'note-delete!': () => NIL,
      'note-at-point': () => NIL,
      'note-next!': () => NIL,
      'note-prev!': () => NIL,
      'notes-toggle!': () => NIL,
      'write-custom-file!': () => NIL,
      'apply-theme!': () => NIL,
      'load-doc-manifest!': () => NIL,
      'open-doc!': () => NIL,
      'open-docstring-page!': () => NIL,
      'start-doc-search!': () => NIL,
      'form-bounds-at-point!': () => NIL,
      'form-bounds-before-point!': () => NIL,
      'eval-region!': () => NIL,
      'show-eval-log!': () => NIL,
      'show-status!': () => NIL,
      'clear-status!': () => NIL,
      'home-directory': () => '',
      'list-directory-paths': () => NIL,
      'open-file-path!': () => NIL,
      'open-completing-minibuffer!': () => NIL,
    },
  });

  await loadStdlib(
    interpreter,
    (name) => readFile(join(lispDir, name), 'utf8'),
    {
      listLanguageFiles: async () =>
        (await readdir(languagesDir)).filter((n) => n.endsWith('.lisp')),
    }
  );

  return {
    interpreter,
    registry,
    switches,
    kills,
    currentName: () => registry[currentIndex].name,
    currentBuffer: () => registry[currentIndex].buffer,
  };
}

const press = (interpreter, key) => interpreter.call('handle-key', key);

test('buffer-menu opens a *Buffer List* buffer', async () => {
  const editor = await buildEditor([
    { name: 'alpha.txt', text: 'one' },
    { name: 'beta.txt', text: 'two' },
  ]);
  editor.interpreter.evaluate('(buffer-menu)');
  assert.equal(editor.currentName(), '*Buffer List*');
});

test('buffer-menu renders one row per open buffer', async () => {
  const editor = await buildEditor([
    { name: 'alpha.txt', text: 'a' },
    { name: 'beta.txt', text: 'b' },
    { name: 'gamma.txt', text: 'c' },
  ]);
  editor.interpreter.evaluate('(buffer-menu)');
  const text = editor.currentBuffer().text;
  const lines = text.split('\n').filter((l) => l.length > 0);
  // One header line + one row per buffer in the registry. After
  // buffer-menu runs the registry includes *Buffer List* itself.
  const header = lines[0];
  assert.ok(header.includes('Name'), `header was: ${header}`);
  const rows = lines.slice(1);
  // Four buffers: alpha, beta, gamma, *Buffer List*.
  assert.equal(rows.length, 4);
  assert.ok(rows.some((r) => r.includes('alpha.txt')));
  assert.ok(rows.some((r) => r.includes('beta.txt')));
  assert.ok(rows.some((r) => r.includes('*Buffer List*')));
});

test('buffer-menu sets buffer-menu-mode on *Buffer List*', async () => {
  const editor = await buildEditor();
  editor.interpreter.evaluate('(buffer-menu)');
  assert.ok(
    editor.interpreter.evaluate(
      '(eq? (buffer-major-mode) buffer-menu-mode)'
    )
  );
});

test('C-x C-b is bound to buffer-menu', async () => {
  const editor = await buildEditor();
  assert.ok(
    editor.interpreter.evaluate(
      '(eq? (get c-x-keymap "C-b") (quote buffer-menu))'
    )
  );
  press(editor.interpreter, 'C-x');
  press(editor.interpreter, 'C-b');
  assert.equal(editor.currentName(), '*Buffer List*');
});

test('buffer-menu cursor lands on the first row, not the header', async () => {
  const editor = await buildEditor([{ name: 'alpha.txt', text: 'x' }]);
  editor.interpreter.evaluate('(buffer-menu)');
  // The current line text should be a buffer row, not the column header.
  const line = editor.interpreter.evaluate('(current-line-text)');
  assert.ok(typeof line === 'string');
  assert.ok(!line.includes('Name'), `header line: ${line}`);
  assert.ok(line.length > 0);
});

test('RET selects the buffer on the current row', async () => {
  const editor = await buildEditor([
    { name: 'alpha.txt', text: 'one' },
    { name: 'beta.txt', text: 'two' },
  ]);
  editor.interpreter.evaluate('(buffer-menu)');
  // First row is the first buffer in registry order — alpha.
  press(editor.interpreter, 'enter');
  assert.equal(editor.currentName(), 'alpha.txt');
});

test('d marks the current row for delete', async () => {
  const editor = await buildEditor([
    { name: 'alpha.txt', text: 'one' },
    { name: 'beta.txt', text: 'two' },
  ]);
  editor.interpreter.evaluate('(buffer-menu)');
  press(editor.interpreter, 'd');
  const lines = editor.currentBuffer().text.split('\n');
  // The first row (alpha.txt) should now start with 'D'.
  const alphaLine = lines.find((l) => l.includes('alpha.txt'));
  assert.ok(alphaLine, 'alpha row exists');
  assert.equal(alphaLine[0], 'D');
});

test('u unmarks a row', async () => {
  const editor = await buildEditor([
    { name: 'alpha.txt', text: 'one' },
    { name: 'beta.txt', text: 'two' },
  ]);
  editor.interpreter.evaluate('(buffer-menu)');
  press(editor.interpreter, 'd'); // mark alpha
  // d also advanced to the next line; go back up to the marked line.
  press(editor.interpreter, 'up');
  press(editor.interpreter, 'u'); // unmark
  const lines = editor.currentBuffer().text.split('\n');
  const alphaLine = lines.find((l) => l.includes('alpha.txt'));
  assert.equal(alphaLine[0], '.');
});

test('x kills every marked buffer and refreshes', async () => {
  const editor = await buildEditor([
    { name: 'alpha.txt', text: 'one' },
    { name: 'beta.txt', text: 'two' },
    { name: 'gamma.txt', text: 'three' },
  ]);
  editor.interpreter.evaluate('(buffer-menu)');
  press(editor.interpreter, 'd'); // mark alpha (and step to beta)
  press(editor.interpreter, 'd'); // mark beta (and step to gamma)
  press(editor.interpreter, 'x'); // execute
  assert.deepEqual(editor.kills, ['alpha.txt', 'beta.txt']);
  // After refresh, the menu is still current and only gamma + the
  // menu remain.
  assert.equal(editor.currentName(), '*Buffer List*');
  const lines = editor.currentBuffer().text.split('\n');
  assert.ok(!lines.some((l) => l.includes('alpha.txt')));
  assert.ok(!lines.some((l) => l.includes('beta.txt')));
  assert.ok(lines.some((l) => l.includes('gamma.txt')));
});

test('g refreshes the list', async () => {
  const editor = await buildEditor([
    { name: 'alpha.txt', text: 'one' },
  ]);
  editor.interpreter.evaluate('(buffer-menu)');
  // Mutate the registry directly, then refresh.
  editor.registry.push({
    name: 'late.txt',
    kind: 'text',
    mode: null,
    lineCount: 1,
    file: null,
    modified: false,
    buffer: createBuffer('', { name: 'late.txt' }),
  });
  press(editor.interpreter, 'g');
  const lines = editor.currentBuffer().text.split('\n');
  assert.ok(lines.some((l) => l.includes('late.txt')));
});

test('q returns to the buffer that was current when the menu opened', async () => {
  const editor = await buildEditor([
    { name: 'alpha.txt', text: 'one' },
    { name: 'beta.txt', text: 'two' },
  ]);
  // Make beta current first; then open the menu from beta.
  editor.interpreter.evaluate('(switch-to-buffer! "beta.txt")');
  assert.equal(editor.currentName(), 'beta.txt');
  editor.interpreter.evaluate('(buffer-menu)');
  assert.equal(editor.currentName(), '*Buffer List*');
  press(editor.interpreter, 'q');
  assert.equal(editor.currentName(), 'beta.txt');
});

test('the menu buffer name and mode-map binding match the spec', async () => {
  const editor = await buildEditor();
  // The mode-map binds the documented keys.
  for (const [key, sym] of [
    ['enter', 'buffer-menu-select'],
    ['d', 'buffer-menu-mark-delete'],
    ['k', 'buffer-menu-mark-delete'],
    ['u', 'buffer-menu-unmark'],
    ['x', 'buffer-menu-execute'],
    ['g', 'buffer-menu-refresh'],
    ['q', 'buffer-menu-quit'],
  ]) {
    assert.ok(
      editor.interpreter.evaluate(
        `(eq? (get buffer-menu-mode-map ${JSON.stringify(key)}) (quote ${sym}))`
      ),
      `expected ${key} -> ${sym}`
    );
  }
});

test('a row shows the modified flag for a dirty buffer', async () => {
  const editor = await buildEditor([
    { name: 'alpha.txt', text: 'one', modified: true },
    { name: 'clean.txt', text: 'two', modified: false },
  ]);
  editor.interpreter.evaluate('(buffer-menu)');
  const lines = editor.currentBuffer().text.split('\n');
  const alphaLine = lines.find((l) => l.includes('alpha.txt'));
  const cleanLine = lines.find((l) => l.includes('clean.txt'));
  // Column 0 is the action mark, column 3 is the modified flag (after
  // the action mark and a two-space gap).
  assert.equal(alphaLine[3], '*');
  assert.equal(cleanLine[3], '.');
});

test('the file column shows the buffer file path', async () => {
  const editor = await buildEditor([
    { name: 'main.js', text: 'x', file: '/path/to/main.js' },
  ]);
  editor.interpreter.evaluate('(buffer-menu)');
  const text = editor.currentBuffer().text;
  assert.ok(text.includes('/path/to/main.js'), `text: ${text}`);
});
