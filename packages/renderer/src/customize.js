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

/** Render a Lisp value as a label string for a `:choice` select.
 *  Bare strings pass through; Lisp `Sym` / keyword instances expose a
 *  `name` property (the Lisp dialect's printed form); everything else
 *  falls back to `String(v)`. Without this the dropdown showed
 *  `[object Object]` for every theme option, because `String(sym)`
 *  produces the default object string. */
function asDisplayString(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v.name === 'string') return v.name;
  return String(v);
}

/** Escape a string for use in a CSS attribute selector. The browser
 *  ships `CSS.escape`; in test environments we may not have it, so
 *  fall back to a conservative manual escape. */
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return String(value).replace(/[^\w-]/g, (c) => `\\${c}`);
}

/**
 * Create the customisation view.
 *
 * @param {HTMLElement} container - Where to mount the view.
 * @param {object} [options]
 * @param {(key: string) => boolean} [options.onKey] - Dispatches a key
 *   typed outside a form control, so `C-x b`/`M-x` work here too.
 * @param {(name: string, value: *) => void} [options.applySetting]
 * @param {(name: string, value: *) => void} [options.saveSetting]
 * @param {(name: string) => void} [options.resetSetting]
 * @param {(scope: object) => void} [options.openScope] - Open another
 *   customisation buffer (a subgroup, a variable, a face).
 * @param {(face: string, attr: string, value: *) => void}
 *   [options.setFaceAttribute] - Live-set a face attribute. The
 *   model the next render picks up reflects this immediately.
 * @param {(face: string) => void} [options.resetFace] - Drop the
 *   global override of a face.
 */
