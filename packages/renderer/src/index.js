/**
 * @file Layer 4 — public entry point.
 *
 * The renderer projects L2 buffer state into the DOM and turns keyboard
 * input into editing commands. It never mutates the buffer directly
 * except through the buffer's own command methods.
 */

export { createEditorView } from './view.js';
export { createReplView } from './repl.js';
export {
  createMarkdownPreview,
  PREVIEW_DEBOUNCE_MS,
} from './markdown-preview.js';
export { createMinibuffer } from './minibuffer.js';
export { createCustomizeView } from './customize.js';
export {
  createImageView,
  isImageName,
  mimeTypeForImage,
} from './image-view.js';
export { toLines, selectionRects } from './projection.js';
export { resolveKey, keyEventToString } from './keymap.js';
export { applyIntent, handleKeyEvent } from './commands.js';
export { fuzzyFilter } from './fuzzy.js';
export { highlightLine, languageForName } from './highlight.js';
export { splitIntoLineRuns } from './runs.js';
export {
  createJavaScriptHighlighter,
  createHtmlHighlighter,
  createPythonHighlighter,
} from './treesitter.js';
export { matchingBracket } from './brackets.js';
