/**
 * @file Detecting CSS colour literals in text — a pure, DOM-free module.
 *
 * The view uses this to decorate every colour literal in a rendered
 * line with a clickable swatch. Keeping detection here, separate from
 * the DOM, means it can be unit-tested directly and reused.
 *
 * Four literal forms are recognised:
 *
 *   - `#rgb`        — three hex digits
 *   - `#rrggbb`     — six hex digits
 *   - `#rrggbbaa`   — eight hex digits (with alpha); `#rgba` (four) too
 *   - `rgb(...)`    — functional notation
 *   - `rgba(...)`   — functional notation with alpha
 *
 * A literal is reported with its exact span in the source string, so a
 * caller can replace precisely that text.
 */

/**
 * A colour literal found in a string.
 *
 * @typedef {object} ColourLiteral
 * @property {number} start - Index of the literal's first character.
 * @property {number} end - Index one past its last character.
 * @property {string} text - The literal's exact source text.
 * @property {string} css - A CSS colour value safe to assign to a
 *   `background-color` — for the functional forms this is `text`, for
 *   the hex forms it is normalised to a form the browser accepts.
 */

// A hash literal: # then 3, 4, 6 or 8 hex digits. The digit count is
// checked after the match so that, e.g., `#abcde` (five digits) does
// not match its first three as `#abc`.
const HASH = /#[0-9a-fA-F]+/g;

// Functional rgb()/rgba(). The body is any run of characters that are
// not a closing paren — digits, commas, dots, spaces, and the `%` and
// `/` that modern CSS syntax allows. Validated further below.
const FUNCTIONAL = /\brgba?\(([^()]*)\)/gi;

/** The hex-digit counts that form a valid `#…` colour. */
const VALID_HEX_LENGTHS = new Set([3, 4, 6, 8]);

/** Whether `body` (the text inside `rgb(...)`) is a plausible colour. */
function isPlausibleFunctionalBody(body) {
  if (body.trim() === '') return false;
  // Only the characters CSS colour functions use. This rejects, e.g.,
  // a stray `rgb(foo)` while accepting `rgb(1 2 3 / 50%)`.
  return /^[0-9.,%/\s]+$/.test(body);
}

/**
 * Find every colour literal in `text`.
 *
 * Pure: depends only on its argument and returns a fresh array each
 * call. Literals are returned in order of appearance and never overlap.
 *
 * @param {string} text
 * @returns {ColourLiteral[]}
 */
export function findColourLiterals(text) {
  if (typeof text !== 'string' || text === '') return [];
  const found = [];

  HASH.lastIndex = 0;
  let match;
  while ((match = HASH.exec(text)) !== null) {
    const digits = match[0].length - 1;
    if (!VALID_HEX_LENGTHS.has(digits)) continue;
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      css: match[0],
    });
  }

  FUNCTIONAL.lastIndex = 0;
  while ((match = FUNCTIONAL.exec(text)) !== null) {
    if (!isPlausibleFunctionalBody(match[1])) continue;
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      css: match[0],
    });
  }

  found.sort((a, b) => a.start - b.start);
  return found;
}

/**
 * Normalise a colour to a `#rrggbb` or `#rrggbbaa` hex string — the
 * form a native `<input type="color">` produces and the form written
 * back into the buffer. Accepts the same literals `findColourLiterals`
 * reports; returns null for anything it cannot resolve.
 *
 * `rgb(...)` / `rgba(...)` are resolved only when their channels are
 * plain integers (and the alpha a 0–1 fraction); percentage and
 * `/`-separated notations are left to the caller's CSS engine and
 * yield null here.
 *
 * @param {string} literal
 * @returns {string | null}
 */
export function normaliseToHex(literal) {
  if (typeof literal !== 'string') return null;
  const value = literal.trim();

  const hash = /^#([0-9a-fA-F]+)$/.exec(value);
  if (hash) {
    const d = hash[1];
    if (d.length === 3) {
      return `#${d[0]}${d[0]}${d[1]}${d[1]}${d[2]}${d[2]}`.toLowerCase();
    }
    if (d.length === 4) {
      return (
        `#${d[0]}${d[0]}${d[1]}${d[1]}${d[2]}${d[2]}${d[3]}${d[3]}`
      ).toLowerCase();
    }
    if (d.length === 6 || d.length === 8) return `#${d.toLowerCase()}`;
    return null;
  }

  const fn = /^rgba?\(([^()]*)\)$/i.exec(value);
  if (fn) {
    const parts = fn[1]
      .split(/[,\s]+/)
      .map((p) => p.trim())
      .filter((p) => p !== '');
    if (parts.length !== 3 && parts.length !== 4) return null;
    const channel = (p) => {
      if (!/^\d+$/.test(p)) return null;
      const n = Number(p);
      return n >= 0 && n <= 255 ? n : null;
    };
    const r = channel(parts[0]);
    const g = channel(parts[1]);
    const b = channel(parts[2]);
    if (r === null || g === null || b === null) return null;
    const hex2 = (n) => n.toString(16).padStart(2, '0');
    let result = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
    if (parts.length === 4) {
      const a = Number(parts[3]);
      if (!Number.isFinite(a) || a < 0 || a > 1) return null;
      result += hex2(Math.round(a * 255));
    }
    return result;
  }

  return null;
}
