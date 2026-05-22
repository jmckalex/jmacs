/**
 * @file The customisation view — the view a `customize`-kind buffer is
 * shown through. A buffer has a kind; the host mounts the matching
 * view (text buffers → the editor view, a customisation buffer → this).
 *
 * It renders the customisation registry as real HTML form controls: a
 * buffer scoped to a group shows that group's subgroups and settings.
 * Editing a widget *stages* a change; Apply commits staged changes for
 * the session, Apply and Save also persists them — the Emacs Set /
 * Save model, where a setting can change without persisting.
 *
 * The view is decoupled from the Lisp: it receives a plain-data model
 * and reports changes through callbacks.
 */

import { keyEventToString } from './keymap.js';

/** Tags whose own keyboard handling must not be hijacked. */
const FORM_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);

/** A bare modifier press is not a key in its own right. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/**
 * Create the customisation view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(key: string) => boolean} [options.onKey] - Dispatches a key
 *   typed outside a form control, so `C-x b`/`M-x` work here too.
 * @param {(scope: object) => (object | null)} [options.getModel] -
 *   The model for a buffer's scope: `{title, doc, parent, groups,
 *   settings}`.
 * @param {(name: string, value: *) => void} [options.applySetting]
 * @param {(name: string, value: *) => void} [options.saveSetting]
 * @param {(name: string) => void} [options.resetSetting]
 * @param {(scope: object) => void} [options.openScope] - Open another
 *   customisation buffer (a subgroup, a variable).
 */
export function createCustomizeView(container, options = {}) {
  const doc = container.ownerDocument;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const getModel = options.getModel ?? (() => null);
  const applySetting = options.applySetting ?? (() => {});
  const saveSetting = options.saveSetting ?? (() => {});
  const resetSetting = options.resetSetting ?? (() => {});
  const openScope = options.openScope ?? (() => {});

  const root = doc.createElement('div');
  root.className = 'customize';
  root.tabIndex = 0;
  container.append(root);

  root.addEventListener('keydown', (event) => {
    if (MODIFIERS.has(event.key)) return;
    if (FORM_TAGS.has(event.target.tagName)) return;
    if (onKey && onKey(keyEventToString(event))) event.preventDefault();
  });

  /** The customisation buffer currently shown. */
  let buffer = null;
  /** name -> a staged-but-not-yet-applied value. */
  const staged = new Map();

  /** A typed form widget for a setting, and how to read its value. */
  function makeWidget(setting) {
    const value = staged.has(setting.name)
      ? staged.get(setting.name)
      : setting.value;
    let widget;
    switch (setting.type) {
      case 'boolean':
        widget = doc.createElement('input');
        widget.type = 'checkbox';
        widget.checked = value === true;
        return { widget, read: () => widget.checked };
      case 'integer':
        widget = doc.createElement('input');
        widget.type = 'number';
        widget.value = String(value ?? 0);
        return { widget, read: () => Number(widget.value) };
      case 'colour':
        widget = doc.createElement('input');
        widget.type = 'color';
        widget.value = typeof value === 'string' ? value : '#000000';
        return { widget, read: () => widget.value };
      case 'text':
        widget = doc.createElement('textarea');
        widget.rows = 3;
        widget.value = value == null ? '' : String(value);
        return { widget, read: () => widget.value };
      case 'choice':
        widget = doc.createElement('select');
        for (const option of setting.options) {
          const el = doc.createElement('option');
          el.value = String(option);
          el.textContent = String(option);
          if (String(option) === String(value)) el.selected = true;
          widget.append(el);
        }
        return { widget, read: () => widget.value };
      default:
        widget = doc.createElement('input');
        widget.type = 'text';
        widget.value = value == null ? '' : String(value);
        return { widget, read: () => widget.value };
    }
  }

  /** Build one setting's row. */
  function settingRow(setting) {
    const row = doc.createElement('div');
    row.className = 'customize-row';

    const head = doc.createElement('div');
    head.className = 'customize-row-head';
    const name = doc.createElement('span');
    name.className = 'customize-name';
    name.textContent = setting.name;
    const badge = doc.createElement('span');
    badge.className = 'customize-state';
    const state = staged.has(setting.name) ? 'edited' : setting.state;
    badge.textContent = state;
    badge.dataset.state = state;
    head.append(name, badge);

    const docEl = doc.createElement('div');
    docEl.className = 'customize-doc';
    docEl.textContent = setting.doc;

    const { widget, read } = makeWidget(setting);
    widget.className = 'customize-widget';
    const markEdited = () => {
      staged.set(setting.name, read());
      badge.textContent = 'edited';
      badge.dataset.state = 'edited';
    };
    widget.addEventListener('input', markEdited);
    widget.addEventListener('change', markEdited);

    const reset = doc.createElement('button');
    reset.className = 'customize-reset';
    reset.textContent = 'Reset';
    reset.addEventListener('click', () => {
      resetSetting(setting.name);
      staged.delete(setting.name);
      render();
    });

    const controls = doc.createElement('div');
    controls.className = 'customize-controls';
    controls.append(widget, reset);

    row.append(head, docEl, controls);
    return row;
  }

  /** Commit every staged edit through `commitFn`, then re-render. */
  function commit(commitFn) {
    for (const [name, value] of staged) commitFn(name, value);
    staged.clear();
    render();
  }

  /** Render the view for the current buffer's scope. */
  function render() {
    root.replaceChildren();
    const model = buffer ? getModel(buffer.scope) : null;
    if (!model) return;

    if (model.parent) {
      const back = doc.createElement('button');
      back.className = 'customize-back';
      back.textContent = `← ${model.parent}`;
      back.addEventListener('click', () => openScope({ group: model.parent }));
      root.append(back);
    }

    const title = doc.createElement('h1');
    title.className = 'customize-title';
    title.textContent = model.title;
    root.append(title);
    if (model.doc) {
      const intro = doc.createElement('p');
      intro.className = 'customize-note';
      intro.textContent = model.doc;
      root.append(intro);
    }

    if (model.groups.length > 0) {
      const groups = doc.createElement('div');
      groups.className = 'customize-groups';
      for (const group of model.groups) {
        const link = doc.createElement('button');
        link.className = 'customize-group-link';
        link.textContent = group.doc
          ? `${group.name} — ${group.doc}`
          : group.name;
        link.addEventListener('click', () =>
          openScope({ group: group.name })
        );
        groups.append(link);
      }
      root.append(groups);
    }

    for (const setting of model.settings) root.append(settingRow(setting));

    if (model.settings.length === 0 && model.groups.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'customize-note';
      empty.textContent = 'No settings in this group.';
      root.append(empty);
    }

    const footer = doc.createElement('div');
    footer.className = 'customize-footer';
    const apply = doc.createElement('button');
    apply.textContent = 'Apply';
    apply.title = 'Apply staged changes for this session';
    apply.addEventListener('click', () => commit(applySetting));
    const save = doc.createElement('button');
    save.textContent = 'Apply and Save';
    save.title = 'Apply staged changes and persist them';
    save.addEventListener('click', () => commit(saveSetting));
    const revert = doc.createElement('button');
    revert.textContent = 'Revert';
    revert.title = 'Discard staged changes';
    revert.addEventListener('click', () => {
      staged.clear();
      render();
    });
    footer.append(apply, save, revert);
    root.append(footer);
  }

  /** Render the view for a customisation buffer. */
  function setBuffer(next) {
    buffer = next;
    staged.clear();
    render();
  }

  return {
    element: root,
    setBuffer,
    focus: () => root.focus(),
  };
}
