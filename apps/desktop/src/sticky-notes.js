/**
 * @file Sticky notes — resizable rectangles overlaid on the buffer.
 *
 * A note holds JMarkdown source; its rendered HTML is shown in the
 * note body. Notes are anchored to a character offset in the buffer,
 * so they ride the text as it scrolls and as it is edited. They live
 * in the editor view's `overlayLayer` — an empty layer the host fills
 * — positioned in the same `1lh` grid the text uses, so scrolling is
 * free (the layer spans the whole document).
 *
 * This module owns the note DOM and the mouse interaction. The note
 * data lives on `buffer.metadata.notes`, an ad-hoc host property; the
 * module never touches the L2 buffer's own state. JMarkdown rendering
 * and persistence are injected (`render`, `onChange`) so this module
 * stays independent of how those are wired.
 */

/** Smallest a note may be dragged, in pixels. */
const MIN_WIDTH = 96;
const MIN_HEIGHT = 56;

/** A fresh note's geometry. */
const DEFAULT = { x: 80, y: 6, width: 252, height: 156 };

/** Escape text for safe display as HTML. */
function escapeHtml(text) {
  return text.replace(
    /[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]
  );
}

/**
 * Re-place a note anchor after a buffer edit — the marker arithmetic
 * the L2 buffer does not yet provide. Given a `BufferChange`
 * (`{start, removed, inserted}`, with `removed`/`inserted` strings),
 * return the anchor's new offset:
 *
 * - an anchor at or before the edit stays (insertion gravity: stay);
 * - an anchor past the removed span shifts by the net length change;
 * - an anchor inside the removed span collapses to the edit start.
 *
 * @param {number} anchor
 * @param {{start: number, removed: string, inserted: string}} change
 * @returns {number}
 */
export function adjustAnchor(anchor, change) {
  const { start } = change;
  const removed = change.removed.length;
  const inserted = change.inserted.length;
  if (anchor <= start) return anchor;
  if (anchor >= start + removed) return anchor + inserted - removed;
  return start;
}

/**
 * Split a note's source into an optional YAML-style metadata header and
 * the Markdown body. A header is a `---` line, `key: value` lines, and a
 * closing `---` line, all at the very start of the source — e.g.
 * `---\ncolor: yellow\n---`. Keys are lower-cased; the first colon
 * separates key from value, so an `rgba(…)` value survives intact.
 *
 * @param {string} source
 * @returns {{meta: Record<string, string>, body: string}}
 */
export function parseNoteSource(source) {
  const meta = {};
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  if (!match) return { meta, body: source };
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (key) meta[key] = line.slice(colon + 1).trim();
  }
  return { meta, body: source.slice(match[0].length) };
}

/**
 * Validate a metadata `icon-size` value. Accepts a bare number or one
 * with a `px` suffix; clamps to a sane range so a typo like
 * `icon-size: 9999` can't take over the viewport. Returns the pixel
 * value as a number, or `null` when the input is missing or invalid.
 *
 * The bounds (12px–256px): under 12 the Font Awesome glyph stops
 * rendering recognisably; over 256 the note would dwarf the editor.
 *
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parseIconSize(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/px$/i, '').trim();
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (value < 12 || value > 256) return null;
  return value;
}

/** The Font Awesome classes for a collapsed note's glyph when no `icon`
 *  is set, or the value can't be parsed. */
export const DEFAULT_ICON_CLASSES = 'fa-solid fa-note-sticky';

/** Font Awesome style keywords recognised in an `icon:` value, so
 *  `icon: regular star` picks the regular face. A value with no style
 *  word defaults to `fa-solid` (the only universally free face besides
 *  brands). */
const ICON_STYLE_WORDS = new Set([
  'solid',
  'regular',
  'brands',
  'light',
  'thin',
  'duotone',
  'sharp',
]);

