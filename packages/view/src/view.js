/**
 * @file View — the addressable on-screen thing.
 *
 * A view is what a pane shows. It has:
 *
 *   - kind: a string discriminator ('text', 'image', 'shell', ...).
 *   - name: a human-readable label (the modeline name).
 *   - buffer: an L2 buffer for text-editing views, null otherwise.
 *   - state: a free-form bag of view-kind-specific data (track list,
 *     image src, shell session id, ...). For text views, state is
 *     intentionally empty — the buffer carries everything.
 *
 * The buffer-vs-state split is exhaustive: a text view edits text and
 * uses a buffer; every other kind owns its own state and has no buffer.
 *
 * `createView` returns an object with a `kind`, a mutable `name` and
 * `state`, and a (possibly-null) `buffer`. The `mode` slot is the
 * view's own mode for non-text views; text views resolve modes through
 * the buffer.
 *
 * The view is intentionally a plain mutable record — it's a small
 * piece of state that the desktop app, the kind registry and the Lisp
 * primitives share. The shape is what matters; behaviour lives in the
 * kind registry.
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
 * @param {string} options.kind - The view's kind (e.g. 'text', 'image',
 *   'shell', 'tabline'). The kind drives renderer dispatch and the
 *   life-cycle hooks the kind registry provides.
 * @param {string} [options.name] - The view's modeline name. Falls
 *   back to the buffer's name for text views, or a kind-derived
 *   placeholder otherwise.
 * @param {import('@editor/buffer').Buffer | null} [options.buffer] -
 *   The L2 buffer for text-editing views. Other views pass `null`.
 * @param {object} [options.state] - The view-kind-specific state bag.
 *   Free-form; the kind registry's spec decides what shape it has.
 * @param {*} [options.mode] - The view's own mode (only used by
 *   non-text kinds with their own mode-like behaviour, e.g. an image
 *   view with its image keymap). Text views resolve modes through the
 *   buffer; this slot is left null for them.
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
    state: options.state ?? {},
    mode: options.mode ?? null,
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
  return view;
}

/**
 * Whether `value` looks like a view (a kind + name + buffer/state
 * shape, as `createView` returns).
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isView(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.kind === 'string' &&
    'buffer' in value &&
    'state' in value
  );
}

/**
 * @typedef {object} View
 * @property {string} id - A unique-enough id; assigned at creation.
 * @property {string} kind - The view's kind discriminator.
 * @property {string} name - The view's modeline name.
 * @property {import('@editor/buffer').Buffer | null} buffer - The L2
 *   buffer for text views; null otherwise.
 * @property {object} state - The view-kind-specific state bag.
 * @property {*} mode - The view's own mode (non-text views); null for
 *   text views (their modes live on the buffer).
 */
