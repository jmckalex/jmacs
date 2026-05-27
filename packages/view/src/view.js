/**
 * @file View — the addressable on-screen thing.
 *
 * A view is what a pane shows. Every view has:
 *
 *   - kind: a string discriminator ('text', 'image', 'shell', ...).
 *   - name: a human-readable label (the modeline name).
 *   - buffer: an L2 buffer for text-editing views, null otherwise.
 *
 * Kind-specific state (image src, jukebox track list, shell session
 * id, ...) lives directly on the view — `createView` accepts an
 * `extras` object whose fields are spread onto the result. The renderer
 * view modules read those fields the same way they used to read
 * `buffer.tracks`, `buffer.sessionId`, etc.
 *
 * The buffer-vs-extras split is exhaustive: text views edit text and
 * use a buffer; every other kind owns its own state directly on the
 * view and has no buffer.
 *
 * One special case: a **tabline-view** (`kind === 'tabline'`) is a
 * *structural* view that contains other views. Its extra fields are:
 *
 *   - `tabs`:   View[]            — the child views in display order.
 *   - `active`: number            — index into `tabs`.
 *   - `edge`:   'top' | 'right' | 'bottom' | 'left' — where the strip
 *               renders inside the pane.
 *
 * Tabline-views have no buffer and never appear in the global view list;
 * they live only inside pane handles. See plans/PANES-PHASE-3B.md.
 *
 * `createView` returns a plain mutable record — it's a small piece of
 * state shared by the desktop app, the kind registry and the Lisp
 * primitives. The shape is what matters; behaviour lives in the kind
 * registry.
 */

/** A unique-enough id for a freshly-minted view. */
let nextId = 1;
function freshId(kind) {
  const n = nextId;
  nextId += 1;
  return `view-${kind}-${n}`;
}

/**
 * Create a view.
 *
 * @param {object} options
 * @param {string} options.kind - The view's kind. Drives renderer
 *   dispatch and the life-cycle hooks the kind registry provides.
 * @param {string} [options.name] - The view's modeline name. Falls
 *   back to the buffer's name for text views, or a kind-derived
 *   placeholder otherwise.
 * @param {import('@editor/buffer').Buffer | null} [options.buffer] -
 *   The L2 buffer for text-editing views; `null` for everything else.
 * @param {object} [options.extras] - Kind-specific fields to spread
 *   onto the view (e.g. `{ src: '...', filePath: '...' }` for an
 *   image view; `{ sessionId, transcript }` for a shell view). The
 *   renderer view modules read these the same way they read the old
 *   buffer-record fields — they are the kind-specific state.
 * @param {*} [options.mode] - The view's own mode (only used by
 *   non-text kinds with their own mode-like behaviour). Text views
 *   resolve modes through the buffer; this slot is left null for them.
 * @returns {View}
 */
