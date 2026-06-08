/**
 * @file face-overrides.js — convert between the on-disk JSON shape of
 * `faces.json` and the in-memory Lisp shape of `*face-overrides*`.
 *
 * JSON shape (what the user sees and edits if they open faces.json):
 *
 *   { "global":  { "keyword": { "weight": "bold" } },
 *     "themes":  { "dark": { "operator": { "foreground": "#62b3b2" } } },
 *     "perMode": { "LaTeX": { "keyword": { "foreground": "#c0a" } } } }
 *
 * Lisp shape (`*face-overrides*`):
 *
 *   {:global  { keyword       -> { :weight :bold } }
 *    :themes  { dark -> { operator -> { :foreground "#62b3b2" } } }
 *    :perMode { "LaTeX" -> { keyword -> { :foreground "#c0a" } } }}
 *
 * The `perMode` bucket is keyed by the major-mode DISPLAY NAME (a plain
 * string — "LaTeX", "Python" — not a symbol), since that is how Lisp's
 * per-mode store is keyed. A faces.json written before perMode existed
 * (no `perMode` key) loads cleanly: the bucket is simply empty.
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
  m.set(f.keyword('perMode'), new Map());
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
  // perMode is keyed by the mode DISPLAY NAME (a string), so the bucket
  // key stays a string; only the inner face names are symbols. Absent
  // in a pre-perMode faces.json — the bucket then stays empty (migration
  // is a no-op read).
  const perMode = out.get(f.keyword('perMode'));
  if (json.perMode && typeof json.perMode === 'object') {
    for (const [mode, faces] of Object.entries(json.perMode)) {
      const modeMap = new Map();
      if (faces && typeof faces === 'object') {
        for (const [face, attrs] of Object.entries(faces)) {
          modeMap.set(f.sym(face), jsonFaceToLisp(attrs, f));
        }
      }
      perMode.set(mode, modeMap);
    }
  }
  return out;
}

/** Convert a Lisp face-overrides hash-map back into the JSON shape.
 *  @param {Map<*, *>} overrides
 *  @param {LispFactories} f */
export function lispToJsonOverrides(overrides, f) {
  const out = { global: {}, themes: {}, perMode: {} };
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
  // perMode: the bucket key is a mode DISPLAY NAME (a string already);
  // inner face names are symbols.
  const perMode = overrides.get(f.keyword('perMode'));
  if (perMode instanceof Map) {
    for (const [mode, faces] of perMode.entries()) {
      const mname = mode && typeof mode.name === 'string' ? mode.name : String(mode);
      const mjson = {};
      if (faces instanceof Map) {
        for (const [face, attrs] of faces.entries()) {
          const fname = face && typeof face.name === 'string' ? face.name : String(face);
          const json = lispFaceToJson(attrs);
          if (Object.keys(json).length > 0) mjson[fname] = json;
        }
      }
      if (Object.keys(mjson).length > 0) out.perMode[mname] = mjson;
    }
  }
  return out;
}

// --- the full faces.json file (v2) ------------------------------------
// The file carries three things in one blob: the colour `overrides`
// (global/themes/perMode, above), the user-created `userFaces`, and the
// `highlightRules`. A v1 file (just {global, themes}) reads cleanly —
// the absent sections become empty.

/** Lisp `:keyword` -> the bare attribute name. */
function nameOf(k) {
  return k && typeof k.name === 'string' ? k.name : String(k);
}

/** Convert one user-face Lisp entry (a hash-map of :doc :parent
 *  :light :dark :bright :midnight) into its JSON object. */
function lispUserFaceToJson(entry) {
  if (!(entry instanceof Map)) return null;
  const out = {};
  for (const [k, v] of entry.entries()) {
    const key = nameOf(k);
    if (key === 'doc') {
      out.doc = typeof v === 'string' ? v : '';
    } else if (key === 'parent') {
      out.parent = v && typeof v.name === 'string' ? v.name : null;
    } else if (['light', 'dark', 'bright', 'midnight'].includes(key)) {
      out[key] = lispFaceToJson(v);
    }
  }
  return out;
}

/** Convert the Lisp `*user-faces*` map into a JSON object keyed by face
 *  name. */
function lispUserFacesToJson(userFaces) {
  const out = {};
  if (!(userFaces instanceof Map)) return out;
  for (const [name, entry] of userFaces.entries()) {
    const json = lispUserFaceToJson(entry);
    if (json) out[nameOf(name)] = json;
  }
  return out;
}

