/**
 * @file `<text-view>` — the custom-element wrapper around the text
 * editor renderer.
 *
 * Phase 2 of `plans/VIEWS-AS-CUSTOM-ELEMENTS.md`: a thin wrapper. The
 * existing `createEditorView` factory still does the heavy lifting;
 * `TextView` provides the custom-element shell (lifecycle hooks,
 * warehouse-friendly identity, `data-file-path` mirror) and exposes
 * the editor's API as instance methods.
 *
 * The closure-heavy internals of `createEditorView` *can* be refactored
 * into class methods later. The decision (Phase 2 charter): not in this
 * pass. The wrapper gives us the lifecycle guarantees the editor needs
 * — single-parent enforcement, warehouse-style stashing, explicit
 * `destroy()` — without rewriting 900 lines of tested editor logic.
 *
 * Lifecycle (see `view-elements.js` and `plans/VIEWS-AS-CUSTOM-ELEMENTS.md`):
 *
 *   - `constructor()` does no DOM work. State fields are initialised
 *     to null / sentinel.
 *   - `setBuffer(buffer)` or `setView(view)` populates the pending
 *     buffer reference. If the element is already connected and
 *     mounted, the underlying editor is re-pointed via its `setView`.
 *   - `connectedCallback()` mounts the editor lazily — only on first
 *     connect with a buffer in hand. A re-connect (moving between
 *     panes / out of the warehouse) is a no-op for the editor; only
 *     the DOM-tree position changes.
 *   - `disconnectedCallback()` is empty. Moves fire it; they're not
 *     teardowns.
 *   - `destroy()` is the explicit teardown — runs the inner editor's
 *     destroy() which unsubscribes from the buffer, cancels any
 *     pending frame, and removes the inner root.
 *
 * Construction options (`configure(options)`) must be set BEFORE the
 * first `connectedCallback` mounts the editor. Reconfiguring after
 * mount isn't supported and throws — keeps the model honest.
 */

import { createEditorView } from './view.js';
import { defineViewElement, ViewElement } from './view-elements.js';

/**
 * @typedef {object} TextViewOptions
 * @property {(key: string) => boolean} [onKey] - Key dispatcher.
 * @property {Record<string, *>} [highlighters] - Tree-sitter highlighters.
 * @property {Record<string, *>} [foldCaptures] - Fold-capture extractors.
 * @property {boolean} [colourSwatches] - Colour-literal decoration.
 * @property {() => number} [getPoint] - Per-view-point reader.
 * @property {() => number | null} [getMark] - Per-view-mark reader.
 * @property {() => Array<{point: number, mark: number|null}>} [getCursors]
 *   - Multi-cursor reader.
 * @property {() => number} [getTabWidth] - The tab-width reader.
 * @property {() => import('./projection.js').DecorationRange[]}
 *   [getDecorations] - Face-tagged offset ranges to paint as styled
 *   boxes (e.g. snippet fields + mirrors). Read every render.
 * @property {() => Array<{start:number, end:number, kind:'inline'|'block',
 *   el?: () => Node}>} [getReplacedRanges] - Replaced-range widgets
 *   (math preview). Read fresh each render.
 */

export class TextView extends ViewElement {
  constructor() {
    super();
    /** @type {*} */
    this._editor = null;
    /** @type {TextViewOptions | null} */
    this._mountOptions = null;
    /** @type {*} */
    this._pendingBuffer = null;
    /** @type {*} */
    this._pendingView = null;
  }

  /**
   * Supply the construction-time options the editor needs (key
   * dispatcher, highlighters, per-view-point closures, …). Must be
   * called before the first `connectedCallback` mounts the editor.
   * Calling it after mount throws — reconfiguring an already-mounted
   * editor isn't supported by this wrapper.
   *
   * @param {TextViewOptions} options
   */
  configure(options) {
    if (this._editor !== null) {
      throw new Error(
        'TextView.configure: cannot reconfigure after the editor is mounted; ' +
        'destroy() and replace, or change properties via setView'
      );
    }
    this._mountOptions = options;
  }

  /**
   * Bind to a buffer. The renderer will subscribe to its onChange and
   * render its content. Idempotent: re-binding to the same buffer is a
   * no-op for the buffer subscription, but still triggers a re-render
   * (matching the existing `setView` semantics for the unmounted →
   * mounted reveal pass).
   *
   * @param {import('@editor/buffer').Buffer} buffer
   */
  setBuffer(buffer) {
    this._pendingBuffer = buffer;
    this._pendingView = null;
    this._syncFilePathAttr(buffer);
    if (this._editor !== null) {
      // Wrap the bare buffer in a minimal view-shaped object — the
      // inner editor's setView expects `.buffer` and ignores most else
      // (per-view-point closures take precedence over the view fields).
      this._editor.setView({ buffer, point: 0, mark: null });
    }
  }

  /**
   * Bind to a Lisp-side View handle (carries `buffer`, `point`, `mark`,
   * `cursors`, etc.). The inner editor reads buffer state from `.buffer`
   * and cursor state from the configured per-view-point closures (which
   * the desktop app passes via `configure`).
   *
   * @param {*} view
   */
  setView(view) {
    this._pendingView = view;
    this._pendingBuffer = view && view.buffer ? view.buffer : null;
    this._syncFilePathAttr(this._pendingBuffer);
    if (this._editor !== null) {
      this._editor.setView(view);
    }
  }

  /**
   * The buffer the editor is bound to (or the pending buffer if the
   * element hasn't been mounted yet).
   *
   * @returns {*}
   */
  get buffer() {
    return this._pendingBuffer;
  }

  /**
   * The View handle the editor was last bound to, if `setView` was
   * used. `null` if only `setBuffer` was called.
   *
   * @returns {*}
   */
  get boundView() {
    return this._pendingView;
  }

