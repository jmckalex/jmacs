/**
 * @file The SVG editor's properties panel — a sidebar that reflects the
 * current selection and applies live edits.
 *
 * The panel is generic: it renders input rows from the pure descriptor
 * schema (svg-properties.js) for the selected element's kind. Reading
 * uses attribute maps per descriptor `target` (self / border / content);
 * writing routes each patch back through the view (`applyProperty`),
 * which owns undo snapshots, marker resolution and node rebuilds.
 */

import {
  kindOfShape,
  propertiesForKind,
} from './svg-properties.js';

/** Attribute map of an element (plain object, for the pure descriptors). */
function attrMap(el) {
  const map = {};
  if (el && el.attributes) {
    for (const a of Array.from(el.attributes)) map[a.name] = a.value;
  }
  return map;
}

/** Resolve a descriptor target to a concrete element of the selection. */
export function resolveTarget(el, target) {
  if (target === 'border') return el.querySelector('[data-godot-role="border"]');
  if (target === 'content') return el.querySelector('[data-godot-role="content"]');
  return el;
}

export class SvgPropertiesPanel {
  /**
   * @param {HTMLElement} container - the sidebar element to render into.
   * @param {object} view - the hosting svg-editor-view.
   */
  constructor(container, view) {
    this._container = container;
    this._view = view;
    this._gestured = new Set(); // descriptor keys mid-gesture (undo taken)
  }

  /** Rebuild the panel from the current selection. */
  refresh() {
    const doc = this._container.ownerDocument;
    this._container.replaceChildren();
    this._gestured.clear();
    const sel = this._view.selectionList();

    const title = doc.createElement('div');
    title.className = 'svg-editor-props-title';
    this._container.append(title);

    if (sel.length === 0) {
      title.textContent = 'Properties';
      const hint = doc.createElement('div');
      hint.className = 'svg-editor-props-hint';
      hint.textContent = 'Select an object to edit its properties.';
      this._container.append(hint);
      return;
    }
    if (sel.length > 1) {
      title.textContent = `${sel.length} objects`;
      this._buttonRow(doc, 'Align', [
        ['⇤', 'align left edges', () => this._view.alignSelection('left')],
        ['⇹', 'align horizontal centres', () => this._view.alignSelection('centerX')],
        ['⇥', 'align right edges', () => this._view.alignSelection('right')],
      ]);
      this._buttonRow(doc, '', [
        ['⤒', 'align top edges', () => this._view.alignSelection('top')],
        ['⇳', 'align vertical centres', () => this._view.alignSelection('centerY')],
        ['⤓', 'align bottom edges', () => this._view.alignSelection('bottom')],
      ]);
      this._buttonRow(doc, 'Spread', [
        ['↔', 'distribute horizontally (needs 3+)', () => this._view.distributeSelection('x')],
        ['↕', 'distribute vertically (needs 3+)', () => this._view.distributeSelection('y')],
      ]);
      this._buttonRow(doc, 'Group', [
        ['Group (M-g)', 'group into one object', () => this._view.groupSelection()],
      ]);
      return;
    }

    const el = sel[0];
    const kind = kindOfShape(el.getAttribute('data-godot-shape'), el.tagName);
    title.textContent = this._kindLabel(kind);

    if (kind === 'group') {
      this._buttonRow(doc, '', [
        ['Ungroup (M-S-g)', 'dissolve the group', () => this._view.ungroupSelection()],
      ]);
    }

    // A label-bearing object gets an edit affordance up top.
    if (kind === 'node' || kind === 'math' || kind === 'text') {
      const btn = doc.createElement('button');
      btn.className = 'svg-editor-props-edit-label';
      btn.textContent = 'Edit label…';
      btn.addEventListener('click', () => this._view.openLabelEditor(el));
      this._container.append(btn);
    }

    for (const desc of propertiesForKind(kind)) {
      const target = resolveTarget(el, desc.target);
      if (!target) continue; // e.g. a node with border 'none' has no border child
      this._container.append(this._row(doc, el, desc, target));
    }
  }

  _kindLabel(kind) {
    const labels = {
      rect: 'Rectangle',
      ellipse: 'Ellipse',
      line: 'Line',
      path: 'Path',
      text: 'Text',
      math: 'Math',
      node: 'Node',
      group: 'Group',
      shape: 'Shape',
      opaque: 'Object',
    };
    return labels[kind] ?? 'Object';
  }

