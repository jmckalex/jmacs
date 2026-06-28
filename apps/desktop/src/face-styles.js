/**
 * @file face-styles.js — generate a `<style id="face-overrides">`
 * element in `<head>` from a resolved face map.
 *
 * The Lisp side hands us an alist (face-name . ((:attr . value) …)).
 * We translate it into one CSS rule per face on `.tok-NAME`, setting
 * `color`, `background-color`, `font-weight`, `font-style`,
 * `text-decoration`, and (when a face overrides them) `font-size` /
 * `font-family` from the attributes that are present. Attributes the
 * face does not specify are omitted — never written as empty.
 *
 * The one exception is the base face (`default`): it is not painted as a
 * `.tok-` rule but as a `:root` rule driving the `--font-size` /
 * `--font-mono` variables, so every other face inherits the editor's
 * base typography through the cascade (see `generateBaseFaceCss`).
 *
 * The full element is rewritten on every change; with a handful of faces
 * the cost is negligible, and the alternative (per-rule editing) is
 * fragile across hot reloads of the stdlib.
 */

/** Element id used for the generated style block. Stable so we can
 *  find and rewrite it. */
export const FACE_STYLE_ELEMENT_ID = 'face-overrides';

/** The base face. Unlike the token faces it is NOT painted as a
 *  `.tok-NAME` rule; its typography (`:size`, `:family`) is written to
 *  the editor surface via the `--font-size` / `--font-mono` CSS
 *  variables, so every other face inherits it through the cascade. */
export const BASE_FACE_NAME = 'default';

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

/** The CSS `font-size` for a face's `:size` value. A bare number (14,
 *  13.5) is treated as pixels; a value that already carries a unit or a
 *  keyword (`1.2em`, `larger`) passes through unchanged. */
function cssSize(value) {
  const v = valueToString(value);
  if (v === null) return null;
  return /^\d+(\.\d+)?$/.test(v) ? `${v}px` : v;
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

/** The CSS declarations for one face attribute map, or `[]` when the
 *  face declares nothing. Shared by the global and per-mode generators. */
function faceDeclarations(attrs) {
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
  if (decoration !== null) decls.push(`text-decoration: ${decoration};`);
  // Typography overrides: a face may set its own size/family, overriding
  // what it would otherwise inherit from the base `default` face.
  const size = cssSize(attrs.get('size'));
  if (size !== null) decls.push(`font-size: ${size};`);
  const family = valueToString(attrs.get('family'));
  if (family !== null) decls.push(`font-family: ${family};`);
  return decls;
}

/** Escape a major-mode name for use inside a CSS attribute-selector
 *  string. Mode names are short display strings ("LaTeX", "Python");
 *  a backslash or double-quote would break the selector, so escape both. */
function cssAttrValue(name) {
  return String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
    // The base face paints the editor surface (see generateBaseFaceCss),
    // not a `.tok-` rule — every face inherits it through the cascade.
    if (name === BASE_FACE_NAME) continue;
    const decls = faceDeclarations(faces.get(name));
    if (decls.length === 0) continue;
    lines.push(`.tok-${name} { ${decls.join(' ')} }`);
  }
  return lines.join('\n');
}

/**
 * Generate the `:root` rule that carries the base face's typography —
 * its `:size` → `--font-size`, its `:family` → `--font-mono`. These CSS
 * variables are what `styles.css` reads for the editor font, so writing
 * them here (the face-overrides block loads after `styles.css`) lets the
 * base face drive the editor's base typography live. Returns `''` when
 * there is no base face or it declares no typography.
 *
 * @param {Map<string, Map<string, *>>} faces - face-name → attr-map
 * @returns {string}
 */
export function generateBaseFaceCss(faces) {
  const base = faces.get(BASE_FACE_NAME);
  if (!(base instanceof Map)) return '';
  const decls = [];
  const size = cssSize(base.get('size'));
  if (size !== null) decls.push(`--font-size: ${size};`);
  const family = valueToString(base.get('family'));
  if (family !== null) decls.push(`--font-mono: ${family};`);
  return decls.length === 0 ? '' : `:root { ${decls.join(' ')} }`;
}

