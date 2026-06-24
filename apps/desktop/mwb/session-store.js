/**
 * @file The named-session store (Model B session manager).
 *
 * Replaces the single flat `{ files, active }` session with a store of NAMED
 * sessions plus a reserved auto-snapshot. The on-disk shape (one atomic file):
 *
 *   {
 *     "version": 3,
 *     "sessions": [ <entry>, ... ],     // the user's labelled saves
 *     "lastSession": <entry | null>     // the always-on "⚨ Last session" snapshot
 *   }
 *
 * An ENTRY:
 *
 *   { "id": "sess-…" | "__last__",
 *     "label": "Chapter 7 rewrite",     // "" for the auto-snapshot / unlabelled
 *     "savedAt": 1750000000000,         // epoch ms
 *     "windows": [ <window-blob>, ... ],// each: { rootPane, bounds, display }
 *     "activeWindow": 0 }
 *
 * A window-blob's `rootPane` is exactly `pane-model.js`'s `serialiseLayout`
 * output (a path-keyed pane tree); `bounds`/`display` are the saved window frame
 * + the display it sat on (for `window-geometry.js`'s reconcile). This module is
 * agnostic to the window-blob internals — it just stores and lists them.
 *
 * IO is injected (`read`/`write`) so the store is unit-testable with an
 * in-memory buffer; the server wires `read = () => readFileSync(path)` and
 * `write = (s) => atomicWriteSync(path, s)`. Tolerant: an unreadable / malformed
 * file yields an empty store (the editor must never refuse to start over a
 * stray session file); an old flat `{ files, active }` is migrated into the
 * `lastSession` slot.
 */

import { randomUUID } from 'node:crypto';

const emptyModel = () => ({ version: 3, sessions: [], lastSession: null });

/** Is E a structurally-valid session entry (enough to keep)? */
function isEntry(e) {
  return !!e && typeof e === 'object' && typeof e.id === 'string' && Array.isArray(e.windows);
}

/**
 * Convert an old flat `{ files, active }` session into a single-window v3
 * window-session: one leaf presenting a tabline of the files (active = the index
 * of `active`), no geometry (restore default-places it). Returns
 * `{ windows, activeWindow }` or null when there are no files.
 *
 * @param {{files?: string[], active?: string|null}} flat
 * @returns {{windows: object[], activeWindow: number}|null}
 */
export function flatToWindowSession(flat) {
  const files = Array.isArray(flat.files)
    ? flat.files.filter((p) => typeof p === 'string' && p !== '')
    : [];
  if (files.length === 0) return null;
  const active = typeof flat.active === 'string' ? flat.active : null;
  const activeIdx = active == null ? 0 : Math.max(0, files.indexOf(active));
  const tabs = files.map((path) => ({ kind: 'text', path, point: 0, mark: null }));
  const window = {
    rootPane: { kind: 'leaf', focused: true, view: { kind: 'tabline', active: activeIdx, tabs } },
    bounds: null,
    display: null,
  };
  return { windows: [window], activeWindow: 0 };
}

/**
 * Build the named-session store over an injected IO pair.
 *
 * @param {object} io
 * @param {() => string|null} io.read - Read the store file's contents (or null).
 * @param {(text: string) => void} io.write - Write the store file (atomically).
 * @param {() => number} [io.now] - Clock (epoch ms). Defaults to `Date.now`.
 * @param {() => string} [io.mintId] - Fresh id source. Defaults to `randomUUID`.
 */
export function createSessionStore({ read, write, now = Date.now, mintId = randomUUID }) {
  let model = load();

  function load() {
    let raw;
    try { raw = read(); } catch { raw = null; }
    if (typeof raw !== 'string' || raw === '') return emptyModel();
    let data;
    try { data = JSON.parse(raw); } catch { return emptyModel(); }
    if (!data || typeof data !== 'object') return emptyModel();
    if (Array.isArray(data.sessions)) {
      return {
        version: 3,
        sessions: data.sessions.filter(isEntry),
        lastSession: isEntry(data.lastSession) ? data.lastSession : null,
      };
    }
    // Old flat { files, active } → migrate into the lastSession slot.
    if (Array.isArray(data.files)) {
      const win = flatToWindowSession(data);
      return {
        version: 3,
        sessions: [],
        lastSession: win ? { id: '__last__', label: '', savedAt: now(), ...win } : null,
      };
    }
    return emptyModel();
  }

  function persist() {
    try { write(JSON.stringify(model)); } catch { /* a session write must never disturb editing */ }
  }

  /** The chooser payload: a slim list of saved sessions + whether a last-session
   *  snapshot exists. */
  function list() {
    return {
      sessions: model.sessions.map((s) => ({
        id: s.id,
        label: s.label,
        savedAt: s.savedAt,
        windowCount: Array.isArray(s.windows) ? s.windows.length : 0,
      })),
      hasLast: !!model.lastSession,
    };
  }

  /** The full entry for ID (`'__last__'` for the auto-snapshot), or null. */
  function get(id) {
    if (id === '__last__') return model.lastSession;
    return model.sessions.find((s) => s.id === id) ?? null;
  }

  /** Save a new NAMED session; returns its fresh id. */
  function save({ label, windows, activeWindow }) {
    const id = `sess-${mintId()}`;
    model.sessions.push({
      id,
      label: typeof label === 'string' ? label : '',
      savedAt: now(),
      windows: Array.isArray(windows) ? windows : [],
      activeWindow: Number.isFinite(activeWindow) ? activeWindow : 0,
    });
    persist();
    return id;
  }

  /** Overwrite the reserved "last session" auto-snapshot. */
  function writeLast({ windows, activeWindow }) {
    model.lastSession = {
      id: '__last__',
      label: '',
      savedAt: now(),
      windows: Array.isArray(windows) ? windows : [],
      activeWindow: Number.isFinite(activeWindow) ? activeWindow : 0,
    };
    persist();
  }

  /** Delete a saved session (or clear the last-session snapshot). Returns
   *  whether anything was removed. */
  function remove(id) {
    if (id === '__last__') {
      if (!model.lastSession) return false;
      model.lastSession = null;
      persist();
      return true;
    }
    const i = model.sessions.findIndex((s) => s.id === id);
    if (i < 0) return false;
    model.sessions.splice(i, 1);
    persist();
    return true;
  }

  return { list, get, save, writeLast, remove };
}
