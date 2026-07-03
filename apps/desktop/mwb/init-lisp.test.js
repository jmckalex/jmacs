/**
 * @file The spine evaluates the user's custom.lisp + init.lisp at startup.
 *
 * Both were dropped when the renderer Lisp interpreter was deleted; only
 * custom.lisp came back, and TOO EARLY — before the `languages/*.lisp` modes and
 * their defcustoms load, so a saved value for a language-file defcustom was
 * silently dropped and init.lisp never ran at all. This pins the fix: both files
 * are evaluated at the END of boot, after every mode + defcustom is declared, so
 * a saved value or a free-form form (e.g. `(register-mode ".md" jmarkdown-mode)`,
 * which needs the late-defined `jmarkdown-mode`) takes effect.
 *
 * CONFIG_HOME is read from MWB_CONFIG_HOME at MODULE LOAD, so we point it at a
 * temp dir BEFORE dynamically importing spine.js. `createSpine` reads the config
 * files fresh on each construction, so each test writes its own config.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'godot-init-lisp-'));
process.env.MWB_CONFIG_HOME = HOME;
const { createSpine } = await import('./spine.js');
after(() => {
  delete process.env.MWB_CONFIG_HOME;
  rmSync(HOME, { recursive: true, force: true });
});

const INIT = join(HOME, 'init.lisp');
const CUSTOM = join(HOME, 'custom.lisp');

/** Write (or, for null, remove) the two config files, then build a spine over an
 *  initial buffer named NAME. */
function spineWith({ init = null, custom = null }, name = 'notes.md') {
  if (init === null) rmSync(INIT, { force: true }); else writeFileSync(INIT, init, 'utf8');
  if (custom === null) rmSync(CUSTOM, { force: true }); else writeFileSync(CUSTOM, custom, 'utf8');
  return createSpine({ initialText: '', name, initialPath: null }, {});
}

test('init.lisp is evaluated: (register-mode ".md" jmarkdown-mode) opens .md in JMarkdown', () => {
  // jmarkdown-mode is defined in languages/jmarkdown.lisp, which loads late — so
  // this ALSO proves init.lisp runs after the languages, not at the old spot.
  const spine = spineWith({ init: '(register-mode ".md" jmarkdown-mode)\n' });
  assert.match(spine.viewState().modeline, /\(JMarkdown\)/);
});

test('without an override, .md keeps the stdlib default (Markdown)', () => {
  const spine = spineWith({ init: ';; nothing to override here\n' });
  assert.match(spine.viewState().modeline, /\(Markdown\)/);
});

test('custom.lisp is evaluated late too — it can set a language-file mode/defcustom', () => {
  // Put the (late-symbol) registration in custom.lisp with NO init.lisp: it only
  // resolves because custom.lisp now runs after the languages load.
  const spine = spineWith({ custom: '(register-mode ".md" jmarkdown-mode)\n' });
  assert.match(spine.viewState().modeline, /\(JMarkdown\)/);
});

test('init.lisp runs AFTER custom.lisp — its registration wins (documented order)', () => {
  // register-mode prepends, and the later registration is matched first. custom
  // says JMarkdown, init overrides back to markdown-mode: Markdown proves init
  // ran last.
  const spine = spineWith({
    custom: '(register-mode ".md" jmarkdown-mode)\n',
    init: '(register-mode ".md" markdown-mode)\n',
  });
  assert.match(spine.viewState().modeline, /\(Markdown\)/);
});

test('a broken init.lisp is reported, not fatal — the spine still boots', () => {
  let spine;
  assert.doesNotThrow(() => {
    spine = spineWith({ init: '(no-such-function-at-all 1 2 3)\n' });
  });
  // Boot completed past the bad config: the initial buffer still got its mode.
  assert.match(spine.viewState().modeline, /\(Markdown\)/);
});

test('first run with no init.lisp seeds a commented template', () => {
  spineWith({ init: null }); // removes INIT; createSpine should re-create it
  assert.match(readFileSync(INIT, 'utf8'), /init\.lisp — your Godot configuration/);
});
