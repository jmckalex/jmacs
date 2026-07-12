/**
 * @file The user configuration home — where Godot keeps its hand-editable
 * config (custom.lisp, init.lisp, faces.json, panes.json, session.json,
 * projects-index.json and the recovery/ and snippets/ directories).
 *
 * This is deliberately SEPARATE from Electron's `app.getPath('userData')`.
 * userData is where Chromium parks its caches, cookies, GPU blobs and the
 * like — tens of MB of opaque machinery — and we don't want our half-dozen
 * small, user-editable config files buried in there. Godot's config home is
 * `~/.godot` (after Emacs's `~/.emacs.d`), overridable with the GODOT_HOME
 * environment variable (handy for test isolation and throwaway profiles).
 *
 * Pure Node — no electron import — so it is unit-testable. The main process
 * resolves the legacy userData dir and hands it to `setupConfigHome` for a
 * one-time migration; everything else just reads `configHomePath()`.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The config entries Godot owns and will migrate. Everything else in the
 * legacy userData dir (Cache/, Cookies, GPUCache/, Local Storage/, …) is
 * Chromium's and is deliberately left behind. Files and directories both —
 * `cpSync` with `recursive` copies either.
 * @type {readonly string[]}
 */
export const CONFIG_ENTRIES = Object.freeze([
  'custom.lisp',
  'init.lisp',
  'faces.json',
  'panes.json',
  'session.json',
  'projects-index.json',
  'recovery',
  'snippets',
]);

/**
 * The config home path: `$GODOT_HOME` when set and non-empty, else `~/.godot`.
 * Pure — no side effects — so it is safe to call from anywhere that just needs
 * the directory (e.g. the file-IPC handlers).
 * @returns {string}
 */
export function configHomePath() {
  const override = process.env.GODOT_HOME;
  if (typeof override === 'string' && override.length > 0) return override;
  return join(homedir(), '.godot');
}

/**
 * Ensure the config home directory exists, returning its path.
 * @returns {string}
 */
export function ensureConfigHome() {
  const home = configHomePath();
  mkdirSync(home, { recursive: true });
  return home;
}

/**
 * One-time migration: copy each known config entry from LEGACYDIR into the
 * config home when it is present in LEGACYDIR and absent in the home.
 * Non-destructive (the legacy copies stay in place as a backup) and
 * idempotent per entry. Does nothing when LEGACYDIR is missing, falsy, or is
 * the home itself.
 *
 * @param {string} legacyDir  The old config location (Electron userData).
 * @param {string} [home]     The config home (defaults to `configHomePath()`).
 * @returns {string[]}        The entry names actually copied.
 */
export function migrateLegacyConfig(legacyDir, home = configHomePath()) {
  if (!legacyDir || legacyDir === home || !existsSync(legacyDir)) return [];
  const copied = [];
  for (const name of CONFIG_ENTRIES) {
    const src = join(legacyDir, name);
    const dest = join(home, name);
    if (existsSync(src) && !existsSync(dest)) {
      cpSync(src, dest, { recursive: true });
      copied.push(name);
    }
  }
  return copied;
}

/**
 * Resolve and create the config home, migrating config from LEGACYDIR on the
 * FIRST run only (when the home did not already exist). Returns the home path.
 * The first-run gate means a config file the user later deletes is not
 * silently resurrected from the legacy dir on the next launch.
 *
 * @param {string} [legacyDir]  The old config location to migrate from.
 * @returns {string}            The config home path.
 */
export function setupConfigHome(legacyDir) {
  const home = configHomePath();
  const fresh = !existsSync(home);
  mkdirSync(home, { recursive: true });
  if (fresh) migrateLegacyConfig(legacyDir, home);
  return home;
}
