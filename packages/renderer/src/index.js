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
export {
  boolAttr,
  defineViewElement,
  numAttr,
  setBoolAttr,
  strAttr,
} from './view-elements.js';
export { TextView } from './text-view.js';
export { TablineView } from './tabline-view.js';
export { createTabline } from './tabline.js';
export { CustomizeView } from './customize.js';
export { DocView } from './doc-view.js';
export { createHoverDoc } from './hover-doc.js';
export { createInlineEval } from './inline-eval.js';
export { renderMarkdown } from './markdown.js';
export {
  parseCitations, formatBibliography, formatCitation, citationKeys,
  citationEntries, formatBibliographyEntries, splitBibliographyEntries,
  registerCslStyle,
} from './citation.js';
export {
  ImageView,
  isImageName,
  mimeTypeForImage,
} from './image-view.js';
export {
  PdfView,
  isPdfName,
  mimeTypeForPdf,
} from './pdf-view.js';
export {
  isAudioFileName,
  isVideoFileName,
  mediaUrlForPath,
  mimeTypeForAudio,
  mimeTypeForVideo,
} from './media-view.js';
export { AudioView, formatDuration } from './audio-view.js';
export { VideoView } from './video-view.js';
export { BrowserView, normaliseUrl } from './browser-view.js';
export {
  DirectoryTreeView,
  iconClassForFile,
} from './directory-tree-view.js';
export {
  DirectoryColumnsView,
} from './directory-columns-view.js';
export { ShellView } from './shell-view.js';
export { GnuplotView } from './gnuplot-view.js';
export { createHistory } from './gnuplot-history.js';
export {
  NotebookView,
  serializeCells,
  cellsFromSource,
  topLevelForms,
  shouldForwardChord,
  badgeForState,
  moveItem,
} from './notebook-view.js';
export { ViewListView, kindLabel, fileLabel } from './view-list-view.js';
export {
  createReftexSelectPanel,
  mapReftexKey,
  groupHeading,
  filterCandidates,
  distinctTypes,
  groupByType,
  nextTypeFilter,
} from './reftex-select-panel.js';
export { PlaceholderView } from './placeholder-view.js';
export {
  PLACEHOLDER_ACTIONS,
  DEFAULT_PLACEHOLDER_ACTION,
  resolvePlaceholderAction,
  cloneTargetForKind,
  isPlaceholderView,
} from './placeholder-actions.js';
export {
  AUDIO_SUFFIXES,
  ART_FILENAMES,
  JukeboxView,
  findArt,
  isAudioFile,
  joinPath,
  shufflePermutation,
} from './jukebox-view.js';
export {
  toLines,
  selectionRects,
  cursorPositions,
  visualColumn,
  charIndexAtVisualColumn,
} from './projection.js';
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
export {
  scanMathSegments,
  segmentsFromNodeRanges,
  pointInsideSegment,
  segmentContainingPoint,
  isEmptyBody,
  LATEX_MATH_CONFIG,
  MARKDOWN_MATH_CONFIG,
  MATH_ENVIRONMENT_NAMES,
} from './math-segments.js';
export {
  MATH_PREVIEW_CONFIGS,
  providerForConfig,
  mathPreviewProviderForMode,
} from './math-preview-providers.js';
export {
  typesetMath,
  isMathJaxReady,
  whenMathJaxReady,
  cacheKey,
  createMathCache,
  typesetCached,
} from './typeset-math.js';
export {
  computeMathLayout,
  rangeRevealedByAnyCursor,
  spliceInlineWidgets,
} from './math-layout.js';
export {
  createMathPreview,
  createLatexMathPreview,
  planSegments,
  detectLeave,
} from './math-preview.js';
