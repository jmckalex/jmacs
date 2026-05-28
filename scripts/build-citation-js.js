#!/usr/bin/env node
/**
 * @file Build the vendored citation-js bundle.
 *
 * Citation.js is composed of several npm packages — `@citation-js/core`
 * plus parsing / formatting plugins. The editor's runtime has no
 * bundler (per `packages/renderer/vendor/README.md`'s "ESM committed,
 * not resolved" rule), so we esbuild the pieces we want into a single
 * ESM file ahead of time and commit the output.
 *
 * Includes: core + plugin-bibtex (parsing BibTeX / BibLaTeX) +
 * plugin-csl (formatting via CSL XML styles bundled with the plugin —
 * APA, Vancouver, Harvard, and a few hundred others available
 * through the locale / style data the plugin ships).
 *
 * Excluded: plugin-doi / plugin-wikidata / plugin-ris (each pulls in
 * network code we don't want in a renderer-side dependency) and
 * plugin-bibjson (rare; can be added later if needed).
 *
 * Run with: `node scripts/build-citation-js.js`
 */

import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const out = join(repo, 'packages/renderer/vendor/citation-js.esm.js');

// A tiny entry-point ESM file. The exports object the renderer sees
// matches `@citation-js/core`'s default export shape (`Cite`, plus
// the `plugins` / `util` namespaces); the two plugin imports register
// themselves with the core's plugin registry as a side effect.
const entrySource = `
import { Cite, plugins, util } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import '@citation-js/plugin-csl';
export { Cite, plugins, util };
export default Cite;
`;

const stub = join(repo, 'node_modules/.citation-js-entry.mjs');
await writeFile(stub, entrySource, 'utf8');

const result = await build({
  entryPoints: [stub],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  // The CSL plugin loads locales / styles via fs.readFileSync at
  // import time; esbuild inlines them as base64 strings when we mark
  // the JSON / XML modules as bundlable. Citation.js's package
  // already exports its data assets as JS modules so no additional
  // loader config is needed.
  target: ['es2020'],
  outfile: out,
  // Keep the bundle readable enough that a grep across the vendor
  // dir still finds export names. Minification cuts ~30%; we trade
  // it for diff-friendliness on commits.
  minify: false,
  legalComments: 'none',
  // Citation.js plugins reach for these Node-isms in places; the
  // empty shims let the renderer-side bundle resolve them as no-ops.
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js: '/* Vendored citation.js bundle — built via scripts/build-citation-js.js. Do not hand-edit. */',
  },
});

if (result.errors.length > 0) {
  console.error(result.errors);
  process.exit(1);
}

console.log(`citation.js bundle → ${out}`);
