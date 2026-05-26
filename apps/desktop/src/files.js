/**
 * @file Main-process file handling. The renderer is sandboxed and has
 * no filesystem access, so opening and saving files happens here and is
 * reached over IPC (see `preload.mjs`).
 */

import { app, dialog, ipcMain } from 'electron';
import { readdirSync } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractAlbumArt } from './audio-art.js';
import { extractMetadata, extractMetadataSync } from './audio-metadata.js';
import { writeMetadataSync as writeAudioMetadataSync } from './audio-metadata-write.js';

/**
 * Expand a leading `~` (or `~/…`) to the current user's home directory.
 * Paths a user types from the REPL (e.g. `(jukebox "~/Music/foo")`)
 * arrive verbatim — Node does not do the shell's tilde expansion. Used
 * by every IPC handler that touches a user-supplied path.
 *
 * @param {string} path
 * @returns {string}
 */
function expandTilde(path) {
  if (typeof path !== 'string') return path;
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

// apps/desktop/src/files.js → repository root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const docsBuildDir = join(repoRoot, 'docs', 'build');

/** Cached parse of docs/build/manifest.json, refreshed when mtime
 *  changes. `null` = unloaded; `false` = manifest does not exist. */
let docManifestCache = null;
let docManifestMtimeMs = 0;

/**
 * Read (and cache) the documentation manifest produced by
 * `pnpm run docs`. Returns the parsed object, or `null` when the
 * manifest doesn't exist yet (docs haven't been built).
 */
async function loadDocManifest() {
  const path = join(docsBuildDir, 'manifest.json');
  try {
    const info = await stat(path);
    if (
      docManifestCache &&
      docManifestCache !== false &&
      info.mtimeMs === docManifestMtimeMs
    ) {
      return docManifestCache;
    }
    const raw = await readFile(path, 'utf8');
    docManifestCache = JSON.parse(raw);
    docManifestMtimeMs = info.mtimeMs;
    return docManifestCache;
  } catch {
    docManifestCache = false;
    docManifestMtimeMs = 0;
    return null;
  }
}

/** The companion file holding a file's jmacs metadata (sticky notes). */
const metadataPath = (filePath) => `${filePath}.jmacs-metadata`;

/** Image file suffixes → MIME type. A file with one of these suffixes
 *  is read as binary and returned as a `data:` URL, so the renderer can
 *  show the image instead of its bytes. */
const IMAGE_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

/** Audio file suffixes the open path should route to the audio view.
 *  Mirrors `AUDIO_MIME_TYPES` in `packages/renderer/src/media-view.js`;
 *  the main process keeps its own copy because it cannot import the
 *  renderer package. */
const AUDIO_SUFFIXES = new Set([
  '.mp3', '.flac', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.opus',
]);

/** Video file suffixes the open path should route to the video view.
 *  Same shape as `AUDIO_SUFFIXES`. */
const VIDEO_SUFFIXES = new Set([
  '.mp4', '.m4v', '.webm', '.mov', '.mkv',
]);

/** The image MIME type for a path, by its suffix, or `null` when the
 *  path is not a recognised image. The renderer's `mimeTypeForImage`
 *  (in `@editor/renderer`) is the unit-tested twin of this logic; this
 *  copy stays here because the main process cannot import the renderer
 *  package. The pair is exercised end-to-end by the smoke test. */
function imageMimeType(filePath) {
  if (typeof filePath !== 'string') return null;
  return IMAGE_MIME_TYPES[extname(filePath).toLowerCase()] ?? null;
}

/** `'audio' | 'video' | null` for a path, by its suffix. Tells the
 *  open path which non-text view (if any) should mount instead of
 *  reading the file as UTF-8. */
function mediaKindFor(filePath) {
  if (typeof filePath !== 'string') return null;
  const suffix = extname(filePath).toLowerCase();
  if (AUDIO_SUFFIXES.has(suffix)) return 'audio';
  if (VIDEO_SUFFIXES.has(suffix)) return 'video';
  return null;
}

/** Build a `media://localhost/...` URL the renderer can fetch through
 *  the main process's media-scheme handler. Per-segment encoding so
 *  spaces and unicode in a path survive. */
function mediaUrl(filePath) {
  return (
    'media://localhost' +
    filePath.split('/').map(encodeURIComponent).join('/')
  );
}

/**
 * Read an image file as a `data:` URL.
 *
 * @param {string} filePath
 * @param {string} mime - The image's MIME type.
 * @returns {Promise<string>}
 */
async function readImageDataUrl(filePath, mime) {
  const data = await readFile(filePath);
  return `data:${mime};base64,${data.toString('base64')}`;
}

/** A config file lives in the per-user data directory; its name is a
 *  bare filename (no path separators), resolved against that directory. */
function configPath(name) {
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name)) return null;
  return join(app.getPath('userData'), name);
}

