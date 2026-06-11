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

/** Named keys mapped to the names used in key strings. */
const NAMED_KEYS = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Backspace: 'backspace',
  Delete: 'delete',
  Enter: 'enter',
  Tab: 'tab',
  Home: 'home',
  End: 'end',
  Escape: 'escape',
  ' ': 'space',
};

/** `event.code` values mapped to the names used in key strings. */
const NAMED_CODES = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Backspace: 'backspace',
  Delete: 'delete',
  Enter: 'enter',
  Tab: 'tab',
  Home: 'home',
  End: 'end',
  Escape: 'escape',
  Space: 'space',
  // The bracket keys read as their characters, so a binding can say
  // "M-[" / "M-]" (Sublime's indent keys) rather than "M-bracketleft".
  // Other punctuation codes keep their lowercased code names — existing
  // bindings like "M-S-comma" depend on them.
  BracketLeft: '[',
  BracketRight: ']',
};

/**
 * Derive a layout-independent base name from `event.code`. `event.code`
 * names a physical key (`KeyX`, `Digit1`, `ArrowLeft`) regardless of
 * the keyboard layout or of Option composing a character on macOS.
 *
 * @param {string} code
 * @returns {string}
 */
function codeToBase(code) {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return NAMED_CODES[code] ?? code.toLowerCase();
}

/**
 * Normalise a keyboard event to a key string, for keymap dispatch by
 * the host (the editor's real keymap is defined in Lisp).
 *
 * A bare printable key is returned as typed — `"a"`, `"A"`, `"("`, `" "`
 * — so it can be self-inserted. Everything else gets a name and, when
 * held, modifier prefixes in this order:
 *
 *   `C-` Control · `M-` Command (Meta, the Emacs-on-Mac convention) ·
 *   `A-` Option (Alt) · `S-` Shift
 *
 * Examples: `"left"`, `"S-left"`, `"C-z"`, `"M-x"` (Cmd+X), `"A-]"`
 * (Option+]), `"C-M-S-q"`.
 *
 * Option deliberately gets its own `A-` prefix rather than Meta: it
 * stays free for user bindings, and — because an *unbound* `A-` chord
 * falls through to inserting the character Option composed (see the
 * keydown dispatchers) — native macOS typing of curly quotes and
 * accented letters works in the buffer.
 *
 * For a modified key the base name comes from `event.code` when present,
 * so `A-x` is `"A-x"` even where Option composes a character (macOS).
 * Synthetic events without a `code` fall back to `event.key`.
 *
 * @param {Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'metaKey' |
 *   'ctrlKey' | 'altKey'>} event
 * @returns {string}
 */
export function keyEventToString(event) {
  const { key } = event;
  const ctrl = event.ctrlKey;
  const meta = event.metaKey;
  const alt = event.altKey;

  // A bare printable character: return it exactly as typed.
  if (key.length === 1 && !ctrl && !meta && !alt) {
    return key;
  }

  const base =
    (ctrl || meta || alt) && event.code
      ? codeToBase(event.code)
      : NAMED_KEYS[key] ?? key.toLowerCase();

  let prefix = '';
  if (ctrl) prefix += 'C-';
  if (meta) prefix += 'M-';
  if (alt) prefix += 'A-';
  if (event.shiftKey) prefix += 'S-';
  return prefix + base;
}

/**
 * Whether an unhandled key event should fall back to inserting the
 * character it composed: Option (alone, possibly with Shift) held, and
 * the platform composed a single printable character (`’`, `“`, `é`,
 * `å`, …). The dispatchers try the `A-…` chord first — a user binding
 * wins — and call this only when the keymap declined.
 *
 * @param {Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>} event
 * @returns {boolean}
 */
export function altComposedInsert(event) {
  return (
    event.altKey === true &&
    !event.ctrlKey &&
    !event.metaKey &&
    typeof event.key === 'string' &&
    event.key.length === 1
  );
}