export function createView(options) {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('createView: options is required');
  }
  if (typeof options.kind !== 'string' || options.kind === '') {
    throw new TypeError('createView: kind is required (non-empty string)');
  }
  const view = {
    id: freshId(options.kind),
    kind: options.kind,
    name: options.name ?? null,
    buffer: options.buffer ?? null,
    mode: options.mode ?? null,
    ...(options.extras ?? {}),
  };
  // For text views the canonical name comes from the buffer; fall
  // back to it when the caller didn't supply one.
  if (view.name === null) {
    if (view.buffer && typeof view.buffer.name === 'string') {
      view.name = view.buffer.name;
    } else {
      view.name = `*${view.kind}*`;
    }
  }
  // Per-view-point: text views own their own cursor (point) and
  // selection anchor (mark). Two text views over the same buffer thus
  // have independent cursors. Non-text views leave these undefined.
  // The buffer holds only text, markers and edit history.
  //
  // Multi-cursor: the *canonical* storage is `view.cursors`, an array
  // of `{point, mark}` records; index 0 is the primary. `view.point`
  // and `view.mark` are aliases for `cursors[0].point` / `cursors[0].mark`
  // so every existing caller that reads or writes the primary still works.
  if (view.kind === 'text') {
    const initialPoint = typeof options.point === 'number' ? options.point : 0;
    const initialMark = typeof options.mark === 'number' ? options.mark : null;
    view.cursors = [{ point: initialPoint, mark: initialMark }];
    Object.defineProperty(view, 'point', {
      get() { return this.cursors[0].point; },
      set(v) { this.cursors[0].point = v; },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(view, 'mark', {
      get() { return this.cursors[0].mark; },
      set(v) { this.cursors[0].mark = v; },
      enumerable: true,
      configurable: true,
    });
  }
  // Tabline-views default their structural fields when not supplied via
  // `extras`. A bare `createView({ kind: 'tabline' })` thus yields an
  // empty top-edge tabline with no active child; the per-pane mount
  // hook tolerates that (it renders an empty strip + empty content
  // area until tabs are added).
  if (view.kind === 'tabline') {
    if (!Array.isArray(view.tabs)) view.tabs = [];
    if (typeof view.active !== 'number') view.active = 0;
    if (typeof view.edge !== 'string') view.edge = 'top';
    // For vertical-edge tablines, the strip's pixel width. `null` means
    // "use the host's default" (the mount picks the default it wants);
    // a positive number is the user-set width from a resizer drag, which
    // also survives across session restore.
    if (view.width !== undefined && typeof view.width !== 'number') {
      view.width = null;
    } else if (view.width === undefined) {
      view.width = null;
    }
  }
  return view;
}

/**
 * Whether `value` looks like a view (a kind + name + buffer shape, as
 * `createView` returns).
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isView(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.kind === 'string' &&
    'buffer' in value
  );
}

/**
 * Whether VALUE is a tabline-view — a view whose `kind` is `'tabline'`
 * and which carries the structural `tabs` / `active` / `edge` fields.
 *
 * Callers use this to branch on "is the focused pane holding a tabline-
 * view or a plain leaf view?" without having to remember the literal
 * `'tabline'` string.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isTablineView(value) {
  return (
    isView(value) &&
    value.kind === 'tabline' &&
    Array.isArray(value.tabs)
  );
}

/**
 * The active child of a tabline-view, or `null` when VIEW is not a
 * tabline-view, the tabs list is empty, or `active` is out of range.
 *
 * `(current-view)` resolves through this: when the focused pane's view
 * is a tabline-view, the active child is what the user is actually
 * editing.
 *
 * @param {import('./view.js').View | null | undefined} view
 * @returns {import('./view.js').View | null}
 */
export function tablineActiveChild(view) {
  if (!isTablineView(view)) return null;
  if (view.tabs.length === 0) return null;
  const i = view.active;
  if (typeof i !== 'number' || i < 0 || i >= view.tabs.length) return null;
  return view.tabs[i] ?? null;
}

/**
 * @typedef {object} View
 * @property {string} id - A unique-enough id; assigned at creation.
 * @property {string} kind - The view's kind discriminator.
 * @property {string} name - The view's modeline name.
 * @property {import('@editor/buffer').Buffer | null} buffer - The L2
 *   buffer for text views; null otherwise.
 * @property {*} mode - The view's own mode (non-text views); null for
 *   text views (their modes live on the buffer).
 * @property {number} [point] - The primary cursor's offset, for text
 *   views. Two views over the same buffer have independent cursors.
 *   Backed by `cursors[0].point`.
 * @property {number | null} [mark] - The primary cursor's selection
 *   anchor, for text views. `null` means no selection. Backed by
 *   `cursors[0].mark`.
 * @property {{point: number, mark: number|null}[]} [cursors] - The full
 *   selection set, for text views. Index 0 is the primary; additional
 *   entries are secondary cursors. Always non-empty for a text view.
 * @property {View[]} [tabs] - For tabline-views: the child views in
 *   display order. Other kinds leave this undefined.
 * @property {number} [active] - For tabline-views: index into `tabs`
 *   of the currently visible child.
 * @property {('top'|'right'|'bottom'|'left')} [edge] - For tabline-
 *   views: which edge of the pane the strip renders on.
 * @property {number | null} [width] - For vertical-edge (left/right)
 *   tabline-views: the user-chosen strip width in pixels. `null` means
 *   "use the host's default."
 *
 * Kind-specific state lives as additional top-level fields (e.g.
 * `src`, `tracks`, `sessionId`) put there by `createView`'s `extras`
 * option.
 */
