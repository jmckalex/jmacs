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
  if (view.kind === 'text') {
    view.point = typeof options.point === 'number' ? options.point : 0;
    view.mark = typeof options.mark === 'number' ? options.mark : null;
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
 * @typedef {object} View
 * @property {string} id - A unique-enough id; assigned at creation.
 * @property {string} kind - The view's kind discriminator.
 * @property {string} name - The view's modeline name.
 * @property {import('@editor/buffer').Buffer | null} buffer - The L2
 *   buffer for text views; null otherwise.
 * @property {*} mode - The view's own mode (non-text views); null for
 *   text views (their modes live on the buffer).
 * @property {number} [point] - The cursor offset, for text views.
 *   Two views over the same buffer have independent cursors.
 * @property {number | null} [mark] - The selection anchor, for text
 *   views. `null` means no selection.
 *
 * Kind-specific state lives as additional top-level fields (e.g.
 * `src`, `tracks`, `sessionId`) put there by `createView`'s `extras`
 * option.
 */
