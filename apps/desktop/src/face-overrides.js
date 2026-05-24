/**
 * @file face-overrides.js — convert between the on-disk JSON shape of
 * `faces.json` and the in-memory Lisp shape of `*face-overrides*`.
 *
 * JSON shape (what the user sees and edits if they open faces.json):
 *
 *   { "global":  { "keyword": { "weight": "bold" } },
 *     "themes":  { "dark": { "operator": { "foreground": "#62b3b2" } } } }
 *
 * Lisp shape (`*face-overrides*`):
 *
 *   {:global  { keyword       -> { :weight :bold } }
 *    :themes  { dark -> { operator -> { :foreground "#62b3b2" } } }}
 *
 * Face names and theme names are *symbols* (Sym). Attribute names are
 * *keywords* (Keyword). Weight / slant values that are symbolic in
 * Lisp ("bold", "italic", "normal") are stored as bare strings in the
 * JSON — colours are already strings either way.
 *
 * The Sym / Keyword constructors live in `@editor/lisp`, but this
 * module accepts them as parameters so it can be unit-tested with
 * stand-ins (the desktop test package has no @editor/* dependency).
 */

/** Attribute names that store a symbolic value (a Lisp keyword) when
 *  loaded — `weight: "bold"` in JSON becomes `:weight :bold` in Lisp. */
const SYMBOLIC_ATTR_VALUES = new Set(['weight', 'slant']);

/**
 * @typedef {object} LispFactories
 * @property {(name: string) => *} keyword - Intern a Lisp keyword.
 * @property {(name: string) => *} sym - Intern a Lisp symbol.
 */

/** A new empty face-overrides Lisp shape — used when the JSON file
 *  does not exist (first launch) or fails to parse.
 *  @param {LispFactories} f */
export function emptyOverrides(f) {
  const m = new Map();
  m.set(f.keyword('global'), new Map());
  m.set(f.keyword('themes'), new Map());
  return m;
}

/** Convert one JSON face object (attribute -> value) into a Lisp
 *  hash-map of Keyword -> value, with symbolic attribute values
 *  re-interned as keywords. */
function jsonFaceToLisp(face, f) {
  const out = new Map();
  if (!face || typeof face !== 'object') return out;
  for (const [attr, value] of Object.entries(face)) {
    const k = f.keyword(attr);
    if (SYMBOLIC_ATTR_VALUES.has(attr) && typeof value === 'string') {
      out.set(k, f.keyword(value));
    } else {
      out.set(k, value);
    }
  }
  return out;
}

/** Convert one Lisp face hash-map back into a JSON face object. */
function lispFaceToJson(face) {
  const out = {};
  if (!(face instanceof Map)) return out;
  for (const [k, value] of face.entries()) {
    const attr = k && typeof k.name === 'string' ? k.name : String(k);
    if (value && typeof value.name === 'string') {
      // A Sym/Keyword — drop the leading-colon distinction in JSON.
      out[attr] = value.name;
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      out[attr] = value;
    } else if (typeof value === 'string') {
      out[attr] = value;
    } else if (value === null || value === undefined) {
      // skip
    } else {
      out[attr] = String(value);
    }
  }
  return out;
}

/** Convert the JSON face-overrides blob into the Lisp shape.
 *  @param {object | null} json
 *  @param {LispFactories} f */
export function jsonToLispOverrides(json, f) {
  const out = emptyOverrides(f);
  if (!json || typeof json !== 'object') return out;
  const globals = out.get(f.keyword('global'));
  if (json.global && typeof json.global === 'object') {
    for (const [face, attrs] of Object.entries(json.global)) {
      globals.set(f.sym(face), jsonFaceToLisp(attrs, f));
    }
  }
  const themes = out.get(f.keyword('themes'));
  if (json.themes && typeof json.themes === 'object') {
    for (const [theme, faces] of Object.entries(json.themes)) {
      const themeMap = new Map();
      if (faces && typeof faces === 'object') {
        for (const [face, attrs] of Object.entries(faces)) {
          themeMap.set(f.sym(face), jsonFaceToLisp(attrs, f));
        }
      }
      themes.set(f.sym(theme), themeMap);
    }
  }
  return out;
}

/** Convert a Lisp face-overrides hash-map back into the JSON shape.
 *  @param {Map<*, *>} overrides
 *  @param {LispFactories} f */
export function lispToJsonOverrides(overrides, f) {
  const out = { global: {}, themes: {} };
  if (!(overrides instanceof Map)) return out;
  const globals = overrides.get(f.keyword('global'));
  if (globals instanceof Map) {
    for (const [face, attrs] of globals.entries()) {
      const name = face && typeof face.name === 'string' ? face.name : String(face);
      const json = lispFaceToJson(attrs);
      if (Object.keys(json).length > 0) out.global[name] = json;
    }
  }
  const themes = overrides.get(f.keyword('themes'));
  if (themes instanceof Map) {
    for (const [theme, faces] of themes.entries()) {
      const tname = theme && typeof theme.name === 'string' ? theme.name : String(theme);
      const tjson = {};
      if (faces instanceof Map) {
        for (const [face, attrs] of faces.entries()) {
          const fname = face && typeof face.name === 'string' ? face.name : String(face);
          const json = lispFaceToJson(attrs);
          if (Object.keys(json).length > 0) tjson[fname] = json;
        }
      }
      if (Object.keys(tjson).length > 0) out.themes[tname] = tjson;
    }
  }
  return out;
}
