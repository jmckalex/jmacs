/**
 * @file Integration tests for the `jmarkdown` / `jmarkdown_inline`
 * language registrations.
 *
 * Unlike the older grammar-bound paths (which lean on the desktop
 * smoke test), these load the vendored wasm grammars directly — the
 * current web-tree-sitter runs fine under plain Node — so a query that
 * names a node the grammar doesn't have fails *here*, not at app
 * startup. The provider plumbing is exercised against real parses via
 * the pure merge (`applyCaptureProvider`).
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Language, Parser, Query } from '../vendor/web-tree-sitter.js';
import {
  registeredLanguages,
} from '../src/language-registry.js';
import { applyCaptureProvider } from '../src/treesitter.js';
import '../src/languages/jmarkdown.js';
import '../src/languages/jmarkdown-inline.js';

const VENDOR = fileURLToPath(new URL('../vendor/', import.meta.url));

/** @type {Record<string, { language: object, parser: object }>} */
const grammars = {};

before(async () => {
  await Parser.init({ locateFile: (name) => VENDOR + name });
  for (const wasm of ['tree-sitter-markdown.wasm', 'tree-sitter-markdown-inline.wasm']) {
    const language = await Language.load(
      new Uint8Array(readFileSync(VENDOR + wasm))
    );
    const parser = new Parser();
    parser.setLanguage(language);
    grammars[wasm] = { language, parser };
  }
});

function spec(tag) {
  const found = registeredLanguages().find((s) => s.tag === tag);
  assert.ok(found, `language ${tag} is registered`);
  return found;
}

test('jmarkdown registers with the full provider set and claims .jmd', () => {
  const s = spec('jmarkdown');
  assert.equal(s.grammar, 'tree-sitter-markdown.wasm');
  assert.deepEqual(s.suffixes, ['.jmd']);
  assert.equal(typeof s.injectionProvider, 'function');
  assert.equal(typeof s.captureProvider, 'function');
  assert.equal(typeof s.foldProvider, 'function');
  assert.match(s.injectionQuery, /jmarkdown_inline/);
});

test('jmarkdown_inline registers as injection-only', () => {
  const s = spec('jmarkdown_inline');
  assert.equal(s.grammar, 'tree-sitter-markdown-inline.wasm');
  assert.deepEqual(s.suffixes, []);
  assert.equal(typeof s.injectionProvider, 'function');
});

test('every jmarkdown query compiles against its real grammar', () => {
  for (const tag of ['jmarkdown', 'jmarkdown_inline']) {
    const s = spec(tag);
    const { language } = grammars[s.grammar];
    for (const source of [s.query, s.injectionQuery, s.foldQuery]) {
      if (source === undefined) continue;
      assert.doesNotThrow(() => new Query(language, source), `${tag} query`);
    }
  }
});

test('inline remap: *strong*, **intense**, __underline__, _emphasis_', () => {
  const s = spec('jmarkdown_inline');
  const { language, parser } = grammars[s.grammar];
  const sample = '*bold* **intense** __under__ _it_';
  const tree = parser.parse(sample);
  const captures = new Query(language, s.query).captures(tree.rootNode);
  const byText = new Map(
    captures
      .filter((c) => !['paren', 'constant'].includes(c.name))
      .map((c) => [sample.slice(c.node.startIndex, c.node.endIndex), c.name])
  );
  assert.equal(byText.get('*bold*'), 'jmd-strong');
  assert.equal(byText.get('**intense**'), 'jmd-intense');
  assert.equal(byText.get('__under__'), 'jmd-underline');
  assert.equal(byText.get('_it_'), 'emphasis');
});

test('the capture provider occludes the header mis-parse on a real parse', () => {
  // `Title: My Book` over `---` parses as a setext heading; the
  // provider's owned region must clip that grammar capture away and
  // paint the key instead.
  const s = spec('jmarkdown');
  const { language, parser } = grammars[s.grammar];
  const text = 'Title: My Book\n---\n\nReal prose.\n';
  const tree = parser.parse(text);
  const grammarCaptures = new Query(language, s.query)
    .captures(tree.rootNode)
    .map((c) => ({ start: c.node.startIndex, end: c.node.endIndex, face: c.name }));
  assert.ok(
    grammarCaptures.some((c) => c.face === 'heading'),
    'the raw grammar does mis-parse the header as a heading'
  );
  const merged = applyCaptureProvider(grammarCaptures, s.captureProvider(text));
  assert.ok(
    !merged.some((c) => c.face === 'heading' && c.start < text.indexOf('---') + 3),
    'the header heading capture is occluded'
  );
  assert.ok(merged.some((c) => c.face === 'jmd-meta-key'));
});

test('fold sources: grammar sections/fences plus scanner directives', () => {
  const s = spec('jmarkdown');
  const { language, parser } = grammars[s.grammar];
  const text = '# Top\n\nProse.\n\n:::note\nBody.\n:::\n\n```js\nx\n```\n';
  // The grammar half.
  const tree = parser.parse(text);
  const grammarFolds = new Query(language, s.foldQuery).captures(tree.rootNode);
  assert.ok(grammarFolds.some((c) => c.node.type === 'section'));
  assert.ok(grammarFolds.some((c) => c.node.type === 'fenced_code_block'));
  // The scanner half.
  const providerFolds = s.foldProvider(text);
  assert.equal(providerFolds.length, 1);
  assert.equal(providerFolds[0].start, text.indexOf(':::note'));
});

test('the injection provider routes verbatim bodies to the right grammars', () => {
  const s = spec('jmarkdown');
  const text =
    ':::TiKZ\n\\draw (0,0);\n:::\n\nUse compute(1).label here.\n\n' +
    '<script>let a = 1;</script>\n';
  const langs = s.injectionProvider(text).map((i) => i.language);
  assert.ok(langs.includes('latex'));
  assert.ok(langs.includes('javascript'));
  assert.ok(langs.includes('html'));
});

test('jmarkdown_inline injects latex into math, like markdown_inline', () => {
  const s = spec('jmarkdown_inline');
  const ranges = s.injectionProvider('Euler: $e^{i\\pi} = -1$ indeed.');
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].language, 'latex');
});

test('indented text is prose, not code (jmarkdown has no indented blocks)', () => {
  const s = spec('jmarkdown');
  const { language, parser } = grammars[s.grammar];
  const text = 'A paragraph.\n\n    Indented prose, *bold* and all.\n';
  const tree = parser.parse(text);
  const captures = new Query(language, s.query).captures(tree.rootNode);
  // The grammar still parses the indentation as indented_code_block,
  // but the query paints no face on it — no green.
  assert.ok(
    captures.every((c) => c.node.type !== 'indented_code_block'),
    'no capture on indented_code_block'
  );
  // And the injection query routes it into the inline grammar instead.
  const injections = new Query(language, s.injectionQuery).matches(tree.rootNode);
  const injected = injections.some((m) =>
    m.captures.some(
      (c) => c.name === 'injection.content' && c.node.type === 'indented_code_block'
    )
  );
  assert.ok(injected, 'indented prose gets the jmarkdown_inline injection');
});
