/**
 * @file Reproducible static build for the gnuplot-view walkthrough.
 *
 * Pipeline:
 *   1. Generate the real gnuplot plots (high-sample SVGs, project dark
 *      theme) into a temp dir — these replace the old hand-drawn jagged
 *      sine `<polyline>`s.
 *   2. Run `jmarkdown process docs/gnuplot-view-walkthrough.jmd` into a
 *      temp HTML file (jmarkdown gives us real, static `hljs-…` syntax
 *      highlighting at build time — no runtime script).
 *   3. Post-process that HTML:
 *        a. inject each cleaned plot SVG where the `.jmd` left a
 *           `<!--PLOT:name-->` placeholder;
 *        b. add a slug `id` to every `<h1>`/`<h2>` heading;
 *        c. build a `<nav class="toc">` of anchor links and inject it
 *           after the masthead;
 *        d. strip every external-network resource tag (FontAwesome,
 *           MathJax, Mermaid, jQuery, the hljs CDN <link>, Biblify, and
 *           the Sublime click-to-open shim) so the page is fully
 *           self-contained. The hljs theme CSS is already inlined via the
 *           `.jmd`'s `HTML header`.
 *   4. Write the final, self-contained, dark, static
 *      `docs/gnuplot-view-walkthrough.html`.
 *
 * Run with:  node scripts/build-gnuplot-walkthrough.js
 *
 * Requirements: `jmarkdown` (v0.5) and `gnuplot` (v6) on PATH.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const jmdPath = join(repoRoot, 'docs', 'gnuplot-view-walkthrough.jmd');
const outPath = join(repoRoot, 'docs', 'gnuplot-view-walkthrough.html');

/* ------------------------------------------------------------------ *
 * 0. The self-contained page CSS.
 * ------------------------------------------------------------------ *
 * Page theme + the highlight.js atom-one-dark theme, inlined verbatim
 * (curled once from
 *   https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css
 * with `.hljs` background re-pointed at the page's panel colour so code
 * blocks blend in). Injected into <head> by the build (rather than via
 * the .jmd's `HTML header`, whose YAML block-scalar handling mangles a
 * stylesheet this large). This is what makes the page need no network.
 */
