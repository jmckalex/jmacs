/**
 * @file `<placeholder-view>` — the chooser view a freshly-split pane
 * shows until the user decides what it should hold. It replaces split's
 * old silent auto-clone (`buildDuplicateViewForSplit`) with an explicit
 * prompt:
 *
 *   > Do you want to … open a file, clone the previous view, start a new
 *   > file, or run a command?
 *
 * with `o`/`c`/`s`/`r` accelerators (underlined), an `Enter` default
 * (the host-configured `*placeholder-default-action*`), and a command
 * mode: pressing `r` swaps the chips for a bare centred `<input>` whose
 * Enter runs the typed command through the host (Escape returns to the
 * chooser).
 *
 * Per-view-instance, like `<browser-view>`: each split mints its own
 * placeholder element (no shared singleton). The element captures its
 * own accelerator keys when focused (the jukebox / view-list pattern)
 * and forwards genuine editor chords through `onKey` so `C-x` etc. still
 * fire while the chooser has focus. In command mode the `<input>` keeps
 * all its own keys (the browser URL-bar pattern).
 *
 * See `plans/PANES-PLACEHOLDER.md` for the design intent and
 * `docs/CUSTOM-VIEWS.md` for the view-kind contract.
 */

import { keyEventToString } from './keymap.js';
import { defineViewElement, ViewElement } from './view-elements.js';

/** A bare modifier press is not a key in its own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/**
 * @typedef {object} PlaceholderViewOptions
 * @property {() => void} [onOpen] - The `o` action (find-file into this
 *   pane).
 * @property {() => void} [onClone] - The `c` action (clone the originating
 *   view into this pane).
 * @property {() => void} [onNewFile] - The `s` action (fresh text view).
 * @property {(text: string) => void} [onRunCommand] - The `r` action's
 *   commit: run the typed command name.
 * @property {() => string} [defaultAction] - Returns the resolved default
 *   action (`open`/`clone`/`new`/`command`/`none`) — read lazily when
 *   Enter is pressed so a customisation change is honoured live.
 * @property {string} [cloneLabel] - The label for the clone chip (e.g.
 *   "clone the previous view"); lets the host name the origin kind.
 * @property {boolean} [cloneEnabled] - Whether cloning is available (a
 *   split always has an origin, so normally true; false greys the chip).
 * @property {(key: string) => boolean} [onKey] - Editor chord dispatcher;
 *   forwarded genuine chords so the host keymap fires while focused.
 */

export class PlaceholderView extends ViewElement {
  constructor() {
    super();
    /** @type {PlaceholderViewOptions | null} */
    this._options = null;
    /** @type {object | null} - The placeholder view object. */
    this._buffer = null;
    this._mounted = false;
    /** @type {HTMLElement | null} */
    this._chooserEl = null;
    /** @type {HTMLElement | null} */
    this._commandEl = null;
    /** @type {HTMLInputElement | null} */
    this._input = null;
    this._mode = 'chooser'; // 'chooser' | 'command'
  }

  /**
   * Supply the host's configuration. Must be called before the first
   * `connectedCallback`. Reconfiguring after mount throws (the
   * view-kind contract).
   *
   * @param {PlaceholderViewOptions} options
   */
  configure(options) {
    if (this._mounted) {
      throw new Error(
        'PlaceholderView.configure: cannot reconfigure after mount'
      );
    }
    this._options = options ?? null;
  }

  get kind() {
    return 'placeholder';
  }

  /** Repoint at a placeholder view object. The element carries no real
   *  payload — the buffer is only kept so the host's mount dispatch has
   *  something to set. */
  setBuffer(next) {
    this._buffer = next;
  }

  get buffer() {
    return this._buffer;
  }

  focus() {
    if (this._mode === 'command' && this._input) {
      this._input.focus();
      return;
    }
    if (this._mounted) super.focus();
  }

  // --- lifecycle ------------------------------------------------------

  connectedCallback() {
    if (this._mounted) return;
    this._ensureMounted();
  }

  disconnectedCallback() {
    /* hide-not-kill: a DOM move keeps the element alive */
  }

  destroy() {
    this._buffer = null;
  }

  // --- internal -------------------------------------------------------

  _ensureMounted() {
    if (this._mounted) return;
    const doc = this.ownerDocument;
    this.classList.add('placeholder-view');
    this.tabIndex = 0;

    // The chooser: prompt + four accelerator chips + an Enter hint.
    const chooser = doc.createElement('div');
    chooser.className = 'placeholder-chooser';

    const prompt = doc.createElement('div');
    prompt.className = 'placeholder-prompt';
    prompt.append(doc.createTextNode('Do you want to…'));
    chooser.append(prompt);

    const chips = doc.createElement('div');
    chips.className = 'placeholder-chips';
    this._appendChip(doc, chips, 'open', 'open', 'a file', 'o', () =>
      this._act('open')
    );
    const cloneEnabled =
      !this._options || this._options.cloneEnabled !== false;
    const cloneLabel =
      this._options && typeof this._options.cloneLabel === 'string'
        ? this._options.cloneLabel
        : 'the previous view';
    this._cloneChip = this._appendChip(
      doc,
      chips,
      'clone',
      'clone',
      cloneLabel,
      'c',
      () => this._act('clone')
    );
    if (!cloneEnabled) {
      this._cloneChip.classList.add('is-disabled');
      this._cloneChip.setAttribute('aria-disabled', 'true');
    }
    this._appendChip(doc, chips, 'new', 'start a', 'new file', 's', () =>
      this._act('new')
    );
    this._appendChip(doc, chips, 'command', 'run a', 'command', 'r', () =>
      this._act('command')
    );
    chooser.append(chips);

    const hint = doc.createElement('div');
    hint.className = 'placeholder-hint';
    hint.textContent = 'Enter for the default · Esc keeps the placeholder';
    chooser.append(hint);

    // Command mode: a bare centred input below a short label.
    const command = doc.createElement('div');
    command.className = 'placeholder-command';
    command.style.display = 'none';
    const cmdLabel = doc.createElement('div');
    cmdLabel.className = 'placeholder-command-label';
    cmdLabel.textContent = 'Run command:';
    const input = doc.createElement('input');
    input.className = 'placeholder-command-input';
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = 'command name (e.g. gnuplot)';
    command.append(cmdLabel, input);

    this._chooserEl = chooser;
    this._commandEl = command;
    this._input = input;
    this.append(chooser, command);

    this._wireEvents();
    this._mounted = true;
  }

