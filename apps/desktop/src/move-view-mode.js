/**
 * @file Move-views mode — a transient overlay for `swap-views` /
 * `permute-views` (see `plans/PANES-SWAP-PERMUTE.md`).
 *
 * Structurally a sibling of `add-pane-mode.js`: the desktop primitive
 * `enter-move-views-mode!` calls `enterMoveViewsMode(...)`, which mounts
 * an overlay over `#editor-host`, numbers every pane with a shaded badge
 * (clockwise-spiral order, `spiralOrder`), and captures keystrokes at the
 * window's capture phase so they're read even when a `<webview>` had
 * focus. The pure entry logic lives in `move-view-state.js`; this module
 * is the DOM + key plumbing around it.
 *
 * On commit the supplied `onCommit(assignments)` runs (1-based numbers,
 * in spiral order — `[a, b]` for swap, a length-N destination list for
 * permute). Escape / `C-g` / a click on the backdrop cancel.
 *
 * The overlay grabs focus on entry so keystrokes reach the window even
 * if a browser pane was focused (the same reason the View-menu entries
 * exist). While it's up it is modal: every keydown is swallowed in
 * capture phase, so stray keys can't reach the focused editor or the
 * global key router.
 */

import { spiralOrder, computeRects } from '@editor/pane';
import {
  createMoveViewState,
  reduce,
  candidateNumbers,
  currentSource,
  destinationForPane,
  isReady,
} from './move-view-state.js';

/**
 * @param {object} options
 * @param {'swap'|'permute'} options.mode
 * @param {HTMLElement} options.host - `#editor-host`; the overlay mounts
 *   inside it and badges use its coordinate space (same as the panes).
 * @param {() => import('@editor/pane').Pane} options.getRootPane
 * @param {(assignments: number[]) => void} options.onCommit - Called with
 *   the 1-based spiral-order assignment(s) when the user presses Enter.
 * @returns {{ active: boolean, exit: () => void }}
 */
export function enterMoveViewsMode(options) {
  const { mode, host, getRootPane, onCommit } = options;
  if (!host || typeof getRootPane !== 'function') {
    return { active: false, exit: () => {} };
  }

  const root = getRootPane();
  const hostRect = host.getBoundingClientRect();
  const dims = { width: hostRect.width, height: hostRect.height };
  const { ordered } = spiralOrder(root, dims);
  const n = ordered.length;
  if (n < 2) {
    // Nothing to rearrange — let the caller surface a message.
    return { active: false, exit: () => {} };
  }
  const rects = computeRects(root, dims);

  let state = createMoveViewState(mode, n);

  const overlay = document.createElement('div');
  overlay.className = 'move-view-overlay';
  overlay.dataset.role = 'move-view-overlay';
  overlay.dataset.mode = mode;
  overlay.tabIndex = -1; // focusable, so it can pull focus off a webview

  const promptEl = document.createElement('div');
  promptEl.className = 'move-view-prompt';
  overlay.append(promptEl);

  const badges = ordered.map((leaf, i) => {
    const rect = rects.get(leaf.id) ?? { left: 0, top: 0 };
    const badge = document.createElement('div');
    badge.className = 'move-view-badge';
    badge.style.left = `${rect.left}px`;
    badge.style.top = `${rect.top}px`;
    overlay.append(badge);
    return { badge, number: i + 1 };
  });

  host.dataset.moveView = '1';
  host.append(overlay);
  overlay.focus();

  let alive = true;
  const handle = {
    get active() {
      return alive;
    },
    exit: () => {
      if (!alive) return;
      alive = false;
      overlay.remove();
      delete host.dataset.moveView;
      window.removeEventListener('keydown', onKeyDown, true);
    },
  };

  function render() {
    const candidates = new Set(candidateNumbers(state));
    const src = currentSource(state);
    for (const { badge, number } of badges) {
      badge.classList.toggle('is-candidate', candidates.has(number));
      badge.classList.toggle('is-current-source', src === number);
      let label = String(number);
      // In permute mode show `k→dest` for every pane whose destination is
      // known — including the forced last one, which destinationForPane
      // fills in automatically once all but one source has been assigned.
      const dest =
        state.mode === 'permute' ? destinationForPane(state, number) : null;
      const assigned = dest != null;
      const derived = assigned && number - 1 >= state.entries.length;
      if (assigned) label = `${number}→${dest}`;
      badge.classList.toggle('is-assigned', assigned);
      badge.classList.toggle('is-derived', derived);
      badge.textContent = label;
    }
    promptEl.textContent = promptText(state);
    overlay.classList.toggle('is-ready', isReady(state));
  }

  function promptText(s) {
    const help =
      '   ·   digits pick · Space confirms · ⌫ undoes · Enter applies · Esc cancels';
    const pend = s.pending ? ` [${s.pending}]` : '';
    if (s.mode === 'swap') {
      const picked = s.entries.length ? s.entries.join(' ↔ ') : 'pick two panes';
      return `Swap views: ${picked}${pend}${help}`;
    }
    const src = currentSource(s);
    if (src === null) {
      return `Permute views: ready — last pane auto-filled, press Enter${help}`;
    }
    return `Permute views: pane ${src} → ?${pend}${help}`;
  }

  function flashBeep() {
    overlay.classList.remove('move-view-beep');
    void overlay.offsetWidth; // restart the animation
    overlay.classList.add('move-view-beep');
  }

  function onKeyDown(event) {
    const mapped = mapKey(event);
    if (!mapped) {
      // Let modified keys through (Cmd/Ctrl/Alt system shortcuts still
      // work) but swallow plain keys so stray typing can't reach the
      // focused editor or the global key router. C-g is already mapped.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // Modal: a mapped key is fully consumed.
    event.preventDefault();
    event.stopPropagation();
    const result = reduce(state, mapped);
    state = result.state;
    const { effect } = result;
    if (effect.type === 'commit') {
      handle.exit();
      if (typeof onCommit === 'function') onCommit(effect.assignments);
      return;
    }
    if (effect.type === 'abort') {
      handle.exit();
      return;
    }
    if (effect.type === 'beep') flashBeep();
    render();
  }

  // A click on the backdrop cancels (and stops a stray click stealing
  // focus to a pane, which would break key capture).
  overlay.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    handle.exit();
  });

  window.addEventListener('keydown', onKeyDown, true);
  render();
  return handle;
}

/** Map a KeyboardEvent to a state-machine event, or null to ignore. */
function mapKey(event) {
  const k = event.key;
  if (/^[0-9]$/.test(k)) return { type: 'digit', digit: k };
  if (k === ' ' || k === 'Spacebar') return { type: 'space' };
  if (k === 'Backspace' || k === 'Delete') return { type: 'backspace' };
  if (k === 'Enter') return { type: 'enter' };
  if (k === 'Escape') return { type: 'cancel' };
  if (k === 'g' && event.ctrlKey) return { type: 'cancel' }; // C-g
  return null;
}
