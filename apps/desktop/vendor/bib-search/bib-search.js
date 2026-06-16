// <bib-search> — a self-contained bibliography search that inserts \cite{…}.
//
// A "dumb" agent: a fast search engine over a bibliography that, on pick,
// dispatches an `insert-text` CustomEvent with a cite macro over the selected
// keys. It owns everything — it bundles citation.js (sibling module) and ingests
// any format citation.js auto-detects (BibTeX, BibLaTeX, CSL-JSON, RIS, …). It
// knows nothing about its host: on the web you'd wire `insert-text`/`onAction`
// to a paste; in Godot the <element-view> host drops the text into the active
// buffer (with :no-focus, the document — a nicer RefTeX you keep open).
//
// Adapted from the MIT `bib-search` component (J. McKenzie Alexander); the
// scholarly aesthetic is his. Self-contained per the "bundle, don't depend"
// principle — co-locate bib-search.js + citation-js.esm.js (resolved relative
// to this module, so it works wherever the files are hosted).
//
// Attributes:
//   src          URL of a bibliography in any citation.js format
//   macro        default cite macro: cite | citep | citet | @  (default: cite)
//   placeholder  search box placeholder
//
// Events:
//   insert-text  detail { text } — the cite macro to insert (composed+bubbling)
//   bib-loaded   detail { count }
//   bib-error    detail { error }

import { Cite } from './citation-js.esm.js';

const STYLES = `
:host {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-family: 'Crimson Pro', Georgia, serif;
  font-size: 15px;
  color: #2c2c2c;
}
.container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  border: 1px solid #d4d0c8;
  background: #fff;
}
.search-bar {
  padding: 0.6rem; background: #f5f4f2; border-bottom: 1px solid #d4d0c8;
  display: flex; gap: 0.5rem; align-items: center;
}
.search-wrapper { flex: 1; position: relative; display: flex; align-items: center; }
.regex-toggle {
  flex: 0 0 auto; padding: 0.5rem 0.55rem; font-size: 0.8rem;
  background: transparent; color: #8b7355;
}
.regex-toggle.active { background: #8b7355; color: #fff; }
.search-input.invalid { border-color: #a85454; box-shadow: 0 0 0 2px rgba(168,84,84,.15); }
.search-input {
  width: 100%; padding: 0.5rem 2rem 0.5rem 0.7rem; font-family: inherit; font-size: 1rem;
  border: 1px solid #c8c4bc; background: #fff; outline: none;
  transition: border-color .15s, box-shadow .15s;
}
.search-input:focus { border-color: #8b7355; box-shadow: 0 0 0 2px rgba(139,115,85,.15); }
.search-input::placeholder { color: #999; font-style: italic; }
.clear-btn {
  position: absolute; right: 6px; width: 20px; height: 20px; padding: 0; border: none;
  border-radius: 50%; background: #c8c4bc; color: #fff; font-size: 14px; line-height: 1;
  cursor: pointer; display: none; align-items: center; justify-content: center;
}
.clear-btn:hover { background: #a8a49c; }
.clear-btn.visible { display: flex; }
button {
  padding: 0.5rem 1rem; font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 0.78rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;
  border: 1px solid #8b7355; background: #8b7355; color: #fff; cursor: pointer; transition: all .15s;
}
button:hover:not(:disabled) { background: #6d5a43; border-color: #6d5a43; }
button:disabled { opacity: .5; cursor: not-allowed; }
button.secondary { background: transparent; color: #8b7355; }
button.secondary:hover:not(:disabled) { background: rgba(139,115,85,.1); }
.toolbar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.4rem 0.6rem; background: #faf9f7; border-bottom: 1px solid #e8e5e0; font-size: 0.85rem;
}
.status { color: #666; font-style: italic; }
.selection-controls { display: flex; gap: 0.5rem; }
.selection-controls button { padding: 0.2rem 0.5rem; font-size: 0.68rem; }
.entry-list { flex: 1; min-height: 0; overflow-y: auto; }
.entry {
  display: flex; gap: 0.6rem; padding: 0.55rem 0.6rem; border-bottom: 1px solid #f0eeeb;
  cursor: pointer; transition: background-color .1s;
  content-visibility: auto; contain-intrinsic-size: auto 56px;
}
.entry:hover { background: #faf9f7; }
.entry.selected { background: #f5f3ef; }
.checkbox {
  flex-shrink: 0; width: 12px; height: 12px; border: 1.5px solid #8b7355; border-radius: 2px;
  margin-top: 5px; background: #fff; position: relative;
}
.checkbox.checked { background: #8b7355; }
.checkbox.checked::after {
  content: ''; position: absolute; left: 3.5px; top: 0.5px; width: 4px; height: 8px;
  border: solid #fff; border-width: 0 1.5px 1.5px 0; transform: rotate(45deg);
}
.entry-content { flex: 1; line-height: 1.45; min-width: 0; }
.cite-key {
  font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.72rem;
  color: #8b7355; background: #f0ece4; padding: 0 4px; border-radius: 3px; margin-right: 6px;
}
.ref-author { font-variant: small-caps; }
.ref-year { color: #6d5a43; }
.ref-title { font-style: italic; }
.empty, .error { padding: 2rem; text-align: center; color: #888; font-style: italic; }
.error { color: #a85454; background: #fdf6f6; }
.action-bar {
  padding: 0.6rem; background: #f5f4f2; border-top: 1px solid #d4d0c8;
  display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;
}
.macro-select {
  font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.8rem;
  padding: 0.35rem 0.4rem; border: 1px solid #c8c4bc; background: #fff; color: #2c2c2c;
}
.entry-list::-webkit-scrollbar { width: 8px; }
.entry-list::-webkit-scrollbar-track { background: #f5f4f2; }
.entry-list::-webkit-scrollbar-thumb { background: #c8c4bc; border-radius: 4px; }
`;

