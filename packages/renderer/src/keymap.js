/**
 * @file Keymap — the pure translation from a keyboard event to an
 * editor intent. Takes only the fields it needs from a `KeyboardEvent`,
 * so it can be exercised with plain objects in tests.
 *
 * This is a v0 keymap baked into the renderer. The editor's real
 * keybindings will eventually be defined in Lisp; this is the floor
 * that makes the window usable before that exists.
 */

/**
 * An editor intent resolved from a keystroke.
 *
 * @typedef {object} InsertIntent
 * @property {'insert'} type
 * @property {string} text - Text to insert at the cursor.
 *
 * @typedef {object} CommandIntent
 * @property {'command'} type
 * @property {string} name - A buffer command name.
 * @property {boolean} [extend] - Whether a movement should extend the
 *   selection.
 *
 * @typedef {InsertIntent | CommandIntent} KeyIntent
 */

/** Movement keys, mapped to their plain (unmodified) command. */
const MOVEMENT = {
  ArrowLeft: 'moveLeft',
  ArrowRight: 'moveRight',
  ArrowUp: 'moveUp',
  ArrowDown: 'moveDown',
  Home: 'moveLineStart',
  End: 'moveLineEnd',
};

/** Movement keys with a modifier (Cmd/Ctrl) held — jump further. */
const MOVEMENT_WITH_MOD = {
  ArrowLeft: 'moveLineStart',
  ArrowRight: 'moveLineEnd',
  ArrowUp: 'moveBufferStart',
  ArrowDown: 'moveBufferEnd',
};

/**
 * Resolve a keyboard event to an editor intent.
 *
 * @param {Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' |
 *   'ctrlKey' | 'altKey'>} event
 * @returns {KeyIntent | null} The intent, or `null` if the key is not
 *   bound (the caller should let the event through).
 */
export function resolveKey(event) {
  const { key, shiftKey: shift, altKey: alt } = event;
  // The target platform is macOS; treat Cmd and Ctrl alike so the
  // editor is still usable on a non-Mac keyboard.
  const mod = event.metaKey || event.ctrlKey;

  if (key === 'Backspace') return { type: 'command', name: 'deleteBackward' };
  if (key === 'Delete') return { type: 'command', name: 'deleteForward' };
  if (key === 'Enter') return { type: 'insert', text: '\n' };
  if (key === 'Tab') return { type: 'insert', text: '  ' };

  if (mod && (key === 'z' || key === 'Z')) {
    return { type: 'command', name: shift ? 'redo' : 'undo' };
  }

  if (Object.hasOwn(MOVEMENT, key)) {
    const name = (mod ? MOVEMENT_WITH_MOD : MOVEMENT)[key];
    return { type: 'command', name, extend: shift };
  }

  // A single printable character, with no command modifier held.
  if (key.length === 1 && !mod && !alt) {
    return { type: 'insert', text: key };
  }

  return null;
}
