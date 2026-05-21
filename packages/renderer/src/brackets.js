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