/** Build a display/search record from one CSL-JSON entry (citation.js `.data`).
 *  The full CSL entry is kept on `.csl` so the list can render it in
 *  Chicago author-date style; `.authorStr`/`.year`/`.title` are the simple
 *  fallback fields used when there is no CSL (a loosely-parsed entry). */
function entryFromCsl(e, index) {
  const names = e.author || e.editor || [];
  const family = names
    .map((a) => a.family || a.literal || a.given || '')
    .filter(Boolean);
  const allNames = names
    .map((a) => `${a.given || ''} ${a.family || a.literal || ''}`)
    .join(' ');
  const authorStr =
    family.length === 0 ? '' :
    family.length === 1 ? family[0] :
    family.length === 2 ? `${family[0]} & ${family[1]}` :
    `${family[0]} et al.`;
  const parts = e.issued && e.issued['date-parts'];
  const year = (parts && parts[0] && parts[0][0]) ? String(parts[0][0]) : '';
  const title = e.title || '';
  const container = e['container-title'] || '';
  const key = e.id || '';
  return {
    index,
    key,
    csl: e,
    authorStr,
    year,
    title,
    search: `${key} ${allNames} ${year} ${title} ${container}`.toLowerCase(),
  };
}

/** Chicago author-date name list: first author inverted ("Family, Given"),
 *  the rest natural, "and" before the last; 4+ authors → "First et al." */
