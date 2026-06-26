/**
 * @file Renderable-output descriptors for the JS notebook.
 *
 * Cells execute where there is no DOM (the renderer's interpreter
 * context in the flag-off MVP, the server's Node session in the Model-B
 * port). A cell therefore cannot return a live DOM node. Instead, a
 * cell's value is run through an **inspector** that turns it into a small,
 * **serializable descriptor** — a tagged union — which the client
 * materializes into DOM (design contract: `plans/NOTEBOOK-JS.md` §5).
 *
 * The descriptor types (the `type` tag):
 *   - `text`    — a string / primitive shown verbatim.
 *   - `json`    — a structured value shown as a (bounded) JSON tree.
 *   - `table`   — an array of flat objects shown as a table.
 *   - `html`    — a raw HTML string (escape hatch; trust model = REPL).
 *   - `svg`     — a raw `<svg…>` string.
 *   - `image`   — an image, by data URL.
 *   - `element` — a custom element to import-and-mount, reusing the
 *                 element-view transport: `{tag, moduleUrl, attrs}`.
 *   - `empty`   — the cell produced no value (`undefined`).
 *
 * This module is pure: it builds and bounds descriptors but never
 * touches the DOM. The client (`notebook-js-view.js`) owns rendering.
 */

/**
 * Default ceilings so a cell that returns a huge value can't wedge the
 * wire or the renderer. The inspector truncates and annotates rather
 * than refusing.
 */
export const LIMITS = Object.freeze({
  /** Max rows materialized for a `table`. */
  tableRows: 200,
  /** Max array/string length before a `json`/`text` value is truncated. */
  jsonLength: 2000,
  /** Max characters in a stringified scalar. */
  textChars: 100000,
});

/**
 * The explicit descriptor builders injected into a cell as `Inspector.*`
 * (design §2.4). Each returns a plain descriptor object so a cell can
 * choose its own rendering, e.g.
 *   `Inspector.table(rows)` / `Inspector.element('line-chart', url, {…})`.
 */
export const Inspector = Object.freeze({
  /**
   * @param {string} text
   * @returns {{type: 'text', text: string}}
   */
  text(text) {
    return { type: 'text', text: String(text) };
  },

  /**
   * @param {*} value
   * @returns {{type: 'json', value: *, truncated: boolean}}
   */
  json(value) {
    return boundedJson(value);
  },

  /**
   * @param {Array<Object>} rows
   * @param {{columns?: string[]}} [opts]
   * @returns {{type: 'table', columns: string[], rows: Array<Object>, total: number, truncated: boolean}}
   */
  table(rows, opts = {}) {
    return buildTable(rows, opts.columns);
  },

  /**
   * @param {string} html
   * @returns {{type: 'html', html: string}}
   */
  html(html) {
    return { type: 'html', html: String(html) };
  },

  /**
   * @param {string} svg
   * @returns {{type: 'svg', svg: string}}
   */
  svg(svg) {
    return { type: 'svg', svg: String(svg) };
  },

  /**
   * @param {string} dataUrl - a `data:image/...;base64,...` URL.
   * @param {{alt?: string}} [opts]
   * @returns {{type: 'image', dataUrl: string, alt: string}}
   */
  image(dataUrl, opts = {}) {
    return { type: 'image', dataUrl: String(dataUrl), alt: opts.alt || '' };
  },

  /**
   * The killer integration: render output via a custom element imported
   * from MODULEURL, reusing the element-view `{tag, moduleUrl, attrs}`
   * transport. The cell returns the element's *spec*; the client mounts
   * it. (design §5.2)
   *
   * @param {string} tag - the custom-element tag name.
   * @param {string} moduleUrl - the module that defines the element.
   * @param {Object} [attrs] - serializable attributes/props.
   * @returns {{type: 'element', tag: string, moduleUrl: string, attrs: Object}}
   */
  element(tag, moduleUrl, attrs = {}) {
    return {
      type: 'element',
      tag: String(tag),
      moduleUrl: String(moduleUrl),
      attrs: attrs && typeof attrs === 'object' ? attrs : {},
    };
  },
});

/**
 * Classify an arbitrary cell VALUE into a renderable descriptor. This is
 * the automatic path (`inspect`) used when a cell returns a plain value
 * rather than an explicit `Inspector.*` descriptor (design §5.3).
 *
 * Recognition order:
 *   1. `undefined` → `empty`.
 *   2. an already-built descriptor (has a known `type`) → passed through.
 *   3. a string containing `<svg` → `svg`.
 *   4. a primitive (string/number/boolean/bigint/symbol) → `text`.
 *   5. an array of flat objects → `table`.
 *   6. anything else (object, array, Map, …) → bounded `json`.
 *
 * @param {*} value
 * @returns {Object} a descriptor (see this file's header).
 */
export function inspect(value) {
  if (value === undefined) return { type: 'empty' };

  if (isDescriptor(value)) return value;

  if (typeof value === 'string') {
    if (/<svg[\s>]/i.test(value)) return { type: 'svg', svg: value };
    return { type: 'text', text: truncateText(value) };
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return { type: 'text', text: scalarToText(value) };
  }

  if (Array.isArray(value) && isArrayOfFlatObjects(value)) {
    return buildTable(value);
  }

  return boundedJson(value);
}

