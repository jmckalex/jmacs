/**
 * @file The RefTeX **citation** bottom panels — RefTeX R3's two-step,
 * format-first cite flow (plans/RefTeX.md). Both dock at the bottom of
 * the editor (full width — formatted references need horizontal room),
 * mounted by `openReftexBottomDock` in apps/desktop/src/app.js.
 *
 *   1. `createReftexCiteFormatPanel` — the *format menu*: the cite macros
 *      from `*reftex-cite-format*` (\cite / \citep / \citet / …), each on
 *      a single key. RefTeX shows this first; picking one swaps the dock
 *      for the picker below.
 *   2. `createReftexCitePanel` — the *cite picker*: the bibliography
 *      entries shown as professionally formatted references (citation.js
 *      + a CSL style), searchable, with `m` to mark several. RET inserts
 *      `<macro>{k1,k2}`.
 *
 * Both feed keys in via `handleKey(keyString)` (the overlay's modal
 * window-capture handler). The pure key/selection helpers are exported
 * and unit-tested without a DOM.
 *
 * Key strings are exactly what `keyEventToString` produces: named keys
 * lowercased (`enter`, `up`, `down`, `escape`, `backspace`), printables
 * verbatim (so `p` and `P` are distinct — the format menu uses both).
 */

// -----------------------------------------------------------------------
// Pure helpers (no DOM) — unit-tested in Node.

/**
 * @typedef {object} CiteFormat
 * @property {string} key - The keystroke that picks this format.
 * @property {string} macro - The LaTeX macro inserted (e.g. `\citep`).
 * @property {string} desc - The menu hint.
 */

/**
 * @typedef {object} CiteRow
 * @property {string} key - The bib key (inserted into the macro).
 * @property {string} html - The CSL-formatted reference HTML (display).
 * @property {string} plain - Plain text (key/author/year/title) to filter.
 */

/**
 * The macro whose format KEY matches the pressed key, or null. Drives the
 * format menu's single-key selection.
 *
 * @param {string} key
 * @param {CiteFormat[]} formats
 * @returns {string|null}
 */
export function matchCiteFormatKey(key, formats) {
  for (const f of formats ?? []) {
    if (f && f.key === key) return f.macro;
  }
  return null;
}

/**
 * Compile a filter query into AND-ed matchers, RefTeX-style. Whitespace
 * splits the query into terms that must ALL match; each term compiles to a
 * case-insensitive RegExp. A term that isn't a valid regexp degrades to a
 * literal (case-insensitive) substring matcher — so a half-typed pattern
 * like `foo(` never throws while you type. Returns `[]` for an empty or
 * whitespace-only query (which matches everything).
 *
 * Splitting on literal whitespace means a power-user can still match a
 * phrase by using `\s` (e.g. `van\sder`), since that survives the split.
 *
 * @param {string} filter
 * @returns {Array<{test: (s: string) => boolean}>}
 */
export function compileCiteFilter(filter) {
  const parts = (filter ?? '').trim().split(/\s+/).filter((p) => p !== '');
  return parts.map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch {
      const lit = p.toLowerCase();
      return { test: (s) => (s ?? '').toLowerCase().includes(lit) };
    }
  });
}

/**
 * Filter cite rows by a RefTeX-style query: whitespace-separated terms
 * that must ALL match (AND), each a case-insensitive regular expression
 * tested against the bib key or the plain author/year/title text. An empty
 * query matches everything; see {@link compileCiteFilter} for the term
 * grammar and the invalid-regexp fallback.
 *
 * @param {CiteRow[]} rows
 * @param {string} filter
 * @returns {CiteRow[]}
 */
export function filterCiteRows(rows, filter) {
  const terms = compileCiteFilter(filter);
  if (terms.length === 0) return rows ?? [];
  return (rows ?? []).filter((r) => {
    const key = r.key ?? '';
    const plain = r.plain ?? '';
    return terms.every((t) => t.test(key) || t.test(plain));
  });
}

/**
 * The keys to insert: the marked keys in full-index order when any are
 * marked (so a mark survives filtering to something else), else the
 * currently highlighted key, else `[]`. RefTeX's "marked, or current"
 * rule.
 *
 * @param {Array<{key: string}>} allRows - The FULL index, in bib order.
 * @param {Set<string>} marked - The set of marked keys.
 * @param {string|null} currentKey - The highlighted row's key.
 * @returns {string[]}
 */
export function citeKeysToInsert(allRows, marked, currentKey) {
  const inOrder = (allRows ?? [])
    .filter((r) => marked && marked.has(r.key))
    .map((r) => r.key);
  if (inOrder.length > 0) return inOrder;
  return currentKey ? [currentKey] : [];
}

