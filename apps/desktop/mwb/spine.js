/**
 * @file Model-B command spine — the server-side command surface.
 *
 * This is the next slice after render-from-mirror (architect-notes.md
 * 2026-06-22 11:00): make the prototype a genuinely usable single-window
 * editor *through the server*. The render half was proven a drop-in (zero
 * view.js changes); the cost was said to live in the **model/command
 * half**. This module pays down the thinnest real slice of that half.
 *
 * What it does: stands up the REAL command machinery server-side —
 *   - a REAL L2 buffer (@editor/buffer) wrapped in a REAL view
 *     (@editor/view), gathered into a `session` whose `currentView` is
 *     that view (the exact shape `createBufferPrimitives` expects);
 *   - the REAL buffer primitives (`createBufferPrimitives` from
 *     @editor/stdlib) — `insert!`, `delete-backward!`, `cursor-*!`,
 *     `point`, `mark`, `goto!`, `set-mark!`, … unchanged from production;
 *   - the REAL command system + editing commands, loaded verbatim from
 *     disk: `commands.lisp` (`defcommand`/`run-command`/the interactive
 *     gatherer + minibuffer continuation) and `editing.lisp` (motion +
 *     editing commands written against those primitives);
 *   - a focused keymap + `handle-key` dispatch in the same shape as the
 *     production `keymap.lisp` (prefix chords, self-insert fallthrough),
 *     wired to the real `run-command`;
 *   - the host primitives the spine needs that would otherwise be
 *     renderer/pixel concerns — `show-status!`, `clear-status!`,
 *     `open-minibuffer!`, `recenter!`, `goto-line!`, `replace-all!` — each
 *     turned into a server-side effect that the caller surfaces to the
 *     client as a view-update (the modeline/status/minibuffer state) or a
 *     down-channel scroll request.
 *
 * It is DOM-free and Electron-free: it takes plain callbacks for its
 * outward effects (status changes, minibuffer prompts, scroll requests),
 * so it is unit-testable under `node --test` with no harness (see
 * spine.test.js). `server.js` wires those callbacks to the wire.
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInterpreter, NIL, cons, listToArray, arrayToList, keyword } from '@editor/lisp';
import { createBuffer } from '@editor/buffer';
import { createView } from '@editor/view';
import { createBufferPrimitives, createLatexPrimitives } from '@editor/stdlib';

import { renderModeline, screenfulStep } from './protocol.js';
import { createBufferRegistry } from './buffer-registry.js';
import { createDataSourceRegistry } from './data-source.js';
// Bookmarks graduate to the server: the SAME engine the in-renderer app runs
// (pure / Node-safe — markers + context-relocate, no DOM), one instance per
// buffer entry. The outline's structural ops (indent/outdent) + document-order
// sort are the renderer view's pure helpers, reused server-side so a port stays
// byte-identical. See bookmarks.lisp + apps/desktop/src/bookmarks.js.
import { createBookmarks } from '../src/bookmarks.js';
import {
  indent as outlineIndent,
  outdent as outlineOutdent,
  sortByDocumentPosition,
} from '../../../packages/renderer/src/bookmark-outline.js';
import { createPaneModel } from './pane-model.js';
import { createCitationPrimitives } from './citation-bridge.js';

const here = dirname(fileURLToPath(import.meta.url));
const STDLIB_DIR = join(here, '..', '..', '..', 'packages', 'stdlib', 'lisp');

/** The bare name of a Lisp symbol/keyword/string argument (a Sym and a
 *  Keyword both carry a `.name`), with any leading `:` stripped, or null when
 *  ARG isn't symbol-like. The pane primitives read their orientation/side/
 *  direction args this way (mirrors app.js's `symbolNameOf`). */
function symName(arg) {
  let name = null;
  if (typeof arg === 'string') name = arg;
  else if (arg && typeof arg === 'object' && typeof arg.name === 'string') {
    name = arg.name;
  }
  if (name === null) return null;
  return name.startsWith(':') ? name.slice(1) : name;
}

/** Coerce a Lisp value to a JS display string: a string passes through, a
 *  keyword/symbol yields its (colon-stripped) name, NIL/nil/null yields '',
 *  a number stringifies. Used by the RefTeX picker row converters to read
 *  Lisp candidate fields (type keywords, context strings) for the wire. */
function lispString(value) {
  if (value === NIL || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && typeof value.name === 'string') {
    return value.name.startsWith(':') ? value.name.slice(1) : value.name;
  }
  return '';
}

// --- regexp / string search helpers (model-side) ----------------------
//
// The model halves of regex-search.lisp's host primitives. These are pure
// functions over a TEXT string (no buffer, no DOM); the spine's
// `find-regexp-forward` / `find-string-forward` / `replace-regexp-all!`
// primitives drive them against the active buffer's text. They mirror
// app.js's identically-named helpers byte-for-byte (the renderer and the
// server must agree on a match), so a regexp search resolves the SAME way
// in both worlds. Two windows on one buffer cannot legitimately disagree
// about where a pattern matches its text → this is model state. See
// PRIMITIVE-SPLIT.md "Search / regex".

/** A `RegExp` from SOURCE with FLAGS, or null for an empty/invalid source
 *  (a half-typed pattern is a miss, never an error — see app.js). */