const PAGE_CSS = `<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
/* Building a gnuplot-view for jmacs — dark developer-docs theme.
   Self-contained: page theme + inlined highlight.js atom-one-dark. */
:root{
  --bg:#161a1f; --bg-page:#1b2026; --bg-panel:#1e2228; --bg-panel-2:#232a31;
  --bg-inline:#252b33; --bg-toc:#181c22;
  --border:#2c343d; --border-soft:#242b33; --border-strong:#3a434d;
  --fg:#d7dde4; --fg-strong:#f1f4f7; --fg-dim:#95a0ac; --fg-fainter:#768290;
  --blue:#5aa9e6; --orange:#f78c6b; --green:#7ed491; --purple:#c792ea;
  --yellow:#ffcb6b; --red:#ff6b8a; --link:#6cb6f0; --link-hover:#93caf5;
  --font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --font-mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Monaco,"Cascadia Code",Consolas,monospace;
  --content-max:1180px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body.gpwt{
  margin:0 auto; max-width:var(--content-max); padding:0 28px 120px;
  background:radial-gradient(1200px 600px at 80% -10%,#20262d 0%,rgba(32,38,45,0) 60%),var(--bg);
  color:var(--fg); font-family:var(--font-sans); font-size:16.5px; line-height:1.68;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
  counter-reset:section;
}
body.gpwt > h1{
  font-size:42px; line-height:1.1; letter-spacing:-0.02em; font-weight:700;
  color:var(--fg-strong); margin:64px 0 14px; padding-top:48px;
}
.masthead{ border-bottom:1px solid var(--border); padding-bottom:36px; margin-bottom:8px; }
.masthead .eyebrow{
  font-family:var(--font-mono); font-size:12.5px; letter-spacing:.14em;
  text-transform:uppercase; color:var(--green); margin:0 0 4px;
}
.masthead .subtitle{ font-size:18px; color:var(--fg-dim); margin:14px 0 0; max-width:64ch; }
.masthead .meta{
  margin-top:18px; font-family:var(--font-mono); font-size:12.5px; color:var(--fg-fainter);
  display:flex; flex-wrap:wrap; gap:8px 18px;
}
.masthead .meta span::before{ content:"\\203A  "; color:var(--border-strong); }
nav.toc{
  background:var(--bg-toc); border:1px solid var(--border); border-radius:12px;
  padding:18px 20px; margin:36px 0 8px; font-size:14.5px;
}
nav.toc .toc-heading{
  font-size:11.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--fg-fainter);
  margin:0 0 10px; font-weight:600; border:none; padding:0;
}
nav.toc ol{ list-style:none; margin:0; padding:0; counter-reset:toc; columns:2; column-gap:36px; }
nav.toc li{ margin:0 0 2px; counter-increment:toc; break-inside:avoid; }
nav.toc a{
  display:flex; gap:10px; align-items:baseline; padding:6px 8px; border-radius:7px;
  color:var(--fg-dim); text-decoration:none; line-height:1.3;
}
nav.toc a::before{
  content:counter(toc); font-family:var(--font-mono); font-size:11.5px;
  color:var(--fg-fainter); min-width:1.4em; text-align:right; flex:0 0 auto;
}
nav.toc a:hover{ background:#ffffff0a; color:var(--fg); }
body.gpwt h2{
  font-size:28px; line-height:1.22; letter-spacing:-0.015em; color:var(--fg-strong);
  margin:64px 0 22px; padding-top:24px; border-top:1px solid var(--border-soft); font-weight:700;
  counter-increment:section; scroll-margin-top:16px;
}
body.gpwt h2::before{ content:counter(section) " \\B7 "; color:var(--blue); font-weight:600; }
body.gpwt h3{ font-size:20px; line-height:1.3; color:var(--fg-strong); margin:40px 0 14px; font-weight:600; scroll-margin-top:16px; }
body.gpwt h4{ font-size:16.5px; color:var(--fg-strong); margin:30px 0 12px; font-weight:600; }
p{ margin:0 0 18px; }
a{ color:var(--link); text-decoration:none; border-bottom:1px solid #6cb6f040; }
a:hover{ color:var(--link-hover); border-bottom-color:var(--link-hover); }
strong{ color:var(--fg-strong); font-weight:600; }
em{ color:#e3e8ee; font-style:italic; }
ul,ol{ margin:0 0 20px; padding-left:1.4em; }
li{ margin:0 0 9px; }
li::marker{ color:var(--fg-fainter); }
kbd{
  font-family:var(--font-mono); font-size:.82em; background:var(--bg-panel-2);
  border:1px solid var(--border-strong); border-bottom-width:2px; border-radius:5px;
  padding:1px 6px; color:var(--fg-strong); white-space:nowrap;
}
code{ font-family:var(--font-mono); font-size:.86em; }
:not(pre) > code{
  background:var(--bg-inline); border:1px solid var(--border-soft); border-radius:5px;
  padding:.12em .42em; color:#cdd6e0;
}
pre{
  margin:0 0 22px; background:var(--bg-panel); border:1px solid var(--border);
  border-radius:10px; overflow-x:auto; line-height:1.55; font-size:13.5px;
  box-shadow:inset 0 1px 0 #ffffff06;
}
pre code,pre code.hljs{
  font-family:var(--font-mono); background:none; padding:14px 16px; font-size:13.5px;
  color:#c6cfda; display:block; tab-size:2; -moz-tab-size:2;
}
blockquote{
  background:linear-gradient(180deg,#1d2630 0%,#1b232c 100%);
  border:1px solid var(--border-strong); border-left:3px solid var(--blue);
  border-radius:8px; padding:14px 18px; margin:0 0 24px; color:#c4cdd7; font-size:15.5px;
}
blockquote > :first-child{ margin-top:0; }
blockquote > :last-child{ margin-bottom:0; }
blockquote strong:first-child{ color:var(--blue); }
figure{ margin:8px 0 22px; }
figure svg{
  display:block; width:100%; height:auto; background:var(--bg-panel);
  border:1px solid var(--border); border-radius:10px; padding:14px;
}
figure.plot svg{ padding:0; }
figcaption{
  font-size:13px; color:var(--fg-dim); margin:8px 0 0; padding-left:12px;
  border-left:2px solid var(--border-strong); line-height:1.55;
}
figcaption code{ font-size:.92em; }
table{
  width:100%; border-collapse:collapse; margin:0 0 24px; font-size:14.5px;
  background:var(--bg-panel); border:1px solid var(--border); border-radius:10px; overflow:hidden;
}
thead th{
  text-align:left; background:var(--bg-panel-2); color:var(--fg-strong); font-weight:600;
  font-size:13px; padding:11px 14px; border-bottom:1px solid var(--border-strong);
}
tbody td{ padding:11px 14px; border-bottom:1px solid var(--border-soft); vertical-align:top; color:var(--fg); }
tbody tr:last-child td{ border-bottom:none; }
tbody tr:nth-child(even){ background:#ffffff04; }
.d-label{ fill:var(--fg-fainter); font:600 12px var(--font-sans); }
.d-text{ fill:#cfd6de; font:13px var(--font-sans); }
.d-dim{ fill:#8b95a1; font:12px var(--font-sans); }
.d-mono{ fill:#9fd49a; font-family:var(--font-mono); font-size:12px; }
@media (max-width:680px){ nav.toc ol{ columns:1; } body.gpwt > h1{ font-size:32px; } }
/* highlight.js atom-one-dark (inlined; no network; bg re-pointed to the panel colour) */
pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#abb2bf;background:#1e2228}.hljs-comment,.hljs-quote{color:#5c6370;font-style:italic}.hljs-doctag,.hljs-formula,.hljs-keyword{color:#c678dd}.hljs-deletion,.hljs-name,.hljs-section,.hljs-selector-tag,.hljs-subst{color:#e06c75}.hljs-literal{color:#56b6c2}.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#98c379}.hljs-attr,.hljs-number,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-pseudo,.hljs-template-variable,.hljs-type,.hljs-variable{color:#d19a66}.hljs-bullet,.hljs-link,.hljs-meta,.hljs-selector-id,.hljs-symbol,.hljs-title{color:#61aeee}.hljs-built_in,.hljs-class .hljs-title,.hljs-title.class_{color:#e6c07b}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}.hljs-link{text-decoration:underline}
</style>`;