/**
 * Map a key string to the cite picker's action — PURE. The picker is a
 * search box, so EVERY bare printable (including `n`, `p`, `m`, `q`)
 * extends the filter — that is what lets authors like "Peano" and
 * "Alexander" be typed. Navigation lives off the letters: the arrows and
 * `C-n`/`C-p` move; `tab` marks; `enter` inserts; `escape` cancels;
 * `backspace`/`delete` edit the filter.
 *
 * @param {string} key
 * @returns {{type: string, delta?: number, char?: string}|null}
 */
export function mapCiteKey(key) {
  switch (key) {
    case 'down':
    case 'C-n':
      return { type: 'move', delta: 1 };
    case 'up':
    case 'C-p':
      return { type: 'move', delta: -1 };
    case 'tab':
      return { type: 'mark' };
    case 'enter':
      return { type: 'insert' };
    case 'escape':
      return { type: 'cancel' };
    case 'backspace':
    case 'delete':
      return { type: 'backspace' };
    default:
      if (key.length === 1) return { type: 'filter', char: key };
      return null;
  }
}

// -----------------------------------------------------------------------
// The format-menu panel (step 1).

/**
 * Create the cite *format menu* panel. The host mounts `element` in the
 * bottom dock and feeds keys via `handleKey`.
 *
 * @param {object} [options]
 * @param {Document} [options.document]
 * @param {() => CiteFormat[]} [options.getFormats]
 * @param {(macro: string) => void} [options.onPick]
 * @param {() => void} [options.onCancel]
 * @returns {{element: HTMLElement, handleKey: (key: string) => boolean, refresh: Function, focus: Function, destroy: Function}}
 */
export function createReftexCiteFormatPanel(options = {}) {
  const doc = options.document ?? globalThis.document;
  const getFormats = typeof options.getFormats === 'function' ? options.getFormats : () => [];
  const onPick = typeof options.onPick === 'function' ? options.onPick : null;
  const onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;

  const root = doc.createElement('div');
  root.className = 'reftex-cite-view reftex-cite-format';
  root.tabIndex = -1;

  const header = doc.createElement('div');
  header.className = 'reftex-cite-header';
  const icon = doc.createElement('i');
  icon.className = 'fa-solid fa-quote-right';
  const label = doc.createElement('span');
  label.className = 'reftex-cite-header-label';
  label.textContent = 'Select citation format';
  header.append(icon, label);
  root.append(header);

  const list = doc.createElement('div');
  list.className = 'reftex-cite-format-list';
  root.append(list);

  /** A human label for a format key ("enter" → "⏎"). */
  function keyLabel(key) {
    return key === 'enter' ? '⏎' : key;
  }

  function render() {
    list.replaceChildren();
    for (const f of getFormats() || []) {
      const row = doc.createElement('div');
      row.className = 'reftex-cite-format-row';
      row.dataset.key = f.key ?? '';
      const keyEl = doc.createElement('span');
      keyEl.className = 'reftex-cite-format-key';
      keyEl.textContent = keyLabel(f.key ?? '');
      const macroEl = doc.createElement('span');
      macroEl.className = 'reftex-cite-format-macro';
      macroEl.textContent = f.macro ?? '';
      const descEl = doc.createElement('span');
      descEl.className = 'reftex-cite-format-desc';
      descEl.textContent = f.desc ?? '';
      row.append(keyEl, macroEl, descEl);
      list.append(row);
    }
  }

  list.addEventListener('click', (event) => {
    const row = event.target.closest('.reftex-cite-format-row');
    if (!row) return;
    const macro = matchCiteFormatKey(row.dataset.key ?? '', getFormats() || []);
    if (macro != null && onPick) onPick(macro);
  });

  function handleKey(key) {
    if (key === 'q' || key === 'escape') {
      if (onCancel) onCancel();
      return true;
    }
    const macro = matchCiteFormatKey(key, getFormats() || []);
    if (macro != null) {
      if (onPick) onPick(macro);
      return true;
    }
    return false;
  }

  render();
  return {
    element: root,
    refresh: render,
    focus: () => root.focus(),
    handleKey,
    destroy: () => root.remove(),
  };
}

// -----------------------------------------------------------------------
// The cite-picker panel (step 2).

/**
 * Assign citation.js-formatted reference HTML to EL. The HTML comes from
 * the host's `citation-format-entries` (citation.js bibliography output),
 * which HTML-escapes every bib field's text and emits only its own
 * formatting tags (`<i>`, `<span>`, the Vancouver numbering `<div>`s); the
 * bib file is the user's own local source. So `innerHTML` here renders the
 * professional reference without a sanitiser. Defensively drop `<script`
 * just in case a future formatter path changes.
 *
 * @param {HTMLElement} el
 * @param {string} html
 */
