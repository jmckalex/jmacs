/**
 * @file Main-process file handling. The renderer is sandboxed and has
 * no filesystem access, so opening and saving files happens here and is
 * reached over IPC (see `preload.mjs`).
 */

import { app, dialog, ipcMain, shell } from 'electron';
import {
  existsSync,
  readdirSync,
  readFileSync as nodeReadFileSync,
  readlinkSync,
  statSync,
} from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWrite } from './atomic-write.js';
import { createChangeTracker } from './external-change.js';
import {
  RECOVERY_DIR_NAME,
  recoveryFileName,
  parseRecoveryRecord,
} from './recovery.js';

// Tracks the on-disk (mtime, size) of files we have read or written, so a
// save can refuse to silently clobber a file another program changed
// underneath us. See external-change.js.
const changeTracker = createChangeTracker();
import { extractAlbumArt } from './audio-art.js';
import { extractMetadata, extractMetadataSync } from './audio-metadata.js';
import { writeMetadataSync as writeAudioMetadataSync } from './audio-metadata-write.js';
import { hostFileUrl, allowHostDir, allowHostFile } from './serve.js';
import { resolveBdskFile } from './bdsk-file.js';
import {
  metadataPath,
  legacyMetadataPath,
  isEmptyMetadata,
  METADATA_VERSION,
} from './metadata.js';

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

// The companion-metadata path scheme + emptiness rule live in metadata.js.

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

/** PDF suffix the open path should route to the pdf view. A Set for
 *  symmetry with the audio / video sets; the renderer's `isPdfName`
 *  twin lives in `packages/renderer/src/pdf-view.js`. */
const PDF_SUFFIXES = new Set(['.pdf']);

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

/** Whether PATH names a PDF the open path should route to the pdf
 *  view. Mirrors `isPdfName` in `@editor/renderer`; the main process
 *  keeps its own copy because it cannot import the renderer package. */
