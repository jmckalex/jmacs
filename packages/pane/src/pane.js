/**
 * @file Pane — a rectangular tile in the editor area.
 *
 * A pane tree is binary: each split node holds an orientation
 * (`horizontal` or `vertical`) and a ratio in `[0, 1]` that controls how
 * its bounding rectangle is split between its two children. A leaf pane
 * holds exactly one view.
 *
 * Pane handles are plain objects — small mutable records the desktop
 * app and the Lisp primitives read directly. The shape is what
 * matters; behaviour lives in `tree.js` (walking) and `layout.js` (the
 * rect math).
 *
 * Phase 2 only ever needs the leaf case (the editor area is a single
 * leaf containing the current view); the split kind exists in the data
 * model so phase 3 can exercise it without touching the constructors.
 *
 * Construction returns the pane handle (Q15 — pane-creating commands
 * return handles). Callers wire the handle into the tree directly.
 */

/** Pane kinds. */
export const PANE_KIND_LEAF = 'leaf';
export const PANE_KIND_SPLIT = 'split';

/** Split orientations. */
export const SPLIT_HORIZONTAL = 'horizontal';
export const SPLIT_VERTICAL = 'vertical';

let nextId = 1;
function freshId(kind) {
  const n = nextId;
  nextId += 1;
  return `pane-${kind}-${n}`;
}

/**
 * Advance the pane-id counter past any value embedded in `seenId`. Used
 * by the session restore loop so the runtime id source doesn't mint a
 * collision against an id we just restored verbatim from disk. Ids
 * follow the `pane-<kind>-<n>` convention; ids that don't parse are
 * ignored (callers can pass arbitrary persisted ids without checking).
 *
 * @param {string} seenId
 */
export function bumpIdCounterPast(seenId) {
  if (typeof seenId !== 'string') return;
  const match = seenId.match(/-(\d+)$/);
  if (!match) return;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return;
  if (n >= nextId) nextId = n + 1;
}

/**
 * Create a leaf pane.
 *
 * @param {object} [options]
 * @param {string} [options.id] - Optional explicit id. When omitted, a
 *   fresh monotonically-increasing id is assigned.
 * @param {object | null} [options.view] - The view this leaf holds.
 *   May be `null` in tests; the desktop app always sets one.
 * @returns {LeafPane}
 */
export function createLeafPane(options = {}) {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('createLeafPane: options must be an object');
  }
  return {
    kind: PANE_KIND_LEAF,
    id: options.id ?? freshId(PANE_KIND_LEAF),
    view: options.view ?? null,
  };
}

/**
 * Create a split pane.
 *
 * @param {object} options
 * @param {string} options.orientation - `'horizontal'` (splits side by
 *   side; the first child occupies the left fraction) or `'vertical'`
 *   (splits top/bottom; the first child occupies the top fraction).
 * @param {number} options.ratio - The first child's fraction of the
 *   container, in `[0, 1]`. Clamped to a sensible minimum/maximum to
 *   keep both children visible.
 * @param {Pane} options.first - The first child pane (left or top).
 * @param {Pane} options.second - The second child pane (right or bottom).
 * @param {string} [options.id] - Optional explicit id.
 * @returns {SplitPane}
 */
export function createSplitPane(options) {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('createSplitPane: options is required');
  }
  if (
    options.orientation !== SPLIT_HORIZONTAL &&
    options.orientation !== SPLIT_VERTICAL
  ) {
    throw new TypeError(
      "createSplitPane: orientation must be 'horizontal' or 'vertical'"
    );
  }
  if (
    typeof options.ratio !== 'number' ||
    Number.isNaN(options.ratio) ||
    options.ratio <= 0 ||
    options.ratio >= 1
  ) {
    throw new RangeError(
      'createSplitPane: ratio must be a number in (0, 1)'
    );
  }
  if (!isPane(options.first) || !isPane(options.second)) {
    throw new TypeError('createSplitPane: first and second must be panes');
  }
  return {
    kind: PANE_KIND_SPLIT,
    id: options.id ?? freshId(PANE_KIND_SPLIT),
    orientation: options.orientation,
    ratio: options.ratio,
    first: options.first,
    second: options.second,
  };
}

/**
 * Whether `value` looks like a pane handle (leaf or split).
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isPane(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value.kind === PANE_KIND_LEAF || value.kind === PANE_KIND_SPLIT)
  );
}

/** @returns {boolean} */
export function isLeafPane(value) {
  return isPane(value) && value.kind === PANE_KIND_LEAF;
}

/** @returns {boolean} */
export function isSplitPane(value) {
  return isPane(value) && value.kind === PANE_KIND_SPLIT;
}

/**
 * @typedef {object} LeafPane
 * @property {'leaf'} kind
 * @property {string} id
 * @property {object | null} view
 *
 * @typedef {object} SplitPane
 * @property {'split'} kind
 * @property {string} id
 * @property {'horizontal' | 'vertical'} orientation
 * @property {number} ratio - First child's fraction in `[0, 1]`.
 * @property {Pane} first
 * @property {Pane} second
 *
 * @typedef {LeafPane | SplitPane} Pane
 */
