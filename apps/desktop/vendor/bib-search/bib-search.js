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
//   bib-path     host path of the .bib (anchors the BibDesk PDF fallback)
//
// Events:
//   insert-text   detail { text } — the cite macro to insert (composed+bubbling)
//   open-external detail { bdsk, bibPath, source } — open a BibDesk PDF
//   bib-loaded    detail { count }
//   bib-error     detail { error }
//
// BibDesk PDFs: a BibTeX entry with a `bdsk-file-1` field (a base64 macOS
// alias BibDesk writes) gets its title rendered as a link; clicking it
// dispatches `open-external` so the host can resolve the alias and open the
// PDF in the default reader. The host knows how to resolve it (native macOS
// bookmark API); the element just carries the opaque value.

import { Cite } from './citation-js.esm.js';

const STYLES = `
:host {
  /* Follow Godot's theme: each token aliases a host theme variable (set on
     :root, inherited through the shadow boundary) with a fallback to the
     panel's own "scholarly" light palette, so the component still looks
     right if ever used standalone on the web. */
  --bs-bg:      var(--bg-editor, #fff);
  --bs-chrome:  var(--bg-chrome, #f5f4f2);
  --bs-fg:      var(--fg, #2c2c2c);
  --bs-dim:     var(--fg-dim, #8a857c);
  --bs-accent:  var(--accent, #8b7355);
  --bs-sel:     var(--selection, rgba(139,115,85,.14));
  --bs-error:   var(--error, #a85454);
  --bs-border:  color-mix(in srgb, var(--fg-dim, #8a857c) 32%, transparent);
  --bs-faint:   color-mix(in srgb, var(--fg-dim, #8a857c) 14%, transparent);
  --bs-tint:    color-mix(in srgb, var(--accent, #8b7355) 14%, transparent);
  --bs-mono:    var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);

  display: flex;
  flex-direction: column;
  height: 100%;
  font-family: 'Crimson Pro', Georgia, serif;
  font-size: 15px;
  color: var(--bs-fg);
}
.container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--bs-border);
  background: var(--bs-bg);
}
.search-bar { padding: 0.6rem; background: var(--bs-chrome); border-bottom: 1px solid var(--bs-border); }
.search-wrapper { position: relative; display: flex; align-items: center; }
.search-input.invalid { border-color: var(--bs-error); box-shadow: 0 0 0 2px color-mix(in srgb, var(--bs-error) 22%, transparent); }
.search-input {
  width: 100%; padding: 0.5rem 2rem 0.5rem 0.7rem; font-family: inherit; font-size: 1rem;
  border: 1px solid var(--bs-border); background: var(--bs-bg); color: var(--bs-fg); outline: none;
  transition: border-color .15s, box-shadow .15s;
}
.search-input:focus { border-color: var(--bs-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--bs-accent) 22%, transparent); }
.search-input::placeholder { color: var(--bs-dim); font-style: italic; }
.clear-btn {
  position: absolute; right: 6px; width: 20px; height: 20px; padding: 0; border: none;
  border-radius: 50%; background: var(--bs-dim); color: var(--bs-bg); font-size: 14px; line-height: 1;
  cursor: pointer; display: none; align-items: center; justify-content: center;
}
.clear-btn:hover { background: var(--bs-fg); }
.clear-btn.visible { display: flex; }
button {
  padding: 0.5rem 1rem; font-family: var(--bs-mono);
  font-size: 0.78rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;
  border: 1px solid color-mix(in srgb, var(--bs-accent) 55%, transparent);
  background: color-mix(in srgb, var(--bs-accent) 24%, transparent); color: var(--bs-fg);
  cursor: pointer; transition: all .15s;
}
button:hover:not(:disabled) { background: color-mix(in srgb, var(--bs-accent) 40%, transparent); border-color: var(--bs-accent); }
button:disabled { opacity: .5; cursor: not-allowed; }
button.secondary { background: transparent; color: var(--bs-accent); border-color: var(--bs-border); }
button.secondary:hover:not(:disabled) { background: var(--bs-tint); }
.toolbar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.4rem 0.6rem; background: var(--bs-chrome); border-bottom: 1px solid var(--bs-border); font-size: 0.85rem;
}
.status { color: var(--bs-dim); font-style: italic; }
.selection-controls { display: flex; gap: 0.5rem; align-items: center; }
.sort-select {
  font-family: var(--bs-mono); font-size: 0.7rem;
  padding: 0.15rem 0.3rem; border: 1px solid var(--bs-border); background: var(--bs-bg); color: var(--bs-fg);
}
.selection-controls button { padding: 0.2rem 0.5rem; font-size: 0.68rem; }
.entry-list { flex: 1; min-height: 0; overflow-y: auto; }
.entry {
  display: flex; gap: 0.6rem; padding: 0.55rem 0.6rem; border-bottom: 1px solid var(--bs-faint);
  cursor: pointer; transition: background-color .1s;
  content-visibility: auto; contain-intrinsic-size: auto 56px;
}
.entry:hover { background: var(--bs-tint); }
.entry.selected { background: var(--bs-sel); }
.checkbox {
  flex-shrink: 0; width: 12px; height: 12px; border: 1.5px solid var(--bs-accent); border-radius: 2px;
  margin-top: 5px; background: var(--bs-bg); position: relative;
}
.checkbox.checked { background: var(--bs-accent); }
.checkbox.checked::after {
  content: ''; position: absolute; left: 3.5px; top: 0.5px; width: 4px; height: 8px;
  border: solid var(--bs-bg); border-width: 0 1.5px 1.5px 0; transform: rotate(45deg);
}
.entry-content { flex: 1; line-height: 1.45; min-width: 0; color: var(--bs-fg); }
.cite-key {
  font-family: var(--bs-mono); font-size: 0.72rem;
  color: var(--bs-accent); background: var(--bs-tint); padding: 0 4px; border-radius: 3px; margin-right: 6px;
}
.pdf-link {
  color: inherit; text-decoration: none; cursor: pointer;
  border-bottom: 1px dotted var(--bs-accent); transition: color .12s, background-color .12s;
}
.pdf-link:hover { color: var(--bs-accent); border-bottom-color: var(--bs-accent); background: var(--bs-tint); }
.empty, .error { padding: 2rem; text-align: center; color: var(--bs-dim); font-style: italic; }
.error { color: var(--bs-error); background: color-mix(in srgb, var(--bs-error) 8%, transparent); }
.action-bar {
  padding: 0.6rem; background: var(--bs-chrome); border-top: 1px solid var(--bs-border);
  display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;
}
.macro-select {
  font-family: var(--bs-mono); font-size: 0.8rem;
  padding: 0.35rem 0.4rem; border: 1px solid var(--bs-border); background: var(--bs-bg); color: var(--bs-fg);
}
.entry-list::-webkit-scrollbar { width: 8px; }
.entry-list::-webkit-scrollbar-track { background: var(--bs-chrome); }
.entry-list::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--bs-dim) 45%, transparent); border-radius: 4px; }
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
    sortAuthor: (family[0] || '').toLowerCase(),
    sortYear: parseInt(year, 10) || 0,
    sortTitle: title.toLowerCase().replace(/^(the|a|an)\s+/, ''),
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

/** Wrap a title's HTML in a "click to open the PDF" link when `link` is on. */
function pdfLink(inner, link) {
  return link
    ? `<a class="pdf-link" role="link" tabindex="0" title="Open PDF">${inner}</a>`
    : inner;
}

/** Render one CSL-JSON entry as a Chicago author-date reference (HTML).
 *  Journal titles and books are italicised; article titles quoted. When
 *  `opts.link` is set, the title becomes a PDF link (a BibDesk attachment). */
function formatChicago(e, opts = {}) {
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
    const inner = isBook ? `<i>${escapeHtml(title)}</i>` : escapeHtml(title);
    const linked = pdfLink(inner, opts.link);
    bits.push(isBook
      ? `${linked}${titlePunct}`
      : `&ldquo;${linked}${titlePunct}&rdquo;`);
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
    sortAuthor: author.toLowerCase(),
    sortYear: parseInt(year, 10) || 0,
    sortTitle: title.toLowerCase().replace(/^(the|a|an)\s+/, ''),
    search: `${km[1]} ${cleanTeX(authorRaw)} ${year} ${title}`.toLowerCase(),
  };
}

/** Map each cite key to its BibDesk `bdsk-file-1` value (a base64 macOS
 *  alias), for the entries that carry one. citation.js drops the field, so
 *  we read it straight from the raw BibTeX. Whitespace inside the base64
 *  (BibDesk may wrap it across lines) is stripped so it decodes cleanly. */
function bdskFilesByKey(text) {
  const map = new Map();
  for (const { source } of splitBibEntries(text)) {
    const km = source.match(/@\w+\s*\{\s*([^,\s}]+)/);
    if (!km) continue;
    const val = bibField(source, 'bdsk-file-1');
    if (val) map.set(km[1], val.replace(/\s+/g, ''));
  }
  return map;
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
    this._sort = 'author';       // sort order (author / year / title / file)
    this._bdskByKey = new Map(); // cite key → BibDesk PDF alias (base64)
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
    const placeholder = this.getAttribute('placeholder')
      || 'Search — regex ok (e.g. ale|br, ^smith, 19[89]\\d)…';
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="container">
        <div class="search-bar"><div class="search-wrapper">
          <input type="text" class="search-input" placeholder="${escapeHtml(placeholder)}"
                 aria-label="Search bibliography">
          <button class="clear-btn" type="button" title="Clear" aria-label="Clear">×</button>
        </div></div>
        <div class="toolbar">
          <span class="status">Loading…</span>
          <div class="selection-controls">
            <select class="sort-select" aria-label="Sort order" title="Sort">
              <option value="author">Author</option>
              <option value="year-desc">Year ↓</option>
              <option value="year-asc">Year ↑</option>
              <option value="title">Title</option>
              <option value="file">File order</option>
            </select>
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
    this._sortSel = $('.sort-select');
    this._sortSel.value = this._sort;
    this._sortSel.addEventListener('change', () => {
      this._sort = this._sortSel.value;
      this._sortEntries();
      this._applyFilter();
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
      // A title that links to a BibDesk PDF: open it, don't toggle selection.
      const link = e.target.closest('.pdf-link');
      if (link) {
        e.preventDefault();
        const linkRow = link.closest('.entry');
        if (linkRow) this._openPdf(linkRow.dataset.key);
        return;
      }
      const row = e.target.closest('.entry');
      if (row) this._toggle(row.dataset.key);
    });
    this._list.addEventListener('dblclick', (e) => {
      if (e.target.closest('.pdf-link')) return; // PDF link, not a pick
      const row = e.target.closest('.entry');
      if (row) { this.selected = new Set([row.dataset.key]); this._insert(); }
    });
    // The host answers an open-external request with one of these.
    this.addEventListener('pdf-opened', () => this._setCountStatus());
    this.addEventListener('pdf-error', (e) => {
      const msg = (e.detail && e.detail.error) || 'could not open';
      if (this._status) this._status.textContent = `PDF: ${msg}`;
      setTimeout(() => this._setCountStatus(), 2500);
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
      // BibDesk PDF aliases (by cite key) — the raw field citation.js drops.
      // Attach the opaque value to each entry so its title can link to the PDF.
      const pdfs = bdskFilesByKey(text);
      this._bdskByKey = pdfs;
      for (const e of entries) e.pdf = pdfs.get(e.key) || null;
      this.entries = entries;
      this._loose = loose;
      this.selected.clear();
      this._sortEntries();
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

  /** A predicate for QUERY. Each whitespace-separated term is a
   *  case-insensitive RegExp (a plain word is itself a valid regex, so
   *  substring search still "just works"); ALL terms must match (AND). So
   *  `ale|br` matches "ale" OR "br", `skyrms 2019` is two ANDed terms, and
   *  `^smith` anchors. A half-typed / malformed pattern falls back to a
   *  literal match for that term and flags the input, so the list never
   *  blanks out mid-keystroke. */
  _matcher(q) {
    const query = q.trim();
    if (this._input) this._input.classList.remove('invalid');
    if (query === '') return () => true;
    let invalid = false;
    const tests = query.split(/\s+/).map((term) => {
      try {
        return new RegExp(term, 'i');
      } catch {
        invalid = true;
        const lit = term.toLowerCase();
        return { test: (s) => s.includes(lit) };
      }
    });
    if (invalid && this._input) this._input.classList.add('invalid');
    return (e) => tests.every((re) => re.test(e.search));
  }

  /** Sort `this.entries` in place by the current `_sort` mode. Missing
   *  author/title sort to the end; ties break by author then year. */
  _sortEntries() {
    const cmp = (a, b) => a.localeCompare(b);
    const byAuthor = (a, b) =>
      cmp(a.sortAuthor || '￿', b.sortAuthor || '￿') ||
      (a.sortYear - b.sortYear) ||
      cmp(a.sortTitle || '', b.sortTitle || '');
    const comparators = {
      author: byAuthor,
      'year-desc': (a, b) => (b.sortYear || 0) - (a.sortYear || 0) || byAuthor(a, b),
      'year-asc': (a, b) => (a.sortYear || 0) - (b.sortYear || 0) || byAuthor(a, b),
      title: (a, b) => cmp(a.sortTitle || '￿', b.sortTitle || '￿') || byAuthor(a, b),
      file: (a, b) => a.index - b.index,
    };
    this.entries.sort(comparators[this._sort] || comparators.author);
  }

  _applyFilter() {
    const q = this._input ? this._input.value : '';
    const match = this._matcher(q);
    this.filtered = this.entries.filter(match);
    this._renderList();
    this._setCountStatus();
    this._syncAction();
  }

  /** Set the toolbar status to the entry/match count (the resting state). */
  _setCountStatus() {
    if (!this._status || !this.entries || !this.entries.length) return;
    const q = this._input ? this._input.value.trim() : '';
    const loose = this._loose ? ` (${this._loose} loose)` : '';
    this._status.textContent = q
      ? `${this.filtered.length} / ${this.entries.length}`
      : `${this.entries.length} entries${loose}`;
  }

  /** Ask the host to open the BibDesk PDF attached to the entry KEY. The
   *  host resolves the opaque alias (native macOS bookmark) and opens it in
   *  the default reader, then answers with `pdf-opened` / `pdf-error`. */
  _openPdf(key) {
    const bdsk = key && this._bdskByKey.get(key);
    if (!bdsk) return;
    if (this._status) this._status.textContent = 'Opening PDF…';
    this.dispatchEvent(new CustomEvent('open-external', {
      detail: {
        bdsk,
        bibPath: this.getAttribute('bib-path') || undefined,
        source: this,
      },
      bubbles: true,
      composed: true,
    }));
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
        ? formatChicago(e.csl, { link: !!e.pdf })
        : (e.authorStr ? `${escapeHtml(e.authorStr)} ` : '') +
          (e.year ? `${escapeHtml(e.year)}. ` : '') +
          (e.title ? pdfLink(`<i>${escapeHtml(e.title)}</i>`, !!e.pdf) : '');
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
