/**
 * @file Bracket matching — finding the partner of the bracket at the
 * cursor, so the view can highlight the pair. Pure and DOM-free.
 *
 * Brackets inside strings and comments are skipped: a non-code mask is
 * computed for the language first. The mask is a whole-buffer scan, so
 * multi-line strings and comments are handled. Matching is otherwise a
 * depth count of one bracket type.
 */

/** Open brackets mapped to their close. */
const OPENERS = { '(': ')', '[': ']', '{': '}' };

/** Close brackets mapped to their open. */
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

/** Mark a string literal beginning at `i`; returns the index after it. */
function maskString(text, mask, i, quote) {
  mask[i] = 1;
  let j = i + 1;
  while (j < text.length && text[j] !== quote) {
    if (text[j] === '\\') {
      mask[j] = 1;
      j += 1;
    }
    if (j < text.length) {
      mask[j] = 1;
      j += 1;
    }
  }
  if (j < text.length) {
    mask[j] = 1; // the closing quote
    j += 1;
  }
  return j;
}

/** A mask marking characters inside Lisp strings and `;` comments. */
function lispMask(text) {
  const mask = new Uint8Array(text.length);
  let i = 0;
  while (i < text.length) {
    if (text[i] === ';') {
      while (i < text.length && text[i] !== '\n') mask[i++] = 1;
    } else if (text[i] === '"') {
      i = maskString(text, mask, i, '"');
    } else {
      i += 1;
    }
  }
  return mask;
}

/** A mask marking characters inside JavaScript strings and comments. */
function javascriptMask(text) {
  const mask = new Uint8Array(text.length);
  let i = 0;
  while (i < text.length) {
    const pair = text.slice(i, i + 2);
    const ch = text[i];
    if (pair === '//') {
      while (i < text.length && text[i] !== '\n') mask[i++] = 1;
    } else if (pair === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      while (i < stop) mask[i++] = 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      i = maskString(text, mask, i, ch);
    } else {
      i += 1;
    }
  }
  return mask;
}

/** Characters that are inside a string or comment, by language. */
function nonCodeMask(text, language) {
  if (language === 'lisp') return lispMask(text);
  if (language === 'javascript') return javascriptMask(text);
  return new Uint8Array(text.length);
}

/** From an open bracket at `i`, the index of its matching close, or -1. */
function matchForward(text, i, mask) {
  const open = text[i];
  const close = OPENERS[open];
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    if (mask[j]) continue;
    if (text[j] === open) depth += 1;
    else if (text[j] === close) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** From a close bracket at `i`, the index of its matching open, or -1. */
function matchBackward(text, i, mask) {
  const close = text[i];
  const open = CLOSERS[close];
  let depth = 0;
  for (let j = i; j >= 0; j -= 1) {
    if (mask[j]) continue;
    if (text[j] === close) depth += 1;
    else if (text[j] === open) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/**
 * The offset of the open bracket of the form enclosing `point`, or
 * `-1` if `point` is not inside any form. Brackets inside strings
 * and comments are ignored. Used by the inline-evaluation commands
 * to find the form-at-point.
 *
 * @param {string} text
 * @param {number} point
 * @param {'lisp' | 'javascript' | 'plain'} [language='plain']
 * @returns {number}
 */
function findEnclosingOpen(text, point, language) {
  const mask = nonCodeMask(text, language);
  let depth = 0;
  for (let i = point - 1; i >= 0; i -= 1) {
    if (mask[i]) continue;
    const ch = text[i];
    if (Object.hasOwn(OPENERS, ch)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (Object.hasOwn(CLOSERS, ch)) {
      depth += 1;
    }
  }
  return -1;
}

/**
 * The (start, end) of the form enclosing `point`, half-open
 * (`end` is just past the closing bracket). Returns `null` when
 * `point` is not inside any complete form.
 *
 * @param {string} text
 * @param {number} point
 * @param {'lisp' | 'javascript' | 'plain'} [language='plain']
 * @returns {{ start: number, end: number } | null}
 */
export function formBoundsAtPoint(text, point, language = 'plain') {
  const open = findEnclosingOpen(text, point, language);
  if (open < 0) return null;
  const mask = nonCodeMask(text, language);
  const close = matchForward(text, open, mask);
  if (close < 0) return null;
  return { start: open, end: close + 1 };
}

/**
 * The (start, end) of the complete form immediately before `point`.
 * If the char just before point is a closer, returns its full form.
 * If it's part of a bare atom (symbol / number / `"string"`), scans
 * back to the atom's start. Returns `null` when there isn't one.
 *
 * @param {string} text
 * @param {number} point
 * @param {'lisp' | 'javascript' | 'plain'} [language='plain']
 * @returns {{ start: number, end: number } | null}
 */
export function formBoundsBeforePoint(text, point, language = 'plain') {
  // Skip trailing whitespace.
  let end = point;
  while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
  if (end === 0) return null;
  const mask = nonCodeMask(text, language);
  const ch = text[end - 1];
  if (Object.hasOwn(CLOSERS, ch) && !mask[end - 1]) {
    const open = matchBackward(text, end - 1, mask);
    if (open < 0) return null;
    return { start: open, end };
  }
  if (ch === '"' && !mask[end - 1]) {
    // The string just ended here — scan back to its opening quote.
    // `mask[i]` is set for every char inside a string (including the
    // opening quote); the first index where it flips to 0 is one
    // past the opener.
    let i = end - 2;
    while (i >= 0 && mask[i]) i -= 1;
    return { start: i + 1, end };
  }
  // An atom — scan back over symbol chars.
  const ATOM_DELIM = /[\s()[\]{}";'`,]/;
  let start = end - 1;
  while (start > 0 && !ATOM_DELIM.test(text[start - 1])) start -= 1;
  if (start >= end) return null;
  return { start, end };
}

/**
 * The bracket pair to highlight for a cursor at `point`, or `null`.
 * A close bracket immediately before the cursor, or an open bracket at
 * the cursor, is matched to its partner. Brackets inside strings and
 * comments are ignored.
 *
 * @param {string} text
 * @param {number} point
 * @param {'lisp' | 'javascript' | 'plain'} [language='plain']
 * @returns {{ a: number, b: number } | null} The two bracket offsets.
 */
export function matchingBracket(text, point, language = 'plain') {
  const mask = nonCodeMask(text, language);

  const before = point > 0 ? text[point - 1] : '';
  if (Object.hasOwn(CLOSERS, before) && !mask[point - 1]) {
    const match = matchBackward(text, point - 1, mask);
    if (match !== -1) return { a: point - 1, b: match };
  }
  const at = point < text.length ? text[point] : '';
  if (Object.hasOwn(OPENERS, at) && !mask[point]) {
    const match = matchForward(text, point, mask);
    if (match !== -1) return { a: point, b: match };
  }
  return null;
}