/**
 * Parse a metadata `icon:` value into a Font Awesome class string for the
 * collapsed-note glyph. Forgiving by design: a bare name (`star`), an
 * `fa-`-prefixed name (`fa-star`), an explicit style (`regular star`,
 * `fa-regular fa-star`), and trailing FA utility classes (`star fa-spin`)
 * all work. Every token is sanitised to `[a-z0-9-]`, so the result is
 * always a safe class list regardless of input. Returns `null` when the
 * value names no icon (so the caller can fall back to the default).
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
export function parseIconClasses(raw) {
  if (typeof raw !== 'string') return null;
  let style = null;
  const names = [];
  for (const token of raw.trim().toLowerCase().split(/\s+/)) {
    const bare = (token.startsWith('fa-') ? token.slice(3) : token).replace(
      /[^a-z0-9-]/g,
      ''
    );
    if (!bare) continue;
    if (ICON_STYLE_WORDS.has(bare)) style = `fa-${bare}`;
    else names.push(`fa-${bare}`);
  }
  if (names.length === 0) return null;
  return `${style ?? 'fa-solid'} ${names.join(' ')}`;
}

/**
 * Create the sticky-notes overlay manager.
 *
 * @param {object} options
 * @param {HTMLElement} options.overlayLayer - The view's overlay layer.
 * @param {() => import('@editor/buffer').Buffer} options.getBuffer -
 *   Returns the current buffer.
 * @param {(source: string) => (string | Promise<string>)} [options.render]
 *   - Turns a note's JMarkdown source into HTML. Defaults to showing
 *   the raw source.
 * @param {() => void} [options.onChange] - Called whenever note data
 *   changes; the host uses it to persist.
 */