function setReferenceHtml(el, html) {
  el.innerHTML = typeof html === 'string' ? html.replace(/<script/gi, '&lt;script') : '';
}

/** The most rows the picker renders (and formats) at once. A larger
 *  bibliography is filtered down by typing; the rest are summarised as
 *  "N more — type to filter" rather than formatted. Keeps both DOM and
 *  CSL-formatting work bounded regardless of bib size. */
const MAX_VISIBLE = 40;

/**
 * Create the cite *picker* panel. It is driven by a CHEAP index (one
 * `{key, plain}` per bib entry — `plain` is the author/year/title filter
 * text) and formats the CSL references LAZILY: only the rows it actually
 * shows are formatted, via `getFormatted`, and each result is cached. So
 * a 1000-entry bibliography opens instantly and is never formatted whole.
 *
 * @param {object} [options]
 * @param {Document} [options.document]
 * @param {() => Array<{key: string, plain: string}>} [options.getIndex] -
 *   The full cheap index, in bib order.
 * @param {(keysCsv: string) => Array<{key: string, html: string}>} [options.getFormatted]
 *   - CSL-format just the named keys (the rows about to be shown).
 * @param {(keysCsv: string) => void} [options.onInsert] - Called with the
 *   comma-joined keys to cite (marked, or the highlighted row).
 * @param {() => void} [options.onCancel]
 * @returns {{element: HTMLElement, handleKey: (key: string) => boolean, refresh: Function, focus: Function, destroy: Function}}
 */