function compileRegexpSource(source, flags = 'g') {
  if (source === '') return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/** Expand REPLACEMENT against a regex MATCH array, honouring `$N`, `$&`
 *  and `$$` (the standard JS String.replace replacement semantics). */
function expandReplacement(replacement, match) {
  return replacement.replace(/\$([\d&$])/g, (token, ch) => {
    if (ch === '$') return '$';
    if (ch === '&') return match[0];
    const n = Number(ch);
    const captured = match[n];
    return captured === undefined ? '' : captured;
  });
}

/** The first regexp match in TEXT at or after FROM as `{ start, end }`, or
 *  null. REGEXP must carry the `g` flag (we drive `lastIndex`). */
function regexpForwardMatch(text, regexp, from) {
  regexp.lastIndex = Math.max(0, from);
  const match = regexp.exec(text);
  if (match === null) return null;
  // Skip zero-length matches at the same position; they would loop.
  if (match[0].length === 0) {
    regexp.lastIndex = match.index + 1;
    const retry = regexp.exec(text);
    if (retry === null || retry[0].length === 0) return null;
    return { start: retry.index, end: retry.index + retry[0].length };
  }
  return { start: match.index, end: match.index + match[0].length };
}

/** The last regexp match in TEXT strictly before FROM as `{ start, end }`,
 *  or null (a backward search past a match advances). */
function regexpBackwardMatch(text, regexp, from) {
  regexp.lastIndex = 0;
  const limit = Math.max(0, from);
  let last = null;
  let match;
  while ((match = regexp.exec(text)) !== null) {
    if (match.index >= limit) break;
    last = { start: match.index, end: match.index + match[0].length };
    if (match[0].length === 0) regexp.lastIndex += 1;
  }
  return last;
}

/**
 * The standard-library files the spine loads, in dependency order.
 *
 * Beyond the original command core (`commands.lisp` + `editing.lisp`),
 * this is the **model-heavy slice** the primitive-split proves out (see
 * `mwb/PRIMITIVE-SPLIT.md`): the customisation registry, indent settings,
 * the mode machinery, the kill ring / yank, line operations, the search
 * command stubs, and a real major mode (Markdown). Every file here is
 * loaded **verbatim from disk** — the same source the production editor
 * runs — and depends only on model-side primitives (provided directly
 * below) plus a handful of render-side primitives that the spine
 * routes to a view-update or stubs.
 *
 * NOT yet loaded: the pane/tabline/faces/themes/languages/preview files,
 * which pull in renderer-only primitives (the pane tree, DOM measurement,
 * MathJax, element views) that are render-side slices of their own. See
 * PRIMITIVE-SPLIT.md for the full categorisation.
 *
 * Order matches the relevant prefix of the production STDLIB_FILES:
 * commands → editing → custom → indent → modes → math-preview →
 * kill → yank-pop → line-ops → search → markdown. (`modes.lisp` must
 * precede the mode files; `custom.lisp` must precede `defcustom` users;
 * `math-preview.lisp` defines `math-preview-mode` before `markdown.lisp`
 * references it.)
 */
const SPINE_STDLIB = Object.freeze([
  'commands.lisp',
  'editing.lisp',
  'custom.lisp',
  'indent.lisp',
  'modes.lisp',
  'math-preview.lisp',
  'kill.lisp',
  'yank-pop.lisp',
  'line-ops.lisp',
  // occur.lisp — M-s o: list every line matching a literal substring in a
  // fresh *Occur: PATTERN* buffer. Pure Lisp over buffer-text + new-view! +
  // insert! — under Model B new-view! mints a registry buffer and switches
  // the active client onto it, so the results land in a real server buffer
  // the window sees. Fully model-side. (Production order: after line-ops.)
  'occur.lisp',
  // expand-region.lisp (pure Lisp; defines expand-region-word-bounds) must
  // precede multi-cursor.lisp, which uses it to find the word at point.
  'expand-region.lisp',
  // multi-cursor.lisp — the C-c d / C-c D word-select-and-add commands,
  // written against the model-side multi-cursor primitives (add-selection!,
  // selections, collapse-to-primary!). It rebinds keyboard-quit, so a
  // minimal keyboard-quit is defined in the spine prelude before it loads.
  'multi-cursor.lisp',
  'search.lisp',
  // regex-search.lisp — the regexp / query-replace commands (C-M-s/r,
  // C-M-%, M-%). The two `isearch-regexp-*` starters are render-side
  // (the incremental loop, like plain isearch) and STUBBED; but
  // `replace-regexp` and `query-replace` are FULLY model-side — they
  // walk the buffer text via the model-side regexp/string search +
  // replace primitives (find-regexp-forward/-backward, find-string-
  // forward, replace-regexp-all!, replace-range!), and query-replace's
  // per-match key loop runs through the spine's read-next-key reader.
  // Loads after search.lisp (production order). See PRIMITIVE-SPLIT.md.
  'regex-search.lisp',
  'markdown.lisp',
  // latex.lisp — the base LaTeX writing commands (latex-textbf/textit/
  // emph/math-inline/section/itemize/… + the C-c keymap). FULLY
  // model-side: latex-surround is pure buffer ops (region-active?,
  // region-text, insert!, goto!, delete-backward!). Its deps are all
  // loaded — modes.lisp declares latex-mode + latex-mode-map (which this
  // file fills), and math-preview.lisp defines math-preview-mode (aliased
  // as latex-math-preview-mode). The C-c chord dispatches through the
  // spine's mode-keymap chain (resolveMode). Production order: after
  // markdown.lisp. See PRIMITIVE-SPLIT.md "Modes / latex".
  'latex.lisp',
  // latex-insert.lisp — AUCTeX Phase 2 smart insertion (environment /
  // macro / section / font). The pure ENV-STACK helpers + the model-side
  // commands run server-side; the completion-driven inserts route through
  // the spine's completing-minibuffer (the prompt round-trips; the
  // candidate LIST is the deferred render half). Its RefTeX label-prefix
  // reuse is a SOFT dep (try/catch fallback when reftex is absent), so it
  // loads without reftex. latex-nav + latex-fill reuse its pure env-stack
  // helpers, so it precedes them.
  'latex-insert.lisp',
  // latex-math.lisp — AUCTeX Phase 3 LaTeX-math-mode (math symbol
  // abbreviations). Model-side symbol insertion; the unknown-key fallback
  // opens the completing-minibuffer (stubbed prompt). After latex-insert.
  'latex-math.lisp',
  // latex-nav.lisp — AUCTeX Phase 5 navigation (section next/prev,
  // begin/end matching jump, M-RET insert-item, smart quotes). FULLY
  // model-side (goto!/insert!/set!/show-status!). Reuses latex-insert's
  // innermost-open-env finder, so it loads after it.
  'latex-nav.lisp',
  // latex-fill.lisp — AUCTeX-style LaTeX-fill-paragraph (M-q). FULLY
  // model-side (delete-region!/goto!/insert!/set!/show-status!). Reuses
  // latex-insert's pure env-stack helpers; loads after latex-nav.lisp.
  'latex-fill.lisp',
  // makefile.lisp — Makefile editing commands (target / phony / variable /
  // tab / include + the C-c keymap). FULLY model-side (insert!/goto!/
  // set-mark!), exactly like latex.lisp: modes.lisp declares makefile-mode
  // + makefile-mode-map (which this fills). The C-c chord dispatches via
  // the mode-keymap chain on a Makefile buffer. See PRIMITIVE-SPLIT.md.
  'makefile.lisp',
  // panes.lisp — the interactive split/other/delete-window commands (C-x 2 /
  // 3 / 0 / 1 / o). Loaded VERBATIM: the same source the production editor
  // runs. Its commands wrap host primitives (split-horizontal!, delete-pane!,
  // other-pane!, current-pane, …) that the spine provides server-side against
  // the active client's LOGICAL pane tree (pane-model.js) — no DOM, no pixels.
  // This is the G0a proof: the pane commands graduate with zero Lisp change;
  // only the host primitives differ. Needs custom.lisp (defgroup/defcustom)
  // and commands.lisp (defcommand), both already loaded above.
  'panes.lisp',
  // auto-pair.lisp — automatic matching-bracket / quote insertion. FULLY
  // model-side: it works over point / buffer-substring / insert! / goto! /
  // delete-region! / delete-backward! and a defcustom (*auto-pair*). Its
  // ONE render-coupled line — binding the bracket characters into
  // `the-keymap` (keymap.lisp, not loaded) — is satisfied by the spine's
  // model-side `the-keymap` shim, AND handle-key consults it before
  // self-insert, so typing "(" auto-pairs server-side end-to-end. Loads
  // after panes.lisp; production order is after keymap/multi-cursor/
  // snippets (it only needs the-keymap + custom.lisp, both present).
  'auto-pair.lisp',
  // snippets-parser.lisp — the yasnippet file-format reader + body parser.
  // PURE data-in / data-out (no buffer, no I/O, no host primitives at all),
  // so it loads verbatim with zero glue and its parse-snippet-file /
  // parse-snippet-body run unchanged server-side. snippets.lisp (below)
  // builds the expansion engine on top of it.
  'snippets-parser.lisp',
  // snippets.lisp — the snippet engine: store, expansion, field nav. The
  // ENGINE is fully model-side: -expand-record! / -select-field! /
  // snippet-next-field run over insert!/goto!/set-mark!/add-selection!/
  // collapse-to-primary! (all provided), and mirrors install as a real
  // multi-cursor set (Policy A) — proving multi-cursor + overlays end to
  // end. Its load-time deps are defgroup/defcustom (custom.lisp) + a
  // model-side defface/face shim (prelude). The directory-store reads
  // (snippet-user-directory / list-directory-paths / read-file-text!) are
  // host file-I/O, stubbed to safe empties — but the built-in starter set
  // (*snippet-builtins*, defined in Lisp) still loads, so snippet-insert /
  // snippet-expand work server-side out of the box. Needs
  // expand-region-word-bounds (expand-region.lisp, loaded). See
  // PRIMITIVE-SPLIT.md "Snippets".
  'snippets.lisp',
  // bookmarks.lisp — Emacs-style bookmarks (C-x r m/b/l): a bookmark-minor-mode
  // (default-on in text buffers) + the set / jump / delete / list commands. The
  // commands wrap the host primitives bookmark-set!/jump!/delete! +
  // open-bookmark-view! (provided above), which run the SAME bookmarks.js engine
  // the renderer uses against the server's L2 buffers + markers. Needs modes.lisp
  // (define-mode + register-default-text-minor-mode) + commands.lisp, both loaded.
  'bookmarks.lisp',
  // --- the citation + RefTeX chain (the last model-heavy stdlib family) ---
  // cite.lisp — citation parsing/formatting wrappers over the citation host
  // bridge (citation-parse / -format / -keys, provided by createCitation-
  // Primitives above). Defines load-bibliography / format-bibliography /
  // format-citation + the *citation-style* / *citation-bib-path* defcustoms.
  // Needs custom.lisp (loaded). FULLY model-side: the bridge IS the model.
  'cite.lisp',
  // reftex.lisp — RefTeX R1 multi-file document model + label/section/cite
  // DB. Lisp over the pure host primitives latex-scan / path-resolve /
  // path-dirname / path-basename (createLatexPrimitives) + the impure reads
  // read-file-text! / file-exists? / list-directory-paths + the view verbs
  // current-view / view-list / view-file-path / view-buffer / switch-to-view!
  // (all provided above). It redefines latex-master-file (latex-compile.lisp
  // is not loaded; reftex's definition is the sole one — it calls reftex-
  // master). Loads after latex.lisp (latex-mode) + cite.lisp (bib path).
  'reftex.lisp',
  // reftex-refs.lisp — RefTeX R2 labels & references (reftex-label C-c (,
  // reftex-reference C-c ), reftex-reference-minibuffer). Builds the
  // *RefTeX Select* candidate model and opens it via open-reftex-select!
  // (bridged to the generic PICKER channel below). Extends latex-c-c-map
  // (latex.lisp built it) with ( and ); redefines minibuffer-tab-complete
  // (the spine's pass-through base, defined in the prelude). Loads after
  // reftex.lisp (R1 DB + type helpers).
  'reftex-refs.lisp',
  // reftex-cite.lisp — RefTeX R3 citations (reftex-citation C-c [). The
  // format-first flow: a format menu (open-reftex-cite-format!) then the
  // cite picker (open-reftex-cite-select!) — both bridged to the generic
  // PICKER channel below. Reuses R2's origin bookkeeping + the citation
  // bridge (citation-parse-lenient / -entries / -format-keys / -register-
  // style!). Extends latex-c-c-map with [. Loads after reftex-refs.lisp.
  'reftex-cite.lisp',
]);

/**
 * The keymap: a key-string → command-name table, in the same spirit as
 * production `keymap.lisp` but pared to what the spine exercises. The
 * server's `handle-key` resolves a key here, runs the bound command
 * through the REAL `run-command`, or self-inserts a bare printable.
 *
 * `keyEventToString` names (see reference_key_names): arrows are
 * `left/right/up/down`; `enter`, `backspace`; Meta is Command (`M-…`).
 */
const KEYMAP = Object.freeze({
  // motion
  left: 'backward-char',
  right: 'forward-char',
  up: 'previous-line',
  down: 'next-line',
  'C-a': 'move-beginning-of-line',
  'C-e': 'move-end-of-line',
  'C-f': 'forward-char',
  'C-b': 'backward-char',
  'C-n': 'next-line',
  'C-p': 'previous-line',
  'M-f': 'forward-word',
  'M-b': 'backward-word',
  'M-less': 'beginning-of-buffer',
  'M-greater': 'end-of-buffer',
  // Screenful scroll (editing.lisp scroll-up/scroll-down, loaded verbatim):
  // C-v page-down, M-v page-up. They step point by `(page-lines)` — the host
  // primitive that reads this client's reported VIEWPORT (only the client
  // knows how many lines fit). Moving point makes the client follow-scroll.
  'C-v': 'scroll-up',
  'M-v': 'scroll-down',
  // more motion (editing.lisp, loaded verbatim — pure goto!-based)
  'M-m': 'back-to-indentation', // M-m → first non-blank of the line
  'M-a': 'backward-sentence', // M-a → start of the sentence
  'M-e': 'forward-sentence', // M-e → end of the sentence
  'M-g': 'goto-line', // M-g → read a line number (goto-line! is host-wired)
  // editing
  enter: 'newline',
  backspace: 'delete-backward',
  'C-d': 'delete-forward',
  'C-l': 'recenter',
  // --- more everyday editing (editing.lisp / kill.lisp, loaded verbatim) ---
  // C-o opens a line (insert "\n", leave point before it); C-t transposes the
  // two chars before point. Both are pure point/insert!/delete-region! over
  // the real buffer primitives — no renderer dependency. (keymap.lisp binds
  // these in the production global-map; they were simply not in the spine's
  // pared map yet.)
  'C-o': 'open-line',
  'C-t': 'transpose-chars',
  'M-k': 'kill-sentence', // kill.lisp — kill forward to the sentence end
  'M-q': 'fill-paragraph', // editing.lisp → fill-paragraph! (createBufferPrimitives)
  'M-r': 'replace-string', // editing.lisp → replace-all! (host-wired); minibuffer read
  // C-= grows the active region one structural step (word→line→paragraph→
  // buffer); chains on repeat via *last-command* (which run-command tracks).
  // The `=` key normalises to `C-equal` (event.code "Equal"), per keymap.lisp.
  'C-equal': 'expand-region',
  // --- undo / redo (editing.lisp `undo`/`redo` → `undo!`/`redo!`) -----
  // The L2 undo stack lives with the canonical buffer, so undo through the
  // server reverts the buffer BOTH windows on it see (the Model-B payoff).
  // C-/ is the Emacs undo key; on a US layout `event.code` is `Slash`, so it
  // normalises to `C-slash` (and Emacs's literal C-_ is Shift+Minus →
  // `C-S-minus`). C-x u (the other classic undo binding) is in CX_MAP.
  // Redo: C-S-/ (`C-S-slash`) + M-S-z (`M-S-z`), mirroring keymap.lisp.
  'C-slash': 'undo',
  'C-S-minus': 'undo',
  'C-S-slash': 'redo',
  'M-S-z': 'redo',
  // selection
  'C-space': 'set-mark-command',
  'C-g': 'keyboard-quit',
  // --- kill ring / yank (kill.lisp + yank-pop.lisp) ------------------
  'C-w': 'kill-region',
  'M-w': 'copy-region',
  'C-k': 'kill-line',
  'C-y': 'yank',
  'M-y': 'yank-pop',
  'M-d': 'kill-word',
  'M-backspace': 'backward-kill-word',
  // --- line operations (line-ops.lisp) ------------------------------
  'M-up': 'move-line-up',
  'M-down': 'move-line-down',
  'M-bracketright': 'indent-region', // M-]
  'M-bracketleft': 'outdent-region', // M-[
  // --- search (search.lisp — commands resolve; loop is a host stub) -
  'C-s': 'isearch-forward',
  'C-r': 'isearch-backward',
  // --- highlight all matches (a REAL overlay feature, server-side) ---
  // M-s h highlights every occurrence of the word at point / region as
  // overlays the renderer draws via getDecorations(); M-s u clears them.
  // (Emacs binds highlight-symbol-at-point under M-s h …; we keep the
  // mnemonic.) These prove overlay sync end-to-end.
  'M-s': { h: 'highlight-matches', u: 'unhighlight-all' },
  // command spine entry points
  'M-x': 'execute-extended-command',
});

/**
 * The global `C-c` prefix the spine offers when no MAJOR mode claims it.
 * In a Markdown buffer the mode-keymap chain catches `C-c` first (its
 * `C-c b` etc.), so these only fire in a plain buffer — exactly where
 * production's global `c-c-keymap` holds `C-c d` / `C-c D` (multi-cursor).
 */
const CC_MAP = Object.freeze({
  d: 'add-cursor-next', // multi-cursor.lisp — word-select + add next match
  D: 'select-all-matches', // multi-cursor.lisp — a cursor at every match
});

/**
 * A keymap whose values are themselves keymaps make a key a *prefix*. The
 * `C-x` prefix carries the file + buffer commands. (Production resolves
 * this through nested maps in keymap.lisp; the spine inlines the one
 * prefix it needs.)
 */
const CX_MAP = Object.freeze({
  'C-f': 'find-file',
  'C-s': 'save-buffer',
  'C-w': 'write-file', // save-as: write the buffer to a new path (prompts)
  'C-d': 'duplicate-line', // line-ops.lisp (production binds C-x C-d here)
  'C-j': 'join-line', // line-ops.lisp
  // More of production's C-x map (editing.lisp — pure buffer ops):
  'C-x': 'exchange-point-and-mark', // C-x C-x — swap point and mark
  h: 'mark-whole-buffer', // C-x h — select the whole buffer
  ';': 'comment-line', // C-x ; — comment/uncomment the line (mode comment-prefix)
  // Multi-buffer (production keymap.lisp): C-x b switches buffer (a
  // minibuffer name read, host-completed), C-x C-b lists buffers, C-x k
  // kills the current buffer.
  b: 'switch-to-buffer',
  'C-b': 'list-buffers',
  k: 'kill-buffer',
  u: 'undo', // C-x u — the classic Emacs undo binding (alongside C-/)
  // --- pane/window splits (panes.lisp — the Emacs C-x map) -----------
  // C-x 2 / 3 / 0 / 1 / o drive the REAL panes.lisp commands against the
  // active window's LOGICAL pane tree (pane-model.js). So a key routed
  // through handleKey splits/cycles/deletes panes server-side, the same as
  // a PANE_INTENT does — both paths run the same commands.
  2: 'split-vertical', // C-x 2 — split top/bottom
  3: 'split-horizontal', // C-x 3 — split side-by-side
  0: 'delete-pane', // C-x 0 — delete the focused pane
  1: 'delete-other-panes', // C-x 1 — the focused pane fills the window
  o: 'other-pane', // C-x o — cycle focus to the next pane
  // --- new window (C-x 5 2 — the Emacs make-frame prefix, G4) --------
  // C-x 5 is the frame-command prefix; the spine offers `2` (make a new
  // frame). A nested map makes `5` a prefix. The command's effect is
  // CLIENT-performed (new-window → request-new-window! → WINDOW_NEW →
  // host.newWindow()), so it's window lifecycle, not a buffer edit. (No
  // conflict with C-x 2 = split-vertical: that resolves at the C-x level
  // before this sub-map is entered.)
  5: Object.freeze({ 2: 'new-window' }),
  // --- bookmarks (C-x r prefix — bookmarks.lisp) ---------------------
  // C-x r m set · C-x r b jump · C-x r l open the outline. A nested map makes
  // `r` a prefix (production's keymap.lisp isn't loaded server-side; the spine
  // inlines the bindings it needs, like the C-x 5 frame prefix above).
  r: Object.freeze({
    m: 'bookmark-set',
    b: 'bookmark-jump',
    l: 'list-bookmarks',
  }),
});

/**
 * Create the command spine.
 *
 * @param {object} options
 * @param {string} options.initialText - The buffer's seed text.
 * @param {string} options.name - The buffer/view name (drives the mode/
 *   language client-side and the modeline label).
 * @param {object} effects - Outward effects, wired to the wire by the
 *   server. All optional; default to no-ops.
 * @param {(text: string) => void} [effects.onStatus] - Echo-area message
 *   set (`show-status!`) or cleared (`clear-status!` → '').
 * @param {(prompt: string) => void} [effects.onMinibufferOpen] - A command
 *   asked to read from the minibuffer. The server should show the prompt;
 *   the user's submit/cancel comes back via `deliverMinibuffer`.
 * @param {() => void} [effects.onMinibufferClose] - The minibuffer prompt
 *   resolved (submit or cancel); the client should hide it.
 * @param {(req: object) => void} [effects.onScroll] - A scroll/centering
 *   request the client must execute in pixels (e.g. recenter). The server
 *   decides the line; the client does the pixels (plan §5d).
 * @param {(path: string) => { text: string, name: string, path?: string } | null} [effects.openFile]
 *   - Read a file off disk for find-file. Returns the text + name (+ the
 *   resolved absolute path, so the buffer knows where to save back), or null
 *   on failure. (The server is a Node child, so file I/O is direct —
 *   plan §3 (i).)
 * @param {(req: { path: string, text: string }) => { ok: boolean, error?: string }} [effects.saveFile]
 *   - Write a buffer's text to disk ATOMICALLY (temp file + rename), for
 *   save-buffer / write-file. Returns `{ ok }` or `{ ok:false, error }`. The
 *   spine re-baselines the saved text on success (the dirty flag clears).
 * @returns {Spine}
 */
export function createSpine(options, effects = {}) {
  const onStatus = effects.onStatus ?? (() => {});
  const onMinibufferOpen = effects.onMinibufferOpen ?? (() => {});
  const onMinibufferClose = effects.onMinibufferClose ?? (() => {});
  const onScroll = effects.onScroll ?? (() => {});
  const openFile = effects.openFile ?? (() => null);
  // Write a buffer to disk (atomic). Default to a failure so a save with no
  // host wired reports cleanly rather than silently claiming success.
  const saveFile = effects.saveFile
    ?? (() => ({ ok: false, error: 'no save handler wired' }));
  // Raised whenever the overlay set changes (a command added/cleared a
  // highlight). The server broadcasts the fresh snapshot to every client
  // sharing the buffer (overlays are shared state). Called with no args;
  // the server reads `spine.overlaySnapshot()`.
  const onOverlays = effects.onOverlays ?? (() => {});
  // Raised when the active client runs list-buffers (C-x C-b). The server
  // sends that client the buffer-list records (`spine.bufferListRecords`).
  const onBufferList = effects.onBufferList ?? (() => {});
  // Raised when a command opens a generic PICKER (open-picker! — the G0b
  // channel). The server sends the active client a PICKER down-message with
  // the request `{ id, title, rows, options }`; the client renders the
  // interactive list and the user's choice/cancel comes back up, resolved
  // via `deliverPicker`. Mirrors onMinibufferOpen.
  const onPicker = effects.onPicker ?? (() => {});
  // Raised when a kill-buffer switched the active client to a different
  // buffer (the killed buffer is gone). The server re-snapshots that client
  // onto its new buffer. Called with the active client's new bufferId.
  const onBufferSwitched = effects.onBufferSwitched ?? (() => {});
  // Raised for every text change on ANY held buffer, tagged with its id.
  // The server fans a delta only to the clients viewing THAT buffer (a delta
  // is no longer a broadcast — different windows hold different buffers).
  // Signature: (bufferId, { change, point }, buffer).
  const onBufferChange = effects.onBufferChange ?? (() => {});
  // Bookmarks — companion `.godot-metadata` sidecar I/O, server-owned. The
  // server reads files directly (no main-process IPC), so it owns the sidecar
  // too. `readMetadata(absPath)` loads a freshly-visited file's sidecar (sticky
  // notes + bookmarks) so the bookmark engine can restore edit-tracked
  // positions; `writeMetadata(absPath, metadata)` persists a buffer's metadata
  // back (the server debounces + atomic-writes it, mirroring files.js's
  // metadata:write). Both no-op without a host wired (unit tests).
  const readMetadata = effects.readMetadata ?? (() => null);
  const writeMetadata = effects.writeMetadata ?? (() => {});

  // --- the buffer registry (multi-buffer) ------------------------------
  //
  // The server holds MANY buffers at once (a buffer list, keyed by id). Each
  // registry entry owns its text, its per-client views (each window keeps
  // its own point/mark over the shared text — the per-window vs per-buffer
  // split, plan §4), and its overlay state. find-file ADDS a buffer rather
  // than replacing the current one; a client switches between them.
  const registry = createBufferRegistry({
    createBuffer,
    createView,
    onBufferChange: (id, event) => onBufferChange(id, event),
  });

  // The data-source registry — the source-of-truth analogue of a text buffer for
  // NON-TEXT views (image/audio/video/pdf today; stella/jukebox later). It sits
  // beside the buffer registry sharing the id-space (a distinct `ds` prefix), so
  // the pane model / tabs / open-set treat a data-source id like any view id. A
  // media source is immutable (kind + path); the onStateChange fan-out seam is
  // unused until a mutable source (stella/jukebox) graduates, when it'll re-push
  // the source to every client whose pane shows it.
  const dataSources = createDataSourceRegistry({
    onStateChange: (id) => { for (const ci of clientIndices) if (buffersShownByClient(ci).includes(id)) onPaneTree(ci); },
  });

  // Bookmarks are per-buffer (each rides its own buffer's edits), so each buffer
  // entry owns ONE bookmark engine, created lazily (`bookmarksFor`) on the first
  // bookmark op / outline open. id (entry) → engine.
  const bookmarkEngines = new Map();

  // The seed buffer (the file the server booted with). Every client starts
  // viewing it; further buffers join via find-file.
  const initialEntry = registry.add(
    options.initialText ?? '', options.name ?? 'mwb-scratch', options.initialPath ?? null);

  // --- per-window pane trees (G0a) -------------------------------------
  //
  // Each client/window owns its OWN logical pane tree (pane-model.js). A
  // leaf shows a buffer from the registry + its own per-pane view-state
  // (point/scroll); two leaves can show the SAME buffer (shared text,
  // independent point) — the same-buffer-two-windows case, but within one
  // window. The buffer the active client EDITS is its pane model's FOCUSED
  // leaf's buffer (setActiveClient binds it). A single-pane window behaves
  // exactly like the pre-pane spine: one leaf, one focused buffer.
  //
  // The leaf's view is a REAL @editor/view, minted per leaf (keyed by leaf
  // id) so the buffer's cursor binds to this pane's own point/mark. The
  // factory routes through the registry so a leaf's view participates in the
  // same multi-cursor / overlay machinery as everything else.
  /** Mint/reuse a real view over BUFFERID for the leaf with stable VIEWKEY,
   *  keyed by (viewKey, bufferId) so each (pane, buffer) pair keeps its OWN
   *  persistent point/mark — and so switching a pane away from a buffer and
   *  back restores that pane's cursor in it. Two panes on the SAME buffer have
   *  different view keys, so their cursors are independent (the same-buffer-
   *  two-windows case within one window). */
  function makeLeafView(bufferId, viewKey) {
    // A data-source leaf (media: image/audio/video/pdf) has no text buffer and
    // no cursor, so it mints NO view — it renders client-side from the PANE_TREE
    // descriptor, not the text mirror. (Without this guard, registry.viewFor
    // would miss and fall back to a text view over the welcome buffer.)
    if (bufferId != null && dataSources.has(bufferId)) return null;
    const id = bufferId ?? initialEntry.id;
    const key = `${viewKey}:${id}`;
    return registry.viewFor(id, key) ?? registry.viewFor(initialEntry.id, key);
  }

  /** @type {Map<number, import('./pane-model.js').PaneModel>} index → pane tree. */
  const paneModels = new Map();

  /** Raised when a client's pane layout/focus changed (a split / delete /
   *  other-window). The server re-pushes that client's PANE_TREE. Signature:
   *  (clientIndex). */
  const onPaneTree = effects.onPaneTree ?? (() => {});

  /** Raised when the `new-window` command runs (C-x 5 2). The server forwards
   *  a WINDOW_NEW down-message to the active client, which asks its host to
   *  open another window (a new client on this shared server). Signature: (). */
  const onNewWindow = effects.onNewWindow ?? (() => {});

  /** Create (and remember) the pane model for client INDEX, seeded on the
   *  client's starting buffer. */
  function makePaneModel(index, startBufferId) {
    const model = createPaneModel(
      { initialBufferId: startBufferId },
      {
        onChange: () => onPaneTree(index),
        nameForBuffer: (id) => {
          const ds = id ? dataSources.get(id) : null;
          if (ds) return ds.name;
          const e = id ? registry.get(id) : null;
          return e ? e.buffer.name : 'scratch';
        },
        // Step 3b: the text of a non-focused, different-buffer leaf, so the
        // client can render it as a static pane (it doesn't mirror that buffer).
        // A data-source leaf has no text (it renders from its descriptor).
        textForBuffer: (id) => {
          const e = id ? registry.get(id) : null;
          return e ? e.buffer.text : null;
        },
        // The non-text DATA-SOURCE descriptor for a leaf (image/audio/video/pdf),
        // or null for a text buffer. The snapshot carries `viewKind` + `filePath`
        // so the client mounts the matching element-view (the bytes load
        // client-side); media never touches the text mirror.
        mediaForBuffer: (id) => (id ? dataSources.descriptor(id) : null),
        // Step 3c: per-buffer tab metadata for a tabline leaf's curated strip. A
        // data-source tab carries its kind (so the client labels/icons it) and is
        // never "modified" (immutable).
        tabMeta: (id) => {
          const ds = id ? dataSources.get(id) : null;
          if (ds) return { name: ds.name, modified: false, filePath: ds.filePath, viewKind: ds.kind };
          const e = id ? registry.get(id) : null;
          if (!e) return { name: 'scratch', modified: false, filePath: null };
          return {
            name: e.buffer.name,
            modified: registry.isModified(e),
            filePath: e.filePath ?? null,
          };
        },
        // Namespace the leaf view key by the WINDOW (client index) too, so two
        // windows' leaves — whose per-window viewKey counters both start at 0 —
        // get distinct registry views (independent cursors per window). Within
        // a window the viewKey is stable per leaf (cursor survives a buffer
        // switch away and back).
        makeView: (bufferId, viewKey) => makeLeafView(bufferId, `c${index}-${viewKey}`),
      }
    );
    paneModels.set(index, model);
    return model;
  }

  // Client 0's pane tree starts as a single leaf on the seed buffer.
  makePaneModel(0, initialEntry.id);

  /** The pane model of the active client (what the pane primitives mutate).
   *  Falls back to any surviving model — index 0 may have detached — then null
   *  (only with zero clients, when nothing is being served). */
  function currentPaneModel() {
    return (
      paneModels.get(activeClientIndex)
      ?? paneModels.get(0)
      ?? paneModels.values().next().value
      ?? null
    );
  }

  // The set of LIVE client indices (so a buffer-wide refresh / a kill can
  // re-home every client). Index 0 is the bootstrap (default) view; a client
  // may detach (removeClientView), so 0 is not guaranteed to outlive the run.
  const clientIndices = new Set([0]);

  // The next client index to hand out. Monotonic — NEVER reused, so a detached
  // window's index can't collide with a later window's (using clientIndices.size
  // would: drop index 1 of {0,1,2} and size→2 would re-mint an in-use 2).
  let nextClientIndex = 1;

  // G4 — per-window OPEN-SET: the buffers a window shows (its tabline tabs / pane
  // contents). A window shows ONLY its own buffers, so opening a file in one
  // window does NOT add it to another window's tabline. The C-x C-b PICKER
  // (bufferListRows) still reaches the WHOLE pool, so any buffer is one switch
  // away — and switching ADDS it to this window's set. Keyed by buffer id today;
  // when buffer-less element-views (jukebox / stella) graduate to the server they
  // extend the same per-client set (it's "what this window has open", not "all
  // buffers"). Client 0 (window 1 — the session) is seeded with the boot buffer;
  // restore + find-file add the rest via switchClientToBuffer.
  /** @type {Map<number, Set<string>>} clientIndex -> open buffer ids. */
  const clientBuffers = new Map([[0, new Set([initialEntry.id])]]);

  /** Note that client INDEX now has BUFFERID open (shows it / can tab to it). */
  function noteClientBuffer(index, bufferId) {
    if (bufferId == null) return;
    let set = clientBuffers.get(index);
    if (!set) { set = new Set(); clientBuffers.set(index, set); }
    set.add(bufferId);
  }

  // Per-client viewport height in VISIBLE TEXT LINES, reported by the client
  // (only it knows how many lines fit — plan §5d). Screenful scroll (C-v/M-v)
  // reads the ACTIVE client's value. 0 means "not measured yet"; the scroll
  // math falls back to a one-line nudge so the command is never a silent
  // no-op until the first VIEWPORT report lands (on mount).
  const clientViewports = new Map([[0, 0]]);

  /** The active client's reported viewport height in lines (0 = unmeasured). */
  function activeViewportLines() {
    return clientViewports.get(activeClientIndex) ?? 0;
  }

  // The ACTIVE (buffer, view) the interpreter operates against right now —
  // resolved from the active client by setActiveClient before each intent.
  // `bindCursor` (run inside the buffer primitives) routes the active
  // buffer's point/mark through the active view's cursors; the session's
  // `currentView` getter returns the active view. This is exactly
  // production's session shape, but the active buffer/view now varies with
  // which client (and which of its buffers) the server is serving.
  let activeEntry = initialEntry;
  // The initial active view is client 0's FOCUSED leaf view (its pane model
  // was created above with one leaf on the seed buffer). A single-pane window
  // thus behaves exactly like the pre-pane spine: one focused leaf, one view.
  let view = paneModels.get(0).focusedView() ?? registry.viewFor(initialEntry.id, 0);
  let buffer = initialEntry.buffer;
  buffer.bindCursor(view);

  /** The session the buffer primitives operate against. A getter for
   *  `currentView` so a buffer/client switch swaps the active view
   *  underneath without re-creating the primitives. */
  const session = {
    get currentView() {
      return view;
    },
  };

  /**
   * Make (the active client's view of) buffer ENTRY active: the interpreter's
   * `buffer`, `view`, and `session.currentView` now point at it, and the
   * buffer's cursor reads/writes the given view's point/mark. Every command
   * dispatch + overlay primitive runs against whatever this last set.
   *
   * @param {object} entry - A registry buffer entry.
   * @param {object} v - That entry's view for the active client.
   */
  function bindActive(entry, v) {
    activeEntry = entry;
    buffer = entry.buffer;
    view = v;
    buffer.bindCursor(view);
  }

  /**
   * Rebind the interpreter to the ACTIVE client's FOCUSED leaf — its buffer +
   * that leaf's view — and re-derive the major mode. Called after any pane op
   * that moves focus (split / other-pane / delete / focus-direction / swap),
   * so a following command and the next keystroke edit the right pane. This is
   * just `setActiveClient(activeClientIndex)`, named for intent. (A function
   * declaration so it's hoisted above the primitive bodies that call it.) */
  function rebindFocusedPane() {
    setActiveClient(activeClientIndex);
  }

  // --- the echo area (status line) -------------------------------------
  let statusText = '';

  // --- the active minibuffer prompt ------------------------------------
  // The prompt label of an open minibuffer read, or null. The server reads
  // this on submit to decide HOW to resolve: an ordinary argument prompt
  // (goto-line, replace-string) resumes the suspended command via
  // `deliverMinibuffer`; the M-x / find-file prompts are special — their
  // command body is a no-op and the host runs the chosen command / visits
  // the file itself (see server.js).
  let activePrompt = null;

  // --- the active picker request (G0b) ---------------------------------
  // The wire request `{ id, title, rows, options }` of the currently-open
  // generic picker, or null. The server reads it on a PICKER_CHOOSE/CANCEL
  // to match the reply to the suspended command (a reply whose pickerId no
  // longer matches the active picker is stale and dropped). A fresh id is
  // minted per open so a superseded picker can't resume the wrong command.
  let activePicker = null;
  let pickerSeq = 0;

  // --- the modeline modified flag --------------------------------------
  // The "last saved" baseline is now per-buffer (registry entry.savedText),
  // so a buffer is modified when its text differs from ITS own baseline.

  // --- the server-local clipboard (kill.lisp's interprogram edge) ------
  // STUB: an in-memory clipboard, so the kill ring round-trips fully
  // without an OS clipboard (which a headless Node child lacks). See
  // PRIMITIVE-SPLIT.md "Kill ring".
  let clipboardText = '';

  // --- overlays (shared buffer state) ----------------------------------
  //
  // An overlay is a face-tagged range on the CANONICAL buffer — a search
  // highlight, a snippet field, a secondary-cursor decoration. They are
  // MODEL state (shared: every client viewing the buffer sees the same
  // set, so they live here, not per-client), and they must ride edits, so
  // each overlay's endpoints are real L2 MARKERS (which shift correctly
  // under inserts/deletes — packages/buffer createMarker). The server reads
  // their live offsets (`overlaySnapshot`) and broadcasts the set to every
  // client, whose mirror renders them via the renderer's getDecorations().
  //
  // This is the model-side half of the search/snippet/decoration features
  // PRIMITIVE-SPLIT.md flagged as render-message slices: the OVERLAY STATE
  // is model-side (shared, edit-tracked); only the PIXELS are client-side
  // (the renderer already draws getDecorations()). So an overlay needs no
  // new render protocol — just the offsets on the wire.
  //
  // Overlays now live ON THE BUFFER ENTRY (registry), not in the spine: a
  // highlight is a property of a buffer, so switching buffers must show that
  // buffer's overlays. These helpers operate on the ACTIVE entry (the
  // commands run against whatever client the server is serving). The wire
  // snapshot for a SPECIFIC buffer is `overlaySnapshotOf(id)` (used to send
  // a switching client its new buffer's overlays).

  /** Drop the active buffer's overlays (releasing markers), or only KIND. */
  function clearOverlays(kind) {
    registry.clearOverlays(activeEntry, kind);
  }

  /** A wire snapshot of the ACTIVE buffer's overlays at their current
   *  (edit-tracked) offsets. Drops overlays a deletion has collapsed. */
  function overlaySnapshot() {
    return registry.overlaySnapshot(activeEntry);
  }

  /** A wire snapshot of a SPECIFIC buffer's overlays (for a switch). */
  function overlaySnapshotOf(id) {
    const entry = registry.get(id);
    return entry ? registry.overlaySnapshot(entry) : [];
  }


  // --- the interpreter --------------------------------------------------
  const interpreter = createInterpreter({
    write: () => {}, // discard print output in the spine
    primitives: {
      // The real buffer primitives — the entire editing/motion surface the
      // stdlib commands are written against, operating on `session`.
      ...createBufferPrimitives(session),

      // --- the citation host bridge (cite.lisp / RefTeX) ----------------
      // citation-parse / -format / -format-bibliography / -keys / -entries
      // / -format-entries / -format-keys / -parse-lenient /
      // -register-style!, backed by the SAME renderer-side citation.js the
      // in-renderer app uses (its vendored Citation.js bundle is pure ESM,
      // so the headless server imports it directly). Model-side: two windows
      // on one document agree on how a bibliography formats. See
      // PRIMITIVE-SPLIT.md "RefTeX / citations" + citation-bridge.js.
      ...createCitationPrimitives(),

      // --- the pure LaTeX/RefTeX primitives (latex-primitives.js) -------
      // latex-scan (the LaTeX source scanner → labels/sections/refs/cites/
      // index/inputs/bib record lists) + the POSIX path helpers (path-resolve
      // / path-dirname / path-basename) + parse-latex-log / parse-synctex-*.
      // All PURE (no fs, no view, no async) — the same source the renderer
      // runs, so a RefTeX scan resolves identically server-side. The reftex
      // document model is Lisp over these. See PRIMITIVE-SPLIT.md "RefTeX".
      ...createLatexPrimitives(),

      // --- echo area (the minibuffer's status line) ---------------------
      // keymap.lisp calls these; the spine routes them to the client's
      // echo area via the onStatus effect.
      'show-status!': (args) => {
        statusText = String(args[0] ?? '');
        onStatus(statusText);
        return NIL;
      },
      'clear-status!': () => {
        statusText = '';
        onStatus('');
        return NIL;
      },

      // --- the minibuffer prompt ----------------------------------------
      // `open-minibuffer!` is called by the interactive gatherer
      // (commands.lisp `minibuffer-read`) to prompt for an argument. The
      // server shows the prompt; the user's input resolves via
      // `minibuffer-delivered` (called from deliverMinibuffer below).
      'open-minibuffer!': (args) => {
        activePrompt = String(args[0] ?? '');
        onMinibufferOpen(activePrompt);
        return NIL;
      },
      // open-completing-minibuffer! — the completion-backed prompt the
      // LaTeX/RefTeX smart-insertion commands use (latex-insert.lisp,
      // latex-math.lisp). The COMPLETION tab is render-side, but the
      // suspend/resume IS the ordinary minibuffer round-trip: a command
      // calls it, suspends, and resumes via minibuffer-delivered. The spine
      // routes it through the SAME prompt channel as open-minibuffer! (the
      // completion candidates are the deferred render half). So a LaTeX
      // smart-insert command resolves server-side: it prompts, and on submit
      // the model effect (insert the chosen environment/macro) runs. See
      // PRIMITIVE-SPLIT.md "Minibuffer / completion".
      'open-completing-minibuffer!': (args) => {
        activePrompt = String(args[0] ?? '');
        onMinibufferOpen(activePrompt);
        return NIL;
      },

      // --- the generic picker (G0b) -------------------------------------
      // `open-picker!` is the render half of the picker channel: a command
      // (via picker-read, defined below) calls it to open an interactive
      // list client-side. ARGS are (title rows options?): TITLE is the
      // header label; ROWS is an opaque JS array of `{ label, value, ...
      // meta }` (the host row-provider built it — Lisp passes it through
      // verbatim, never inspecting it, exactly as it passes a pane handle);
      // OPTIONS is an optional opaque JS options bag. The spine mints a
      // fresh picker id, records the request, and raises onPicker so the
      // server sends a PICKER message. The user's choice resolves via
      // `deliverPicker` (→ picker-delivered), the minibuffer's twin.
      'open-picker!': (args) => {
        const title = String(args[0] ?? '');
        const rows = Array.isArray(args[1]) ? args[1] : [];
        const options = args[2] && typeof args[2] === 'object' && !Array.isArray(args[2])
          ? args[2] : {};
        pickerSeq += 1;
        const id = `picker-${pickerSeq}`;
        activePicker = { id, title, rows, options };
        onPicker(activePicker);
        return NIL;
      },
      // `buffer-list-rows` is the buffer-list ROW-PROVIDER: it returns the
      // open buffers as picker rows (an opaque JS array) for the active
      // client — each row's label is the buffer name, its value the buffer
      // id (what an on-choose switch needs), with line-count + a ●/– flag as
      // meta and the current buffer pre-marked. This is the one concrete
      // provider G0b builds; every other picker (completions, *Recover*,
      // RefTeX) is the SAME open-picker! call with a different provider.
      'buffer-list-rows': () => bufferListRows(),

      // --- RefTeX picker ROW-PROVIDERS (cite/ref → the generic PICKER) ---
      // The RefTeX cite/ref pickers ride the SAME generic open-picker! channel
      // as the buffer list (architect-notes G0b: "cite rows map onto it; the
      // panel's row.group/row.detail fields cover RefTeX's type-grouped
      // headings + cite's author/year second line without a new channel").
      // Each converter reads the Lisp-side candidate accessor and returns the
      // opaque JS picker-row array open-picker! wants. The `value` is what the
      // on-choose Lisp callback receives.

      // reftex-select-rows — the *RefTeX Select* candidates (reftex-refs.lisp's
      // reftex-select-candidates: a list of (name type macro context)) → rows
      // { label:name, value:name, group:type, detail:context }. group drives
      // the type headings; detail is the context line.
      'reftex-select-rows': () => {
        const cands = listToArray(interpreter.call('reftex-select-candidates'));
        return cands.map((row) => {
          const [name, type, , context] = listToArray(row);
          const n = String(name ?? '');
          return {
            label: n,
            value: n,
            group: lispString(type),
            detail: lispString(context),
          };
        });
      },
      // reftex-cite-format-rows — the cite FORMAT menu (reftex-cite.lisp's
      // reftex-cite-formats: a list of (key macro description)) → rows
      // { label:"macro — description", value:macro, detail:macro }. value is
      // the LaTeX macro the on-choose callback (reftex-cite-format-chosen)
      // remembers; the key column is the keystroke (not needed by the picker).
      'reftex-cite-format-rows': () => {
        const fmts = listToArray(interpreter.call('reftex-cite-formats'));
        return fmts.map((row) => {
          const [, macro, description] = listToArray(row);
          const m = lispString(macro);
          const d = lispString(description);
          return { label: d ? `${m} — ${d}` : m, value: m, detail: m };
        });
      },
      // reftex-cite-index-rows — the cheap cite index (reftex-cite.lisp's
      // reftex-cite-index: a list of (key plain)) → rows { label:plain or key,
      // value:key, group:key, detail:plain }. The plain blob is the
      // substring-filter text (key + author + year + title); the CSL-formatted
      // HTML is fetched lazily render-side, so the server ships the cheap index
      // and the client narrows it. value is the bib key (\cite{key}).
      'reftex-cite-index-rows': () => {
        const index = listToArray(interpreter.call('reftex-cite-index'));
        return index.map((row) => {
          const [key, plain] = listToArray(row);
          const k = String(key ?? '');
          const p = lispString(plain);
          return { label: p || k, value: k, group: k, detail: p };
        });
      },

      // --- scroll / measurement (plan §5d) ------------------------------
      // recenter! is a Lisp command whose *effect* is a client-pixel
      // scroll. The server decides the target line (it knows point); the
      // client executes the pixels. Down-channel request, the easy
      // direction of the measurement conversation.
      'recenter!': () => {
        const { line } = buffer.positionAt(buffer.point);
        onScroll({ kind: 'recenter', line });
        return NIL;
      },

      // --- bookmarks (C-x r m/b/l — bookmarks.lisp) ---------------------
      // Named, edit-tracked positions: each is an L2 marker on the active
      // buffer plus a record persisted to the file's `.godot-metadata`
      // sidecar. The engine (apps/desktop/src/bookmarks.js) is shared
      // verbatim with the in-renderer app, one instance PER buffer entry
      // (bookmarksFor). set / delete also re-push an OPEN outline
      // (refreshBookmarkSource → setState fan-out); jump moves point in the
      // active buffer (its cursor reconciles like any motion command).
      'bookmark-set!': (args) => {
        const name = bookmarksFor(activeEntry).set(String(args[0] ?? ''));
        if (name === null) return NIL;
        refreshBookmarkSource(activeEntry);
        return name;
      },
      'bookmark-jump!': (args) => {
        bookmarksFor(activeEntry).jump(String(args[0] ?? ''));
        return NIL;
      },
      'bookmark-delete!': (args) => {
        bookmarksFor(activeEntry).remove(String(args[0] ?? ''));
        refreshBookmarkSource(activeEntry);
        return NIL;
      },
      'bookmark-names': () => arrayToList(bookmarksFor(activeEntry).names()),
      'bookmark-count': () => bookmarksFor(activeEntry).count(),
      // open-bookmark-view! (C-x r l) — open/reveal the outline beside the
      // document as a mutable 'bookmark' data-source.
      'open-bookmark-view!': () => { openBookmarkView(); return NIL; },

      // --- window lifecycle (G4) ----------------------------------------
      // request-new-window! is the `new-window` command's effect (C-x 5 2).
      // Opening an OS window is the client/host's job — the server has none —
      // so this raises the onNewWindow effect; the server posts WINDOW_NEW to
      // the active client, which calls host.newWindow(). The model half (the
      // keymap binding + the command) is here; the host half is in the client.
      'request-new-window!': () => {
        onNewWindow();
        return NIL;
      },

      // (page-lines) — the visible TEXT-LINE count of the active client's
      // pane, the screenful the verbatim `editing.lisp` scroll-up/scroll-down
      // step point by (production wires this to the renderer's
      // editorView.pageLines(); the server reads the client's VIEWPORT report
      // instead — only the client knows how many lines fit, plan §5d). Moving
      // point by a screenful makes the client follow-scroll on the resulting
      // CURSOR update, so C-v/M-v scroll with no new down-channel message. A
      // single-line fallback (computed pure in screenfulStep) keeps the
      // command from being a no-op before the first VIEWPORT report lands.
      'page-lines': () => screenfulStep(activeViewportLines()),

      // --- editing commands' host helpers (mirrors of app.js) -----------
      'goto-line!': (args) => {
        const n = Number(args[0]);
        if (Number.isInteger(n) && n >= 1) {
          buffer.moveTo(buffer.offsetAt(Math.min(n, buffer.lineCount) - 1, 0));
        }
        return NIL;
      },
      'replace-all!': (args) => {
        const search = String(args[0]);
        const replacement = String(args[1]);
        if (search !== '') {
          const text = buffer.text;
          const count = text.split(search).length - 1;
          if (count > 0) buffer.setText(text.split(search).join(replacement));
          statusText =
            count > 0
              ? `replaced ${count} occurrence(s) of "${search}"`
              : `"${search}" not found`;
          onStatus(statusText);
        }
        return NIL;
      },

      // --- the pane tree (G0a — panes.lisp's host primitives) ----------
      //
      // panes.lisp (loaded verbatim) wraps these. They mutate the ACTIVE
      // client's LOGICAL pane tree (pane-model.js) — no DOM, no pixels. This
      // is the whole point of G0a: the split/other/delete commands graduate
      // with zero Lisp change; only these host primitives differ from the
      // renderer's (which interleave ~1000 lines of pixel plumbing). Each
      // returns nil (interactive callers ignore the return) and the model's
      // onChange raises onPaneTree so the server re-pushes PANE_TREE.

      // Every focus-changing pane op must REBIND the interpreter to the newly-
      // focused leaf's buffer + view, so a following command (and the next
      // keystroke / intent) edits the right pane. A split moves focus to the
      // new pane; other-pane / delete / focus-direction move it too. Without
      // this, an edit would land in the previously-bound pane.

      // (split-horizontal! ratio side) — split the focused pane side-by-side.
      // SIDE is the symbol 'after (new pane right, default) or 'before (left).
      'split-horizontal!': (args) => {
        currentPaneModel().split('horizontal', Number(args[0]) || 0.5, symName(args[1]) === 'before' ? 'before' : 'after');
        rebindFocusedPane();
        return NIL;
      },
      // (split-vertical! ratio side) — split the focused pane top/bottom.
      'split-vertical!': (args) => {
        currentPaneModel().split('vertical', Number(args[0]) || 0.5, symName(args[1]) === 'before' ? 'before' : 'after');
        rebindFocusedPane();
        return NIL;
      },
      // (delete-pane!) — collapse the focused pane into its sibling (C-x 0).
      'delete-pane!': () => { currentPaneModel().deletePane(); rebindFocusedPane(); return NIL; },
      // (delete-other-panes!) — the focused pane fills the window (C-x 1).
      'delete-other-panes!': () => { currentPaneModel().deleteOtherPanes(); rebindFocusedPane(); return NIL; },
      // (other-pane!) — cycle focus to the next pane in display order (C-x o).
      'other-pane!': () => {
        currentPaneModel().otherPane();
        rebindFocusedPane(); // rebind to the new focused leaf
        return NIL;
      },
      // (balance-panes!) — reset every split ratio to 0.5.
      'balance-panes!': () => { currentPaneModel().balancePanes(); return NIL; },
      // (toggle-tabline!) — Step 3c: flip the focused pane between a single view
      // and a TABLINE of this window's buffers. The model's onChange re-pushes
      // PANE_TREE (carrying the leaf's `tabline` flag); the client re-renders it.
      'toggle-tabline!': () => {
        const model = currentPaneModel();
        if (model) model.toggleFocusedTabline();
        return NIL;
      },
      // (focus-pane-direction! dir) — spatial focus move (the one geometry-
      // coupled command; uses the client's reported host rect). DIR is a
      // symbol 'left/'right/'up/'down. Rebinds after a successful move.
      'focus-pane-direction!': (args) => {
        const moved = currentPaneModel().focusPaneDirection(symName(args[0]));
        if (moved) rebindFocusedPane();
        return NIL;
      },
      // (current-pane) — the focused leaf pane handle (panes.lisp reads its
      // id via other helpers; here it's the @editor/pane leaf object).
      'current-pane': () => currentPaneModel().focusedLeaf(),
      // (current-view) — the focused leaf's view handle. Production routes
      // current-view through current-pane; the spine returns the leaf's view.
      'current-view': () => currentPaneModel().focusedView() ?? NIL,
      // (swap-panes! a b) — swap which buffer two panes show (frames stay).
      'swap-panes!': (args) => {
        const a = args[0];
        const b = args[1];
        if (a && b && typeof a === 'object' && typeof b === 'object') {
          currentPaneModel().swapPanes(a, b);
          rebindFocusedPane();
        }
        return NIL;
      },
      // (panes-in-spiral-order) — the leaves in clockwise-badge order, as a
      // Lisp list (swap-views/permute-views read its length). Geometry-derived.
      'panes-in-spiral-order': () => arrayToList(currentPaneModel().panesInSpiralOrder()),

      // --- system clipboard (kill.lisp) — STUB (server-local) ----------
      // The kill ring's *internal* state is real shared interpreter state
      // (the `*kill-ring*` list); the clipboard mirror is the system-
      // integration edge. The server is a headless Node child with no
      // Electron `clipboard`, so it keeps an IN-MEMORY clipboard: the ring
      // works fully + round-trips (copy here, yank here), but true
      // cross-application paste is deferred (a future clipboard
      // render-message both ways). See PRIMITIVE-SPLIT.md "Kill ring".
      'clipboard-set-text!': (args) => {
        clipboardText = String(args[0] ?? '');
        return NIL;
      },
      'clipboard-text': () => clipboardText,

      // --- overlays (model state, edit-tracked via L2 markers) ---------
      // The model-side surface for face-tagged ranges. `add-overlay!`
      // pins two markers (so the range rides edits) and returns an id;
      // `clear-overlays!` drops all overlays or only those of a kind. The
      // server broadcasts the resulting set (overlaySnapshot) to clients,
      // whose renderer draws them via getDecorations(). This is what makes
      // search-match HIGHLIGHTING (every match, not just the selected one)
      // work over the wire — a real overlay feature proving the sync.
      // (start end face [kind]) -> id-string
      'add-overlay!': (args) => {
        const start = Math.max(0, Math.floor(Number(args[0]) || 0));
        const end = Math.max(0, Math.floor(Number(args[1]) || 0));
        const face = String(args[2] ?? 'overlay');
        const kind = args.length > 3 && args[3] !== NIL ? String(args[3]) : 'overlay';
        const id = registry.addOverlay(activeEntry, start, end, face, kind);
        onOverlays();
        return id;
      },
      // (clear-overlays! [kind]) -> nil. No kind clears all.
      'clear-overlays!': (args) => {
        const kind = args.length > 0 && args[0] !== NIL ? String(args[0]) : undefined;
        const removed = registry.clearOverlays(activeEntry, kind);
        if (removed > 0) onOverlays();
        return NIL;
      },
      // (overlay-count) -> integer (the live, non-collapsed count).
      'overlay-count': () => overlaySnapshot().length,

      // --- multi-buffer host helpers -----------------------------------
      // open-buffer-list! signals the host to send the active client the
      // buffer-list records (C-x C-b). The host (server.js) owns the
      // registry, so it packs + sends the list; this just raises the effect.
      'open-buffer-list!': () => { onBufferList(); return NIL; },
      // switch-to-buffer-id! switches the ACTIVE client's window to buffer ID
      // (the on-choose action of the C-x C-b picker). Re-points the focused
      // leaf onto the buffer and raises onBufferSwitched so the server re-syncs
      // the client onto its new buffer. (id) -> #t on success, #f if no such id.
      'switch-to-buffer-id!': (args) => {
        const id = String(args[0] ?? '');
        return switchClientToBuffer(activeClientIndex, id);
      },
      // kill-current-buffer! removes the active client's current buffer and
      // switches that client to another (the registry refuses to drop the
      // last buffer). The host performs the kill + re-snapshot (killBuffer).
      'kill-current-buffer!': () => { killActiveBuffer(); return NIL; },

      // (open-file-path! PATH) — visit PATH, adding it as a buffer + switching
      // the active client to it (the server is a Node child, so it reads disk
      // directly via visitFile). RefTeX's reftex-select-on-peek + the cite/ref
      // origin-return path use it to surface a label's source file. Returns
      // nil. A read failure is surfaced by visitFile's status.
      'open-file-path!': (args) => {
        const path = String(args[0] ?? '');
        if (path !== '') visitFile(path);
        return NIL;
      },

      // --- view-list surface (view-primitives.js) — MODEL --------------
      // Under Model B a "view" maps onto a registry BUFFER: the buffers
      // are shared server state, and each client tracks which it views
      // (PRIMITIVE-SPLIT.md "View / pane addressing — the buffer list").
      // So new-view! mints a fresh empty buffer and switches the ACTIVE
      // client's focused leaf onto it (subsequent insert!s land there) —
      // exactly what occur.lisp expects (`(new-view! name)` then
      // `(insert! result)`). Returns the new buffer's view for the active
      // client (a real @editor/view object, like production's newView).
      // (name) -> view
      'new-view!': (args) => {
        const name = args.length > 0 && args[0] !== NIL ? String(args[0]) : 'scratch';
        const entry = registry.add('', name);
        switchClientToBuffer(activeClientIndex, entry.id);
        return registry.viewFor(entry.id, activeClientIndex);
      },
      // find-view — a by-name buffer lookup. A miss is `#f` (absence
      // convention), so `(if (find-view n) …)` works. Returns the active
      // client's view of that buffer, or #f.
      'find-view': (args) => {
        const entry = registry.findByName(String(args[0] ?? ''));
        return entry ? registry.viewFor(entry.id, activeClientIndex) : false;
      },
      // switch-to-view! — switch the active client to a buffer by name or
      // by a view handle. Returns the resulting view, or nil on a miss.
      'switch-to-view!': (args) => {
        const arg = args[0];
        let entry = null;
        if (typeof arg === 'string') entry = registry.findByName(arg);
        else if (arg && typeof arg === 'object' && typeof arg.name === 'string') {
          entry = registry.findByName(arg.name);
        }
        if (!entry) return NIL;
        switchClientToBuffer(activeClientIndex, entry.id);
        return registry.viewFor(entry.id, activeClientIndex);
      },

      // --- view → file mapping (RefTeX document model) -----------------
      // The RefTeX R1 document model (reftex.lisp) needs the file path /
      // buffer / directory of a view to detect the master, resolve \input
      // chains, and read the current file. Under Model B a "view" is a real
      // @editor/view bound to a registry buffer; map it back to its registry
      // entry by buffer identity (view.buffer === entry.buffer) to read the
      // entry's filePath. A view with no backing file (scratch) → nil.
      // (view-file-path VIEW) -> absolute path string, or nil.
      'view-file-path': (args) => {
        const entry = entryForView(args[0]);
        return entry && entry.filePath ? entry.filePath : NIL;
      },
      // (view-buffer VIEW) -> the view's buffer object, or nil. reftex.lisp
      // declares it as a dep; the document model reads the CURRENT buffer's
      // text via buffer-text, so this is rarely hit, but provide it for
      // completeness (returns the real L2 buffer).
      'view-buffer': (args) => {
        const v = args[0];
        return v && typeof v === 'object' && v.buffer ? v.buffer : NIL;
      },
      // (view-directory VIEW) -> the directory of the view's file, or nil.
      'view-directory': (args) => {
        const entry = entryForView(args[0]);
        if (!entry || !entry.filePath) return NIL;
        const slash = entry.filePath.lastIndexOf('/');
        return slash <= 0 ? '/' : entry.filePath.slice(0, slash);
      },

      // --- file existence (RefTeX \input-chain + bib-path resolution) ---
      // (file-exists? PATH) -> #t when PATH names an existing file/dir, #f
      // otherwise. Synchronous (the server is a Node child), mirroring
      // app.js's fileExistsSync wrapper. RefTeX uses it to skip absent
      // \input targets and to probe bib paths before reading.
      'file-exists?': (args) => {
        const p = String(args[0] ?? '');
        if (p === '') return false;
        try {
          statSync(p);
          return true;
        } catch {
          return false;
        }
      },

      // --- save (real file I/O, atomic) --------------------------------
      // save-buffer! writes the ACTIVE buffer's text to its file path
      // (atomic temp-file + rename, via the saveFile effect) and re-baselines
      // the saved text so the ● dirty flag clears. A path-less buffer can't
      // save here: the primitive returns 'no-path so the command opens a
      // write-file prompt instead (host-completed, like find-file). Returns
      // a status STRING the command branches on: "ok" | "no-path" | "error".
      'save-buffer!': () => saveActiveBuffer(),
      // write-file! writes the active buffer to PATH, rebinds the buffer's
      // path to it (subsequent C-x C-s saves there), and re-baselines.
      // (path) -> "ok" | "error".
      'write-file!': (args) => writeActiveBufferTo(String(args[0] ?? '')),

      // --- customisation openers (custom.lisp) — STUB ------------------
      // These open a render-side customize view. The `customize` command
      // resolves; the panel itself is a render-side slice, deferred. None
      // is called at load time, so loading custom.lisp is unaffected.
      'open-customize!': () => NIL,
      'open-customize-group!': () => NIL,
      'open-customize-variable!': () => NIL,
      'write-custom-file!': () => NIL,

      // --- search (search.lisp) — STUB (the isearch loop is host-owned) -
      // `isearch-forward`/`isearch-backward` just BEGIN an incremental
      // search; the per-keystroke match + highlight + minibuffer loop
      // lives in the host. Server-side that is a render-message slice of
      // its own (a server search state machine + a client overlay). For
      // now the commands resolve and surface a status so the wiring is
      // visible, then no-op. See PRIMITIVE-SPLIT.md "Search".
      'start-search!': () => {
        statusText = 'I-search: temporarily unavailable in server-mode (being rebuilt)';
        onStatus(statusText);
        return NIL;
      },
      'start-search-backward!': () => {
        statusText = 'I-search backward: temporarily unavailable in server-mode (being rebuilt)';
        onStatus(statusText);
        return NIL;
      },

      // --- regexp isearch starters (regex-search.lisp) — STUB ----------
      // Like start-search!, these BEGIN an incremental regexp search; the
      // per-keystroke match + highlight loop is render-side. The commands
      // (isearch-regexp-forward/backward) resolve + surface a status, then
      // no-op. See PRIMITIVE-SPLIT.md "Search / regex".
      'start-regexp-search!': () => {
        statusText = 'I-search regexp: temporarily unavailable in server-mode (being rebuilt)';
        onStatus(statusText);
        return NIL;
      },
      'start-regexp-search-backward!': () => {
        statusText = 'I-search regexp backward: (spine stub — host-side loop)';
        onStatus(statusText);
        return NIL;
      },

      // --- regexp / string search + replace (regex-search.lisp) — MODEL -
      // The model halves that back replace-regexp + query-replace. Each
      // operates on the ACTIVE buffer's text and mirrors app.js exactly
      // (same match positions in both worlds). A match is `(start . end)`;
      // a miss — including an invalid/empty pattern — is `#f` (the absence
      // convention the Lisp tests with a bare `if`). See PRIMITIVE-SPLIT.md.
      'find-regexp-forward': (args) => {
        const source = String(args[0] ?? '');
        const from = Number(args[1] ?? 0);
        const regexp = compileRegexpSource(source);
        if (regexp === null) return false;
        const match = regexpForwardMatch(buffer.text, regexp, from);
        return match === null ? false : cons(match.start, match.end);
      },
      'find-regexp-backward': (args) => {
        const source = String(args[0] ?? '');
        const from = Number(args[1] ?? 0);
        const regexp = compileRegexpSource(source);
        if (regexp === null) return false;
        const match = regexpBackwardMatch(buffer.text, regexp, from);
        return match === null ? false : cons(match.start, match.end);
      },
      'find-string-forward': (args) => {
        const needle = String(args[0] ?? '');
        const from = Number(args[1] ?? 0);
        if (needle === '') return false;
        const index = buffer.text.indexOf(needle, Math.max(0, from));
        return index < 0 ? false : cons(index, index + needle.length);
      },
      // (replace-regexp-all! source replacement) -> count, or -1 for an
      // invalid pattern. REPLACEMENT honours $N / $& / $$.
      'replace-regexp-all!': (args) => {
        const source = String(args[0] ?? '');
        const replacement = String(args[1] ?? '');
        const regexp = compileRegexpSource(source);
        if (regexp === null) return -1;
        let count = 0;
        const newText = buffer.text.replace(regexp, (...match) => {
          count += 1;
          return expandReplacement(replacement, match);
        });
        if (count > 0) buffer.setText(newText);
        statusText =
          count > 0
            ? `replaced ${count} occurrence(s) of /${source}/`
            : `/${source}/ — no match`;
        onStatus(statusText);
        return count;
      },
      // (replace-range! start end text) -> nil. One match swapped in a
      // single edit (query-replace's per-match replace).
      'replace-range!': (args) => {
        const start = Number(args[0]);
        const end = Number(args[1]);
        const text = String(args[2] ?? '');
        if (!Number.isInteger(start) || !Number.isInteger(end)) return NIL;
        buffer.moveTo(Math.min(start, end));
        buffer.deleteForward(Math.abs(end - start));
        buffer.insert(text);
        return NIL;
      },

      // --- live preview (markdown.lisp) — STUB -------------------------
      // markdown-preview! / math-preview! drive render-side iframes /
      // MathJax. The toggle commands resolve; the visual effect is a
      // render-message to build later. See PRIMITIVE-SPLIT.md "preview".
      'markdown-preview!': () => {
        statusText = 'markdown-preview: (spine stub — preview pane is render-side)';
        onStatus(statusText);
        return NIL;
      },
      'math-preview!': () => NIL,

      // --- snippets.lisp host primitives -------------------------------
      // The snippet engine (expansion, fields, mirrors-as-multicursors) is
      // entirely MODEL-side — it runs over insert!/goto!/set-mark!/
      // add-selection!/collapse-to-primary!, all provided. The remaining
      // host primitives are: a date formatter (model, deterministic from
      // the clock — mirrors app.js) and three FILE-system reads for the
      // user/disk snippet directories. The spine has no user snippet
      // directory yet, so the directory reads return safe empties; the
      // built-in starter set (*snippet-builtins*, defined in Lisp) still
      // loads, so snippet-insert / snippet-expand work fully server-side.
      // read-file-text! does a real disk read (the server is a Node child)
      // for the day a snippet directory is wired. See PRIMITIVE-SPLIT.md.

      // (snippet-date-string kind) — "date" | "datetime" | "year". Mirrors
      // app.js byte-for-byte so a `date`/`year` snippet expands identically.
      'snippet-date-string': (args) => {
        const kind = String(args[0] ?? 'date');
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ymd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        if (kind === 'year') return String(now.getFullYear());
        if (kind === 'datetime') return `${ymd} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        return ymd;
      },
      // (snippet-user-directory) — the user snippet root. None server-side
      // yet (it is an app/render data-path concern), so "" → no user dir.
      'snippet-user-directory': () => '',
      // (list-directory-paths dir) — (name . :file/:directory) pairs for the
      // entries of DIR, or nil when DIR can't be listed. A REAL disk read
      // (the server is a Node child), mirroring app.js's
      // listDirectoryWithTypesSync. RefTeX's master detection
      // (-reftex-tex-siblings) lists a directory to find a sibling .tex that
      // \inputs the current file; snippet directory reads would use it too.
      'list-directory-paths': (args) => {
        const dir = String(args[0] ?? '');
        if (dir === '') return NIL;
        let dirents;
        try {
          dirents = readdirSync(dir, { withFileTypes: true });
        } catch {
          return NIL;
        }
        return arrayToList(
          dirents.map((d) =>
            cons(d.name, keyword(d.isDirectory() ? 'directory' : 'file'))
          )
        );
      },
      // (read-file-text! path) — a real disk read (the server is a Node
      // child); nil on any error. Only reached once a snippet directory is
      // wired (the built-ins never touch the fs).
      'read-file-text!': (args) => {
        const p = String(args[0] ?? '');
        if (p === '') return NIL;
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return NIL;
        }
      },

      // --- register-mode-menu! consumes (math-preview/modes) -----------
      // `register-mode-menu!` is defined in menus.lisp (not loaded), but
      // markdown.lisp calls it at load to register its grouped menu. The
      // registry it writes is shared model state; the *rendering* of the
      // menu is render-side. Provide a model-side recorder so the load
      // succeeds and the registration is queryable, without pulling in
      // the whole of menus.lisp (which is render-heavy). See
      // PRIMITIVE-SPLIT.md "Modes".
      // (No host primitive needed — register-mode-menu! is pure Lisp; we
      // define a minimal version in the spine prelude below.)

      // `string-repeat` is in the prelude? No — it's a stdlib helper used
      // by `insert-tab`. Provide it so insert-tab works. (Pure; mirrors
      // the stdlib's own definition closely enough for the spine.)
      'string-repeat': (args) => String(args[0] ?? '').repeat(Math.max(0, Number(args[1]) || 0)),
    },
  });

  // --- spine prelude: model-side shims for two procedures that live in
  // render-heavy files we deliberately DON'T load (menus.lisp) but that a
  // loaded file references at load time. Both are pure model state (a
  // registry); only the RENDERING of what they record is render-side, and
  // that's deferred. Defining them here as pure Lisp lets markdown.lisp
  // load verbatim without pulling in menus.lisp. See PRIMITIVE-SPLIT.md.
  interpreter.evaluate(`
    ;; register-mode-menu! — the structured-menu registry (menus.lisp).
    ;; markdown.lisp calls this at load. The registry is shared model
    ;; state; the menu's rendering is render-side (deferred).
    (define *mode-menu-sections* {})
    (define (register-mode-menu! mode-name sections)
      (set! *mode-menu-sections*
            (assoc *mode-menu-sections* mode-name sections))
      sections)
    (define (mode-menu-sections-for mode-name)
      (get *mode-menu-sections* mode-name nil))

    ;; *prefix-arg* — the C-u universal-argument state (keymap.lisp owns it in
    ;; production; that file is render-heavy and not loaded). panes.lisp reads
    ;; it to decide a split's side ('after with no prefix, 'before with C-u).
    ;; The spine has no C-u path yet, so it stays nil → splits default 'after.
    (define *prefix-arg* nil)

    ;; the-keymap — the global key -> command table (keymap.lisp owns it in
    ;; production; not loaded here). auto-pair.lisp binds the bracket/quote
    ;; characters into it ((set! the-keymap (assoc the-keymap "(" …))), and
    ;; the spine's handle-key consults it for a single printable BEFORE
    ;; self-inserting — so a typed "(" runs auto-pair-open-paren server-side,
    ;; exactly as production resolves the-keymap before self-insert. It seeds
    ;; empty (the spine's motion/editing chords live in the JS KEYMAP); only
    ;; the per-character auto-pair bindings land here. (-spine-the-keymap-get
    ;; reads it for handle-key; a miss is #f.)
    (define the-keymap {})
    (define (-spine-the-keymap-get key)
      "The command bound to KEY in the-keymap, or #f when unbound. Read by
       handle-key's printable path so auto-pair's character bindings fire."
      (let ((binding (get the-keymap key nil)))
        (if (nil? binding) #f binding)))

    ;; defface / face — the face registry (faces.lisp owns these in
    ;; production; that file is render-heavy and not loaded). snippets.lisp
    ;; (and other feature files) register their faces at load via defface.
    ;; The face REGISTRY is shared model state — two windows agree on what a
    ;; face is — so the spine records it; only the *rendering* (the
    ;; <style id="face-overrides"> the host writes) is render-side, deferred.
    ;; A minimal model-side version: the face constructor builds a
    ;; descriptor hash-map; defface stores it under its name. snippets.lisp
    ;; (and the other feature files the spine loads) call defface with an
    ;; EXPLICIT quote on the name — (defface 'snippet-active-face :doc …
    ;; :default-dark (face …)) — and evaluated (face …) blocks, so a plain
    ;; function (not a macro)
    ;; suffices: NAME arrives already as a symbol, the option values already
    ;; evaluated. The (from 'parent) inheritance form is unused here. See
    ;; PRIMITIVE-SPLIT.md "Live preview / faces".
    (define *face-registry* {})
    (define (face . pairs)
      "Build a face descriptor (a hash-map) from keyword-value pairs."
      (apply hash-map pairs))
    (define (defface name . options)
      "Register face NAME (a symbol) with OPTIONS (keyword/value pairs).
       Model-side: records the descriptor; the rendering is deferred."
      (set! *face-registry*
            (assoc *face-registry* name
                   (assoc (apply hash-map options) :name name)))
      name)

    ;; minibuffer-tab-complete — the base TAB-completion handler the
    ;; minibuffer's onTab calls (files.lisp owns it in production; that file
    ;; is render-heavy and not loaded). latex-insert.lisp / reftex-refs.lisp
    ;; CAPTURE this at load (\`(define orig minibuffer-tab-complete)\`) to
    ;; wrap it, so it must exist before they load. TAB completion is a
    ;; render-side feature (the completions tab + the live candidate list),
    ;; so the model-side base is a PASS-THROUGH: it returns CURRENT
    ;; unchanged (no candidates server-side). The wrapping files still load
    ;; + add their own candidate sources at command time; only the
    ;; interactive completion UI is deferred. See PRIMITIVE-SPLIT.md.
    (define (minibuffer-tab-complete current) current)
  `);

  // Load the real command system + editing commands + the model-heavy
  // slice (see SPINE_STDLIB) verbatim from disk — the same source the
  // production editor runs. Just before multi-cursor.lisp (which rebinds
  // keyboard-quit), define a minimal model-side keyboard-quit: production's
  // (keymap.lisp, render-heavy, not loaded) also resets the keymap + prefix
  // arg, but the spine owns chord state in JS (resetChord), so the model
  // half is just clearing the mark. `defcommand` exists once commands.lisp
  // (first in the list) has loaded, so this must run mid-loop, not in the
  // early prelude above.
  for (const file of SPINE_STDLIB) {
    if (file === 'multi-cursor.lisp') {
      interpreter.evaluate(`
        (defcommand keyboard-quit ()
          "Abort a partial key sequence and clear the selection (C-g)."
          (clear-mark!))
      `);
    }
    const source = readFileSync(join(STDLIB_DIR, file), 'utf8');
    interpreter.evaluate(source);
  }

  // Language major modes (`languages/*.lisp`: a `define-mode` + `register-mode`
  // each, plus a few editing commands using the same primitives the modes above
  // already provide). Loaded TOLERANTLY — one bad file logs + skips rather than
  // aborting the boot — so the modeline + mode keymaps get the right mode for
  // common file types (.html, .py, .css, .json, …) without per-file curation.
  // Skip latex/markdown: their richer modes load from the list above.
  try {
    const langDir = join(STDLIB_DIR, 'languages');
    for (const f of readdirSync(langDir)) {
      if (!f.endsWith('.lisp') || f === 'latex.lisp' || f === 'markdown.lisp') continue;
      try {
        interpreter.evaluate(readFileSync(join(langDir, f), 'utf8'));
      } catch (error) {
        console.error(`[mwb-server] language mode skipped languages/${f}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`[mwb-server] language modes unavailable: ${error.message}`);
  }

  // A couple of spine-level commands defined in Lisp on top of the real
  // command system: the M-x entry point and a minimal find-file. These run
  // through the same `run-command`/`defcommand` machinery as everything
  // else — they are real commands, not host shims.
  interpreter.evaluate(`
    ;; --- the generic picker round-trip (G0b) ----------------------------
    ;; The SAME suspend/resume shape as the minibuffer (commands.lisp's
    ;; minibuffer-read / minibuffer-delivered), for a render-side PICKER: a
    ;; command opens an interactive list (open-picker!), SUSPENDS, and resumes
    ;; in a callback when the user picks a row (or cancels). The buffer list,
    ;; *Recover*, completions, RefTeX select + cite are ALL this one shape —
    ;; rows in, one choice out — so they share this one mechanism + a per-
    ;; picker row-provider. This lives in the spine (not production
    ;; commands.lisp) so the channel stays inside the mwb slice.
    (define *picker-reader* nil)

    (define (picker-read title rows callback)
      "Open a render-side picker titled TITLE over ROWS (the host's opaque
       row array); CALLBACK receives the chosen row's value, or nil on cancel."
      (set! *picker-reader* callback)
      (open-picker! title rows))

    (define (picker-delivered result)
      "Called by the host when an open picker resolves. RESULT is the chosen
       row's value, or nil on cancel. Resumes the suspended continuation."
      (let ((reader *picker-reader*))
        (set! *picker-reader* nil)
        (if (not (nil? reader)) (reader result))))

    ;; M-x — prompt for a command name, then run it. The host completes
    ;; the prompt (it has the command list); on submit the host calls
    ;; (run-command (quote NAME)) directly, so this command's body just
    ;; opens the prompt with a marker the host recognises.
    (defcommand execute-extended-command ()
      "Read a command name in the minibuffer and run it (M-x)."
      (interactive (string "M-x "))
      ;; The argument IS the chosen command name (the host resolved it).
      (lambda (name) name))

    ;; --- multi-buffer commands (C-x b / C-x C-b / C-x k) -------------
    ;; switch-to-buffer prompts for a buffer name; the host completes
    ;; against the live buffer list and, on submit, switches the active
    ;; client to that buffer (sending it the new buffer's snapshot +
    ;; overlays). Like M-x/find-file, the body is a host-fulfilled
    ;; placeholder — the host acts on submit (server.js).
    (defcommand switch-to-buffer ()
      "Switch the current window to another buffer by name (C-x b)."
      (interactive (string "Switch to buffer: "))
      (lambda (name) name))

    ;; list-buffers (C-x C-b) — the FIRST consumer of the generic picker
    ;; (G0b). It opens an interactive PICKER over the open buffers (rows from
    ;; the host's buffer-list-rows provider) and, on a choice, switches this
    ;; window to the chosen buffer. This is the round-trip in miniature: the
    ;; command suspends in picker-read; the client renders the list, narrows,
    ;; navigates, picks; the host resumes the continuation with the chosen
    ;; buffer's id; the body switches to it. switch-to-buffer-id! is host-side
    ;; (it re-syncs the client onto the new buffer). A cancel resumes with nil
    ;; → the cond's else does nothing (the window stays put).
    (defcommand list-buffers ()
      "Pick a buffer to switch to (C-x C-b)."
      (picker-read "Buffer list"
                   (buffer-list-rows)
                   (lambda (id)
                     (cond
                       ((nil? id) nil)            ;; cancelled — stay put
                       (else (switch-to-buffer-id! id))))))

    ;; kill-buffer removes the current buffer from the registry and
    ;; switches the window to another (the registry refuses to drop the
    ;; last buffer). The host performs the kill + re-snapshot on dispatch.
    (defcommand kill-buffer ()
      "Kill the current buffer and switch to another (C-x k)."
      (kill-current-buffer!))

    ;; save-buffer (C-x C-s): write the current buffer to its file path
    ;; (atomic, host-side). The host primitive returns a status string:
    ;;   "ok"      — saved; show a confirmation.
    ;;   "no-path" — a path-less buffer; fall back to write-file (prompt for
    ;;               a path), exactly like Emacs's C-x C-s on a new buffer.
    ;;   "error"   — the disk write failed; surface it.
    (defcommand save-buffer ()
      "Save the current buffer to its file (C-x C-s)."
      (let ((result (save-buffer!)))
        (cond
          ((equal? result "ok") (show-status! "Saved"))
          ((equal? result "no-path") (run-command 'write-file))
          (else (show-status! "save-buffer: write failed")))))

    ;; write-file / save-as (C-x C-w): prompt for a path, write the buffer
    ;; there, and rebind the buffer's path to it. The host fulfils the prompt
    ;; (like find-file): on submit server.js calls write-file! with the path.
    (defcommand write-file ()
      "Write the current buffer to a named file (C-x C-w)."
      (interactive (string "Write file: "))
      (lambda (path) path))

    ;; set-mark-command: start a selection at point.
    (defcommand set-mark-command ()
      "Set the mark at point, starting a selection (C-space)."
      (set-mark!)
      (show-status! "Mark set"))

    ;; --- highlight-matches: a REAL overlay feature, server-side -------
    ;; Highlight EVERY occurrence of the word at point (or the active
    ;; region's text) as overlays. Unlike the host's interactive isearch
    ;; (which selects one match at a time), this paints all matches at
    ;; once — the natural proof that overlays sync to the client and the
    ;; real view.js draws them via getDecorations(). The overlays ride
    ;; edits (their endpoints are L2 markers) and are shared across every
    ;; window viewing the buffer.
    (define (-highlight-bounds)
      "The (start . end) to highlight: the active region, else the word
       at point. nil when there is neither."
      (cond
        ((region-active?)
         (let ((m (mark)) (p (point)))
           (cons (min m p) (max m p))))
        (else (expand-region-word-bounds (buffer-text) (point)))))

    (define (-add-match-overlays text needle n from)
      "Add a search overlay at every occurrence of NEEDLE (length N) in
       TEXT at or after FROM. Tail-recursive."
      (let ((found (string-index-of text needle from)))
        (cond
          ((< found 0) nil)
          (else
            (add-overlay! found (+ found n) "search-match" "search")
            (-add-match-overlays text needle n (+ found n))))))

    (defcommand highlight-matches ()
      "Highlight every occurrence of the word at point (or the region)
       with search overlays (M-s h)."
      (clear-overlays! "search")
      (let ((bounds (-highlight-bounds)))
        (when (not (nil? bounds))
          (let* ((start (car bounds))
                 (end (cdr bounds))
                 (text (buffer-text))
                 (needle (substring text start end))
                 (n (string-length needle)))
            (when (> n 0)
              (-add-match-overlays text needle n 0)
              (show-status!
                (string-append "Highlighted "
                               (number->string (overlay-count))
                               " match(es) of \\"" needle "\\"")))))))

    (defcommand unhighlight-all ()
      "Remove all search-match highlight overlays (M-s u)."
      (clear-overlays! "search")
      (show-status! "Highlights cleared"))
  `);

  // --- RefTeX picker openers → the generic PICKER channel --------------
  //
  // reftex-refs.lisp / reftex-cite.lisp call three render-side openers to
  // surface their selection UIs — `open-reftex-select!` (the *RefTeX Select*
  // label picker), `open-reftex-cite-format!` (the cite format menu) and
  // `open-reftex-cite-select!` (the cite entry picker) — plus `open-file-path!`
  // (peek/jump). In production these open bespoke bottom-dock panels; under
  // Model B they ride the SAME generic open-picker! suspend/resume channel as
  // the buffer list (architect-notes G0b). Each opener reads its candidate
  // rows from the matching JS row-provider (reftex-select-rows /
  // -cite-format-rows / -cite-index-rows, which marshal the Lisp candidate
  // accessors into the picker's wire shape) and resumes the right reftex
  // callback on the user's choice (or its -on-cancel on a nil cancel). The
  // commands' bodies (reftex-reference / reftex-citation) are unchanged — they
  // build the candidate model and call these openers exactly as in production.
  //
  // These are defined HERE (after the SPINE_STDLIB chain has loaded, so the
  // reftex-* accessors/callbacks exist, and after picker-read) so they OVERRIDE
  // the absence of the production openers; loading the reftex files first left
  // these symbols unbound, which only matters at command time. See
  // PRIMITIVE-SPLIT.md "RefTeX".
  interpreter.evaluate(`
    ;; The *RefTeX Select* label picker (reftex-reference, C-c )). The rows are
    ;; grouped by label type (row.group); RET inserts <macro>{name} at the
    ;; origin (reftex-select-on-select); cancel returns to the origin.
    ;; (SPC-peek is a render-side affordance of the bespoke panel; the generic
    ;; picker is choose-or-cancel, so peek is deferred — the choose path is the
    ;; daily one and is fully wired.)
    (define (open-reftex-select!)
      (picker-read "RefTeX: insert reference"
                   (reftex-select-rows)
                   (lambda (name)
                     (if (nil? name)
                         (reftex-select-on-cancel)
                         (reftex-select-on-select name)))))

    ;; The cite FORMAT menu (step 1 of reftex-citation, C-c [). Choosing a
    ;; format remembers the macro and opens the cite picker
    ;; (reftex-cite-format-chosen → open-reftex-cite-select!); cancel aborts.
    (define (open-reftex-cite-format!)
      (picker-read "RefTeX: citation format"
                   (reftex-cite-format-rows)
                   (lambda (macro)
                     (if (nil? macro)
                         (reftex-cite-on-cancel)
                         (reftex-cite-format-chosen macro)))))

    ;; The cite ENTRY picker (step 2). The cheap index is shipped + narrowed
    ;; client-side; RET inserts <macro>{key} at the origin (reftex-cite-insert);
    ;; cancel returns to the origin. (Marking several entries with \`m\` is a
    ;; bespoke-panel affordance; the generic picker inserts the single chosen
    ;; key — the common case — and multi-key marking is deferred.)
    (define (open-reftex-cite-select!)
      (picker-read "RefTeX: choose citation"
                   (reftex-cite-index-rows)
                   (lambda (key)
                     (if (nil? key)
                         (reftex-cite-on-cancel)
                         (reftex-cite-insert key)))))
  `);

  // --- the mode-keymap resolver (the meaningful spine extension) -------
  //
  // For a mode's bindings (Markdown's C-c b, the math-symbol minor mode's
  // \`) to dispatch server-side, handleKey must consult the active
  // buffer's mode-keymap chain — exactly what production keymap.lisp does
  // via `lookup-in-chain (keymap-chain)`. modes.lisp (now loaded) provides
  // `minor-mode-keymaps` + `major-mode-keymap`; this resolver reuses them.
  //
  // It is written in Lisp (so it walks the real Lisp hash-maps) but is
  // STATELESS toward JS: it returns a tagged plain value JS can branch on
  // without holding a Lisp object —
  //   - a command name (string)  → JS runs it through run-command;
  //   - the symbol 'prefix       → JS knows a chord started (the resolver
  //                                stashed the map in `-spine-chord-map`);
  //   - nil                      → not bound in the mode chain (JS falls
  //                                through to its own global KEYMAP).
  // The chord state lives in `-spine-chord-map`; a follow-up key resolves
  // against it. resetMode() clears it (C-g, an unbound mid-chord key).
  interpreter.evaluate(`
    (define -spine-chord-map nil)

    (define (-spine-mode-chain)
      "The mode keymaps for the current buffer, highest precedence first:
       minor-mode maps, then the major-mode map. (No global map — the JS
       KEYMAP is the spine's global layer.)"
      (append (minor-mode-keymaps) (list (major-mode-keymap))))

    (define (-spine-lookup key maps)
      "First non-nil binding of KEY among MAPS (skipping nil maps)."
      (cond
        ((nil? maps) nil)
        ((nil? (car maps)) (-spine-lookup key (cdr maps)))
        (else (let ((b (get (car maps) key nil)))
                (if (nil? b) (-spine-lookup key (cdr maps)) b)))))

    (define (-spine-resolve key)
      "Resolve KEY through the mode chain (or the active chord map). Returns
       a command name (string), 'prefix (a chord began — map stashed), or
       nil (unbound in the mode chain)."
      (let ((b (if (nil? -spine-chord-map)
                   (-spine-lookup key (-spine-mode-chain))
                   (get -spine-chord-map key nil))))
        (cond
          ((nil? b) (set! -spine-chord-map nil) nil)
          ((map? b) (set! -spine-chord-map b) 'prefix)
          ((symbol? b) (set! -spine-chord-map nil) (symbol->string b))
          (else (set! -spine-chord-map nil) nil))))

    (define (-spine-reset-chord) (set! -spine-chord-map nil))
    (define (-spine-chord-active?) (not (nil? -spine-chord-map)))

    ;; Choose the major mode from the current view's name (modes.lisp's
    ;; choose-major-mode! turns on default minor modes too — none here yet).
    (define (-spine-choose-major-mode) (choose-major-mode!) nil)

    ;; read-next-key support: route the next keystroke to a callback
    ;; instead of the keymaps (keymap.lisp's mechanism; the math-symbol
    ;; minor mode's \` uses it). Defined here because keymap.lisp (which
    ;; owns the production version) is render-heavy and not loaded.
    (define *spine-key-reader* nil)
    (define (read-next-key callback) (set! *spine-key-reader* callback) nil)
    (define (-spine-key-reader-pending?) (not (nil? *spine-key-reader*)))
    (define (-spine-take-key-reader key)
      "If a key-reader is pending, consume it with KEY and return #t."
      (if (nil? *spine-key-reader*)
          #f
          (let ((reader *spine-key-reader*))
            (set! *spine-key-reader* nil)
            (reader key)
            #t)))
  `);

  // --- M-x: a real command-name read --------------------------------
  // execute-extended-command's interactive (string "M-x ") opens the
  // minibuffer; the host (server) completes against the real command
  // registry and, on submit, runs the chosen command. We expose the
  // command names + a runner for the server to use.

  /** Every registered command name, as strings (from the REAL registry). */
  function commandNames() {
    return listToArray(interpreter.call('registered-command-names')).map(String);
  }

  // --- find-file (a real command, host-completed path) ------------------
  // find-file prompts for a path; on submit the host reads the file (Node,
  // direct I/O) and swaps the canonical buffer. We model it as a command
  // whose prompt the host fulfils, then the host calls `visitFile`.
  interpreter.evaluate(`
    (defcommand find-file ()
      "Visit a file (C-x C-f). The host reads the path and swaps buffers."
      (interactive (string "Find file: "))
      (lambda (path) path))

    (defcommand directory-tree ()
      "Open a directory tree-view rooted at a directory chosen in the
       minibuffer. The host opens it as a directory-view DATA-SOURCE."
      (interactive (string "Directory tree: "))
      (lambda (path) path))

    (defcommand directory-columns ()
      "Open a directory columns-view (Miller columns) rooted at a directory
       chosen in the minibuffer. The host opens it as a directory-view
       DATA-SOURCE."
      (interactive (string "Directory columns: "))
      (lambda (path) path))

    (defcommand jukebox ()
      "Open a jukebox for a directory of audio files chosen in the minibuffer.
       The host scans the directory and opens it as a jukebox DATA-SOURCE."
      (interactive (string "Jukebox directory: "))
      (lambda (path) path))

    (defcommand new-window ()
      "Open another editor window onto the shared server (C-x 5 2). The
       window itself is opened by the client's host; this raises the effect."
      (request-new-window!))

    (defcommand toggle-tabline ()
      "Toggle whether the focused pane is a tabline of this window's buffers
       (Step 3c) — 'add a tabline-view' to a single pane, or back."
      (toggle-tabline!))
  `);

  // Now that the stdlib + the mode machinery are loaded, choose the major
  // mode for the initial buffer from its name (e.g. a `.md` file gets
  // markdown-mode, so Markdown's C-c bindings dispatch). bindCursor is
  // already in place, so choose-major-mode! operates on the live view.
  interpreter.call('-spine-choose-major-mode');

  /**
   * Visit a file: read it (via the openFile effect) and, if it isn't already
   * open, ADD it as a NEW buffer in the registry (multi-buffer: find-file no
   * longer replaces the current buffer), then switch the ACTIVE client to it.
   * Returns the buffer's id on success, or null on failure. The server
   * re-snapshots the active client onto the buffer after this.
   *
   * Emacs `find-file` semantics: a second visit of an already-open file
   * SWITCHES to the existing buffer rather than adding a duplicate. This both
   * shares one buffer across windows (the Model-B payoff — edit it in lockstep)
   * and avoids a `name<2>`-suffixed duplicate, whose suffixed name also broke
   * the client's extension-based syntax highlighting (`foobar.html<2>` doesn't
   * end in `.html`). Reuse keeps any unsaved edits in the open buffer (Emacs
   * does not revert from disk on re-visit).
   *
   * @param {string} path - An absolute path.
   * @returns {string | null} The buffer id, or null.
   */
  function visitFile(path) {
    const result = openFile(path);
    if (!result) {
      statusText = `find-file: cannot open ${path}`;
      onStatus(statusText);
      return null;
    }
    // Record the resolved absolute path so save-buffer (C-x C-s) writes back
    // to the right file. openFile returns it; fall back to the typed path.
    const absPath = typeof result.path === 'string' && result.path !== ''
      ? result.path
      : path;
    // A DIRECTORY: open it as a directory-view DATA-SOURCE (default kind from
    // the host — directory-tree). The client mounts the directory element-view,
    // which lists the directory itself; no text mirror.
    if (result.directory) {
      return openDirectorySource(absPath, result.kind, result.name);
    }
    // A MEDIA file (image/audio/video/pdf): create (or reuse) a non-text
    // DATA-SOURCE and switch the focused leaf to it — the client mounts the
    // matching element-view and loads the bytes itself (never the text mirror).
    if (result.media) {
      const src = dataSources.findByPath(absPath)
        ?? dataSources.add({ kind: result.kind, name: result.name, filePath: absPath });
      switchClientToSource(activeClientIndex, src.id);
      statusText = '';
      onStatus('');
      return src.id;
    }
    // Already open? Switch to the EXISTING buffer (shared across windows; its
    // unsaved edits preserved) instead of adding a duplicate.
    const existing = registry.findByPath(absPath);
    if (existing) {
      switchClientToBuffer(activeClientIndex, existing.id);
      statusText = '';
      onStatus('');
      return existing.id;
    }
    const entry = registry.add(result.text, result.name, absPath);
    entry.savedText = result.text;
    // Restore the file's companion metadata (sticky notes + bookmarks) from its
    // `.godot-metadata` sidecar BEFORE any client touches it, so the bookmark
    // engine relocates from saved context the first time the outline is opened.
    seedMetadata(entry, absPath);
    // Switch the active client to the new buffer (mints its view, derives
    // the major mode, leaves the buffer's own overlays — none yet — intact).
    switchClientToBuffer(activeClientIndex, entry.id);
    statusText = '';
    onStatus('');
    return entry.id;
  }

  /** Open the directory at ABSPATH as a directory-view DATA-SOURCE of KIND
   *  (directory-tree / directory-columns) and switch the active client's focused
   *  leaf to it. Reuses an existing source for the SAME path AND kind (re-opening
   *  switches rather than duplicates); a different kind on the same path mints a
   *  new source (tree and columns are distinct views). Returns the source id. */
  function openDirectorySource(absPath, kind, name) {
    const existing = dataSources.list()
      .find((s) => s.filePath === absPath && s.kind === kind);
    const src = existing ?? dataSources.add({ kind, name, filePath: absPath });
    switchClientToSource(activeClientIndex, src.id);
    statusText = '';
    onStatus('');
    return src.id;
  }

  /**
   * Open a directory as a directory-view DATA-SOURCE of an EXPLICIT kind (the
   * `directory-tree` / `directory-columns` commands). Validates the path is a
   * directory via the openFile effect (the host marks it `directory:true`); a
   * non-directory path surfaces a status and is a no-op.
   *
   * @param {string} path
   * @param {string} kind - 'directory-tree' | 'directory-columns'
   * @returns {string | null} The data-source id, or null.
   */
  function visitDirectory(path, kind) {
    const result = openFile(path);
    if (!result || !result.directory) {
      statusText = `directory: not a directory: ${path}`;
      onStatus(statusText);
      return null;
    }
    const absPath = typeof result.path === 'string' && result.path !== ''
      ? result.path
      : path;
    return openDirectorySource(absPath, kind, result.name);
  }

  /**
   * Open an `element` element-view DATA-SOURCE from a renderer-computed SPEC and
   * switch the active client's focused leaf to it. The renderer owns spec
   * computation (define-element-view, host-file-url, user config) and sends the
   * finished spec — `{ name, tag, moduleUrl, attrs, fit, keyboard, noFocus }` —
   * which the server holds as a data-source so it gets a pane slot + restore.
   * The client mounts <element-view> from the spec carried on the PANE_TREE leaf.
   * Reuses an existing source with the SAME tag (re-running the command reveals
   * it rather than duplicating). A `noFocus` spec (a helper panel that acts on
   * the document, e.g. bib-search) opens BESIDE the focused leaf in a split,
   * keeping focus on the document; a normal one switches the focused leaf.
   * Returns the source id, or null on a bad spec.
   *
   * @param {object} spec
   * @returns {string | null}
   */
  function openElementSource(spec) {
    const s = spec && typeof spec === 'object' ? spec : {};
    const tag = typeof s.tag === 'string' ? s.tag : '';
    if (tag === '') return null;
    const state = {
      tag,
      moduleUrl: typeof s.moduleUrl === 'string' ? s.moduleUrl : '',
      attrs: Array.isArray(s.attrs) ? s.attrs : [],
      fit: typeof s.fit === 'string' ? s.fit : 'center',
      keyboard: typeof s.keyboard === 'string' ? s.keyboard : 'grab',
      noFocus: s.noFocus === true,
    };
    const name = typeof s.name === 'string' && s.name !== '' ? s.name : tag;
    const existing = dataSources.list()
      .find((d) => d.kind === 'element' && d.state && d.state.tag === tag);
    if (existing) {
      // Already open: a normal element-view switches to it; a no-focus panel is
      // already beside the document — leave it (no duplicate split).
      if (!existing.state.noFocus) switchClientToSource(activeClientIndex, existing.id);
      statusText = '';
      onStatus('');
      return existing.id;
    }
    const src = dataSources.add({ kind: 'element', name, state });
    if (state.noFocus) openSourceBesideFocus(activeClientIndex, src.id);
    else switchClientToSource(activeClientIndex, src.id);
    statusText = '';
    onStatus('');
    return src.id;
  }

  /** Open data-source SRCID BESIDE the focused (document) leaf of CLIENT INDEX:
   *  split side-by-side, put the source in the new pane, and restore focus to
   *  the document — a `:no-focus` helper panel (bib-search) that acts on the
   *  active document. Falls back to a plain switch if the split can't happen. */
  function openSourceBesideFocus(index, srcId) {
    const model = paneModels.get(index);
    if (!model) return switchClientToSource(index, srcId);
    const docLeafId = model.focusedId;
    const docId = model.focusedBufferId();
    const newLeaf = model.split('horizontal', 0.66, 'after'); // new pane focused
    if (!newLeaf) return switchClientToSource(index, srcId);
    model.setFocusedBuffer(srcId);  // the new (focused) pane shows the panel
    noteClientBuffer(index, srcId); // the panel joins the window's open set
    model.focusPane(docLeafId);     // focus returns to the document
    // Re-bind + resync the client onto the (still-focused) document so its live
    // mirror + interpreter binding follow. A path-less scratch (no docId) or a
    // non-text doc needs no text re-bind — the onChange above already re-pushed
    // the PANE_TREE.
    if (docId && registry.has(docId)) switchClientToBuffer(index, docId);
    else onBufferSwitched(model.focusedBufferId());
    return srcId;
  }

  /**
   * Open a JUKEBOX DATA-SOURCE for a directory of audio files. SPEC is the
   * server-scanned listing `{ dir, tracks, art, name }` (the host owns the
   * filesystem; it scans + filters audio + finds album art). Switches the
   * active client's focused leaf to it; the client mounts <jukebox-view> and
   * handles playback / per-track labels / art client-side. Reuses an existing
   * source for the SAME directory (re-running reveals it). Returns the id.
   *
   * @param {{ dir: string, tracks?: string[], art?: string|null, name?: string }} spec
   * @returns {string | null}
   */
  function openJukebox(spec) {
    const s = spec && typeof spec === 'object' ? spec : {};
    const dir = typeof s.dir === 'string' ? s.dir : '';
    if (dir === '') return null;
    const state = {
      dir,
      tracks: Array.isArray(s.tracks) ? s.tracks : [],
      art: typeof s.art === 'string' ? s.art : null,
    };
    const name = typeof s.name === 'string' && s.name !== ''
      ? s.name : `*Jukebox: ${dir}*`;
    const existing = dataSources.list()
      .find((d) => d.kind === 'jukebox' && d.state && d.state.dir === dir);
    const src = existing ?? dataSources.add({ kind: 'jukebox', name, state });
    switchClientToSource(activeClientIndex, src.id);
    statusText = '';
    onStatus('');
    return src.id;
  }

  // --- bookmarks (server-owned, edit-tracked) --------------------------
  //
  // Bookmarks graduate to the server like overlays: each is an L2 MARKER on a
  // buffer (rides edits) plus a record on `entry.buffer.metadata.bookmarks`,
  // persisted to the file's `.godot-metadata` sidecar. The engine is the SAME
  // apps/desktop/src/bookmarks.js the in-renderer app runs (pure / Node-safe),
  // one instance PER buffer entry, bound to that entry's L2 buffer. The outline
  // is a MUTABLE 'bookmark' data-source whose `state.records` carry the wire
  // snapshot; EXPLICIT bookmark ops re-derive + fan it out (setState →
  // onStateChange → PANE_TREE), while ordinary source edits only PERSIST (the
  // open outline refreshes on the next explicit op / `g` — the Core-first scope,
  // so a keystroke in the document doesn't spam every window a fresh PANE_TREE).

  /** Seed ENTRY's buffer metadata from its file's `.godot-metadata` sidecar (so
   *  restored bookmarks + sticky notes are present before the bookmark engine
   *  attaches and relocates them). A no-op for a path-less / sidecar-less file. */
  function seedMetadata(entry, absPath) {
    if (!entry || typeof absPath !== 'string' || absPath === '') return;
    const data = readMetadata(absPath);
    if (data && typeof data === 'object') entry.buffer.metadata = data;
  }

  /** The bookmark engine for ENTRY, created (and seeded from the buffer's
   *  restored sidecar metadata) on first use. `setBuffer` relocates each record
   *  from its stored context and pins a fresh marker, so positions survive edits
   *  the engine wasn't watching. The engine's onChange persists ONLY (no
   *  fan-out): a source edit shifts markers + re-baselines the sidecar quietly. */
  function bookmarksFor(entry) {
    let engine = bookmarkEngines.get(entry.id);
    if (!engine) {
      // Restore from the sidecar if this entry's metadata wasn't seeded at visit
      // — a session-restored or boot buffer doesn't go through visitFile's seed,
      // so without this its saved bookmarks wouldn't load on the next launch.
      if (entry.filePath && !entry.buffer.metadata) seedMetadata(entry, entry.filePath);
      engine = createBookmarks({ onChange: () => persistMetadata(entry) });
      engine.setBuffer(entry.buffer);
      bookmarkEngines.set(entry.id, engine);
    }
    return engine;
  }

  /** Persist ENTRY's companion metadata (bookmarks + any sticky notes) to its
   *  sidecar via the host effect (the server debounces + atomic-writes it). A
   *  path-less buffer keeps its bookmarks in memory only — nothing to write. */
  function persistMetadata(entry) {
    if (!entry || !entry.filePath) return;
    writeMetadata(entry.filePath, entry.buffer.metadata ?? {});
  }

  /** The wire snapshot of ENTRY's bookmarks for the outline view: each record at
   *  its CURRENT (edit-tracked) offset, plus the line/column the client renders
   *  (it has no buffer to compute them) and the outline depth/collapsed flag.
   *  Document-ordered (siblings by position, subtrees intact); the order is also
   *  PERSISTED by mutating the stored array in place — exactly as the renderer
   *  view's paint() does, so a bookmark set mid-document lands where it belongs. */
  function bookmarkRecordsWire(entry) {
    const recs = entry.buffer.metadata && entry.buffer.metadata.bookmarks;
    if (!Array.isArray(recs) || recs.length === 0) return [];
    if (recs.length > 1) recs.splice(0, recs.length, ...sortByDocumentPosition(recs));
    return recs.map((b) => {
      const offset = Math.max(0, Math.min(b.anchor ?? 0, entry.buffer.length));
      const { line, column } = entry.buffer.positionAt(offset);
      return {
        id: b.id, name: b.name, anchor: offset, line, column,
        depth: b.depth ?? 0, collapsed: !!b.collapsed,
      };
    });
  }

  /** Re-push ENTRY's bookmarks to EVERY outline viewing that file (across windows,
   *  following or pinned): re-derive the wire records + setState, which fans a
   *  fresh PANE_TREE to each client showing that source (the mutable data-source
   *  seam). Bookmarks are per-FILE (the records live on the buffer), so a set /
   *  delete must refresh all outlines on that file, not just one. No-op when none
   *  is open for ENTRY. */
  function refreshBookmarkSource(entry) {
    for (const src of dataSources.list()) {
      if (src.kind === 'bookmark' && src.state && src.state.sourceBufferId === entry.id) {
        dataSources.setState(src.id, { ...src.state, records: bookmarkRecordsWire(entry) });
      }
    }
  }

  /** The wire state for the bookmark outline pointed at TEXT buffer ENTRY: its
   *  source id + display name + the document-ordered records. */
  function bookmarkOutlineState(entry) {
    return {
      sourceBufferId: entry.id,
      sourceName: entry.buffer.name,
      records: bookmarkRecordsWire(entry),
    };
  }

  /** Whether SRC is a PINNED bookmark outline (frozen to its file — doesn't
   *  follow focus). The flag rides the wire `state` so the client shows the
   *  thumbtack. */
  function isPinnedOutline(src) {
    return !!(src && src.state && src.state.pinned);
  }

  /** The wire state for a FOLLOWING bookmark outline pointed at ENTRY (pinned
   *  cleared — only a following outline is ever re-targeted). */
  function followingOutlineState(entry) {
    return { ...bookmarkOutlineState(entry), pinned: false };
  }

  /** The FOLLOWING (unpinned) bookmark outline owned by client INDEX, or null.
   *  Each window owns its own outline(s) (per-window scope). A PINNED outline is
   *  excluded: it's frozen to a file and there may be several per window. */
  function followingOutlineOf(index) {
    return dataSources.list().find(
      (s) => s.kind === 'bookmark' && s._ownerClient === index && !isPinnedOutline(s)) ?? null;
  }

  /** Open (or reveal) the bookmark OUTLINE for the active client's current text
   *  buffer (C-x r l). Each WINDOW has its own FOLLOWING outline (a mutable
   *  'bookmark' data-source) that re-targets to whichever file that window
   *  focuses. Re-running reveals + re-targets that following outline; but once it
   *  has been PINNED (frozen to a file via the thumbtack), there's no following
   *  outline, so this spawns a fresh one — that's how a split ends up with two
   *  outlines (one pinned per file). Opens in a split BESIDE the document with
   *  focus on the outline. Returns the source id, or null when there's no text
   *  buffer to annotate. */
  function openBookmarkView() {
    const entry = activeEntry;
    if (!entry || !registry.has(entry.id)) return null;
    bookmarksFor(entry); // ensure markers + live anchors before snapshotting
    let src = followingOutlineOf(activeClientIndex);
    if (src) {
      dataSources.setState(src.id, followingOutlineState(entry));
    } else {
      src = dataSources.add({ kind: 'bookmark', name: '*Bookmarks*', state: followingOutlineState(entry) });
      src._ownerClient = activeClientIndex; // per-window ownership (server-side only)
    }
    openBookmarkBeside(activeClientIndex, src.id);
    statusText = '';
    onStatus('');
    return src.id;
  }

  /** Follow focus: re-target the active client's FOLLOWING outline(s) to its
   *  FOCUSED text buffer. Skips PINNED outlines (they stay on their file) and
   *  skips entirely when the focused leaf is a data-source (the outline / media) —
   *  the outlines keep their last text target. Called after any focus / buffer
   *  switch. (Re-targets ALL of the window's following outlines, so unpinning one
   *  while another exists never leaves an orphan that follows nothing.) */
  function followBookmarkOutline() {
    const focusedId = currentBufferIdOf(activeClientIndex);
    if (!registry.has(focusedId)) return;
    const entry = registry.get(focusedId);
    let prepared = false;
    for (const src of dataSources.list()) {
      if (src.kind !== 'bookmark' || src._ownerClient !== activeClientIndex) continue;
      if (isPinnedOutline(src)) continue;
      if (src.state && src.state.sourceBufferId === entry.id) continue; // already on it
      if (!prepared) { bookmarksFor(entry); prepared = true; }
      dataSources.setState(src.id, followingOutlineState(entry));
    }
  }

  /** Reveal SRCID in a pane of CLIENT INDEX beside its document, FOCUSING the
   *  outline (unlike bib-search's no-focus panel — bookmarks are a navigator you
   *  drive). Reuses a pane already showing it; otherwise splits the focused
   *  (document) leaf and puts the outline in the new pane. */
  function openBookmarkBeside(index, srcId) {
    const model = paneModels.get(index);
    if (!model) return switchClientToSource(index, srcId);
    const shown = model.leaves().find((l) => model.stateOf(l.id)?.bufferId === srcId);
    if (shown) model.focusPane(shown.id);
    else if (!model.split('horizontal', 0.7, 'after')) {
      return switchClientToSource(index, srcId);
    }
    return switchClientToSource(index, srcId);
  }

  /** Apply an outline op from the bookmark VIEW to its source buffer's records.
   *  OP is `{ op, id?, name? }`. EDIT ops (rename / delete / indent / outdent /
   *  toggle) mutate the records, persist, and fan the fresh outline out. JUMP
   *  moves the document's point to the bookmark + focuses its pane, returning
   *  TRUE so the server re-syncs the client onto the document. Every other op
   *  returns false (the setState fan-out already refreshed the outline). */
  function applyBookmarkOp(srcId, op) {
    const src = dataSources.get(srcId);
    if (!src || src.kind !== 'bookmark') return false;
    const entry = registry.get(src.state && src.state.sourceBufferId);
    if (!entry) return false;
    const engine = bookmarksFor(entry);
    const recs = (entry.buffer.metadata && entry.buffer.metadata.bookmarks) || [];
    const kind = op && typeof op === 'object' ? String(op.op ?? '') : '';
    const recById = (id) => recs.find((b) => b.id === id);

    if (kind === 'pin') {
      // The thumbtack: toggle whether this outline is FROZEN to its file. Pinned
      // outlines are skipped by follow-focus (they stay put); unpinning lets it
      // follow again on the next focus change. The flag rides the wire state, so
      // the fan-out updates the thumbtack icon.
      dataSources.setState(src.id, { ...src.state, pinned: !isPinnedOutline(src) });
      return false;
    }
    if (kind === 'refresh') {
      // `g` in the outline: re-derive the wire from the CURRENT (edit-tracked)
      // anchors, so line/column reflect source edits made since it last opened
      // (the engine keeps anchors current; this just re-snapshots + fans out).
      refreshBookmarkSource(entry);
      return false;
    }
    if (kind === 'jump') {
      const rec = recById(op.id) ?? recs.find((b) => b.name === op.name);
      return rec ? bookmarkJump(entry, rec.name) : false;
    }
    if (kind === 'delete') {
      const rec = recById(op.id);
      if (rec) { engine.remove(rec.name); refreshBookmarkSource(entry); }
      return false;
    }
    if (kind === 'rename') {
      const rec = recById(op.id);
      const next = String(op.name ?? '').trim();
      if (rec && next !== '') { rec.name = next; persistMetadata(entry); refreshBookmarkSource(entry); }
      return false;
    }
    if (kind === 'indent' || kind === 'outdent') {
      const i = recs.findIndex((b) => b.id === op.id);
      const fn = kind === 'indent' ? outlineIndent : outlineOutdent;
      if (i >= 0 && fn(recs, i)) { persistMetadata(entry); refreshBookmarkSource(entry); }
      return false;
    }
    if (kind === 'toggle') {
      const rec = recById(op.id);
      if (rec) { rec.collapsed = !rec.collapsed; persistMetadata(entry); refreshBookmarkSource(entry); }
      return false;
    }
    return false;
  }

  /** Jump the active client to bookmark NAME in source ENTRY: focus the pane
   *  showing the document (or switch the focused leaf onto it when no pane shows
   *  it), bind it, move point to the bookmark's live offset, and recenter.
   *  Returns true so the caller (the BOOKMARK_OP handler) re-syncs the client. */
  function bookmarkJump(entry, name) {
    const index = activeClientIndex;
    const model = paneModels.get(index);
    const docLeaf = model
      ? model.leaves().find((l) => model.stateOf(l.id)?.bufferId === entry.id)
      : null;
    if (docLeaf) model.focusPane(docLeaf.id);
    else switchClientToBuffer(index, entry.id);
    setActiveClient(index); // bind `buffer` = entry.buffer + the doc view's cursor
    const moved = bookmarksFor(entry).jump(name); // moves entry.buffer.point
    if (moved) onScroll({ kind: 'recenter', line: entry.buffer.positionAt(entry.buffer.point).line });
    return true;
  }

  /**
   * Load a CRASH-RECOVERED buffer into the registry (recover-on-startup).
   * The recovered text is the buffer's unsaved state at crash time; it must
   * present as DIRTY relative to disk so the user knows it needs saving — so
   * the saved-text baseline is set to the on-disk content (the recovered text
   * differs from it by exactly the lost edits), via the optional
   * `diskBaseline`. When the on-disk content is unknown, the baseline is left
   * differing (empty) so the buffer is conservatively marked modified. Does
   * NOT switch any client; the server lists/surfaces recovered buffers. Returns
   * the new buffer id.
   *
   * @param {{ name?: string, filePath?: string|null, text: string, diskBaseline?: string }} rec
   * @returns {string}
   */
  function recoverBuffer(rec) {
    const text = String(rec.text ?? '');
    const name = rec.name || 'recovered';
    const filePath = typeof rec.filePath === 'string' && rec.filePath !== ''
      ? rec.filePath
      : null;
    const entry = registry.add(text, name, filePath);
    // A recovered buffer belongs to window 1 (the session window) — it doesn't
    // switch any client, so note it explicitly or it'd be in no window's tabline.
    noteClientBuffer(0, entry.id);
    // Baseline = on-disk content when known, else a value that differs from
    // the recovered text (so the buffer reads as modified / shows ●).
    if (typeof rec.diskBaseline === 'string') {
      entry.savedText = rec.diskBaseline;
    } else {
      entry.savedText = text === '' ? ' ' : '';
    }
    return entry.id;
  }

  // --- save (real disk write, atomic) -----------------------------------
  //
  // save-buffer writes the ACTIVE buffer's text to its file path via the
  // saveFile effect (the server does the atomic temp-file + rename); on
  // success the saved-text baseline is re-set so the ● dirty flag clears.

  /**
   * Save the active buffer to its file path. Returns a status string the
   * Lisp command branches on:
   *   - "no-path" — the buffer has no path (a new/scratch buffer); the
   *     command falls back to write-file (prompt for a path).
   *   - "ok"      — the bytes were written and the baseline re-set (clean).
   *   - "error"   — the disk write failed (the error is surfaced as status).
   *
   * @returns {"ok" | "no-path" | "error"}
   */
  function saveActiveBuffer() {
    if (!activeEntry.filePath) return 'no-path';
    return writeActiveBufferTo(activeEntry.filePath);
  }

  /**
   * Write the active buffer's text to PATH (atomic), rebind the buffer's
   * file path to it, and re-baseline the saved text. Used by save-buffer
   * (to the existing path) and write-file / save-as (to a new path).
   *
   * @param {string} path - The destination path.
   * @returns {"ok" | "error"}
   */
  function writeActiveBufferTo(path) {
    const target = String(path ?? '').trim();
    if (target === '') {
      statusText = 'write-file: no path given';
      onStatus(statusText);
      return 'error';
    }
    const text = buffer.text;
    let result;
    try {
      result = saveFile({ path: target, text });
    } catch (error) {
      result = { ok: false, error: error && error.message };
    }
    if (!result || !result.ok) {
      statusText = `Save failed: ${(result && result.error) || 'unknown error'}`;
      onStatus(statusText);
      return 'error';
    }
    // The disk now matches the buffer: bind the path + re-baseline so the
    // dirty flag clears, mirroring the real app's saved-baseline reset.
    registry.setFilePath(activeEntry, target);
    registry.markSaved(activeEntry);
    statusText = `Wrote ${activeEntry.buffer.name}`;
    onStatus(statusText);
    return 'ok';
  }

  // --- multi-buffer / multi-window window-state (the Model-B payoff) ----
  //
  // The server holds N buffers and serves N clients/windows. Each window owns
  // a PANE TREE (paneModels); the buffer a window currently edits is its
  // FOCUSED leaf's buffer. A leaf keeps its OWN view (point/mark/scroll) over
  // the buffer, so two leaves on the same buffer have independent cursors —
  // and so do two windows. Before processing a client's intent the server
  // makes that client active (setActiveClient), which binds the interpreter
  // to the client's focused leaf's buffer + that leaf's view.

  /** The client index the server is currently serving (so a command's effect
   *  — kill-buffer, list-buffers, split-window — targets the right window). */
  let activeClientIndex = 0;

  /** Register a new client/window. Returns a fresh, never-reused index.
   *
   *  With `{ freshScratch: true }` (G4 Step 1 — a real new window) it opens on
   *  its OWN empty *scratch* buffer, private to this window, so the window
   *  starts as a single composable pane rather than a tabline of every file.
   *  Otherwise the leaf starts on the ACTIVE client's current buffer (the
   *  two-windows-on-one-buffer path the multi-client tests exercise), falling
   *  back to any live window and finally the seed buffer.
   *
   *  @param {{ freshScratch?: boolean }} [opts]
   */
  function addClientView(opts = {}) {
    const index = nextClientIndex++;
    clientIndices.add(index);
    let startId;
    if (opts.freshScratch) {
      const scratch = registry.add('', '*scratch*', null);
      startId = scratch.id;
    } else {
      startId =
        paneModels.get(activeClientIndex)?.focusedBufferId()
        ?? paneModels.values().next().value?.focusedBufferId()
        ?? initialEntry.id;
    }
    clientBuffers.set(index, new Set([startId]));
    makePaneModel(index, startId);
    return index;
  }

  /** Drop client INDEX's window-state (its window closed). Removes its pane
   *  tree, viewport, and its per-buffer views across EVERY buffer; the buffers
   *  themselves outlive the client. Idempotent. If it was the active client,
   *  the active index falls back to a survivor (the server re-binds via
   *  setActiveClient before its next intent regardless). */
  function removeClientView(index) {
    const set = clientBuffers.get(index);
    clientIndices.delete(index);
    paneModels.delete(index);
    clientViewports.delete(index);
    clientBuffers.delete(index);
    registry.dropClient(index);
    // The bookmark outline(s) are per-window — drop this window's own so they
    // don't linger after it closes.
    for (const s of dataSources.list()) {
      if (s.kind === 'bookmark' && s._ownerClient === index) dataSources.remove(s.id);
    }
    // Reap this window's buffers that NO other window shows AND that are an
    // empty, path-less scratch (a fresh window's unused scratch shouldn't linger
    // in the pool). A scratch the user typed into, or any file-backed buffer, is
    // left behind (reachable via C-x C-b), so no edits are lost.
    if (set) {
      const shownElsewhere = new Set();
      for (const s of clientBuffers.values()) for (const id of s) shownElsewhere.add(id);
      for (const id of set) {
        if (shownElsewhere.has(id)) continue;
        const e = registry.get(id);
        if (e && !e.filePath && e.buffer.text === '' && registry.count() > 1) {
          registry.remove(id);
        }
      }
    }
    if (activeClientIndex === index) {
      activeClientIndex = clientIndices.values().next().value ?? 0;
    }
  }

  /** The buffer entry the FOCUSED leaf of client INDEX shows (defaults to the
   *  seed buffer if somehow unset). */
  function entryForClient(index) {
    const id = paneModels.get(index)?.focusedBufferId() ?? initialEntry.id;
    return registry.get(id) ?? initialEntry;
  }

  /** Make client INDEX active: bind the interpreter to its FOCUSED leaf's
   *  buffer + that leaf's view. Subsequent handleKey/runCommand/overlay/pane
   *  primitives operate on this window's focused pane + buffer. */
  function setActiveClient(index) {
    if (!clientIndices.has(index)) return;
    activeClientIndex = index;
    const model = paneModels.get(index);
    const entry = entryForClient(index);
    // Bind the FOCUSED leaf's own view (its per-pane cursor over the buffer).
    const v = (model && model.focusedView()) || registry.viewFor(entry.id, index);
    bindActive(entry, v);
    // The major mode is a property of the buffer; re-derive it so the
    // mode-keymap chain resolves against THIS buffer's mode (a markdown
    // buffer's C-c, a .js buffer's global C-c, …).
    interpreter.call('-spine-choose-major-mode');
    followBookmarkOutline(); // the bookmark outline follows the focused file
  }

  /**
   * Switch a client's FOCUSED pane to buffer ID. Re-points the focused leaf
   * (minting its view over the new buffer), binds the interpreter (if this is
   * the active client), re-derives the major mode, and raises onBufferSwitched
   * so the server re-snapshots the client onto its new buffer. Returns true on
   * success.
   *
   * @param {number} index - The client to switch.
   * @param {string} id - The target buffer id.
   * @returns {boolean}
   */
  function switchClientToBuffer(index, id) {
    // A non-text DATA-SOURCE id (media) routes to the source-switch path.
    if (dataSources.has(id)) return switchClientToSource(index, id);
    if (!registry.has(id)) return false;
    // The window now has this buffer open (covers find-file / new-view! / the
    // C-x C-b picker / C-x b — all switch here). It joins this window's tabline.
    noteClientBuffer(index, id);
    const model = paneModels.get(index);
    if (model) {
      // Point the focused leaf at the new buffer (re-mints its leaf view).
      const wasActive = index === activeClientIndex;
      if (!wasActive) activeClientIndex = index; // setFocusedBuffer affects the focused leaf
      model.setFocusedBuffer(id);
      activeClientIndex = wasActive ? index : activeClientIndex;
    }
    if (index === activeClientIndex) {
      const entry = registry.get(id);
      const v = (model && model.focusedView()) || registry.viewFor(id, index);
      bindActive(entry, v);
      interpreter.call('-spine-choose-major-mode');
      followBookmarkOutline(); // the bookmark outline follows the focused file
    }
    onBufferSwitched(id);
    return true;
  }

  /**
   * Switch a client's FOCUSED pane to a non-text DATA-SOURCE (media). The leaf
   * shows the source by id (a tabline leaf adds it as a tab); the source mints NO
   * text view (makeLeafView returns null), so the interpreter binding falls back
   * to a real text buffer via setActiveClient (no keys edit a media leaf — the
   * client mounts an element-view, not a text-view, so nothing routes to
   * handle-key). Re-syncs via onBufferSwitched; the model's onChange re-pushes
   * the PANE_TREE that carries the media descriptor the client renders.
   *
   * @param {number} index
   * @param {string} id - A data-source id.
   * @returns {boolean}
   */
  function switchClientToSource(index, id) {
    if (!dataSources.has(id)) return false;
    noteClientBuffer(index, id);
    const model = paneModels.get(index);
    if (model) {
      const wasActive = index === activeClientIndex;
      if (!wasActive) activeClientIndex = index;
      model.setFocusedBuffer(id);
      activeClientIndex = wasActive ? index : activeClientIndex;
    }
    if (index === activeClientIndex) setActiveClient(index);
    onBufferSwitched(id);
    return true;
  }

  /**
   * Seed client INDEX's focused leaf as a TABLINE with a given curated tab set
   * (the unify: window 1's restored session presents as a tabline leaf, so it
   * renders through the same pane pipeline as every window). IDS is the ordered
   * tab list (each noted in the window's open-set); ACTIVEID the active tab.
   * Rebinds the interpreter when this is the active client. Returns true when
   * seeded. The model's onChange re-pushes the PANE_TREE.
   *
   * @param {number} index
   * @param {string[]} ids
   * @param {string} activeId
   * @returns {boolean}
   */
  function seedClientTabline(index, ids, activeId) {
    const model = paneModels.get(index);
    if (!model) return false;
    // Keep TEXT buffers AND non-text DATA-SOURCES (media) — restored media must
    // become tabs too, not just text files (else they're open-but-hidden).
    const open = Array.isArray(ids)
      ? ids.filter((id) => registry.has(id) || dataSources.has(id))
      : [];
    for (const id of open) noteClientBuffer(index, id);
    const ok = model.seedFocusedTabline(open, activeId);
    if (ok && index === activeClientIndex) {
      const entry = registry.get(model.focusedBufferId()) ?? entryForClient(index);
      const v = model.focusedView() || registry.viewFor(entry.id, index);
      bindActive(entry, v);
      interpreter.call('-spine-choose-major-mode');
    }
    return ok;
  }

  /** Serialise client INDEX's window layout to a path-keyed persistence blob
   *  (the session's per-window `rootPane`), or null when the window is gone.
   *  Each leaf's buffer resolves to its FILE PATH (text via the registry, media
   *  via the data-sources); a path-less buffer → a null leaf-view (restores to a
   *  scratch). The geometry (bounds/display) is added by the server, which holds
   *  the client's reported window frame — the spine knows only the logical tree. */
  function serializeWindow(index) {
    const model = paneModels.get(index);
    if (!model) return null;
    return model.serialiseLayout((bufferId) => {
      if (bufferId == null) return null;
      const e = registry.get(bufferId);
      if (e && e.filePath) return { kind: 'text', path: e.filePath };
      const ds = dataSources.get(bufferId);
      if (!ds) return null;
      // A BOOKMARK outline has no filePath — it identifies its source by
      // `state.sourceBufferId` (+ a pin flag). Serialise it by its SOURCE file +
      // kind so restore reopens an outline, not a text copy of the file.
      if (ds.kind === 'bookmark') {
        const srcEntry = ds.state ? registry.get(ds.state.sourceBufferId) : null;
        const path = srcEntry && srcEntry.filePath ? srcEntry.filePath : null;
        if (!path) return null; // bookmarks over an unsaved buffer can't be restored
        return { kind: 'bookmark', path, pinned: !!(ds.state && ds.state.pinned) };
      }
      // Media / directory data-sources carry their own filePath (suffix-routable).
      return ds.filePath ? { kind: ds.kind, path: ds.filePath } : null;
    });
  }

  /** Restore a per-window bookmark OUTLINE over the file at SOURCEPATH (which must
   *  already be open), pinned or following per the saved leaf. Returns the new
   *  outline data-source's id (the leaf shows it), or null when the source file
   *  didn't open. The mirror of serializeWindow's bookmark branch. */
  function restoreBookmarkOutline(index, sourcePath, pinned) {
    const srcEntry = registry.findByPath(sourcePath);
    if (!srcEntry) return null;
    bookmarksFor(srcEntry); // ensure markers + live anchors before snapshotting
    const src = dataSources.add({
      kind: 'bookmark',
      name: '*Bookmarks*',
      state: { ...bookmarkOutlineState(srcEntry), pinned: !!pinned },
    });
    src._ownerClient = index; // per-window ownership
    return src.id;
  }

  /** Restore client INDEX's window layout from a path-keyed blob (the mirror of
   *  `serializeWindow`). The referenced files must ALREADY be open in the
   *  registry (the caller opens them first, deduped); each path resolves to its
   *  live buffer id, an unresolved path → a scratch leaf. Notes every restored
   *  buffer in the window's open-set and rebinds the active client. Returns true
   *  when a layout was installed. */
  function loadWindowLayout(index, rootBlob) {
    const model = paneModels.get(index);
    if (!model || !rootBlob) return false;
    const resolveId = (viewBlob) => {
      if (!viewBlob || typeof viewBlob.path !== 'string' || viewBlob.path === '') return null;
      // A bookmark leaf reopens as a fresh per-window OUTLINE over its source file
      // (not a text buffer); everything else resolves by path (the files were
      // opened up front — text → registry, media/dir → data-source).
      if (viewBlob.kind === 'bookmark') {
        return restoreBookmarkOutline(index, viewBlob.path, viewBlob.pinned);
      }
      const e = registry.findByPath(viewBlob.path);
      if (e) return e.id;
      const ds = dataSources.findByPath(viewBlob.path);
      return ds ? ds.id : null;
    };
    const ok = model.loadLayout(rootBlob, resolveId);
    if (!ok) return false;
    // The window now shows EXACTLY the restored buffers: reset its open-set
    // before re-noting them. This drops files that were opened only to seed the
    // restore (a multi-window restore opens every window's files up front) and a
    // freshly-spawned window's throwaway scratch — so a window's tabs / View List
    // reflect only its own restored buffers.
    clientBuffers.set(index, new Set());
    for (const leaf of model.leaves()) {
      const s = model.stateOf(leaf.id);
      if (!s) continue;
      if (s.tabline && Array.isArray(s.tabs)) s.tabs.forEach((id) => noteClientBuffer(index, id));
      else noteClientBuffer(index, s.bufferId);
    }
    if (index === activeClientIndex) {
      const entry = registry.get(model.focusedBufferId()) ?? entryForClient(index);
      const v = model.focusedView() || registry.viewFor(entry.id, index);
      bindActive(entry, v);
      interpreter.call('-spine-choose-major-mode');
      followBookmarkOutline();
    }
    return true;
  }

  /** Resolve a buffer NAME to its id (the C-x b switch path), or null. */
  function bufferIdByName(name) {
    const entry = registry.findByName(name);
    return entry ? entry.id : null;
  }

  /** The buffer id the FOCUSED leaf of client INDEX shows. */
  function currentBufferIdOf(index) {
    return paneModels.get(index)?.focusedBufferId() ?? initialEntry.id;
  }

  /** The registry entry backing VIEW (an @editor/view), matched by buffer
   *  identity (a view minted by registry.viewFor binds entry.buffer), or null
   *  when VIEW isn't a view / has no backing entry. Used by the RefTeX
   *  view→file primitives (view-file-path / view-directory). */
  function entryForView(view) {
    if (!view || typeof view !== 'object' || !view.buffer) return null;
    for (const e of registry.list()) {
      if (e.buffer === view.buffer) return e;
    }
    return null;
  }

  /** The buffer-list ROW-PROVIDER for the generic picker (G0b): the open
   *  buffers as picker rows for the ACTIVE client. Each row's `value` is the
   *  buffer id (what an on-choose switch needs); `label` the name; `meta` a
   *  "Nl ●/–" line-count + dirty flag; `current` marks the window's buffer.
   *  Pure data, no L2 objects — the wire shape `normalisePickerRequest` wants. */
  function bufferListRows() {
    const currentId = currentBufferIdOf(activeClientIndex);
    const bufRows = registry.listRecords().map((r) => ({
      label: r.name,
      value: r.id,
      meta: `${r.lineCount}L ${r.modified ? '●' : '–'}`,
      current: r.id === currentId,
    }));
    // Non-text data-sources (media) join the GLOBAL picker too, so C-x C-b can
    // switch to an open image/video/pdf; the meta shows the kind, not a line count.
    const dsRows = dataSources.list().map((s) => ({
      label: s.name,
      value: s.id,
      meta: s.kind,
      current: s.id === currentId,
    }));
    return [...bufRows, ...dsRows];
  }

  /** Every buffer id any leaf of client INDEX shows (a window may have several
   *  panes on different buffers). Used by the kill-buffer re-home: a window is
   *  "affected" if ANY of its panes shows the killed buffer. */
  function buffersShownByClient(index) {
    const model = paneModels.get(index);
    if (!model) return [];
    return model.leaves()
      .map((l) => model.stateOf(l.id)?.bufferId)
      .filter((id) => id != null);
  }

  /** Kill the ACTIVE client's focused buffer, switching every pane (in any
   *  window) showing it to another buffer. Refuses to kill the last buffer
   *  (the registry guard). Called by the kill-current-buffer! primitive. */
  function killActiveBuffer() {
    const index = activeClientIndex;
    const killedId = currentBufferIdOf(index);
    if (registry.count() <= 1) {
      statusText = 'kill-buffer: refusing to kill the only buffer';
      onStatus(statusText);
      return;
    }
    // Pick a survivor buffer (any other than the one being killed).
    const survivor = registry.list().find((e) => e.id !== killedId);
    if (!survivor) return;
    registry.remove(killedId);
    // Drop the killed buffer from EVERY window's open-set (it's gone globally).
    for (const s of clientBuffers.values()) s.delete(killedId);
    // Re-home EVERY pane (across all windows) showing the killed buffer onto
    // the survivor. A window is affected if its focused pane showed it (the
    // simple, tested re-home path: re-point the focused leaf + re-sync).
    for (const [ci, model] of paneModels) {
      for (const leaf of model.leaves()) {
        if (model.stateOf(leaf.id)?.bufferId === killedId) {
          model.focusPane(leaf.id);
          switchClientToBuffer(ci, survivor.id);
        }
      }
    }
    statusText = `Killed buffer; switched to ${survivor.buffer.name}`;
    onStatus(statusText);
  }

  /** The current (active) buffer's major-mode display name (e.g. "Markdown"),
   *  for the modeline. Model-side: the server chose the mode from the
   *  buffer name (choose-major-mode!), so it owns this. */
  function majorModeName() {
    try {
      const name = interpreter.call('major-mode-name');
      return typeof name === 'string' ? name : '';
    } catch {
      return '';
    }
  }

  /** The major-mode display name a SPECIFIC buffer entry would show. The
   *  major mode is a property of the buffer (derived from its name), but the
   *  interpreter only knows the mode of the ACTIVE view — so we briefly bind
   *  the entry, derive its mode, read the name, then restore the active
   *  binding. Read-only (no buffer text touched), so the round-trip is safe.
   *  This keeps a window's modeline mode correct even when another window on
   *  a different buffer is the active one. */
  function majorModeNameFor(entry, v) {
    if (entry === activeEntry) return majorModeName();
    const savedEntry = activeEntry;
    const savedView = view;
    bindActive(entry, v);
    try {
      interpreter.call('-spine-choose-major-mode');
      return majorModeName();
    } catch {
      return '';
    } finally {
      bindActive(savedEntry, savedView);
      interpreter.call('-spine-choose-major-mode');
    }
  }

  // Resolve (once) the general `math-preview-mode` minor-mode map from the
  // server interpreter (math-preview.lisp is in SPINE_STDLIB). It is the same
  // map object the stdlib defined; a buffer's minor-mode list holds it by
  // identity when the mode is on.
  let mathPreviewModeMap;
  let mathPreviewModeResolved = false;
  function resolveMathPreviewModeMap() {
    if (mathPreviewModeResolved) return mathPreviewModeMap;
    mathPreviewModeResolved = true;
    try {
      mathPreviewModeMap = interpreter.evaluate('math-preview-mode');
    } catch {
      mathPreviewModeMap = null;
    }
    return mathPreviewModeMap;
  }

  /** Whether BUFFER has `math-preview-mode` enabled. Walks the buffer's
   *  minor-mode cons list for the stdlib's mode map by identity — the same
   *  test the renderer's math-preview-host does, run HERE on the canonical
   *  buffer so the server can tell each client whether to typeset math (the
   *  renderer's own interpreter is inert under GODOT_SERVER=1). Tolerant: any
   *  missing piece yields false, never throws (the view path calls it often). */
  function bufferHasMathPreview(buffer) {
    const mode = resolveMathPreviewModeMap();
    if (!buffer || mode == null) return false;
    let node = buffer.minorModes;
    let guard = 0;
    while (node && typeof node === 'object' && 'head' in node && 'tail' in node) {
      if (node.head === mode) return true;
      node = node.tail;
      if (++guard > 100000) break;
    }
    return false;
  }

  /** The FOCUSED leaf's view of client INDEX — the view its keyboard edits
   *  (the per-pane cursor over the focused buffer). Falls back to the
   *  registry/active view if a pane model is somehow missing. */
  function focusedViewOf(index) {
    const model = paneModels.get(index);
    if (model) {
      const v = model.focusedView();
      if (v) return v;
    }
    const entry = entryForClient(index);
    return registry.viewFor(entry.id, index) ?? view;
  }

  /** The view-state of a specific client (the point/mark of its FOCUSED pane
   *  over that pane's buffer). Reads the focused leaf's buffer + view, so two
   *  windows — or two panes — on different buffers report different
   *  modelines. */
  function viewStateOf(index) {
    // A media-focused leaf has no text buffer/cursor (the interpreter is bound to
    // a fallback buffer), so report the DATA-SOURCE's name + kind in the modeline
    // — what the user actually sees — rather than the fallback buffer's name.
    const ds = dataSources.get(currentBufferIdOf(index));
    if (ds) {
      return {
        point: 0,
        mark: null,
        name: ds.name,
        // A data-source leaf has no text major mode and never typesets math.
        majorModeName: '',
        mathPreviewActive: false,
        modeline: renderModeline({ name: ds.name, modified: false, line: 1, column: 0, mode: ds.kind }),
        status: statusText,
        modified: false,
      };
    }
    const entry = entryForClient(index);
    const buf = entry.buffer;
    const v = focusedViewOf(index);
    const { line, column } = buf.positionAt(v.point);
    const modified = buf.text !== entry.savedText;
    // The major-mode display name + whether math-preview-mode is on travel as
    // their OWN view-state fields (not just baked into the modeline string), so
    // a client under GODOT_SERVER=1 can pick the math scanner provider + decide
    // whether to typeset — its own interpreter is inert, so the buffer's
    // minor-mode/major-mode state is only knowable from the server.
    const modeName = majorModeNameFor(entry, v);
    return {
      point: v.point,
      mark: v.mark,
      name: buf.name,
      majorModeName: modeName,
      mathPreviewActive: bufferHasMathPreview(buf),
      modeline: renderModeline({
        name: buf.name, modified, line: line + 1, column,
        mode: modeName,
      }),
      status: statusText,
      modified,
    };
  }

  /** A client's FULL cursor set (the primary + every secondary) for its
   *  FOCUSED pane, as plain `[{point, mark}]` — the shape the renderer's
   *  getCursors() returns. The multi-cursor commands build the set on the
   *  active client's view; this surfaces it for the CURSORS message so the
   *  renderer paints every caret. */
  function cursorsOf(index) {
    const v = focusedViewOf(index);
    const cs = Array.isArray(v.cursors) && v.cursors.length
      ? v.cursors
      : [{ point: v.point, mark: v.mark ?? null }];
    return cs.map((c) => ({ point: c.point, mark: c.mark ?? null }));
  }

  /** How many cursors the active client's view has (≥1). The server uses
   *  this to decide a single delta vs a RESYNC after an edit: a
   *  multi-cursor edit makes several L1 edits but emits one change event,
   *  so it needs a whole-buffer resync to replicate faithfully. */
  function activeCursorCount() {
    return Array.isArray(view.cursors) ? view.cursors.length : 1;
  }

  // --- the keymap dispatch ---------------------------------------------
  //
  // A pared `handle-key` in the server's host (JS), in the SAME shape as
  // production keymap.lisp's `handle-key`: resolve the key in the active
  // map (a prefix stack) or the global map; a nested map starts a chord; a
  // command name runs through the REAL run-command; a bare printable
  // self-inserts. The minibuffer steals keys while a prompt is open (the
  // client handles minibuffer input itself, so the server only sees the
  // resolved submit/cancel — handle-key is not called during a prompt).

  /** The active JS prefix map (a global chord is in progress), or null. */
  let activeMap = null;
  let chordPrefix = '';

  function resetChord() {
    activeMap = null;
    chordPrefix = '';
    if (statusText.endsWith('-')) {
      statusText = '';
      onStatus('');
    }
  }

  /** Is a Lisp key-reader pending (read-next-key, e.g. the math-symbol `)? */
  function keyReaderPending() {
    return interpreter.call('-spine-key-reader-pending?') === true;
  }

  /** Resolve a key through the mode chain (or the active mode-chord). One
   *  of: a command name (string), the boolean-ish marker 'prefix', or
   *  false/nil. Re-entry while a mode-chord is active resolves against it. */
  function resolveMode(key) {
    const result = interpreter.call('-spine-resolve', key);
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object' && result.name === 'prefix') {
      return 'prefix';
    }
    return null; // nil / unbound
  }

  /** Is a mode-chord (e.g. after C-c) in progress? */
  function modeChordActive() {
    return interpreter.call('-spine-chord-active?') === true;
  }

  /**
   * Dispatch a key. Returns true when the key was handled. Mirrors
   * keymap.lisp's resolution order: a pending key-reader first, then the
   * active chord (mode or global), then — at rest — the buffer's
   * mode-keymap chain, then the spine's global KEYMAP; a bare printable
   * self-inserts.
   *
   * @param {string} key - A normalised key string (keyEventToString name).
   * @returns {boolean}
   */
  function handleKey(key) {
    // 1. A pending key-reader (read-next-key) steals the key.
    if (keyReaderPending()) {
      interpreter.call('-spine-take-key-reader', key);
      return true;
    }

    // 2. Mid mode-chord (e.g. C-c then b): resolve against the stashed map.
    if (modeChordActive()) {
      const r = resolveMode(key);
      if (r === 'prefix') {
        chordPrefix = `${chordPrefix} ${key}`;
        statusText = `${chordPrefix}-`;
        onStatus(statusText);
        return true;
      }
      // Either a command or unbound — the chord ends.
      if (statusText.endsWith('-')) { statusText = ''; onStatus(''); }
      chordPrefix = '';
      if (typeof r === 'string') runCommand(r);
      return true;
    }

    // 3. Mid global chord (e.g. C-x then C-f).
    if (activeMap !== null) {
      const binding = activeMap[key];
      if (binding && typeof binding === 'object') {
        activeMap = binding;
        chordPrefix = `${chordPrefix} ${key}`;
        statusText = `${chordPrefix}-`;
        onStatus(statusText);
        return true;
      }
      if (typeof binding === 'string') {
        resetChord();
        runCommand(binding);
        return true;
      }
      resetChord(); // unbound mid-chord: abort cleanly
      return true;
    }

    // 4. At rest — try the buffer's mode-keymap chain first (so a mode's
    //    bindings, e.g. Markdown C-c b, win over the global table).
    const modeResult = resolveMode(key);
    if (modeResult === 'prefix') {
      chordPrefix = key;
      statusText = `${chordPrefix}-`;
      onStatus(statusText);
      return true;
    }
    if (typeof modeResult === 'string') {
      runCommand(modeResult);
      return true;
    }

    // 5. The spine's global KEYMAP (motion / editing / kill-yank / …).
    let binding = KEYMAP[key];
    if (key === 'C-x') binding = CX_MAP;
    // The global C-c prefix (multi-cursor) — only reached when no major
    // mode claimed C-c above (step 4). In Markdown, the mode map wins.
    if (key === 'C-c') binding = CC_MAP;
    if (binding && typeof binding === 'object') {
      activeMap = binding;
      chordPrefix = key;
      statusText = `${chordPrefix}-`;
      onStatus(statusText);
      return true;
    }
    if (typeof binding === 'string') {
      runCommand(binding);
      return true;
    }

    // 6. A single printable bound in the-keymap (auto-pair.lisp binds the
    //    bracket/quote characters there). Production resolves the-keymap
    //    before self-insert; the spine does the same so a typed "(" runs
    //    auto-pair-open-paren server-side rather than self-inserting. A miss
    //    is #f → fall through to plain self-insert below.
    if (typeof key === 'string' && [...key].length === 1) {
      const charBinding = interpreter.call('-spine-the-keymap-get', key);
      if (typeof charBinding === 'string') {
        runCommand(charBinding);
        return true;
      }
      if (charBinding && typeof charBinding === 'object'
          && typeof charBinding.name === 'string') {
        runCommand(charBinding.name); // a bound Sym
        return true;
      }
    }

    // 7. At rest, unbound: self-insert a bare printable. Route the
    //    *last-command* update through it too (the yank-pop subtlety —
    //    see PRIMITIVE-SPLIT.md): typing must invalidate a pending yank.
    if (typeof key === 'string' && [...key].length === 1) {
      interpreter.evaluate("(set! *last-command* 'self-insert)");
      buffer.insert(key);
      return true;
    }
    return false;
  }

  // Did the last dispatched command perform an undo or redo? A change-group
  // undo emits SEVERAL L1 edits but only ONE L2 change event, so the single
  // forwarded delta can't replicate it on the client mirror (proven: it
  // desyncs). The server therefore RESYNCs (full text + cursors) after an
  // undo/redo, exactly as it does for a multi-cursor edit. This flag tells it
  // an undo/redo just ran; the server reads-and-clears it via consumeHistoryOp.
  let lastWasHistoryOp = false;

  /** Run a command by name through the REAL run-command. A name that needs
   *  interactive args (a minibuffer prompt) suspends inside run-command;
   *  the prompt is delivered later via deliverMinibuffer. */
  function runCommand(name) {
    if (name === 'undo' || name === 'redo') lastWasHistoryOp = true;
    interpreter.evaluate(`(run-command (quote ${name}))`);
  }

  /**
   * Apply a PANE_INTENT from a client: a structural request (split / focus /
   * delete / resize). Most map 1:1 onto the REAL panes.lisp commands run
   * through `run-command` against the active window's logical tree — the same
   * commands C-x 2 / 3 / o / 0 / 1 dispatch — so the wire intent and the key
   * path share one implementation. FOCUS_PANE / RESIZE are direct model ops
   * (no Lisp command exists for "focus this exact leaf by id" / "the user
   * dragged this splitter"). The intent runs against client INDEX's window;
   * the active client is set first so the pane primitives target it.
   *
   * @param {number} index - The client/window the intent targets.
   * @param {{ op: string, paneId?: string, ratio?: number }} intent
   * @returns {boolean} Whether the op was recognised.
   */
  function applyPaneIntent(index, intent) {
    if (!intent || typeof intent !== 'object') return false;
    if (!paneModels.has(index)) return false;
    setActiveClient(index); // the pane primitives mutate the active window
    const model = paneModels.get(index);
    switch (intent.op) {
      case 'split-below':
        runCommand('split-vertical');
        return true;
      case 'split-right':
        runCommand('split-horizontal');
        return true;
      case 'other-window':
        runCommand('other-pane');
        return true;
      case 'delete-window':
        runCommand('delete-pane');
        return true;
      case 'delete-other-windows':
        runCommand('delete-other-panes');
        return true;
      case 'focus-pane':
        // A client click: focus a specific leaf by id, then rebind so the
        // next edit lands in it.
        if (model.focusPane(String(intent.paneId ?? ''))) {
          setActiveClient(index);
          return true;
        }
        return false;
      case 'close-tab':
        // Step 3c: close a tab in the focused tabline leaf (un-curate that
        // buffer from THIS tabline; the buffer lives on in the pool). If the
        // active tab closed, the model re-points to a neighbour — the server's
        // MSG.PANE handler sees the focused buffer change and re-syncs.
        return model.closeFocusedTab(String(intent.bufferId ?? ''));
      case 'reorder-tab':
        // Step 3c: drag-reorder a tab in the focused tabline leaf. The active
        // tab is tracked by buffer id, so the order changes but not which tab is
        // active; the model's onChange re-pushes PANE_TREE and the client
        // re-renders the strip in the new order.
        return model.reorderFocusedTab(Number(intent.from), Number(intent.to));
      case 'resize':
        // The client owns the pixels; it echoes the new ratio up so the
        // logical tree records the user's chosen split.
        return model.setSplitRatio(String(intent.paneId ?? ''), Number(intent.ratio));
      default:
        return false;
    }
  }

  /** Read-and-clear the "last dispatch was an undo/redo" flag. The server
   *  calls this after each intent to decide whether to RESYNC (a change-group
   *  undo's single delta is insufficient — see lastWasHistoryOp). */
  function consumeHistoryOp() {
    const was = lastWasHistoryOp;
    lastWasHistoryOp = false;
    return was;
  }

  /** Deliver a minibuffer result to the suspended command (commands.lisp's
   *  `minibuffer-delivered`). Pass null to cancel. Resumes the command's
   *  continuation, which may itself open the next prompt (a chained
   *  interactive spec, e.g. replace-string). */
  function deliverMinibuffer(value) {
    activePrompt = null;
    onMinibufferClose();
    if (value === null) {
      interpreter.evaluate('(minibuffer-delivered nil)');
    } else {
      interpreter.evaluate(
        `(minibuffer-delivered ${JSON.stringify(String(value))})`
      );
    }
  }

  /** Abort the suspended command WITHOUT resuming its body, and close the
   *  prompt. Used when the host fulfils the prompt itself (M-x, find-file):
   *  the command's body is a no-op placeholder, so we drop the
   *  continuation and let the host act. */
  function abortMinibuffer() {
    activePrompt = null;
    onMinibufferClose();
    // Drop the pending continuation in the interpreter so a later
    // (minibuffer-delivered …) can't accidentally resume it.
    interpreter.evaluate('(set! *minibuffer-reader* nil)');
  }

  /** Deliver a generic-picker choice to the suspended command (the spine's
   *  `picker-delivered`, defined in Lisp above), the minibuffer's twin. VALUE
   *  is the chosen row's value (a string/number/boolean — a buffer id, a
   *  command name, a recovery key, …); pass null to CANCEL (the continuation
   *  resumes with nil, so the command does nothing). PICKERID guards against a
   *  stale reply: a choice whose id no longer matches the open picker is
   *  dropped (the picker was superseded by another). Returns whether the reply
   *  was applied. */
  function deliverPicker(value, pickerId) {
    // A reply for a picker that is no longer open (or a different one) is
    // stale — ignore it so it can't resume the wrong command.
    if (!activePicker) return false;
    if (pickerId != null && pickerId !== activePicker.id) return false;
    activePicker = null;
    if (value === null || value === undefined) {
      interpreter.evaluate('(picker-delivered nil)');
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      interpreter.evaluate(`(picker-delivered ${JSON.stringify(value)})`);
    } else {
      interpreter.evaluate(`(picker-delivered ${JSON.stringify(String(value))})`);
    }
    return true;
  }

  /** Cancel the open picker WITHOUT a choice: resume the suspended command's
   *  continuation with nil (so it does nothing) and clear the active picker.
   *  The Escape / C-g path. PICKERID guards against a stale cancel. */
  function cancelPicker(pickerId) {
    return deliverPicker(null, pickerId);
  }

  // --- view-state snapshot ---------------------------------------------
  /** The current point's 1-based line and 0-based column. */
  function pointPosition() {
    const { line, column } = buffer.positionAt(buffer.point);
    return { line: line + 1, column };
  }

  /** A fresh view-state object (protocol ViewState) for the active client.
   *  The modeline is rendered by the shared pure helper in protocol.js, so
   *  the server and any future client agree on its shape. */
  function viewState() {
    const { line, column } = pointPosition();
    const modified = buffer.text !== activeEntry.savedText;
    return {
      point: buffer.point,
      mark: buffer.mark,
      name: buffer.name,
      modeline: renderModeline({
        name: buffer.name, modified, line, column, mode: majorModeName(),
      }),
      status: statusText,
      modified,
    };
  }

  /** @typedef {object} Spine */
  return {
    /** The canonical L2 buffer (read-only access for the server). */
    get buffer() {
      return buffer;
    },
    /** The current view (window-state owner). */
    get view() {
      return view;
    },
    get interpreter() {
      return interpreter;
    },
    handleKey,
    runCommand,
    consumeHistoryOp,
    commandNames,
    deliverMinibuffer,
    abortMinibuffer,
    // the generic picker round-trip (G0b): resolve / cancel the open picker.
    deliverPicker,
    cancelPicker,
    visitFile,
    visitDirectory,
    openElementSource,
    openJukebox,
    /** Apply an outline op from a bookmark VIEW (jump / rename / delete / indent
     *  / outdent / toggle) to its source buffer's records. Returns true when the
     *  op moved the document's point (jump) so the server re-syncs the client. */
    applyBookmarkOp,
    recoverBuffer,
    // save (real disk write) — the server wires saveFile to atomicWrite.
    saveActiveBuffer,
    writeActiveBufferTo,
    /** The active buffer's file path (where C-x C-s writes), or null. */
    get activeFilePath() {
      return activeEntry.filePath;
    },
    /** Whether the active buffer has unsaved edits (drives the ● flag). */
    get activeModified() {
      return registry.isModified(activeEntry);
    },
    /** Plain snapshots of every buffer with unsaved edits, for autosave:
     *  `[{ id, name, filePath, text }]`. Pure data (no L2 objects), so the
     *  server can write each to a recovery file without holding the buffer. */
    dirtyBufferSnapshots() {
      return registry.dirtyEntries().map((e) => ({
        id: e.id,
        name: e.buffer.name,
        filePath: e.filePath,
        text: e.buffer.text,
      }));
    },
    viewState,
    pointPosition,
    // multi-client window-state (per-client buffer + cursor)
    addClientView,
    removeClientView,
    setActiveClient,
    viewStateOf,
    // --- the pane tree (G0a) -------------------------------------------
    /** The PANE_TREE wire snapshot of client INDEX's window layout (the split
     *  structure + per-leaf buffer/view-state + the focused leaf; no pixels).
     *  The server pushes this on HELLO + whenever a window's layout changes. */
    paneSnapshot(index) {
      const model = paneModels.get(index);
      return model ? model.snapshot() : null;
    },
    /** The pane model of client INDEX (introspection: tests + the server). */
    paneModelOf(index) {
      return paneModels.get(index) ?? null;
    },
    // session persistence: serialise a window's layout by path; restore it back
    // (the files must already be open). The server adds geometry around these.
    serializeWindow,
    loadWindowLayout,
    /** Record client INDEX's editor-area pixel rectangle (a VIEWPORT-style
     *  report). Only spatial pane navigation needs it; everything else is
     *  pixel-free. `{ width, height }`. */
    setPaneHostRect(index, rect) {
      const model = paneModels.get(index);
      if (model) model.setHostRect(rect);
    },
    /** Apply a PANE_INTENT from client INDEX: a structural request (split /
     *  focus / delete / resize) the server fulfils by running the REAL
     *  panes.lisp command (or a model op) against that window's tree. Returns
     *  true when the intent was recognised. The model's onChange raises
     *  onPaneTree, so the server re-pushes the fresh PANE_TREE. */
    applyPaneIntent(index, intent) {
      return applyPaneIntent(index, intent);
    },
    /** Record client INDEX's viewport height in VISIBLE TEXT LINES (a VIEWPORT
     *  report — the client measures it on mount + resize). Screenful scroll
     *  (C-v/M-v via `page-lines`) reads the active client's value. A
     *  non-positive/non-finite report is ignored (keeps the last good value).
     *  Idempotent; safe to call before/after the client is otherwise known. */
    setViewport(index, lines) {
      const n = Math.floor(Number(lines));
      if (Number.isFinite(n) && n > 0) clientViewports.set(index, n);
    },
    /** The recorded viewport line count for client INDEX (0 = unmeasured).
     *  Introspection for the server + tests. */
    viewportOf(index) {
      return clientViewports.get(index) ?? 0;
    },
    /** Save the focused leaf's first-visible line for client INDEX (a scroll
     *  report). Per-pane scroll is window-state the leaf owns. */
    setPaneScroll(index, line) {
      const model = paneModels.get(index);
      if (model) {
        const wasActive = activeClientIndex;
        activeClientIndex = index;
        model.setFocusedScroll(line);
        activeClientIndex = wasActive;
      }
    },
    // multi-buffer registry surface
    switchClientToBuffer,
    seedClientTabline,
    bufferIdByName,
    currentBufferIdOf,
    /** Whether ID names a non-text DATA-SOURCE (media / directory / jukebox /
     *  element / bookmark) rather than a text buffer. The server uses this to
     *  skip the text SNAPSHOT when a data-source leaf is focused — that snapshot
     *  would rebuild + scroll a document shown in a sibling pane. */
    isDataSource: (id) => dataSources.has(id),
    killActiveBuffer,
    /** Plain-data buffer-list records for client INDEX's TABS / View List, each
     *  tagged with whether it is that client's CURRENT buffer. Scoped to the
     *  window's OWN open-set (G4 — a window shows only its own buffers; opening a
     *  file in one window doesn't add it to another's tabline). The current
     *  buffer is always included, defensively. NB: the C-x C-b switch PICKER uses
     *  `bufferListRows` (the whole pool), so any buffer is reachable from any
     *  window, and switching adds it to that window's set. */
    bufferListRecords(clientIndex) {
      const currentId = currentBufferIdOf(clientIndex);
      const open = clientBuffers.get(clientIndex) ?? new Set();
      const bufRecs = registry.listRecords()
        .filter((r) => open.has(r.id) || r.id === currentId)
        .map((r) => ({ ...r, current: r.id === currentId }));
      // Non-text data-sources (media) the window has open join its View List /
      // tabs / session record too (so an image/video/pdf restores + lists). A
      // media source has no line count and is never modified (immutable).
      const dsRecs = dataSources.list()
        .filter((s) => open.has(s.id) || s.id === currentId)
        .map((s) => ({
          id: s.id, name: s.name, lineCount: 0, modified: false,
          filePath: s.filePath, viewKind: s.kind, current: s.id === currentId,
        }));
      return [...bufRecs, ...dsRecs];
    },
    get bufferCount() {
      return registry.count();
    },
    // overlays + multi-cursor over the wire
    cursorsOf,
    activeCursorCount,
    overlaySnapshot,
    overlaySnapshotOf,
    get clientCount() {
      return clientIndices.size;
    },
    /** The active minibuffer prompt label, or null. */
    get activePrompt() {
      return activePrompt;
    },
    /** The open generic-picker request `{ id, title, rows, options }`, or null.
     *  The server reads it on a PICKER_CHOOSE/CANCEL to match the reply (the
     *  pickerId) and to know which client owns the picker. */
    get activePicker() {
      return activePicker;
    },
    get statusText() {
      return statusText;
    },
  };
}
