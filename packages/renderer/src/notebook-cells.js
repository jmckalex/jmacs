/**
 * notebook-cells.js — a generalizable, language-agnostic cell-notebook model.
 *
 * Architecture A: every cell lives in ONE unified buffer, so the editor parses
 * and highlights the whole notebook with a SINGLE syntax tree and its existing
 * WINDOWED renderer draws only the visible lines (`view.js` `renderLines` keeps
 * ~viewport+overscan line elements in the DOM regardless of size — a 70k-line
 * file is ~50 DOM lines). Each cell is wrapped in language-specific scaffolding,
 * on its OWN lines, so the single parse cannot bleed across cell boundaries; an
 * offset map translates cell-local <-> unified positions. Highlighting is then
 * free: parse `unifiedText()`, take the editor's per-line token runs, and slice
 * them by each cell's `cellLineRange`.
 *
 * Generalizable: a LANGUAGE ADAPTER supplies the scaffolding + the highlighter
 * key. JS, Lisp and Python ship below; another language is just a new adapter
 * (open/close wrapper lines + a per-line indent for indentation-structured
 * languages) — no model changes, "minimal plumbing". The MODEL is pure
 * (no DOM, no highlighter dependency), so it is fully unit-testable and the same
 * core serves a JS notebook, a Lisp notebook, a Python notebook, …
 */

/**
 * @typedef {object} CellLangAdapter
 * @property {string} id                 - adapter id ('javascript' | 'lisp' | …)
 * @property {string} highlightLanguage  - key into the editor's highlighter map
 * @property {string} open   - wrapper line opening a cell's syntactic unit ('' = none)
 * @property {string} close  - wrapper line closing it ('' = none)
 * @property {number} indent - columns prepended to each content line (Python: 4)
 */

/**
 * Built-in adapters. Each isolates a cell so the single whole-notebook parse
 * can't bleed across a boundary (an unbalanced/mid-edit cell stays contained).
 */
export const NOTEBOOK_ADAPTERS = Object.freeze({
  // A block scope: redeclarations don't collide and the braces fence the cell.
  javascript: Object.freeze({
    id: 'javascript', highlightLanguage: 'javascript', open: '{', close: '}', indent: 0,
  }),
  // A `(progn …)` fences the cell's forms into one isolated top-level form.
  lisp: Object.freeze({
    id: 'lisp', highlightLanguage: 'lisp', open: '(progn', close: ')', indent: 0,
  }),
  // An `if True:` block; content indented under it — Python is indentation-
  // structured, so the wrapper proves the adapter handles per-line indent.
  python: Object.freeze({
    id: 'python', highlightLanguage: 'python', open: 'if True:', close: '', indent: 4,
  }),
});

let cellSeq = 0;
/** A fresh unique cell id. */
export function freshCellId() {
  cellSeq += 1;
  return `cell-${cellSeq}`;
}

/** Indent every non-empty line of CONTENT by N columns (Python wrapping). */
function indentBody(content, n) {
  if (n <= 0) return content;
  const pad = ' '.repeat(n);
  return content.split('\n').map((l) => (l.length ? pad + l : l)).join('\n');
}

/**
 * Create a notebook document over a language ADAPTER. Holds the ordered cells,
 * builds the unified buffer, and maps positions between a cell and the buffer.
 * Structural ops invalidate a cached layout that is rebuilt lazily.
 *
 * @param {CellLangAdapter} adapter
 */
