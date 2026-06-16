/**
 * @file Preload script. Runs in an isolated context with access to
 * Electron IPC, and exposes a small, explicit `host` API to the
 * renderer through the context bridge. The renderer gets exactly these
 * functions and nothing else — no `require`, no `fs`.
 */

import { contextBridge, ipcRenderer, clipboard } from 'electron';
import { homedir } from 'node:os';

contextBridge.exposeInMainWorld('host', {
  /** The current user's home directory — used by the renderer to
   *  expand `~/…` paths a user types from the REPL into something the
   *  filesystem and `file://` URL scheme will accept. */
  homeDirectory: homedir(),

  /** The editor's per-user data directory (`app.getPath('userData')`),
   *  resolved once at preload time over a synchronous IPC call. The
   *  snippet engine reads `<userDataDirectory>/snippets`. Empty string
   *  when the main process can't resolve it. */
  userDataDirectory: (() => {
    try {
      const dir = ipcRenderer.sendSync('userdata:dir-sync');
      return typeof dir === 'string' ? dir : '';
    } catch {
      return '';
    }
  })(),

  /** Read the system clipboard's plain text, synchronously. Electron's
   *  `clipboard` module works in the preload (sandbox is off); the
   *  renderer's kill ring reads this so C-y / yank can paste text copied
   *  in another app (Emacs's interprogram-paste). Returns '' when empty. */
  clipboardReadText: () => clipboard.readText(),

  /** Write TEXT to the system clipboard, synchronously. The kill ring
   *  mirrors every kill/copy here (interprogram-cut) so editor kills are
   *  pasteable in other apps. */
  clipboardWriteText: (text) => clipboard.writeText(String(text ?? '')),

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
   *
   * If the file changed on disk since it was last read or written, the
   * save is held and the result is `{ conflict: true, path, name }`
   * instead of being written — unless `options.force` is true, the user's
   * explicit "overwrite anyway".
   *
   * @param {string | null} path
   * @param {string} content
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<{path: string, name: string} | {conflict: true, path: string, name: string} | null>}
   */
  saveFile: (path, content, options) =>
    ipcRenderer.invoke('file:save', {
      path,
      content,
      force: options?.force === true,
    }),

  /**
   * Rename / move a file. Returns `{ ok, path? error? }` so the caller
   * can surface failures (name collisions are the common one).
   * @param {string} from
   * @param {string} to
   */
  renameFile: (from, to) => ipcRenderer.invoke('file:rename', { from, to }),

  /**
   * Move a file or directory to the OS trash (recoverable).
   * @param {string} path
   */
  trashFile: (path) => ipcRenderer.invoke('file:trash', { path }),

  /**
   * Reveal a file in the OS file browser (Finder on macOS).
   * @param {string} path
   */
  revealInFolder: (path) => ipcRenderer.send('file:reveal', { path }),

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
   * A typed sync listing of `path`: each entry is `{ name, kind }`
   * with `kind` ∈ `'directory' | 'file' | 'other'`. Folders sort
   * before files. The directory tree-view uses this to render the
   * right icon and know which rows expand. Returns null on read
   * failure (unreadable path, missing directory).
   *
   * @param {string} path
   * @returns {Array<{name: string, kind: 'directory' | 'file' | 'other'}> | null}
   */
  listDirectoryDetailedSync: (path) =>
    ipcRenderer.sendSync('directory:list-detailed-sync', { path }),

  /**
   * Synchronous text-file read. Returns the file's UTF-8 contents, or
   * null when the path is unreadable / missing. Used by Lisp
   * primitives that need file content inline (e.g.
   * `(load-bibliography path)`).
   * @param {string} path
   * @returns {string | null}
   */
  readFileTextSync: (path) =>
    ipcRenderer.sendSync('file:read-text-sync', { path }),

  /**
   * Vouch for a specific file so the `__host__` route will serve it,
   * allowing its real directory (symlinks resolved). Used before fetching
   * a file the editor was explicitly pointed at whose real location lies
   * outside an already-opened folder (e.g. bib-search's symlinked
   * bibliography). Returns true.
   * @param {string} path
   * @returns {boolean}
   */
  allowHostFile: (path) =>
    ipcRenderer.sendSync('host:allow-file-sync', { path }),

  /**
   * Synchronous existence check. Returns `true` when `path` (tilde-
   * expanded host-side) names an existing file or directory, `false`
   * otherwise. The Lisp interpreter is synchronous, so the
   * `(file-exists? path)` primitive reaches the filesystem this way —
   * the same `sendSync` pattern as `readFileTextSync`.
   * @param {string} path
   * @returns {boolean}
   */
  fileExistsSync: (path) =>
    ipcRenderer.sendSync('file:exists-sync', { path }),

  /**
   * A directory listing with per-entry type info — each result is
   * `{ name, type }` where `type` is `"directory"` or `"file"`.
   * Find-file's tab-completion uses this synchronously.
   * @param {string} path
   * @returns {{name: string, type: 'directory' | 'file'}[] | null}
   */
  listDirectoryWithTypesSync: (path) =>
    ipcRenderer.sendSync('directory:list-with-types-sync', { path }),

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
   * Register a handler invoked when a native Quit (Cmd+Q / app-menu
   * Quit) is requested. The main process holds the quit until the
   * renderer responds, so the handler should run its unsaved-changes
   * confirm + flush and then call `quit()` to proceed — or do nothing
   * to cancel.
   * @param {() => void} callback
   */
  onConfirmQuit: (callback) =>
    ipcRenderer.on('app:confirm-quit', () => callback()),

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
   * Write a crash-recovery snapshot for one dirty buffer. `record` is
   * `{ key, path, name, text, savedAt, hash }`; `key` identifies the
   * buffer (its abs path, or an id for a path-less buffer).
   * @param {object} record
   */
  writeRecovery: (record) => ipcRenderer.invoke('recovery:write', { record }),

  /**
   * List every recovery snapshot, each enriched with `diskExists` /
   * `diskModified`. Called once on startup to offer recovery.
   * @returns {Promise<object[]>}
   */
  listRecovery: () => ipcRenderer.invoke('recovery:list'),

  /**
   * Delete one buffer's recovery snapshot (on a successful save).
   * @param {string} key
   */
  deleteRecovery: (key) => ipcRenderer.invoke('recovery:delete', { key }),

  /** Remove every recovery snapshot (on a clean confirmed quit). */
  clearRecovery: () => ipcRenderer.invoke('recovery:clear'),

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

  /**
   * Spawn a child process running the user's default shell ($SHELL,
   * falling back to /bin/zsh). The session id is renderer-generated;
   * the host keeps it in its session table so subsequent writes /
   * signals / kills can find the same process.
   *
   * Stdout and stderr stream back through `onShellData` (registered
   * below). On process exit `onShellExit` fires with the code and
   * signal. The shell runs with plain pipes (no PTY), so curses
   * applications (`vi`, `top`, `less`) will misbehave — that's a
   * documented v1 limit.
   *
   * @param {string} sessionId
   * @param {object} [options]
   * @param {string} [options.cwd]
   * @returns {Promise<{ ok: boolean, shell?: string, pid?: number, pty?: boolean, error?: string }>}
   */
  shellSpawn: (sessionId, options = {}) =>
    ipcRenderer.invoke('shell:spawn', { sessionId, cwd: options.cwd }),

  /**
   * Write `data` to a shell session's stdin. The caller is responsible
   * for any trailing newline — the shell only acts on a line when it
   * sees one. Returns `{ ok: true }` on a successful write,
   * `{ ok: false }` when the process has already exited.
   *
   * @param {string} sessionId
   * @param {string} data
   */
  shellWrite: (sessionId, data) =>
    ipcRenderer.invoke('shell:write', { sessionId, data }),

  /**
   * Send a signal (default SIGINT) to a shell session's child — this
   * is what C-c on a running command does. Returns `{ ok: boolean }`.
   *
   * @param {string} sessionId
   * @param {string} [signal]
   */
  shellSignal: (sessionId, signal) =>
    ipcRenderer.invoke('shell:signal', { sessionId, signal }),

  /**
   * Close the shell's stdin. The shell sees EOF and exits, which
   * fires `onShellExit`. This is what C-d at an empty input line
   * does — the conventional way to end a shell session.
   *
   * @param {string} sessionId
   */
  shellEndInput: (sessionId) =>
    ipcRenderer.invoke('shell:end-input', { sessionId }),

  /**
   * Terminate a shell session — kill the child and forget the entry.
   * Called from `kill-buffer!` when a shell buffer is removed.
   *
   * @param {string} sessionId
   */
  shellKill: (sessionId) =>
    ipcRenderer.invoke('shell:kill', { sessionId }),

  /**
   * Tell a shell session its new terminal size. Routes
   * `<cols>:<rows>\n` to the python helper's fd 3 sidechannel, which
   * calls `ioctl(master, TIOCSWINSZ, ...)`. The kernel raises
   * SIGWINCH inside the shell so prompts and TUIs reflow. No-op
   * under the pipe fallback (no master to resize).
   *
   * @param {string} sessionId
   * @param {number} cols
   * @param {number} rows
   */
  shellResize: (sessionId, cols, rows) =>
    ipcRenderer.invoke('shell:resize', { sessionId, cols, rows }),

  /**
   * Register a handler for streamed shell output. The handler is
   * invoked with `{ sessionId, stream: 'stdout' | 'stderr', data }`
   * for each chunk the child emits.
   *
   * Returns an unsubscribe function — the view calls it on destroy.
   *
   * @param {(payload: { sessionId: string, stream: string, data: string }) => void} callback
   * @returns {() => void}
   */
  onShellData: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('shell:data', handler);
    return () => ipcRenderer.removeListener('shell:data', handler);
  },

  /**
   * Register a handler for shell-process exits. Fires once per session,
   * after which writes/signals to that id no-op.
   *
   * Returns an unsubscribe function.
   *
   * @param {(payload: { sessionId: string, code: number | null, signal: string | null }) => void} callback
   * @returns {() => void}
   */
  onShellExit: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('shell:exit', handler);
    return () => ipcRenderer.removeListener('shell:exit', handler);
  },

  // --- general process runner ------------------------------------------
  //
  // A one-shot child process: spawn a program with an explicit argv in
  // an optional cwd, buffer its output, and report the result through
  // `onRunProcessExit` when it exits. The host spawns with NO shell
  // interpretation (no `shell: true`). This is the foundation for the
  // AUCTeX compile/view loop; it is otherwise general-purpose.

  /**
   * Spawn a one-shot child process. The `runId` is renderer-generated
   * and ties the spawn to its later `process:exit` event. Returns
   * `{ ok }` immediately; the buffered output arrives via
   * `onRunProcessExit`.
   *
   * @param {string} runId
   * @param {string} program
   * @param {string[]} args
   * @param {{ cwd?: string }} [opts]
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  runProcess: (runId, program, args, opts = {}) =>
    ipcRenderer.invoke('process:run', {
      runId,
      program,
      args,
      cwd: opts?.cwd,
    }),

  /**
   * Kill a running process by id (SIGTERM). Its `onRunProcessExit`
   * still fires with whatever output was buffered.
   *
   * @param {string} runId
   * @returns {Promise<{ ok: boolean }>}
   */
  runProcessKill: (runId) =>
    ipcRenderer.invoke('process:kill', { runId }),

  /**
   * Register a handler for one-shot process exits. Fires once per
   * run with `{ runId, stdout, stderr, code }` — `code` is null when
   * the process was killed by a signal or failed to spawn.
   *
   * Returns an unsubscribe function.
   *
   * @param {(payload: { runId: string, stdout: string, stderr: string, code: number | null }) => void} callback
   * @returns {() => void}
   */
  onRunProcessExit: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('process:exit', handler);
    return () => ipcRenderer.removeListener('process:exit', handler);
  },

  // --- gnuplot ---------------------------------------------------------
  //
  // A gnuplot view is a notebook REPL over one long-lived `gnuplot`
  // child. The renderer generates the session id; the host frames each
  // submitted command, routes the plot to a temp SVG, and sends one
  // `gnuplot:result` per submission. A missing gnuplot binary surfaces
  // via `onGnuplotExit` with `notInstalled: true`.

  /**
   * Spawn a long-lived gnuplot process for `sessionId`. Returns
   * `{ ok }` immediately; a missing gnuplot binary surfaces later
   * through `onGnuplotExit` with `notInstalled: true` rather than as a
   * spawn error (spawn doesn't throw for ENOENT).
   *
   * @param {string} sessionId
   * @param {object} [options]
   * @param {string} [options.cwd]
   * @returns {Promise<{ ok: boolean, pid?: number, error?: string }>}
   */
  gnuplotSpawn: (sessionId, options = {}) =>
    ipcRenderer.invoke('gnuplot:spawn', { sessionId, cwd: options.cwd }),

  /**
   * Submit a gnuplot command. The host appends the protocol epilogue
   * and the newline; the caller passes just the command line(s). The
   * result arrives asynchronously via `onGnuplotResult`.
   *
   * @param {string} sessionId
   * @param {string} data
   * @returns {Promise<{ ok: boolean }>}
   */
  gnuplotWrite: (sessionId, data) =>
    ipcRenderer.invoke('gnuplot:write', { sessionId, data }),

  /**
   * Send SIGINT to a gnuplot session — interrupts a long-running plot.
   *
   * @param {string} sessionId
   * @returns {Promise<{ ok: boolean }>}
   */
  gnuplotSignal: (sessionId) =>
    ipcRenderer.invoke('gnuplot:signal', { sessionId }),

  /**
   * Terminate a gnuplot session — kill the child and forget the entry.
   * Called from the kill-view path when a gnuplot buffer is removed.
   *
   * @param {string} sessionId
   * @returns {Promise<{ ok: boolean }>}
   */
  gnuplotKill: (sessionId) =>
    ipcRenderer.invoke('gnuplot:kill', { sessionId }),

  /**
   * Save a plot's SVG via a native Save dialog (suggests a .svg name).
   * @param {string} svg
   * @param {string} name
   * @returns {Promise<{ path: string } | null>}
   */
  gnuplotSaveSvg: (svg, name) =>
    ipcRenderer.invoke('gnuplot:save-svg', { svg, name }),

  /**
   * Set a gnuplot session's plot theme (e.g. 'dark' | 'light'). Affects
   * subsequent plots in that session.
   * @param {string} sessionId
   * @param {string} theme
   * @returns {Promise<{ ok: boolean }>}
   */
  gnuplotSetTheme: (sessionId, theme) =>
    ipcRenderer.invoke('gnuplot:set-theme', { sessionId, theme }),

  /**
   * Register a handler for per-submission gnuplot results. Fires once
   * per submitted command with
   * `{ sessionId, id, svg, text, error }` — `svg` is the plot markup
   * (or null if the command produced no plot), `text` is stdout output,
   * `error` is stderr output.
   *
   * Returns an unsubscribe function.
   *
   * @param {(payload: { sessionId: string, id: number, svg: string|null, text: string, error: string }) => void} callback
   * @returns {() => void}
   */
  onGnuplotResult: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('gnuplot:result', handler);
    return () => ipcRenderer.removeListener('gnuplot:result', handler);
  },

  /**
   * Register a handler for gnuplot process exits and not-installed
   * events. Payload carries `{ sessionId, code, signal }` and, when
   * gnuplot isn't installed, `{ notInstalled: true, message }`.
   *
   * Returns an unsubscribe function.
   *
   * @param {(payload: { sessionId: string, code: number|null, signal: string|null, notInstalled?: boolean, message?: string }) => void} callback
   * @returns {() => void}
   */
  onGnuplotExit: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('gnuplot:exit', handler);
    return () => ipcRenderer.removeListener('gnuplot:exit', handler);
  },
});