function chicagoAuthors(names) {
  if (!names || names.length === 0) return '';
  const inv = (a) => {
    const f = a.family || a.literal || '';
    const g = a.given || '';
    return f ? (g ? `${f}, ${g}` : f) : (a.literal || '');
  };
  const nat = (a) => {
    const f = a.family || a.literal || '';
    const g = a.given || '';
    return f ? (g ? `${g} ${f}` : f) : (a.literal || '');
  };
  if (names.length === 1) return inv(names[0]);
  if (names.length > 3) return `${inv(names[0])} et al.`;
  const parts = names.map((a, i) => (i === 0 ? inv(a) : nat(a)));
  return parts.length === 2
    ? `${parts[0]}, and ${parts[1]}`
    : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/** Render one CSL-JSON entry as a Chicago author-date reference (HTML).
 *  Journal titles and books are italicised; article titles quoted. */
function formatChicago(e) {
  const auth = chicagoAuthors(e.author || e.editor || []);
  const dp = e.issued && e.issued['date-parts'];
  const year = (dp && dp[0] && dp[0][0]) ? String(dp[0][0]) : 'n.d.';
  const title = (e.title || '').replace(/\.\s*$/, '');
  const titlePunct = /[?!]$/.test(title) ? '' : '.'; // keep "Title?" as-is
  const container = e['container-title'] || '';
  const isBook = !container && (e.type === 'book' || e.publisher || e['publisher-place']);
  const bits = [];
  // Avoid a doubled period after a name ending in an initial ("Thomas C.").
  if (auth) bits.push(escapeHtml(auth.endsWith('.') ? auth : `${auth}.`));
  bits.push(`${escapeHtml(year)}.`);
  if (title) {
    bits.push(isBook
      ? `<i>${escapeHtml(title)}</i>${titlePunct}`
      : `&ldquo;${escapeHtml(title)}${titlePunct}&rdquo;`);
  }
  if (container) {
    let t = `<i>${escapeHtml(container)}</i>`;
    if (e.volume) t += ` ${escapeHtml(String(e.volume))}`;
    if (e.issue) t += ` (${escapeHtml(String(e.issue))})`;
    if (e.page) t += `: ${escapeHtml(String(e.page).replace(/-+/g, '–'))}`;
    bits.push(`${t}.`);
  } else if (e.publisher || e['publisher-place']) {
    const place = e['publisher-place'] ? `${escapeHtml(e['publisher-place'])}: ` : '';
    bits.push(`${place}${escapeHtml(e.publisher || '')}.`);
  }
  return bits.join(' ');
}

/** Split BibTeX TEXT into `{type, source}` entries, brace-balanced so a
 *  `{…}` field value doesn't end the entry early. (Mirrors Godot's
 *  citation.js `splitBibtexEntries`.) */
function splitBibEntries(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  const re = /@(\w+)\s*\{/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const type = m[1].toLowerCase();
    let depth = 0;
    let i = re.lastIndex - 1; // on the opening brace
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
    }
    out.push({ type, source: text.slice(m.index, i) });
    re.lastIndex = i;
  }
  return out;
}

/** One BibTeX field's raw value (brace- or quote-delimited, nesting-aware),
 *  or '' if absent. */
function bibField(source, name) {
  const m = new RegExp(name + '\\s*=\\s*', 'i').exec(source);
  if (!m) return '';
  let i = m.index + m[0].length;
  const open = source[i];
  if (open === '{') {
    let depth = 0;
    const start = i + 1;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    return source.slice(start, i);
  }
  if (open === '"') {
    const start = i + 1;
    const end = source.indexOf('"', start);
    return end < 0 ? '' : source.slice(start, end);
  }
  const bare = /^[^,}\n]+/.exec(source.slice(i));
  return bare ? bare[0].trim() : '';
}

/** Strip TeX commands/braces for plain-text display: `Fran{\c}ois` →
 *  `Franois`, `{\"O}strom` → `Ostrom`. Imperfect, but readable. */
