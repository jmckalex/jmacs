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
export { createDocView } from './doc-view.js';
export { createHoverDoc } from './hover-doc.js';
export { createInlineEval } from './inline-eval.js';
export { renderMarkdown } from './markdown.js';
export {
  createImageView,
  isImageName,
  mimeTypeForImage,
} from './image-view.js';
export {
  isAudioFileName,
  isVideoFileName,
  mediaUrlForPath,
  mimeTypeForAudio,
  mimeTypeForVideo,
} from './media-view.js';
export { createAudioView, formatDuration } from './audio-view.js';
export { createVideoView } from './video-view.js';
export {
  AUDIO_SUFFIXES,
  ART_FILENAMES,
  createJukeboxView,
  findArt,
  isAudioFile,
  joinPath,
  shufflePermutation,
} from './jukebox-view.js';
export { toLines, selectionRects } from './projection.js';
export { resolveKey, keyEventToString } from './keymap.js';
export { applyIntent, handleKeyEvent } from './commands.js';
export { fuzzyFilter } from './fuzzy.js';
export { createSplitter } from './splitter.js';
export { highlightLine, languageForName } from './highlight.js';
export { splitIntoLineRuns } from './runs.js';
export { createTreeSitterHighlighter } from './treesitter.js';
export {
  registerLanguage,
  registeredLanguages,
  languageForFilename,
  loadLanguageHighlighters,
  clearLanguages,
} from './language-registry.js';
export {
  matchingBracket,
  formBoundsAtPoint,
  formBoundsBeforePoint,
} from './brackets.js';
export { findColourLiterals, normaliseToHex } from './colour-literals.js';
export { openColourPicker } from './colour-picker.js';
export {
  createColourSwatches,
  replaceLiteralInBuffer,
} from './colour-swatches.js';