/** Where the splitter pane sizes are persisted — a small JSON file in
 *  the per-user data directory. Separate from custom.lisp because it
 *  is host UI state, not a Lisp customisation: the renderer reads it
 *  before the standard library is even loaded. */
function panesPath() {
  return join(app.getPath('userData'), 'panes.json');
}

/** Where the persistent-session payload is written. A bare filename
 *  inside the per-user data directory, so it sits next to custom.lisp
 *  and init.lisp. */
const sessionFileName = 'session.json';
function sessionPath() {
  return join(app.getPath('userData'), sessionFileName);
}

/**
 * Read PATH and shape it for whichever buffer kind the renderer should
 * mount. Returns:
 *
 * - `{ path, name, imageSrc }` for an image suffix.
 * - `{ path, name, mediaKind: 'audio', src, metadata?, albumArtSrc? }`
 *   for an audio suffix — `metadata` and `albumArtSrc` are best-effort;
 *   either may be absent if the file carries no recognised tag block.
 * - `{ path, name, mediaKind: 'video', src }` for a video suffix.
 * - `{ path, name, content }` for anything else.
 *
 * The renderer's `openFileInteractive` switches on `imageSrc` /
 * `mediaKind` to pick the right view; the text path is the fallback.
 *
 * @param {string} path - An absolute filesystem path.
 * @returns {Promise<object>}
 */
async function readPathAsBuffer(path) {
  const imageMime = imageMimeType(path);
  if (imageMime !== null) {
    const imageSrc = await readImageDataUrl(path, imageMime);
    return { path, name: basename(path), imageSrc };
  }
  const mediaKind = mediaKindFor(path);
  if (mediaKind === 'audio') {
    const src = mediaUrl(path);
    // Tag metadata + album art are nice-to-haves; either can fail
    // (unsupported container, no tag block, malformed picture frame)
    // and the audio view still works without them.
    let metadata = null;
    try {
      metadata = await extractMetadata(path);
    } catch {
      metadata = null;
    }
    let albumArtSrc = null;
    try {
      const art = await extractAlbumArt(path);
      if (art) {
        albumArtSrc =
          `data:${art.mime};base64,${art.data.toString('base64')}`;
      }
    } catch {
      albumArtSrc = null;
    }
    return {
      path,
      name: basename(path),
      mediaKind,
      src,
      ...(metadata ? { metadata } : {}),
      ...(albumArtSrc ? { albumArtSrc } : {}),
    };
  }
  if (mediaKind === 'video') {
    return {
      path,
      name: basename(path),
      mediaKind,
      src: mediaUrl(path),
    };
  }
  const content = await readFile(path, 'utf8');
  return { path, name: basename(path), content };
}