function cleanTeX(s) {
  return String(s)
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Best-effort record for a BibTeX entry citation.js could not parse (e.g.
 *  a malformed accent). The cite KEY is always recovered so the entry stays
 *  searchable and citable; author/title/year are cleaned raw fields. */
function fallbackEntry(source, index) {
  const km = source.match(/@\w+\s*\{\s*([^,\s}]+)/);
  if (!km) return null;
  const authorRaw = bibField(source, 'author') || bibField(source, 'editor');
  const author = cleanTeX(authorRaw).split(/\s+and\s+/i)[0] || '';
  const title = cleanTeX(bibField(source, 'title'));
  const year = (bibField(source, 'year').match(/\d{4}/) || [''])[0];
  return {
    index,
    key: km[1],
    authorStr: author,
    year,
    title,
    search: `${km[1]} ${cleanTeX(authorRaw)} ${year} ${title}`.toLowerCase(),
  };
}

/** Parse a bibliography (any citation.js format) into display/search
 *  records, TOLERANT of entries citation.js can't handle. Fast path: the
 *  whole file at once. On failure: parse each BibTeX entry alone (with
 *  `@string`/`@preamble` macros prepended), and for entries that still
 *  fail, keep the cite key via `fallbackEntry` so nothing becomes
 *  un-citable. Returns the records and how many were salvaged loosely. */
function parseBibliography(text) {
  try {
    return { entries: new Cite(text).data.map(entryFromCsl), loose: 0 };
  } catch {
    // one bad entry took down the whole file — fall back to entry-by-entry
  }
  const raw = splitBibEntries(text);
  const headers = raw
    .filter((e) => e.type === 'string' || e.type === 'preamble')
    .map((e) => e.source)
    .join('\n');
  const entries = [];
  let loose = 0;
  let index = 0;
  for (const e of raw) {
    if (e.type === 'string' || e.type === 'preamble' || e.type === 'comment') {
      continue;
    }
    try {
      for (const d of new Cite(`${headers}\n${e.source}`).data) {
        entries.push(entryFromCsl(d, index));
        index += 1;
      }
    } catch {
      const fb = fallbackEntry(e.source, index);
      if (fb) { entries.push(fb); index += 1; loose += 1; }
    }
  }
  return { entries, loose };
}

/** The text to insert for MACRO over KEYS. `@` is pandoc/jmd `[@a; @b]`; the
 *  rest are LaTeX `\macro{a,b}`. */
export function citeString(macro, keys) {
  if (keys.length === 0) return '';
  if (macro === '@') return '[' + keys.map((k) => '@' + k).join('; ') + ']';
  return '\\' + macro + '{' + keys.join(',') + '}';
}

/** Does ENTRY match every whitespace-separated term in QUERY (AND, substring)? */
export function entryMatches(entry, query) {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return q.split(/\s+/).every((term) => entry.search.includes(term));
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class BibSearch extends HTMLElement {
  static get observedAttributes() { return ['src', 'macro', 'placeholder']; }
  static DEBOUNCE_MS = 150;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.entries = [];
    this.filtered = [];
    this.selected = new Set();   // selected bib keys (stable across filtering)
    this._loose = 0;             // entries salvaged loosely (citation.js couldn't parse)
    this._regex = false;         // regex search mode (toggle); default substring
    this._debounce = null;
  }

  connectedCallback() {
    if (this._mounted) return;
    this._mounted = true;
    this._render();
    this.loadBibliography();
  }

  disconnectedCallback() {
    if (this._debounce) { clearTimeout(this._debounce); this._debounce = null; }
  }

  attributeChangedCallback(name, oldV, newV) {
    if (oldV === newV || !this._mounted) return;
    if (name === 'src') this.loadBibliography();
  }

  get macro() { return this.getAttribute('macro') || 'cite'; }

  _render() {
    const placeholder = this.getAttribute('placeholder') || 'Search author, title, year, key…';
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="container">
        <div class="search-bar">
          <div class="search-wrapper">
            <input type="text" class="search-input" placeholder="${escapeHtml(placeholder)}"
                   aria-label="Search bibliography">
            <button class="clear-btn" type="button" title="Clear" aria-label="Clear">×</button>
          </div>
          <button class="regex-toggle" type="button" aria-pressed="false"
                  title="Regular-expression search">.*</button>
        </div>
        <div class="toolbar">
          <span class="status">Loading…</span>
          <div class="selection-controls">
            <button class="secondary select-none" type="button">Clear</button>
          </div>
        </div>
        <div class="entry-list" role="listbox"><div class="empty">Loading bibliography…</div></div>
        <div class="action-bar">
          <select class="macro-select" aria-label="Cite macro">
            <option value="cite">\\cite</option>
            <option value="citep">\\citep</option>
            <option value="citet">\\citet</option>
            <option value="@">[@key]</option>
          </select>
          <button class="action-btn" type="button" disabled>Insert \\cite{…}</button>
        </div>
      </div>`;
    const $ = (s) => this.shadowRoot.querySelector(s);
    this._input = $('.search-input');
    this._clear = $('.clear-btn');
    this._status = $('.status');
    this._list = $('.entry-list');
    this._action = $('.action-btn');
    this._macroSel = $('.macro-select');
    this._macroSel.value = this.macro;
    this._regexBtn = $('.regex-toggle');
    this._regexBtn.classList.toggle('active', this._regex);
    this._regexBtn.setAttribute('aria-pressed', this._regex ? 'true' : 'false');

    this._regexBtn.addEventListener('click', () => {
      this._regex = !this._regex;
      this._regexBtn.classList.toggle('active', this._regex);
      this._regexBtn.setAttribute('aria-pressed', this._regex ? 'true' : 'false');
      this._input.placeholder = this._regex
        ? 'Regex (e.g. ^smith, conv.*tion, 19[89]\\d)…'
        : (this.getAttribute('placeholder') || 'Search author, title, year, key…');
      this._applyFilter();
      this._input.focus();
    });

    this._input.addEventListener('input', () => {
      this._clear.classList.toggle('visible', this._input.value !== '');
      if (this._debounce) clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this._applyFilter(), BibSearch.DEBOUNCE_MS);
    });
    this._input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._insert(); }
      else if (e.key === 'Escape') { this._input.value = ''; this._clear.classList.remove('visible'); this._applyFilter(); }
    });
    this._clear.addEventListener('click', () => {
      this._input.value = ''; this._clear.classList.remove('visible');
      this._applyFilter(); this._input.focus();
    });
    $('.select-none').addEventListener('click', () => {
      this.selected.clear(); this._paintSelection(); this._syncAction();
    });
    this._macroSel.addEventListener('change', () => this._syncAction());
    this._action.addEventListener('click', () => this._insert());
    this._list.addEventListener('click', (e) => {
      const row = e.target.closest('.entry');
      if (row) this._toggle(row.dataset.key);
    });
    this._list.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.entry');
      if (row) { this.selected = new Set([row.dataset.key]); this._insert(); }
    });
  }

  async loadBibliography() {
    const src = this.getAttribute('src');
    if (!src) return;
    this._status.textContent = 'Loading…';
    try {
      const resp = await fetch(src);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      // Tolerant parse: one malformed entry must not lose the whole file,
      // and every entry stays citable even if citation.js can't read it.
      const { entries, loose } = parseBibliography(text);
      this.entries = entries;
      this._loose = loose;
      this.selected.clear();
      this._applyFilter();
      this.dispatchEvent(new CustomEvent('bib-loaded', {
        detail: { count: entries.length, loose }, bubbles: true, composed: true,
      }));
    } catch (error) {
      const msg = error && error.message ? error.message : String(error);
      this._list.innerHTML = `<div class="error">Could not load bibliography: ${escapeHtml(msg)}</div>`;
      this._status.textContent = 'Error';
      this.dispatchEvent(new CustomEvent('bib-error', {
        detail: { error: msg }, bubbles: true, composed: true,
      }));
    }
  }

  /** A predicate for QUERY: a case-insensitive RegExp in regex mode (with a
   *  literal fallback on an invalid pattern, flagged on the input), else
   *  whitespace-separated AND substring matching. */
  _matcher(q) {
    const query = q.trim();
    if (this._input) this._input.classList.remove('invalid');
    if (query === '') return () => true;
    if (this._regex) {
      try {
        const re = new RegExp(query, 'i');
        return (e) => re.test(e.search);
      } catch {
        // Pattern still being typed / malformed — match literally so the
        // list doesn't blank out, and flag the input.
        if (this._input) this._input.classList.add('invalid');
        const lit = query.toLowerCase();
        return (e) => e.search.includes(lit);
      }
    }
    const terms = query.toLowerCase().split(/\s+/);
    return (e) => terms.every((t) => e.search.includes(t));
  }

  _applyFilter() {
    const q = this._input ? this._input.value : '';
    const match = this._matcher(q);
    this.filtered = this.entries.filter(match);
    this._renderList();
    if (this._status && this.entries.length) {
      const loose = this._loose ? ` (${this._loose} loose)` : '';
      this._status.textContent = q.trim()
        ? `${this.filtered.length} / ${this.entries.length}`
        : `${this.entries.length} entries${loose}`;
    }
    this._syncAction();
  }

  _renderList() {
    if (this.filtered.length === 0) {
      this._list.innerHTML = '<div class="empty">No matching entries.</div>';
      return;
    }
    const frag = this.ownerDocument.createDocumentFragment();
    for (const e of this.filtered) {
      const row = this.ownerDocument.createElement('div');
      row.className = 'entry' + (this.selected.has(e.key) ? ' selected' : '');
      row.dataset.key = e.key;
      row.setAttribute('role', 'option');
      const checked = this.selected.has(e.key) ? ' checked' : '';
      // Chicago author-date from the CSL entry; loosely-parsed entries (no
      // CSL) fall back to the simple author/year/title fields.
      const reference = e.csl
        ? formatChicago(e.csl)
        : (e.authorStr ? `${escapeHtml(e.authorStr)} ` : '') +
          (e.year ? `${escapeHtml(e.year)}. ` : '') +
          (e.title ? `<i>${escapeHtml(e.title)}</i>` : '');
      row.innerHTML =
        `<span class="checkbox${checked}" aria-hidden="true"></span>` +
        `<span class="entry-content">` +
        `<span class="cite-key">${escapeHtml(e.key)}</span>` +
        `<span class="ref">${reference}</span>` +
        `</span>`;
      frag.appendChild(row);
    }
    this._list.replaceChildren(frag);
  }

  _toggle(key) {
    if (!key) return;
    if (this.selected.has(key)) this.selected.delete(key);
    else this.selected.add(key);
    this._paintSelection();
    this._syncAction();
  }

  /** Update checkbox / row classes in place without rebuilding the list. */
  _paintSelection() {
    for (const row of this._list.querySelectorAll('.entry')) {
      const on = this.selected.has(row.dataset.key);
      row.classList.toggle('selected', on);
      row.querySelector('.checkbox').classList.toggle('checked', on);
    }
  }

  _syncAction() {
    if (!this._action) return;
    const n = this.selected.size;
    this._action.disabled = n === 0;
    const macro = this._macroSel.value;
    const label = macro === '@' ? '[@…]' : `\\${macro}{…}`;
    this._action.textContent = n > 1 ? `Insert ${label} ×${n}` : `Insert ${label}`;
  }

  /** Insert the cite macro over the selected keys (or the single filtered
   *  entry if nothing is selected) by dispatching `insert-text`. */
  _insert() {
    let keys = [...this.selected];
    if (keys.length === 0 && this.filtered.length > 0) keys = [this.filtered[0].key];
    const text = citeString(this._macroSel.value, keys);
    if (text === '') return;
    this.dispatchEvent(new CustomEvent('insert-text', {
      detail: { text }, bubbles: true, composed: true,
    }));
    // Reset for the next citation, RefTeX-style; keep the search so related
    // keys are still in view.
    this.selected.clear();
    this._paintSelection();
    this._syncAction();
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('bib-search')) {
  customElements.define('bib-search', BibSearch);
}

export { BibSearch };