export function createReftexCitePanel(options = {}) {
  const doc = options.document ?? globalThis.document;
  const getIndex = typeof options.getIndex === 'function' ? options.getIndex : () => [];
  const getFormatted =
    typeof options.getFormatted === 'function' ? options.getFormatted : () => [];
  const onInsert = typeof options.onInsert === 'function' ? options.onInsert : null;
  const onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;

  /** @type {Array<{key: string, plain: string}>} The shown (capped) rows. */
  let shown = [];
  let highlight = 0;
  let filter = '';
  /** @type {Set<string>} Marked bib keys (survive filtering). */
  const marked = new Set();
  /** @type {Map<string, string>} key → formatted HTML (lazy, cached). */
  const htmlCache = new Map();

  const root = doc.createElement('div');
  root.className = 'reftex-cite-view reftex-cite-picker';
  root.tabIndex = -1;

  const header = doc.createElement('div');
  header.className = 'reftex-cite-header';
  const icon = doc.createElement('i');
  icon.className = 'fa-solid fa-book';
  const label = doc.createElement('span');
  label.className = 'reftex-cite-header-label';
  label.textContent = 'Insert citation';
  const filterEl = doc.createElement('span');
  filterEl.className = 'reftex-cite-filter';
  header.append(icon, label, filterEl);
  root.append(header);

  // The search box — a focused text-input affordance. The dock captures
  // keystrokes at the window level and routes them through `handleKey`
  // (no native <input> takes focus here), so this renders the live filter
  // plus a blinking caret. Every printable types, so n/p/m/q are
  // searchable rather than commands.
  const search = doc.createElement('div');
  search.className = 'reftex-cite-search';
  const searchIcon = doc.createElement('i');
  searchIcon.className = 'fa-solid fa-magnifying-glass reftex-cite-search-icon';
  // text + caret + placeholder share one inline group with NO gap, so the
  // caret sits flush against the typed text. (The outer flex `gap` would
  // otherwise wedge a space between them: "Alexand |".)
  const field = doc.createElement('span');
  field.className = 'reftex-cite-search-field';
  const searchText = doc.createElement('span');
  searchText.className = 'reftex-cite-search-text';
  const caret = doc.createElement('span');
  caret.className = 'reftex-cite-caret';
  const placeholder = doc.createElement('span');
  placeholder.className = 'reftex-cite-search-placeholder';
  placeholder.textContent = 'Type to filter…';
  field.append(searchText, caret, placeholder);
  search.append(searchIcon, field);
  root.append(search);

  const scroll = doc.createElement('div');
  scroll.className = 'reftex-cite-scroll';
  root.append(scroll);

  const hint = doc.createElement('div');
  hint.className = 'reftex-cite-hint';
  hint.textContent =
    'filter: regexp, space = and · ↑↓ or C-n/C-p move · Tab mark · Enter insert · Esc cancel';
  root.append(hint);

  /** Ensure every key in KEYS has formatted HTML cached, fetching the
   *  uncached ones in one batched call. Misses are cached as '' so a key
   *  the formatter can't render isn't requested again. */
  function ensureFormatted(keys) {
    const need = keys.filter((k) => !htmlCache.has(k));
    if (need.length === 0) return;
    const got = getFormatted(need.join(',')) || [];
    for (const { key, html } of got) htmlCache.set(key, html ?? '');
    for (const k of need) if (!htmlCache.has(k)) htmlCache.set(k, '');
  }

  function render() {
    const index = getIndex() || [];
    const matches = filterCiteRows(index, filter);
    shown = matches.slice(0, MAX_VISIBLE);
    if (highlight >= shown.length) highlight = Math.max(0, shown.length - 1);
    if (highlight < 0) highlight = 0;

    // Format only the rows we're about to paint.
    ensureFormatted(shown.map((r) => r.key));

    // The typed filter shows in the search box; the header keeps the
    // marks + "showing N of M" status.
    searchText.textContent = filter;
    placeholder.style.display = filter === '' ? '' : 'none';

    const bits = [];
    if (marked.size > 0) bits.push(`${marked.size} marked`);
    if (matches.length > shown.length) {
      bits.push(`showing ${shown.length} of ${matches.length}`);
    }
    filterEl.textContent = bits.join(' · ');

    scroll.replaceChildren();
    if (shown.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'reftex-cite-empty';
      empty.textContent = index.length === 0 ? 'No bibliography entries.' : 'No matches.';
      scroll.append(empty);
      return;
    }

    shown.forEach((row, idx) => {
      const el = doc.createElement('div');
      el.className = 'reftex-cite-row';
      el.dataset.index = String(idx);
      if (idx === highlight) el.classList.add('is-current');
      if (marked.has(row.key)) el.classList.add('is-marked');

      const mark = doc.createElement('span');
      mark.className = 'reftex-cite-mark';
      mark.textContent = marked.has(row.key) ? '•' : '';
      const keyEl = doc.createElement('span');
      keyEl.className = 'reftex-cite-key';
      keyEl.textContent = row.key ?? '';
      const refEl = doc.createElement('div');
      refEl.className = 'reftex-cite-ref';
      // The formatted reference, or the cheap filter text until it loads.
      const html = htmlCache.get(row.key);
      if (html) setReferenceHtml(refEl, html);
      else refEl.textContent = row.plain ?? '';

      const top = doc.createElement('div');
      top.className = 'reftex-cite-row-top';
      top.append(mark, keyEl);
      el.append(top, refEl);
      scroll.append(el);
    });
    scrollHighlightIntoView();
  }

  function scrollHighlightIntoView() {
    const el = scroll.querySelector('.reftex-cite-row.is-current');
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  function move(delta) {
    if (shown.length === 0) return;
    highlight = Math.min(shown.length - 1, Math.max(0, highlight + delta));
    render();
  }

  function toggleMark() {
    const row = shown[highlight];
    if (!row) return;
    if (marked.has(row.key)) marked.delete(row.key);
    else marked.add(row.key);
    // Advance so repeated `m` marks a run, RefTeX-style.
    if (highlight < shown.length - 1) highlight += 1;
    render();
  }

  function insert() {
    const cur = shown[highlight];
    const keys = citeKeysToInsert(getIndex() || [], marked, cur ? cur.key : null);
    if (onInsert) onInsert(keys.join(','));
  }

  function backspaceFilter() {
    if (filter.length > 0) {
      filter = filter.slice(0, -1);
      highlight = 0;
      render();
    }
  }

  function extendFilter(char) {
    filter += char;
    highlight = 0;
    render();
  }

  scroll.addEventListener('click', (event) => {
    const el = event.target.closest('.reftex-cite-row');
    if (!el) return;
    const idx = Number.parseInt(el.dataset.index ?? '', 10);
    if (!Number.isFinite(idx)) return;
    highlight = idx;
    toggleMark();
  });

  function handleKey(key) {
    const action = mapCiteKey(key);
    if (!action) return false;
    switch (action.type) {
      case 'move': move(action.delta); return true;
      case 'mark': toggleMark(); return true;
      case 'insert': insert(); return true;
      case 'cancel': if (onCancel) onCancel(); return true;
      case 'backspace': backspaceFilter(); return true;
      case 'filter': extendFilter(action.char); return true;
      default: return false;
    }
  }

  render();
  return {
    element: root,
    refresh: render,
    focus: () => root.focus(),
    handleKey,
    destroy: () => root.remove(),
  };
}