function createCustomizeView(container, options = {}) {
  const doc = container.ownerDocument;
  const onKey = typeof options.onKey === 'function' ? options.onKey : null;
  const applySetting = options.applySetting ?? (() => {});
  const saveSetting = options.saveSetting ?? (() => {});
  const resetSetting = options.resetSetting ?? (() => {});
  const openScope = options.openScope ?? (() => {});
  const setFaceAttribute = options.setFaceAttribute ?? (() => {});
  const resetFace = options.resetFace ?? (() => {});

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
      case 'choice': {
        widget = doc.createElement('select');
        // Keep a label → original-option lookup so `read()` returns
        // the *original Lisp value* (typically a Sym) rather than the
        // dropdown's string-only `value`. Without this the apply path
        // quotes the string `"dark"`, which evaluates to a string —
        // and `(eq? *theme* 'dark)` in the theme resolver fails,
        // leaving every choice rendering as the dark theme.
        const optionByLabel = new Map();
        for (const option of setting.options) {
          const label = asDisplayString(option);
          optionByLabel.set(label, option);
          const el = doc.createElement('option');
          el.value = label;
          el.textContent = label;
          if (label === asDisplayString(value)) el.selected = true;
          widget.append(el);
        }
        return {
          widget,
          read: () => optionByLabel.get(widget.value) ?? widget.value,
        };
      }
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
      // B2.3b: the server reset pushes a refreshed model, which re-renders.
    });

    const controls = doc.createElement('div');
    controls.className = 'customize-controls';
    controls.append(widget, reset);

    row.append(head, docEl, controls);
    return row;
  }

  /** Commit every staged edit through `commitFn`. B2.3b: no local re-render — the
   *  server applies the edit and pushes a refreshed model (setState fan-out ->
   *  setBuffer), which clears `staged` and re-renders the panel. Keeping `staged`
   *  until then means the widget keeps showing the just-picked value (no flash to
   *  the old value), and the badge flips edited -> set when the push lands. */
  function commit(commitFn) {
    for (const [name, value] of staged) commitFn(name, value);
  }

  /** Build one face row — name, doc, live swatch, and all the
   *  widgets. Each widget commits immediately (faces are live), so
   *  there's no staging here. */
  function faceRow(face) {
    const row = doc.createElement('div');
    row.className = 'customize-row customize-face-row';
    row.dataset.faceName = face.name;

    const head = doc.createElement('div');
    head.className = 'customize-row-head';
    const name = doc.createElement('span');
    name.className = 'customize-name';
    name.textContent = face.name;
    const badge = doc.createElement('span');
    badge.className = 'customize-state';
    badge.textContent = face.state;
    badge.dataset.state = face.state;
    head.append(name, badge);

    const docEl = doc.createElement('div');
    docEl.className = 'customize-doc';
    docEl.textContent = face.doc;

    // Live swatch — a span styled with the .tok-NAME class so the
    // user can see the current face applied to text. The base face has
    // no .tok- rule, so we preview its typography inline.
    const preview = doc.createElement('div');
    preview.className = 'customize-face-preview';
    const swatch = doc.createElement('span');
    swatch.className = `tok-${face.name}`;
    swatch.textContent = 'Aa Bb Cc 0123';
    if (face.isBase) {
      if (face.size !== '' && face.size != null) {
        swatch.style.fontSize = `${face.size}px`;
      }
      if (face.family) swatch.style.fontFamily = face.family;
    }
    preview.append(swatch);

    const grid = doc.createElement('div');
    grid.className = 'customize-face-grid';

    if (face.isBase) {
      // The base face owns the editor's base typography only — size and
      // family. Every other face inherits these; colours are theme-owned
      // and not set here, so it shows no colour/weight widgets.
      grid.append(
        faceNumberField(face.name, 'size', 'Size (px)', face.size),
      );
      grid.append(
        faceTextField(face.name, 'family', 'Font family', face.family),
      );
    } else {
      // Foreground colour.
      grid.append(
        faceColourField(face.name, 'foreground', 'Foreground', face.foreground),
      );
      // Background colour.
      grid.append(
        faceColourField(face.name, 'background', 'Background', face.background),
      );
      // Weight dropdown.
      grid.append(
        faceChoiceField(face.name, 'weight', 'Weight', face.weight, [
          'normal', 'bold',
        ]),
      );
      // Slant dropdown.
      grid.append(
        faceChoiceField(face.name, 'slant', 'Slant', face.slant, [
          'normal', 'italic',
        ]),
      );
      // Underline / strike-through checkboxes.
      grid.append(
        faceBooleanField(face.name, 'underline', 'Underline', face.underline),
      );
      grid.append(
        faceBooleanField(
          face.name, 'strike-through', 'Strike-through', face.strikeThrough,
        ),
      );
    }

    const reset = doc.createElement('button');
    reset.className = 'customize-reset';
    reset.textContent = 'Reset';
    reset.title = 'Drop overrides for this face';
    reset.addEventListener('click', () => {
      resetFace(face.name);
    });

    const controls = doc.createElement('div');
    controls.className = 'customize-controls';
    controls.append(reset);

    row.append(head, docEl, preview, grid, controls);
    return row;
  }

  /** A labelled colour input that commits on change. Empty value
   *  passes through as an empty string so the resolver falls back
   *  to the default. */
  function faceColourField(faceName, attr, label, value) {
    const field = doc.createElement('label');
    field.className = 'customize-face-field';
    const labelEl = doc.createElement('span');
    labelEl.textContent = label;
    const input = doc.createElement('input');
    input.type = 'color';
    input.value = value && value.startsWith('#') ? value : '#000000';
    input.addEventListener('change', () => {
      setFaceAttribute(faceName, attr, input.value);
    });
    field.append(labelEl, input);
    return field;
  }

  /** A labelled select. */
  function faceChoiceField(faceName, attr, label, value, options) {
    const field = doc.createElement('label');
    field.className = 'customize-face-field';
    const labelEl = doc.createElement('span');
    labelEl.textContent = label;
    const select = doc.createElement('select');
    for (const opt of options) {
      const el = doc.createElement('option');
      el.value = opt;
      el.textContent = opt;
      if (opt === value) el.selected = true;
      select.append(el);
    }
    select.addEventListener('change', () => {
      setFaceAttribute(faceName, attr, select.value);
    });
    field.append(labelEl, select);
    return field;
  }

  /** A labelled checkbox. */
  function faceBooleanField(faceName, attr, label, value) {
    const field = doc.createElement('label');
    field.className = 'customize-face-field customize-face-boolean';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.checked = value === true;
    input.addEventListener('change', () => {
      setFaceAttribute(faceName, attr, input.checked);
    });
    const labelEl = doc.createElement('span');
    labelEl.textContent = label;
    field.append(input, labelEl);
    return field;
  }

  /** A labelled numeric input (e.g. font size in px). An empty value is
   *  left as inherit — no override is committed; use Reset to clear an
   *  existing override. A number commits immediately (faces are live). */
  function faceNumberField(faceName, attr, label, value) {
    const field = doc.createElement('label');
    field.className = 'customize-face-field customize-face-number';
    const labelEl = doc.createElement('span');
    labelEl.textContent = label;
    const input = doc.createElement('input');
    input.type = 'number';
    input.min = '6';
    input.max = '48';
    input.step = '1';
    input.value = value === '' || value == null ? '' : String(value);
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (v === '') return; // inherit; Reset clears an override
      setFaceAttribute(faceName, attr, v);
    });
    field.append(labelEl, input);
    return field;
  }

  /** A labelled text input (e.g. a CSS font-family stack). Empty commits
   *  as an empty override, which falls back to the inherited value. */
  function faceTextField(faceName, attr, label, value) {
    const field = doc.createElement('label');
    field.className = 'customize-face-field customize-face-text';
    const labelEl = doc.createElement('span');
    labelEl.textContent = label;
    const input = doc.createElement('input');
    input.type = 'text';
    input.value = value ?? '';
    input.addEventListener('change', () => {
      setFaceAttribute(faceName, attr, input.value);
    });
    field.append(labelEl, input);
    return field;
  }

  /** Render the view for the current buffer's scope. PRESERVESCROLL keeps the
   *  current scroll position across the rebuild — an in-place update (toggling a
   *  face checkbox, applying, resetting) must not jump back to the top. A fresh
   *  buffer renders at the top (or at `scrollToFace`). */
  function render(preserveScroll = false) {
    // B2.3b: the model is server-computed and pushed in the leaf state
    // (buffer.model); the panel renders ONLY from it. A missing model (not yet
    // pushed) keeps the current DOM rather than blanking — a push will deliver it.
    const model = buffer ? buffer.model : null;
    if (!model) return;
    const prevScroll = preserveScroll ? root.scrollTop : 0;
    root.replaceChildren();

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

    const faces = Array.isArray(model.faces) ? model.faces : [];
    for (const face of faces) root.append(faceRow(face));

    const isEmpty =
      model.settings.length === 0 &&
      model.groups.length === 0 &&
      faces.length === 0;
    if (isEmpty) {
      const empty = doc.createElement('p');
      empty.className = 'customize-note';
      empty.textContent = 'No settings in this group.';
      root.append(empty);
    }

    const footer = doc.createElement('div');
    footer.className = 'customize-footer';
    // Apply / Save / Revert only make sense for staged settings. With
    // a faces-only model the buttons would be confusing; hide them.
    if (model.settings.length > 0) {
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
        render(true);
      });
      footer.append(apply, save, revert);
    }
    root.append(footer);

    // If the model asked to scroll to a face, do so after layout.
    if (model.scrollToFace) {
      const el = root.querySelector(
        `[data-face-name="${cssEscape(model.scrollToFace)}"]`
      );
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'start' });
      }
    } else {
      // Restore the pre-render scroll: 0 for a fresh buffer, the live position
      // for an in-place re-render.
      root.scrollTop = prevScroll;
    }
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

