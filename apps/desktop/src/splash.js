/**
 * @file The startup splash — a panel of the editor's own Lisp,
 * syntax-highlighted and tilted into the distance, drawn into the
 * editor view's background layer behind the welcome text.
 *
 * It is the editor showing its own source: the real `handle-key`
 * dispatcher from `packages/stdlib/lisp/keymap.lisp`.
 */

import { highlightLine } from '@editor/renderer';

/** The code shown in the splash — keymap.lisp's handle-key, verbatim. */
const SPLASH_CODE = [
  ';; handle-key — every keystroke flows through here.',
  '(define (handle-key key)',
  '  (if (not (nil? *key-reader*))',
  '      (let ((reader *key-reader*))',
  '        (set! *key-reader* nil)',
  '        (reader key) #t)',
  '      (let ((binding (lookup-key key)))',
  '        (cond',
  '          ((map? binding)',
  '           (set! active-keymap binding) #t)',
  '          ((symbol? binding)',
  '           (reset-keymap!) ((eval binding)) #t)',
  '          ((self-insert-key? key)',
  '           (insert! key) #t)',
  '          (else #f)))))',
];

/** Muted Mariana faces — low-contrast, so the panel reads as a backdrop. */
const FACE_COLOR = {
  comment: '#566472',
  keyword: '#9a7faf',
  string: '#7fae84',
  number: '#c89a6a',
  constant: '#6a9b9b',
  paren: '#5d6b78',
  operator: '#7c8794',
};
const BASE_COLOR = '#8a97a6';

const escapeXml = (text) =>
  text.replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'
  );

/**
 * Build the splash element — a `<div class="splash">` holding an SVG of
 * the code. Append it to an editor view's `backgroundLayer`.
 *
 * @returns {HTMLElement}
 */
export function createSplash() {
  const lineHeight = 26;
  const lines = SPLASH_CODE.map((line, index) => {
    const tspans = highlightLine(line, 'lisp')
      .map((run) => {
        const fill = run.face ? FACE_COLOR[run.face] ?? BASE_COLOR : BASE_COLOR;
        return `<tspan fill="${fill}">${escapeXml(run.text)}</tspan>`;
      })
      .join('');
    const y = 30 + index * lineHeight;
    return `<text x="0" y="${y}" xml:space="preserve">${tspans || ' '}</text>`;
  }).join('');

  const width = 620;
  const height = 30 + SPLASH_CODE.length * lineHeight;

  const splash = document.createElement('div');
  splash.className = 'splash';
  splash.innerHTML =
    `<svg class="splash-code" viewBox="0 0 ${width} ${height}"` +
    ` xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<g font-size="18">${lines}</g></svg>`;
  return splash;
}
