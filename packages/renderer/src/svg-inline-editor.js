/**
 * @file The SVG editor's inline label editor — a small positioned
 * overlay with a textarea, used to author / re-edit a node's text or
 * LaTeX in place (replacing the old blocking `window.prompt`).
 *
 * Enter / Tab / click-away commit; Shift+Enter inserts a newline
 * (multi-line plain-text labels); Escape cancels. The editor stops
 * propagation of its keys so canvas tool shortcuts and editor chords
 * don't fire while typing.
 */

export class SvgInlineEditor {
  /**
   * @param {HTMLElement} stage - the positioned stage element the editor
   *   overlays (offsets are relative to its bounding rect).
   */
  constructor(stage) {
    this._stage = stage;
    this._root = null;
    this._textarea = null;
    this._onCommit = null;
    this._onCancel = null;
    this._committed = false;
  }

  get active() {
    return this._root !== null;
  }

  /**
   * Open the editor.
   * @param {object} opts
   * @param {number} opts.screenX - viewport X to anchor at.
   * @param {number} opts.screenY - viewport Y to anchor at.
   * @param {string} [opts.value] - initial source.
   * @param {string} [opts.placeholder]
   * @param {(value: string) => void} opts.onCommit - non-empty commit.
   * @param {() => void} [opts.onCancel] - Escape / empty commit.
   */
  open(opts) {
    this.close();
    const doc = this._stage.ownerDocument;
    const rect = this._stage.getBoundingClientRect();

    this._root = doc.createElement('div');
    this._root.className = 'svg-editor-inline';
    this._root.style.left = `${Math.round(opts.screenX - rect.left)}px`;
    this._root.style.top = `${Math.round(opts.screenY - rect.top)}px`;

    this._textarea = doc.createElement('textarea');
    this._textarea.className = 'svg-editor-inline-input';
    this._textarea.rows = 1;
    this._textarea.value = opts.value ?? '';
    this._textarea.placeholder = opts.placeholder ?? 'text or $math$';
    this._textarea.spellcheck = false;

    this._onCommit = opts.onCommit;
    this._onCancel = opts.onCancel ?? null;
    this._committed = false;

    const hint = doc.createElement('div');
    hint.className = 'svg-editor-inline-hint';
    hint.textContent = '⏎ commit · ⇧⏎ newline · esc cancel';

    this._root.append(this._textarea, hint);
    this._stage.append(this._root);

    this._textarea.addEventListener('keydown', (e) => this._onKeyDown(e));
    // Keep canvas pointer handlers away while editing; a click inside the
    // editor must not start a canvas gesture.
    this._root.addEventListener('pointerdown', (e) => e.stopPropagation());
    this._textarea.addEventListener('blur', () => this._commit());
    this._textarea.addEventListener('input', () => this._autoGrow());

    this._autoGrow();
    this._textarea.focus();
    this._textarea.select();
  }

  _onKeyDown(event) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this._cancel();
    } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault();
      this._commit();
    }
  }

  _autoGrow() {
    const ta = this._textarea;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(200, ta.scrollHeight)}px`;
  }

  _commit() {
    if (!this._root || this._committed) return;
    this._committed = true;
    const value = this._textarea.value;
    const onCommit = this._onCommit;
    const onCancel = this._onCancel;
    this.close();
    if (value.trim() === '') {
      if (onCancel) onCancel();
    } else if (onCommit) {
      onCommit(value);
    }
  }

  _cancel() {
    if (!this._root || this._committed) return;
    this._committed = true;
    const onCancel = this._onCancel;
    this.close();
    if (onCancel) onCancel();
  }

  close() {
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
    this._root = null;
    this._textarea = null;
    this._onCommit = null;
    this._onCancel = null;
  }
}
