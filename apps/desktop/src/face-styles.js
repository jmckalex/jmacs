/**
 * @file face-styles.js — generate a `<style id="face-overrides">`
 * element in `<head>` from a resolved face map.
 *
 * The Lisp side hands us an alist (face-name . ((:attr . value) …)).
 * We translate it into one CSS rule per face on `.tok-NAME`, setting
 * `color`, `background-color`, `font-weight`, `font-style`,
 * `text-decoration` from the attributes that are present. Attributes
 * the face does not specify are omitted — never written as empty.
 *
 * The full element is rewritten on every change; with thirteen faces
 * the cost is negligible, and the alternative (per-rule editing) is
 * fragile across hot reloads of the stdlib.
 */

/** Element id used for the generated style block. Stable so we can
 *  find and rewrite it. */
export const FACE_STYLE_ELEMENT_ID = 'face-overrides';

/** The CSS attribute names emitted for each face descriptor key. */
const ATTR_CSS_PROPERTY = {
  foreground: 'color',
  background: 'background-color',
  weight: 'font-weight',
  slant: 'font-style',
  underline: 'text-decoration', // computed below — combines with strike
  'strike-through': 'text-decoration',
};

/** A keyword/symbol value comes from Lisp as `{ name: '…' }` (a Sym
 *  or a Keyword). A string comes through as a JS string. This pulls
 *  the textual content out either way and returns `null` for empty
 *  or missing values so the caller can skip the attribute. */
function valueToString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && typeof value.name === 'string') {
    return value.name === '' ? null : value.name;
  }
  return String(value);
}

/** The CSS `font-weight` for a face's `:weight` value. */
function cssWeight(value) {
  const v = valueToString(value);
  if (v === null) return null;
  if (v === 'bold') return 'bold';
  if (v === 'normal') return 'normal';
  // A bare integer-like value or a CSS keyword passes through.
  return v;
}

/** The CSS `font-style` for a face's `:slant` value. */
function cssSlant(value) {
  const v = valueToString(value);
  if (v === null) return null;
  if (v === 'italic') return 'italic';
  if (v === 'oblique') return 'oblique';
  if (v === 'normal') return 'normal';
  return v;
}

/** Build the `text-decoration` rule from underline + strike-through
 *  truthiness. Returns null when neither is set, so the property is
 *  omitted entirely (rather than written as an empty string). */
function cssDecoration(underline, strike) {
  const parts = [];
  if (truthy(underline)) parts.push('underline');
  if (truthy(strike)) parts.push('line-through');
  return parts.length === 0 ? null : parts.join(' ');
}

/** A Lisp truthy value: `#t`, `true`, anything but `false` / nil /
 *  empty list. The Lisp host hands us booleans as JS booleans, but
 *  nil arrives as the special NIL marker (an empty list — `{ head:
 *  undefined, tail: ... }` style). Be generous; only literal false
 *  values count as "off". */
function truthy(value) {
  if (value === null || value === undefined) return false;
  if (value === false) return false;
  // Treat the empty-list NIL marker as false as well.
  if (typeof value === 'object' && value.isNil === true) return false;
  // Symbols / keywords are truthy unless the name is "false".
  if (typeof value === 'object' && typeof value.name === 'string') {
    return value.name !== 'false';
  }
  return true;
}

/**
 * Generate the CSS body for a face map.
 *
 * @param {Map<string, Map<string, *>>} faces - face-name → attr-map
 *   where attr-map has keys like 'foreground', 'weight', etc.
 * @returns {string} CSS — one `.tok-NAME { … }` rule per face that
 *   declares at least one property; faces with no resolved attributes
 *   produce nothing.
 */
export function generateFaceCss(faces) {
  const lines = [];
  // Sort face names for stable, diffable output.
  const names = [...faces.keys()].sort();
  for (const name of names) {
    const attrs = faces.get(name);
    const decls = [];
    const fg = valueToString(attrs.get('foreground'));
    if (fg !== null) decls.push(`color: ${fg};`);
    const bg = valueToString(attrs.get('background'));
    if (bg !== null) decls.push(`background-color: ${bg};`);
    const weight = cssWeight(attrs.get('weight'));
    if (weight !== null) decls.push(`font-weight: ${weight};`);
    const slant = cssSlant(attrs.get('slant'));
    if (slant !== null) decls.push(`font-style: ${slant};`);
    const decoration = cssDecoration(
      attrs.get('underline'),
      attrs.get('strike-through')
    );
    if (decoration !== null) {
      decls.push(`text-decoration: ${decoration};`);
    }
    if (decls.length === 0) continue;
    lines.push(`.tok-${name} { ${decls.join(' ')} }`);
  }
  return lines.join('\n');
}

/**
 * The shape the Lisp side hands us — an alist of
 * `(face-name . ((:attr . value) …))` — into a Map<string,
 * Map<string, *>>. Each Lisp keyword like `:foreground` becomes the
 * bare string `'foreground'` in the inner map, so consumers don't
 * have to know about the leading colon.
 *
 * @param {Array<{head: *, tail: *}>} alist - The list as a JS array
 *   of cons pairs (the caller has already done `listToArray`).
 * @param {(form: *) => Array<*>} listToArray - The Lisp helper that
 *   unfolds a cons list. We accept it as a parameter so this module
 *   stays free of a hard dependency on `@editor/lisp`.
 * @returns {Map<string, Map<string, *>>}
 */
export function facesFromAlist(alist, listToArray) {
  const out = new Map();
  for (const cell of alist) {
    if (cell === null || cell === undefined) continue;
    const faceName = cell.head;
    const name = typeof faceName === 'string'
      ? faceName
      : (faceName && faceName.name) || String(faceName);
    const attrs = new Map();
    const pairs = listToArray(cell.tail);
    for (const pair of pairs) {
      if (pair === null || pair === undefined) continue;
      const k = pair.head;
      const key = typeof k === 'string'
        ? k
        : (k && k.name) || String(k);
      attrs.set(key, pair.tail);
    }
    out.set(name, attrs);
  }
  return out;
}

/**
 * Find or create the face-overrides `<style>` element in the
 * document head, and rewrite its text content to the given CSS.
 *
 * @param {Document} doc
 * @param {string} css
 */
export function writeFaceStyleElement(doc, css) {
  let element = doc.getElementById(FACE_STYLE_ELEMENT_ID);
  if (element === null) {
    element = doc.createElement('style');
    element.id = FACE_STYLE_ELEMENT_ID;
    doc.head.append(element);
  }
  element.textContent = css;
}

/**
 * The top-level entry the host calls. Builds the CSS from the resolved
 * face map and writes it to the `<style id="face-overrides">` element.
 *
 * @param {Document} doc - The document to write into.
 * @param {Array<*>} alist - The Lisp-side current-face-styles alist
 *   already unfolded with listToArray.
 * @param {(form: *) => Array<*>} listToArray - The Lisp list helper.
 */
export function applyFaceStyles(doc, alist, listToArray) {
  const faces = facesFromAlist(alist, listToArray);
  writeFaceStyleElement(doc, generateFaceCss(faces));
}