/* ------------------------------------------------------------------ *
 * 1. Real gnuplot plots.
 * ------------------------------------------------------------------ *
 * The project's dark theme `set` block, copied verbatim from
 * apps/desktop/src/gnuplot-protocol.js (THEMES.dark). Kept here rather
 * than imported because that module pulls in nothing, but living beside
 * the plot commands keeps the build a single self-contained script.
 */
const DARK_THEME_BLOCK = [
  "set border lc rgb '#7f8c98'",
  "set xtics textcolor rgb '#aeb6c0'",
  "set ytics textcolor rgb '#aeb6c0'",
  "set ztics textcolor rgb '#aeb6c0'",
  "set title  textcolor rgb '#e6e9ed'",
  "set xlabel textcolor rgb '#cfd6de'",
  "set ylabel textcolor rgb '#cfd6de'",
  "set key textcolor rgb '#cfd6de'",
  "set grid lc rgb '#3a434d' lw 1",
  "set linetype 1 lc rgb '#5aa9e6' lw 2 pt 7",
  "set linetype 2 lc rgb '#f78c6b' lw 2 pt 7",
  "set linetype 3 lc rgb '#7ed491' lw 2 pt 7",
  "set linetype 4 lc rgb '#c792ea' lw 2 pt 7",
  "set linetype 5 lc rgb '#ffcb6b' lw 2 pt 7",
  "set linetype 6 lc rgb '#ff6b8a' lw 2 pt 7",
].join('\n');

const SVG_BACKGROUND = '#1e2228';

/**
 * One plot figure: the placeholder name it fills and the gnuplot body
 * (everything between the terminal/output preamble and `unset output`).
 * `set samples 2000` gives genuinely smooth curves. NOTE: the svg
 * terminal is declared WITHOUT the `dynamic` keyword so the SVG carries
 * intrinsic width/height (needed for a standalone, self-sizing figure).
 */
const PLOTS = [
  {
    name: 'sincos',
    body: [
      "set title 'plot sin(x), cos(x)'",
      'set xrange [-2*pi:2*pi]',
      'set yrange [-1.4:1.4]',
      'plot sin(x), cos(x)',
    ].join('\n'),
  },
  {
    name: 'sinc',
    body: [
      "set title 'plot sin(x)/x'",
      'set xrange [-20:20]',
      'plot sin(x)/x notitle',
    ].join('\n'),
  },
  {
    name: 'damped',
    body: [
      "set title 'plot exp(-x/6)*cos(x), exp(-x/6), -exp(-x/6)'",
      'set xrange [0:30]',
      "plot exp(-x/6)*cos(x) title 'damped', \\",
      "     exp(-x/6) title 'envelope', \\",
      '     -exp(-x/6) notitle',
    ].join('\n'),
  },
  {
    name: 'palette',
    body: [
      "set title 'set linetype palette — plot sin(x)+k, k = 0..5'",
      'set xrange [-pi:pi]',
      'set yrange [-1.5:6.5]',
      'unset key',
      'plot sin(x), sin(x)+1, sin(x)+2, sin(x)+3, sin(x)+4, sin(x)+5',
    ].join('\n'),
  },
];

