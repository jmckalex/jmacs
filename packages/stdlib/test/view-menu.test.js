/**
 * @file Tests for the `*Buffer List*` (`buffer-menu`) feature, post
 * view/buffer split. The host is mocked: a small in-test view registry
 * stands in for the desktop app's list, and `list-views`,
 * `switch-to-view!`, `new-view!` and `kill-view!` are wired against
 * it. The L2 buffer the tests pass to `createBufferPrimitives` is
 * repointed at the active view's buffer through the shared session —
 * exactly how the desktop app does it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuffer } from '@editor/buffer';
import { arrayToList, createInterpreter, keyword, NIL } from '@editor/lisp';
import { createView } from '@editor/view';
import {
  createBufferPrimitives,
  createViewPrimitives,
  loadStdlib,
} from '../src/index.js';

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
  // Each registry entry is a small fixture combining the View handle
  // (so `(current-view)` returns a real one) with the row metadata
  // the *Buffer List* renders (mode, line count, file path, modified
  // flag). Killing/switching mutates this single list.
  const registry = seed.map((entry) => {
    const kind = entry.kind ?? 'text';
    const buffer = kind === 'text'
      ? createBuffer(entry.text ?? '', { name: entry.name })
      : null;
    return {
      view: createView({ kind, name: entry.name, buffer }),
      mode: entry.mode ?? null,
      lineCount: entry.lines ?? 1,
      file: entry.file ?? null,
      modified: entry.modified ?? false,
    };
  });
  let currentIndex = 0;
  const session = {
    get currentView() {
      return registry[currentIndex]?.view ?? null;
    },
  };
  const switches = [];
  const kills = [];

  const recordFor = (entry) => {
    const m = new Map();
    m.set(keyword('name'), entry.view.name);
    m.set(keyword('kind'), entry.view.kind);
    m.set(keyword('mode'), entry.mode === null ? NIL : entry.mode);
    m.set(keyword('line-count'), entry.lineCount);
    m.set(keyword('file'), entry.file === null ? NIL : entry.file);
    m.set(keyword('modified'), entry.modified);
    return m;
  };

  const findIndexByName = (name) =>
    registry.findIndex((e) => e.view.name === name);
  const findIndexByView = (view) =>
    registry.findIndex((e) => e.view === view);

  const switchToIndex = (idx, label) => {
    if (idx < 0) return null;
    currentIndex = idx;
    switches.push(label ?? registry[idx].view.name);
    return registry[idx].view;
  };

  const viewHost = {
    currentView: () => registry[currentIndex]?.view ?? null,
    viewList: () => registry.map((e) => e.view),
    switchToView: (target) => {
      const idx = typeof target === 'string'
        ? findIndexByName(target)
        : findIndexByView(target);
      if (idx < 0) return null;
      return switchToIndex(idx);
    },
    newView: (name) => {
      const finalName =
        name ?? `untitled-${registry.length + 1}`;
      const view = createView({
        kind: 'text',
        name: finalName,
        buffer: createBuffer('', { name: finalName }),
      });
      registry.push({
        view,
        mode: null,
        lineCount: 1,
        file: null,
        modified: false,
      });
      currentIndex = registry.length - 1;
      switches.push(finalName);
      return view;
    },
    killView: (target) => {
      const idx = typeof target === 'string'
        ? findIndexByName(target)
        : findIndexByView(target);
      if (idx < 0) return;
      kills.push(registry[idx].view.name);
      const wasCurrent = idx === currentIndex;
      registry.splice(idx, 1);
      if (registry.length === 0) {
        // Empty list: replace with a fresh *scratch* text view.
        registry.push({
          view: createView({
            kind: 'text',
            name: '*scratch*',
            buffer: createBuffer('', { name: '*scratch*' }),
          }),
          mode: null,
          lineCount: 1,
          file: null,
          modified: false,
        });
        currentIndex = 0;
      } else if (wasCurrent) {
        currentIndex = Math.min(idx, registry.length - 1);
      } else if (idx < currentIndex) {
        currentIndex -= 1;
      }
    },
    nextView: () => null, // unused by the menu tests
    previousView: () => null,
    findViewByName: (name) => registry[findIndexByName(name)]?.view ?? null,
    listViewRecords: () => registry.map(recordFor),
  };

  const interpreter = createInterpreter({
    primitives: {
      ...createBufferPrimitives(session),
      ...createViewPrimitives(viewHost),
      // Filler primitives so the rest of the standard library can load.
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
      'toggle-fold-at-point!': () => NIL,
      'fold-all!': () => NIL,
      'unfold-all!': () => NIL,
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
    currentName: () => registry[currentIndex].view.name,
    currentBuffer: () => registry[currentIndex].view.buffer,
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
    view: createView({
      kind: 'text',
      name: 'late.txt',
      buffer: createBuffer('', { name: 'late.txt' }),
    }),
    mode: null,
    lineCount: 1,
    file: null,
    modified: false,
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
  editor.interpreter.evaluate('(switch-to-view! "beta.txt")');
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
