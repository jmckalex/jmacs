/**
 * @file A documentation panel for the utility dock. It wraps a PRIVATE
 * `<doc-view>` element — minted here and mounted once. A custom view element
 * re-runs its `connectedCallback` (and can lose state) when reparented, so the
 * panel never moves it; the dock only shows/hides the panel and removes it on
 * close. This is why we do NOT reuse a shared singleton doc-view.
 *
 * Content is pre-built HTML (the host's doc pages / rendered docstrings). The
 * doc-view's own behaviour is reused as-is: `[data-godot-doc]` cross-links call
 * `openDoc(name)`, `q` calls `closeBuffer`, other chords go through `onKey`.
 *
 * The panel is non-modal: the doc-view owns its keys via its own keydown
 * listener while focused, and the editor keeps its chords otherwise.
 */

/**
 * Create a doc panel.
 *
 * @param {object} [options]
 * @param {Document} [options.document]
 * @param {string} [options.html] - The pre-built page HTML to show.
 * @param {string} [options.title] - Tab label.
 * @param {string} [options.icon]
 * @param {(key: string) => boolean} [options.onKey]
 * @param {() => void} [options.closeBuffer] - Called on `q` (close the tab).
 * @param {(name: string) => void} [options.openDoc] - Cross-link navigation.
 * @param {(text: string, language: string) => *} [options.highlightCode]
 * @returns {object} the utility-panel contract + `setHtml`.
 */
export function createDocPanel(options = {}) {
  const doc = options.document ?? globalThis.document;

  const docEl = /** @type {*} */ (doc.createElement('doc-view'));
  docEl.configure({
    onKey: options.onKey,
    closeBuffer: options.closeBuffer,
    openDoc: options.openDoc,
    highlightCode: options.highlightCode,
    manifest: options.manifest ?? null,
  });
  docEl.setBuffer({ kind: 'doc', html: options.html ?? '' });

  return {
    element: docEl,
    title: options.title ?? 'Doc',
    icon: options.icon ?? 'fa-solid fa-book-open',
    modal: false,
    closable: true,
    /** Replace the rendered page, reusing the same tab (in-place nav). */
    setHtml: (html) => docEl.setBuffer({ kind: 'doc', html: html ?? '' }),
    /** Replace the navigation tree (once the manifest has loaded). */
    setManifest: (manifest) => docEl.setManifest(manifest),
    focus: () => {
      if (typeof docEl.focus === 'function') docEl.focus();
    },
    handleKey: () => false,
    destroy: () => {
      if (typeof docEl.destroy === 'function') docEl.destroy();
      docEl.remove();
    },
  };
}