/**
 * Render one plot to an SVG string via a one-shot gnuplot invocation,
 * then clean the markup for safe inline embedding:
 *   - drop the `<?xml …?>` prolog (jmarkdown's HTML directive chokes on
 *     it and would strip the whole <svg> wrapper),
 *   - strip `<title>` / `<desc>` (gnuplot tooltips; not rendered text and
 *     not wanted in the document),
 *   - strip any `<script>` (defence-in-depth — the same strip the host
 *     does before the renderer inlines a plot).
 *
 * @param {{ name: string, body: string }} plot
 * @param {string} tmpDir
 * @returns {string} cleaned `<svg>…</svg>` markup
 */
function renderPlot(plot, tmpDir) {
  const svgFile = join(tmpDir, `${plot.name}.svg`);
  const program = [
    `set terminal svg size 720,460 enhanced background rgb '${SVG_BACKGROUND}' font 'sans,11'`,
    `set output '${svgFile}'`,
    DARK_THEME_BLOCK,
    'set samples 2000',
    plot.body,
    'unset output',
    '',
  ].join('\n');

  execFileSync('gnuplot', [], { input: program });
  let svg = readFileSync(svgFile, 'utf8');

  svg = svg.replace(/<\?xml[\s\S]*?\?>/g, '');
  svg = svg.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  svg = svg.replace(/<title\b[\s\S]*?<\/title>/gi, '');
  svg = svg.replace(/<desc\b[\s\S]*?<\/desc>/gi, '');
  return svg.trim();
}

/* ------------------------------------------------------------------ *
 * 3b. Heading slugs + TOC.
 * ------------------------------------------------------------------ */

/** Turn heading text into a URL slug, deduping collisions. */
function slugify(text, seen) {
  const base =
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/&[a-z]+;/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
  let slug = base;
  let n = 2;
  while (seen.has(slug)) slug = `${base}-${n++}`;
  seen.add(slug);
  return slug;
}

/**
 * Add an `id` to every `<h1>`/`<h2>` that lacks one, and return the list
 * of headings (level, id, text) in document order for the TOC.
 *
 * @param {string} html
 * @returns {{ html: string, headings: Array<{ level: number, id: string, text: string }> }}
 */
function addHeadingIds(html) {
  const seen = new Set();
  const headings = [];
  const out = html.replace(
    /<(h[12])\b([^>]*)>([\s\S]*?)<\/\1>/gi,
    (match, tag, attrs, inner) => {
      const level = Number(tag[1]);
      const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (/\bid\s*=/.test(attrs)) {
        const idMatch = /\bid\s*=\s*"([^"]*)"/.exec(attrs);
        if (idMatch) headings.push({ level, id: idMatch[1], text });
        return match;
      }
      const id = slugify(text, seen);
      headings.push({ level, id, text });
      return `<${tag}${attrs} id="${id}">${inner}</${tag}>`;
    }
  );
  return { html: out, headings };
}

/** Build the static TOC nav from the collected headings (h2s only — the
 *  single h1 is the page title / masthead). */
function buildToc(headings) {
  const items = headings
    .filter((h) => h.level === 2)
    .map(
      (h) =>
        `      <li><a href="#${h.id}">${escapeText(h.text)}</a></li>`
    )
    .join('\n');
  return [
    '<nav class="toc" aria-label="Table of contents">',
    '  <h2 class="toc-heading">Contents</h2>',
    '  <ol>',
    items,
    '  </ol>',
    '</nav>',
  ].join('\n');
}

