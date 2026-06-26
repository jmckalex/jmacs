/**
 * @file Model-B data-source registry — the source-of-truth analogue of a text
 * buffer, generalised to NON-TEXT views.
 *
 * THE IDEA (Jason): a text BUFFER is the shared source of truth fanned out to
 * every view of it — that is what makes "the same file edits in lockstep across
 * two windows" work. That is not a *text* pattern; it is the general one. A
 * DATA-SOURCE is the same idea for any view kind: the server owns it, fans its
 * state out to every viewing client, and each view keeps its OWN per-view UI
 * state.
 *
 *   - image / video / pdf / audio — an IMMUTABLE data-source (a kind + a file
 *     path). Fan-out is a one-shot: the content never changes, so there is no
 *     `setState`; the file path is all a view needs (the bytes load client-side
 *     via the main process's `openFilePath`).
 *   - stella / jukebox (LATER) — a MUTABLE non-text data-source: the loaded ROM
 *     / song is shared state that, when it changes, must fan out so a duplicate
 *     view of the SAME source stays in sync (the non-text equivalent of lockstep
 *     editing). The `setState` + `onStateChange` seam below is defined for that
 *     and is UNUSED by media; it lights up when those views graduate. Per-view
 *     runtime (a live emulator frame, playback position) stays per-view — the
 *     data-source owns the loadable/selection state, not the live runtime.
 *
 * Text buffers stay in `buffer-registry.js` (the existing, well-tested case);
 * this registry sits BESIDE it, sharing the id-space via a distinct `ds` prefix
 * so the pane model / tabs / open-set machinery treats a data-source id like any
 * other view id. DOM-free, Electron-free, interpreter-free → unit-testable.
 */

/**
 * @typedef {object} DataSource
 * @property {string} id - Unique, `ds`-prefixed (distinct from buffer `b…` ids).
 * @property {string} kind - The view kind: 'image' | 'audio' | 'video' | 'pdf'
 *   (later 'stella' | 'jukebox' | …).
 * @property {string} name - Display name (modeline / tab label).
 * @property {string|null} filePath - The file this source loads from, or null.
 * @property {object} state - Kind-specific SHARED state. Empty/immutable for
 *   media; the mutable-source seam writes here via setState + fans the change.
 */

/**
 * Create a data-source registry.
 *
 * @param {object} [hooks]
 * @param {(id: string, source: DataSource) => void} [hooks.onStateChange] - The
 *   fan-out seam: called when a source's shared state changes (setState). Unused
 *   by media; a mutable source (stella/jukebox) wires this to re-push the source
 *   to every viewing client. Defaults to a no-op.
 * @returns {object}
 */
export function createDataSourceRegistry(hooks = {}) {
  const onStateChange = typeof hooks.onStateChange === 'function'
    ? hooks.onStateChange
    : () => {};

  /** @type {Map<string, DataSource>} insertion-ordered. */
  const sources = new Map();
  let nextId = 0;
  const freshId = () => `ds${(nextId += 1)}`;

  /**
   * Add a data-source. Returns its record. Media callers pass a kind + name +
   * filePath (immutable); a mutable source may seed `state`.
   *
   * @param {{ kind: string, name?: string, filePath?: string|null, state?: object }} spec
   * @returns {DataSource}
   */
  function add({ kind, name, filePath = null, state } = {}) {
    const id = freshId();
    const source = {
      id,
      kind: String(kind),
      name: typeof name === 'string' && name !== '' ? name : `*${kind}*`,
      filePath: typeof filePath === 'string' && filePath !== '' ? filePath : null,
      state: state ?? {},
    };
    sources.set(id, source);
    return source;
  }

  /** The source for ID, or null. */
  function get(id) {
    return sources.get(id) ?? null;
  }

  /** Whether ID names a live data-source. */
  function has(id) {
    return sources.has(id);
  }

  /** Every source, in insertion order. */
  function list() {
    return [...sources.values()];
  }

  /** Drop a source (its views close). Returns whether one was removed. */
  function remove(id) {
    return sources.delete(id);
  }

  /** Find a source by its absolute file path (find-file reuse — re-visiting an
   *  already-open media file SWITCHES to it rather than opening a duplicate,
   *  exactly like a text buffer). Path-less sources never match. */
  function findByPath(filePath) {
    if (typeof filePath !== 'string' || filePath === '') return null;
    for (const s of sources.values()) {
      if (s.filePath === filePath) return s;
    }
    return null;
  }

  /**
   * SEAM (unused until mutable sources graduate): replace a source's shared
   * state and fan the change to viewing clients. Media never calls this (the
   * content is immutable); stella/jukebox will, to sync a loaded ROM/song across
   * duplicate views. Returns whether the source exists.
   *
   * @param {string} id
   * @param {object} state
   * @returns {boolean}
   */
  function setState(id, state) {
    const s = sources.get(id);
    if (!s) return false;
    s.state = state ?? {};
    onStateChange(id, s);
    return true;
  }

  /**
   * The wire descriptor a client needs to render a source (its kind + name +
   * file path + shared state). The PANE_TREE leaf carries this for a data-source
   * leaf; the client mounts the matching element-view and loads the bytes itself.
   *
   * @param {string} id
   * @returns {{ viewKind: string, name: string, filePath: string|null, state: object }|null}
   */
  function descriptor(id) {
    const s = sources.get(id);
    if (!s) return null;
    return { viewKind: s.kind, name: s.name, filePath: s.filePath, state: s.state };
  }

  return { add, get, has, list, remove, findByPath, setState, descriptor };
}