/** Convert the Lisp `*highlight-rules*` store (scope-key string -> list
 *  of (pattern . face) cons pairs) into a JSON object of
 *  scope-key -> [[pattern, face], …]. The list arrives as a JS array of
 *  Pair objects (the caller passes a listToArray). */
function lispHighlightRulesToJson(rules, listToArray) {
  const out = {};
  if (!(rules instanceof Map) || typeof listToArray !== 'function') return out;
  for (const [scopeKey, ruleList] of rules.entries()) {
    const key = typeof scopeKey === 'string' ? scopeKey : nameOf(scopeKey);
    const arr = [];
    for (const pair of listToArray(ruleList)) {
      if (!pair) continue;
      const pattern = pair.head;
      const face = pair.tail;
      if (typeof pattern === 'string') {
        arr.push([pattern, typeof face === 'string' ? face : nameOf(face)]);
      }
    }
    if (arr.length > 0) out[key] = arr;
  }
  return out;
}

/**
 * Serialise the full faces-file Lisp map (from `current-faces-file`)
 * into the JSON shape written to faces.json.
 *
 * @param {Map<*, *>} facesFile - {:overrides :userFaces :highlightRules}
 * @param {LispFactories} f
 * @param {(form: *) => Array<*>} listToArray - to unfold rule lists.
 * @returns {object}
 */
export function lispToJsonFacesFile(facesFile, f, listToArray) {
  const overrides =
    facesFile instanceof Map ? facesFile.get(f.keyword('overrides')) : null;
  const json = lispToJsonOverrides(overrides, f);
  json.version = 2;
  const userFaces =
    facesFile instanceof Map ? facesFile.get(f.keyword('userFaces')) : null;
  json.userFaces = lispUserFacesToJson(userFaces);
  const rules =
    facesFile instanceof Map
      ? facesFile.get(f.keyword('highlightRules'))
      : null;
  json.highlightRules = lispHighlightRulesToJson(rules, listToArray);
  return json;
}

/**
 * Build the Lisp `*user-faces*` map from the faces.json `userFaces`
 * object. Theme face values become Lisp face hash-maps; the parent is a
 * symbol (or nil). Absent / malformed input yields an empty map.
 *
 * @param {object | null} json - The whole faces.json object.
 * @param {LispFactories} f
 * @returns {Map<*, *>}
 */
export function jsonToLispUserFaces(json, f) {
  const out = new Map();
  const userFaces = json && typeof json === 'object' ? json.userFaces : null;
  if (!userFaces || typeof userFaces !== 'object') return out;
  for (const [name, entry] of Object.entries(userFaces)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = new Map();
    e.set(f.keyword('doc'), typeof entry.doc === 'string' ? entry.doc : '');
    e.set(
      f.keyword('parent'),
      typeof entry.parent === 'string' ? f.sym(entry.parent) : null
    );
    for (const theme of ['light', 'dark', 'bright', 'midnight']) {
      e.set(f.keyword(theme), jsonFaceToLisp(entry[theme], f));
    }
    out.set(f.sym(name), e);
  }
  return out;
}

/**
 * Build the Lisp `*highlight-rules*` store from the faces.json
 * `highlightRules` object (scope-key -> [[pattern, face], …]). Each
 * bucket becomes a Lisp list of `(pattern . face)` cons pairs. Absent
 * input yields an empty map.
 *
 * @param {object | null} json - The whole faces.json object.
 * @param {LispFactories} f
 * @param {(items: Array<*>) => *} arrayToList - builds a Lisp list.
 * @param {(head: *, tail: *) => *} cons - builds a Lisp cons pair.
 * @returns {Map<string, *>}
 */
export function jsonToLispHighlightRules(json, f, arrayToList, cons) {
  const out = new Map();
  const rules = json && typeof json === 'object' ? json.highlightRules : null;
  if (!rules || typeof rules !== 'object') return out;
  for (const [scopeKey, ruleArr] of Object.entries(rules)) {
    if (!Array.isArray(ruleArr)) continue;
    const pairs = [];
    for (const pair of ruleArr) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      pairs.push(cons(String(pair[0]), String(pair[1])));
    }
    if (pairs.length > 0) out.set(scopeKey, arrayToList(pairs));
  }
  return out;
}