function escapeText(s) {
  return s
    .replace(/&(?![a-z]+;|#\d+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ------------------------------------------------------------------ *
 * 3d. Strip every external-network resource tag.
 * ------------------------------------------------------------------ */

/**
 * Remove the CDN `<script src>` / `<link href>` tags the jmarkdown
 * default template injects (FontAwesome, MathJax, Mermaid, jQuery, the
 * hljs CDN stylesheet, Biblify/citation) plus the Sublime click-to-open
 * `<script>` shim. Leaves the page with zero external requests; the hljs
 * theme CSS is already inlined via the .jmd's HTML header.
 *
 * @param {string} html
 * @returns {string}
 */
function stripExternalResources(html) {
  let out = html;
  // <script src="http(s)://…"></script>
  out = out.replace(
    /[ \t]*<script\b[^>]*\bsrc\s*=\s*"https?:\/\/[^"]*"[^>]*>\s*<\/script>\s*\n?/gi,
    ''
  );
  // <link … href="http(s)://…">
  out = out.replace(
    /[ \t]*<link\b[^>]*\bhref\s*=\s*"https?:\/\/[^"]*"[^>]*>\s*\n?/gi,
    ''
  );
  // The MathJax config <script> (inline, no src) the template emits.
  out = out.replace(
    /[ \t]*<script>\s*MathJax\s*=\s*\{[\s\S]*?<\/script>\s*\n?/gi,
    ''
  );
  // The Sublime "open in editor" click shim (inline <script> using the
  // kmtrigger:// scheme + a local file path — strip it).
  out = out.replace(
    /[ \t]*<script>\s*document\.addEventListener\('click'[\s\S]*?<\/script>\s*\n?/gi,
    ''
  );
  return out;
}

/* ------------------------------------------------------------------ *
 * Drive the pipeline.
 * ------------------------------------------------------------------ */

function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'jmacs-gpwt-'));
  try {
    // 1. Render the plots.
    const svgByName = new Map();
    for (const plot of PLOTS) {
      svgByName.set(plot.name, renderPlot(plot, tmpDir));
    }

    // 2. jmarkdown → temp HTML.
    const tmpHtml = join(tmpDir, 'walkthrough.html');
    execFileSync('jmarkdown', ['process', jmdPath, '-o', tmpHtml], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    let html = readFileSync(tmpHtml, 'utf8');

    // 3a. Inject the plots into their placeholder figures. The .jmd marks
    // each plot slot as an empty `<figure class="plot" data-plot="name">`
    // (an attribute form survives jmarkdown's HTML processing verbatim —
    // a placeholder HTML *comment* can get a stray space injected after
    // `<`). We drop the cleaned SVG inside that figure.
    let injected = 0;
    html = html.replace(
      /(<figure\b[^>]*\bdata-plot="([a-z0-9-]+)"[^>]*>)\s*(<\/figure>)/gi,
      (m, open, name, close) => {
        const svg = svgByName.get(name);
        if (!svg) throw new Error(`No plot generated for placeholder "${name}"`);
        injected += 1;
        return `${open}${svg}${close}`;
      }
    );
    if (injected !== PLOTS.length) {
      throw new Error(
        `Expected ${PLOTS.length} plot placeholders, filled ${injected}`
      );
    }
    // Fail loudly if any placeholder went unfilled (empty figure or a
    // stray comment-form placeholder from an older .jmd).
    if (/data-plot="[a-z0-9-]+"[^>]*>\s*<\/figure>/i.test(html)) {
      throw new Error('An empty plot figure remained unfilled');
    }
    if (/<.{0,2}!--\s*PLOT:[a-z0-9-]+/i.test(html)) {
      throw new Error('A comment-form plot placeholder remained unfilled');
    }

    // 3b. Heading ids + 3c. TOC.
    const withIds = addHeadingIds(html);
    html = withIds.html;
    const toc = buildToc(withIds.headings);

    // Inject the TOC right after the masthead (the <h1> block we wrap in
    // the .jmd) — or, failing that, before the first <h2>.
    if (html.includes('<!--TOC-->')) {
      html = html.replace('<!--TOC-->', toc);
    } else {
      html = html.replace(/(<h2\b)/i, `${toc}\n    $1`);
    }

    // 3d. Strip all external-network resource tags.
    html = stripExternalResources(html);

    // 3e. Inject the self-contained page CSS into <head>.
    if (!html.includes('</head>')) throw new Error('no </head> to inject CSS');
    html = html.replace('</head>', `${PAGE_CSS}\n</head>`);

    writeFileSync(outPath, html, 'utf8');
    process.stdout.write(
      `Built ${outPath}\n` +
        `  plots:    ${PLOTS.length} real gnuplot SVGs embedded\n` +
        `  headings: ${withIds.headings.length} (ids added)\n` +
        `  toc:      ${withIds.headings.filter((h) => h.level === 2).length} entries\n`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
