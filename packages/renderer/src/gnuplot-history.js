/**
 * @file A small, DOM-free command-history ring for the gnuplot notebook
 * view's input line. The shell v4 view keeps no history of its own —
 * xterm.js hands raw bytes to the child shell, whose readline/ZLE owns
 * Up/Down. The gnuplot view has a bare `<input>` with no readline, so it
 * must implement history itself. Extracting it as pure logic keeps it
 * unit-testable without a DOM (per CLAUDE.md's "unit-test pure logic").
 *
 * The model is the standard REPL triple:
 *   - `entries[]`     — submitted commands, oldest → newest.
 *   - `index`         — a cursor into `entries`; `index === entries.length`
 *                       means "the live (not-yet-submitted) line".
 *   - `draft`         — the half-typed line stashed when you first arrow up,
 *                       restored when you arrow back down past the newest
 *                       entry.
 *
 * `up(current)` / `down(current)` take the input's current text (so the
 * draft can be captured) and return the text the input should show.
 */

/**
 * Create a command-history ring.
 *
 * @returns {{
 *   push: (command: string) => void,
 *   up: (current: string) => string,
 *   down: (current: string) => string,
 *   reset: () => void,
 *   entries: () => string[],
 *   index: () => number,
 * }}
 */
export function createHistory() {
  /** @type {string[]} */
  const entries = [];
  let index = 0;
  let draft = '';

  return {
    /**
     * Record a submitted command. Blank/whitespace-only commands are
     * ignored (matching the shell/REPL convention). After a push the
     * cursor resets to the live line and the draft is cleared.
     *
     * @param {string} command
     */
    push(command) {
      if (typeof command === 'string' && command.trim() !== '') {
        entries.push(command);
      }
      index = entries.length;
      draft = '';
    },

    /**
     * Walk one step toward older history. On the first step from the
     * live line, `current` is stashed as the draft. Returns the text to
     * show; at the oldest entry it stays put.
     *
     * @param {string} current
     * @returns {string}
     */
    up(current) {
      if (entries.length === 0) return current;
      if (index === entries.length) draft = current;
      if (index > 0) index -= 1;
      return entries[index];
    },

    /**
     * Walk one step toward newer history. Stepping past the newest entry
     * returns to the live line (the stashed draft). Already on the live
     * line, returns the draft unchanged.
     *
     * @param {string} current
     * @returns {string}
     */
    down(current) {
      if (index >= entries.length) return draft;
      index += 1;
      if (index === entries.length) return draft;
      return entries[index];
    },

    /** Reset the cursor to the live line and clear the draft. */
    reset() {
      index = entries.length;
      draft = '';
    },

    /** A copy of the recorded commands, oldest → newest. */
    entries() {
      return entries.slice();
    },

    /** The current cursor position (for tests / introspection). */
    index() {
      return index;
    },
  };
}
