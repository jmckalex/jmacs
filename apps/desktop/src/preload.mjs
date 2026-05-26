/**
 * @file Preload script. Runs in an isolated context with access to
 * Electron IPC, and exposes a small, explicit `host` API to the
 * renderer through the context bridge. The renderer gets exactly these
 * functions and nothing else — no `require`, no `fs`.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { homedir } from 'node:os';

contextBridge.exposeInMainWorld('host', {
  /** The current user's home directory — used by the renderer to
   *  expand `~/…` paths a user types from the REPL into something the
   *  filesystem and `file://` URL scheme will accept. */
  homeDirectory: homedir(),

  /**
   * Show an open dialog and read the chosen file. The shape of the
   * result depends on the file's suffix:
   *   - image: `{ path, name, imageSrc }` (a `data:` URL)
   *   - audio: `{ path, name, mediaKind: 'audio', src, metadata?,
   *              albumArtSrc? }` — `src` is a `media://` URL the
   *              `<audio>` element streams from
   *   - video: `{ path, name, mediaKind: 'video', src }`
   *   - text:  `{ path, name, content }`
   * @returns {Promise<object | null>}
   */
  openFile: () => ipcRenderer.invoke('file:open'),

  /**
   * Read a file by an explicit path — no dialog. Same routing as
   * `openFile` above.
   * @param {string} path
   * @returns {Promise<object | null>}
   */
  openFilePath: (path) => ipcRenderer.invoke('file:open-path', { path }),

  /**
   * Save content to a file. With a null path, prompts for one.
   * @param {string | null} path
   * @param {string} content
   * @returns {Promise<{path: string, name: string} | null>}
   */
  saveFile: (path, content) => ipcRenderer.invoke('file:save', { path, content }),

  /** Quit the application. */
  quit: () => ipcRenderer.send('app:quit'),

  /**
   * List a directory's non-hidden entries, sorted alphabetically. Returns
   * null when the path cannot be read.
   * @param {string} path
   * @returns {Promise<string[] | null>}
   */
  listDirectory: (path) => ipcRenderer.invoke('directory:list', { path }),

  /**
   * Show a directory-only open dialog. Returns the chosen path or null.
   * @returns {Promise<string | null>}
   */
  openDirectory: () => ipcRenderer.invoke('directory:open'),

  /**
   * The same listing, synchronously — the Lisp interpreter is
   * synchronous, so jukebox-mode reaches the filesystem this way.
   * @param {string} path
   * @returns {string[] | null}
   */
  listDirectorySync: (path) => ipcRenderer.sendSync('directory:list-sync', { path }),

  /**
   * Render JMarkdown `source` to HTML by running `command` (a shell
   * command) with the source on stdin.
   * @param {string} command
   * @param {string} source
   * @returns {Promise<{html: string} | {error: string}>}
   */
  renderJMarkdown: (command, source) =>
    ipcRenderer.invoke('jmarkdown:render', { command, source }),

  /**
   * Read a file's companion metadata (sticky notes), or null.
   * @param {string} path - The file's own path.
   * @returns {Promise<object | null>}
   */
  readMetadata: (path) => ipcRenderer.invoke('metadata:read', { path }),

  /**
   * Write a file's companion metadata.
   * @param {string} path - The file's own path.
   * @param {object} data
   */
  writeMetadata: (path, data) =>
    ipcRenderer.invoke('metadata:write', { path, data }),

  /**
   * Send the current buffer's mode menu to the main process, which
   * rebuilds the application menu around it. Pass null for no menu.
   * @param {{label: string, items: object[]} | null} menu
   */
  setModeMenu: (menu) => ipcRenderer.send('menu:set', menu),

  /**
   * Register a handler for a command chosen from a native menu.
   * @param {(command: string) => void} callback
   */
  onMenuCommand: (callback) =>
    ipcRenderer.on('menu:invoke', (_event, command) => callback(command)),

  /**
   * Read a user config file (e.g. `custom.lisp`, `init.lisp`) from the
   * per-user data directory, or null when it does not exist.
   * @param {string} name - A bare filename.
   * @returns {Promise<string | null>}
   */
  readConfigFile: (name) => ipcRenderer.invoke('config:read', { name }),

  /**
   * Write a user config file to the per-user data directory.
   * @param {string} name - A bare filename.
   * @param {string} content
   */
  writeConfigFile: (name, content) =>
    ipcRenderer.invoke('config:write', { name, content }),

  /**
   * Read the persisted splitter pane sizes, or null when none have
   * been saved yet. The shape is `{ previewWidth?: number,
   * replHeight?: number }`.
   * @returns {Promise<{previewWidth?: number, replHeight?: number} | null>}
   */
  readPanes: () => ipcRenderer.invoke('panes:read'),

  /**
   * Persist the splitter pane sizes.
   * @param {{previewWidth?: number, replHeight?: number}} data
   */
  writePanes: (data) => ipcRenderer.invoke('panes:write', { data }),

  /**
   * Read the face-overrides JSON file (`<userData>/faces.json`).
   * Returns `{ global, themes }` or `null` when no file exists yet.
   */
  readFaces: () => ipcRenderer.invoke('faces:read'),

  /**
   * Write the face-overrides JSON file. `data` must be the same
   * shape that `readFaces` returns: `{ global, themes }`.
   * @param {{global: object, themes: object}} data
   */
  writeFaces: (data) => ipcRenderer.invoke('faces:write', { data }),

  /**
   * Read the persisted session JSON written on last quit. Returns the
   * parsed object (the shape produced by `session.js`'s `serialise`),
   * or null when there is no saved session.
   * @returns {Promise<object | null>}
   */
  readSession: () => ipcRenderer.invoke('session:read'),

  /**
   * Write the persisted session JSON. Called debounced on buffer-list
   * changes and on pagehide.
   * @param {object} data - The shape produced by `serialise`.
   */
  writeSession: (data) => ipcRenderer.invoke('session:write', { data }),

  /**
   * Read the documentation manifest (the list of doc-page names
   * produced by `pnpm run docs`). Returns `{ names: string[] }` or
   * `null` when the docs haven't been built yet.
   */
  readDocManifest: () => ipcRenderer.invoke('doc:manifest'),

  /**
   * Read the rendered HTML of a doc page by name. Returns
   * `{ name, path, html }` or `null` when the name is unknown.
   * @param {string} name
   */
  readDocPage: (name) => ipcRenderer.invoke('doc:read', { name }),

  /**
   * Read the embedded album art from an audio file. Returns
   * `{ mime, dataUrl }` (the `dataUrl` is ready for `<img src>`) or
   * `null` when the format is unsupported, the file is unreadable,
   * or no art is present. Used by the jukebox view.
   * @param {string} path
   * @returns {Promise<{ mime: string, dataUrl: string } | null>}
   */
  audioAlbumArt: (path) => ipcRenderer.invoke('audio:album-art', { path }),

  /**
   * Read an audio file's embedded tag metadata. Returns
   * `{ title, artist, album, track, year, genre, duration }` (with
   * `null` for any field that the tag did not carry) or `null` when
   * the format is unsupported, the file is unreadable, or no
   * recognised tag block is present.
   * @param {string} path
   * @returns {Promise<{
   *   title: string | null,
   *   artist: string | null,
   *   album: string | null,
   *   track: number | null,
   *   year: number | null,
   *   genre: string | null,
   *   duration: number | null,
   * } | null>}
   */
  audioMetadata: (path) => ipcRenderer.invoke('audio:metadata', { path }),

  /**
   * The same metadata, synchronously — the Lisp interpreter is
   * synchronous, so the `(audio-metadata path)` primitive reaches
   * the filesystem this way. Mirrors `listDirectorySync`.
   * @param {string} path
   */
  audioMetadataSync: (path) =>
    ipcRenderer.sendSync('audio:metadata-sync', { path }),

  /**
   * Replace the tag metadata on `path` with `fields`. The host parses
   * the file, mutates the in-memory model, and atomically rewrites
   * the file. Returns `{ ok: true }` on success or `{ ok: false,
   * error }` on any failure (unsupported format, read-only file,
   * malformed input). Synchronous — same reason as
   * `audioMetadataSync`.
   *
   * @param {string} path
   * @param {object} fields
   */
  audioMetadataWriteSync: (path, fields) =>
    ipcRenderer.sendSync('audio:metadata-write-sync', { path, fields }),
});