/**
 * Generate mode-scoped CSS — `[data-major-mode="MODE"] .tok-NAME { … }`
 * — from a map of mode-name → (face-name → attr-map). The editor view's
 * root carries `data-major-mode` (see view.js), so these rules win over
 * the unscoped `.tok-NAME` rules for buffers in that mode (equal
 * specificity from the attribute selector, but later in the stylesheet).
 *
 * @param {Map<string, Map<string, Map<string, *>>>} perMode
 * @returns {string}
 */
export function generateModeFaceCss(perMode) {
  const lines = [];
  const modes = [...perMode.keys()].sort();
  for (const mode of modes) {
    const faces = perMode.get(mode);
    if (!(faces instanceof Map)) continue;
    const sel = `[data-major-mode="${cssAttrValue(mode)}"]`;
    const names = [...faces.keys()].sort();
    for (const name of names) {
      const decls = faceDeclarations(faces.get(name));
      if (decls.length === 0) continue;
      lines.push(`${sel} .tok-${name} { ${decls.join(' ')} }`);
    }
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
 * Parse the per-mode styles alist the Lisp side hands us —
 * `(mode-name . ((face-name . ((:attr . value) …)) …))` — into a
 * Map<modeName, Map<faceName, Map<attr, value>>>.
 *
 * @param {Array<{head: *, tail: *}>} alist - The list as a JS array of
 *   cons pairs (caller already did `listToArray`).
 * @param {(form: *) => Array<*>} listToArray
 * @returns {Map<string, Map<string, Map<string, *>>>}
 */
export function modeFacesFromAlist(alist, listToArray) {
  const out = new Map();
  for (const cell of alist) {
    if (cell === null || cell === undefined) continue;
    const modeName = typeof cell.head === 'string'
      ? cell.head
      : (cell.head && cell.head.name) || String(cell.head);
    const faces = facesFromAlist(listToArray(cell.tail), listToArray);
    out.set(modeName, faces);
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
 * global face map (and any per-mode overrides) and writes it to the
 * `<style id="face-overrides">` element. The per-mode rules are appended
 * AFTER the global ones so they win for buffers in that mode.
 *
 * @param {Document} doc - The document to write into.
 * @param {Array<*>} alist - The Lisp-side current-face-styles alist
 *   already unfolded with listToArray.
 * @param {(form: *) => Array<*>} listToArray - The Lisp list helper.
 * @param {Array<*>} [modeAlist] - The Lisp-side current-mode-face-styles
 *   alist (per-mode overrides), already unfolded. Optional — omit it for
 *   the global-only behaviour.
 */
/**
 * Build the full face-overrides CSS text — the base-face `:root` rule first,
 * then the per-token `.tok-` rules, then any per-mode overrides — from the
 * Lisp-side `current-face-styles` alist (+ optional `current-mode-face-styles`).
 *
 * Pure (no DOM): the spine generates this CSS server-side and pushes it to every
 * window as a FACES_APPLY directive (plans/MODEL-B-DEFAULT.md B1.3); the renderer
 * injects the returned string via `writeFaceStyleElement`.
 *
 * @param {Array<*>} alist - current-face-styles, unfolded with listToArray.
 * @param {(form: *) => Array<*>} listToArray
 * @param {Array<*>} [modeAlist] - current-mode-face-styles, unfolded.
 * @returns {string}
 */
export function faceStylesCss(alist, listToArray, modeAlist) {
  const faces = facesFromAlist(alist, listToArray);
  const base = generateBaseFaceCss(faces);
  let css = generateFaceCss(faces);
  if (base !== '') css = css === '' ? base : `${base}\n${css}`;
  if (Array.isArray(modeAlist) && modeAlist.length > 0) {
    const perMode = modeFacesFromAlist(modeAlist, listToArray);
    const modeCss = generateModeFaceCss(perMode);
    if (modeCss !== '') css = css === '' ? modeCss : `${css}\n${modeCss}`;
  }
  return css;
}

export function applyFaceStyles(doc, alist, listToArray, modeAlist) {
  writeFaceStyleElement(doc, faceStylesCss(alist, listToArray, modeAlist));
}