/**
 * The set of descriptor `type` tags the client knows how to render.
 * @type {Set<string>}
 */
const DESCRIPTOR_TYPES = new Set([
  'text',
  'json',
  'table',
  'html',
  'svg',
  'image',
  'element',
  'empty',
]);

/**
 * Whether VALUE is already a renderable descriptor (so `inspect` passes
 * it through untouched).
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isDescriptor(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.type === 'string' &&
    DESCRIPTOR_TYPES.has(value.type)
  );
}

/**
 * Whether VALUE is a non-empty array whose elements are all plain
 * objects with no nested objects/arrays as values — i.e. a flat table.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isArrayOfFlatObjects(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (row) =>
      row !== null &&
      typeof row === 'object' &&
      !Array.isArray(row) &&
      Object.values(row).every((v) => v === null || typeof v !== 'object'),
  );
}

/**
 * Build a `table` descriptor from ROWS. Columns are the union of all row
 * keys in first-seen order unless COLUMNS is given. Rows beyond
 * {@link LIMITS.tableRows} are dropped and the descriptor is marked
 * `truncated` with the real `total`.
 *
 * @param {Array<Object>} rows
 * @param {string[]} [columns]
 * @returns {{type: 'table', columns: string[], rows: Array<Object>, total: number, truncated: boolean}}
 */
export function buildTable(rows, columns) {
  const all = Array.isArray(rows) ? rows : [];
  const cols = columns || unionKeys(all);
  const total = all.length;
  const truncated = total > LIMITS.tableRows;
  const kept = truncated ? all.slice(0, LIMITS.tableRows) : all;
  const cells = kept.map((row) => {
    const out = {};
    for (const c of cols) out[c] = scalarToText(row?.[c]);
    return out;
  });
  return { type: 'table', columns: cols, rows: cells, total, truncated };
}

/**
 * The union of all object keys across ROWS, in first-seen order.
 *
 * @param {Array<Object>} rows
 * @returns {string[]}
 */
function unionKeys(rows) {
  const seen = [];
  const set = new Set();
  for (const row of rows) {
    if (row && typeof row === 'object') {
      for (const k of Object.keys(row)) {
        if (!set.has(k)) {
          set.add(k);
          seen.push(k);
        }
      }
    }
  }
  return seen;
}

/**
 * Build a `json` descriptor, converting non-JSON-native values (Map,
 * Set, bigint, …) into a serializable shape and bounding the overall
 * size. Marks `truncated` if anything was clipped.
 *
 * @param {*} value
 * @returns {{type: 'json', value: *, truncated: boolean}}
 */
export function boundedJson(value) {
  const state = { truncated: false };
  const safe = toSerializable(value, state, 0);
  return { type: 'json', value: safe, truncated: state.truncated };
}

/**
 * Recursively convert VALUE into a JSON-serializable structure, bounding
 * array/object sizes and depth. Mutates STATE.truncated when it clips.
 *
 * @param {*} value
 * @param {{truncated: boolean}} state
 * @param {number} depth
 * @returns {*}
 */
function toSerializable(value, state, depth) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string') {
    if (value.length > LIMITS.jsonLength) {
      state.truncated = true;
      return `${value.slice(0, LIMITS.jsonLength)}…`;
    }
    return value;
  }
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return `${value}n`;
  if (t === 'symbol' || t === 'function' || t === 'undefined') {
    return scalarToText(value);
  }

  if (depth >= 6) {
    state.truncated = true;
    return '[…]';
  }

  if (Array.isArray(value)) {
    const keep = value.slice(0, LIMITS.jsonLength);
    if (value.length > LIMITS.jsonLength) state.truncated = true;
    return keep.map((v) => toSerializable(v, state, depth + 1));
  }

  if (value instanceof Map) {
    const out = {};
    let n = 0;
    for (const [k, v] of value) {
      if (n >= LIMITS.jsonLength) {
        state.truncated = true;
        break;
      }
      out[String(k)] = toSerializable(v, state, depth + 1);
      n += 1;
    }
    return out;
  }

  if (value instanceof Set) {
    return toSerializable(Array.from(value), state, depth);
  }

  // Plain object (or class instance — treated structurally).
  const out = {};
  let n = 0;
  for (const k of Object.keys(value)) {
    if (n >= LIMITS.jsonLength) {
      state.truncated = true;
      break;
    }
    out[k] = toSerializable(value[k], state, depth + 1);
    n += 1;
  }
  return out;
}

/**
 * Render a scalar (or any value, defensively) to a short text cell value.
 *
 * @param {*} v
 * @returns {string}
 */
export function scalarToText(v) {
  if (v === null) return 'null';
  if (v === undefined) return '';
  const t = typeof v;
  if (t === 'string') return v;
  if (t === 'bigint') return `${v}n`;
  if (t === 'symbol') return v.toString();
  if (t === 'function') return `ƒ ${v.name || 'anonymous'}`;
  if (t === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * Clamp a string to {@link LIMITS.textChars}, appending an ellipsis when
 * clipped.
 *
 * @param {string} s
 * @returns {string}
 */
function truncateText(s) {
  if (s.length <= LIMITS.textChars) return s;
  return `${s.slice(0, LIMITS.textChars)}…`;
}
