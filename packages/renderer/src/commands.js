/**
 * @file Commands — applies a resolved {@link KeyIntent} to a buffer.
 * Pure with respect to the DOM: it only calls L2 buffer methods, so it
 * is fully testable without a renderer.
 */

import { resolveKey } from './keymap.js';

/** @typedef {import('@editor/buffer').Buffer} Buffer */
/** @typedef {import('./keymap.js').KeyIntent} KeyIntent */

/** Command names that map directly to a buffer method taking `{ extend }`. */
const MOVEMENT_COMMANDS = new Set([
  'moveLeft',
  'moveRight',
  'moveUp',
  'moveDown',
  'moveLineStart',
  'moveLineEnd',
  'moveBufferStart',
  'moveBufferEnd',
]);

/**
 * Apply a resolved intent to a buffer.
 *
 * @param {Buffer} buffer
 * @param {KeyIntent | null} intent
 * @returns {boolean} Whether the intent was handled (and so the
 *   originating event should be consumed).
 */
export function applyIntent(buffer, intent) {
  if (intent === null) return false;

  if (intent.type === 'insert') {
    buffer.insert(intent.text);
    return true;
  }

  const { name } = intent;

  if (MOVEMENT_COMMANDS.has(name)) {
    buffer[name]({ extend: Boolean(intent.extend) });
    return true;
  }

  switch (name) {
    case 'deleteBackward':
      buffer.deleteBackward();
      return true;
    case 'deleteForward':
      buffer.deleteForward();
      return true;
    case 'undo':
      buffer.undo();
      return true;
    case 'redo':
      buffer.redo();
      return true;
    default:
      return false;
  }
}

/**
 * Resolve a keyboard event and apply it to a buffer in one step.
 *
 * @param {Buffer} buffer
 * @param {Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' |
 *   'ctrlKey' | 'altKey'>} event
 * @returns {boolean} Whether the event was handled.
 */
export function handleKeyEvent(buffer, event) {
  return applyIntent(buffer, resolveKey(event));
}