export function createNotebookDocument(adapter) {
  if (
    !adapter ||
    typeof adapter.open !== 'string' ||
    typeof adapter.close !== 'string' ||
    typeof adapter.indent !== 'number'
  ) {
    throw new TypeError('createNotebookDocument: a language adapter is required');
  }

  /** @type {{ id: string, content: string }[]} */
  const cells = [];
  /** @type {{ text: string, byId: Map<string, object>, order: string[] } | null} */
  let layout = null;

  function indexOf(id) {
    return cells.findIndex((c) => c.id === id);
  }

  /** Rebuild the unified buffer text + per-cell offset/line map (O(total)). */
  function rebuild() {
    let text = '';
    let line = 0;
    const append = (s) => {
      for (let i = 0; i < s.length; i += 1) if (s[i] === '\n') line += 1;
      text += s;
    };
    const byId = new Map();
    const order = [];
    for (const cell of cells) {
      if (adapter.open) append(`${adapter.open}\n`);
      const contentStartOffset = text.length;
      const contentStartLine = line;
      const body = indentBody(cell.content, adapter.indent);
      append(body);
      const contentEndOffset = text.length;
      append('\n');
      if (adapter.close) append(`${adapter.close}\n`);
      byId.set(cell.id, {
        id: cell.id,
        contentStartLine,
        contentLineCount: body.split('\n').length,
        contentStartOffset,
        contentEndOffset,
        indent: adapter.indent,
      });
      order.push(cell.id);
    }
    layout = { text, byId, order };
  }

  function ensure() {
    if (layout === null) rebuild();
    return layout;
  }
  function invalidate() {
    layout = null;
  }

  return {
    adapter,

    /** The ordered cell ids. */
    cellIds() {
      return ensure().order.slice();
    },
    /** Number of cells. */
    cellCount() {
      return cells.length;
    },
    /** The raw (unwrapped, unindented) source of a cell — what the eval runs. */
    cellContent(id) {
      const i = indexOf(id);
      return i === -1 ? null : cells[i].content;
    },
    /** The unified buffer text — what the editor parses + highlights once. */
    unifiedText() {
      return ensure().text;
    },
    /** A cell's layout record { contentStartLine, contentLineCount, indent, … }. */
    cellLayout(id) {
      return ensure().byId.get(id) ?? null;
    },
    /**
     * [startLine, endLine) of a cell's CONTENT in the unified buffer — for
     * slicing the editor's per-line runs and anchoring the cell's chrome
     * (gutter / run button / output) via the block-widget layer.
     */
    cellLineRange(id) {
      const r = ensure().byId.get(id);
      return r ? [r.contentStartLine, r.contentStartLine + r.contentLineCount] : null;
    },

    /** Cell-local (line, col) -> unified (line, col). */
    toUnified(id, cellLine, cellCol) {
      const r = ensure().byId.get(id);
      if (!r) return null;
      return { line: r.contentStartLine + cellLine, column: r.indent + cellCol };
    },
    /**
     * Unified (line, col) -> { id, cellLine, cellCol }, or null when the point
     * is on a scaffolding line (a wrapper open/close) — i.e. not in any cell.
     */
    fromUnified(uLine, uCol) {
      const l = ensure();
      for (const id of l.order) {
        const r = l.byId.get(id);
        if (uLine >= r.contentStartLine && uLine < r.contentStartLine + r.contentLineCount) {
          return { id, cellLine: uLine - r.contentStartLine, cellCol: Math.max(0, uCol - r.indent) };
        }
      }
      return null;
    },

    // --- structural ops (each invalidates the cached layout) ----------------
    /** Append (or insert at ATINDEX) a cell; returns its fresh id. */
    addCell(content = '', atIndex = cells.length) {
      const id = freshCellId();
      const i = Math.max(0, Math.min(atIndex, cells.length));
      cells.splice(i, 0, { id, content: String(content ?? '') });
      invalidate();
      return id;
    },
    removeCell(id) {
      const i = indexOf(id);
      if (i === -1) return false;
      cells.splice(i, 1);
      invalidate();
      return true;
    },
    setContent(id, content) {
      const i = indexOf(id);
      if (i === -1) return false;
      cells[i].content = String(content ?? '');
      invalidate();
      return true;
    },
    moveCell(id, toIndex) {
      const i = indexOf(id);
      if (i === -1) return false;
      const [c] = cells.splice(i, 1);
      const j = Math.max(0, Math.min(toIndex, cells.length));
      cells.splice(j, 0, c);
      invalidate();
      return true;
    },
  };
}
