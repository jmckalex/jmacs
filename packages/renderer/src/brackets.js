/**
 * @file Bracket matching — finding the partner of the bracket at the
 * cursor, so the view can highlight the pair. Pure and DOM-free.
 *
 * v0 matches by depth-counting one bracket type and does not skip
 * brackets inside strings or comments; that needs the syntax tree and
 * can come later.
 */

/** Open brackets mapped to their close. */
const OPENERS = { '(': ')', '[': ']', '{': '}' };

/** Close brackets mapped to their open. */
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

/** From an open bracket at `i`, the index of its matching close, or -1. */
function matchForward(text, i) {
  const open = text[i];
  const close = OPENERS[open];
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    if (text[j] === open) depth += 1;
    else if (text[j] === close) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** From a close bracket at `i`, the index of its matching open, or -1. */
function matchBackward(text, i) {
  const close = text[i];
  const open = CLOSERS[close];
  let depth = 0;
  for (let j = i; j >= 0; j -= 1) {
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
 * the cursor, is matched to its partner.
 *
 * @param {string} text
 * @param {number} point
 * @returns {{ a: number, b: number } | null} The two bracket offsets.
 */
export function matchingBracket(text, point) {
  const before = point > 0 ? text[point - 1] : '';
  if (Object.hasOwn(CLOSERS, before)) {
    const match = matchBackward(text, point - 1);
    if (match !== -1) return { a: point - 1, b: match };
  }
  const at = point < text.length ? text[point] : '';
  if (Object.hasOwn(OPENERS, at)) {
    const match = matchForward(text, point);
    if (match !== -1) return { a: point, b: match };
  }
  return null;
}
