#!/usr/bin/env node
/**
 * @file build-docs — render the jmacs documentation.
 *
 * Invokes the user's installed `jmarkdown` binary on
 * `docs/MANUAL.jmd` (the root source that <<include>>s the topic
 * files) and writes the output under `docs/build/`. The .jmd's
 * postprocessor splits the rendered document into per-function pages
 * and writes the manifest; this script verifies the result and copies
 * the static assets.
 *
 *   node scripts/build-docs.js [--jmarkdown=PATH] [--source=PATH] [--out=DIR]
 *
 * Defaults: --jmarkdown from $JMARKDOWN env, else `jmarkdown` on PATH;
 *           --source=docs/MANUAL.jmd; --out=docs/build.
 *
 * Note: `*jmarkdown-command*` (the sticky-notes setting in the
 * editor's stdlib) is deliberately NOT consulted here — that
 * variable's purpose is rendering sticky-note bodies at runtime, not
 * building the docs. This script resolves the binary independently.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = {
    jmarkdown: process.env.JMARKDOWN || 'jmarkdown',
    source: 'docs/MANUAL.jmd',
    out: 'docs/build',
    help: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg.startsWith('--jmarkdown=')) opts.jmarkdown = arg.slice('--jmarkdown='.length);
    else if (arg.startsWith('--source=')) opts.source = arg.slice('--source='.length);
    else if (arg.startsWith('--out=')) opts.out = arg.slice('--out='.length);
    else {
      console.error(`build-docs: unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function help() {
  process.stdout.write(`Usage: node scripts/build-docs.js [options]

Options:
  --jmarkdown=PATH   Path to the jmarkdown binary. Default: $JMARKDOWN or 'jmarkdown'.
  --source=PATH      Root .jmd file. Default: docs/MANUAL.jmd.
  --out=DIR          Output directory. Default: docs/build.
  -h, --help         This message.

The .jmd source's postprocessor is responsible for writing the per-
function pages and manifest.json. This script invokes jmarkdown,
verifies the artifacts exist, and copies docs/assets/ over.
`);
}

function copyDir(src, dst) {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    if (statSync(srcPath).isDirectory()) copyDir(srcPath, dstPath);
    else copyFileSync(srcPath, dstPath);
  }
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    help();
    return;
  }

  const srcPath = resolve(repoRoot, opts.source);
  const outPath = resolve(repoRoot, opts.out);
  if (!existsSync(srcPath)) {
    console.error(`build-docs: source not found: ${srcPath}`);
    process.exit(1);
  }

  // Wipe the output dir for an idempotent rebuild.
  if (existsSync(outPath)) rmSync(outPath, { recursive: true, force: true });
  mkdirSync(outPath, { recursive: true });

  // The postprocessor inside the .jmd writes its files relative to
  // process.cwd(). Run jmarkdown from the repo root and pass the
  // output directory through an env variable so the script can use
  // it without hard-coding `docs/build`.
  process.env.JMACS_DOCS_OUT = relative(repoRoot, outPath) || '.';

  const mainHtml = join(outPath, 'MANUAL.html');
  const res = spawnSync(
    opts.jmarkdown,
    ['process', srcPath, '-o', mainHtml],
    { cwd: repoRoot, stdio: 'inherit', env: process.env }
  );
  if (res.error) {
    console.error(`build-docs: failed to run ${opts.jmarkdown}: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`build-docs: jmarkdown exited with code ${res.status}`);
    process.exit(res.status ?? 1);
  }

  // Verify the artifacts the .jmd's postprocessor was supposed to produce.
  const manifestPath = join(outPath, 'manifest.json');
  const missing = [];
  if (!existsSync(mainHtml)) missing.push('MANUAL.html');
  if (!existsSync(manifestPath)) missing.push('manifest.json');
  if (missing.length > 0) {
    console.error(`build-docs: missing artifacts: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Copy docs/assets/ to docs/build/assets/ if the postprocessor
  // didn't (it usually doesn't — assets are static).
  const assetsSrc = resolve(repoRoot, 'docs/assets');
  const assetsDst = join(outPath, 'assets');
  if (existsSync(assetsSrc) && !existsSync(assetsDst)) copyDir(assetsSrc, assetsDst);

  // Summary.
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const count = Object.keys(manifest).length;
  console.error(`build-docs: wrote MANUAL.html and ${count} function page${count === 1 ? '' : 's'} to ${relative(repoRoot, outPath)}/`);
}

main();