/** Register the `file:*` IPC handlers. Call once, after the app is ready. */
export function registerFileHandlers() {
  // Show an open dialog and read the chosen file. An image file is
  // read as a `data:` URL (in `imageSrc`) so the renderer can display
  // it. An audio or video file comes back as `{ mediaKind, src,
  // metadata?, albumArtSrc? }`, where `src` is a `media://` URL the
  // renderer's <audio>/<video> element streams from. Any other file
  // is read as UTF-8 text (in `content`).
  ipcMain.handle('file:open', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const path = result.filePaths[0];
    return readPathAsBuffer(path);
  });

  // Open a file by an explicit path — no dialog. Mirrors `file:open`
  // for image / audio / video / text routing so callers from inside
  // the renderer (e.g. jukebox-mode's M-RET on the album-art file)
  // can hand a path to the same view-buffer pipeline `file:open`
  // feeds into.
  ipcMain.handle('file:open-path', async (_event, payload) => {
    const raw = payload?.path;
    if (typeof raw !== 'string' || raw === '') return null;
    try {
      return await readPathAsBuffer(expandTilde(raw));
    } catch {
      return null;
    }
  });

  // Show a directory-only open dialog. Used by jukebox-mode.
  ipcMain.handle('directory:open', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // Write content to a path; with no path, prompt for one first.
  ipcMain.handle('file:save', async (_event, payload) => {
    let target = payload?.path ?? null;
    if (target === null) {
      const result = await dialog.showSaveDialog({});
      if (result.canceled || !result.filePath) {
        return null;
      }
      target = result.filePath;
    }
    await writeFile(target, payload?.content ?? '', 'utf8');
    return { path: target, name: basename(target) };
  });

  // Read a file's companion metadata (sticky notes). Returns the parsed
  // JSON, or null when the companion file is absent or unreadable.
  ipcMain.handle('metadata:read', async (_event, payload) => {
    try {
      const content = await readFile(metadataPath(payload?.path), 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  });

  // List the (non-hidden) entries of a directory. Returns an array of
  // filenames or null when the path cannot be read — used by
  // jukebox-mode to discover audio files and album art.
  ipcMain.handle('directory:list', async (_event, payload) => {
    try {
      const entries = await readdir(expandTilde(payload?.path), {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return null;
    }
  });

  // The same listing, synchronously. The Lisp interpreter is synchronous,
  // so the jukebox-mode Lisp calls this directly to read a directory in
  // the middle of building its panel. Used sparingly — sync IPC blocks
  // the renderer thread.
  ipcMain.on('directory:list-sync', (event, payload) => {
    try {
      const entries = readdirSync(expandTilde(payload?.path), {
        withFileTypes: true,
      });
      event.returnValue = entries
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      event.returnValue = null;
    }
  });

  // Write a file's companion metadata. With no notes, the companion
  // file is removed rather than left as an empty husk.
  ipcMain.handle('metadata:write', async (_event, payload) => {
    const target = metadataPath(payload?.path);
    const data = payload?.data ?? {};
    const notes = Array.isArray(data.notes) ? data.notes : [];
    if (notes.length === 0) {
      await rm(target, { force: true });
      return { path: target, removed: true };
    }
    await writeFile(target, JSON.stringify(data, null, 2), 'utf8');
    return { path: target };
  });

  // Read a user config file (custom.lisp, init.lisp) from the per-user
  // data directory. Returns the text, or null when it does not exist.
  ipcMain.handle('config:read', async (_event, payload) => {
    const target = configPath(payload?.name);
    if (target === null) return null;
    try {
      return await readFile(target, 'utf8');
    } catch {
      return null;
    }
  });

  // Write a user config file to the per-user data directory.
  ipcMain.handle('config:write', async (_event, payload) => {
    const target = configPath(payload?.name);
    if (target === null) throw new Error('invalid config file name');
    await writeFile(target, payload?.content ?? '', 'utf8');
    return { path: target };
  });

  // Persisted splitter pane sizes (preview width, REPL height). Returns
  // the parsed object or null when the file does not exist. The shape
  // is `{ previewWidth: number, replHeight: number }`; either field
  // may be absent, in which case the renderer falls back to the CSS
  // default for that variable.
  ipcMain.handle('panes:read', async () => {
    try {
      const content = await readFile(panesPath(), 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  });

  // Persist the splitter pane sizes. Always overwritten in full so the
  // file shape stays predictable; callers pass the whole object.
  ipcMain.handle('panes:write', async (_event, payload) => {
    const data = payload?.data ?? {};
    await writeFile(panesPath(), JSON.stringify(data, null, 2), 'utf8');
    return { path: panesPath() };
  });

  // Face customisation: read `<userData>/faces.json`. Returns the
  // parsed JSON (a {global, themes} object) or null when no file
  // exists yet — the first launch has no overrides.
  ipcMain.handle('faces:read', async () => {
    const target = configPath('faces.json');
    if (target === null) return null;
    try {
      const text = await readFile(target, 'utf8');
      return JSON.parse(text);
    } catch {
      return null;
    }
  });

  // Face customisation: write `<userData>/faces.json`. Atomic-ish:
  // payload.data is JSON-serialised and written in one call. The
  // file is small (~few KB at most) so we don't bother with a
  // temp-file dance.
  ipcMain.handle('faces:write', async (_event, payload) => {
    const target = configPath('faces.json');
    if (target === null) throw new Error('invalid faces target');
    const data = payload?.data ?? { global: {}, themes: {} };
    await writeFile(target, JSON.stringify(data, null, 2), 'utf8');
    return { path: target };
  });

  // Persistent session: read the session JSON written on last quit.
  // Returns the parsed object, or null when the file is absent or
  // unreadable — a missing session is normal on first run.
  ipcMain.handle('session:read', async () => {
    try {
      const content = await readFile(sessionPath(), 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  });

  // Persistent session: write the session JSON. The renderer pickles
  // its buffer list (debounced + on pagehide) through this handler.
  ipcMain.handle('session:write', async (_event, payload) => {
    const target = sessionPath();
    const data = payload?.data ?? { buffers: [], currentPath: null };
    await writeFile(target, JSON.stringify(data, null, 2), 'utf8');
    return { path: target };
  });

  // Documentation: read the manifest produced by `pnpm run docs`.
  // Returns { names: [...] } or null when no manifest exists yet.
  ipcMain.handle('doc:manifest', async () => {
    const map = await loadDocManifest();
    if (map === null) return null;
    return { names: Object.keys(map) };
  });

  // Read the embedded album art from an audio file (MP3 ID3v2 APIC
  // or MP4 covr). Returns `{ mime, dataUrl }` ready for the
  // renderer to drop into an `<img src=...>`, or null when the file
  // is unsupported, unreadable, or carries no art. Used by the
  // jukebox view so a track without a sidecar cover.jpg still gets
  // its picture displayed.
  // Read an audio file's embedded tag metadata (title, artist, album,
  // track, year, genre, duration). Returns the shaped object or null
  // when the format is unsupported, the file is unreadable, or no
  // recognised tag block is present. Used by the jukebox to format
  // track-list rows from real tags rather than raw filenames.
  ipcMain.handle('audio:metadata', async (_event, payload) => {
    const raw = payload?.path;
    if (typeof raw !== 'string' || raw === '') return null;
    return extractMetadata(expandTilde(raw));
  });

  // The synchronous twin. The Lisp interpreter is synchronous, so the
  // (audio-metadata path) host primitive reaches the filesystem via
  // sendSync — the same pattern listDirectorySync uses. Metadata
  // extraction is small file IO so the latency is fine.
  ipcMain.on('audio:metadata-sync', (event, payload) => {
    const raw = payload?.path;
    if (typeof raw !== 'string' || raw === '') {
      event.returnValue = null;
      return;
    }
    event.returnValue = extractMetadataSync(expandTilde(raw));
  });

  // Replace the embedded tag metadata on `path` with `fields`. The
  // file is parsed, the in-memory model is rebuilt with the new
  // fields, then re-serialised and atomically renamed into place.
  // Cover art on the existing file is preserved unless `fields`
  // explicitly carries a `cover` entry. Synchronous for the same
  // Lisp-interpreter reason as `audio:metadata-sync`.
  ipcMain.on('audio:metadata-write-sync', (event, payload) => {
    const raw = payload?.path;
    if (typeof raw !== 'string' || raw === '') {
      event.returnValue = { ok: false, error: 'no path' };
      return;
    }
    const fields = (payload && typeof payload.fields === 'object')
      ? payload.fields
      : {};
    event.returnValue = writeAudioMetadataSync(expandTilde(raw), fields);
  });

  ipcMain.handle('audio:album-art', async (_event, payload) => {
    const raw = payload?.path;
    if (typeof raw !== 'string' || raw === '') return null;
    const path = expandTilde(raw);
    const art = await extractAlbumArt(path);
    if (!art) return null;
    return {
      mime: art.mime,
      dataUrl: `data:${art.mime};base64,${art.data.toString('base64')}`,
    };
  });

  // Documentation: read the rendered HTML for a doc page by name.
  // Returns { name, path, html } or null when the name is unknown
  // or the file can't be read.
  ipcMain.handle('doc:read', async (_event, payload) => {
    const map = await loadDocManifest();
    if (map === null) return null;
    const name = payload?.name;
    if (typeof name !== 'string') return null;
    const relPath = map[name];
    if (typeof relPath !== 'string') return null;
    const absPath = join(docsBuildDir, relPath);
    // Refuse to read outside docs/build/.
    if (!absPath.startsWith(docsBuildDir + '/')) return null;
    try {
      const html = await readFile(absPath, 'utf8');
      return { name, path: relPath, html };
    } catch {
      return null;
    }
  });
}
