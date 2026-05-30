/**
 * @file View — public entry point.
 *
 * A View is the addressable on-screen thing. Each pane (in a later
 * phase, an OS window's pane tree) holds exactly one view.
 *
 * Text-editing views wrap an L2 buffer; non-text views (image, jukebox,
 * audio, video, shell, directory-tree, directory-columns, customize,
 * doc, tabline) hold their own state and have no buffer. Each kind has
 * its own custom HTMLElement (`<text-view>`, `<image-view>`, …) in the
 * renderer package; this package only owns the buffer-less view model.
 */

export {
  createView,
  isView,
  isTablineView,
  tablineActiveChild,
} from './view.js';

export {
  viewFilePath,
} from './view-utils.js';
