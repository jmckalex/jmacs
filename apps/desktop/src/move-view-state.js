/**
 * @file Pure state machine for the `swap-views` / `permute-views`
 * digit-entry UI (see `plans/PANES-SWAP-PERMUTE.md`).
 *
 * No DOM. The overlay module (`move-view-mode.js`) feeds it key events
 * and renders from its state, so the tricky entry logic —
 * unambiguous-prefix auto-accept, the bijection constraint, the forced
 * last destination, and undo — is unit-testable on its own.
 *
 * Pane numbers are 1-based throughout: they match the on-screen badges.
 *
 * Model:
 *   - `swap` collects exactly two distinct pane numbers (the two panes
 *     whose contents trade places).
 *   - `permute` collects a destination slot for source pane 1, then pane
 *     2, …, in order. Destinations are distinct (a bijection). Only n-1
 *     are typed — the last is forced and derived (`committedAssignments`
 *     appends it).
 *
 * `entries` only ever holds *explicitly accepted* numbers; the permute
 * forced-last is derived on commit so a single Backspace cleanly undoes
 * the user's last real choice.
 *
 * @typedef {{
 *   mode: 'swap' | 'permute',
 *   n: number,
 *   pending: string,
 *   entries: number[],
 * }} MoveViewState
 *
 * @typedef {{ type: 'none' }
 *   | { type: 'beep' }
 *   | { type: 'abort' }
 *   | { type: 'commit', assignments: number[] }} MoveViewEffect
 */

/**
 * Initial state for a session over N panes.
 * @param {'swap'|'permute'} mode
 * @param {number} n
 * @returns {MoveViewState}
 */
export function createMoveViewState(mode, n) {
  return {
    mode: mode === 'permute' ? 'permute' : 'swap',
    n,
    pending: '',
    entries: [],
  };
}

/** How many entries the user types before the operation is ready: swap
 *  needs two explicit panes; permute needs n-1 (the last destination is
 *  forced). */
export function inputTarget(state) {
  return state.mode === 'swap' ? Math.min(2, state.n) : state.n - 1;
}

/** Numbers 1..n not yet consumed by an accepted entry. */
export function availableNumbers(state) {
  const used = new Set(state.entries);
  const out = [];
  for (let i = 1; i <= state.n; i += 1) if (!used.has(i)) out.push(i);
  return out;
}

/** Available numbers whose decimal string starts with the pending digits
 *  (all available numbers when nothing is pending). These are the panes
 *  the overlay highlights as candidates for the current entry. */
export function candidateNumbers(state) {
  const avail = availableNumbers(state);
  if (state.pending === '') return avail;
  return avail.filter((num) => String(num).startsWith(state.pending));
}

/** True when there are enough entries to commit (awaiting Enter), with
 *  no half-typed number pending. */
export function isReady(state) {
  return state.pending === '' && state.entries.length >= inputTarget(state);
}

/** For permute: the 1-based source pane currently being assigned (the
 *  next one), or null when done / not in permute mode. The overlay marks
 *  this pane as "where does this one go?". */
export function currentSource(state) {
  if (state.mode !== 'permute') return null;
  if (state.entries.length >= inputTarget(state)) return null;
  return state.entries.length + 1;
}

/**
 * The full assignment list to commit, including permute's forced last
 * destination. Returns null when not ready.
 *
 * For swap: `[a, b]` — the two pane numbers to exchange.
 * For permute: `dests` of length n, where `dests[k]` is the destination
 * slot of pane `k + 1` (1-based numbers).
 *
 * @param {MoveViewState} state
 * @returns {number[] | null}
 */
export function committedAssignments(state) {
  if (!isReady(state)) return null;
  if (state.mode === 'swap') return state.entries.slice(0, 2);
  const remaining = availableNumbers(state);
  // entries.length === n-1, so exactly one number remains: pane n's dest.
  return remaining.length === 1
    ? [...state.entries, remaining[0]]
    : state.entries.slice();
}

/**
 * Advance the state machine by one event.
 *
 * @param {MoveViewState} state
 * @param {{ type: 'digit', digit: string }
 *   | { type: 'space' } | { type: 'backspace' }
 *   | { type: 'enter' } | { type: 'cancel' }} event
 * @returns {{ state: MoveViewState, effect: MoveViewEffect }}
 */
export function reduce(state, event) {
  switch (event.type) {
    case 'cancel':
      return { state, effect: { type: 'abort' } };
    case 'digit':
      return reduceDigit(state, event.digit);
    case 'space':
      return reduceSpace(state);
    case 'backspace':
      return reduceBackspace(state);
    case 'enter':
      return reduceEnter(state);
    default:
      return { state, effect: { type: 'none' } };
  }
}

/** Push NUM as an accepted entry and clear pending. */
function acceptNumber(state, num) {
  return {
    state: { ...state, entries: [...state.entries, num], pending: '' },
    effect: { type: 'none' },
  };
}

function reduceDigit(state, digit) {
  if (typeof digit !== 'string' || !/^[0-9]$/.test(digit)) {
    return { state, effect: { type: 'none' } };
  }
  // The current entry is closed once enough entries exist — no more input
  // until Enter or Backspace.
  if (state.entries.length >= inputTarget(state)) {
    return { state, effect: { type: 'beep' } };
  }
  const pending = state.pending + digit;
  const cands = availableNumbers(state).filter((num) =>
    String(num).startsWith(pending)
  );
  if (cands.length === 0) {
    // No available pane could complete this prefix — reject the digit.
    return { state, effect: { type: 'beep' } };
  }
  const p = Number(pending);
  // Unambiguous: this prefix matches exactly one available pane, and that
  // pane is the prefix itself. Accept it without waiting for Space.
  if (cands.length === 1 && cands[0] === p) {
    return acceptNumber(state, p);
  }
  return { state: { ...state, pending }, effect: { type: 'none' } };
}

function reduceSpace(state) {
  if (state.pending === '') return { state, effect: { type: 'beep' } };
  const p = Number(state.pending);
  if (availableNumbers(state).includes(p)) return acceptNumber(state, p);
  return { state, effect: { type: 'beep' } };
}

function reduceBackspace(state) {
  if (state.pending !== '') {
    return {
      state: { ...state, pending: state.pending.slice(0, -1) },
      effect: { type: 'none' },
    };
  }
  if (state.entries.length > 0) {
    return {
      state: { ...state, entries: state.entries.slice(0, -1) },
      effect: { type: 'none' },
    };
  }
  return { state, effect: { type: 'beep' } };
}

function reduceEnter(state) {
  let s = state;
  // Enter accepts a valid pending number first, then commits.
  if (s.pending !== '') {
    const p = Number(s.pending);
    if (availableNumbers(s).includes(p) && s.entries.length < inputTarget(s)) {
      s = acceptNumber(s, p).state;
    } else {
      return { state, effect: { type: 'beep' } };
    }
  }
  const assignments = committedAssignments(s);
  if (assignments === null) return { state: s, effect: { type: 'beep' } };
  return { state: s, effect: { type: 'commit', assignments } };
}