function isPdfPath(filePath) {
  if (typeof filePath !== 'string') return false;
  return PDF_SUFFIXES.has(extname(filePath).toLowerCase());
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

/** The directory holding crash-recovery snapshots — one JSON file per
 *  dirty buffer, inside the per-user data directory. */
function recoveryDir() {
  return join(app.getPath('userData'), RECOVERY_DIR_NAME);
}

/** Refuse to base64 an image larger than this into the renderer as a
 *  project thumbnail — a sanity cap, not a meaningful image limit. */
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

/** A project's per-directory save-state file. Unlike session.json (which
 *  is global, in userData), a project's state travels with the project:
 *  it lives in a `.godot/` folder inside the project root, so moving or
 *  copying the directory carries the open-file layout with it. ROOT must
 *  be a non-empty absolute path; anything else returns null and the
 *  caller treats the project as having no saved state. */
function projectStatePath(root) {
  if (typeof root !== 'string' || root === '' || !root.startsWith('/')) {
    return null;
  }
  return join(root, '.godot', 'project.json');
}

/** The central index of known projects — a small JSON file in the
 *  per-user data directory, listing each project's path + display name
 *  (most-recently-opened first). It holds no project state itself; it is
 *  the future Project Chooser's catalogue. */
function projectIndexPath() {
  return join(app.getPath('userData'), 'projects-index.json');
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
 * - `{ path, name, pdfKind: true, src }` for a `.pdf` suffix.
 * - `{ path, name, content }` for anything else.
 *
 * The renderer's `openFileInteractive` switches on `imageSrc` /
 * `mediaKind` / `pdfKind` to pick the right view; the text path is
 * the fallback.
 *
 * @param {string} path - An absolute filesystem path.
 * @returns {Promise<object>}
 */
async function readPathAsBuffer(path) {
  // Opening a file vouches for its folder: the `__host__` route may serve
  // from it (the preview's relative images, the PDF view). The renderer
  // can't widen this set itself, so a malicious doc can't read elsewhere.
  allowHostDir(dirname(path));
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
  if (isPdfPath(path)) {
    // PDFs ride the `app://editor/__host__/...` same-origin route
    // (see serve.js): PDF.js uses fetch() and Chromium refuses
    // cross-origin fetches for non-allowlisted schemes (custom schemes
    // like media:// can't be CORS targets, regardless of any flag).
    // Audio / video / images keep using media:// because they go
    // through their HTML elements' loaders, which aren't fetch.
    return {
      path,
      name: basename(path),
      pdfKind: true,
      src: hostFileUrl(path),
    };
  }
  const content = await readFile(path, 'utf8');
  // Record the on-disk baseline for these savable text buffers, so a later
  // save can detect an external change. (Re-opening the same path — e.g. a
  // reload — re-notes it and clears any stale conflict.)
  await changeTracker.note(path);
  return { path, name: basename(path), content };
}

/**
 * Describe one directory entry for the typed listings the directory
 * views consume. For a plain entry, returns `{name, kind}`. For a
 * symlink, follows the link with `statSync` to learn the target's
 * kind and reads the link target with `readlinkSync`, so the view can
 * render the row with the right icon plus an overlay arrow and show
 * the target on hover. A dangling link comes back as
 * `{kind: 'other', isSymlink: true, target, broken: true}`.
 *
 * @param {string} parentPath - Absolute directory the entry lives in.
 * @param {import('node:fs').Dirent} entry - From `readdirSync(... withFileTypes: true)`.
 */
function describeEntry(parentPath, entry) {
  if (!entry.isSymbolicLink()) {
    return {
      name: entry.name,
      kind: entry.isDirectory()
        ? 'directory'
        : entry.isFile() ? 'file' : 'other',
    };
  }
  const fullPath = join(parentPath, entry.name);
  let target = '';
  try { target = readlinkSync(fullPath); } catch { /* ignore */ }
  // `statSync` follows the link; `throwIfNoEntry: false` returns
  // undefined for a dangling link instead of throwing. A different
  // error (EACCES on a protected target, ELOOP on a cycle) is treated
  // as "broken enough not to render" — same outcome from the user's
  // perspective.
  let targetStat;
  try {
    targetStat = statSync(fullPath, { throwIfNoEntry: false });
  } catch { /* fall through to broken */ }
  if (!targetStat) {
    return { name: entry.name, kind: 'other', isSymlink: true, target, broken: true };
  }
  const kind = targetStat.isDirectory()
    ? 'directory'
    : targetStat.isFile() ? 'file' : 'other';
  return { name: entry.name, kind, isSymlink: true, target };
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
  //
  // Before overwriting, check whether the file changed on disk since we
  // last read or wrote it. If so — and the caller hasn't passed
  // `force` — hold the save and report `{ conflict: true }` so the
  // renderer can ask the user, rather than silently clobbering another
  // program's change. `force: true` is the user's explicit "overwrite".
  ipcMain.handle('file:save', async (_event, payload) => {
    let target = payload?.path ?? null;
    if (target === null) {
      const result = await dialog.showSaveDialog({});
      if (result.canceled || !result.filePath) {
        return null;
      }
      target = result.filePath;
    }
    if (payload?.force !== true && (await changeTracker.changedSinceNoted(target))) {
      return { conflict: true, path: target, name: basename(target) };
    }
    // Atomic write: a crash mid-save must never truncate the user's file.
    await atomicWrite(target, payload?.content ?? '', 'utf8');
    // The buffer and disk now agree: re-baseline so the next save isn't
    // wrongly flagged.
    await changeTracker.note(target);
    return { path: target, name: basename(target) };
  });

  // Save a gnuplot plot's SVG via a Save dialog (suggests a .svg name).
  ipcMain.handle('gnuplot:save-svg', async (_event, payload) => {
    const result = await dialog.showSaveDialog({
      defaultPath: payload?.name || 'plot.svg',
      filters: [{ name: 'SVG image', extensions: ['svg'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await atomicWrite(result.filePath, payload?.svg ?? '', 'utf8');
    return { path: result.filePath };
  });

  // Read a file's companion metadata (sticky notes, bookmarks, …).
  // Prefers the hidden `.NAME.godot-metadata`; falls back to the legacy
  // visible `NAME.jmacs-metadata` so pre-rename data still loads (it
  // migrates to the new file on the next write). Returns parsed JSON, or
  // null when neither candidate exists or is readable.
  ipcMain.handle('metadata:read', async (_event, payload) => {
    const path = payload?.path;
    if (typeof path !== 'string') return null;
    for (const target of [metadataPath(path), legacyMetadataPath(path)]) {
      try {
        return JSON.parse(await readFile(target, 'utf8'));
      } catch {
        // Try the next candidate.
      }
    }
    return null;
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

  // A typed sync listing — same dot-filter and alphabetical sort as
  // the bare listing, but each entry comes back as
  // `{ name, kind: 'directory' | 'file' | 'other' }`. The directory
  // tree-view uses this to know which icon (folder vs file) to show
  // and which entries can be expanded.
  // Synchronous text-file read. Lisp primitives are synchronous, so a
  // command like `(load-bibliography "~/refs.bib")` needs to fetch the
  // file content in-line. Returns the UTF-8 string contents, or null
  // when the path is unreadable / missing. The path is tilde-expanded.
  ipcMain.on('file:read-text-sync', (event, payload) => {
    try {
      const target = expandTilde(payload?.path);
      // readFileSync via the imported promise API isn't sync; use the
      // synchronous fs counterpart. (We import `readFileSync` lazily
      // to keep the import block clean.)
      event.returnValue = nodeReadFileSync(target, 'utf8');
    } catch {
      event.returnValue = null;
    }
  });

  // Vouch for a specific file the renderer is about to fetch over the
  // `__host__` route (e.g. bib-search loading a document's bibliography),
  // allowing its real directory so a symlink to a shared `.bib` outside
  // the document's folder is reachable. The path is tilde-expanded.
  ipcMain.on('host:allow-file-sync', (event, payload) => {
    try {
      allowHostFile(expandTilde(payload?.path));
      event.returnValue = true;
    } catch {
      event.returnValue = false;
    }
  });

  // The per-user data directory, synchronously — preload resolves it
  // once at startup and exposes it as `host.userDataDirectory`. The
  // snippet engine reads `<userData>/snippets`. `app.getPath('userData')`
  // is only available in the main process, hence this bridge.
  ipcMain.on('userdata:dir-sync', (event) => {
    try {
      event.returnValue = app.getPath('userData');
    } catch {
      event.returnValue = '';
    }
  });

  // Synchronous existence check — returns true when the (tilde-expanded)
  // path names an existing file or directory. The Lisp interpreter is
  // synchronous, so the `(file-exists? path)` primitive reaches the
  // filesystem here, mirroring `file:read-text-sync`. RefTeX uses it to
  // skip \input chains whose target files are absent.
  ipcMain.on('file:exists-sync', (event, payload) => {
    try {
      event.returnValue = existsSync(expandTilde(payload?.path));
    } catch {
      event.returnValue = false;
    }
  });

  ipcMain.on('directory:list-detailed-sync', (event, payload) => {
    try {
      const dirPath = expandTilde(payload?.path);
      const entries = readdirSync(dirPath, { withFileTypes: true });
      event.returnValue = entries
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => describeEntry(dirPath, entry))
        .sort((a, b) => {
          // Folders first, then files; within each group alphabetical.
          // A symlink's sort group follows its target's kind — a link
          // to a folder sorts with folders, matching what the user sees
          // when they click it.
          if (a.kind !== b.kind) {
            if (a.kind === 'directory') return -1;
            if (b.kind === 'directory') return 1;
          }
          return a.name.localeCompare(b.name);
        });
    } catch {
      event.returnValue = null;
    }
  });

  // The same listing with type info — each entry carries whether it is
  // a file or a directory. Find-file's tab-completion uses this to add
  // a trailing "/" to directory completions (and so to descend into
  // them as the user types). Returns null when the path cannot be read.
  ipcMain.on('directory:list-with-types-sync', (event, payload) => {
    try {
      const entries = readdirSync(expandTilde(payload?.path), {
        withFileTypes: true,
      });
      event.returnValue = entries
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      event.returnValue = null;
    }
  });

  // Write a file's companion metadata to the hidden `.NAME.godot-metadata`.
  // An empty payload (no notes, no bookmarks, …) removes the file rather
  // than leaving a husk. Either way the pre-rename legacy sidecar is
  // retired, completing the migration on the first write.
  ipcMain.handle('metadata:write', async (_event, payload) => {
    const path = payload?.path;
    if (typeof path !== 'string') return { removed: true };
    const target = metadataPath(path);
    const legacy = legacyMetadataPath(path);
    const data = payload?.data ?? {};
    if (isEmptyMetadata(data)) {
      await rm(target, { force: true });
      await rm(legacy, { force: true });
      return { path: target, removed: true };
    }
    // Route the versioned writer (with legacy cleanup) through the
    // crash-safe atomic writer — the data-safety reconciliation: a crash
    // mid-write must never truncate a file's sticky-note / bookmark sidecar.
    await atomicWrite(
      target,
      JSON.stringify({ version: METADATA_VERSION, ...data }, null, 2),
      'utf8'
    );
    await rm(legacy, { force: true });
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
    await atomicWrite(target, payload?.content ?? '', 'utf8');
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
    await atomicWrite(panesPath(), JSON.stringify(data, null, 2), 'utf8');
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

  // Face customisation: write `<userData>/faces.json`. Written through
  // atomicWrite (temp + fsync + rename) so a crash mid-write can't
  // corrupt the file and lose every face override at once.
  ipcMain.handle('faces:write', async (_event, payload) => {
    const target = configPath('faces.json');
    if (target === null) throw new Error('invalid faces target');
    const data = payload?.data ?? { global: {}, themes: {} };
    await atomicWrite(target, JSON.stringify(data, null, 2), 'utf8');
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
    await atomicWrite(target, JSON.stringify(data, null, 2), 'utf8');
    return { path: target };
  });

  // Per-project save-state: read <root>/.godot/project.json. Returns the
  // parsed object, or null when the project has never been saved (its
  // first open) or the file is unreadable. Same shape as session.json
  // (a v2 pane-tree blob) — the renderer reuses the session serialiser.
  ipcMain.handle('project:read', async (_event, payload) => {
    const target = projectStatePath(payload?.root);
    if (target === null) return null;
    try {
      const content = await readFile(target, 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  });

  // Per-project save-state: write <root>/.godot/project.json. Creates the
  // `.godot/` folder if absent; the write is atomic (temp + fsync +
  // rename) so a crash mid-write can't corrupt the project's layout.
  ipcMain.handle('project:write', async (_event, payload) => {
    const target = projectStatePath(payload?.root);
    if (target === null) throw new Error('project:write needs an absolute root');
    await mkdir(dirname(target), { recursive: true });
    const data = payload?.data ?? {};
    await atomicWrite(target, JSON.stringify(data, null, 2), 'utf8');
    return { path: target };
  });

  // Central project index: read the catalogue of known projects. Returns
  // the parsed object (`{ projects: [{ path, name }] }`) or null when no
  // project has been opened yet.
  ipcMain.handle('project:index-read', async () => {
    try {
      const content = await readFile(projectIndexPath(), 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  });

  // Central project index: write the catalogue. Overwritten in full so
  // the shape stays predictable; the renderer passes the whole object.
  ipcMain.handle('project:index-write', async (_event, payload) => {
    const data = payload?.data ?? { projects: [] };
    await atomicWrite(projectIndexPath(), JSON.stringify(data, null, 2), 'utf8');
    return { path: projectIndexPath() };
  });

  // Choose a custom thumbnail image for a project tile in the chooser.
  // Returns the chosen absolute path, or null when cancelled.
  ipcMain.handle('project:pick-image', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a project thumbnail',
      properties: ['openFile'],
      filters: [
        // Mirror IMAGE_MIME_TYPES — only formats project:thumbnail can read
        // back as a data URL (others would silently fall back to a letter
        // tile after the user picked them).
        {
          name: 'Images',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'],
        },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Read a project thumbnail image as a data: URL for the chooser's tile.
  // Thumbnails are small, so a base64 data URL (no serve-route allowlisting)
  // is the simplest fit. Returns null when the path isn't a readable image,
  // or is implausibly large for a thumbnail (guards against base64-ing a
  // huge file into the renderer).
  ipcMain.handle('project:thumbnail', async (_event, payload) => {
    const path = payload?.path;
    if (typeof path !== 'string' || path === '') return null;
    const mime = imageMimeType(path);
    if (mime === null) return null;
    try {
      const st = statSync(path, { throwIfNoEntry: false });
      if (!st || !st.isFile() || st.size > MAX_THUMBNAIL_BYTES) return null;
      return await readImageDataUrl(path, mime);
    } catch {
      return null;
    }
  });

  // Crash-recovery snapshots — one JSON file per dirty buffer, written
  // atomically into <userData>/recovery/. The renderer's autosave
  // controller drives these (write on edit/blur, delete on save, clear
  // on a clean quit); see recovery.js.
  ipcMain.handle('recovery:write', async (_event, payload) => {
    const record = payload?.record;
    if (!record || typeof record.key !== 'string' || record.key === '') {
      throw new Error('recovery:write needs a record with a non-empty key');
    }
    const dir = recoveryDir();
    await mkdir(dir, { recursive: true });
    const target = join(dir, recoveryFileName(record.key));
    await atomicWrite(target, JSON.stringify(record, null, 2), 'utf8');
    return { path: target };
  });

  // List every recovery snapshot, each enriched with the state of its
  // on-disk file (so the renderer can tell a still-relevant snapshot from
  // one the user already saved over): `diskExists` and `diskModified`
  // (mtime ms, or null). A path-less buffer has no on-disk file. A
  // missing recovery dir or a corrupt snapshot file is skipped, never
  // fatal — the editor must always be able to start.
  ipcMain.handle('recovery:list', async () => {
    let names;
    try {
      names = await readdir(recoveryDir());
    } catch {
      return [];
    }
    const records = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let record;
      try {
        const text = await readFile(join(recoveryDir(), name), 'utf8');
        record = parseRecoveryRecord(JSON.parse(text));
      } catch {
        continue;
      }
      if (!record) continue;
      if (record.path) {
        try {
          const info = await stat(record.path);
          record.diskExists = true;
          record.diskModified = info.mtimeMs;
        } catch {
          record.diskExists = false;
          record.diskModified = null;
        }
      } else {
        record.diskExists = false;
        record.diskModified = null;
      }
      records.push(record);
    }
    return records;
  });

  // Delete one buffer's recovery snapshot (on a successful save).
  ipcMain.handle('recovery:delete', async (_event, payload) => {
    const key = payload?.key;
    if (typeof key !== 'string' || key === '') return { removed: false };
    await rm(join(recoveryDir(), recoveryFileName(key)), { force: true });
    return { removed: true };
  });

  // Remove every recovery snapshot (on a clean confirmed quit).
  ipcMain.handle('recovery:clear', async () => {
    await rm(recoveryDir(), { recursive: true, force: true });
    return { cleared: true };
  });

  // Documentation: read the manifest produced by `pnpm run docs`.
  // Returns { names: [...] } or null when no manifest exists yet.
  ipcMain.handle('doc:manifest', async () => {
    const map = await loadDocManifest();
    if (map === null) return null;
    // New shape: { functions (flat name→path), nodes (id→node), top,
    // roots, order }. Old shape (back-compat): a flat name→path map.
    // `roots` must survive this handoff — the doc-view renders one
    // sidebar entry per root (manual + reference tiers + guide); when
    // it is missing the view falls back to showing `top` alone.
    if (map.functions && map.nodes) {
      return {
        names: Object.keys(map.functions),
        nodes: map.nodes,
        top: map.top ?? null,
        roots: Array.isArray(map.roots) ? map.roots : [],
        order: Array.isArray(map.order) ? map.order : [],
      };
    }
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
    // Resolve a function name OR a navigation node id to a relative path.
    const relPath = (map.functions && map.nodes)
      ? (map.functions[name] ?? map.nodes[name]?.path)
      : map[name];
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

  // Rename / move a file or directory. Returns `{ ok, path?, error? }`
  // so the renderer can surface the failure (a name collision is the
  // common one). Used by the directory-view context menus' Rename
  // action; the `to` path is computed renderer-side from the user's
  // input on the old basename.
  ipcMain.handle('file:rename', async (_event, payload) => {
    const from = payload?.from;
    const to = payload?.to;
    if (typeof from !== 'string' || typeof to !== 'string') {
      return { ok: false, error: 'invalid arguments' };
    }
    try {
      await rename(from, to);
      return { ok: true, path: to };
    } catch (error) {
      return { ok: false, error: error.message ?? String(error) };
    }
  });

  // Move a file or directory to the OS trash (not a hard delete — the
  // user can recover it from Trash / Recycle Bin). Returns `{ ok }`.
  ipcMain.handle('file:trash', async (_event, payload) => {
    const target = payload?.path;
    if (typeof target !== 'string') {
      return { ok: false, error: 'invalid path' };
    }
    try {
      await shell.trashItem(target);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message ?? String(error) };
    }
  });

  // Open the OS file browser focused on a file (or its parent
  // directory). On macOS this opens Finder with the item highlighted;
  // on Windows / Linux the equivalent file manager. Synchronous —
  // shell.showItemInFolder returns void.
  ipcMain.on('file:reveal', (_event, payload) => {
    const target = payload?.path;
    if (typeof target !== 'string' || target === '') return;
    shell.showItemInFolder(target);
  });

  // Resolve a BibDesk `Bdsk-File-N` value (base64) to its real PDF path and
  // open it in the OS default app. bib-search uses this to make an entry's
  // title a "click to open the PDF" link. The bookmark is resolved natively
  // (inode-tracked, survives moves) with the plist's `relativePath` as
  // fallback, anchored to `bibPath`'s real directory. Returns
  // `{ ok, path?, error? }`.
  ipcMain.handle('bdsk:open', async (_event, payload) => {
    const bdsk = payload?.bdsk;
    const bibPath = payload?.bibPath;
    if (typeof bdsk !== 'string' || bdsk === '') {
      return { ok: false, error: 'no attachment' };
    }
    let path = null;
    try {
      path = await resolveBdskFile(bdsk, typeof bibPath === 'string' ? bibPath : undefined);
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
    if (!path) return { ok: false, error: 'file not found' };
    const failure = await shell.openPath(path); // '' on success
    if (failure) return { ok: false, path, error: failure };
    return { ok: true, path };
  });
}