  /** A labelled row of small action buttons. */
  _buttonRow(doc, label, buttons) {
    const row = doc.createElement('div');
    row.className = 'svg-editor-props-row';
    const name = doc.createElement('span');
    name.className = 'svg-editor-props-label';
    name.textContent = label;
    row.append(name);
    const wrap = doc.createElement('span');
    wrap.className = 'svg-editor-props-buttons';
    for (const [text, title, fn] of buttons) {
      const btn = doc.createElement('button');
      btn.className = 'svg-editor-props-btn';
      btn.textContent = text;
      btn.title = title;
      btn.addEventListener('click', fn);
      wrap.append(btn);
    }
    row.append(wrap);
    this._container.append(row);
  }

  _row(doc, el, desc, target) {
    const row = doc.createElement('label');
    row.className = 'svg-editor-props-row';
    const name = doc.createElement('span');
    name.className = 'svg-editor-props-label';
    name.textContent = desc.label;
    row.append(name);

    const current = desc.get(attrMap(target));
    // One undo snapshot per gesture: the first input/change of a key takes
    // it; the gesture ends on the final 'change' so the next drag snapshots
    // again.
    const commit = (value, isFinal) => {
      this._view.applyProperty(el, desc, value, {
        takeUndo: !this._gestured.has(desc.key),
      });
      this._gestured.add(desc.key);
      if (isFinal) this._gestured.delete(desc.key);
    };

    let input;
    switch (desc.type) {
      case 'color': {
        const wrap = doc.createElement('span');
        wrap.className = 'svg-editor-props-color';
        input = doc.createElement('input');
        input.type = 'color';
        const isNone = current === 'none' || current === '';
        input.value = this._hexOf(current, target, desc);
        input.disabled = isNone && desc.allowNone;
        input.addEventListener('input', () => commit(input.value, false));
        input.addEventListener('change', () => commit(input.value, true));
        wrap.append(input);
        if (desc.allowNone) {
          const noneWrap = doc.createElement('span');
          noneWrap.className = 'svg-editor-props-none';
          const none = doc.createElement('input');
          none.type = 'checkbox';
          none.checked = isNone;
          none.addEventListener('change', () => {
            input.disabled = none.checked;
            commit(none.checked ? 'none' : input.value, true);
          });
          const tag = doc.createElement('span');
          tag.textContent = 'none';
          noneWrap.append(none, tag);
          wrap.append(noneWrap);
        }
        row.append(wrap);
        return row;
      }
      case 'number': {
        input = doc.createElement('input');
        input.type = 'number';
        input.min = String(desc.min);
        input.max = String(desc.max);
        input.step = String(desc.step);
        input.value = String(current);
        input.addEventListener('change', () => commit(input.value, true));
        break;
      }
      case 'range': {
        input = doc.createElement('input');
        input.type = 'range';
        input.min = String(desc.min);
        input.max = String(desc.max);
        input.step = String(desc.step);
        input.value = String(current);
        input.addEventListener('input', () => commit(input.value, false));
        input.addEventListener('change', () => commit(input.value, true));
        break;
      }
      case 'select': {
        input = doc.createElement('select');
        for (const opt of desc.options) {
          const o = doc.createElement('option');
          o.value = opt;
          o.textContent = opt;
          if (opt === current) o.selected = true;
          input.append(o);
        }
        if (!desc.options.includes(current)) {
          const o = doc.createElement('option');
          o.value = current;
          o.textContent = String(current);
          o.selected = true;
          input.append(o);
        }
        input.addEventListener('change', () => commit(input.value, true));
        break;
      }
      case 'checkbox': {
        input = doc.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(current);
        input.addEventListener('change', () => commit(input.checked, true));
        break;
      }
      default:
        return row;
    }
    row.append(input);
    return row;
  }

  /**
   * A colour input needs a #rrggbb value; resolve named / rgb() colours
   * through the live computed style so the swatch reflects reality.
   */
  _hexOf(value, target, desc) {
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
    if (/^#[0-9a-fA-F]{3}$/.test(value)) {
      return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
    }
    if (value === 'none' || value === '') return '#000000';
    try {
      const win = target.ownerDocument.defaultView;
      const probe = target.ownerDocument.createElement('div');
      probe.style.color = value;
      target.ownerDocument.body.append(probe);
      const rgb = win.getComputedStyle(probe).color;
      probe.remove();
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
      if (m) {
        const hex = (n) => Number(n).toString(16).padStart(2, '0');
        return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
      }
    } catch {
      /* fall through */
    }
    return '#000000';
  }
}