  /** Build one accelerator chip: LEAD text, then ACCEL with the matching
   *  letter underlined, then a trailing REST. Returns the chip element. */
  _appendChip(doc, parent, action, lead, rest, accel, handler) {
    const chip = doc.createElement('button');
    chip.type = 'button';
    chip.className = 'placeholder-chip';
    chip.dataset.action = action;
    if (lead) chip.append(doc.createTextNode(lead + ' '));
    // The accelerator word with its first matching letter underlined.
    const idx = rest.toLowerCase().indexOf(accel.toLowerCase());
    if (idx >= 0) {
      if (idx > 0) chip.append(doc.createTextNode(rest.slice(0, idx)));
      const u = doc.createElement('span');
      u.className = 'placeholder-accel';
      u.textContent = rest[idx];
      chip.append(u);
      chip.append(doc.createTextNode(rest.slice(idx + 1)));
    } else {
      chip.append(doc.createTextNode(rest));
    }
    chip.addEventListener('click', (event) => {
      event.preventDefault();
      handler();
    });
    parent.append(chip);
    return chip;
  }

  _wireEvents() {
    // Keys on the wrapper: accelerators when in chooser mode; chord
    // forwarding for genuine editor chords in both modes.
    this.addEventListener('keydown', (event) => {
      if (MODIFIERS.has(event.key)) return;
      // The command input owns all its own keys (handled separately).
      if (event.target === this._input) return;

      // Forward genuine editor chords (Ctrl/Alt/Meta held) so C-x etc.
      // still fire while the chooser has focus — never the bare keys,
      // which are the chooser's accelerators.
      if (event.ctrlKey || event.altKey || event.metaKey) {
        const onKey = this._options && this._options.onKey;
        if (typeof onKey === 'function' && onKey(keyEventToString(event))) {
          event.preventDefault();
        }
        return;
      }

      if (this._mode !== 'chooser') return;
      const key = event.key;
      if (key === 'o' || key === 'O') {
        event.preventDefault();
        this._act('open');
      } else if (key === 'c' || key === 'C') {
        event.preventDefault();
        this._act('clone');
      } else if (key === 's' || key === 'S') {
        event.preventDefault();
        this._act('new');
      } else if (key === 'r' || key === 'R') {
        event.preventDefault();
        this._act('command');
      } else if (key === 'Enter') {
        event.preventDefault();
        this._act('default');
      } else if (key === 'Escape') {
        // No-op in v1 — the pane keeps the placeholder until filled.
        event.preventDefault();
      } else if (key.length === 1) {
        // Swallow stray printables so they don't leak to the window
        // router (which would otherwise try to self-insert).
        event.preventDefault();
      }
    });

    // Command-mode input: Enter commits, Escape returns to the chooser.
    const input = /** @type {HTMLInputElement} */ (this._input);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const text = input.value.trim();
        if (text !== '') {
          const run = this._options && this._options.onRunCommand;
          if (typeof run === 'function') run(text);
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this._exitCommandMode();
      }
      // All other keys are the input's own.
    });
  }

  /** Perform ACTION. `'default'` resolves through the host's
   *  `defaultAction` getter (the `*placeholder-default-action*`
   *  customisation). The clone chip is a no-op when disabled. */
  _act(action) {
    let resolved = action;
    if (action === 'default') {
      const getter = this._options && this._options.defaultAction;
      resolved = typeof getter === 'function' ? getter() : 'clone';
    }
    switch (resolved) {
      case 'open':
        this._invoke('onOpen');
        break;
      case 'clone':
        if (this._cloneChip && this._cloneChip.classList.contains('is-disabled')) {
          return;
        }
        this._invoke('onClone');
        break;
      case 'new':
        this._invoke('onNewFile');
        break;
      case 'command':
        this._enterCommandMode();
        break;
      case 'none':
      default:
        break;
    }
  }

  _invoke(name) {
    const fn = this._options && this._options[name];
    if (typeof fn === 'function') {
      try {
        fn();
      } catch {
        /* host's problem; the placeholder stays put */
      }
    }
  }

  _enterCommandMode() {
    if (!this._mounted) return;
    this._mode = 'command';
    if (this._chooserEl) this._chooserEl.style.display = 'none';
    if (this._commandEl) this._commandEl.style.display = '';
    if (this._input) {
      this._input.value = '';
      this._input.focus();
    }
  }

  _exitCommandMode() {
    this._mode = 'chooser';
    if (this._commandEl) this._commandEl.style.display = 'none';
    if (this._chooserEl) this._chooserEl.style.display = '';
    super.focus();
  }
}

defineViewElement('placeholder-view', PlaceholderView);