  // --- view-shape getters --------------------------------------------
  // The minimum surface the editor's existing helpers (viewFilePath,
  // the tabline strip widget, the modeline) read off a view. By
  // exposing these as getters on the element, all those helpers work
  // with TextView elements unchanged.

  /** Every text-view is kind 'text'. */
  get kind() { return 'text'; }

  /** Buffer's name, or a placeholder. Used for the tab label. */
  get name() {
    const buf = this._pendingBuffer;
    return (buf && typeof buf.name === 'string') ? buf.name : '*text*';
  }

  /** Buffer's file path, or null. Used by `viewFilePath`. */
  get filePath() {
    const buf = this._pendingBuffer;
    return (buf && typeof buf.filePath === 'string') ? buf.filePath : null;
  }

  // --- Custom-element lifecycle ---------------------------------------

  /**
   * Fired when the element joins the document tree. Mounts the
   * underlying editor on first connect (when a buffer is in hand). A
   * re-connect (move between containers — pane ↔ warehouse, pane ↔
   * pane) is a no-op for the editor itself; only the DOM-tree position
   * changes.
   */
  connectedCallback() {
    if (this._editor !== null) return;
    if (this._pendingBuffer === null) return; // park-without-buffer
    this._editor = createEditorView(
      this._pendingBuffer,
      this,
      this._mountOptions ?? {}
    );
    if (this._pendingView !== null) {
      this._editor.setView(this._pendingView);
    }
  }

  /**
   * Fired when the element leaves the document tree. Allowed to be
   * empty (Phase 0 Decision 3): a move and a destroy look the same
   * from inside this callback. Real teardown is `destroy()`.
   */
  disconnectedCallback() {
    /* intentionally empty */
  }

  /**
   * Explicit teardown. Called by the editor's kill-view path. Releases
   * the buffer subscription, cancels any pending animation frame,
   * detaches inner DOM. Safe to call when the editor was never mounted.
   */
  destroy() {
    if (this._editor !== null) {
      this._editor.destroy();
      this._editor = null;
    }
    this._pendingBuffer = null;
    this._pendingView = null;
  }

  // --- Pass-through API ----------------------------------------------

  /** Focus the editor's input target. */
  focus() {
    if (this._editor !== null) this._editor.focus();
    else super.focus();
  }

  /** Scroll the cursor's line to the centre of the viewport. */
  recenter() {
    if (this._editor !== null) this._editor.recenter();
  }

  /** Flash a transient highlight band over the cursor's line. */
  flashCurrentLine() {
    if (this._editor !== null) this._editor.flashCurrentLine();
  }

  /** Force a re-render without moving the cursor — used by an embedding
   *  host (the notebook view) to re-mount replaced-range widgets after an
   *  out-of-band content change (a cell finished running). */
  refresh() {
    if (this._editor !== null) this._editor.refresh();
  }

  /** Roughly how many lines fit in the viewport — for paging. */
  pageLines() {
    return this._editor !== null ? this._editor.pageLines() : 0;
  }

  /** Buffer offset for a viewport pixel position. */
  offsetFromPoint(x, y) {
    return this._editor !== null
      ? this._editor.offsetFromPoint(x, y)
      : null;
  }

  /** The background layer — host-fillable element behind the text. */
  get backgroundLayer() {
    return this._editor !== null ? this._editor.backgroundLayer : null;
  }

  /** The overlay layer — host-fillable element in front of the text. */
  get overlayLayer() {
    return this._editor !== null ? this._editor.overlayLayer : null;
  }

  /** The scroll root (the `.editor` element) — read-only, for a companion
   *  view (e.g. the minimap) to observe scroll and read geometry without
   *  reaching into `createEditorView`'s closures. */
  get scrollElement() {
    return this._editor !== null ? this._editor.element : null;
  }

  /** The editor's whole-buffer per-line highlight runs (`Run[][]`), or null
   *  if it hasn't highlighted yet / is degraded. Shared with the minimap so
   *  it paints accurate token colours (tree-sitter languages included)
   *  without re-tokenising. */
  lineRuns() {
    return this._editor !== null ? this._editor.lineRuns() : null;
  }

  /** The structural fold scopes (`{startLine, endLine}[]`) of the current
   *  buffer — for the minimap's hover scope-extent highlight. */
  foldScopes() {
    return this._editor !== null ? this._editor.foldScopes() : [];
  }

  /** Toggle the fold whose header contains the cursor. */
  toggleFoldAtPoint() {
    if (this._editor !== null) this._editor.toggleFoldAtPoint();
  }

  /** Toggle the fold at a specific buffer line. */
  toggleFoldAt(line) {
    if (this._editor !== null) this._editor.toggleFoldAt(line);
  }

  /** Fold every foldable scope in the current buffer. */
  foldAll() {
    if (this._editor !== null) this._editor.foldAll();
  }

  /** Unfold every fold in the current buffer. */
  unfoldAll() {
    if (this._editor !== null) this._editor.unfoldAll();
  }

  /** Number of lines actually visible (collapsed by folds). */
  visibleLineCount() {
    return this._editor !== null ? this._editor.visibleLineCount() : 0;
  }

  // --- internal ------------------------------------------------------

  /** Keep the `data-file-path` attribute in sync with the buffer's
   *  filePath. Mirror only — read-only for outside observers; the DOM
   *  panel of DevTools shows what each element is editing without
   *  having to crack open the JS instance. */
  _syncFilePathAttr(buffer) {
    const path = buffer && typeof buffer.filePath === 'string'
      ? buffer.filePath
      : null;
    if (path !== null && path !== '') {
      this.setAttribute('data-file-path', path);
    } else {
      this.removeAttribute('data-file-path');
    }
  }
}

defineViewElement('text-view', TextView);