export function createStickyNotes({ overlayLayer, getBuffer, render, onChange }) {
  // The overlay layer can be swapped at runtime via `setOverlayLayer`
  // (see below). Each per-tab text-view in a tabline has its own
  // overlay layer; on tab switch the host re-points us at the active
  // one so notes render in the right place. `doc` / `win` are
  // intentionally captured once — they're document-level objects, not
  // per-layer.
  let overlay = overlayLayer;
  const doc = overlay.ownerDocument;
  const win = doc.defaultView ?? globalThis;

  /** Default renderer: the raw source, escaped, or an empty-note hint. */
  const defaultRender = (source) =>
    source.trim() === ''
      ? '<p class="sticky-note-empty">empty note — double-click to edit</p>'
      : `<pre class="sticky-note-raw">${escapeHtml(source)}</pre>`;
  const renderSource = typeof render === 'function' ? render : defaultRender;
  const notifyChanged = typeof onChange === 'function' ? onChange : () => {};

  /** The buffer whose notes are shown; swapped by `setBuffer`. */
  let buffer = null;
  /** Unsubscribe from the current buffer's change events. */
  let unwatch = () => {};
  /** id -> { root, body, editing }. The DOM for the current buffer. */
  const elements = new Map();
  /** source -> rendered HTML. Markdown is pure, so this is process-wide. */
  const htmlCache = new Map();
  /** A rising z-index, so a touched note comes to the front. */
  let topZ = 10;
  /** One line's height in pixels, measured lazily from the grid. */
  let lineHeightPx = 0;

  /** The current buffer's note array, created on first use. */
  function notes() {
    if (!buffer.metadata) buffer.metadata = {};
    if (!buffer.metadata.notes) buffer.metadata.notes = [];
    return buffer.metadata.notes;
  }

  /** The note with `id`, or undefined. */
  function noteById(id) {
    return notes().find((note) => note.id === id);
  }

  /** One line's height in pixels — the `1lh` the text grid uses. */
  function lineHeight() {
    if (lineHeightPx) return lineHeightPx;
    const probe = doc.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;height:1lh';
    overlay.append(probe);
    lineHeightPx = probe.getBoundingClientRect().height || 23;
    probe.remove();
    return lineHeightPx;
  }

  /** Position and size a note's element from its model. */
  function place(note, root) {
    const { line } = buffer.positionAt(note.anchor);
    root.style.left = `${note.x}px`;
    root.style.top = `calc(${line} * 1lh + ${note.y}px)`;
    root.style.width = `${note.width}px`;
    root.style.height = `${note.height}px`;
  }

  /** Typeset any mathematics in a note body, once MathJax is ready. */
  function typesetMath(bodyEl) {
    const mathJax = globalThis.MathJax;
    if (!mathJax) return;
    const run = () => {
      // The body's HTML was just replaced — drop MathJax's stale record
      // of it before typesetting afresh.
      if (typeof mathJax.typesetClear === 'function') {
        mathJax.typesetClear([bodyEl]);
      }
      if (typeof mathJax.typesetPromise === 'function') {
        mathJax.typesetPromise([bodyEl]).catch(() => {});
      }
    };
    // MathJax loads asynchronously; wait for its startup if need be.
    const ready = mathJax.startup && mathJax.startup.promise;
    if (ready) ready.then(run).catch(() => {});
    else run();
  }

  /** Put HTML into a note body and typeset the mathematics in it. */
  function setBody(bodyEl, html) {
    bodyEl.innerHTML = html;
    typesetMath(bodyEl);
  }

  /** A foreground colour that reads well on the given background. */
  function contrastingText(color) {
    const probe = doc.createElement('span');
    probe.style.color = color;
    doc.body.appendChild(probe);
    const computed = win.getComputedStyle(probe).color;
    probe.remove();
    const channels = /(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/.exec(
      computed
    );
    if (!channels) return '';
    const luminance =
      0.299 * Number(channels[1]) +
      0.587 * Number(channels[2]) +
      0.114 * Number(channels[3]);
    return luminance > 150 ? '#1c1c1c' : '#ececec';
  }

  /** Apply a note's metadata colour (or clear it back to the default). */
  function applyColor(entry, color) {
    const valid =
      typeof color === 'string' &&
      win.CSS &&
      win.CSS.supports('background-color', color);
    entry.root.style.background = valid ? color : '';
    entry.body.style.color = valid ? contrastingText(color) : '';
  }

  /** Apply a note's metadata `icon-size` (or clear it back to the
   *  default). The value is set as a CSS custom property on the note
   *  root; the collapsed-note CSS reads it via `var(--sticky-icon-size,
   *  30px)` so an absent or invalid value falls back to the default. */
  function applyIconSize(entry, raw) {
    const px = parseIconSize(raw);
    if (px === null) {
      entry.root.style.removeProperty('--sticky-icon-size');
    } else {
      entry.root.style.setProperty('--sticky-icon-size', `${px}px`);
    }
  }

  /** Apply a note's metadata `icon` (or restore the default) — sets the
   *  Font Awesome classes on the collapsed-note glyph. */
  function applyIcon(entry, raw) {
    entry.iconGlyph.className = parseIconClasses(raw) ?? DEFAULT_ICON_CLASSES;
  }

  /** Render a note's body from its source (async, cached, race-guarded). */
  function renderBody(id) {
    const note = noteById(id);
    const entry = elements.get(id);
    if (!note || !entry) return;
    // A leading metadata header sets the note's colour and is not part
    // of the Markdown that gets rendered.
    const { meta, body } = parseNoteSource(note.source);
    applyColor(entry, meta.color);
    applyIconSize(entry, meta['icon-size']);
    applyIcon(entry, meta.icon);
    const cached = htmlCache.get(body);
    if (cached !== undefined) {
      setBody(entry.body, cached);
      return;
    }
    Promise.resolve(renderSource(body))
      .then((html) => {
        htmlCache.set(body, html);
        const current = noteById(id);
        const e = elements.get(id);
        // Discard a stale render: the source may have changed while we
        // were waiting, in which case a newer renderBody already ran.
        if (e && current && parseNoteSource(current.source).body === body) {
          setBody(e.body, html);
        }
      })
      .catch(() => {
        const e = elements.get(id);
        if (e) setBody(e.body, defaultRender(body));
      });
  }

  /** Build the DOM for a note and wire its interactions. */
  function build(note) {
    const root = doc.createElement('div');
    root.className = 'sticky-note';
    root.dataset.id = note.id;
    if (note.collapsed) root.classList.add('is-collapsed');

    const bar = doc.createElement('div');
    bar.className = 'sticky-note-bar';
    const collapse = doc.createElement('button');
    collapse.className = 'sticky-note-collapse';
    collapse.title = 'Collapse note';
    collapse.innerHTML = '<i class="fa-solid fa-window-minimize"></i>';
    const close = doc.createElement('button');
    close.className = 'sticky-note-close';
    close.textContent = '×';
    close.title = 'Delete note';
    bar.append(collapse, close);

    const body = doc.createElement('div');
    body.className = 'sticky-note-body';

    const grip = doc.createElement('div');
    grip.className = 'sticky-note-resize';
    grip.title = 'Resize';

    // Shown only while the note is collapsed — the note shrunk to its
    // icon. Draggable, and double-clicked to expand again. The glyph's
    // Font Awesome classes are set from the note's `icon` metadata by
    // applyIcon (renderBody); they default until then.
    const icon = doc.createElement('div');
    icon.className = 'sticky-note-icon';
    icon.title = 'Double-click to expand';
    const iconGlyph = doc.createElement('i');
    iconGlyph.className = DEFAULT_ICON_CLASSES;
    icon.append(iconGlyph);

    root.append(bar, body, grip, icon);

    // A click anywhere on the note must not reach the editor surface
    // (which would place the text cursor); it also raises the note.
    root.addEventListener('mousedown', (event) => {
      root.style.zIndex = ++topZ;
      event.stopPropagation();
    });
    bar.addEventListener('mousedown', (event) => startMove(note, root, event));
    grip.addEventListener('mousedown', (event) =>
      startResize(note, root, event)
    );
    collapse.addEventListener('click', (event) => {
      event.stopPropagation();
      collapseNote(note.id);
    });
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      remove(note.id);
    });
    body.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      beginEdit(note.id);
    });
    icon.addEventListener('mousedown', (event) => startMove(note, root, event));
    icon.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      expandNote(note.id);
    });

    return { root, body, iconGlyph, editing: false };
  }

  /** Shrink a note to its icon. */
  function collapseNote(id) {
    const note = noteById(id);
    const entry = elements.get(id);
    if (!note || !entry || note.collapsed) return;
    note.collapsed = true;
    entry.root.classList.add('is-collapsed');
    notifyChanged();
  }

  /** Restore a collapsed note to its full size and position. */
  function expandNote(id) {
    const note = noteById(id);
    const entry = elements.get(id);
    if (!note || !entry || !note.collapsed) return;
    note.collapsed = false;
    entry.root.classList.remove('is-collapsed');
    notifyChanged();
  }

  /** Add a note's element to the overlay and render it. */
  function addElement(note) {
    const entry = build(note);
    elements.set(note.id, entry);
    overlay.append(entry.root);
    place(note, entry.root);
    renderBody(note.id);
  }

  /** Drag the note by its bar — re-anchors to the line it lands on. */
  function startMove(note, root, event) {
    event.preventDefault();
    event.stopPropagation();
    root.style.zIndex = ++topZ;
    const lh = lineHeight();
    const startLine = buffer.positionAt(note.anchor).line;
    const startTop = startLine * lh + note.y;
    const originX = event.clientX;
    const originY = event.clientY;
    const baseX = note.x;

    function onMove(ev) {
      const left = Math.max(0, baseX + (ev.clientX - originX));
      const top = Math.max(0, startTop + (ev.clientY - originY));
      const line = Math.min(buffer.lineCount - 1, Math.round(top / lh));
      note.x = left;
      note.y = top - line * lh;
      note.anchor = buffer.offsetAt(line, 0);
      root.style.left = `${note.x}px`;
      root.style.top = `calc(${line} * 1lh + ${note.y}px)`;
    }
    function onUp() {
      doc.removeEventListener('mousemove', onMove);
      doc.removeEventListener('mouseup', onUp);
      notifyChanged();
    }
    doc.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', onUp);
  }

  /** Drag the corner grip to resize the note. */
  function startResize(note, root, event) {
    event.preventDefault();
    event.stopPropagation();
    root.style.zIndex = ++topZ;
    const originX = event.clientX;
    const originY = event.clientY;
    const baseW = note.width;
    const baseH = note.height;

    function onMove(ev) {
      note.width = Math.max(MIN_WIDTH, baseW + (ev.clientX - originX));
      note.height = Math.max(MIN_HEIGHT, baseH + (ev.clientY - originY));
      root.style.width = `${note.width}px`;
      root.style.height = `${note.height}px`;
    }
    function onUp() {
      doc.removeEventListener('mousemove', onMove);
      doc.removeEventListener('mouseup', onUp);
      notifyChanged();
    }
    doc.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', onUp);
  }

  /** Swap a note's body for a textarea of its source; commit on blur. */
  function beginEdit(id) {
    const note = noteById(id);
    const entry = elements.get(id);
    if (!note || !entry || entry.editing) return;
    entry.editing = true;

    const textarea = doc.createElement('textarea');
    textarea.className = 'sticky-note-edit';
    textarea.value = note.source;
    textarea.spellcheck = false;
    // The editor is transparent over the note; carry the body's
    // contrast colour so the text stays readable on a coloured note.
    textarea.style.color = entry.body.style.color;

    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      entry.editing = false;
      textarea.replaceWith(entry.body);
      if (value !== note.source) {
        note.source = value;
        renderBody(id);
        notifyChanged();
      }
    }

    // The editor's keydown listener is on the .editor root and ignores
    // event.target — without stopping propagation here, every keystroke
    // would also run an editor command.
    textarea.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(note.source); // cancel
      }
    });
    textarea.addEventListener('mousedown', (event) => event.stopPropagation());
    textarea.addEventListener('blur', () => finish(textarea.value));

    entry.body.replaceWith(textarea);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  /** Re-place every note — called when the buffer's lines shift. */
  function reposition() {
    for (const note of notes()) {
      const entry = elements.get(note.id);
      if (entry) place(note, entry.root);
    }
  }

  /** React to a buffer change: track anchors, then re-place notes. */
  function onBufferChange(event) {
    if (event.change) {
      let moved = false;
      for (const note of notes()) {
        const next = adjustAnchor(note.anchor, event.change);
        if (next !== note.anchor) {
          note.anchor = next;
          moved = true;
        }
      }
      if (moved) notifyChanged();
    }
    reposition();
  }

  /** Remove every note element from the overlay. */
  function clearElements() {
    for (const { root } of elements.values()) root.remove();
    elements.clear();
  }

  // --- the public / imperative API --------------------------------------

  /** Show the notes of `next`, rebuilding the overlay. */
  function setBuffer(next) {
    unwatch();
    buffer = next;
    unwatch = buffer.onChange(onBufferChange);
    clearElements();
    for (const note of notes()) addElement(note);
  }

  /** Create a note at `offset` (default: the cursor). Returns its id. */
  function create(offset) {
    const anchor =
      typeof offset === 'number' ? offset : buffer.point;
    const note = {
      id: globalThis.crypto.randomUUID(),
      anchor,
      x: DEFAULT.x,
      y: DEFAULT.y,
      width: DEFAULT.width,
      height: DEFAULT.height,
      source: '',
      collapsed: false,
    };
    notes().push(note);
    addElement(note);
    notifyChanged();
    return note.id;
  }

  /** Delete the note with `id`. */
  function remove(id) {
    const list = notes();
    const index = list.findIndex((note) => note.id === id);
    if (index < 0) return;
    list.splice(index, 1);
    const entry = elements.get(id);
    if (entry) {
      entry.root.remove();
      elements.delete(id);
    }
    notifyChanged();
  }

  /** Set a note's JMarkdown source and re-render it. */
  function setSource(id, source) {
    const note = noteById(id);
    if (!note) return;
    note.source = source;
    renderBody(id);
    notifyChanged();
  }

  /** A note's JMarkdown source, or null. */
  function getSource(id) {
    const note = noteById(id);
    return note ? note.source : null;
  }

  /** Re-anchor a note to `line` and set its left edge to `x` px. */
  function move(id, line, x) {
    const note = noteById(id);
    if (!note) return;
    const clamped = Math.max(0, Math.min(buffer.lineCount - 1, line | 0));
    note.anchor = buffer.offsetAt(clamped, 0);
    note.x = Math.max(0, x | 0);
    note.y = 0;
    const entry = elements.get(id);
    if (entry) place(note, entry.root);
    notifyChanged();
  }

  /** Resize a note to `width` x `height` pixels. */
  function resize(id, width, height) {
    const note = noteById(id);
    if (!note) return;
    note.width = Math.max(MIN_WIDTH, width | 0);
    note.height = Math.max(MIN_HEIGHT, height | 0);
    const entry = elements.get(id);
    if (entry) place(note, entry.root);
    notifyChanged();
  }

  /** The ids of the current buffer's notes. */
  function ids() {
    return notes().map((note) => note.id);
  }

  /** How many notes the current buffer has. */
  function count() {
    return notes().length;
  }

  /** The id of the note whose anchor is nearest the cursor, or null. */
  function noteAtPoint() {
    const list = notes();
    if (list.length === 0) return null;
    const point = buffer.point;
    let best = list[0];
    for (const note of list) {
      if (
        Math.abs(note.anchor - point) < Math.abs(best.anchor - point)
      ) {
        best = note;
      }
    }
    return best.id;
  }

  /** Open a note's in-place editor. */
  function edit(id) {
    beginEdit(id);
  }

  /** Move the cursor to a note and scroll it into view. */
  function gotoNote(id) {
    const note = noteById(id);
    if (!note) return;
    buffer.moveTo(note.anchor);
    const entry = elements.get(id);
    if (entry) entry.root.scrollIntoView({ block: 'center' });
  }

  /** Move the cursor to the next note after it, by anchor order. */
  function gotoNext() {
    const sorted = [...notes()].sort((a, b) => a.anchor - b.anchor);
    const next = sorted.find((note) => note.anchor > buffer.point);
    if (next) gotoNote(next.id);
  }

  /** Move the cursor to the previous note before it, by anchor order. */
  function gotoPrevious() {
    const sorted = [...notes()].sort((a, b) => b.anchor - a.anchor);
    const prev = sorted.find((note) => note.anchor < buffer.point);
    if (prev) gotoNote(prev.id);
  }

  /** Show or hide every note in the buffer. */
  function toggle() {
    overlay.classList.toggle('notes-hidden');
  }

  /** Tear down all listeners and DOM. */
  function destroy() {
    unwatch();
    clearElements();
  }

  /** Re-point the overlay layer the notes render into. Used when the
   *  host swaps which text-view (and thus which overlay layer) is
   *  active — per-tab text-views in a tabline each have their own
   *  overlay. Moves every existing note's DOM into the new layer and
   *  preserves the notes-hidden toggle state. */
  function setOverlayLayer(nextLayer) {
    if (!nextLayer || nextLayer === overlay) return;
    const wasHidden = overlay.classList.contains('notes-hidden');
    for (const entry of elements.values()) {
      nextLayer.append(entry.root);
    }
    if (wasHidden) nextLayer.classList.add('notes-hidden');
    overlay = nextLayer;
    // Force a re-measure of the line height against the new layer's
    // computed style — the old measurement was tied to the old layer.
    lineHeightPx = 0;
  }

  return {
    setBuffer,
    setOverlayLayer,
    create,
    remove,
    setSource,
    getSource,
    move,
    resize,
    ids,
    count,
    noteAtPoint,
    edit,
    gotoNote,
    gotoNext,
    gotoPrevious,
    toggle,
    destroy,
  };
}