// -----------------------------------------------------------------------
// `<customize-view>` — the custom-element wrapper around the factory
// above. Phase 3d of `plans/VIEWS-AS-CUSTOM-ELEMENTS.md`. Same pattern
// as AudioView / VideoView.

import { defineViewElement, ViewElement } from './view-elements.js';

/** @typedef {object} CustomizeViewOptions
 *  Same options bag the factory accepts — see `createCustomizeView`. */

export class CustomizeView extends ViewElement {
  constructor() {
    super();
    /** @type {ReturnType<typeof createCustomizeView> | null} */
    this._inner = null;
    /** @type {CustomizeViewOptions | null} */
    this._options = null;
    this._pendingBuffer = null;
  }

  configure(options) {
    if (this._inner !== null) {
      throw new Error(
        'CustomizeView.configure: cannot reconfigure after mount'
      );
    }
    this._options = options ?? null;
  }

  get kind() { return 'customize'; }

  setBuffer(buffer) {
    this._pendingBuffer = buffer;
    if (this._inner !== null) this._inner.setBuffer(buffer);
  }

  focus() {
    if (this._inner !== null) this._inner.focus();
    else super.focus();
  }

  connectedCallback() {
    if (this._inner !== null) return;
    this._inner = createCustomizeView(this, this._options ?? {});
    if (this._pendingBuffer !== null) this._inner.setBuffer(this._pendingBuffer);
  }

  disconnectedCallback() {
    /* intentionally empty */
  }

  destroy() {
    this._inner = null;
    this._pendingBuffer = null;
    // The inner factory doesn't expose its own destroy(); the inner DOM
    // disappears when the wrapper is detached + garbage-collected.
  }
}

defineViewElement('customize-view', CustomizeView);
